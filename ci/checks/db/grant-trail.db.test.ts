/**
 * T-0031: Live Postgres tests for queryGrantTrail.
 *
 * Covers AC-19 (RLS / withTenant), AC-20 (type IN filter).
 * Only runs in the db CI job (requires DATABASE_URL + live Postgres with migrations).
 *
 * Strategy:
 *   - All INSERTs use migratorUrl() (choros_migrator — bypasses RLS).
 *   - queryGrantTrail probes use appUrl() (choros_app — NOBYPASSRLS, proves isolation).
 *   - Cleanup is implicit (unique seq per test run via large random offset).
 */

import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import { appUrl, migratorUrl, withClient, TENANT_A, TENANT_B, uuid } from "./_helpers.js";
import { queryGrantTrail } from "../../../src/db/audit-grant-trail.js";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Seed helpers — insert audit_event rows via migrator (bypasses RLS).
// ---------------------------------------------------------------------------

/**
 * seedAuditEvents — insert a batch of audit_event rows for a given tenant.
 * seq values are unique per test invocation (random large offset).
 */
async function seedAuditEvents(
  c: pg.Client,
  tenantId: string,
  rows: Array<{
    seq: number;
    id: string;
    type: string;
    actor: string;
    subject?: string | null;
    payload?: Record<string, unknown>;
    proposedBy?: string | null;
    confirmedBy?: string | null;
  }>,
): Promise<void> {
  for (const row of rows) {
    await c.query(
      `INSERT INTO choros.audit_event
         (tenant_id, seq, id, type, actor, subject, payload, proposed_by, confirmed_by,
          occurred_at, prev_hash, row_hash, vocab_version)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10,
          '\\x00'::bytea, '\\x01'::bytea, 1)
       ON CONFLICT (tenant_id, seq) DO NOTHING`,
      [
        tenantId,
        row.seq,
        row.id,
        row.type,
        row.actor,
        row.subject ?? null,
        JSON.stringify(row.payload ?? {}),
        row.proposedBy ?? null,
        row.confirmedBy ?? null,
        Date.now(),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("queryGrantTrail — live Postgres", () => {
  // Skip if DATABASE_URL is not set (CI unit-only path).
  if (!process.env["DATABASE_URL"]) {
    it.skip("DATABASE_URL not set — skipping live DB tests", () => {});
    return;
  }

  // App pool (choros_app role — NOBYPASSRLS)
  let appPool: pg.Pool;

  // Unique sequence offset to avoid collisions with other test runs.
  const SEQ_BASE = Math.floor(Math.random() * 9_000_000) + 1_000_000;

  beforeAll(async () => {
    appPool = new Pool({ connectionString: appUrl() });

    // Seed audit_head rows for both tenants (required by the GUC pattern).
    await withClient(migratorUrl(), async (c) => {
      // Ensure tenant rows exist (idempotent).
      for (const tenantId of [TENANT_A, TENANT_B]) {
        const tenantSlug = `ct-trail-${tenantId.slice(0, 8)}`;
        await c.query(
          `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
           VALUES ($1, $1, $2, $2, 0)
           ON CONFLICT DO NOTHING`,
          [tenantId, tenantSlug],
        );
        await c.query(
          `INSERT INTO choros.audit_head (tenant_id, seq, row_hash, updated_at, vocab_version)
           VALUES ($1, 0, '\\x00'::bytea, 0, 1)
           ON CONFLICT DO NOTHING`,
          [tenantId],
        );
      }

      // Seed rows for TENANT_A: two grant-family rows + one non-grant row
      await seedAuditEvents(c, TENANT_A, [
        {
          seq: SEQ_BASE + 1,
          id: uuid(),
          type: "grant.create",
          actor: "admin-a",
          subject: "role-x",
          payload: { resourceType: "record", operation: "read" },
          proposedBy: "llm",
          confirmedBy: "admin-a",
        },
        {
          seq: SEQ_BASE + 2,
          id: uuid(),
          type: "assignment.create",
          actor: "admin-a",
          subject: "emp-1",
          payload: { roleId: "role-x" },
        },
        {
          seq: SEQ_BASE + 3,
          id: uuid(),
          type: "approve", // NOT a grant-family type — must NOT appear in trail
          actor: "admin-a",
          subject: null,
          payload: { info: "non-grant" },
        },
        {
          seq: SEQ_BASE + 4,
          id: uuid(),
          type: "grant.revoke",
          actor: "admin-a",
          subject: "role-y",
          payload: { resourceType: "record", operation: "write" },
        },
      ]);

      // Seed rows for TENANT_B: one grant-family row (must NOT appear in TENANT_A query)
      await seedAuditEvents(c, TENANT_B, [
        {
          seq: SEQ_BASE + 10,
          id: uuid(),
          type: "grant.create",
          actor: "admin-b",
          subject: "role-b",
          payload: { resourceType: "registry", operation: "read" },
        },
      ]);
    });
  });

  // AC-19: cross-tenant isolation — TENANT_A query does not return TENANT_B rows
  it("AC-19: TENANT_A trail does not include TENANT_B rows", async () => {
    const result = await queryGrantTrail(appPool, TENANT_A, { limit: 500 });
    for (const row of result.rows) {
      // All rows from TENANT_B have actor "admin-b"; none should appear
      expect(row.actor).not.toBe("admin-b");
      expect(row.subject).not.toBe("role-b");
    }
  });

  it("AC-19: TENANT_B trail does not include TENANT_A rows", async () => {
    const result = await queryGrantTrail(appPool, TENANT_B, { limit: 500 });
    for (const row of result.rows) {
      expect(row.actor).not.toBe("admin-a");
    }
  });

  // AC-20: type IN filter — the 'approve' row must NOT appear in trail
  it("AC-20: queryGrantTrail only returns grant-family event types", async () => {
    const result = await queryGrantTrail(appPool, TENANT_A, { limit: 500 });
    const ALLOWED = new Set(["grant.create", "grant.revoke", "assignment.create", "assignment.revoke"]);
    // Filter to our seeded rows only (by seq range)
    const seededRows = result.rows.filter(
      (r) => r.seq >= SEQ_BASE && r.seq <= SEQ_BASE + 100,
    );
    expect(seededRows.length).toBeGreaterThan(0);
    for (const row of seededRows) {
      expect(ALLOWED.has(row.type)).toBe(true);
    }
    // Confirm the 'approve' row is absent
    const hasApproveRow = seededRows.some((r) => r.type === "approve");
    expect(hasApproveRow).toBe(false);
  });

  // cursor pagination probe (>= 100+ events simulation)
  it("negative probe — cursor pagination: no duplicates or gaps over boundary", async () => {
    // Use a per-run-unique actor slug so the probe is idempotent on a persistent DB.
    // Without scoping to SEQ_BASE the actor='page-actor' query would accumulate rows
    // from previous runs and break the expect(uniqueIds.size).toBe(5) assertion.
    // Fix: R-1 (review finding) — per-run actor slug scoped to SEQ_BASE.
    const PAGE_ACTOR = `page-actor-${SEQ_BASE}`;

    // Seed 5 more rows and paginate them in pages of 2
    await withClient(migratorUrl(), async (c) => {
      await seedAuditEvents(c, TENANT_A, [
        { seq: SEQ_BASE + 20, id: uuid(), type: "grant.create", actor: PAGE_ACTOR, subject: "r1", payload: {} },
        { seq: SEQ_BASE + 21, id: uuid(), type: "grant.create", actor: PAGE_ACTOR, subject: "r2", payload: {} },
        { seq: SEQ_BASE + 22, id: uuid(), type: "grant.create", actor: PAGE_ACTOR, subject: "r3", payload: {} },
        { seq: SEQ_BASE + 23, id: uuid(), type: "grant.create", actor: PAGE_ACTOR, subject: "r4", payload: {} },
        { seq: SEQ_BASE + 24, id: uuid(), type: "grant.create", actor: PAGE_ACTOR, subject: "r5", payload: {} },
      ]);
    });

    // Paginate: page1 = limit 2, page2 = limit 2 with beforeSeq from page1.
    const page1 = await queryGrantTrail(appPool, TENANT_A, {
      actor: PAGE_ACTOR,
      limit: 2,
    });
    expect(page1.rows.length).toBe(2);
    expect(page1.hasMore).toBe(true);

    const minSeq1 = Math.min(...page1.rows.map((r) => r.seq));
    const page2 = await queryGrantTrail(appPool, TENANT_A, {
      actor: PAGE_ACTOR,
      limit: 2,
      beforeSeq: minSeq1,
    });

    // No row from page1 should appear in page2
    const page1Ids = new Set(page1.rows.map((r) => r.id));
    for (const row of page2.rows) {
      expect(page1Ids.has(row.id)).toBe(false);
    }

    // Collect all rows (page1 + page2 + rest)
    const allCollected: typeof page1.rows = [...page1.rows, ...page2.rows];
    let cursor = page2;
    while (cursor.hasMore && cursor.rows.length > 0) {
      const minSeq = Math.min(...cursor.rows.map((r) => r.seq));
      cursor = await queryGrantTrail(appPool, TENANT_A, {
        actor: PAGE_ACTOR,
        limit: 2,
        beforeSeq: minSeq,
      });
      allCollected.push(...cursor.rows);
    }

    // All 5 rows should be collected exactly once (no duplicates)
    const idsFromPageActor = allCollected
      .filter((r) => r.actor === PAGE_ACTOR)
      .map((r) => r.id);
    const uniqueIds = new Set(idsFromPageActor);
    expect(uniqueIds.size).toBe(idsFromPageActor.length); // no duplicates
    expect(uniqueIds.size).toBe(5); // all 5 rows present
  });
});
