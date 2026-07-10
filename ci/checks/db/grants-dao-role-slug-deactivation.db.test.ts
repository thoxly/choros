// T-0738 [security P1, substrate] · getRoleSlugsForActor deactivation gate —
// LIVE Postgres integration probe.
//
// Run: DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npm run fitness:db  (or vitest run against this file directly)
//
// WHY THIS EXISTS (docs/tasks/T-0738.adr.md): judge T-0726 (ADR-T0726 §5.2,
// finding `inbox.ts:GET:/api/inbox[/:id]`) found `getRoleSlugsForActor`
// (src/db/grants-dao.ts:431) — the resolver `resolveRolesForActor` (inbox.ts)
// uses to filter the pool tab — resolved an employee by slug+tenant WITHOUT
// `deactivated_at IS NULL`. The WRITE paths (claim/approve) already gate
// deactivation locally BEFORE ever reaching this resolver, but the READ path
// (`GET /api/inbox`) does not — a deactivated employee whose role_assignment
// was not separately revoked kept seeing the pool tab (and its badge count)
// populated for the role they used to hold, for the residual ~300s window
// their already-issued access-JWT stays valid (T-0702).
//
// COVERAGE (T-0738.adr.md §6):
//   AC-1  — deactivated actor (role assigned, role_assignment intact) →
//           getRoleSlugsForActor returns [] (fail-closed).
//   AC-1+ — positive control: an ACTIVE actor with the identical assignment
//           shape → the role IS resolved (no regression).
//   AC-2  — T-0366 fallback: deactivated primary + ACTIVE fallback
//           (preferred_username) → the fallback identity resolves roles
//           normally (deactivation of the primary slug does not suppress the
//           independent fallback check).
//   AC-2+ — deactivated fallback identity → [] (the predicate applies to
//           BOTH lookups, not just the primary).
//   AC-3  — HTTP, live route: GET /api/inbox?tab=pool as a deactivated role
//           holder returns an empty pool tab (items=[], counts.pool=0);
//           positive control — an ACTIVE holder of the same role sees the
//           pool task.
//
// Generic by construction (D-064): no case literals — every slug/role/scope
// value is a fresh uuid()-suffixed fixture, mirroring
// grants-dao-subject-deactivation.db.test.ts (T-0658) /
// grants-dao-deactivated.db.test.ts (T-0588) / inbox-actor-resolve.db.test.ts
// (T-0648).
//
// Seeding goes through migratorUrl() (BYPASSRLS); getRoleSlugsForActor and the
// HTTP route run through a choros_app Pool (RLS-enforced) — the real
// production read path.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, appUrl, uuid } from './_helpers.js';
import { getRoleSlugsForActor } from '../../../src/db/grants-dao.js';
import { Router } from '../../../src/http/router.js';
import { registerInboxRoutes, type InboxWriteDeps } from '../../../src/http/inbox.js';
import { appendProcessStarted } from '../../../src/http/process-projection.js';
import type { PgClientLike } from '../../../src/db/audit-writer.js';

const NOW = 2_000_000; // fixed instant for deterministic window math

let _pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: appUrl() });
  return _pool;
}

const TENANT = uuid();

type EmpFx = { id: string; slug: string };
const EMPTY_EMP: EmpFx = { id: '', slug: '' };

const fx: {
  deactivatedHolder: EmpFx;
  activeHolder: EmpFx;
  fallbackDeactivatedPrimary: EmpFx; // primary slug row (deactivated) — never resolved
  fallbackActiveTarget: EmpFx; // the ACTUAL fallback-resolved employee (active)
  fallbackDeactivatedTarget: EmpFx; // the fallback-resolved employee (deactivated)
  roleSlug: string;
} = {
  deactivatedHolder: EMPTY_EMP,
  activeHolder: EMPTY_EMP,
  fallbackDeactivatedPrimary: EMPTY_EMP,
  fallbackActiveTarget: EMPTY_EMP,
  fallbackDeactivatedTarget: EMPTY_EMP,
  roleSlug: '',
};

async function seedEmployee(
  c: pg.Client,
  tenantId: string,
  slug: string,
  opts?: { deactivatedAt?: number },
): Promise<EmpFx> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [tenantId, deptId, `t0738-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [tenantId, posId, deptId, `t0738-pos-${posId.slice(0, 8)}`],
  );
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at, deactivated_at)
     VALUES ($1, $2, $3, 'human', $4, $4, 0, 0, $5)`,
    [tenantId, empId, posId, slug, opts?.deactivatedAt ?? null],
  );
  return { id: empId, slug };
}

async function seedRole(c: pg.Client, tenantId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 0, 0)`,
    [tenantId, id, slug],
  );
  return id;
}

const ORG_SCOPE = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });

async function seedAssignment(c: pg.Client, tenantId: string, args: { empId: string; roleId: string }): Promise<void> {
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope,
        valid_from, valid_until, source, granted_by,
        proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb,
             NULL, NULL, 'seed', 'seed',
             NULL, 'seed', NULL, 0, 0)`,
    [tenantId, uuid(), args.empId, args.roleId, ORG_SCOPE],
  );
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
      [TENANT, `t0738-${TENANT.slice(0, 8)}`],
    );
    await c.query('COMMIT');

    await c.query('BEGIN');

    fx.roleSlug = `t0738-role-${uuid().slice(0, 6)}`;
    const roleId = await seedRole(c, TENANT, fx.roleSlug);

    // AC-1: deactivated holder, role_assignment intact (not separately revoked).
    fx.deactivatedHolder = await seedEmployee(c, TENANT, `t0738-deact-${uuid().slice(0, 6)}`, {
      deactivatedAt: 500_000,
    });
    await seedAssignment(c, TENANT, { empId: fx.deactivatedHolder.id, roleId });

    // AC-1+: positive control — active holder of the SAME role.
    fx.activeHolder = await seedEmployee(c, TENANT, `t0738-active-${uuid().slice(0, 6)}`);
    await seedAssignment(c, TENANT, { empId: fx.activeHolder.id, roleId });

    // AC-2/AC-2+: T-0366 fallback fixtures — a deactivated PRIMARY-slug row that
    // must never resolve, plus separate ACTIVE and DEACTIVATED fallback-target
    // employees (the "preferred_username" identity) each holding the role.
    fx.fallbackDeactivatedPrimary = await seedEmployee(c, TENANT, `t0738-fbprimary-${uuid().slice(0, 6)}`, {
      deactivatedAt: 500_000,
    });
    // No role_assignment for the primary — it exists only to prove the primary
    // lookup itself is deactivation-gated (AC-2 uses a primary slug with NO
    // employee row at all, matching the real T-0366 KC-sub shape, so this
    // fixture is unused by AC-2/AC-2+ directly but documents the primary-slug
    // deactivation case is ALSO covered by AC-1 above via the same predicate).

    fx.fallbackActiveTarget = await seedEmployee(c, TENANT, `t0738-fbactive-${uuid().slice(0, 6)}`);
    await seedAssignment(c, TENANT, { empId: fx.fallbackActiveTarget.id, roleId });

    fx.fallbackDeactivatedTarget = await seedEmployee(c, TENANT, `t0738-fbdeact-${uuid().slice(0, 6)}`, {
      deactivatedAt: 500_000,
    });
    await seedAssignment(c, TENANT, { empId: fx.fallbackDeactivatedTarget.id, roleId });

    await c.query('COMMIT');
  } finally {
    await c.end();
  }
});

afterAll(async () => {
  if (_pool) await _pool.end();
});

// ---------------------------------------------------------------------------
// AC-1 / AC-1+ — DAO level: primary-slug lookup
// ---------------------------------------------------------------------------
describe('T-0738 AC-1 — getRoleSlugsForActor excludes a DEACTIVATED actor (fail-closed)', () => {
  it('deactivated actor with an intact, confirmed role_assignment → []', async () => {
    const slugs = await getRoleSlugsForActor(getPool(), TENANT, fx.deactivatedHolder.slug, NOW);
    expect(slugs).toEqual([]);
  });
});

describe('T-0738 AC-1+ — positive control: ACTIVE actor unaffected (no regression)', () => {
  it('active actor with the identical assignment shape → role IS resolved', async () => {
    const slugs = await getRoleSlugsForActor(getPool(), TENANT, fx.activeHolder.slug, NOW);
    expect(slugs).toContain(fx.roleSlug);
  });
});

// ---------------------------------------------------------------------------
// AC-2 / AC-2+ — T-0366 fallback lookup
// ---------------------------------------------------------------------------
describe('T-0738 AC-2 — T-0366 fallback: deactivated/absent primary + ACTIVE fallback resolves normally', () => {
  it('primary slug has no employee row, ACTIVE fallback (preferred_username) resolves roles', async () => {
    const noSuchPrimary = `t0738-nonexistent-primary-${uuid().slice(0, 8)}`;
    const slugs = await getRoleSlugsForActor(
      getPool(),
      TENANT,
      noSuchPrimary,
      NOW,
      fx.fallbackActiveTarget.slug,
    );
    expect(slugs).toContain(fx.roleSlug);
  });
});

describe('T-0738 AC-2+ — T-0366 fallback: DEACTIVATED fallback identity → [] (predicate on both lookups)', () => {
  it('primary slug has no employee row, DEACTIVATED fallback → []', async () => {
    const noSuchPrimary = `t0738-nonexistent-primary-${uuid().slice(0, 8)}`;
    const slugs = await getRoleSlugsForActor(
      getPool(),
      TENANT,
      noSuchPrimary,
      NOW,
      fx.fallbackDeactivatedTarget.slug,
    );
    expect(slugs).toEqual([]);
  });

  it('DEACTIVATED primary slug (has an employee row) falls through to an ACTIVE fallback', async () => {
    // The primary slug DOES have an employee row (fallbackDeactivatedPrimary),
    // but it is deactivated — the primary lookup must miss it (same predicate
    // as AC-1), which then tries the fallback exactly like an unknown primary
    // would (documented fail-closed "deactivated ≈ unknown" shape, T-0738.adr.md §2).
    const slugs = await getRoleSlugsForActor(
      getPool(),
      TENANT,
      fx.fallbackDeactivatedPrimary.slug,
      NOW,
      fx.fallbackActiveTarget.slug,
    );
    expect(slugs).toContain(fx.roleSlug);
  });
});

// ---------------------------------------------------------------------------
// AC-3 — HTTP level: GET /api/inbox?tab=pool through the real route
// ---------------------------------------------------------------------------
describe('T-0738 AC-3 — GET /api/inbox?tab=pool excludes a deactivated role holder (live route)', () => {
  let server: http.Server;
  let baseUrl = '';
  let appPool: pg.Pool;
  let httpTenant = '';
  let httpRoleSlug = '';
  let deactivatedActor: EmpFx = EMPTY_EMP;
  let activeActor: EmpFx = EMPTY_EMP;

  function makeRequest(
    method: string,
    path: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(baseUrl + path);
      const req = http.request(
        { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method, headers: extraHeaders },
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

  beforeAll(async () => {
    appPool = new pg.Pool({ connectionString: appUrl() });
    const router = new Router();
    const writeDeps: InboxWriteDeps = {
      pool: appPool,
      resolveActorTenant: async () => {
        throw new Error('unused in this probe — GET /api/inbox resolves tenant via db/org.ts');
      },
    };
    registerInboxRoutes(router, undefined, writeDeps);
    server = http.createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((resolve) => {
      server.listen(0, 'localhost', () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });

    httpTenant = uuid();
    httpRoleSlug = `t0738-http-role-${uuid().slice(0, 6)}`;

    const c = new pg.Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${httpTenant}'`);
      await c.query(
        `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
         VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
        [httpTenant, `t0738-http-${httpTenant.slice(0, 8)}`],
      );
      const roleId = await seedRole(c, httpTenant, httpRoleSlug);
      deactivatedActor = await seedEmployee(c, httpTenant, `t0738-http-deact-${uuid().slice(0, 6)}`, {
        deactivatedAt: 500_000,
      });
      await seedAssignment(c, httpTenant, { empId: deactivatedActor.id, roleId });
      activeActor = await seedEmployee(c, httpTenant, `t0738-http-active-${uuid().slice(0, 6)}`);
      await seedAssignment(c, httpTenant, { empId: activeActor.id, roleId });

      // A single unclaimed pool task addressed to httpRoleSlug.
      await appendProcessStarted(c as unknown as PgClientLike, {
        instanceId: uuid(),
        procKey: `t0738-proc-${uuid().slice(0, 6)}`,
        actor: 'system:test-seed',
        nowMs: Date.now(),
        approverRole: httpRoleSlug,
        tenantId: httpTenant,
      });
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      await c.end();
    }
  });

  afterAll(async () => {
    if (appPool) await appPool.end();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('deactivated role holder sees an EMPTY pool tab (items=[], counts.pool=0)', async () => {
    const res = await makeRequest('GET', '/api/inbox?tab=pool', { 'x-dev-user': deactivatedActor.slug });
    expect(res.statusCode, res.body).toBe(200);
    const parsed = JSON.parse(res.body) as { items: unknown[]; counts: Record<string, number> };
    expect(parsed.items).toEqual([]);
    expect(parsed.counts['pool']).toBe(0);
  });

  it('positive control: ACTIVE role holder still sees the pool task (no regression)', async () => {
    const res = await makeRequest('GET', '/api/inbox?tab=pool', { 'x-dev-user': activeActor.slug });
    expect(res.statusCode, res.body).toBe(200);
    const parsed = JSON.parse(res.body) as { items: Array<{ role: string }>; counts: Record<string, number> };
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.counts['pool']).toBeGreaterThan(0);
    for (const item of parsed.items) {
      expect(item.role).toBe(httpRoleSlug);
    }
  });
});
