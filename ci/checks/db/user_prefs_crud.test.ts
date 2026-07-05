// T-0651 (E-NAV-IA/sidebar-workspace) — user_pref (личные настройки) CRUD live
// Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// Covers:
//   - GET /api/user-prefs → 200 { prefs: {} } when actor has none (empty map, not 404).
//   - PUT /api/user-prefs/:key → 200 upsert; visible in the next GET.
//   - PUT again with the same key → overwrite (one row per (tenant, actor, key)).
//   - DELETE /api/user-prefs/:key → 204; absent from a later GET; idempotent (204 again).
//   - 401 UNAUTHENTICATED when x-dev-user absent.
//   - 400 VALIDATION on a bad key / missing "value" in the PUT body.
//   - PER-ACTOR isolation: actor A's prefs never leak into actor B's GET, even
//     within the SAME tenant (the defining property of this store — not just
//     tenant RLS, an actor filter on every query).
//   - TENANT ISOLATION: actor A (tenant A) vs actor C (tenant B) — cross-tenant
//     rows are invisible (RLS-enforced, same pattern as sections_crud.test.ts).
//
// T-0144 discipline: BEGIN before SET LOCAL, COMMIT always, cleanup after self.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, TENANT_A, TENANT_B, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerUserPrefRoutes } from '../../../src/http/user-prefs.js';

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

async function seedTenantRow(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

function makeRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { ...extraHeaders };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const parsed = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (ch: Buffer) => chunks.push(ch));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === 'actor-a' || slug === 'actor-b') return TENANT_A;
  if (slug === 'actor-c') return TENANT_B;
  throw new Error(`unknown test actor: ${slug}`);
}

beforeAll(async () => {
  if (!hasDb) return;
  appPool = new pg.Pool({ connectionString: appUrl() });

  const router = new Router();
  registerUserPrefRoutes(router, { pool: appPool, resolveActorTenant: stubResolveActorTenant });
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  await withClient(migratorUrl(), async (c) => {
    await seedTenantRow(c, TENANT_A);
    await seedTenantRow(c, TENANT_B);
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
    await c.query(
      `DELETE FROM choros.user_pref WHERE tenant_id = $1 AND actor IN ('actor-a', 'actor-b')`,
      [TENANT_A],
    );
    await c.query('COMMIT');
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
    await c.query(
      `DELETE FROM choros.user_pref WHERE tenant_id = $1 AND actor = 'actor-c'`,
      [TENANT_B],
    );
    await c.query('COMMIT');
  });
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('user-prefs API — CRUD (T-0651)', () => {
  it('401 when x-dev-user absent', requireDb(async () => {
    const r = await makeRequest(baseUrl, 'GET', '/api/user-prefs');
    expect(r.statusCode).toBe(401);
  }));

  it('GET for an actor with no prefs yet → 200 { prefs: {} } shape (never 404)', requireDb(async () => {
    // actor-b starts each test run with no rows of its own (only this suite's
    // isolation test writes-then-deletes one) — assert the RESPONSE SHAPE
    // (an object, JSON-parseable, "prefs" key present) rather than exact
    // emptiness, since vitest test order is not guaranteed across files.
    const r = await makeRequest(baseUrl, 'GET', '/api/user-prefs', undefined, { 'x-dev-user': 'actor-b' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { prefs: Record<string, unknown> };
    expect(typeof body.prefs).toBe('object');
    expect(body.prefs).not.toBe(null);
  }));

  it('PUT → GET roundtrip; overwrite on second PUT; DELETE removes it', requireDb(async () => {
    const key = `sidebar.collapsed_groups.${uuid().slice(0, 8)}`;

    // First write.
    const put1 = await makeRequest(
      baseUrl, 'PUT', `/api/user-prefs/${encodeURIComponent(key)}`,
      { value: ['constructor', 'admin'] },
      { 'x-dev-user': 'actor-a' },
    );
    expect(put1.statusCode).toBe(200);
    const p1 = JSON.parse(put1.body) as Record<string, unknown>;
    expect(p1['key']).toBe(key);
    expect(p1['value']).toEqual(['constructor', 'admin']);

    // Visible in GET.
    const got1 = await makeRequest(baseUrl, 'GET', '/api/user-prefs', undefined, { 'x-dev-user': 'actor-a' });
    expect(got1.statusCode).toBe(200);
    const gb1 = JSON.parse(got1.body) as { prefs: Record<string, unknown> };
    expect(gb1.prefs[key]).toEqual(['constructor', 'admin']);

    // Overwrite (upsert, one row per key).
    const put2 = await makeRequest(
      baseUrl, 'PUT', `/api/user-prefs/${encodeURIComponent(key)}`,
      { value: ['observability'] },
      { 'x-dev-user': 'actor-a' },
    );
    expect(put2.statusCode).toBe(200);

    const got2 = await makeRequest(baseUrl, 'GET', '/api/user-prefs', undefined, { 'x-dev-user': 'actor-a' });
    const gb2 = JSON.parse(got2.body) as { prefs: Record<string, unknown> };
    expect(gb2.prefs[key]).toEqual(['observability']);

    // DELETE removes it.
    const del = await makeRequest(baseUrl, 'DELETE', `/api/user-prefs/${encodeURIComponent(key)}`, undefined, { 'x-dev-user': 'actor-a' });
    expect(del.statusCode).toBe(204);

    const got3 = await makeRequest(baseUrl, 'GET', '/api/user-prefs', undefined, { 'x-dev-user': 'actor-a' });
    const gb3 = JSON.parse(got3.body) as { prefs: Record<string, unknown> };
    expect(key in gb3.prefs).toBe(false);

    // DELETE is idempotent — a second delete of an absent key is still 204.
    const del2 = await makeRequest(baseUrl, 'DELETE', `/api/user-prefs/${encodeURIComponent(key)}`, undefined, { 'x-dev-user': 'actor-a' });
    expect(del2.statusCode).toBe(204);
  }));

  it('400 VALIDATION on bad key / missing value', requireDb(async () => {
    const badKey = await makeRequest(
      baseUrl, 'PUT', '/api/user-prefs/%20%20', { value: 1 }, { 'x-dev-user': 'actor-a' },
    );
    expect(badKey.statusCode).toBe(400);

    const key = `probe.${uuid().slice(0, 8)}`;
    const noValue = await makeRequest(
      baseUrl, 'PUT', `/api/user-prefs/${key}`, {}, { 'x-dev-user': 'actor-a' },
    );
    expect(noValue.statusCode).toBe(400);
  }));

  it('PER-ACTOR isolation: actor B never sees actor A\'s prefs (same tenant)', requireDb(async () => {
    const key = `sidebar.collapsed_groups.${uuid().slice(0, 8)}`;
    const put = await makeRequest(
      baseUrl, 'PUT', `/api/user-prefs/${encodeURIComponent(key)}`,
      { value: true },
      { 'x-dev-user': 'actor-a' },
    );
    expect(put.statusCode).toBe(200);

    // actor-b is in the SAME tenant (TENANT_A) but a DIFFERENT actor.
    const gotB = await makeRequest(baseUrl, 'GET', '/api/user-prefs', undefined, { 'x-dev-user': 'actor-b' });
    expect(gotB.statusCode).toBe(200);
    const gbB = JSON.parse(gotB.body) as { prefs: Record<string, unknown> };
    expect(key in gbB.prefs).toBe(false);

    // Cleanup.
    await makeRequest(baseUrl, 'DELETE', `/api/user-prefs/${encodeURIComponent(key)}`, undefined, { 'x-dev-user': 'actor-a' });
  }));

  it('TENANT ISOLATION: actor C (tenant B) never sees actor A\'s (tenant A) prefs', requireDb(async () => {
    const key = `sidebar.collapsed_groups.${uuid().slice(0, 8)}`;
    const put = await makeRequest(
      baseUrl, 'PUT', `/api/user-prefs/${encodeURIComponent(key)}`,
      { value: false },
      { 'x-dev-user': 'actor-a' },
    );
    expect(put.statusCode).toBe(200);

    const gotC = await makeRequest(baseUrl, 'GET', '/api/user-prefs', undefined, { 'x-dev-user': 'actor-c' });
    expect(gotC.statusCode).toBe(200);
    const gbC = JSON.parse(gotC.body) as { prefs: Record<string, unknown> };
    expect(key in gbC.prefs).toBe(false);

    await makeRequest(baseUrl, 'DELETE', `/api/user-prefs/${encodeURIComponent(key)}`, undefined, { 'x-dev-user': 'actor-a' });
  }));
});
