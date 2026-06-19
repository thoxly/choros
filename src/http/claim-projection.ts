/**
 * src/http/claim-projection.ts
 *
 * T-0336 [E15-S2] + T-0338 [E15-S2-claim]: Audit-event-backed claim projection
 * + TOCTOU-safe DB lock primitive.
 *
 * DESIGN:
 *  - The `task.claimed` event is the SOURCE OF TRUTH for claim-state (§4.1).
 *    The projection is derived; it is NOT a second authoritative store.
 *  - Emit: appendTaskClaimed() — appends ONE `task.claimed` audit_event inside
 *    the caller's tenant-scoped tx (atomic with the lock INSERT).
 *  - Read: loadClaimsFromAudit() — folds `task.claimed` events into a
 *    Map<taskId, {claimedBy, claimedAt}> (latest claimer wins).
 *  - Lock: insertClaimLock() — INSERT into user_task_claim (migration 078)
 *    inside the SAME tenant-RLS tx as the grant-check and audit emit.
 *    The partial-unique index (tenant_id, task_id) WHERE state='claimed' is the
 *    hard DB lock: a concurrent second INSERT fails immediately (unique violation
 *    → 409 ALREADY_CLAIMED at the DB level, zero TOCTOU window).
 *  - actor_type: derived via projectActorType(employee.kind, "user-task").
 *    Unknown actors default to "human" (accurate for the human-pool path).
 *
 * T-0338 TOCTOU CLOSURE (spec §3 S2 / §4.1):
 *  All three operations are in ONE tenant-RLS tx:
 *    (a) insertClaimLock  — hard DB lock (partial-unique constraint).
 *    (b) appendTaskClaimed — task.claimed audit event (source of truth).
 *  The grant-check (resolveRolesForActor) runs immediately before the tx opens,
 *  fail-closed (DB errors → 500). If the claim-lock INSERT fails (concurrent
 *  claim), the tx rolls back atomically — no partial state.
 *
 *  Agent/service claims are Flowable-owned (fetchAndLock) — NOT here.
 *
 * DB TABLE: user_task_claim (migration 078). PROJECTION (lock-primitive + snapshot),
 *  NOT the source of history — history stays in audit_event.
 */

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import type { AuditEventInput } from "../core/audit-grant-encoder.js";
import { projectActorType } from "../core/lifecycle-audit.js";
import {
  buildTransitionPayload,
  TRANSITION_PAYLOAD_KEY,
} from "../core/transition-payload.js";

// ---------------------------------------------------------------------------
// Audit event type constant
// ---------------------------------------------------------------------------

/** Emitted once per pool-task claim by a human actor. */
export const TASK_CLAIMED_TYPE = "task.claimed";

// ---------------------------------------------------------------------------
// UUID guard (mirrors process-projection.ts)
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// Module-level writer (mirrors process-projection.ts pattern)
// ---------------------------------------------------------------------------

const writer = makePgAuditWriter();

// ---------------------------------------------------------------------------
// appendTaskClaimed — write the task.claimed audit event
//
// Called inside the caller's already-open tenant-scoped tx.
// actor_type is derived from the provided employee.kind → projectActorType.
// Callers that cannot resolve kind (e.g. unknown actor) should pass "human" as
// the default (conservative and accurate for the human-pool claim path).
// ---------------------------------------------------------------------------

export async function appendTaskClaimed(
  tx: PgClientLike,
  args: {
    readonly taskId: string;
    readonly actor: string;
    readonly actorKind: "human" | "agent";
    readonly tenantId: string;
    readonly role: string;
    /** Epoch-ms of the claim. */
    readonly nowMs: number;
  },
): Promise<void> {
  // actor_type from PDP employee.kind — the spec invariant (§5 / T-0336).
  // "user-task" channel: a claim is always on the user-task path.
  const actorType = projectActorType(args.actorKind, "user-task");

  const input: AuditEventInput = {
    id: randomUUID(),
    type: TASK_CLAIMED_TYPE,
    actor: args.actor,
    subject: `task:${args.taskId}`,
    scope: { task_id: args.taskId, role: args.role },
    via: "inbox-claim",
    proposed_by: null,
    confirmed_by: args.actor,
    payload: {
      task_id: args.taskId,
      role: args.role,
      // actor_type from PDP employee.kind (not from engine kind — spec §5).
      actor_type: actorType,
      [TRANSITION_PAYLOAD_KEY]: buildTransitionPayload({
        tenantId: args.tenantId,
        instanceId: null, // claim is a pool-task event; instance unknown at claim time
        processKey: "",    // likewise unknown at claim time
        activity: TASK_CLAIMED_TYPE,
        actor: args.actor,
        actorType,
        ts: args.nowMs,
        durationMs: null, // not applicable for claim
        verdict: "claim",
      }),
    },
    occurred_at: args.nowMs,
  };

  await writer.appendAuditEvent(tx, input);
}

// ---------------------------------------------------------------------------
// ClaimState — the projected shape per task
// ---------------------------------------------------------------------------

export interface ClaimState {
  claimedBy: string;
  claimedAt: number;
}

// ---------------------------------------------------------------------------
// loadClaimsFromAudit — fold task.claimed events into Map<taskId, ClaimState>
//
// Reads all task.claimed events for the tenant, ordered oldest-to-newest.
// Newer claims overwrite older ones (last-writer-wins projection).
// Returns an empty Map when no claim events exist.
//
// NO try/catch — DB errors propagate (fail-closed, NF-3). The caller (GET inbox)
// handles degrade gracefully via its own catch (read projection, not write path).
// ---------------------------------------------------------------------------

export async function loadClaimsFromAudit(
  pool: pg.Pool,
  tenantId: string,
): Promise<Map<string, ClaimState>> {
  assertUuid(tenantId, "tenantId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");

    const { rows } = await client.query<{
      actor: string;
      payload: Record<string, unknown>;
      occurred_at: number;
    }>(
      `SELECT actor, payload, occurred_at::float8 AS occurred_at
         FROM choros.audit_event
        WHERE type = $1
          AND tenant_id = $2
        ORDER BY occurred_at ASC`,
      [TASK_CLAIMED_TYPE, tenantId],
    );

    await client.query("COMMIT");

    const result = new Map<string, ClaimState>();
    for (const row of rows) {
      const p = (row.payload ?? {}) as Record<string, unknown>;
      const taskId = typeof p["task_id"] === "string" ? p["task_id"] : null;
      if (taskId) {
        result.set(taskId, {
          claimedBy: row.actor,
          claimedAt: row.occurred_at,
        });
      }
    }
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// AlreadyClaimedError — thrown by insertClaimLock when a different actor
// already holds the 'claimed' lock.  The caller (inbox route) maps this to
// 409 ALREADY_CLAIMED.  This is a typed domain error, NOT a raw DB error.
// ---------------------------------------------------------------------------

export class AlreadyClaimedError extends Error {
  /** Discriminant for instanceof checks across module boundaries. */
  readonly kind = "AlreadyClaimedError" as const;
  constructor() {
    super("task already claimed by another actor");
    this.name = "AlreadyClaimedError";
  }
}

// ---------------------------------------------------------------------------
// insertClaimLock — write the DB lock row into user_task_claim (T-0338)
//
// Called INSIDE the caller's already-open tenant-scoped tx, BEFORE appendTaskClaimed.
//
// LOCK SEMANTICS (conditional-upsert RETURNING):
//   The query uses ON CONFLICT (tenant_id, task_id) DO UPDATE … WHERE (same-actor
//   OR state='released').  RETURNING claimed_by is appended so we can detect the
//   "different actor holds a live 'claimed' lock" case via rowCount===0 (the WHERE
//   predicate on DO UPDATE was FALSE → Postgres emits 0 rows, NO error).
//
//   Why the partial-unique index alone does NOT enforce this:
//   Migration 078 defines PK (tenant_id, task_id) AND a partial-unique index on the
//   same columns (WHERE state='claimed').  Because the PK already prevents a second
//   row for (tenant_id, task_id), the partial-unique index is redundant and can NEVER
//   fire: the PK conflict is always hit first, and the ON CONFLICT DO UPDATE fires
//   regardless of state.  The WHERE clause on DO UPDATE then decides whether the
//   update should actually apply; if it evaluates to FALSE Postgres leaves the row
//   unchanged and returns 0 rows — but raises NO error.  We detect this 0-row outcome
//   and translate it to AlreadyClaimedError in application code.
//
//   TOCTOU safety:
//   Concurrent txs that race to INSERT for the same PK will both hit the ON CONFLICT
//   path; Postgres serialises them via a row lock on the existing tuple.  Exactly one
//   wins (its WHERE evaluates to TRUE and gets a RETURNING row); the loser sees 0 rows
//   and throws AlreadyClaimedError.  This is race-free because the lock is held for
//   the duration of the winner's tx: the loser cannot proceed past insertClaimLock,
//   so appendTaskClaimed is never reached by the loser.
//
//   Idempotency: same-actor re-claim → WHERE evaluates TRUE → 1 row returned → won.
//   Re-claim after release: state='released' → WHERE evaluates TRUE → won.
//
// The table is a PROJECTION (lock-primitive + snapshot), NOT the history source.
// History stays in audit_event (task.claimed events from appendTaskClaimed).
// ---------------------------------------------------------------------------

export async function insertClaimLock(
  tx: PgClientLike,
  args: {
    readonly taskId: string;
    readonly claimedBy: string;
    readonly claimedAt: number;
    readonly role: string;
    readonly tenantId: string;
  },
): Promise<void> {
  // Conditional-upsert RETURNING:
  //   - New row (no prior claim)           → INSERT wins  → 1 row returned.
  //   - Same actor re-claim (state=claimed) → DO UPDATE WHERE same-actor → TRUE  → 1 row.
  //   - Released task re-claim              → DO UPDATE WHERE state='released' → TRUE  → 1 row.
  //   - Different actor, live 'claimed' row → DO UPDATE WHERE … → FALSE → 0 rows, no error.
  //     We detect 0 rows and throw AlreadyClaimedError.
  const result = await tx.query(
    `INSERT INTO choros.user_task_claim
       (tenant_id, task_id, claimed_by, claimed_at, role, state)
     VALUES ($1, $2, $3, $4, $5, 'claimed')
     ON CONFLICT (tenant_id, task_id) DO UPDATE
       SET claimed_by  = EXCLUDED.claimed_by,
           claimed_at  = EXCLUDED.claimed_at,
           role        = EXCLUDED.role,
           state       = EXCLUDED.state
     WHERE choros.user_task_claim.claimed_by = EXCLUDED.claimed_by
        OR choros.user_task_claim.state = 'released'
     RETURNING claimed_by`,
    [args.tenantId, args.taskId, args.claimedBy, args.claimedAt, args.role],
  );

  // 0 rows returned ↔ different actor holds a live 'claimed' lock (WHERE was FALSE).
  // The loser's tx has NOT been committed — the caller's withTenantTx will ROLLBACK
  // after we throw, so no partial state is written.
  // NOTE: PgClientLike exposes `rows`; we use rows.length (= 0 → lock not won).
  if (result.rows.length === 0) {
    throw new AlreadyClaimedError();
  }
}
