/**
 * ci/checks/db/actor-resolver.db.test.ts — T-0648 [W4-UX/столп 4] live-DB
 * fitness for batchResolveActors (src/db/actor-resolver.ts).
 *
 * The unit suite (src/__tests__/actor-resolver.test.ts) proves the SQL SHAPE
 * against a faked pool. This file proves the query is actually CORRECT and
 * NO-N+1 against a REAL Postgres — the SELECT ... WHERE tenant_id = $1 AND
 * (slug = ANY($2) OR id::text = ANY($2)) must:
 *   AC-resolve:  resolve real choros.employee rows (human + agent kinds) for
 *                a freshly-inserted tenant, matching the dev-seed shape.
 *   AC-isolation: NEVER resolve an employee from a DIFFERENT tenant (RLS +
 *                the literal tenant_id predicate) — read path runs as
 *                choros_app (NOBYPASSRLS, the exact production role).
 *   AC-n1:       exactly ONE round-trip query for a batch, verified via a
 *                query-counting client wrapper (mirrors the technique the
 *                unit suite's fake pool uses, but against a REAL connection).
 *   AC-deactivated: an employee with deactivated_at set surfaces
 *                deactivated:true.
 *
 * Seeding uses the migrator (BYPASSRLS) role — choros.tenant/choros.employee
 * carry FORCE ROW LEVEL SECURITY (migrations 006/013/016), so an INSERT under
 * the NOBYPASSRLS choros_app role without a matching tenant GUC would be
 * rejected by the WITH CHECK policy. The resolver itself is then exercised
 * against choros_app (appUrl()) — the exact production read role.
 *
 * Run:
 *   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
 *   npm run fitness:db
 *
 * No DATABASE_URL → all tests auto-skip (requireDb guard, mirrors the sibling
 * db-tier tests in this directory).
 */

import { describe, it, expect } from "vitest";
import pg from "pg";
import { migratorUrl, appUrl, withClient, uuid } from "./_helpers.js";
import { batchResolveActors } from "../../../src/db/actor-resolver.js";

function requireDb(): boolean {
  return Boolean(process.env["DATABASE_URL"]);
}

/** Seed a minimal tenant + employee row set via the migrator (BYPASSRLS) role. */
async function seedTenant(
  tenantId: string,
  employees: Array<{ id: string; kind: "human" | "agent"; slug: string; displayName: string; deactivatedAt?: number }>,
): Promise<void> {
  await withClient(migratorUrl(), async (c) => {
    await c.query(
      `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
       VALUES ($1, $1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [tenantId, `t-fitness-${tenantId.slice(0, 8)}`, "T-0648 fitness tenant", 0],
    );
    await c.query("BEGIN");
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    for (const e of employees) {
      await c.query(
        `INSERT INTO choros.employee
           (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at, deactivated_at)
         VALUES ($1, $2, NULL, $3, $4, $5, 0, 0, $6)
         ON CONFLICT DO NOTHING`,
        [tenantId, e.id, e.kind, e.slug, e.displayName, e.deactivatedAt ?? null],
      );
    }
    await c.query("COMMIT");
  });
}

async function cleanupTenant(tenantId: string): Promise<void> {
  await withClient(migratorUrl(), async (c) => {
    await c.query("BEGIN");
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [tenantId]);
    await c.query("COMMIT");
  });
}

describe.skipIf(!requireDb())("T-0648 batchResolveActors — live Postgres fitness", () => {
  it("AC-resolve: resolves real human + agent employee rows for a fresh tenant", async () => {
    const tenantId = uuid();
    const humanId = uuid();
    const agentId = uuid();
    await seedTenant(tenantId, [
      { id: humanId, kind: "human", slug: "e-fitness-human", displayName: "Фитнес Человек" },
      { id: agentId, kind: "agent", slug: "a-fitness-agent", displayName: "Фитнес Агент" },
    ]);
    try {
      const pool = new pg.Pool({ connectionString: appUrl() });
      try {
        const resolved = await batchResolveActors(pool, tenantId, [
          "e-fitness-human",
          "a-fitness-agent",
        ]);

        expect(resolved.get("e-fitness-human")?.name).toBe("Фитнес Человек");
        expect(resolved.get("e-fitness-human")?.type).toBe("human");
        expect(resolved.get("a-fitness-agent")?.name).toBe("Фитнес Агент");
        expect(resolved.get("a-fitness-agent")?.type).toBe("agent");
      } finally {
        await pool.end();
      }
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  it("AC-isolation: an employee slug in a DIFFERENT tenant never resolves (RLS + literal predicate)", async () => {
    const tenantA = uuid();
    const tenantB = uuid();
    const slug = "e-fitness-cross-tenant";

    await seedTenant(tenantA, [
      { id: uuid(), kind: "human", slug, displayName: "Tenant A Human" },
    ]);
    // No employee with this slug in tenant B — tenantB is registered (tenant
    // row only) so resolveActorTenant-style callers would still see a valid
    // tenant, just with no matching employee.
    await seedTenant(tenantB, []);

    try {
      const pool = new pg.Pool({ connectionString: appUrl() });
      try {
        const resolvedFromB = await batchResolveActors(pool, tenantB, [slug]);
        expect(resolvedFromB.has(slug)).toBe(false);

        const resolvedFromA = await batchResolveActors(pool, tenantA, [slug]);
        expect(resolvedFromA.get(slug)?.name).toBe("Tenant A Human");
      } finally {
        await pool.end();
      }
    } finally {
      await cleanupTenant(tenantA);
      await cleanupTenant(tenantB);
    }
  });

  it("AC-n1: resolves 10 distinct employees in exactly ONE round-trip query", async () => {
    const tenantId = uuid();
    const employees = Array.from({ length: 10 }, (_, i) => ({
      id: uuid(),
      kind: "human" as const,
      slug: `e-fitness-batch-${i}`,
      displayName: `Batch Actor ${i}`,
    }));
    await seedTenant(tenantId, employees);

    try {
      const rawPool = new pg.Pool({ connectionString: appUrl() });
      let queryCount = 0;
      // Wrap .connect() so every client.query() call on the checked-out client
      // is counted — instruments a REAL pg.Pool/Client (only the counting is
      // instrumented, not the SQL execution/RLS behavior).
      const countingPool = {
        connect: async () => {
          const client = await rawPool.connect();
          const originalQuery = client.query.bind(client);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client as any).query = (...args: any[]) => {
            const sql = String(args[0]);
            if (sql.includes("FROM choros.employee")) queryCount += 1;
            return originalQuery(...args);
          };
          return client;
        },
      } as unknown as pg.Pool;

      try {
        const resolved = await batchResolveActors(
          countingPool,
          tenantId,
          employees.map((e) => e.slug),
        );

        expect(resolved.size).toBe(20); // indexed by BOTH slug and id (see actor-resolver.ts)
        expect(queryCount).toBe(1);
      } finally {
        await rawPool.end();
      }
    } finally {
      await cleanupTenant(tenantId);
    }
  });

  it("AC-deactivated: a soft-deactivated employee surfaces deactivated:true", async () => {
    const tenantId = uuid();
    await seedTenant(tenantId, [
      {
        id: uuid(),
        kind: "human",
        slug: "e-fitness-gone",
        displayName: "Уволенный Фитнес",
        deactivatedAt: Date.now(),
      },
    ]);

    try {
      const pool = new pg.Pool({ connectionString: appUrl() });
      try {
        const resolved = await batchResolveActors(pool, tenantId, ["e-fitness-gone"]);
        expect(resolved.get("e-fitness-gone")?.deactivated).toBe(true);
      } finally {
        await pool.end();
      }
    } finally {
      await cleanupTenant(tenantId);
    }
  });
});
