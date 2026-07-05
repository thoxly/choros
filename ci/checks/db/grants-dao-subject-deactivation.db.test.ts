// T-0658 (security/системный, столп 4) · getGrantsForSubject deactivation gate
// — LIVE Postgres integration probe.
//
// Run on the server CI / locally against the compose Postgres:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npm run fitness:db
//
// WHY THIS EXISTS: `getGrantsForSubject` (grants-dao.ts:208) is the ONE
// resolver every PDP consumer (invoke.ts, records.ts field/read-visibility,
// org.ts capability-token, sandbox-gate-dao.ts, capability-grants-dao.ts,
// registry-digest-dao.ts) uses. Its step 1 (subject slug → employee id) had NO
// `deactivated_at IS NULL` predicate — a deactivated (fired) employee still
// resolved to an employee row, so a still-live KC access token (KC
// `enabled:false` blocks only future token ISSUANCE, not an already-issued
// token before its own TTL expires) passed EVERY PDP consumer of this single
// resolver. `inbox.ts` grew its OWN local `deactivatedAt != null` gate
// (T-0588 BLOCK-3/RE-VERIFY) precisely because this upstream gap existed —
// this probe proves the gap is now closed AT THE SOURCE, not per-path.
//
// COVERAGE (spec T-0658.spec.md §5, ADR-T0658 §6):
//   AC-2 — a DEACTIVATED employee with a valid (confirmed + in-window +
//          dual-confirmed, since it is CRITICAL — resource_type=effect_resource
//          + operation=invoke, axis-b) invoke-grant → getGrantsForSubject
//          returns [] (red before the fix — the raw grant/assignment rows
//          exist and are fully PDP-active by every OTHER predicate).
//   AC-3 — positive control: the SAME grant shape, but the employee is
//          ACTIVE (deactivated_at NULL) → the grant IS returned (happy-path
//          unaffected by the fix).
//   AC-4 — a `kind='agent'` employee (agent_card, migration 032 — no
//          deactivation column of its own; deactivated_at is a column shared
//          with `employee` but structurally never set for agents, since the
//          only writer — PATCH /api/users/:employee_id — is human-only) with
//          the same grant shape → grant IS returned (the gate never
//          interferes with a legitimate agent resolution).
//
// Generic by construction (D-064): no case literals — every slug/role/scope
// value is a fresh uuid()-suffixed fixture, mirroring
// invoke-grant-resolver.db.test.ts (T-0610) / grants-dao-deactivated.db.test.ts
// (T-0588).
//
// Seeding goes through migratorUrl() (BYPASSRLS); getGrantsForSubject runs
// through a choros_app Pool (RLS-enforced) — the real production read path. A
// fresh per-suite tenant keeps rows off the dev seed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, uuid } from './_helpers.js';
import { getGrantsForSubject } from '../../../src/db/grants-dao.js';

const NOW = 3_000_000; // fixed instant for deterministic window math

let _pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: appUrl() });
  return _pool;
}

const TENANT = uuid();

type EmpFx = { id: string; slug: string };
const EMPTY_EMP: EmpFx = { id: '', slug: '' };

const fx: {
  deactivatedHolder: EmpFx;  // deactivated human, valid dual-confirmed invoke-grant
  activeHolder: EmpFx;       // active human, same grant shape (positive control)
  agentHolder: EmpFx;        // kind='agent', same grant shape (must be unaffected)
  roleDeactivated: string;
  roleActive: string;
  roleAgent: string;
  agentRoleTarget: string;   // opaque id standing in for resource_facet.agent_role_id
} = {
  deactivatedHolder: EMPTY_EMP,
  activeHolder: EMPTY_EMP,
  agentHolder: EMPTY_EMP,
  roleDeactivated: '',
  roleActive: '',
  roleAgent: '',
  agentRoleTarget: '',
};

async function seedEmployee(
  c: pg.Client,
  slug: string,
  opts?: { deactivatedAt?: number; kind?: 'human' | 'agent' },
): Promise<EmpFx> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [TENANT, deptId, `t0658-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [TENANT, posId, deptId, `t0658-pos-${posId.slice(0, 8)}`],
  );
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at, deactivated_at)
     VALUES ($1, $2, $3, $4, $5, $5, 0, 0, $6)`,
    [TENANT, empId, posId, opts?.kind ?? 'human', slug, opts?.deactivatedAt ?? null],
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

/** Fully-confirmed, unbounded role_assignment (routine, PDP-active by every
 *  OTHER predicate — isolates the deactivation gate as the only variable). */
async function seedAssignment(c: pg.Client, args: { empId: string; roleId: string }): Promise<void> {
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

/** A CRITICAL (axis-b: effect_resource + invoke), fully DUAL-CONFIRMED grant —
 *  PDP-active by every predicate EXCEPT the one under test (deactivation). */
async function seedInvokeGrant(c: pg.Client, args: { roleId: string; agentRoleId: string }): Promise<void> {
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet,
        operation, scope, "constraint", delegable, granted_by,
        valid_from, valid_until, created_at,
        proposed_by, confirmed_by, confirmed2_by)
     VALUES ($1, $2, $3, 'effect_resource', $4::jsonb,
             'invoke', $5::jsonb, NULL, false, 'seed',
             NULL, NULL, 0,
             'seed', 'seed', 'seed2')`,
    [
      TENANT, uuid(), args.roleId,
      JSON.stringify({ agent_role_id: args.agentRoleId }),
      ORG_SCOPE,
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
      [TENANT, `t0658-${TENANT.slice(0, 8)}`],
    );
    await c.query('COMMIT');

    await c.query('BEGIN');

    fx.agentRoleTarget = uuid(); // opaque id, no FK — DAO-level probe only

    // --- Fixture A: DEACTIVATED human, valid dual-confirmed invoke-grant -----
    // AC-2: getGrantsForSubject must return [] — before the fix, the raw
    // grant/assignment rows are fully PDP-active by every OTHER predicate
    // (confirmed_by set, in-window, confirmed2_by set), so the OLD query
    // would have returned this grant.
    fx.roleDeactivated = await seedRole(c, `t0658-role-deact-${uuid().slice(0, 6)}`);
    await seedInvokeGrant(c, { roleId: fx.roleDeactivated, agentRoleId: fx.agentRoleTarget });
    fx.deactivatedHolder = await seedEmployee(c, `t0658-emp-deact-${uuid().slice(0, 6)}`, {
      deactivatedAt: 500_000,
    });
    await seedAssignment(c, { empId: fx.deactivatedHolder.id, roleId: fx.roleDeactivated });

    // --- Fixture B: ACTIVE human, identical grant shape (positive control) --
    // AC-3: same grant/assignment shape, deactivated_at NULL → grant present.
    fx.roleActive = await seedRole(c, `t0658-role-active-${uuid().slice(0, 6)}`);
    await seedInvokeGrant(c, { roleId: fx.roleActive, agentRoleId: fx.agentRoleTarget });
    fx.activeHolder = await seedEmployee(c, `t0658-emp-active-${uuid().slice(0, 6)}`);
    await seedAssignment(c, { empId: fx.activeHolder.id, roleId: fx.roleActive });

    // --- Fixture C: kind='agent', identical grant shape ----------------------
    // AC-4: an agent employee (deactivated_at always NULL in practice — the
    // only writer, PATCH /api/users/:employee_id, is human-only) must resolve
    // its grants UNAFFECTED by the new predicate.
    fx.roleAgent = await seedRole(c, `t0658-role-agent-${uuid().slice(0, 6)}`);
    await seedInvokeGrant(c, { roleId: fx.roleAgent, agentRoleId: fx.agentRoleTarget });
    fx.agentHolder = await seedEmployee(c, `t0658-emp-agent-${uuid().slice(0, 6)}`, { kind: 'agent' });
    await seedAssignment(c, { empId: fx.agentHolder.id, roleId: fx.roleAgent });

    await c.query('COMMIT');
  } finally {
    await c.end();
  }
});

afterAll(async () => {
  if (_pool) await _pool.end();
});

// ---------------------------------------------------------------------------
// AC-2 — deactivated subject resolves to ZERO grants (fail-closed), even
// though the grant/assignment themselves are fully PDP-active.
// ---------------------------------------------------------------------------
describe('T-0658 AC-2 — getGrantsForSubject excludes a DEACTIVATED employee (fail-closed)', () => {
  it('deactivated employee with a valid dual-confirmed invoke-grant → []', async () => {
    const grants = await getGrantsForSubject(getPool(), TENANT, fx.deactivatedHolder.slug, NOW);
    expect(grants).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-3 — positive control: an ACTIVE employee with the identical grant shape
// still resolves normally (the fix does not break the happy path).
// ---------------------------------------------------------------------------
describe('T-0658 AC-3 — positive control: ACTIVE employee unaffected (no regression)', () => {
  it('active employee with the same grant shape → grant IS returned', async () => {
    const grants = await getGrantsForSubject(getPool(), TENANT, fx.activeHolder.slug, NOW);
    const invokeGrants = grants.filter((g) => g.operation === 'invoke');
    expect(invokeGrants).toHaveLength(1);
    const facet = invokeGrants[0]?.resourceFacet as Record<string, unknown> | undefined;
    expect(facet?.['agent_role_id']).toBe(fx.agentRoleTarget);
  });
});

// ---------------------------------------------------------------------------
// AC-4 — a kind='agent' subject is NOT affected by the deactivation gate: its
// deactivated_at is structurally always NULL (no writer sets it for agents),
// so the new predicate is a permanent no-op on that branch.
// ---------------------------------------------------------------------------
describe('T-0658 AC-4 — kind=agent subject is unaffected by the deactivation gate', () => {
  it('agent employee with the same grant shape → grant IS returned (agent resolution untouched)', async () => {
    const grants = await getGrantsForSubject(getPool(), TENANT, fx.agentHolder.slug, NOW);
    const invokeGrants = grants.filter((g) => g.operation === 'invoke');
    expect(invokeGrants).toHaveLength(1);
    const facet = invokeGrants[0]?.resourceFacet as Record<string, unknown> | undefined;
    expect(facet?.['agent_role_id']).toBe(fx.agentRoleTarget);
  });
});
