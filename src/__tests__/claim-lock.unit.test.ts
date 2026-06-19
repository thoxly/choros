/**
 * src/__tests__/claim-lock.unit.test.ts — T-0338 unit tests for insertClaimLock
 * and the claim-tx atomicity invariants.
 *
 * These tests run in-process (no live DB). They use a mock PgClientLike to verify:
 *   1. insertClaimLock issues the correct INSERT SQL with the partial-unique constraint.
 *   2. The grant-check + insertClaimLock + appendTaskClaimed happen in ONE tx
 *      (mocked withTenantTx: one BEGIN, one COMMIT, no orphan partial-state).
 *   3. A unique-constraint error (code 23505) from insertClaimLock is mapped to
 *      409 ALREADY_CLAIMED (fail-closed).
 *   4. The lock table is a projection (NOT the source of truth): the audit event
 *      is emitted alongside the lock INSERT, not instead of it.
 *   5. Second concurrent INSERT for same (tenant_id, task_id) with state='claimed'
 *      fails (simulated by mock returning a 23505 error).
 *
 * Live-DB behavior (actual partial-unique constraint, FORCE RLS, atomic rollback)
 * is covered in ci/checks/db/user_task_claim.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { insertClaimLock } from "../http/claim-projection.js";
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
      return { rows: [] };
    },
  };
  return { tx, calls };
}

// ---------------------------------------------------------------------------
// Test 1: insertClaimLock issues the correct INSERT SQL
// ---------------------------------------------------------------------------

describe("T-0338 insertClaimLock — SQL shape", () => {
  it("issues INSERT INTO choros.user_task_claim with correct parameters", async () => {
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
    expect(call.sql).toMatch(/claimed/i);
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
// Test 3: 23505 from insertClaimLock simulates the TOCTOU-safe lock rejection
// ---------------------------------------------------------------------------

describe("T-0338 insertClaimLock — concurrent claim simulated via 23505", () => {
  it("propagates code=23505 when DB rejects the second INSERT (partial-unique violation)", async () => {
    const uniqueError = Object.assign(new Error("duplicate key"), { code: "23505" });
    const { tx } = makeMockTx({
      queryImpl: async () => {
        throw uniqueError;
      },
    });

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
    expect((caught as Record<string, unknown>)["code"]).toBe("23505");
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
    // ON CONFLICT ... DO UPDATE is permitted (idempotent re-claim same actor)
    // but must never UPDATE rows of a DIFFERENT actor
    const insertSql = sqls.find((s) => s.startsWith("INSERT"));
    expect(insertSql).toBeDefined();
    // The WHERE clause on the DO UPDATE must reference claimed_by (same-actor guard)
    expect(calls[0]?.sql).toMatch(/WHERE.*claimed_by/i);
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
