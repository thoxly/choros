// Regression — GET /api/grant-trail must return the actor's OWN tenant's trail.
// T-0514: the route historically hardcoded DEV_TENANT_ID for all actors, so any
// self-registered tenant owner saw an empty trail (their rows live under their
// REAL tenant, not the Dev Silo). The fix wires resolveActorTenant into the route
// (same pattern as spend.ts / registry-defs.ts).
//
// Test strategy:
//   - TENANT_X: actor "owner-x" — has one grant.create row. Must be RETURNED.
//   - TENANT_Y: actor "owner-y" — has one grant.create row for a different tenant.
//     Must NOT appear when querying as owner-x (isolation check).
//   - Both tenants are fresh random UUIDs, guaranteed ≠ DEV_TENANT_ID.
//
// Run:
//   DATABASE_URL=postgres://choros_migrator:choros_migrator_dev_pw@localhost:5432/choros \
//   npx vitest run --dir ci/checks/db --no-file-parallelism \
//     ci/checks/db/grant_trail_route.db.test.ts \
//     --testTimeout=120000 --hookTimeout=120000

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerGrantTrailRoutes } from '../../../src/http/grant-trail.js';

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

function requireDb<T>(fn: () => Promise<T>): () => Promise<T | void> {
  return async () => {
    if (!process.env['DATABASE_URL']) {
      console.log('[skip] DATABASE_URL not set');
      return;
    }
    return fn();
  };
}

const hasDb = Boolean(process.env['DATABASE_URL']);

// ---------------------------------------------------------------------------
// Two fresh random tenants — both guaranteed ≠ DEV_TENANT_ID (a0000000-…-001).
// ---------------------------------------------------------------------------

const TENANT_X = uuid();
const TENANT_Y = uuid();

// Unique actor slugs for this run — avoids collisions across reruns.
const OWNER_X = `owner-x-${TENANT_X.slice(0, 8)}`;
const OWNER_Y = `owner-y-${TENANT_Y.slice(0, 8)}`;

// Unique seq base to avoid collision with other parallel tests.
const SEQ_BASE = Math.floor(Math.random() * 8_000_000) + 1_000_000;

// ---------------------------------------------------------------------------
// Stub resolver: maps slug → fresh random tenant (mimics resolveActorTenant).
// ---------------------------------------------------------------------------

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === OWNER_X) return TENANT_X;
  if (slug === OWNER_Y) return TENANT_Y;
  throw new Error(`unknown test actor: ${slug}`);
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
  // audit_head row is required by the GUC pattern (some setups enforce it).
  await c.query(
    `INSERT INTO choros.audit_head (tenant_id, seq, row_hash, updated_at, vocab_version)
     VALUES ($1, 0, '\\x00'::bytea, 0, 1) ON CONFLICT DO NOTHING`,
    [tenantId],
  );
}

// ---------------------------------------------------------------------------
// T-0736: GET /api/grant-trail now gates on resolveActorPrivilege(...)
// .isOwnerOrAdmin (admin/owner authority) — this pre-existing tenant-isolation
// regression test drove the route as a bare dev-header slug with NO backing
// `choros.employee` row at all (dev mode's extractActor trusts the header
// verbatim; the route itself resolved no authority before this task). Under
// the new gate that resolves to isOwnerOrAdmin=false → 403, breaking the
// "legitimate path" this file exists to prove. Fix: seed OWNER_X/OWNER_Y as
// genuine genesis tenant-owners (role.slug='tenant-owner', confirmed_by set)
// in their respective tenants — the SAME shape
// rights-change-requests-deactivated-approver.db.test.ts uses to seed a real
// human employee, extended with a tenant-owner role_assignment.
// ---------------------------------------------------------------------------
async function seedGenesisOwner(c: pg.Client, tenantId: string, slug: string): Promise<void> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [tenantId, deptId, `t0736-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [tenantId, posId, deptId, `t0736-pos-${posId.slice(0, 8)}`],
  );
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at, deactivated_at)
     VALUES ($1, $2, $3, 'human', $4, $4, 0, 0, NULL)`,
    [tenantId, empId, posId, slug],
  );
  const roleId = uuid();
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, 'tenant-owner', 'Tenant Owner', NULL, 0, 0)`,
    [tenantId, roleId],
  );
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope,
        valid_from, valid_until, source, granted_by,
        proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb,
             NULL, NULL, 'seed', 'seed',
             NULL, $6, NULL, 0, 0)`,
    [
      tenantId,
      uuid(),
      empId,
      roleId,
      JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: deptId, nodeLevel: 'department' }),
      slug,
    ],
  );
}

async function seedGrantEvent(
  c: pg.Client,
  tenantId: string,
  seq: number,
  actor: string,
  subject: string,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(
    `INSERT INTO choros.audit_event
       (tenant_id, seq, id, type, actor, subject, payload, occurred_at,
        prev_hash, row_hash, vocab_version)
     VALUES ($1, $2, $3, 'grant.create', $4, $5,
             '{"resourceType":"record","operation":"read"}'::jsonb, $6,
             '\\x00'::bytea, '\\x01'::bytea, 1)
     ON CONFLICT (tenant_id, seq) DO NOTHING`,
    [tenantId, seq, id, actor, subject, Date.now()],
  );
  await c.query('COMMIT');
  return id;
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
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;

// Seeded row IDs for assertions.
let rowXId = '';
let rowYId = '';

beforeAll(async () => {
  if (!hasDb) return;
  appPool = new pg.Pool({ connectionString: appUrl() });

  const router = new Router();
  registerGrantTrailRoutes(router, {
    pool: appPool,
    resolveActorTenant: stubResolveActorTenant,
  });
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  await withClient(migratorUrl(), async (c) => {
    await seedTenant(c, TENANT_X);
    await seedTenant(c, TENANT_Y);
    // T-0736: OWNER_X/OWNER_Y must be real genesis tenant-owners — the route
    // now gates GET /api/grant-trail on admin/owner authority.
    await seedGenesisOwner(c, TENANT_X, OWNER_X);
    await seedGenesisOwner(c, TENANT_Y, OWNER_Y);
    rowXId = await seedGrantEvent(c, TENANT_X, SEQ_BASE + 1, OWNER_X, 'role-x-test');
    rowYId = await seedGrantEvent(c, TENANT_Y, SEQ_BASE + 2, OWNER_Y, 'role-y-test');
  });
});

afterAll(async () => {
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/grant-trail — real tenant resolution (T-0514)', () => {
  it(
    'actor sees their OWN tenant trail (not DEV_TENANT_ID)',
    requireDb(async () => {
      const r = await request(baseUrl, 'GET', '/api/grant-trail', { 'x-dev-user': OWNER_X });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body) as { rows: Array<{ id: string; actor: string; subject: string }>; hasMore: boolean };
      expect(Array.isArray(body.rows)).toBe(true);
      // The row seeded under TENANT_X must be present.
      const ourRow = body.rows.find((row) => row.id === rowXId);
      expect(ourRow).toBeDefined();
      expect(ourRow!.subject).toBe('role-x-test');
    }),
  );

  it(
    'TENANT_Y row does NOT appear in TENANT_X trail (cross-tenant isolation)',
    requireDb(async () => {
      const r = await request(baseUrl, 'GET', '/api/grant-trail', { 'x-dev-user': OWNER_X });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body) as { rows: Array<{ id: string }> };
      // The row belonging to TENANT_Y must never leak into TENANT_X query.
      const leaked = body.rows.find((row) => row.id === rowYId);
      expect(leaked).toBeUndefined();
    }),
  );

  it(
    'actor-Y sees their OWN trail and not TENANT_X rows',
    requireDb(async () => {
      const r = await request(baseUrl, 'GET', '/api/grant-trail', { 'x-dev-user': OWNER_Y });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body) as { rows: Array<{ id: string }> };
      const ourRow = body.rows.find((row) => row.id === rowYId);
      expect(ourRow).toBeDefined();
      const leaked = body.rows.find((row) => row.id === rowXId);
      expect(leaked).toBeUndefined();
    }),
  );
});
