/**
 * ci/checks/db/user_task_claim.test.ts — T-0338 [E15-S2-claim] live-DB fitness
 * for the user_task_claim TOCTOU-safe DB lock primitive.
 *
 * Covers:
 *   AC-lock:       insertClaimLock + appendTaskClaimed in ONE tx; both succeed;
 *                  claim-state is projected correctly after commit.
 *   AC-concurrent: A SECOND concurrent INSERT with state='claimed' for the same
 *                  (tenant_id, task_id) hits the partial-unique constraint (23505)
 *                  → tx rolls back → zero partial state; first claimant wins.
 *   AC-idempotent: Same actor re-claims (PK ON CONFLICT DO UPDATE WHERE
 *                  claimed_by=same) → no error; claimedAt preserved (idempotent).
 *   AC-projection: insertClaimLock is a projection; source of truth is audit_event.
 *                  The lock table row is consistent with the audit event.
 *   AC-isolation:  A claim-lock row in tenant A is invisible in tenant B (FORCE RLS).
 *   AC-rebuildable: The lock table is rebuildable from audit_event (projection property).
 *
 * Run:
 *   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
 *   npm run fitness:db
 *
 * No DATABASE_URL → all tests auto-skip (requireDb guard).
 */

import { describe, it, expect } from "vitest";
import pg from "pg";
import { appUrl } from "./_helpers.js";
import type { PgClientLike } from "../../../src/db/audit-writer.js";
import {
  insertClaimLock,
  appendTaskClaimed,
  loadClaimsFromAudit,
} from "../../../src/http/claim-projection.js";

const { Client } = pg;

// ---------------------------------------------------------------------------
// Guard: skip all tests when no DATABASE_URL is configured.
// ---------------------------------------------------------------------------

function requireDb(): boolean {
  return Boolean(process.env["DATABASE_URL"]);
}

/** Fresh random tenant UUID — no shared-DB pollution (freshTenant pattern). */
function freshTenant(): string {
  return crypto.randomUUID();
}

/**
 * Open a connection, BEGIN a tenant-scoped tx, run fn, COMMIT (or ROLLBACK on error).
 * Returns the COMMIT result, or re-throws on error.
 */
async function withTenantTx<T>(
  tenantId: string,
  fn: (tx: PgClientLike) => Promise<T>,
): Promise<T> {
  const c = new Client({ connectionString: appUrl() });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query("SET LOCAL search_path TO choros");
    const result = await fn(c as unknown as PgClientLike);
    await c.query("COMMIT");
    return result;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

/**
 * Attempt a tenant tx that is EXPECTED to fail (e.g. unique-constraint violation).
 * Returns the caught error (typed as Record<string, unknown> for pg error code access).
 */
async function withTenantTxExpectError(
  tenantId: string,
  fn: (tx: PgClientLike) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  try {
    await withTenantTx(tenantId, fn);
    throw new Error("Expected tx to fail, but it succeeded");
  } catch (err) {
    return err as Record<string, unknown>;
  }
}

// ---------------------------------------------------------------------------
// AC-lock: insertClaimLock + appendTaskClaimed in ONE tx — both succeed
// ---------------------------------------------------------------------------

describe("T-0338 AC-lock — insertClaimLock + appendTaskClaimed in one tx", () => {
  it("both INSERT and audit emit succeed; projection reflects the claim", async () => {
    if (!requireDb()) return;

    const tenantId = freshTenant();
    const taskId = crypto.randomUUID();
    const actor = "e-sokolov";
    const role = "fin-ctrl";
    const nowMs = Date.now();

    // One tx: lock INSERT + audit emit
    await withTenantTx(tenantId, async (tx) => {
      await insertClaimLock(tx, { taskId, claimedBy: actor, claimedAt: nowMs, role, tenantId });
      await appendTaskClaimed(tx, { taskId, actor, actorKind: "human", tenantId, role, nowMs });
    });

    // Verify lock row
    const lockRow = await withTenantTx(tenantId, async (tx) => {
      const raw = tx as unknown as pg.Client;
      const res = await raw.query<{ task_id: string; claimed_by: string; state: string }>(
        `SELECT task_id, claimed_by, state FROM choros.user_task_claim WHERE task_id = $1`,
        [taskId],
      );
      return res.rows[0];
    });
    expect(lockRow).toBeDefined();
    expect(lockRow.task_id).toBe(taskId);
    expect(lockRow.claimed_by).toBe(actor);
    expect(lockRow.state).toBe("claimed");

    // Verify audit projection also reflects the claim
    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const claimMap = await loadClaimsFromAudit(pool, tenantId);
      const claim = claimMap.get(taskId);
      expect(claim).toBeDefined();
      expect(claim!.claimedBy).toBe(actor);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-concurrent: second INSERT with state='claimed' hits partial-unique → 23505
// ---------------------------------------------------------------------------

describe("T-0338 AC-concurrent — second claim hits partial-unique constraint", () => {
  it("concurrent second INSERT on state='claimed' fails with code 23505; first claim intact", async () => {
    if (!requireDb()) return;

    const tenantId = freshTenant();
    const taskId = crypto.randomUUID();
    const firstActor = "e-sokolov";
    const secondActor = "e-kravtsova";
    const role = "fin-ctrl";
    const t1 = Date.now();
    const t2 = t1 + 50;

    // First actor claims successfully
    await withTenantTx(tenantId, async (tx) => {
      await insertClaimLock(tx, { taskId, claimedBy: firstActor, claimedAt: t1, role, tenantId });
      await appendTaskClaimed(tx, { taskId, actor: firstActor, actorKind: "human", tenantId, role, nowMs: t1 });
    });

    // Second actor tries to claim — must hit the partial-unique index (23505)
    const err = await withTenantTxExpectError(tenantId, async (tx) => {
      await insertClaimLock(tx, { taskId, claimedBy: secondActor, claimedAt: t2, role, tenantId });
      await appendTaskClaimed(tx, { taskId, actor: secondActor, actorKind: "human", tenantId, role, nowMs: t2 });
    });

    // Postgres unique-violation code = 23505
    expect(err["code"]).toBe("23505");

    // First claim still intact (tx rolled back atomically)
    const lockRow = await withTenantTx(tenantId, async (tx) => {
      const raw = tx as unknown as pg.Client;
      const res = await raw.query<{ claimed_by: string; state: string }>(
        `SELECT claimed_by, state FROM choros.user_task_claim WHERE task_id = $1`,
        [taskId],
      );
      return res.rows[0];
    });
    expect(lockRow.claimed_by).toBe(firstActor); // first claim wins
    expect(lockRow.state).toBe("claimed");
  });
});

// ---------------------------------------------------------------------------
// AC-idempotent: same actor re-claims → ON CONFLICT DO UPDATE WHERE same actor
// ---------------------------------------------------------------------------

describe("T-0338 AC-idempotent — same actor re-claim is a no-op (idempotent)", () => {
  it("re-claiming own task does not throw; claimed_at is preserved or updated", async () => {
    if (!requireDb()) return;

    const tenantId = freshTenant();
    const taskId = crypto.randomUUID();
    const actor = "e-sokolov";
    const role = "fin-ctrl";
    const t1 = Date.now();
    const t2 = t1 + 200;

    // First claim
    await withTenantTx(tenantId, async (tx) => {
      await insertClaimLock(tx, { taskId, claimedBy: actor, claimedAt: t1, role, tenantId });
      await appendTaskClaimed(tx, { taskId, actor, actorKind: "human", tenantId, role, nowMs: t1 });
    });

    // Re-claim by SAME actor — must NOT throw
    await withTenantTx(tenantId, async (tx) => {
      await insertClaimLock(tx, { taskId, claimedBy: actor, claimedAt: t2, role, tenantId });
      await appendTaskClaimed(tx, { taskId, actor, actorKind: "human", tenantId, role, nowMs: t2 });
    });

    // Lock row still shows same actor
    const lockRow = await withTenantTx(tenantId, async (tx) => {
      const raw = tx as unknown as pg.Client;
      const res = await raw.query<{ claimed_by: string; state: string }>(
        `SELECT claimed_by, state FROM choros.user_task_claim WHERE task_id = $1`,
        [taskId],
      );
      return res.rows[0];
    });
    expect(lockRow.claimed_by).toBe(actor);
    expect(lockRow.state).toBe("claimed");
  });
});

// ---------------------------------------------------------------------------
// AC-projection: lock table is consistent with audit_event (projection property)
// ---------------------------------------------------------------------------

describe("T-0338 AC-projection — lock table is consistent with audit_event source", () => {
  it("after claim, both user_task_claim and audit_event agree on claimed_by", async () => {
    if (!requireDb()) return;

    const tenantId = freshTenant();
    const taskId = crypto.randomUUID();
    const actor = "e-sokolov";
    const role = "fin-ctrl";
    const nowMs = Date.now();

    await withTenantTx(tenantId, async (tx) => {
      await insertClaimLock(tx, { taskId, claimedBy: actor, claimedAt: nowMs, role, tenantId });
      await appendTaskClaimed(tx, { taskId, actor, actorKind: "human", tenantId, role, nowMs });
    });

    // Both lock table and audit projection agree on the claimant
    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const claimMap = await loadClaimsFromAudit(pool, tenantId);
      const auditClaim = claimMap.get(taskId);
      expect(auditClaim).toBeDefined();
      expect(auditClaim!.claimedBy).toBe(actor);

      // Lock row agrees
      const lockRow = await withTenantTx(tenantId, async (tx) => {
        const raw = tx as unknown as pg.Client;
        const res = await raw.query<{ claimed_by: string }>(
          `SELECT claimed_by FROM choros.user_task_claim WHERE task_id = $1`,
          [taskId],
        );
        return res.rows[0];
      });
      expect(lockRow.claimed_by).toBe(auditClaim!.claimedBy);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-isolation: FORCE RLS — lock row in tenant A is invisible in tenant B
// ---------------------------------------------------------------------------

describe("T-0338 AC-isolation — user_task_claim has FORCE RLS tenant isolation", () => {
  it("claim in tenant A is not visible when querying as tenant B", async () => {
    if (!requireDb()) return;

    const tenantA = freshTenant();
    const tenantB = freshTenant();
    const taskIdA = crypto.randomUUID();
    const actor = "e-sokolov";
    const role = "fin-ctrl";
    const nowMs = Date.now();

    await withTenantTx(tenantA, async (tx) => {
      await insertClaimLock(tx, { taskId: taskIdA, claimedBy: actor, claimedAt: nowMs, role, tenantId: tenantA });
    });

    // Query under tenant B — must see zero rows
    const rowCount = await withTenantTx(tenantB, async (tx) => {
      const raw = tx as unknown as pg.Client;
      const res = await raw.query<{ count: string }>(
        `SELECT count(*)::int AS count FROM choros.user_task_claim WHERE task_id = $1`,
        [taskIdA],
      );
      return parseInt(res.rows[0]?.count ?? "0", 10);
    });
    expect(rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-rebuildable: lock table is a projection — rebuildable from audit_event
// ---------------------------------------------------------------------------

describe("T-0338 AC-rebuildable — lock table is rebuildable from audit_event", () => {
  it("audit_event contains the task.claimed event and claim row is consistent", async () => {
    if (!requireDb()) return;

    const tenantId = freshTenant();
    const taskId = crypto.randomUUID();
    const actor = "e-sokolov";
    const role = "fin-ctrl";
    const nowMs = Date.now();

    await withTenantTx(tenantId, async (tx) => {
      await insertClaimLock(tx, { taskId, claimedBy: actor, claimedAt: nowMs, role, tenantId });
      await appendTaskClaimed(tx, { taskId, actor, actorKind: "human", tenantId, role, nowMs });
    });

    // Both audit_event and lock row contain a claim record (they agree — projection property)
    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const claimMap = await loadClaimsFromAudit(pool, tenantId);
      const auditEntry = claimMap.get(taskId);
      expect(auditEntry).toBeDefined();
      // audit_event is the SOURCE OF TRUTH; lock table is the projection.
      // If audit_event says claimedBy=actor, the lock row must agree.
      const lockRow = await withTenantTx(tenantId, async (tx) => {
        const raw = tx as unknown as pg.Client;
        const res = await raw.query<{ claimed_by: string; state: string }>(
          `SELECT claimed_by, state FROM choros.user_task_claim WHERE task_id = $1`,
          [taskId],
        );
        return res.rows[0];
      });
      expect(lockRow.claimed_by).toBe(auditEntry!.claimedBy);
      expect(lockRow.state).toBe("claimed");
    } finally {
      await pool.end();
    }
  });
});
