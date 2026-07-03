// T-0605 · Сшивка контура прав — LIVE Postgres integration probe.
//
// Run on the server CI / locally against the compose Postgres:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npm run fitness:db
//
// WHY THIS EXISTS (live-факт приёмки, тенант Аксон, 2026-07-03): a pool task with
// a candidate group = role slug returned 403 NOT_ELIGIBLE to the tenant owner even
// after the owner self-assigned that role on the «Доступ» screen and the holder
// showed on the role card. Root cause: the PDP's assignment-activation predicate
// (grants-dao.ts) keyed on the role's ABSOLUTE criticality (holds any
// approve/transition grant) and required confirmed2_by on the assignment — which
// the write side (POST /api/role-assignments) never sets for a ROUTINE assignment
// (proposed_by NULL, one confirm). Self-lock: holder visible on the card, invisible
// to the PDP. T-0605 collapses the PDP onto the CANONICAL assignment-active
// predicate (confirmed2_by IS NOT NULL OR proposed_by IS NULL) — the same one the
// role card (rights-overview.ts) and the write side use.
//
// This probe seeds the EXACT shape of the acceptance case into a fresh tenant and
// asserts the eligibility invariant the claim handler enforces
// (inbox.ts:1353: taskRole ∈ resolveRolesForActor(actor)):
//   AC-4 positive — ROUTINE assignment (proposed_by NULL, confirmed2_by NULL) to a
//                   role holding an approve grant → getRoleSlugsForActor INCLUDES
//                   the role slug → claim would pass (taskRole ∈ myRoles).
//   AC-4 regression — a DIFFERENT employee with NO assignment → empty role set →
//                     claim would 403 NOT_ELIGIBLE (taskRole ∉ myRoles).
//   Semi-confirmed guard — an ESCALATING assignment (proposed_by set, confirmed2_by
//                   NULL) stays excluded (dual-control for escalating assigns kept).
//
// Generic by construction (D-064): NO case literals (procurement/снабженец/any
// concrete role slug) — every slug is a fresh uuid-suffixed fixture value.
//
// Seeding goes through migratorUrl() (BYPASSRLS); the DAO runs through a choros_app
// Pool (RLS-enforced), the real production read path. A fresh per-suite tenant keeps
// rows off the dev seed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, uuid } from './_helpers.js';
import { getRoleSlugsForActor } from '../../../src/db/grants-dao.js';

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
  owner: EmpFx;        // self-assigns the workflow role (routine) → eligible
  stranger: EmpFx;     // no assignment at all → NOT eligible
  escalated: EmpFx;    // semi-confirmed assignment to the same role → NOT eligible
  workflowRoleSlug: string; // the pool task's candidate group = this role slug
} = {
  owner: EMPTY_EMP,
  stranger: EMPTY_EMP,
  escalated: EMPTY_EMP,
  workflowRoleSlug: '',
};

async function seedEmployee(c: pg.Client, slug: string): Promise<EmpFx> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [TENANT, deptId, `sew-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [TENANT, posId, deptId, `sew-pos-${posId.slice(0, 8)}`],
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

/** Seed an APPROVE grant on the role (axis-a critical) — makes the role a
 *  "workflow" role, exactly the kind whose pool task a claimant must be eligible
 *  for. The prior gate treated any such role as requiring confirmed2_by on the
 *  ASSIGNMENT — the self-lock this probe pins closed. */
async function seedApproveGrant(c: pg.Client, roleId: string): Promise<void> {
  const scope = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet,
        operation, scope, "constraint", delegable, granted_by,
        valid_from, valid_until, created_at,
        proposed_by, confirmed_by, confirmed2_by)
     VALUES ($1, $2, $3, 'record', NULL,
             'approve', $4::jsonb, NULL, false, 'seed',
             NULL, NULL, 0,
             NULL, 'seed', NULL)`,
    [TENANT, uuid(), roleId, scope],
  );
}

/** Seed a role_assignment. proposed=false → ROUTINE (proposed_by NULL, active on
 *  one confirm) — the real write-side shape (grants.ts POST /api/role-assignments).
 *  proposed=true → ESCALATING/semi-confirmed (proposed_by set) → pending. */
async function seedAssignment(
  c: pg.Client,
  args: { empId: string; roleId: string; proposed: boolean },
): Promise<void> {
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope,
        valid_from, valid_until, source, granted_by,
        proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb,
             NULL, NULL, 'manual', 'seed',
             $6, 'seed', NULL, 0, 0)`,
    [
      TENANT, uuid(), args.empId, args.roleId,
      JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' }),
      args.proposed ? 'seed' : null,
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
      [TENANT, `sew-${TENANT.slice(0, 8)}`],
    );
    await c.query('COMMIT');

    await c.query('BEGIN');

    // The workflow role the pool task is addressed to (candidate group = slug).
    fx.workflowRoleSlug = `sew-role-${uuid().slice(0, 6)}`;
    const roleId = await seedRole(c, fx.workflowRoleSlug);
    await seedApproveGrant(c, roleId); // makes it an axis-a critical (workflow) role

    // Owner: ROUTINE self-assignment (proposed_by NULL) — the «Доступ» screen path.
    fx.owner = await seedEmployee(c, `sew-owner-${uuid().slice(0, 6)}`);
    await seedAssignment(c, { empId: fx.owner.id, roleId, proposed: false });

    // Stranger: NO assignment at all.
    fx.stranger = await seedEmployee(c, `sew-stranger-${uuid().slice(0, 6)}`);

    // Escalated: SEMI-CONFIRMED assignment (proposed_by set) to the same role.
    fx.escalated = await seedEmployee(c, `sew-escalated-${uuid().slice(0, 6)}`);
    await seedAssignment(c, { empId: fx.escalated.id, roleId, proposed: true });

    await c.query('COMMIT');
  } finally {
    await c.end();
  }
});

afterAll(async () => {
  if (_pool) await _pool.end();
});

// ---------------------------------------------------------------------------
// AC-4 positive — the sweep-through: assignment via «Доступ» → eligibility → claim.
// ---------------------------------------------------------------------------
describe('T-0605 AC-4 — routine role assignment yields inbox eligibility', () => {
  it('owner with a ROUTINE assignment to the workflow role → getRoleSlugsForActor INCLUDES the slug', async () => {
    const myRoles = await getRoleSlugsForActor(getPool(), TENANT, fx.owner.slug, NOW);
    // The claim gate (inbox.ts:1353) is: taskRole ∈ myRoles. taskRole is the pool
    // task's candidate group = fx.workflowRoleSlug. Post-T-0605 it IS present.
    expect(myRoles).toContain(fx.workflowRoleSlug);
  });

  it('claim eligibility invariant holds: taskRole ∈ myRoles (claim would pass, not 403)', async () => {
    const myRoles = await getRoleSlugsForActor(getPool(), TENANT, fx.owner.slug, NOW);
    const taskRole = fx.workflowRoleSlug;
    const eligible = myRoles.includes(taskRole);
    expect(eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-4 regression — a non-holder is still NOT eligible (403 NOT_ELIGIBLE).
// ---------------------------------------------------------------------------
describe('T-0605 AC-4 regression — non-holder is not eligible', () => {
  it('stranger with NO assignment → empty role set → claim would 403 NOT_ELIGIBLE', async () => {
    const myRoles = await getRoleSlugsForActor(getPool(), TENANT, fx.stranger.slug, NOW);
    expect(myRoles).toEqual([]);
    expect(myRoles.includes(fx.workflowRoleSlug)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Semi-confirmed guard — dual-control for an ESCALATING assignment is preserved.
// ---------------------------------------------------------------------------
describe('T-0605 — escalating (semi-confirmed) assignment stays excluded', () => {
  it('escalated employee (proposed_by set, confirmed2_by NULL) → role slug excluded', async () => {
    const myRoles = await getRoleSlugsForActor(getPool(), TENANT, fx.escalated.slug, NOW);
    expect(myRoles).not.toContain(fx.workflowRoleSlug);
  });
});
