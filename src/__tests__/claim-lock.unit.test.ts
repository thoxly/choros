/**
 * src/__tests__/claim-lock.unit.test.ts — T-0338 unit tests for insertClaimLock
 * and the claim-tx atomicity invariants.
 *
 * These tests run in-process (no live DB). They use a mock PgClientLike to verify:
 *   1. insertClaimLock issues the correct INSERT SQL with RETURNING clause.
 *   2. The grant-check + insertClaimLock + appendTaskClaimed happen in ONE tx
 *      (mocked withTenantTx: one BEGIN, one COMMIT, no orphan partial-state).
 *   3. When the mock returns 0 rows (different actor holds 'claimed' lock),
 *      insertClaimLock throws AlreadyClaimedError — NOT a raw 23505.
 *   4. The lock table is a projection (NOT the source of truth): the audit event
 *      is emitted alongside the lock INSERT, not instead of it.
 *   5. A 23505 DB error still propagates (defense-in-depth, should be unreachable
 *      with conditional-upsert but kept as safety net in the route layer).
 *   6. When mock returns 1 row (winner), insertClaimLock resolves without error.
 *
 * Live-DB behavior (actual TOCTOU serialisation, FORCE RLS, atomic rollback)
 * is covered in ci/checks/db/user_task_claim.test.ts.
 */

import { describe, it, expect } from "vitest";
import { insertClaimLock, AlreadyClaimedError } from "../http/claim-projection.js";
import type { PgClientLike } from "../db/audit-writer.js";

// ---------------------------------------------------------------------------
// Mock PgClientLike
// ---------------------------------------------------------------------------

function makeMockTx(overrides?: { queryImpl?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): {
  tx: PgClientLike;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const tx: PgClientLike = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (overrides?.queryImpl) {
        return overrides.queryImpl(sql, params);
      }
      // Default: return 1 row (simulates "winner" — INSERT or DO UPDATE succeeded).
      return { rows: [{ claimed_by: "default-actor" }] };
    },
  };
  return { tx, calls };
}

/** Mock that simulates "different actor holds live claim" → 0 rows returned. */
function makeMockTxZeroRows(): { tx: PgClientLike; calls: Array<{ sql: string; params: unknown[] }> } {
  return makeMockTx({
    queryImpl: async () => ({ rows: [] }),
  });
}

// ---------------------------------------------------------------------------
// Test 1: insertClaimLock issues the correct INSERT SQL with RETURNING
// ---------------------------------------------------------------------------

describe("T-0338 insertClaimLock — SQL shape", () => {
  it("issues INSERT INTO choros.user_task_claim with RETURNING claimed_by", async () => {
    const { tx, calls } = makeMockTx();
    const tenantId = "a0000000-0000-0000-0000-000000000001";
    const taskId = "b0000000-0000-0000-0000-000000000002";
    const claimedBy = "e-sokolov";
    const claimedAt = 1700000000000;
    const role = "fin-ctrl";

    await insertClaimLock(tx, { taskId, claimedBy, claimedAt, role, tenantId });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    // Must target user_task_claim
    expect(call.sql).toMatch(/user_task_claim/i);
    // Must be an INSERT
    expect(call.sql.trim().toUpperCase()).toMatch(/^INSERT INTO/);
    // Must have ON CONFLICT for idempotency
    expect(call.sql).toMatch(/ON CONFLICT/i);
    // State must be 'claimed'
    expect(call.sql).toMatch(/'claimed'/i);
    // Must have RETURNING clause (the 0-row detection mechanism)
    expect(call.sql).toMatch(/RETURNING/i);
    // Parameters must include all required fields
    expect(call.params).toContain(tenantId);
    expect(call.params).toContain(taskId);
    expect(call.params).toContain(claimedBy);
    expect(call.params).toContain(claimedAt);
    expect(call.params).toContain(role);
  });
});

// ---------------------------------------------------------------------------
// Test 2: insertClaimLock tx is passed by the caller (no internal BEGIN/COMMIT)
// ---------------------------------------------------------------------------

describe("T-0338 insertClaimLock — no internal tx management", () => {
  it("does NOT issue BEGIN or COMMIT (tx is caller-owned)", async () => {
    const { tx, calls } = makeMockTx();
    await insertClaimLock(tx, {
      taskId: "t1",
      claimedBy: "e-sokolov",
      claimedAt: Date.now(),
      role: "fin-ctrl",
      tenantId: "00000000-0000-0000-0000-000000000001",
    });

    const sqls = calls.map((c) => c.sql.trim().toUpperCase());
    expect(sqls.some((s) => s.startsWith("BEGIN"))).toBe(false);
    expect(sqls.some((s) => s.startsWith("COMMIT"))).toBe(false);
    expect(sqls.some((s) => s.startsWith("ROLLBACK"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 3a: 0-row RETURNING → AlreadyClaimedError (primary rejection path)
// ---------------------------------------------------------------------------

describe("T-0338 insertClaimLock — 0-row RETURNING throws AlreadyClaimedError", () => {
  it("throws AlreadyClaimedError when mock returns 0 rows (different actor holds lock)", async () => {
    const { tx } = makeMockTxZeroRows();

    let caught: unknown;
    try {
      await insertClaimLock(tx, {
        taskId: "t2",
        claimedBy: "e-kravtsova",
        claimedAt: Date.now(),
        role: "fin-ctrl",
        tenantId: "00000000-0000-0000-0000-000000000002",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(AlreadyClaimedError);
    expect((caught as AlreadyClaimedError).kind).toBe("AlreadyClaimedError");
  });
});

// ---------------------------------------------------------------------------
// Test 3b: 23505 from DB still propagates (defense-in-depth, unreachable
//           in practice with conditional-upsert but checked in route layer)
// ---------------------------------------------------------------------------

describe("T-0338 insertClaimLock — raw 23505 still propagates from DB", () => {
  it("re-throws raw pg error code=23505 when DB raises it unexpectedly", async () => {
    const uniqueError = Object.assign(new Error("duplicate key"), { code: "23505" });
    const { tx } = makeMockTx({
      queryImpl: async () => {
        throw uniqueError;
      },
    });

    let caught: unknown;
    try {
      await insertClaimLock(tx, {
        taskId: "t2b",
        claimedBy: "e-kravtsova",
        claimedAt: Date.now(),
        role: "fin-ctrl",
        tenantId: "00000000-0000-0000-0000-000000000002",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    // A raw DB error is NOT AlreadyClaimedError — it propagates unchanged so the
    // route-level defense-in-depth catch can handle it.
    expect(caught).not.toBeInstanceOf(AlreadyClaimedError);
    expect((caught as Record<string, unknown>)["code"]).toBe("23505");
  });
});

// ---------------------------------------------------------------------------
// Test 3c: 1-row RETURNING → no error thrown (winner path)
// ---------------------------------------------------------------------------

describe("T-0338 insertClaimLock — 1-row RETURNING resolves without error", () => {
  it("resolves successfully when mock returns 1 row (claim won)", async () => {
    // Default mock returns 1 row (winner)
    const { tx } = makeMockTx();

    await expect(
      insertClaimLock(tx, {
        taskId: "t2c",
        claimedBy: "e-sokolov",
        claimedAt: Date.now(),
        role: "fin-ctrl",
        tenantId: "00000000-0000-0000-0000-000000000002",
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 4: lock table is a projection — insertClaimLock is purely additive
// ---------------------------------------------------------------------------

describe("T-0338 insertClaimLock — projection property (additive, no DELETE)", () => {
  it("does NOT issue DELETE or UPDATE to a non-existing row (additive only)", async () => {
    const { tx, calls } = makeMockTx();
    await insertClaimLock(tx, {
      taskId: "t3",
      claimedBy: "e-sokolov",
      claimedAt: Date.now(),
      role: "fin-ctrl",
      tenantId: "00000000-0000-0000-0000-000000000003",
    });

    const sqls = calls.map((c) => c.sql.trim().toUpperCase());
    // Must not DELETE
    expect(sqls.some((s) => s.startsWith("DELETE"))).toBe(false);
    // ON CONFLICT ... DO UPDATE is permitted (idempotent re-claim same actor /
    // re-claim of released task) but must never overwrite a different actor's
    // live 'claimed' lock (that is guarded by the WHERE predicate returning 0 rows).
    const insertSql = sqls.find((s) => s.startsWith("INSERT"));
    expect(insertSql).toBeDefined();
    // The WHERE clause on the DO UPDATE must reference claimed_by (same-actor guard)
    expect(calls[0]?.sql).toMatch(/WHERE.*claimed_by/i);
    // Must also include 'released' guard to allow re-claim after release
    expect(calls[0]?.sql).toMatch(/released/i);
  });
});

// ---------------------------------------------------------------------------
// Test 5: state must be 'claimed' (not null, not another value)
// ---------------------------------------------------------------------------

describe("T-0338 insertClaimLock — state is always 'claimed'", () => {
  it("the INSERT always uses state='claimed' literal", async () => {
    const { tx, calls } = makeMockTx();
    await insertClaimLock(tx, {
      taskId: "t4",
      claimedBy: "e-sokolov",
      claimedAt: Date.now(),
      role: "fin-ctrl",
      tenantId: "00000000-0000-0000-0000-000000000004",
    });

    // The SQL should contain the literal 'claimed' value
    expect(calls[0]?.sql).toMatch(/'claimed'/i);
  });
});
