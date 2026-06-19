/**
 * src/http/claim-projection.ts
 *
 * T-0336 [E15-S2]: Audit-event-backed claim projection.
 *
 * Emits `task.claimed` audit events (claim write-path) and projects claim-state
 * (claimedBy, claimedAt) from the append-only `audit_event` track.
 *
 * DESIGN:
 *  - The `task.claimed` event is the SOURCE OF TRUTH for claim-state (§4.1).
 *    The projection is derived; it is NOT a second authoritative store.
 *  - Emit: appendTaskClaimed() — appends ONE `task.claimed` audit_event inside
 *    the caller's tenant-scoped tx (atomic with the role-eligibility check).
 *  - Read: loadClaimsFromAudit() — folds `task.claimed` events into a
 *    Map<taskId, {claimedBy, claimedAt}> (latest claimer wins, so a claim
 *    released and re-claimed by another actor is reflected correctly).
 *  - actor_type: derived via projectActorType(employee.kind, "user-task").
 *    The employee.kind is fetched from the DB (findEmployeeById); unknown actors
 *    default to "human" (conservative, accurate for the human-pool path).
 *
 * CONCURRENT-CLAIM NOTE (T-0338 gap):
 *  The `task.claimed` audit event is append-only; without the deferred DB lock
 *  primitive (T-0338) there is a TOCTOU window between the
 *  read-check (loadClaimsFromAudit) and the emit (appendTaskClaimed). Until
 *  T-0338 adds the DB lock, concurrent claims from two users may both succeed.
 *  This is an accepted, tracked risk (spec §3 / T-0338 prerequisite).
 *  The audit log (task.claimed events) remains correct: both events are recorded,
 *  and the last writer wins in the projection.
 *
 * NO new DB table. Uses existing audit_event track (migration 006).
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
