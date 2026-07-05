// T-0610 · invoke-путь → единый grant-resolver — LIVE Postgres integration probe.
//
// Run on the server CI / locally against the compose Postgres:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npm run fitness:db
//
// WHY THIS EXISTS (F-1, security-ревью T-0605, docs/review/T-0605.review.json):
// src/http/invoke.ts::loadCallerInvokeGrants ran its OWN inline SQL — a SECOND
// authority path parallel to getGrantsForSubject (grants-dao.ts), the ONE
// resolver every other PDP consumer uses. The inline query had NO
// assignment-active predicate (no confirmed_by, no window, no T-0605 canonical
// confirmed2_by/proposed_by gate) and NO grant-active predicate (no
// confirmed_by, no window, no T-0397 criticalGrantPredicate + confirmed2_by
// dual-control gate) — filtering ONLY on operation='invoke'. Since
// resource_type='effect_resource' AND operation='invoke' is itself axis-b of
// the critical-grant classification, an invoke-grant confirmed by only ONE
// approver (semi-confirmed) was silently treated as PDP-active, and an
// unconfirmed/expired role assignment still yielded the grant.
//
// T-0610 rewires loadCallerInvokeGrants to call getGrantsForSubject (then
// filter operation==='invoke' in TS) — the SAME resolver+predicates
// capability-grants-dao.ts and every other consumer use (ADR-T0610 §2). This
// probe seeds the exact failure shapes into a fresh tenant and proves, against
// the REAL SQL, that:
//
//   AC-2 — an UNCONFIRMED role assignment (confirmed_by NULL) to a role
//          holding an invoke-grant yields ZERO invoke-grants for that caller
//          (the raw grant/assignment rows exist; getGrantsForSubject excludes
//          them at the assignment-active gate, step 2).
//   AC-2 — an EXPIRED role assignment (valid_until in the past) → same: zero.
//   AC-3 — a CRITICAL invoke-grant (resource_type='effect_resource',
//          operation='invoke') confirmed by only ONE approver
//          (confirmed2_by NULL) is EXCLUDED — dual-control not bypassed.
//   AC-3 — the SAME shape with confirmed2_by SET (two approvers) IS included.
//   regression — a ROUTINE, fully-confirmed assignment + fully-confirmed
//          (dual-controlled) invoke-grant resolves normally (the legitimate
//          agent-invoke setup keeps working).
//
// Generic by construction (D-064): no case literals — every slug/role/scope
// value is a fresh uuid()-suffixed fixture, mirroring
// rights-eligibility-sew.db.test.ts / grants-dao-dual-control.db.test.ts.
//
// Seeding goes through migratorUrl() (BYPASSRLS); getGrantsForSubject runs
// through a choros_app Pool (RLS-enforced) — the real production read path
// invoke.ts now delegates to. A fresh per-suite tenant keeps rows off the dev
// seed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, uuid } from './_helpers.js';
import { getGrantsForSubject } from '../../../src/db/grants-dao.js';

const NOW = 3_000_000; // fixed instant for deterministic window math
const EXPIRED_UNTIL = 1_000_000; // < NOW → expired

let _pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: appUrl() });
  return _pool;
}

const TENANT = uuid();

type EmpFx = { id: string; slug: string };
const EMPTY_EMP: EmpFx = { id: '', slug: '' };
const fx: {
  empUnconfirmedAssignment: EmpFx; // routine invoke-grant, but assignment confirmed_by NULL
  empExpiredAssignment: EmpFx;     // routine invoke-grant, assignment valid_until in the past
  empSemiConfirmedGrant: EmpFx;    // confirmed assignment, invoke-grant confirmed2_by NULL
  empDualConfirmedGrant: EmpFx;    // confirmed assignment, invoke-grant confirmed2_by SET
  targetRoleId: string;            // the agent-role the invoke-grants target (resource_facet.agent_role_id)
} = {
  empUnconfirmedAssignment: EMPTY_EMP,
  empExpiredAssignment: EMPTY_EMP,
  empSemiConfirmedGrant: EMPTY_EMP,
  empDualConfirmedGrant: EMPTY_EMP,
  targetRoleId: '',
};

async function seedEmployee(c: pg.Client, slug: string): Promise<EmpFx> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [TENANT, deptId, `ig-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [TENANT, posId, deptId, `ig-pos-${posId.slice(0, 8)}`],
  );
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, 'human', $4, $4, 0, 0)`,
    [TENANT, empId, posId, slug],
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

/** Seed an invoke-grant on the role (axis-b critical: effect_resource+invoke).
 *  confirmed2By is null for semi-confirmed, or a distinct approver slug when dual-confirmed. */
async function seedInvokeGrant(
  c: pg.Client,
  args: { roleId: string; agentRoleId: string; confirmed2By: string | null },
): Promise<void> {
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet,
        operation, scope, "constraint", delegable, granted_by,
        valid_from, valid_until, created_at,
        proposed_by, confirmed_by, confirmed2_by)
     VALUES ($1, $2, $3, 'effect_resource', $4::jsonb,
             'invoke', $5::jsonb, NULL, false, 'seed',
             NULL, NULL, 0,
             'seed', 'seed', $6)`,
    [
      TENANT, uuid(), args.roleId,
      JSON.stringify({ agent_role_id: args.agentRoleId }),
      ORG_SCOPE,
      args.confirmed2By,
    ],
  );
}

/** Seed a role_assignment. Defaults to a ROUTINE, fully-confirmed, unbounded
 *  assignment (the real write-side shape for a normal role grant). Overrides
 *  let a fixture simulate "confirmed_by NULL" (unconfirmed) or an expired window. */
async function seedAssignment(
  c: pg.Client,
  args: { empId: string; roleId: string; confirmedBy: string | null; validUntil: number | null },
): Promise<void> {
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope,
        valid_from, valid_until, source, granted_by,
        proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb,
             NULL, $6, 'manual', 'seed',
             NULL, $7, NULL, 0, 0)`,
    [
      TENANT, uuid(), args.empId, args.roleId, ORG_SCOPE,
      args.validUntil, args.confirmedBy,
    ],
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
      [TENANT, `ig-${TENANT.slice(0, 8)}`],
    );
    await c.query('COMMIT');

    await c.query('BEGIN');

    fx.targetRoleId = uuid(); // stands in for the agent's role (resource_facet.agent_role_id) — no FK, opaque id is enough for this DAO-level probe

    // --- Fixture A: unconfirmed assignment -----------------------------------
    // Role holds a fully-confirmed invoke-grant (would pass step 3), but the
    // CALLER's own assignment to that role is never confirmed (confirmed_by
    // NULL). AC-2: getGrantsForSubject must return [] — the old inline query
    // had no assignment predicate at all and would have returned the grant.
    const roleUnconfirmed = await seedRole(c, `ig-role-unconf-${uuid().slice(0, 6)}`);
    await seedInvokeGrant(c, { roleId: roleUnconfirmed, agentRoleId: fx.targetRoleId, confirmed2By: 'seed2' });
    fx.empUnconfirmedAssignment = await seedEmployee(c, `ig-emp-unconf-${uuid().slice(0, 6)}`);
    await seedAssignment(c, {
      empId: fx.empUnconfirmedAssignment.id, roleId: roleUnconfirmed,
      confirmedBy: null, validUntil: null,
    });

    // --- Fixture B: expired assignment ---------------------------------------
    // Confirmed assignment, but its validity window already closed. AC-2: same
    // expectation — zero invoke-grants (the old inline query ignored the
    // window entirely).
    const roleExpired = await seedRole(c, `ig-role-expired-${uuid().slice(0, 6)}`);
    await seedInvokeGrant(c, { roleId: roleExpired, agentRoleId: fx.targetRoleId, confirmed2By: 'seed2' });
    fx.empExpiredAssignment = await seedEmployee(c, `ig-emp-expired-${uuid().slice(0, 6)}`);
    await seedAssignment(c, {
      empId: fx.empExpiredAssignment.id, roleId: roleExpired,
      confirmedBy: 'seed', validUntil: EXPIRED_UNTIL,
    });

    // --- Fixture C: semi-confirmed (one-approver) critical invoke-grant ------
    // Assignment is routine/confirmed (correct), but the invoke-grant ITSELF
    // has only one approver (confirmed2_by NULL). AC-3: must be excluded —
    // this is the sharpest F-1 gap (dual-control bypass on an axis-b grant).
    const roleSemiConfirmed = await seedRole(c, `ig-role-semi-${uuid().slice(0, 6)}`);
    await seedInvokeGrant(c, { roleId: roleSemiConfirmed, agentRoleId: fx.targetRoleId, confirmed2By: null });
    fx.empSemiConfirmedGrant = await seedEmployee(c, `ig-emp-semi-${uuid().slice(0, 6)}`);
    await seedAssignment(c, {
      empId: fx.empSemiConfirmedGrant.id, roleId: roleSemiConfirmed,
      confirmedBy: 'seed', validUntil: null,
    });

    // --- Fixture D: dual-confirmed (regression / happy path) -----------------
    // Fully-confirmed assignment + fully-confirmed (2 approvers) invoke-grant —
    // the legitimate setup MUST keep working post-fix.
    const roleDualConfirmed = await seedRole(c, `ig-role-dual-${uuid().slice(0, 6)}`);
    await seedInvokeGrant(c, { roleId: roleDualConfirmed, agentRoleId: fx.targetRoleId, confirmed2By: 'seed2' });
    fx.empDualConfirmedGrant = await seedEmployee(c, `ig-emp-dual-${uuid().slice(0, 6)}`);
    await seedAssignment(c, {
      empId: fx.empDualConfirmedGrant.id, roleId: roleDualConfirmed,
      confirmedBy: 'seed', validUntil: null,
    });

    await c.query('COMMIT');
  } finally {
    await c.end();
  }
});

afterAll(async () => {
  if (_pool) await _pool.end();
});

// ---------------------------------------------------------------------------
// AC-2 — assignment-active predicate: unconfirmed / expired assignment
// excludes the invoke-grant, even though the raw grant row is fully confirmed.
// ---------------------------------------------------------------------------
describe('T-0610 AC-2 — invoke-grant excluded when the CALLER assignment is not PDP-active', () => {
  it('unconfirmed assignment (confirmed_by NULL) → zero invoke-grants', async () => {
    const grants = await getGrantsForSubject(getPool(), TENANT, fx.empUnconfirmedAssignment.slug, NOW);
    const invokeGrants = grants.filter((g) => g.operation === 'invoke');
    expect(invokeGrants).toEqual([]);
  });

  it('expired assignment (valid_until in the past) → zero invoke-grants', async () => {
    const grants = await getGrantsForSubject(getPool(), TENANT, fx.empExpiredAssignment.slug, NOW);
    const invokeGrants = grants.filter((g) => g.operation === 'invoke');
    expect(invokeGrants).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-3 — grant-level dual-control: a semi-confirmed (one-approver) CRITICAL
// invoke-grant (axis-b: effect_resource + invoke) is excluded; the same grant
// dual-confirmed is included. This is the exact F-1 gap.
// ---------------------------------------------------------------------------
describe('T-0610 AC-3 — invoke-grant dual-control (T-0397) is honored, not bypassed', () => {
  it('semi-confirmed critical invoke-grant (confirmed2_by NULL) → EXCLUDED (was included pre-fix)', async () => {
    const grants = await getGrantsForSubject(getPool(), TENANT, fx.empSemiConfirmedGrant.slug, NOW);
    const invokeGrants = grants.filter((g) => g.operation === 'invoke');
    expect(invokeGrants).toEqual([]);
  });

  it('dual-confirmed critical invoke-grant (confirmed2_by set) → INCLUDED (regression: legitimate setup still works)', async () => {
    const grants = await getGrantsForSubject(getPool(), TENANT, fx.empDualConfirmedGrant.slug, NOW);
    const invokeGrants = grants.filter((g) => g.operation === 'invoke');
    expect(invokeGrants).toHaveLength(1);
    expect(invokeGrants[0]?.operation).toBe('invoke');
    expect(invokeGrants[0]?.resourceType).toBe('effect_resource');
    const facet = invokeGrants[0]?.resourceFacet as Record<string, unknown> | undefined;
    expect(facet?.['agent_role_id']).toBe(fx.targetRoleId);
  });
});
