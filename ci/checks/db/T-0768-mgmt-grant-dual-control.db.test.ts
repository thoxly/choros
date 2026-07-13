// T-0768 (security/dual-control P1, LIVE — finding from T-0767's review) ·
// loadAdminContext step 3 (mgmt_object:* grant load) enforces the T-0397
// grant-ROW dual-control predicate — LIVE Postgres integration probe.
//
// Run on the server CI / locally against the compose Postgres:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npm run fitness:db
//
// WHY THIS EXISTS: T-0767 closed the T-0605 role_assignment-ROW dual-control
// axis in org.ts (steps 1/2). Its review found a SIBLING, LIVE (not dormant)
// hole one layer down: loadAdminContext step 3 — the query that loads delegable
// `mgmt_object:*` grants for each confirmed assignment's role — carried NO
// `confirmed_by`/`confirmed2_by` predicate on the grant ROW at all. This is a
// DIFFERENT axis than T-0605/T-0767 (grant-row activation, T-0397 — the SAME
// axis getGrantsForSubject step 3 in grants-dao.ts already enforces correctly):
//   confirmed_by IS NOT NULL
//   AND (NOT <criticalGrantPredicate> OR confirmed2_by IS NOT NULL)
// Without it, a CRITICAL mgmt_object grant (criticalGrantPredicate axis a —
// e.g. `mgmt_object:tier_promote` / `transition`, the artifacts.ts tier-promote
// gate's own predicate) proposed via POST /api/grants and landed SEMI-CONFIRMED
// by the write side (grants.ts escalating branch: confirmed_by = first
// approver, confirmed2_by = NULL) still reached adminGrants — a LIVE
// single-confirmation dual-control bypass reachable via the real propose route
// (not a dormant/unwritten shape like T-0767's proposed_by axis).
//
// STATUS: proves THREE things:
//   (1) RED→GREEN: a semi-confirmed CRITICAL mgmt_object grant (confirmed_by
//       set, confirmed2_by NULL, criticalGrantPredicate TRUE) is excluded from
//       loadAdminContext's adminGrants (AC-1). Reverting the fix (dropping the
//       confirmed_by/criticalGrantPredicate clause from org.ts step 3) turns
//       this RED.
//   (2) NO-OP / regression control: a non-critical confirmed mgmt_object grant
//       (AC-2, mirrors T-0658/T-0767's fixture shape) and a fully dual-
//       confirmed CRITICAL grant (AC-3) both remain visible, unchanged.
//   (3) UNITY OF AUTHORITY: for the SAME role, the set of mgmt_object grants
//       loadAdminContext.adminGrants returns is IDENTICAL (by id) to the
//       mgmt_object-shaped subset getGrantsForSubject returns for the same
//       actor/role (AC-4) — one source of truth, not two diverging
//       re-implementations of "grant is PDP-active".
//   (4) Defence-in-depth: a NEVER-confirmed grant (confirmed_by IS NULL, the
//       migration-020/030/031 "proposed" contract state) is excluded even when
//       non-critical (AC-5) — the fix closes BOTH the missing confirmed_by AND
//       the missing criticalGrantPredicate/confirmed2_by clause, not just one.
//
// Generic by construction (D-064): no case literals beyond the schema-defined
// 'mgmt_object:tier_promote' / 'transition' criticality axis (the SAME literal
// artifacts.ts's real consumer gates on) and 'tenant-owner' is not used here.
// Every employee/dept/pos/role slug is uuid()-suffixed. Mirrors
// T-0767-owner-admin-assignment-dual-control.db.test.ts's fixture shape.
//
// Seeding goes through migratorUrl() (BYPASSRLS); loadAdminContext/
// getGrantsForSubject run through a choros_app Pool (RLS-enforced) — the real
// production read path. A fresh per-suite tenant keeps rows off the dev seed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, uuid } from './_helpers.js';
import { loadAdminContext } from '../../../src/db/org.js';
import { getGrantsForSubject } from '../../../src/db/grants-dao.js';

const NOW = 3_000_000; // fixed instant for deterministic window math

let _pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: appUrl() });
  return _pool;
}

const TENANT = uuid();

const ORG_SCOPE = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });

type EmpFx = { id: string; slug: string };

const fx: {
  admin: EmpFx;
  adminRoleId: string;
  nonCriticalGrantId: string;
  semiConfirmedCriticalGrantId: string;
  dualConfirmedCriticalGrantId: string;
  neverConfirmedGrantId: string;
} = {
  admin: { id: '', slug: '' },
  adminRoleId: '',
  nonCriticalGrantId: '',
  semiConfirmedCriticalGrantId: '',
  dualConfirmedCriticalGrantId: '',
  neverConfirmedGrantId: '',
};

async function seedEmployee(c: pg.Client, slug: string): Promise<EmpFx> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [TENANT, deptId, `t0768-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [TENANT, posId, deptId, `t0768-pos-${posId.slice(0, 8)}`],
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

/** Fully-confirmed role_assignment (T-0605 routine shape — proposed_by NULL,
 *  the ONLY axis T-0767 exercises; held constant here since T-0768 is testing
 *  the GRANT-row axis, one layer below). */
async function seedAssignment(c: pg.Client, empId: string, roleId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope,
        valid_from, valid_until, source, granted_by,
        proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb,
             NULL, NULL, 'seed', 'seed',
             NULL, 'seed', NULL, 0, 0)`,
    [TENANT, uuid(), empId, roleId, ORG_SCOPE],
  );
}

/** A delegable mgmt_object:* grant on a role, with an explicit T-0397
 *  confirmed_by/confirmed2_by shape — the axis under test. */
async function seedGrant(
  c: pg.Client,
  args: {
    roleId: string;
    resourceType: string;
    operation: string;
    confirmedBy: string | null;
    confirmed2By: string | null;
  },
): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet,
        operation, scope, "constraint", delegable, granted_by,
        valid_from, valid_until, created_at,
        proposed_by, confirmed_by, confirmed2_by)
     VALUES ($1, $2, $3, $4, NULL,
             $5, $6::jsonb, NULL, true, 'seed',
             NULL, NULL, 0,
             $7, $8, $9)`,
    [
      TENANT, id, args.roleId, args.resourceType,
      args.operation, ORG_SCOPE,
      args.confirmedBy, // proposed_by mirrors confirmedBy's presence (irrelevant to the axis under test)
      args.confirmedBy,
      args.confirmed2By,
    ],
  );
  return id;
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
      [TENANT, `t0768-${TENANT.slice(0, 8)}`],
    );
    await c.query('COMMIT');

    await c.query('BEGIN');

    fx.adminRoleId = await seedRole(c, `t0768-role-admin-${uuid().slice(0, 6)}`);
    fx.admin = await seedEmployee(c, `t0768-admin-${uuid().slice(0, 6)}`);
    await seedAssignment(c, fx.admin.id, fx.adminRoleId);

    // (a) non-critical mgmt_object grant, confirmed_by set, confirmed2_by NULL
    //     — criticalGrantPredicate('g') is FALSE for 'update' (not axis a/b/c/Q-2)
    //     — MUST remain visible (regression control, T-0658/T-0767 fixture shape).
    fx.nonCriticalGrantId = await seedGrant(c, {
      roleId: fx.adminRoleId,
      resourceType: 'mgmt_object:employee',
      operation: 'update',
      confirmedBy: 'seed',
      confirmed2By: null,
    });

    // (b) CRITICAL mgmt_object grant (axis a: operation='transition' — the
    //     SAME literal artifacts.ts's tier-promote gate checks), semi-confirmed
    //     (confirmed_by set, confirmed2_by NULL) — the grants.ts escalating-path
    //     INSERT shape. MUST NOT be visible after the fix (AC-1, RED before).
    fx.semiConfirmedCriticalGrantId = await seedGrant(c, {
      roleId: fx.adminRoleId,
      resourceType: 'mgmt_object:tier_promote',
      operation: 'transition',
      confirmedBy: 'seed-approver-1',
      confirmed2By: null,
    });

    // (c) SAME critical shape, but fully dual-confirmed (confirmed2_by set) —
    //     MUST remain visible (regression control — dual-control's happy path).
    fx.dualConfirmedCriticalGrantId = await seedGrant(c, {
      roleId: fx.adminRoleId,
      resourceType: 'mgmt_object:tier_promote',
      operation: 'transition',
      confirmedBy: 'seed-approver-1',
      confirmed2By: 'seed-approver-2',
    });

    // (d) NON-critical mgmt_object grant that was NEVER confirmed at all
    //     (confirmed_by IS NULL — migration 020/030/031 "proposed" contract
    //     state). MUST NOT be visible (defence-in-depth: the fix closes the
    //     missing confirmed_by clause too, not only the criticality clause).
    fx.neverConfirmedGrantId = await seedGrant(c, {
      roleId: fx.adminRoleId,
      resourceType: 'mgmt_object:employee',
      operation: 'update',
      confirmedBy: null,
      confirmed2By: null,
    });

    await c.query('COMMIT');
  } finally {
    await c.end();
  }
});

afterAll(async () => {
  if (_pool) await _pool.end();
});

describe('T-0768 — loadAdminContext step 3 enforces the T-0397 grant-row dual-control predicate', () => {
  it('AC-1 (RED before fix / GREEN after): semi-confirmed CRITICAL mgmt_object:tier_promote/transition grant is EXCLUDED from adminGrants', async () => {
    const admin = await loadAdminContext(getPool(), TENANT, fx.admin.slug, NOW);
    const ids = admin.adminGrants.map((g) => g.id);
    expect(ids).not.toContain(fx.semiConfirmedCriticalGrantId);
  });

  it('AC-2 (no-op / regression control): non-critical confirmed mgmt_object grant remains visible unchanged', async () => {
    const admin = await loadAdminContext(getPool(), TENANT, fx.admin.slug, NOW);
    const ids = admin.adminGrants.map((g) => g.id);
    expect(ids).toContain(fx.nonCriticalGrantId);
  });

  it('AC-3 (regression control): fully dual-confirmed CRITICAL mgmt_object:tier_promote/transition grant remains visible', async () => {
    const admin = await loadAdminContext(getPool(), TENANT, fx.admin.slug, NOW);
    const ids = admin.adminGrants.map((g) => g.id);
    expect(ids).toContain(fx.dualConfirmedCriticalGrantId);
  });

  it('AC-4 (unity of authority): loadAdminContext.adminGrants and getGrantsForSubject resolve the SAME grant-id set for this role (mgmt_object-shaped subset) — one source of truth, not a diverging bespoke re-implementation', async () => {
    const admin = await loadAdminContext(getPool(), TENANT, fx.admin.slug, NOW);
    const adminIds = admin.adminGrants.map((g) => g.id).sort();

    const subjectGrants = await getGrantsForSubject(getPool(), TENANT, fx.admin.slug, NOW);
    const subjectIds = subjectGrants
      .filter((g) => g.resourceType.startsWith('mgmt_object:') && g.delegable)
      .map((g) => g.id)
      .sort();

    expect(adminIds).toEqual(subjectIds);
    // Pin the expected membership explicitly too, so a future accidental
    // widening of BOTH predicates in lockstep still fails this probe.
    expect(adminIds).toEqual([fx.dualConfirmedCriticalGrantId, fx.nonCriticalGrantId].sort());
  });

  it('AC-5 (defence-in-depth): a NEVER-confirmed (confirmed_by IS NULL) non-critical mgmt_object grant is EXCLUDED', async () => {
    const admin = await loadAdminContext(getPool(), TENANT, fx.admin.slug, NOW);
    const ids = admin.adminGrants.map((g) => g.id);
    expect(ids).not.toContain(fx.neverConfirmedGrantId);
  });
});
