// T-0767 (security/dual-control, столп 4) · owner/admin authority resolvers
// enforce the T-0605 assignment-active dual-control disjunct — LIVE Postgres
// integration probe.
//
// Run on the server CI / locally against the compose Postgres:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npm run fitness:db
//
// WHY THIS EXISTS (finding from T-0764's review, D-064): isGenesisOwnerForTenant
// and loadAdminContext (src/db/org.ts) resolve role_assignment activity on
// `confirmed_by IS NOT NULL` ALONE — unlike EVERY other assignment-activity
// reader (getRoleSlugsForActor / getGrantsForSubject, src/db/grants-dao.ts),
// which additionally requires the T-0605 canonical disjunct
// `(confirmed2_by IS NOT NULL OR proposed_by IS NULL)`. Without it, a
// role_assignment that was PROPOSED (proposed_by set) but never received its
// SECOND distinct confirmation (confirmed2_by still NULL) — a semi-confirmed,
// NOT-yet-active assignment by the T-0605 contract — would still grant full
// tenant-owner / admin authority through org.ts's resolvers, because they never
// looked at proposed_by/confirmed2_by at all.
//
// STATUS: real but DORMANT today. T-0764's audit of all 58 seed files found
// role_assignment.proposed_by is NULL on every live INSERT in src/ — no current
// write path proposes an assignment-level escalation. This probe proves BOTH
// halves of the T-0767 fix:
//   (1) RED→GREEN: a role_assignment with proposed_by SET and confirmed2_by
//       NULL — semi-confirmed by T-0605 — no longer grants owner/admin
//       authority (AC-owner-1 / AC-admin-1 below). Reverting the fix (removing
//       assignmentActiveDualControlPredicate("ra") from org.ts) turns these RED.
//   (2) NO-OP proof: every CURRENT production shape — proposed_by NULL
//       (routine, one confirm) AND the fully-dual-confirmed shape (proposed_by
//       set + confirmed2_by set) — resolves EXACTLY as before the fix
//       (AC-owner-2/3, AC-admin-2/3 below). This is the regression control: the
//       fix must not narrow the ACTIVE genesis-owner's existing authority.
//
// Generic by construction (D-064): no case literals beyond the schema-defined
// 'tenant-owner' lattice-root role slug (migration 026); every employee/dept/
// pos/role slug is uuid()-suffixed. Mirrors org-admin-deactivation.db.test.ts
// (T-0658) and grants-dao.test.ts's T-0605 fixture shape.
//
// Seeding goes through migratorUrl() (BYPASSRLS); the org.ts resolvers run
// through a choros_app Pool (RLS-enforced) — the real production read path. A
// fresh per-suite tenant keeps rows off the dev seed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, uuid } from './_helpers.js';
import { isGenesisOwnerForTenant, loadAdminContext } from '../../../src/db/org.js';

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
  ownerRoutine: EmpFx;
  ownerSemiConfirmed: EmpFx;
  ownerDualConfirmed: EmpFx;
  adminRoutine: EmpFx;
  adminSemiConfirmed: EmpFx;
  adminDualConfirmed: EmpFx;
  ownerRoleId: string;
  adminRoleId: string;
} = {
  ownerRoutine: EMPTY_EMP,
  ownerSemiConfirmed: EMPTY_EMP,
  ownerDualConfirmed: EMPTY_EMP,
  adminRoutine: EMPTY_EMP,
  adminSemiConfirmed: EMPTY_EMP,
  adminDualConfirmed: EMPTY_EMP,
  ownerRoleId: '',
  adminRoleId: '',
};

const ORG_SCOPE = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });

async function seedEmployee(c: pg.Client, slug: string): Promise<EmpFx> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [TENANT, deptId, `t0767-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [TENANT, posId, deptId, `t0767-pos-${posId.slice(0, 8)}`],
  );
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at, deactivated_at)
     VALUES ($1, $2, $3, 'human', $4, $4, 0, 0, NULL)`,
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

/** role_assignment with an explicit T-0605 proposed_by/confirmed_by/confirmed2_by
 *  shape — the axis under test. Always confirmed_by set + unbounded window, so
 *  the ONLY variable across fixtures is the T-0605 disjunct. */
async function seedAssignment(
  c: pg.Client,
  args: { empId: string; roleId: string; proposedBy: string | null; confirmed2By: string | null },
): Promise<void> {
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope,
        valid_from, valid_until, source, granted_by,
        proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb,
             NULL, NULL, 'seed', 'seed',
             $6, 'seed', $7, 0, 0)`,
    [TENANT, uuid(), args.empId, args.roleId, ORG_SCOPE, args.proposedBy, args.confirmed2By],
  );
}

/** A delegable mgmt_object:* grant on a role — what loadAdminContext step 3
 *  collects into adminGrants (confirmed, in-window, delegable, resource_type
 *  starting with mgmt_object:). */
async function seedAdminGrant(c: pg.Client, roleId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet,
        operation, scope, "constraint", delegable, granted_by,
        valid_from, valid_until, created_at,
        proposed_by, confirmed_by, confirmed2_by)
     VALUES ($1, $2, $3, 'mgmt_object:employee', NULL,
             'update', $4::jsonb, NULL, true, 'seed',
             NULL, NULL, 0,
             NULL, 'seed', NULL)`,
    [TENANT, uuid(), roleId, ORG_SCOPE],
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
      [TENANT, `t0767-${TENANT.slice(0, 8)}`],
    );
    await c.query('COMMIT');

    await c.query('BEGIN');

    // tenant-owner role (structural lattice-root slug, migration 026).
    fx.ownerRoleId = await seedRole(c, 'tenant-owner');
    // a non-owner admin role that holds a delegable mgmt_object grant.
    fx.adminRoleId = await seedRole(c, `t0767-role-admin-${uuid().slice(0, 6)}`);
    await seedAdminGrant(c, fx.adminRoleId);

    // --- owner fixtures: the T-0605 axis, everything else held constant ------
    // routine (proposed_by NULL) — the shape EVERY live assignment has today.
    fx.ownerRoutine = await seedEmployee(c, `t0767-owner-routine-${uuid().slice(0, 6)}`);
    await seedAssignment(c, {
      empId: fx.ownerRoutine.id,
      roleId: fx.ownerRoleId,
      proposedBy: null,
      confirmed2By: null,
    });

    // semi-confirmed (proposed_by SET, confirmed2_by NULL) — pending a distinct
    // second approver by the T-0605 contract; MUST NOT grant owner authority.
    fx.ownerSemiConfirmed = await seedEmployee(c, `t0767-owner-semi-${uuid().slice(0, 6)}`);
    await seedAssignment(c, {
      empId: fx.ownerSemiConfirmed.id,
      roleId: fx.ownerRoleId,
      proposedBy: 'seed-proposer',
      confirmed2By: null,
    });

    // fully dual-confirmed (proposed_by SET, confirmed2_by SET) — the escalating
    // path's happy ending; must grant owner authority same as routine.
    fx.ownerDualConfirmed = await seedEmployee(c, `t0767-owner-dual-${uuid().slice(0, 6)}`);
    await seedAssignment(c, {
      empId: fx.ownerDualConfirmed.id,
      roleId: fx.ownerRoleId,
      proposedBy: 'seed-proposer',
      confirmed2By: 'seed-second-approver',
    });

    // --- admin fixtures: same three shapes, on the admin (mgmt_object) role --
    fx.adminRoutine = await seedEmployee(c, `t0767-admin-routine-${uuid().slice(0, 6)}`);
    await seedAssignment(c, {
      empId: fx.adminRoutine.id,
      roleId: fx.adminRoleId,
      proposedBy: null,
      confirmed2By: null,
    });

    fx.adminSemiConfirmed = await seedEmployee(c, `t0767-admin-semi-${uuid().slice(0, 6)}`);
    await seedAssignment(c, {
      empId: fx.adminSemiConfirmed.id,
      roleId: fx.adminRoleId,
      proposedBy: 'seed-proposer',
      confirmed2By: null,
    });

    fx.adminDualConfirmed = await seedEmployee(c, `t0767-admin-dual-${uuid().slice(0, 6)}`);
    await seedAssignment(c, {
      empId: fx.adminDualConfirmed.id,
      roleId: fx.adminRoleId,
      proposedBy: 'seed-proposer',
      confirmed2By: 'seed-second-approver',
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
// AC-owner — isGenesisOwnerForTenant enforces the T-0605 disjunct.
// ---------------------------------------------------------------------------
describe('T-0767 AC-owner — isGenesisOwnerForTenant enforces the T-0605 assignment-active disjunct', () => {
  it('AC-owner-1 (RED before fix / GREEN after): semi-confirmed assignment (proposed_by set, confirmed2_by NULL) → isGenesisOwnerForTenant returns FALSE', async () => {
    const isOwner = await isGenesisOwnerForTenant(getPool(), TENANT, fx.ownerSemiConfirmed.slug, NOW);
    expect(isOwner).toBe(false);
  });

  it('AC-owner-2 (no-op / regression control): routine assignment (proposed_by NULL, today\'s ONLY live shape) → isGenesisOwnerForTenant returns TRUE unchanged', async () => {
    const isOwner = await isGenesisOwnerForTenant(getPool(), TENANT, fx.ownerRoutine.slug, NOW);
    expect(isOwner).toBe(true);
  });

  it('AC-owner-3 (regression control): fully dual-confirmed assignment (proposed_by set, confirmed2_by set) → isGenesisOwnerForTenant returns TRUE', async () => {
    const isOwner = await isGenesisOwnerForTenant(getPool(), TENANT, fx.ownerDualConfirmed.slug, NOW);
    expect(isOwner).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-admin — loadAdminContext enforces the T-0605 disjunct (both the inlined
// owner-check in step 1 AND the assignment-load in step 2).
// ---------------------------------------------------------------------------
describe('T-0767 AC-admin — loadAdminContext enforces the T-0605 assignment-active disjunct', () => {
  it('AC-admin-1a (RED before fix / GREEN after, step 1): semi-confirmed OWNER assignment → loadAdminContext.isGenesisOwner is FALSE', async () => {
    const admin = await loadAdminContext(getPool(), TENANT, fx.ownerSemiConfirmed.slug, NOW);
    expect(admin.isGenesisOwner).toBe(false);
  });

  it('AC-admin-1b (RED before fix / GREEN after, step 2): semi-confirmed ADMIN assignment → loadAdminContext.adminGrants is EMPTY (the assignment never resolves to a role, so its delegable mgmt_object grant is unreachable)', async () => {
    const admin = await loadAdminContext(getPool(), TENANT, fx.adminSemiConfirmed.slug, NOW);
    expect(admin.isGenesisOwner).toBe(false);
    expect(admin.adminGrants).toEqual([]);
  });

  it('AC-admin-2 (no-op / regression control): routine OWNER assignment → isGenesisOwner=true unchanged', async () => {
    const admin = await loadAdminContext(getPool(), TENANT, fx.ownerRoutine.slug, NOW);
    expect(admin.isGenesisOwner).toBe(true);
  });

  it('AC-admin-3 (no-op / regression control): routine ADMIN assignment → retains its delegable mgmt_object grant unchanged', async () => {
    const admin = await loadAdminContext(getPool(), TENANT, fx.adminRoutine.slug, NOW);
    expect(admin.isGenesisOwner).toBe(false);
    expect(admin.adminGrants.length).toBeGreaterThan(0);
    expect(admin.adminGrants.every((g) => g.resourceType.startsWith('mgmt_object:'))).toBe(true);
  });

  it('AC-admin-4 (regression control): fully dual-confirmed ADMIN assignment → retains its delegable mgmt_object grant', async () => {
    const admin = await loadAdminContext(getPool(), TENANT, fx.adminDualConfirmed.slug, NOW);
    expect(admin.isGenesisOwner).toBe(false);
    expect(admin.adminGrants.length).toBeGreaterThan(0);
  });
});
