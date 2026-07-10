// T-0737 (security P1, substrate) · audit-surface READ-PDP/ACTOR_ACTIVE gate —
// LIVE Postgres integration probe.
//
// Run on the server CI / locally against the compose Postgres:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npm run fitness:db
//
// WHY THIS EXISTS (T-0726 judge finding on T-0702's R-3, confirmed by the
// ci/checks/actor-active-route-coverage.sh live run): GET /api/audit,
// GET /api/audit/export and GET /api/audit/:instanceId carried a
// "FORWARD-OBLIGATION: no PDP gate in dev slice... all three routes must be
// closed together" comment since T-0138/T-0500. /api/audit itself already had
// a real owner-only gate (loadAdminContext); /export only checked that an
// x-dev-user header was PRESENT (not WHO); /:instanceId had NO gate at all —
// a live-but-DEACTIVATED actor's residual JWT window (~300s, offline-JWKS,
// KC session revocation cannot shrink an already-issued access token) would
// read the export and instance-trace surfaces unfiltered.
//
// THE FIX (T-0737): all three routes now share ONE gate, requireAuditRead()
// (src/http/audit.ts) — extractActor -> resolveActorTenant -> loadAdminContext
// -> holdsAuditRead (genesis-owner ONLY, T-0500 policy, no new authority path).
// loadAdminContext's OWN deactivation predicate (`deactivated_at IS NULL`,
// ACTOR_ACTIVE_SQL) is already proven at the resolver level by
// ci/checks/db/org-admin-deactivation.db.test.ts (T-0658) — THIS probe proves
// the WIRING: that the real HTTP routes actually reach that resolver and
// honour its verdict, end-to-end, through a real http.Server + a real
// choros_migrator Pool (the production grantsPool credential — server.ts
// passes `new Pool({ connectionString: DATABASE_URL })`, BYPASSRLS, to
// registerAuditRoutes; mirrored here via migratorUrl(), not the RLS-enforced
// app pool, exactly like rights-change-requests-deactivated-approver.db.test.ts).
//
// COVERAGE — all three routes, both DEACTIVATED-owner and non-owner-active vectors,
// plus a positive control:
//   AC-1  DEACTIVATED tenant-owner  -> GET /api/audit               -> 403
//   AC-2  DEACTIVATED tenant-owner  -> GET /api/audit/export         -> 403
//   AC-3  DEACTIVATED tenant-owner  -> GET /api/audit/:instanceId    -> 403
//   AC-4  ACTIVE non-owner member   -> GET /api/audit               -> 403
//   AC-5  ACTIVE non-owner member   -> GET /api/audit/export         -> 403
//   AC-6  ACTIVE non-owner member   -> GET /api/audit/:instanceId    -> 403
//   AC-7  positive control: ACTIVE tenant-owner -> all three routes  -> 200
//         (proves the gate blocks ONLY deactivation/non-ownership, not every
//         reader — a legitimate audit reader is never broken by this fix)
//
// Generic by construction (D-064): no case literals beyond the schema-defined
// 'tenant-owner' role slug (migration 026, lattice root); every employee/dept/
// position/role slug is uuid()-suffixed. Seeding goes through migratorUrl()
// (BYPASSRLS); the routes ALSO run through migratorUrl() (mirrors the real
// production wiring, see above) — a fresh per-suite tenant keeps rows off the
// dev seed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerAuditRoutes } from '../../../src/http/audit.js';

const DEACT_AT = 500_000; // epoch-ms; any non-null value marks the row deactivated.

let _pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: migratorUrl() });
  return _pool;
}

const TENANT = uuid();

type EmpFx = { id: string; slug: string };
const EMPTY_EMP: EmpFx = { id: '', slug: '' };

const fx: {
  ownerDeactivated: EmpFx;
  ownerActive: EmpFx;
  memberActive: EmpFx; // active human, NO tenant-owner role assignment at all
} = {
  ownerDeactivated: EMPTY_EMP,
  ownerActive: EMPTY_EMP,
  memberActive: EMPTY_EMP,
};

async function seedEmployee(
  c: pg.Client,
  slug: string,
  opts?: { deactivatedAt?: number },
): Promise<EmpFx> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [TENANT, deptId, `t0737-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [TENANT, posId, deptId, `t0737-pos-${posId.slice(0, 8)}`],
  );
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at, deactivated_at)
     VALUES ($1, $2, $3, 'human', $4, $4, 0, 0, $5)`,
    [TENANT, empId, posId, slug, opts?.deactivatedAt ?? null],
  );
  return { id: empId, slug };
}

async function seedRole(c: pg.Client, slug: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 0, 0)`,
    [TENANT, id, slug],
  );
  return id;
}

const ORG_SCOPE = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });

async function seedOwnerAssignment(c: pg.Client, args: { empId: string; roleId: string }): Promise<void> {
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope,
        valid_from, valid_until, source, granted_by,
        proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb,
             NULL, NULL, 'seed', 'seed',
             NULL, 'seed', NULL, 0, 0)`,
    [TENANT, uuid(), args.empId, args.roleId, ORG_SCOPE],
  );
}

// ---------------------------------------------------------------------------
// Real HTTP server driving the REAL audit routes (registerAuditRoutes).
// ---------------------------------------------------------------------------

let baseUrl = '';
let closeServer: () => Promise<void> = async () => {};

function req(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const httpReq = http.request(
      new URL(baseUrl + path),
      { method: 'GET', headers },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    httpReq.on('error', reject);
    httpReq.end();
  });
}

beforeAll(async () => {
  const c = new pg.Client({ connectionString: migratorUrl() });
  await c.connect();
  try {
    await c.query('SET search_path TO choros;');
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
       VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
      [TENANT, `t0737-${TENANT.slice(0, 8)}`],
    );
    await c.query('COMMIT');

    await c.query('BEGIN');
    const ownerRoleId = await seedRole(c, 'tenant-owner');

    fx.ownerDeactivated = await seedEmployee(c, `t0737-owner-deact-${uuid().slice(0, 6)}`, {
      deactivatedAt: DEACT_AT,
    });
    await seedOwnerAssignment(c, { empId: fx.ownerDeactivated.id, roleId: ownerRoleId });

    fx.ownerActive = await seedEmployee(c, `t0737-owner-active-${uuid().slice(0, 6)}`);
    await seedOwnerAssignment(c, { empId: fx.ownerActive.id, roleId: ownerRoleId });

    // An ACTIVE human with NO role_assignment at all (ordinary tenant member).
    fx.memberActive = await seedEmployee(c, `t0737-member-active-${uuid().slice(0, 6)}`);

    await c.query('COMMIT');
  } finally {
    await c.end();
  }

  const router = new Router();
  // Mirrors production wiring (src/server.ts:595): registerAuditRoutes(router,
  // store, grantsPool) — grantsPool is the BYPASSRLS choros_migrator Pool.
  registerAuditRoutes(router, undefined, getPool());
  const server = http.createServer(router.dispatch.bind(router));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
  closeServer = () => new Promise((res) => server.close(() => res()));
});

afterAll(async () => {
  await closeServer();
  if (_pool) { await _pool.end(); _pool = null; }
});

// ---------------------------------------------------------------------------
// AC-1..3 — a DEACTIVATED tenant-owner is rejected on all three routes.
// ---------------------------------------------------------------------------
describe('T-0737 AC-1..3 — a DEACTIVATED tenant-owner cannot read any audit-surface route (live JWT, residual window)', () => {
  it('GET /api/audit -> 403', async () => {
    const r = await req('/api/audit', { 'x-dev-user': fx.ownerDeactivated.slug });
    expect(r.status).toBe(403);
  });

  it('GET /api/audit/export -> 403', async () => {
    const r = await req('/api/audit/export', { 'x-dev-user': fx.ownerDeactivated.slug });
    expect(r.status).toBe(403);
  });

  it('GET /api/audit/INS-7731 -> 403', async () => {
    const r = await req('/api/audit/INS-7731', { 'x-dev-user': fx.ownerDeactivated.slug });
    expect(r.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// AC-4..6 — an ACTIVE but non-owner tenant member is rejected on all three
// routes (this is the T-0500 owner-only policy, not deactivation — proves the
// gate is APPLIED on the export/instance surfaces exactly like /api/audit).
// ---------------------------------------------------------------------------
describe('T-0737 AC-4..6 — an ACTIVE non-owner member cannot read any audit-surface route (owner-only policy)', () => {
  it('GET /api/audit -> 403', async () => {
    const r = await req('/api/audit', { 'x-dev-user': fx.memberActive.slug });
    expect(r.status).toBe(403);
  });

  it('GET /api/audit/export -> 403', async () => {
    const r = await req('/api/audit/export', { 'x-dev-user': fx.memberActive.slug });
    expect(r.status).toBe(403);
  });

  it('GET /api/audit/INS-7731 -> 403', async () => {
    const r = await req('/api/audit/INS-7731', { 'x-dev-user': fx.memberActive.slug });
    expect(r.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// AC-7 — positive control: an ACTIVE tenant-owner reads all three routes fine.
// A legitimate reader (owner) is never broken by this fix.
// ---------------------------------------------------------------------------
describe('T-0737 AC-7 — positive control: an ACTIVE tenant-owner reads every audit-surface route (no regression)', () => {
  it('GET /api/audit -> 200 { events, nextCursor }', async () => {
    const r = await req('/api/audit', { 'x-dev-user': fx.ownerActive.slug });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { events: unknown[]; nextCursor: string | null };
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('GET /api/audit/export -> 200 attachment', async () => {
    const r = await req('/api/audit/export', { 'x-dev-user': fx.ownerActive.slug });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { instance: { id: string } };
    expect(body.instance.id).toBe('INS-7731');
  });

  it('GET /api/audit/INS-7731 -> 200 with the demo trace', async () => {
    const r = await req('/api/audit/INS-7731', { 'x-dev-user': fx.ownerActive.slug });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { instance: { id: string } };
    expect(body.instance.id).toBe('INS-7731');
  });
});
