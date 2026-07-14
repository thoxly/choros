/**
 * ci/checks/db/org-tree-deactivated.db.test.ts — T-0698 [P2 from T-0673's
 * judge / anti-UUID / столп 4] live-DB fitness for listOrgTree
 * (src/db/org.ts) carrying the `deactivated` boolean.
 *
 * THE BUG THIS PROVES FIXED: GET /api/org's `people[]` (built by
 * listOrgTree) never carried any deactivation signal at all — the SQL SELECT
 * didn't fetch `employee.deactivated_at` and the `OrgPerson` type didn't
 * declare the field. web/src/screens/screen-app-records.jsx's PersonCell
 * reads `hit.deactivated` from a Map built off this exact endpoint
 * (fetchEmployees()), so the deactivated-executor marker was permanently
 * false in production. The unit test that shipped alongside PersonCell
 * (T-0673) stayed green throughout because it hand-built its `employees` Map
 * with `deactivated: true` directly — it never exercised listOrgTree at all.
 *
 * This file proves the SERVER half against a REAL Postgres:
 *   AC-active:      an employee with deactivated_at IS NULL surfaces
 *                    deactivated:false in listOrgTree's people[].
 *   AC-deactivated: an employee with deactivated_at set surfaces
 *                    deactivated:true.
 *   AC-boolean:     the raw deactivated_at epoch-ms value is NEVER present on
 *                    the returned OrgPerson — only the derived boolean (see
 *                    docs/design/ADR-T0698-personcell-deactivated-thread.md
 *                    §3.1 for why: /api/org is broadly readable by any
 *                    authenticated tenant member, so the exact deactivation
 *                    timestamp is deliberately NOT exposed).
 *
 * Run:
 *   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
 *   npm run fitness:db
 *
 * No DATABASE_URL → all tests auto-skip (requireDb guard, mirrors every
 * sibling db-tier test in this directory).
 */

import { describe, it, expect } from "vitest";
import pg from "pg";
import { migratorUrl, appUrl, withClient, uuid } from "./_helpers.js";
import { listOrgTree } from "../../../src/db/org.js";

function requireDb(): boolean {
  return Boolean(process.env["DATABASE_URL"]);
}

/**
 * Seed a minimal tenant → department → position → employee chain via the
 * migrator (BYPASSRLS) role — listOrgTree walks exactly this hierarchy
 * (department.tenant_id → position.department_id → employee.position_id),
 * unlike batchResolveActors' flatter employee-only seed (actor-resolver.db.
 * test.ts), so this helper carries one more join level.
 */
async function seedOrgTree(
  tenantId: string,
  employees: Array<{ id: string; slug: string; displayName: string; deactivatedAt?: number }>,
): Promise<{ deptId: string; posId: string }> {
  const deptId = uuid();
  const posId = uuid();
  await withClient(migratorUrl(), async (c) => {
    await c.query(
      `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
       VALUES ($1, $1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [tenantId, `t-fitness-${tenantId.slice(0, 8)}`, "T-0698 fitness tenant", 0],
    );
    await c.query("BEGIN");
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query(
      `INSERT INTO choros.department
         (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
       VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
      [tenantId, deptId, `dept-fitness-${deptId.slice(0, 8)}`],
    );
    await c.query(
      `INSERT INTO choros.position
         (tenant_id, id, department_id, slug, title, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, 0, 0)`,
      [tenantId, posId, deptId, `pos-fitness-${posId.slice(0, 8)}`],
    );
    for (const e of employees) {
      await c.query(
        `INSERT INTO choros.employee
           (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at, deactivated_at)
         VALUES ($1, $2, $3, 'human', $4, $5, 0, 0, $6)
         ON CONFLICT DO NOTHING`,
        [tenantId, e.id, posId, e.slug, e.displayName, e.deactivatedAt ?? null],
      );
    }
    await c.query("COMMIT");
  });
  return { deptId, posId };
}

async function cleanupTenant(tenantId: string): Promise<void> {
  await withClient(migratorUrl(), async (c) => {
    await c.query("BEGIN");
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [tenantId]);
    await c.query(`DELETE FROM choros.position WHERE tenant_id = $1`, [tenantId]);
    await c.query(`DELETE FROM choros.department WHERE tenant_id = $1`, [tenantId]);
    await c.query("COMMIT");
  });
}

function findPerson(
  departments: Awaited<ReturnType<typeof listOrgTree>>,
  slug: string,
): { id: string; name: string; type: string; deactivated?: boolean } | undefined {
  for (const dept of departments) {
    for (const pos of dept.positions) {
      const hit = pos.people.find((p) => p.id === slug);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe.skipIf(!requireDb())("T-0698 listOrgTree — deactivated boolean, live Postgres fitness", () => {
  it("AC-active: an active employee (deactivated_at IS NULL) surfaces deactivated:false", async () => {
    const tenantId = uuid();
    await seedOrgTree(tenantId, [
      { id: uuid(), slug: "e-fitness-active", displayName: "Активный Фитнес" },
    ]);
    try {
      const pool = new pg.Pool({ connectionString: appUrl() });
      try {
        const departments = await listOrgTree(pool, tenantId);
        const person = findPerson(departments, "e-fitness-active");
        expect(person).toBeDefined();
        expect(person!.name).toBe("Активный Фитнес");
        expect(person!.deactivated).toBe(false);
      } finally {
        await pool.end();
      }
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  it("AC-deactivated: a soft-deactivated employee surfaces deactivated:true — this is the assertion that FAILS on pre-T-0698 code (listOrgTree didn't select deactivated_at at all, so `deactivated` was always undefined/falsy regardless of the row)", async () => {
    const tenantId = uuid();
    await seedOrgTree(tenantId, [
      { id: uuid(), slug: "e-fitness-gone", displayName: "Уволенный Фитнес", deactivatedAt: Date.now() },
    ]);
    try {
      const pool = new pg.Pool({ connectionString: appUrl() });
      try {
        const departments = await listOrgTree(pool, tenantId);
        const person = findPerson(departments, "e-fitness-gone");
        expect(person).toBeDefined();
        expect(person!.deactivated).toBe(true);
      } finally {
        await pool.end();
      }
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  it("AC-boolean: the raw deactivated_at epoch-ms timestamp is never present on the returned person (boolean only — privacy minimization, ADR §3.1)", async () => {
    const tenantId = uuid();
    const deactivatedAt = Date.now();
    await seedOrgTree(tenantId, [
      { id: uuid(), slug: "e-fitness-private", displayName: "Приватный Фитнес", deactivatedAt },
    ]);
    try {
      const pool = new pg.Pool({ connectionString: appUrl() });
      try {
        const departments = await listOrgTree(pool, tenantId);
        const person = findPerson(departments, "e-fitness-private") as unknown as Record<string, unknown>;
        expect(person).toBeDefined();
        expect(person["deactivated"]).toBe(true);
        expect(person["deactivatedAt"]).toBeUndefined();
        expect(person["deactivated_at"]).toBeUndefined();
        expect(Object.values(person)).not.toContain(deactivatedAt);
      } finally {
        await pool.end();
      }
    } finally {
      await cleanupTenant(tenantId);
    }
  });
});
