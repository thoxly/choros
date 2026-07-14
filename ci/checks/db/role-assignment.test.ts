// T-0022 · role + role_assignment DB-level acceptance criteria.
//
// Live Postgres probes for the AC that need real DDL/constraint behaviour.
// Run in the `db` CI job / locally: DATABASE_URL=... npm run fitness:db
//
// Covers (executable templates from ADR §6 "Live verification"):
//   AC-6  — role slug uniqueness per tenant (23505); same slug other tenant OK
//   AC-7  — role_assignment FK employee tenant-scoped (absent / cross-tenant → 23503)
//   AC-8  — role_assignment FK role tenant-scoped (absent / cross-tenant → 23503)
//   AC-9  — org_scope jsonb NOT NULL (23502); node+set jsonb round-trip
//   AC-10 — validity window bigint NULL × 4 null-combos; no CHECK on from>until
//   AC-11 — proposed_by/confirmed_by text NULL (proposal insertable)
//   AC-12 — source/granted_by text NOT NULL (NULL → 23502); arbitrary string OK
//   AC-13 — grant.role_id real FK after 021 (bad role_id → 23503)
//   AC-14 — grant.role_id FK tenant-scoped (cross-tenant role ref → 23503)
//   AC-15 — dev role seed present (tenant-owner + functional) + idempotent
//   AC-16 — dev assignment seed wires real employee→role→dept node + idempotent
//
// Seeding goes through migratorUrl() (bypasses RLS). Test tenants TENANT_A/_B are
// distinct from the dev-seed tenant (a0…0001), so test rows never collide with seeds.

import { describe, it, expect, beforeAll } from 'vitest';
import { migratorUrl, withClient, TENANT_A, TENANT_B, uuid } from './_helpers.js';

// Dev-seed UUID constants (match migrations 014/016/019/020).
const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
const DEV_DEPT_FIN = 'b0000000-0000-0000-0000-000000000001';
const DEV_EMP_MIRONOV = 'd0000000-0000-0000-0000-000000000004';
const DEV_ROLE_OWNER = 'e0000000-0000-0000-0000-000000000001';
const DEV_ROLE_BUDGET_APPROVER = 'e0000000-0000-0000-0000-000000000002';
const DEV_RA_MIRONOV = 'f0000000-0000-0000-0000-000000000001';

async function ensureTenant(c: import('pg').Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, `test-tenant-${tenantId.slice(0, 8)}`],
  );
}

/** Insert a role for a tenant; returns its id. */
async function insertRole(c: import('pg').Client, tenantId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.role
       (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 0, 0)`,
    [tenantId, id, slug],
  );
  return id;
}

/** Minimal org chain (dept → position → employee) for a test tenant; returns ids. */
async function insertOrgChain(
  c: import('pg').Client,
  tenantId: string,
): Promise<{ deptId: string; empId: string }> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [tenantId, deptId, `ra-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [tenantId, posId, deptId, `ra-pos-${posId.slice(0, 8)}`],
  );
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, 'human', $4, $4, 0, 0)`,
    [tenantId, empId, posId, `ra-emp-${empId.slice(0, 8)}`],
  );
  return { deptId, empId };
}

function orgNode(nodeId: string): string {
  return JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId, nodeLevel: 'department' });
}

// Per-test-tenant fixtures.
const fx = {
  a: { deptId: '', empId: '', roleId: '' },
  b: { deptId: '', empId: '', roleId: '' },
};

beforeAll(async () => {
  await withClient(migratorUrl(), async (c) => {
    for (const t of [TENANT_A, TENANT_B]) {
      await c.query('BEGIN');
      await ensureTenant(c, t);
      await c.query('COMMIT');
    }
    await c.query('BEGIN');
    const aChain = await insertOrgChain(c, TENANT_A);
    fx.a.deptId = aChain.deptId;
    fx.a.empId = aChain.empId;
    fx.a.roleId = await insertRole(c, TENANT_A, `ra-fx-role-${uuid().slice(0, 8)}`);
    await c.query('COMMIT');

    await c.query('BEGIN');
    const bChain = await insertOrgChain(c, TENANT_B);
    fx.b.deptId = bChain.deptId;
    fx.b.empId = bChain.empId;
    fx.b.roleId = await insertRole(c, TENANT_B, `ra-fx-role-${uuid().slice(0, 8)}`);
    await c.query('COMMIT');
  });
});

// ---------------------------------------------------------------------------
// AC-6 — role slug uniqueness per tenant
// ---------------------------------------------------------------------------
describe('AC-6 · FF-5: role slug unique per tenant', () => {
  it('duplicate (tenant_id, slug) → 23505; same slug in another tenant OK', async () => {
    const slug = `ra-dup-${uuid().slice(0, 8)}`;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await insertRole(c, TENANT_A, slug);
      await c.query('COMMIT');

      // Same (tenant_id, slug) → unique violation.
      await c.query('BEGIN');
      await expect(insertRole(c, TENANT_A, slug)).rejects.toMatchObject({ code: '23505' });
      await c.query('ROLLBACK');

      // Same slug in a DIFFERENT tenant is allowed.
      await c.query('BEGIN');
      const otherId = await insertRole(c, TENANT_B, slug);
      await c.query('COMMIT');
      expect(otherId).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// AC-7 — role_assignment FK employee tenant-scoped
// ---------------------------------------------------------------------------
describe('AC-7 · FF-6: role_assignment FK employee tenant-scoped', () => {
  it('absent employee_id → 23503', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO choros.role_assignment
             (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
              source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, 'manual', 'tester', NULL, 'tester', 0, 0)`,
          [TENANT_A, uuid(), uuid() /* absent employee */, fx.a.roleId, orgNode(fx.a.deptId)],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await c.query('ROLLBACK');
    });
  });

  it('cross-tenant employee reference (tenant-A row, tenant-B employee) → 23503', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO choros.role_assignment
             (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
              source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, 'manual', 'tester', NULL, 'tester', 0, 0)`,
          [TENANT_A, uuid(), fx.b.empId /* tenant-B emp */, fx.a.roleId, orgNode(fx.a.deptId)],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-8 — role_assignment FK role tenant-scoped
// ---------------------------------------------------------------------------
describe('AC-8 · FF-6: role_assignment FK role tenant-scoped', () => {
  it('absent role_id → 23503', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO choros.role_assignment
             (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
              source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, 'manual', 'tester', NULL, 'tester', 0, 0)`,
          [TENANT_A, uuid(), fx.a.empId, uuid() /* absent role */, orgNode(fx.a.deptId)],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await c.query('ROLLBACK');
    });
  });

  it('cross-tenant role reference (tenant-A row, tenant-B role) → 23503', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO choros.role_assignment
             (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
              source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, 'manual', 'tester', NULL, 'tester', 0, 0)`,
          [TENANT_A, uuid(), fx.a.empId, fx.b.roleId /* tenant-B role */, orgNode(fx.a.deptId)],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-9 — org_scope jsonb NOT NULL; node + set round-trip
// ---------------------------------------------------------------------------
describe('AC-9 · FF-7: org_scope jsonb NOT NULL + round-trip', () => {
  it('org_scope NULL → 23502', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO choros.role_assignment
             (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
              source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NULL, NULL, NULL, 'manual', 'tester', NULL, 'tester', 0, 0)`,
          [TENANT_A, uuid(), fx.a.empId, fx.a.roleId],
        ),
      ).rejects.toMatchObject({ code: '23502' });
      await c.query('ROLLBACK');
    });
  });

  it('valid node jsonb and set jsonb both insert and round-trip', async () => {
    const setScope = JSON.stringify({
      kind: 'set',
      members: [
        { kind: 'node', hierarchy: 'org', nodeId: fx.a.deptId, nodeLevel: 'department' },
      ],
    });
    await withClient(migratorUrl(), async (c) => {
      // node
      await c.query('BEGIN');
      const nodeId = uuid();
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
            source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, 'manual', 'tester', NULL, 'tester', 0, 0)`,
        [TENANT_A, nodeId, fx.a.empId, fx.a.roleId, orgNode(fx.a.deptId)],
      );
      // set
      const setId = uuid();
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
            source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, 'manual', 'tester', NULL, 'tester', 0, 0)`,
        [TENANT_A, setId, fx.a.empId, fx.a.roleId, setScope],
      );
      const { rows } = await c.query(
        `SELECT id, org_scope FROM choros.role_assignment WHERE tenant_id=$1 AND id IN ($2,$3)`,
        [TENANT_A, nodeId, setId],
      );
      await c.query('COMMIT');
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.org_scope]));
      expect(byId[nodeId]).toEqual(JSON.parse(orgNode(fx.a.deptId)));
      expect(byId[setId]).toEqual(JSON.parse(setScope));
    });
  });
});

// ---------------------------------------------------------------------------
// AC-10 — validity window bigint NULL × 4 combos; no CHECK on from>until
// ---------------------------------------------------------------------------
describe('AC-10 · FF-8: validity window — all 4 null combos; from>until allowed', () => {
  it('all four (valid_from, valid_until) null-combinations insert; from>until accepted', async () => {
    const combos: [number | null, number | null][] = [
      [null, null],
      [1000, null],
      [null, 2000],
      [5000, 1000], // from > until — must be accepted (no DB CHECK, AC-10)
    ];
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      for (const [from, until] of combos) {
        await c.query(
          `INSERT INTO choros.role_assignment
             (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
              source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'manual', 'tester', NULL, 'tester', 0, 0)`,
          [TENANT_A, uuid(), fx.a.empId, fx.a.roleId, orgNode(fx.a.deptId), from, until],
        );
      }
      await c.query('COMMIT');
    });
  });

  it('valid_from/valid_until are bigint NULL per information_schema', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
           WHERE table_schema='choros' AND table_name='role_assignment'
             AND column_name IN ('valid_from','valid_until')`,
      );
      const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));
      expect(byName.valid_from.data_type).toBe('bigint');
      expect(byName.valid_from.is_nullable).toBe('YES');
      expect(byName.valid_until.data_type).toBe('bigint');
      expect(byName.valid_until.is_nullable).toBe('YES');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-11 — proposed_by/confirmed_by text NULL; proposal (confirmed_by NULL) insertable
// ---------------------------------------------------------------------------
describe('AC-11 · FF-9: proposed_by/confirmed_by text NULL semantics', () => {
  it('a proposal (confirmed_by NULL) and a confirmed row both insert; proposed_by independently nullable', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      // Proposal: confirmed_by NULL, proposed_by set.
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
            source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, 'llm-proposed', 'tester', 'agent-x', NULL, 0, 0)`,
        [TENANT_A, uuid(), fx.a.empId, fx.a.roleId, orgNode(fx.a.deptId)],
      );
      // Confirmed direct: proposed_by NULL, confirmed_by set.
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
            source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, 'manual', 'tester', NULL, 'human-y', 0, 0)`,
        [TENANT_A, uuid(), fx.a.empId, fx.a.roleId, orgNode(fx.a.deptId)],
      );
      await c.query('COMMIT');
    });
  });

  it('proposed_by/confirmed_by are text NULL per information_schema', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
           WHERE table_schema='choros' AND table_name='role_assignment'
             AND column_name IN ('proposed_by','confirmed_by')`,
      );
      const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));
      expect(byName.proposed_by.data_type).toBe('text');
      expect(byName.proposed_by.is_nullable).toBe('YES');
      expect(byName.confirmed_by.data_type).toBe('text');
      expect(byName.confirmed_by.is_nullable).toBe('YES');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-12 — source/granted_by text NOT NULL; arbitrary string OK
// ---------------------------------------------------------------------------
describe('AC-12 · FF-9: source/granted_by text NOT NULL', () => {
  it('source NULL → 23502', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO choros.role_assignment
             (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
              source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, NULL, 'tester', NULL, 'tester', 0, 0)`,
          [TENANT_A, uuid(), fx.a.empId, fx.a.roleId, orgNode(fx.a.deptId)],
        ),
      ).rejects.toMatchObject({ code: '23502' });
      await c.query('ROLLBACK');
    });
  });

  it('granted_by NULL → 23502', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO choros.role_assignment
             (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
              source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, 'manual', NULL, NULL, 'tester', 0, 0)`,
          [TENANT_A, uuid(), fx.a.empId, fx.a.roleId, orgNode(fx.a.deptId)],
        ),
      ).rejects.toMatchObject({ code: '23502' });
      await c.query('ROLLBACK');
    });
  });

  it('arbitrary non-empty source string accepted (no CHECK enum)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      for (const src of ['manual', 'llm-proposed', 'import', 'whatever-custom']) {
        await c.query(
          `INSERT INTO choros.role_assignment
             (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
              source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, $6, 'tester', NULL, 'tester', 0, 0)`,
          [TENANT_A, uuid(), fx.a.empId, fx.a.roleId, orgNode(fx.a.deptId), src],
        );
      }
      await c.query('COMMIT');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-13 — grant.role_id real FK after 021 (bad role_id → 23503)
// ---------------------------------------------------------------------------
describe('AC-13 · FF-10: grant.role_id real FK after migration 021', () => {
  it('inserting a grant whose role_id names no existing role → 23503', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO choros."grant"
             (tenant_id, id, role_id, resource_type, operation, scope, granted_by, created_at)
           VALUES ($1, $2, $3, 'application', 'read', '{}'::jsonb, 'tester', 0)`,
          [TENANT_A, uuid(), uuid() /* no such role */],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await c.query('ROLLBACK');
    });
  });

  it('inserting a grant referencing an existing role succeeds', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, operation, scope, granted_by, created_at)
         VALUES ($1, $2, $3, 'application', 'read', '{}'::jsonb, 'tester', 0)`,
        [TENANT_A, uuid(), fx.a.roleId],
      );
      await c.query('COMMIT');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-14 — grant.role_id FK tenant-scoped (cross-tenant role ref → 23503)
// ---------------------------------------------------------------------------
describe('AC-14 · FF-10: grant.role_id FK is tenant-scoped', () => {
  it('grant in tenant-A referencing a role that exists only in tenant-B → 23503', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO choros."grant"
             (tenant_id, id, role_id, resource_type, operation, scope, granted_by, created_at)
           VALUES ($1, $2, $3, 'application', 'read', '{}'::jsonb, 'tester', 0)`,
          [TENANT_A, uuid(), fx.b.roleId /* role lives in tenant-B */],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-15 — dev role seed present (tenant-owner + functional) + idempotent
// ---------------------------------------------------------------------------
describe('AC-15 · FF-11: dev role seed present + idempotent', () => {
  it('dev tenant has tenant-owner + ≥1 functional role; re-seed is a no-op', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows: ownerRows } = await c.query(
        `SELECT id, slug FROM choros.role WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, DEV_ROLE_OWNER],
      );
      expect(ownerRows.length, 'tenant-owner genesis role must be seeded').toBe(1);
      expect(ownerRows[0].slug).toBe('tenant-owner');

      const { rows: budgetRows } = await c.query(
        `SELECT slug FROM choros.role WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, DEV_ROLE_BUDGET_APPROVER],
      );
      expect(budgetRows.length, 'budget-approver functional role must be seeded').toBe(1);

      const before = (
        await c.query(`SELECT count(*)::int AS n FROM choros.role WHERE tenant_id=$1`, [DEV_TENANT])
      ).rows[0].n;
      expect(before).toBeGreaterThanOrEqual(2);

      // Re-run the seed insert (ON CONFLICT DO NOTHING) — idempotent: same count.
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
         VALUES ($1, $2, 'tenant-owner', 'Владелец тенанта', 'x', 0, 0),
                ($1, $3, 'budget-approver', 'Согласующий бюджет', 'x', 0, 0)
         ON CONFLICT DO NOTHING`,
        [DEV_TENANT, DEV_ROLE_OWNER, DEV_ROLE_BUDGET_APPROVER],
      );
      await c.query('COMMIT');
      const after = (
        await c.query(`SELECT count(*)::int AS n FROM choros.role WHERE tenant_id=$1`, [DEV_TENANT])
      ).rows[0].n;
      expect(after, 're-seed must not add duplicate roles').toBe(before);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-16 — dev assignment seed wires real employee→role→dept node + idempotent
// ---------------------------------------------------------------------------
describe('AC-16 · FF-11: dev assignment seed wires real employee→role→dept node', () => {
  it('seeded assignment resolves to real employee/role/dept; confirmed; idempotent', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT employee_id, role_id, org_scope, confirmed_by, proposed_by
           FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, DEV_RA_MIRONOV],
      );
      expect(rows.length, 'dev assignment seed must exist').toBe(1);
      const ra = rows[0];
      expect(ra.employee_id).toBe(DEV_EMP_MIRONOV);
      expect(ra.role_id).toBe(DEV_ROLE_BUDGET_APPROVER);
      expect(ra.confirmed_by, 'seed must be confirmed (effective)').not.toBeNull();
      expect(ra.proposed_by, 'seed created direct → proposed_by NULL').toBeNull();
      expect(ra.org_scope).toEqual({
        kind: 'node',
        hierarchy: 'org',
        nodeId: DEV_DEPT_FIN,
        nodeLevel: 'department',
      });

      // employee, role, and the org node referenced all really exist.
      const emp = await c.query(`SELECT 1 FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [
        DEV_TENANT,
        ra.employee_id,
      ]);
      expect(emp.rows.length).toBe(1);
      const role = await c.query(`SELECT 1 FROM choros.role WHERE tenant_id=$1 AND id=$2`, [
        DEV_TENANT,
        ra.role_id,
      ]);
      expect(role.rows.length).toBe(1);
      const dept = await c.query(`SELECT 1 FROM choros.department WHERE tenant_id=$1 AND id=$2`, [
        DEV_TENANT,
        ra.org_scope.nodeId,
      ]);
      expect(dept.rows.length).toBe(1);

      // Idempotency: re-run the seed insert → same row count.
      const before = (
        await c.query(`SELECT count(*)::int AS n FROM choros.role_assignment WHERE tenant_id=$1`, [
          DEV_TENANT,
        ])
      ).rows[0].n;
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
            source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, 'manual', 'seed', NULL, 'seed', 0, 0)
         ON CONFLICT DO NOTHING`,
        [DEV_TENANT, DEV_RA_MIRONOV, DEV_EMP_MIRONOV, DEV_ROLE_BUDGET_APPROVER, orgNode(DEV_DEPT_FIN)],
      );
      await c.query('COMMIT');
      const after = (
        await c.query(`SELECT count(*)::int AS n FROM choros.role_assignment WHERE tenant_id=$1`, [
          DEV_TENANT,
        ])
      ).rows[0].n;
      expect(after, 're-seed must not duplicate the assignment').toBe(before);
    });
  });
});
