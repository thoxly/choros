// T-0658 (security/системный, столп 4) · owner/admin authority deactivation gate
// — LIVE Postgres integration probe.
//
// Run on the server CI / locally against the compose Postgres:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npm run fitness:db
//
// WHY THIS EXISTS (CHANGES_REQUESTED, adversarial skeptic REAL_HOLE, severity
// HIGH): the grant-side T-0658 fix (getGrantsForSubject step 1) does NOT cover
// the owner/admin authority path. Owner authority is resolved by a SECOND,
// PARALLEL resolver in src/db/org.ts (isGenesisOwnerForTenant / loadAdminContext),
// whose inner slug->employee subqueries had NO `deactivated_at IS NULL`
// predicate. Worse, owner authority SHORT-CIRCUITS the grant PDP:
// capability-grants-dao.ts (canConfigureLlmConnection / canActorOperateSystemAgents),
// report-page-render.ts, seed-write.ts (x11 mgmt paths), llm-config.ts,
// rights-sod-admin.ts all call isGenesisOwnerForTenant / loadAdminContext BEFORE
// (or instead of) getGrantsForSubject. Deactivation (PATCH /api/users, T-0583)
// only sets employee.deactivated_at — it does NOT revoke the tenant-owner
// role_assignment — so a DEACTIVATED owner with a still-live KC token
// (KC enabled:false blocks only NEW token issuance, not an already-issued one
// before its TTL) kept returning isGenesisOwner=true and retained full owner
// authority. This probe proves the org.ts gate now closes that path.
//
// COVERAGE:
//   AC-owner-2  — a DEACTIVATED tenant-owner -> isGenesisOwnerForTenant returns
//                 FALSE (red before the fix; the role_assignment is untouched by
//                 deactivation, so the OLD subquery still resolved the owner).
//   AC-owner-3  — positive control: an ACTIVE tenant-owner -> true (happy path).
//   AC-admin-2  — a DEACTIVATED admin (delegable mgmt_object:* grant, NOT owner)
//                 -> loadAdminContext returns isGenesisOwner=false AND
//                 adminGrants=[] (loses admin authority entirely).
//   AC-admin-3  — positive control: an ACTIVE admin -> isGenesisOwner=false but
//                 adminGrants has their delegable mgmt_object grant (unchanged).
//
// Generic by construction (D-064): no case literals beyond the structural
// 'tenant-owner' role slug (which is the schema-defined lattice-root name,
// migration 026 — not a business/case literal); every employee/dept/pos slug is
// uuid()-suffixed, mirroring grants-dao-deactivated.db.test.ts (T-0588).
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
  ownerDeactivated: EmpFx;
  ownerActive: EmpFx;
  adminDeactivated: EmpFx;
  adminActive: EmpFx;
  ownerRoleId: string;
  adminRoleId: string;
} = {
  ownerDeactivated: EMPTY_EMP,
  ownerActive: EMPTY_EMP,
  adminDeactivated: EMPTY_EMP,
  adminActive: EMPTY_EMP,
  ownerRoleId: '',
  adminRoleId: '',
};

const ORG_SCOPE = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });

async function seedEmployee(
  c: pg.Client,
  slug: string,
  opts?: { deactivatedAt?: number },
): Promise<EmpFx> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [TENANT, deptId, `t0658o-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [TENANT, posId, deptId, `t0658o-pos-${posId.slice(0, 8)}`],
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

/** Confirmed, unbounded role_assignment (routine, PDP-active by every predicate
 *  EXCEPT the deactivation gate under test). */
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
      [TENANT, `t0658o-${TENANT.slice(0, 8)}`],
    );
    await c.query('COMMIT');

    await c.query('BEGIN');

    // tenant-owner role (structural lattice-root slug, migration 026).
    fx.ownerRoleId = await seedRole(c, 'tenant-owner');
    // a non-owner admin role that holds a delegable mgmt_object grant.
    fx.adminRoleId = await seedRole(c, `t0658o-role-admin-${uuid().slice(0, 6)}`);
    await seedAdminGrant(c, fx.adminRoleId);

    // --- owner fixtures ------------------------------------------------------
    fx.ownerDeactivated = await seedEmployee(c, `t0658o-owner-deact-${uuid().slice(0, 6)}`, {
      deactivatedAt: 500_000,
    });
    await seedAssignment(c, { empId: fx.ownerDeactivated.id, roleId: fx.ownerRoleId });

    fx.ownerActive = await seedEmployee(c, `t0658o-owner-active-${uuid().slice(0, 6)}`);
    await seedAssignment(c, { empId: fx.ownerActive.id, roleId: fx.ownerRoleId });

    // --- admin fixtures ------------------------------------------------------
    fx.adminDeactivated = await seedEmployee(c, `t0658o-admin-deact-${uuid().slice(0, 6)}`, {
      deactivatedAt: 500_000,
    });
    await seedAssignment(c, { empId: fx.adminDeactivated.id, roleId: fx.adminRoleId });

    fx.adminActive = await seedEmployee(c, `t0658o-admin-active-${uuid().slice(0, 6)}`);
    await seedAssignment(c, { empId: fx.adminActive.id, roleId: fx.adminRoleId });

    await c.query('COMMIT');
  } finally {
    await c.end();
  }
});

afterAll(async () => {
  if (_pool) await _pool.end();
});

// ---------------------------------------------------------------------------
// AC-owner — isGenesisOwnerForTenant fail-closed on a deactivated owner.
// ---------------------------------------------------------------------------
describe('T-0658 AC-owner — isGenesisOwnerForTenant excludes a DEACTIVATED owner (fail-closed)', () => {
  it('deactivated tenant-owner → isGenesisOwnerForTenant returns FALSE', async () => {
    const isOwner = await isGenesisOwnerForTenant(getPool(), TENANT, fx.ownerDeactivated.slug, NOW);
    expect(isOwner).toBe(false);
  });

  it('positive control: ACTIVE tenant-owner → isGenesisOwnerForTenant returns TRUE (no regression)', async () => {
    const isOwner = await isGenesisOwnerForTenant(getPool(), TENANT, fx.ownerActive.slug, NOW);
    expect(isOwner).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-admin — loadAdminContext fail-closed on a deactivated owner/admin.
// ---------------------------------------------------------------------------
describe('T-0658 AC-admin — loadAdminContext excludes a DEACTIVATED owner/admin (fail-closed)', () => {
  it('deactivated owner → loadAdminContext isGenesisOwner=false', async () => {
    const admin = await loadAdminContext(getPool(), TENANT, fx.ownerDeactivated.slug, NOW);
    expect(admin.isGenesisOwner).toBe(false);
  });

  it('deactivated admin (delegable mgmt_object grant, not owner) → isGenesisOwner=false AND adminGrants=[]', async () => {
    const admin = await loadAdminContext(getPool(), TENANT, fx.adminDeactivated.slug, NOW);
    expect(admin.isGenesisOwner).toBe(false);
    expect(admin.adminGrants).toEqual([]);
  });

  it('positive control: ACTIVE owner → isGenesisOwner=true (no regression)', async () => {
    const admin = await loadAdminContext(getPool(), TENANT, fx.ownerActive.slug, NOW);
    expect(admin.isGenesisOwner).toBe(true);
  });

  it('positive control: ACTIVE admin → isGenesisOwner=false but retains their delegable mgmt_object grant', async () => {
    const admin = await loadAdminContext(getPool(), TENANT, fx.adminActive.slug, NOW);
    expect(admin.isGenesisOwner).toBe(false);
    expect(admin.adminGrants.length).toBeGreaterThan(0);
    expect(admin.adminGrants.every((g) => g.resourceType.startsWith('mgmt_object:'))).toBe(true);
  });
});
