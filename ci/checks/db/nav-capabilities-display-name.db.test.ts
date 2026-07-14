// ci/checks/db/nav-capabilities-display-name.db.test.ts — T-0772
//
// LIVE Postgres regression for the pillar-7 sidebar account-card fix.
//
// THE BUG (T-0772, follow-up to T-0770): the sidebar account card / user menu
// read ONLY the KC token's `preferred_username` (or the dev-user's stored
// name) for the displayed identity. T-0770 humanized `employee.display_name`
// at registration time, but nothing on the client surfaced it for the
// CURRENT actor's own account card — a fresh owner still saw their raw email
// in the sidebar footer, even though the humanized name already lived in
// choros.employee.display_name.
//
// THE FIX: GET /api/me/nav-capabilities (T-0539, already resolved on every
// boot to drive zone visibility) now ALSO returns the caller's OWN
// employee.display_name — reusing the existing findEmployeeById lookup, no
// new endpoint, no wire-contract break (the field is additive; a client that
// ignores it behaves exactly as before).
//
// This test proves the SERVER side of that contract on a live tenant: an
// employee whose display_name differs from both their slug and any
// email-shaped string resolves to that EXACT display_name in the response —
// never the slug, never null (when the employee row exists).
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerOrgRoutes } from '../../../src/http/org.js';

const hasDb = Boolean(process.env['DATABASE_URL']);

function requireDb<T>(fn: () => Promise<T>): () => Promise<T | void> {
  return async () => {
    if (!hasDb) {
      console.log('[skip] DATABASE_URL not set');
      return;
    }
    return fn();
  };
}

// ---------------------------------------------------------------------------
// Fixture identity — a human employee whose display_name is a DELIBERATELY
// different, human string (never the slug, never email-shaped) — mirrors the
// T-0770 humanization outcome ("lp-w8-owner@example.com" → "Lp W8 Owner").
// ---------------------------------------------------------------------------

const TENANT = uuid();
const ACTOR_SLUG = `actor-t0772-${TENANT.slice(0, 8)}`;
const ACTOR_DISPLAY_NAME = 'T0772 Human Display Name';
// A second employee with NO display_name distinctiveness check needed — this
// file only asserts the pass-through, not org-tree shape.

async function seedTenant(c: pg.Client): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [TENANT, `t-nav-caps-${TENANT.slice(0, 8)}`],
  );

  const employeeId = uuid();

  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $4, 0, 0)`,
    [TENANT, employeeId, ACTOR_SLUG, ACTOR_DISPLAY_NAME],
  );
  await c.query('COMMIT');
}

async function cleanupTenant(c: pg.Client): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
  await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [TENANT]);
  await c.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [TENANT]);
  await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [TENANT]);
  await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [TENANT]);
  await c.query('COMMIT');
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function request(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl + path);
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (ch: Buffer) => chunks.push(ch));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Server (dev mode — CHOROS_AUTH_MODE unset/'dev'; org.ts reads DATABASE_URL
// itself via getOrgPool(), which the `db` CI job / local run already points
// at choros_migrator — see actor-resolve-seeded-persona.db.test.ts §comment).
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl = '';
const savedAuthMode = process.env['CHOROS_AUTH_MODE'];

beforeAll(async () => {
  if (!hasDb) return;
  process.env['CHOROS_AUTH_MODE'] = 'dev';

  await withClient(migratorUrl(), async (c) => {
    await seedTenant(c);
  });

  const router = new Router();
  registerOrgRoutes(router);

  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${(addr as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    await cleanupTenant(c);
  });
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (savedAuthMode === undefined) delete process.env['CHOROS_AUTH_MODE'];
  else process.env['CHOROS_AUTH_MODE'] = savedAuthMode;
});

// ---------------------------------------------------------------------------
// T-0772: GET /api/me/nav-capabilities returns the caller's OWN display_name
// ---------------------------------------------------------------------------

describe('T-0772: GET /api/me/nav-capabilities exposes displayName', () => {
  it('resolves the caller employee.display_name — NOT the slug, NOT null', requireDb(async () => {
    const res = await request(baseUrl, 'GET', '/api/me/nav-capabilities', { 'x-dev-user': ACTOR_SLUG });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.displayName).toBe(ACTOR_DISPLAY_NAME);
    expect(body.displayName).not.toBe(ACTOR_SLUG);
    // Sanity: the existing NavCapabilitySet contract (T-0539) is untouched —
    // this is a strictly additive field.
    expect(typeof body.isGenesisOwner).toBe('boolean');
    expect(Array.isArray(body.zones)).toBe(true);
    expect(body.zones).toContain('work');
  }));

  it('unknown actor slug → 403 ACTOR_TENANT_UNRESOLVED (fail-closed, unchanged pre-existing behavior)', requireDb(async () => {
    const res = await request(baseUrl, 'GET', '/api/me/nav-capabilities', { 'x-dev-user': `ghost-${uuid()}` });
    expect(res.statusCode).toBe(403);
  }));
});
