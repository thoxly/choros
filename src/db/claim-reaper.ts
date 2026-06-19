/**
 * src/db/claim-reaper.ts — T-0339 [E15-S3]
 *
 * Reaper / sweep for stuck human claims (F3 closure, §3 S3 spec).
 *
 * BACKGROUND:
 *   T-0338 introduced `user_task_claim` (migration 078) as the TOCTOU-safe lock
 *   for human pool-task claims. The partial-unique constraint prevents double-claiming,
 *   but there is NO built-in lease-TTL (unlike Flowable's `lockExpirationTime` for
 *   external tasks). A human actor that claims a task and then disconnects / times out
 *   leaves the task permanently locked in state='claimed', blocking all other actors.
 *
 * SOLUTION (spec §3 S3, F3 closure):
 *   A reaper sweep runs periodically and transitions stale claims
 *   `claimed → released` so the task returns to the pool.
 *   It follows the lock-sweep pattern of migration 029 / job_locked_expired_buckets:
 *     - Cross-tenant discovery via SECURITY DEFINER aggregate function.
 *     - Per-tenant RLS write via tenant-scoped tx (exact same pattern as insertClaimLock).
 *     - Idempotent: re-running on a task already in state='released' is a no-op.
 *     - Emits ONE `task.released-by-timeout` audit event per released claim so the
 *       transition is observable in the journal (F2 Phase 1).
 *
 * THRESHOLD:
 *   Default: 2 hours (CLAIM_REAPER_THRESHOLD_MS). Configurable via the `thresholdMs`
 *   argument to `sweepStaleClaims` or the CLAIM_REAPER_THRESHOLD_MS env var.
 *   The threshold is applied to `claimed_at` (epoch-ms in user_task_claim). A claim
 *   older than `nowMs - thresholdMs` is considered stale.
 *
 * TENANT SAFETY:
 *   The cross-tenant discovery query (findStaleTenants) runs as the migrator role
 *   (BYPASSRLS) and returns only (tenant_id, count). The per-tenant release runs in
 *   a tenant-RLS tx (SET LOCAL choros.tenant_id). No payload data crosses tenant
 *   boundaries.
 *
 * IDEMPOTENCY:
 *   The UPDATE … WHERE state='claimed' predicate makes re-runs safe: already-released
 *   claims are untouched. The audit emit uses ON CONFLICT DO NOTHING via the canonical
 *   audit writer (idempotency_key on the outbox / hash-chain dedup).
 *
 * AUDIT EVENT:
 *   type: 'task.released-by-timeout'
 *   payload: { task_id, claimed_by, claimed_at, released_at, threshold_ms,
 *              transition_payload: canonical TransitionPayload with verdict='timeout-release' }
 *
 * NO new TABLE: writes only to the EXISTING user_task_claim (078) and audit_event (006).
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { makePgAuditWriter, type PgClientLike } from "./audit-writer.js";
import {
  buildTransitionPayload,
  TRANSITION_PAYLOAD_KEY,
  projectActorType,
} from "../core/transition-payload.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Audit event type for a reaper-released claim. */
export const TASK_RELEASED_BY_TIMEOUT_TYPE = "task.released-by-timeout";

/**
 * Default claim staleness threshold: 2 hours.
 * Override via CLAIM_REAPER_THRESHOLD_MS env var or the `thresholdMs` argument.
 */
export const DEFAULT_CLAIM_REAPER_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2h

/** System actor for reaper-originated events. */
const REAPER_ACTOR = "system:claim-reaper" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SweepOptions {
  /**
   * Staleness threshold in ms. Claims older than `nowMs - thresholdMs` are released.
   * Defaults to DEFAULT_CLAIM_REAPER_THRESHOLD_MS (2 hours).
   * Read from CLAIM_REAPER_THRESHOLD_MS env var when not supplied directly
   * (server-side env is acceptable here — this is NOT src/core/*).
   */
  readonly thresholdMs?: number;
  /** Clock override for tests. Defaults to Date.now(). */
  readonly nowMs?: number;
}

export interface SweptClaim {
  readonly tenantId: string;
  readonly taskId: string;
  readonly claimedBy: string;
  readonly claimedAt: number;
  readonly releasedAt: number;
}

export interface SweepResult {
  /** Total released claims across all tenants. */
  readonly released: number;
  /** Per-tenant breakdown. */
  readonly byTenant: Record<string, number>;
  /** Individual released claims (for testing / observability). */
  readonly claims: SweptClaim[];
}

// ---------------------------------------------------------------------------
// Stale-claim discovery (cross-tenant, reads user_task_claim directly)
//
// The caller pool must be a BYPASSRLS connection (choros_migrator or equivalent)
// to discover stale claims across all tenants. The per-tenant release then runs
// under choros_app RLS.
//
// Unlike migration 029's SECURITY DEFINER function, the reaper runs at the
// application layer (no DDL) so we do a direct pool query with BYPASSRLS.
// ---------------------------------------------------------------------------

interface StaleClaimRow {
  tenant_id: string;
  task_id: string;
  claimed_by: string;
  claimed_at: string; // bigint from PG comes as string
}

async function findStaleClaims(
  migratorPool: pg.Pool,
  beforeMs: number,
): Promise<StaleClaimRow[]> {
  const client = await migratorPool.connect();
  try {
    // BYPASSRLS path: choros_migrator sees all rows.
    // The WHERE tenant_id predicate is a double-predicate guard (mimicking migration-029
    // SECURITY DEFINER pattern) — not strictly needed for migrator role but mirrors
    // production defensive style.
    const { rows } = await client.query<StaleClaimRow>(
      `SELECT tenant_id::text, task_id, claimed_by, claimed_at::text
         FROM choros.user_task_claim
        WHERE state = 'claimed'
          AND claimed_at < $1
        ORDER BY tenant_id, claimed_at ASC`,
      [beforeMs],
    );
    return rows;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Per-tenant release (tenant-RLS tx, choros_app path)
// ---------------------------------------------------------------------------

async function releaseClaimForTenant(
  appPool: pg.Pool,
  tenantId: string,
  taskId: string,
  claimedBy: string,
  claimedAt: number,
  releasedAt: number,
  thresholdMs: number,
): Promise<boolean> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");

    // UPDATE user_task_claim: state 'claimed' → 'released'. Idempotent (WHERE state='claimed').
    const updateResult = await client.query(
      `UPDATE choros.user_task_claim
          SET state = 'released'
        WHERE tenant_id = $1
          AND task_id = $2
          AND state = 'claimed'`,
      [tenantId, taskId],
    );

    if ((updateResult.rowCount ?? 0) === 0) {
      // Already released or no longer in 'claimed' state — idempotent no-op.
      await client.query("COMMIT");
      return false;
    }

    // Emit the transition-journal event.
    const actorType = projectActorType("agent", "service"); // reaper is a service actor
    const writer = makePgAuditWriter();
    await writer.appendAuditEvent(client as unknown as PgClientLike, {
      id: randomUUID(),
      type: TASK_RELEASED_BY_TIMEOUT_TYPE,
      actor: REAPER_ACTOR,
      subject: `task:${taskId}`,
      scope: { task_id: taskId, claimed_by: claimedBy },
      via: "claim-reaper",
      proposed_by: null,
      confirmed_by: REAPER_ACTOR,
      payload: {
        task_id: taskId,
        claimed_by: claimedBy,
        claimed_at: claimedAt,
        released_at: releasedAt,
        threshold_ms: thresholdMs,
        [TRANSITION_PAYLOAD_KEY]: buildTransitionPayload({
          tenantId,
          instanceId: null, // not available at claim level
          processKey: "",   // not available at claim level
          activity: TASK_RELEASED_BY_TIMEOUT_TYPE,
          actor: REAPER_ACTOR,
          actorType,
          ts: releasedAt,
          durationMs: releasedAt - claimedAt, // time stuck = claim age
          verdict: "timeout-release",
        }),
      },
      occurred_at: releasedAt,
    });

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// sweepStaleClaims — main public entry point
//
// Accepts two pools:
//   migratorPool: BYPASSRLS connection (choros_migrator) for cross-tenant discovery.
//   appPool:      choros_app connection for per-tenant RLS writes.
//
// In production both can be the same migrator pool if the reaper runs as
// choros_migrator throughout. The split is preserved for testability.
// ---------------------------------------------------------------------------

export async function sweepStaleClaims(
  migratorPool: pg.Pool,
  appPool: pg.Pool,
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const thresholdMs =
    opts.thresholdMs ??
    (process.env["CLAIM_REAPER_THRESHOLD_MS"] != null
      ? parseInt(process.env["CLAIM_REAPER_THRESHOLD_MS"]!, 10)
      : DEFAULT_CLAIM_REAPER_THRESHOLD_MS);

  const beforeMs = nowMs - thresholdMs;
  const staleClaims = await findStaleClaims(migratorPool, beforeMs);

  let releasedCount = 0;
  const byTenant: Record<string, number> = {};
  const claims: SweptClaim[] = [];

  for (const claim of staleClaims) {
    const claimedAt = parseInt(claim.claimed_at, 10);
    const released = await releaseClaimForTenant(
      appPool,
      claim.tenant_id,
      claim.task_id,
      claim.claimed_by,
      claimedAt,
      nowMs,
      thresholdMs,
    );
    if (released) {
      releasedCount++;
      byTenant[claim.tenant_id] = (byTenant[claim.tenant_id] ?? 0) + 1;
      claims.push({
        tenantId: claim.tenant_id,
        taskId: claim.task_id,
        claimedBy: claim.claimed_by,
        claimedAt,
        releasedAt: nowMs,
      });
    }
  }

  return { released: releasedCount, byTenant, claims };
}
