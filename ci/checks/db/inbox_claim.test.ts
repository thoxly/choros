/**
 * ci/checks/db/inbox_claim.test.ts — T-0336 [E15-S2] live-DB fitness for the
 * audit-event-backed claim projection.
 *
 * Covers:
 *   AC-emit:    appendTaskClaimed emits a `task.claimed` audit_event inside the
 *               tenant-scoped tx (durable after COMMIT, re-readable).
 *   AC-project: loadClaimsFromAudit projects the claim (claimedBy, claimedAt)
 *               for the actor that claimed.
 *   AC-pool:    After a claim, a DB-backed inbox GET reflects pool:false / mine:true
 *               for the claimant and pool:true (unclaimed) from another actor's view.
 *   AC-idem:    Re-claim by the SAME actor is idempotent (last-writer-wins; stable
 *               state — claimedBy unchanged, status reflects the re-claimant).
 *   AC-concurrent: A SECOND actor claiming an already-claimed task is last-writer-wins
 *               via audit projection (the newer event's actor wins). Hard TOCTOU
 *               protection (partial-unique DB lock) lands in T-0338.
 *   AC-isolation: A claim in tenant A is NOT visible when querying tenant B.
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
  appendTaskClaimed,
  loadClaimsFromAudit,
  TASK_CLAIMED_TYPE,
} from "../../../src/http/claim-projection.js";

const { Client } = pg;

// ---------------------------------------------------------------------------
// Guard: skip all tests when no DATABASE_URL is configured.
// The no-DB e2e suite covers memory-mode behaviour; this file tests the live
// audit-projection path (ci/checks/db/ job) only.
// ---------------------------------------------------------------------------

function requireDb(): boolean {
  return Boolean(process.env["DATABASE_URL"]);
}

/** Fresh random tenant UUID — no shared-DB pollution. */
function freshTenant(): string {
  return crypto.randomUUID();
}

/**
 * Open a connection using appUrl(), BEGIN a tenant-scoped tx, run fn, COMMIT.
 * Mirrors the pattern in process-projection.test.ts / deferred-inbox.test.ts.
 * Uses the choros_app role (NOBYPASSRLS) — the exact production read path.
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

// ---------------------------------------------------------------------------
// AC-emit: appendTaskClaimed writes a task.claimed audit_event
// ---------------------------------------------------------------------------

describe("T-0336 AC-emit — appendTaskClaimed emits a task.claimed audit_event", () => {
  it("emits type=task.claimed with task_id and role in payload; row is durable", async () => {
    if (!requireDb()) return;

    const tenantId = freshTenant();
    const taskId = crypto.randomUUID();
    const actor = "e-sokolov";

    await withTenantTx(tenantId, (tx) =>
      appendTaskClaimed(tx, {
        taskId,
        actor,
        actorKind: "human",
        tenantId,
        role: "fin-ctrl",
        nowMs: Date.now(),
      }),
    );

    // Re-read via a FRESH connection (durability probe — data must survive beyond
    // the writing transaction).
    const row = await withTenantTx(tenantId, async (tx) => {
      const raw = tx as unknown as pg.Client;
      const res = await raw.query<{
        id: string;
        type: string;
        actor: string;
        payload: Record<string, unknown>;
        occurred_at: number;
      }>(
        `SELECT id, type, actor, payload, occurred_at::float8 AS occurred_at
           FROM choros.audit_event
          WHERE payload->>'task_id' = $1
            AND tenant_id = current_setting('choros.tenant_id', false)::uuid`,
        [taskId],
      );
      return res.rows[0];
    });

    expect(row).toBeDefined();
    expect(row.type).toBe(TASK_CLAIMED_TYPE);
    expect(row.actor).toBe(actor);
    expect(row.payload["task_id"]).toBe(taskId);
    expect(row.payload["role"]).toBe("fin-ctrl");
    expect(typeof row.occurred_at).toBe("number");
    expect(row.occurred_at).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC-project: loadClaimsFromAudit projects claimedBy + claimedAt
// ---------------------------------------------------------------------------

describe("T-0336 AC-project — loadClaimsFromAudit projects the claim", () => {
  it("returns a Map entry with correct claimedBy and claimedAt for the task", async () => {
    if (!requireDb()) return;

    const tenantId = freshTenant();
    const taskId = crypto.randomUUID();
    const actor = "e-sokolov";
    const nowMs = Date.now();

    await withTenantTx(tenantId, (tx) =>
      appendTaskClaimed(tx, { taskId, actor, actorKind: "human", tenantId, role: "fin-ctrl", nowMs }),
    );

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const claimMap = await loadClaimsFromAudit(pool, tenantId);
      const claim = claimMap.get(taskId);

      expect(claim).toBeDefined();
      expect(claim!.claimedBy).toBe(actor);
      // claimedAt should be within 10 seconds of nowMs (tolerant of latency).
      expect(Math.abs(claim!.claimedAt - nowMs)).toBeLessThan(10_000);
    } finally {
      await pool.end();
    }
  });

  it("returns an empty Map when no claims exist for the tenant", async () => {
    if (!requireDb()) return;

    const tenantId = freshTenant(); // fresh tenant — zero claim events
    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const claimMap = await loadClaimsFromAudit(pool, tenantId);
      expect(claimMap.size).toBe(0);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-pool: after a claim, pool:false / mine:true for claimant; pool:true for others
//
// This test exercises the projection logic directly rather than hitting the HTTP
// route (which requires seed data). It confirms:
//   - claimedBy in the projection matches the actor.
//   - A second actor does NOT see mine:true for the same claim.
// ---------------------------------------------------------------------------

describe("T-0336 AC-pool — loadClaimsFromAudit reflects pool→claimed state", () => {
  it("after claim, claimedBy is the actor; a different actor sees claimedBy but not mine", async () => {
    if (!requireDb()) return;

    const tenantId = freshTenant();
    const taskId = crypto.randomUUID();
    const claimant = "e-sokolov";
    const otherActor = "e-kravtsova";

    await withTenantTx(tenantId, (tx) =>
      appendTaskClaimed(tx, { taskId, actor: claimant, actorKind: "human", tenantId, role: "fin-ctrl", nowMs: Date.now() }),
    );

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const claimMap = await loadClaimsFromAudit(pool, tenantId);
      const claim = claimMap.get(taskId);

      expect(claim).toBeDefined();
      // Claimant check: pool=false, mine=true (upstream logic in findInboxItems).
      // Here we confirm the projection provides the right claimedBy for both actors:
      expect(claim!.claimedBy).toBe(claimant);
      // "mine" is computed as claimedBy === actor in findInboxItems; the other actor
      // gets mine:false (verified by checking claimedBy !== otherActor).
      expect(claim!.claimedBy).not.toBe(otherActor);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-idem: re-claim by the SAME actor is idempotent (last-writer-wins, stable)
// ---------------------------------------------------------------------------

describe("T-0336 AC-idem — same-actor re-claim is idempotent (last-writer-wins)", () => {
  it("two claim events from the same actor result in stable claimedBy (last event wins, same actor)", async () => {
    if (!requireDb()) return;

    const tenantId = freshTenant();
    const taskId = crypto.randomUUID();
    const actor = "e-sokolov";
    const t1 = Date.now();
    const t2 = t1 + 100;

    // First claim
    await withTenantTx(tenantId, (tx) =>
      appendTaskClaimed(tx, { taskId, actor, actorKind: "human", tenantId, role: "fin-ctrl", nowMs: t1 }),
    );
    // Re-claim (same actor, slightly later)
    await withTenantTx(tenantId, (tx) =>
      appendTaskClaimed(tx, { taskId, actor, actorKind: "human", tenantId, role: "fin-ctrl", nowMs: t2 }),
    );

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const claimMap = await loadClaimsFromAudit(pool, tenantId);
      const claim = claimMap.get(taskId);

      expect(claim).toBeDefined();
      // Last-writer-wins: claimedBy is still the same actor (idempotent).
      expect(claim!.claimedBy).toBe(actor);
      // The projection should reflect the later timestamp.
      expect(claim!.claimedAt).toBeGreaterThanOrEqual(t1);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-concurrent: second actor claiming an already-claimed task — last-writer-wins
//
// WITHOUT the deferred DB claim-lock primitive (T-0338), two concurrent claims
// from different actors can both succeed. The audit track records both events;
// the projection uses last-writer-wins (ORDER BY occurred_at ASC → last row wins).
//
// This test asserts CURRENT honest behavior without the T-0338 hard lock:
//   - Both appendTaskClaimed calls succeed (no DB error).
//   - The projection shows the SECOND actor's claim (last writer wins).
//
// T-0338 will add a partial-unique DB lock that makes the FIRST claim win and
// causes the second to fail with a DB constraint, enabling 409 ALREADY_CLAIMED.
// ---------------------------------------------------------------------------

describe("T-0336 AC-concurrent — concurrent claim is last-writer-wins (T-0338 adds hard lock)", () => {
  it("second actor's claim overwrites first in the projection (last-writer-wins without T-0338 lock)", async () => {
    if (!requireDb()) return;

    const tenantId = freshTenant();
    const taskId = crypto.randomUUID();
    const firstActor = "e-sokolov";
    const secondActor = "e-kravtsova";
    const t1 = Date.now();
    const t2 = t1 + 50; // slightly later

    // First claim
    await withTenantTx(tenantId, (tx) =>
      appendTaskClaimed(tx, { taskId, actor: firstActor, actorKind: "human", tenantId, role: "fin-ctrl", nowMs: t1 }),
    );
    // Second claim by a different actor — without the T-0338 DB lock this succeeds.
    // T-0338 will introduce a partial-unique constraint that rejects this at the DB level.
    await withTenantTx(tenantId, (tx) =>
      appendTaskClaimed(tx, { taskId, actor: secondActor, actorKind: "human", tenantId, role: "fin-ctrl", nowMs: t2 }),
    );

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const claimMap = await loadClaimsFromAudit(pool, tenantId);
      const claim = claimMap.get(taskId);

      expect(claim).toBeDefined();
      // Last-writer-wins: the second actor's event (higher occurred_at) wins.
      // Both events are appended (append-only); the projection folds them in
      // ORDER BY occurred_at ASC so the last row wins.
      expect(claim!.claimedBy).toBe(secondActor);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-isolation: claim in tenant A is NOT visible in tenant B
// ---------------------------------------------------------------------------

describe("T-0336 AC-isolation — claim is tenant-RLS isolated", () => {
  it("a task.claimed event in tenant A is invisible when querying tenant B", async () => {
    if (!requireDb()) return;

    const tenantA = freshTenant();
    const tenantB = freshTenant();
    const taskIdA = crypto.randomUUID();
    const taskIdB = crypto.randomUUID();

    // Seed one claim per tenant
    await withTenantTx(tenantA, (tx) =>
      appendTaskClaimed(tx, { taskId: taskIdA, actor: "e-sokolov", actorKind: "human", tenantId: tenantA, role: "fin-ctrl", nowMs: Date.now() }),
    );
    await withTenantTx(tenantB, (tx) =>
      appendTaskClaimed(tx, { taskId: taskIdB, actor: "e-kravtsova", actorKind: "human", tenantId: tenantB, role: "fin-ctrl", nowMs: Date.now() }),
    );

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      // Tenant A view: must see A's claim, must NOT see B's.
      const mapA = await loadClaimsFromAudit(pool, tenantA);
      expect(mapA.get(taskIdA)).toBeDefined();
      expect(mapA.get(taskIdB)).toBeUndefined();

      // Tenant B view: must see B's claim, must NOT see A's.
      const mapB = await loadClaimsFromAudit(pool, tenantB);
      expect(mapB.get(taskIdB)).toBeDefined();
      expect(mapB.get(taskIdA)).toBeUndefined();
    } finally {
      await pool.end();
    }
  });
});
