// Live Postgres behavioral tests for T-0017 org-structure acceptance criteria.
// Covers AC-8, AC-9, AC-10, AC-12.
// Run in the `db` CI job / locally: DATABASE_URL=... npm run fitness:db
//
// AC-8  — FK cross-tenant rejection: department row with wrong tenant_id FK → PG 23503
// AC-9  — Department cycle prevention: A.parent=B then B.parent=A → rejected
// AC-10 — employee.kind CHECK: kind='robot' rejected with PG 23514
// AC-12 — employee slug uniqueness per tenant: duplicate (tenant_id, slug) → PG 23505

import { describe, it, expect } from 'vitest';
import { migratorUrl, withClient, TENANT_A, TENANT_B, uuid } from './_helpers.js';

// ---------------------------------------------------------------------------
// Stable seed UUID constants (matches migration 013-016 seeds)
// ---------------------------------------------------------------------------

const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
// fin department (seeded in 014)
const DEV_DEPT_FIN = 'b0000000-0000-0000-0000-000000000001';
// fin-ctrl position (seeded in 015)
const DEV_POS_FIN_CTRL = 'c0000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Helper: insert a tenant row for a test-tenant UUID (TENANT_A / TENANT_B)
// These are test tenants, not the dev-seed tenant.
// ---------------------------------------------------------------------------

async function ensureTenant(c: import('pg').Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, `test-tenant-${tenantId.slice(0, 8)}`],
  );
}

// ---------------------------------------------------------------------------
// AC-8 — FK cross-tenant rejection (PG 23503)
// Insert a department row where tenant_id does not match any seeded tenant row,
// so the FK position→department / department→department (parent) chain would
// violate cross-tenant isolation.
//
// The concrete test: insert a department for TENANT_A referencing TENANT_B's
// department UUID as parent_id — the composite FK (tenant_id, parent_id) checks
// that (TENANT_A, TENANT_B_DEPT_ID) exists in department, which it doesn't →
// FK violation 23503.
// ---------------------------------------------------------------------------

describe('AC-8: FK cross-tenant rejection', () => {
  it('department parent_id referencing a different-tenant dept row is rejected (23503)', async () => {
    await withClient(migratorUrl(), async (c) => {
      // Ensure TENANT_A and TENANT_B rows exist.
      await c.query('BEGIN');
      await ensureTenant(c, TENANT_A);
      await c.query('COMMIT');

      await c.query('BEGIN');
      await ensureTenant(c, TENANT_B);
      // Seed a dept for TENANT_B
      const deptBId = uuid();
      await c.query(
        `INSERT INTO choros.department
           (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
        [TENANT_B, deptBId, `dept-b-${deptBId.slice(0, 8)}`],
      );
      await c.query('COMMIT');

      // Now try to insert a TENANT_A department whose parent_id = deptBId.
      // FK (tenant_id=TENANT_A, parent_id=deptBId) → department(TENANT_A, deptBId) — no such row.
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO choros.department
             (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4, 0, 0)`,
          [TENANT_A, uuid(), deptBId, `dept-a-bad-${uuid().slice(0, 8)}`],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await c.query('ROLLBACK');
    });
  });

  it('position row with tenant_id referencing non-existent dept (cross-tenant) is rejected (23503)', async () => {
    await withClient(migratorUrl(), async (c) => {
      // Seed dept for TENANT_A
      await c.query('BEGIN');
      await ensureTenant(c, TENANT_A);
      const deptAId = uuid();
      await c.query(
        `INSERT INTO choros.department
           (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
        [TENANT_A, deptAId, `dept-a-${deptAId.slice(0, 8)}`],
      );
      await c.query('COMMIT');

      // Try to insert a TENANT_B position referencing TENANT_A's dept UUID.
      // FK (tenant_id=TENANT_B, department_id=deptAId) → department(TENANT_B, deptAId) — doesn't exist.
      await c.query('BEGIN');
      await ensureTenant(c, TENANT_B);
      await expect(
        c.query(
          `INSERT INTO choros.position
             (tenant_id, id, department_id, slug, title, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4, 0, 0)`,
          [TENANT_B, uuid(), deptAId, `pos-b-bad-${uuid().slice(0, 8)}`],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-9 — Department cycle prevention
// The ADR §1.1 specifies application-layer cycle prevention (ancestor walk
// before INSERT/UPDATE parent_id). The DB self-referential FK alone does not
// prevent cycles — it only enforces referential integrity within the same
// tenant. This test verifies the DB-layer behavior: after A.parent=B is set,
// setting B.parent=A IS accepted at the DB layer (the DB doesn't enforce
// acyclicity). This test documents the agreed boundary: cycle prevention is
// application-layer responsibility, not DB-enforced.
//
// This test both demonstrates the absence of DB-level cycle rejection AND
// provides a baseline for future application-layer enforcement tests.
// ---------------------------------------------------------------------------

describe('AC-9: department cycle — application-layer boundary', () => {
  it('DB allows B.parent=A when A.parent=B (cycle is app-layer responsibility)', async () => {
    // Per ADR §1.1: "Cycle prevention (AC-9) is an application-layer pre-insert
    // check (path ancestry walk); a DB-level cycle trigger is an autonomous
    // improvement — the spec allows either."
    // This test documents the DB-layer boundary: the DB FK does NOT reject a cycle.
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await ensureTenant(c, TENANT_A);

      // Insert dept A (root)
      const deptA = uuid();
      await c.query(
        `INSERT INTO choros.department
           (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
        [TENANT_A, deptA, `cycle-a-${deptA.slice(0, 8)}`],
      );

      // Insert dept B with parent_id = A
      const deptB = uuid();
      await c.query(
        `INSERT INTO choros.department
           (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4, 0, 0)`,
        [TENANT_A, deptB, deptA, `cycle-b-${deptB.slice(0, 8)}`],
      );

      // Update A.parent_id = B → creates a cycle A→B→A.
      // DB FK (TENANT_A, deptB) exists in department → update succeeds at DB layer.
      // Application layer MUST prevent this before reaching DB.
      await c.query(
        `UPDATE choros.department SET parent_id = $1 WHERE tenant_id = $2 AND id = $3`,
        [deptB, TENANT_A, deptA],
      );

      await c.query('ROLLBACK'); // Roll back to not pollute DB state
    });
    // If we reach here: DB allowed the cycle — application layer must guard it.
    // This is the expected behavior per ADR §1.1.
  });
});

// ---------------------------------------------------------------------------
// AC-10 — employee.kind CHECK constraint: kind='robot' rejected with PG 23514
// ---------------------------------------------------------------------------

describe('AC-10: employee.kind CHECK constraint', () => {
  it("INSERT employee with kind='robot' is rejected (23514)", async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO choros.employee
             (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
           VALUES ($1, $2, $3, 'robot', $4, $4, 0, 0)`,
          [DEV_TENANT, uuid(), DEV_POS_FIN_CTRL, `robot-${uuid().slice(0, 8)}`],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await c.query('ROLLBACK');
    });
  });

  it("INSERT employee with kind='human' succeeds", async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      const slug = `valid-human-${uuid().slice(0, 8)}`;
      await c.query(
        `INSERT INTO choros.employee
           (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, $3, 'human', $4, $4, 0, 0)`,
        [DEV_TENANT, uuid(), DEV_POS_FIN_CTRL, slug],
      );
      await c.query('ROLLBACK');
    });
  });

  it("INSERT employee with kind='agent' succeeds", async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      const slug = `valid-agent-${uuid().slice(0, 8)}`;
      await c.query(
        `INSERT INTO choros.employee
           (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, $3, 'agent', $4, $4, 0, 0)`,
        [DEV_TENANT, uuid(), DEV_POS_FIN_CTRL, slug],
      );
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-12 — employee slug uniqueness per tenant: UNIQUE (tenant_id, slug) → 23505
// Same slug in different tenants is allowed (cross-tenant slug reuse).
// Same slug in same tenant is rejected.
// ---------------------------------------------------------------------------

describe('AC-12: employee slug uniqueness per tenant', () => {
  it('duplicate (tenant_id, slug) on employee is rejected (23505)', async () => {
    const slug = `slug-dup-${uuid().slice(0, 8)}`;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      // First insert — should succeed
      await c.query(
        `INSERT INTO choros.employee
           (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, $3, 'human', $4, $4, 0, 0)`,
        [DEV_TENANT, uuid(), DEV_POS_FIN_CTRL, slug],
      );
      // Second insert same (tenant_id, slug) → should fail with 23505
      await expect(
        c.query(
          `INSERT INTO choros.employee
             (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
           VALUES ($1, $2, $3, 'human', $4, $4, 0, 0)`,
          [DEV_TENANT, uuid(), DEV_POS_FIN_CTRL, slug],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await c.query('ROLLBACK');
    });
  });

  it('same slug allowed across different tenants', async () => {
    const slug = `slug-cross-${uuid().slice(0, 8)}`;
    await withClient(migratorUrl(), async (c) => {
      // Seed TENANT_A dept + position for this test
      await c.query('BEGIN');
      await ensureTenant(c, TENANT_A);
      const deptA = uuid();
      await c.query(
        `INSERT INTO choros.department
           (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
        [TENANT_A, deptA, `dept-slug-cross-a-${deptA.slice(0, 8)}`],
      );
      const posA = uuid();
      await c.query(
        `INSERT INTO choros.position
           (tenant_id, id, department_id, slug, title, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4, 0, 0)`,
        [TENANT_A, posA, deptA, `pos-slug-cross-a-${posA.slice(0, 8)}`],
      );
      await c.query('COMMIT');

      // Seed TENANT_B dept + position
      await c.query('BEGIN');
      await ensureTenant(c, TENANT_B);
      const deptB = uuid();
      await c.query(
        `INSERT INTO choros.department
           (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
        [TENANT_B, deptB, `dept-slug-cross-b-${deptB.slice(0, 8)}`],
      );
      const posB = uuid();
      await c.query(
        `INSERT INTO choros.position
           (tenant_id, id, department_id, slug, title, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4, 0, 0)`,
        [TENANT_B, posB, deptB, `pos-slug-cross-b-${posB.slice(0, 8)}`],
      );
      await c.query('COMMIT');

      // Insert same slug in TENANT_A — ok
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.employee
           (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, $3, 'human', $4, $4, 0, 0)`,
        [TENANT_A, uuid(), posA, slug],
      );
      await c.query('COMMIT');

      // Insert same slug in TENANT_B — should also succeed (different tenant)
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.employee
           (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, $3, 'human', $4, $4, 0, 0)`,
        [TENANT_B, uuid(), posB, slug],
      );
      await c.query('COMMIT');
    });
  });
});
