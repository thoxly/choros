/**
 * T-0184 · Pool-role fitness test for queryGrantTrail.
 *
 * AC-2: Cross-tenant isolation via migrator pool (BYPASSRLS).
 * AC-3: SELF-TEST — demonstrates that a raw SELECT without WHERE tenant_id
 *       DOES return cross-tenant rows, proving the explicit WHERE is load-bearing.
 *
 * Strategy:
 *   - All INSERTs use migratorUrl() (choros_migrator — BYPASSRLS).
 *   - queryGrantTrail probes use migratorUrl() pool — this is the runtime role
 *     gap documented in T-0141 R-1 §1c. The existing grant-trail.db.test.ts
 *     uses appUrl() (NOBYPASSRLS), which does NOT exercise the migrator pool path.
 *   - Self-test: raw SELECT without WHERE tenant_id via migratorUrl() proves the
 *     migrator role sees all rows — confirming the explicit WHERE is the only guard.
 *
 * Discipline (T-0087): every SET LOCAL must be preceded by BEGIN.
 * Note: audit_event is append-only (no DELETE trigger). Test rows are isolated
 * by unique RUN_TAG actor prefix and random SEQ_BASE; they do not affect other tests.
 */

import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import {
  migratorUrl,
  withClient,
  TENANT_A,
  TENANT_B,
  uuid,
} from "./_helpers.js";
import { queryGrantTrail } from "../../../src/db/audit-grant-trail.js";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Skip guard — graceful skip when DATABASE_URL is absent (NF-4).
// ---------------------------------------------------------------------------
const HAS_DB = Boolean(process.env["DATABASE_URL"]);

// ---------------------------------------------------------------------------
// Stable test identifiers — unique per run to avoid collision with other tests.
// ---------------------------------------------------------------------------
const RUN_TAG = `t0184-pool-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
const SEQ_BASE = Math.floor(Math.random() * 8_000_000) + 1_000_000;

// ---------------------------------------------------------------------------
// Seed helper: plant one grant.create audit_event row for a given tenant.
// Uses BEGIN + INSERT + COMMIT (T-0087 discipline).
// ---------------------------------------------------------------------------
async function seedGrantEvent(
  c: pg.Client,
  tenantId: string,
  seq: number,
  actor: string,
): Promise<string> {
  const id = uuid();
  // T-0087: BEGIN must precede SET LOCAL (not needed here — plain INSERT with
  // explicit tenant_id column; BEGIN/COMMIT still wraps for transactional cleanliness).
  await c.query("BEGIN");
  await c.query(
    `INSERT INTO choros.audit_event
       (tenant_id, seq, id, type, actor, subject, payload, occurred_at,
        prev_hash, row_hash, vocab_version)
     VALUES ($1, $2, $3, 'grant.create', $4, NULL, '{"t0184":true}'::jsonb, $5,
             '\\x00'::bytea, '\\x01'::bytea, 1)
     ON CONFLICT (tenant_id, seq) DO NOTHING`,
    [tenantId, seq, id, actor, Date.now()],
  );
  await c.query("COMMIT");
  return id;
}

/** Ensure tenant row exists (idempotent). */
async function ensureTenant(c: pg.Client, tenantId: string): Promise<void> {
  const slug = `t0184-tenant-${tenantId.slice(0, 8)}`;
  await c.query("BEGIN");
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, slug],
  );
  await c.query("COMMIT");
}

/** Ensure audit_head row exists (idempotent). */
async function ensureAuditHead(c: pg.Client, tenantId: string): Promise<void> {
  await c.query("BEGIN");
  await c.query(
    `INSERT INTO choros.audit_head (tenant_id, seq, row_hash, updated_at, vocab_version)
     VALUES ($1, 0, '\\x00'::bytea, 0, 1)
     ON CONFLICT DO NOTHING`,
    [tenantId],
  );
  await c.query("COMMIT");
}

// ---------------------------------------------------------------------------
// Actors used in seeds (unique per run via RUN_TAG prefix).
// ---------------------------------------------------------------------------
const ACTOR_A = `${RUN_TAG}-tenant-a`;
const ACTOR_B = `${RUN_TAG}-tenant-b`;

// ---------------------------------------------------------------------------
// Global setup + teardown.
// ---------------------------------------------------------------------------
beforeAll(async () => {
  if (!HAS_DB) return;

  await withClient(migratorUrl(), async (c) => {
    await ensureTenant(c, TENANT_A);
    await ensureTenant(c, TENANT_B);
    await ensureAuditHead(c, TENANT_A);
    await ensureAuditHead(c, TENANT_B);

    // Plant TENANT_A rows.
    await seedGrantEvent(c, TENANT_A, SEQ_BASE + 1, ACTOR_A);
    await seedGrantEvent(c, TENANT_A, SEQ_BASE + 2, ACTOR_A);

    // Plant TENANT_B row (the row that must NOT leak into TENANT_A query).
    await seedGrantEvent(c, TENANT_B, SEQ_BASE + 10, ACTOR_B);
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T-0184 · grant-trail pool-role fitness (migratorUrl = BYPASSRLS)", () => {
  if (!HAS_DB) {
    it.skip("DATABASE_URL not set — skipping DB-gated pool-role fitness test", () => {});
    return;
  }

  // AC-2: queryGrantTrail via migrator pool — must return only TENANT_A rows.
  //
  // Two-pass strategy:
  //   Pass A (actor filter): queryGrantTrail(TENANT_A, actor=ACTOR_A) must return
  //     our seeded rows and zero ACTOR_B rows — proves isolation at the seeded-row level.
  //   Pass B (isolation probe): queryGrantTrail(TENANT_A, actor=ACTOR_B) must return
  //     zero rows — ACTOR_B rows exist in the DB (TENANT_B) but must never be visible
  //     in a TENANT_A context query.
  it("AC-2: queryGrantTrail(migratorPool, TENANT_A) returns zero TENANT_B rows", async () => {
    const migratorPool = new Pool({ connectionString: migratorUrl() });
    try {
      // Pass A: query scoped to ACTOR_A — should find our seeded TENANT_A rows.
      const resultA = await queryGrantTrail(migratorPool, TENANT_A, {
        actor: ACTOR_A,
        limit: 500,
      });

      // Sanity: our seeded TENANT_A rows must appear (proves the query works).
      expect(
        resultA.rows.length,
        `Expected at least 1 seeded TENANT_A row (actor=${ACTOR_A}); got 0. ` +
          `Seed may have failed or rows fell outside query window.`,
      ).toBeGreaterThanOrEqual(1);

      // None of the TENANT_A results may have actor ACTOR_B.
      const spuriousBRowsA = resultA.rows.filter((r) => r.actor === ACTOR_B);
      expect(
        spuriousBRowsA.length,
        `Pass A: Found TENANT_B rows (actor=${ACTOR_B}) in TENANT_A actor-filtered query`,
      ).toBe(0);

      // Pass B: query scoped to ACTOR_B — must return zero rows from TENANT_A context.
      // ACTOR_B rows exist in the DB under TENANT_B, but must not be visible here.
      const resultB = await queryGrantTrail(migratorPool, TENANT_A, {
        actor: ACTOR_B,
        limit: 500,
      });
      expect(
        resultB.rows.length,
        `Pass B: Found ${resultB.rows.length} row(s) with actor=${ACTOR_B} in TENANT_A context — cross-tenant leak`,
      ).toBe(0);
    } finally {
      await migratorPool.end();
    }
  });

  // SELF-TEST (AC-3): raw SELECT without WHERE tenant_id via migrator pool
  // MUST be able to return TENANT_B rows — proving the BYPASSRLS role bypasses
  // RLS and that the explicit WHERE tenant_id in queryGrantTrail is load-bearing.
  it("AC-3 SELF-TEST: raw SELECT without WHERE tenant_id via migratorUrl sees TENANT_B rows", async () => {
    // This test proves the fix is non-decorative: without the WHERE clause,
    // TENANT_B rows are visible from within a TENANT_A withTenant() context.
    // If this test FAILS (0 rows), it means the seeded TENANT_B row is missing
    // or the migrator role has lost BYPASSRLS — the fixture is broken, not the fix.
    const migratorPool = new Pool({ connectionString: migratorUrl() });
    try {
      let rawTenantBCount = 0;

      // Use withClient to bypass withTenant() — we want to see ALL rows without
      // tenant_id scoping to simulate a buggy (pre-fix) query path.
      await withClient(migratorUrl(), async (c) => {
        // T-0087 discipline: BEGIN before SET LOCAL.
        await c.query("BEGIN");
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
        await c.query("SET LOCAL search_path TO choros");

        // Raw probe: omit WHERE tenant_id intentionally — simulates the pre-fix path.
        const { rows } = await c.query<{ actor: string }>(
          `SELECT actor FROM choros.audit_event
           WHERE type = 'grant.create' AND actor LIKE $1`,
          [`${RUN_TAG}%`],
        );
        await c.query("COMMIT");

        rawTenantBCount = rows.filter((r) => r.actor === ACTOR_B).length;
      });

      expect(
        rawTenantBCount,
        `SELF-TEST: raw SELECT (no WHERE tenant_id) must see at least 1 TENANT_B row ` +
          `via choros_migrator (BYPASSRLS). Got 0 — either seed is missing or ` +
          `the migrator role lost BYPASSRLS privilege (fixture broken).`,
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await migratorPool.end();
    }
  });
});
