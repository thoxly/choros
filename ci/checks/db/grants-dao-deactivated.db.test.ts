// T-0588 (FR-2) · grants-dao deactivation filter — LIVE Postgres integration probe.
//
// Run in the `db` CI job / locally: DATABASE_URL=... npm run fitness:db
//
// WHY THIS EXISTS (spec §1.4 / ADR §"Дыра №2"): getHoldersForRole and
// findTenantOwnerSlug JOIN choros.employee but, before this task, never filtered
// `deactivated_at IS NULL` — a deactivated (fired) employee stayed in the role
// holder pool and could still resolve as fallback-owner. This probe seeds rows
// into a fresh tenant and calls the REAL DAO functions against a REAL Postgres,
// proving the additive `AND e.deactivated_at IS NULL` predicate actually holds.
//
// COVERAGE (AC-3/AC-4 + positive controls, regression-safe):
//   AC-3  — getHoldersForRole excludes a deactivated SOLE holder (returns []).
//   AC-3+ — positive control: an ACTIVE holder is still returned (no regression).
//   AC-4  — findTenantOwnerSlug returns null for a deactivated SOLE tenant-owner.
//   AC-4+ — positive control: an ACTIVE tenant-owner is still resolved.
//   mixed — a role with ONE active + ONE deactivated holder returns ONLY the
//           active holder's slug (deactivation is per-employee, not per-role).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, uuid } from './_helpers.js';
import { getHoldersForRole, findTenantOwnerSlug } from '../../../src/db/grants-dao.js';

const NOW = 1_000_000; // fixed instant for deterministic window math

let _pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: appUrl() });
  return _pool;
}

const TENANT = uuid();

type EmpFx = { id: string; slug: string };
const EMPTY_EMP: EmpFx = { id: '', slug: '' };

const fx: {
  soleHolderDeactivated: EmpFx;
  soleHolderActive: EmpFx;
  soleOwnerDeactivated: EmpFx;
  soleOwnerActive: EmpFx;
  mixedActive: EmpFx;
  mixedDeactivated: EmpFx;
  roleSoleDeactivated: string;
  roleSoleActive: string;
  roleMixed: string;
} = {
  soleHolderDeactivated: EMPTY_EMP,
  soleHolderActive: EMPTY_EMP,
  soleOwnerDeactivated: EMPTY_EMP,
  soleOwnerActive: EMPTY_EMP,
  mixedActive: EMPTY_EMP,
  mixedDeactivated: EMPTY_EMP,
  roleSoleDeactivated: '',
  roleSoleActive: '',
  roleMixed: '',
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
    [TENANT, deptId, `t0588-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [TENANT, posId, deptId, `t0588-pos-${posId.slice(0, 8)}`],
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

async function seedAssignment(
  c: pg.Client,
  args: { empId: string; roleId: string },
): Promise<void> {
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope,
        valid_from, valid_until, source, granted_by,
        proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb,
             NULL, NULL, 'seed', 'seed',
             NULL, 'seed', NULL, 0, 0)`,
    [
      TENANT, uuid(), args.empId, args.roleId,
      JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' }),
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
      [TENANT, `t0588-gd-${TENANT.slice(0, 8)}`],
    );
    await c.query('COMMIT');

    await c.query('BEGIN');

    // AC-3: sole holder of a role, DEACTIVATED → getHoldersForRole returns [].
    fx.roleSoleDeactivated = `t0588-role-solededeact-${uuid().slice(0, 6)}`;
    const rSoleDeact = await seedRole(c, fx.roleSoleDeactivated);
    fx.soleHolderDeactivated = await seedEmployee(c, `t0588-holder-deact-${uuid().slice(0, 6)}`, {
      deactivatedAt: 500_000,
    });
    await seedAssignment(c, { empId: fx.soleHolderDeactivated.id, roleId: rSoleDeact });

    // Positive control: sole holder ACTIVE (deactivated_at NULL) → still returned.
    fx.roleSoleActive = `t0588-role-soleactive-${uuid().slice(0, 6)}`;
    const rSoleActive = await seedRole(c, fx.roleSoleActive);
    fx.soleHolderActive = await seedEmployee(c, `t0588-holder-active-${uuid().slice(0, 6)}`);
    await seedAssignment(c, { empId: fx.soleHolderActive.id, roleId: rSoleActive });

    // AC-4: sole tenant-owner, DEACTIVATED → findTenantOwnerSlug returns null.
    const rOwnerRole1 = await seedRole(c, 'tenant-owner');
    fx.soleOwnerDeactivated = await seedEmployee(c, `t0588-owner-deact-${uuid().slice(0, 6)}`, {
      deactivatedAt: 500_000,
    });
    await seedAssignment(c, { empId: fx.soleOwnerDeactivated.id, roleId: rOwnerRole1 });

    // mixed: one role with ONE active + ONE deactivated holder → only active slug returned.
    fx.roleMixed = `t0588-role-mixed-${uuid().slice(0, 6)}`;
    const rMixed = await seedRole(c, fx.roleMixed);
    fx.mixedActive = await seedEmployee(c, `t0588-mixed-active-${uuid().slice(0, 6)}`);
    fx.mixedDeactivated = await seedEmployee(c, `t0588-mixed-deact-${uuid().slice(0, 6)}`, {
      deactivatedAt: 500_000,
    });
    await seedAssignment(c, { empId: fx.mixedActive.id, roleId: rMixed });
    await seedAssignment(c, { empId: fx.mixedDeactivated.id, roleId: rMixed });

    await c.query('COMMIT');
  } finally {
    await c.end();
  }
});

afterAll(async () => {
  if (_pool) await _pool.end();
});

// ---------------------------------------------------------------------------
// AC-3 — getHoldersForRole excludes a deactivated sole holder
// ---------------------------------------------------------------------------
describe('T-0588 AC-3 — getHoldersForRole excludes deactivated employees', () => {
  it('sole holder DEACTIVATED → returns empty list (not included)', async () => {
    const holders = await getHoldersForRole(getPool(), TENANT, fx.roleSoleDeactivated, NOW);
    expect(holders).toEqual([]);
  });

  it('positive control: sole holder ACTIVE → still returned (no regression)', async () => {
    const holders = await getHoldersForRole(getPool(), TENANT, fx.roleSoleActive, NOW);
    expect(holders).toEqual([fx.soleHolderActive.slug]);
  });

  it('mixed pool: role with one active + one deactivated holder → only active slug returned', async () => {
    const holders = await getHoldersForRole(getPool(), TENANT, fx.roleMixed, NOW);
    expect(holders).toEqual([fx.mixedActive.slug]);
    expect(holders).not.toContain(fx.mixedDeactivated.slug);
  });
});

// ---------------------------------------------------------------------------
// AC-4 — findTenantOwnerSlug returns null for a deactivated owner
// ---------------------------------------------------------------------------
describe('T-0588 AC-4 — findTenantOwnerSlug excludes a deactivated tenant-owner', () => {
  it('sole tenant-owner DEACTIVATED → returns null (no fallback to disabled account)', async () => {
    const owner = await findTenantOwnerSlug(getPool(), TENANT, NOW);
    expect(owner).toBeNull();
  });
});

describe('T-0588 AC-4+ — findTenantOwnerSlug positive control (separate tenant)', () => {
  const OWNER_TENANT = uuid();
  let ownerSlug = '';

  beforeAll(async () => {
    const c = new pg.Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
         VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
        [OWNER_TENANT, `t0588-gd-owner-${OWNER_TENANT.slice(0, 8)}`],
      );
      await c.query('COMMIT');

      await c.query('BEGIN');
      // seedEmployee/seedRole/seedAssignment close over TENANT — inline a local
      // owner seed against OWNER_TENANT instead.
      const deptId = uuid();
      await c.query(
        `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
        [OWNER_TENANT, deptId, `t0588-dept-${deptId.slice(0, 8)}`],
      );
      const posId = uuid();
      await c.query(
        `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4, 0, 0)`,
        [OWNER_TENANT, posId, deptId, `t0588-pos-${posId.slice(0, 8)}`],
      );
      const empId = uuid();
      ownerSlug = `t0588-owner-active-${uuid().slice(0, 6)}`;
      await c.query(
        `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, $3, 'human', $4, $4, 0, 0)`,
        [OWNER_TENANT, empId, posId, ownerSlug],
      );
      const roleId = uuid();
      await c.query(
        `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
         VALUES ($1, $2, 'tenant-owner', 'tenant-owner', NULL, 0, 0)`,
        [OWNER_TENANT, roleId],
      );
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope,
            valid_from, valid_until, source, granted_by,
            proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb,
                 NULL, NULL, 'seed', 'seed',
                 NULL, 'seed', NULL, 0, 0)`,
        [
          OWNER_TENANT, uuid(), empId, roleId,
          JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' }),
        ],
      );
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
  });

  it('ACTIVE tenant-owner → still resolved (no regression)', async () => {
    const owner = await findTenantOwnerSlug(getPool(), OWNER_TENANT, NOW);
    expect(owner).toBe(ownerSlug);
  });
});
