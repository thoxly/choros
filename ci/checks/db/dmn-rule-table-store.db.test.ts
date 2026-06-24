/**
 * T-0433 — Live Postgres tests for DMN rule table write functions.
 *
 * Round-trip: upsertRuleTableDraft → getRuleTableById → publish →
 *   loadPublishedRuleTables returns the table.
 *
 * D-056 assertion: after publishRuleTable, loadPublishedRuleTables RETURNS
 * the authored table — proving the runtime evaluator reads what the write API wrote.
 *
 * Cross-tenant: getRuleTableById with a foreign tenant id returns null.
 *
 * Strategy (mirrors grant-trail.db.test.ts):
 *   - Each test uses a FRESH uuid() tenant (NOT TENANT_A/B — shared tenants
 *     cause false-greens via cross-test contamination).
 *   - Seed uses withClient(migratorUrl()) — choros_migrator bypasses RLS.
 *   - Store calls use withClient(appUrl()) via withTenantTx — choros_app
 *     NOBYPASSRLS proves RLS isolation.
 */

import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import { appUrl, migratorUrl, withClient, uuid } from "./_helpers.js";
import {
  upsertRuleTableDraft,
  getRuleTableById,
  listRuleTables,
  publishRuleTable,
  loadPublishedRuleTables,
} from "../../../src/db/dmn-rule-table-store.js";
import type { DmnRuleTable } from "../../../src/core/dmn-middle.js";

const { Pool } = pg;

// Skip if DATABASE_URL is not set (CI unit-only path).
if (!process.env["DATABASE_URL"]) {
  describe.skip("dmn-rule-table-store — live Postgres (DATABASE_URL not set)", () => {
    it.skip("skipped", () => {});
  });
} else {

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed a fresh tenant row via migrator (bypasses RLS).
 * Each test run uses a unique tenant to prevent cross-test contamination.
 */
async function seedTenant(tenantId: string): Promise<void> {
  await withClient(migratorUrl(), async (c) => {
    await c.query(
      `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
       VALUES ($1, $1, $2, $2, 0)
       ON CONFLICT DO NOTHING`,
      [tenantId, `dmn-test-${tenantId.slice(0, 8)}`],
    );
  });
}

/** A minimal valid 2-rule FIRST table (matches the ТЭЛ seed shape). */
function makeTable(id: string): DmnRuleTable {
  return {
    id,
    name: "T-0433 test: порог суммы",
    hitPolicy: "FIRST",
    rules: [
      {
        conditions: [{ field: "amount", operator: "gt", value: 5000000 }],
        effects: [
          { kind: "set_routing_outcome", name: "approvalRequired", value: "needs-approval" },
        ],
        annotation: "Сумма > 5 млн → доп. согласование",
      },
      {
        conditions: [],
        effects: [
          { kind: "set_routing_outcome", name: "approvalRequired", value: "standard" },
        ],
        annotation: "Стандартный трек",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dmn-rule-table-store — live Postgres", () => {
  let appPool: pg.Pool;

  beforeAll(() => {
    appPool = new Pool({ connectionString: appUrl() });
  });

  // -------------------------------------------------------------------------
  // Round-trip: upsertRuleTableDraft → getRuleTableById → publish →
  //             loadPublishedRuleTables returns the table (D-056 assertion).
  // -------------------------------------------------------------------------

  it("round-trip: draft upsert → getById → publish → loadPublishedRuleTables", async () => {
    const tenantId = uuid();
    await seedTenant(tenantId);

    const tableId = uuid();
    const table = makeTable(tableId);

    // Step 1: upsert as draft
    const client = await appPool.connect();
    let insertedId: string;
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await client.query("SET LOCAL search_path TO choros");
      insertedId = await upsertRuleTableDraft(client, tenantId, table, null);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    expect(insertedId).toBe(tableId);

    // Step 2: getRuleTableById returns the draft
    const client2 = await appPool.connect();
    let fetched;
    try {
      await client2.query("BEGIN");
      await client2.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await client2.query("SET LOCAL search_path TO choros");
      fetched = await getRuleTableById(client2, tenantId, insertedId);
      await client2.query("COMMIT");
    } catch (err) {
      await client2.query("ROLLBACK");
      throw err;
    } finally {
      client2.release();
    }

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(insertedId);
    expect(fetched!.status).toBe("draft");
    expect(fetched!.definition.name).toBe(table.name);
    expect(fetched!.definition.hitPolicy).toBe("FIRST");
    expect(fetched!.definition.rules).toHaveLength(2);

    // Step 3: publish the table
    const client3 = await appPool.connect();
    let published: boolean;
    try {
      await client3.query("BEGIN");
      await client3.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await client3.query("SET LOCAL search_path TO choros");
      published = await publishRuleTable(client3, tenantId, insertedId);
      await client3.query("COMMIT");
    } catch (err) {
      await client3.query("ROLLBACK");
      throw err;
    } finally {
      client3.release();
    }

    expect(published).toBe(true);

    // Step 4: D-056 assertion — loadPublishedRuleTables returns the published table.
    // This proves the runtime evaluator reads what the write API wrote.
    const client4 = await appPool.connect();
    let { tables } = { tables: [] as DmnRuleTable[] };
    try {
      await client4.query("BEGIN");
      await client4.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await client4.query("SET LOCAL search_path TO choros");
      const result = await loadPublishedRuleTables(client4, tenantId);
      tables = result.tables;
      await client4.query("COMMIT");
    } catch (err) {
      await client4.query("ROLLBACK");
      throw err;
    } finally {
      client4.release();
    }

    const found = tables.find((t) => t.id === insertedId);
    expect(found).toBeDefined();
    expect(found!.name).toBe(table.name);
    expect(found!.hitPolicy).toBe("FIRST");
    expect(found!.rules).toHaveLength(2);
    // Verify the routing outcome is preserved round-trip
    const routingEffect = found!.rules[0]!.effects.find(
      (e) => e.kind === "set_routing_outcome",
    );
    expect(routingEffect).toBeDefined();
    if (routingEffect?.kind === "set_routing_outcome") {
      expect(routingEffect.name).toBe("approvalRequired");
      expect(routingEffect.value).toBe("needs-approval");
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Cross-tenant: getRuleTableById with a foreign tenant returns null.
  // -------------------------------------------------------------------------

  it("cross-tenant: getRuleTableById returns null for foreign tenant", async () => {
    // Tenant A owns the table
    const tenantA = uuid();
    const tenantB = uuid();
    await seedTenant(tenantA);
    await seedTenant(tenantB);

    const tableId = uuid();
    const table = makeTable(tableId);

    // Insert in tenant A
    const clientA = await appPool.connect();
    let insertedId: string;
    try {
      await clientA.query("BEGIN");
      await clientA.query(`SET LOCAL choros.tenant_id = '${tenantA}'`);
      await clientA.query("SET LOCAL search_path TO choros");
      insertedId = await upsertRuleTableDraft(clientA, tenantA, table, null);
      await clientA.query("COMMIT");
    } catch (err) {
      await clientA.query("ROLLBACK");
      throw err;
    } finally {
      clientA.release();
    }

    // Try to fetch it as tenant B — must return null (RLS + explicit WHERE)
    const clientB = await appPool.connect();
    let fetchedByB;
    try {
      await clientB.query("BEGIN");
      await clientB.query(`SET LOCAL choros.tenant_id = '${tenantB}'`);
      await clientB.query("SET LOCAL search_path TO choros");
      fetchedByB = await getRuleTableById(clientB, tenantB, insertedId);
      await clientB.query("COMMIT");
    } catch (err) {
      await clientB.query("ROLLBACK");
      throw err;
    } finally {
      clientB.release();
    }

    expect(fetchedByB).toBeNull();
  }, 30_000);

  // -------------------------------------------------------------------------
  // listRuleTables includes drafts and filters by processKey.
  // -------------------------------------------------------------------------

  it("listRuleTables returns draft rows and filters by processKey", async () => {
    const tenantId = uuid();
    await seedTenant(tenantId);

    const globalId = uuid();
    const scopedId = uuid();
    const otherKeyId = uuid();
    const processKey = `proc-${tenantId.slice(0, 8)}`;

    // Insert 3 tables: global, scoped to processKey, scoped to another key
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await client.query("SET LOCAL search_path TO choros");
      await upsertRuleTableDraft(client, tenantId, makeTable(globalId), null);
      await upsertRuleTableDraft(client, tenantId, makeTable(scopedId), processKey);
      await upsertRuleTableDraft(client, tenantId, makeTable(otherKeyId), "other-proc");
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // List all (no processKey filter) — should return all 3
    const client2 = await appPool.connect();
    let allRows;
    try {
      await client2.query("BEGIN");
      await client2.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await client2.query("SET LOCAL search_path TO choros");
      allRows = await listRuleTables(client2, tenantId);
      await client2.query("COMMIT");
    } catch (err) {
      await client2.query("ROLLBACK");
      throw err;
    } finally {
      client2.release();
    }

    expect(allRows.length).toBeGreaterThanOrEqual(3);

    // List filtered by processKey — should return global (NULL) + scoped, not other-proc
    const client3 = await appPool.connect();
    let filteredRows;
    try {
      await client3.query("BEGIN");
      await client3.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await client3.query("SET LOCAL search_path TO choros");
      filteredRows = await listRuleTables(client3, tenantId, processKey);
      await client3.query("COMMIT");
    } catch (err) {
      await client3.query("ROLLBACK");
      throw err;
    } finally {
      client3.release();
    }

    const ids = filteredRows.map((r) => r.id);
    expect(ids).toContain(globalId);
    expect(ids).toContain(scopedId);
    expect(ids).not.toContain(otherKeyId);

    // All returned rows are drafts (we never called publish)
    for (const row of filteredRows) {
      expect(row.status).toBe("draft");
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // publishRuleTable returns false for non-existent id.
  // -------------------------------------------------------------------------

  it("publishRuleTable returns false for a non-existent id", async () => {
    const tenantId = uuid();
    await seedTenant(tenantId);

    const ghostId = uuid();
    const client = await appPool.connect();
    let result: boolean;
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await client.query("SET LOCAL search_path TO choros");
      result = await publishRuleTable(client, tenantId, ghostId);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    expect(result).toBe(false);
  }, 30_000);
});

} // end DATABASE_URL guard
