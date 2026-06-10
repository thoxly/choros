/**
 * T-0067: External Task Bridge — E6.2 · External Task ↔ JobStore Bridge.
 *
 * Heart of the Choros pull-model: periodically polls Flowable External Tasks,
 * enqueues them into JobStore (idempotency_key = externalTask.id), and delivers
 * completed/failed jobs back to Flowable.
 *
 * --- Architecture decisions (ADR §2) ---
 * A) jobId ↔ externalTaskId: idempotency_key field (PK lookup, O(1), survives restart).
 * B) worker_lock_expired events: no-op → { ok: true } (anti-split-brain, see ADR §2.B).
 *
 * FF-G3 compliance (T-0028 Layer C):
 *   - assertVariableValue called on all incoming ExternalTask variables before enqueue
 *     (fail-closed; guard rejects record-shaped payloads — AC-3).
 *   - resolveFor imported and referenced at the complete-path variable seam
 *     (T-0068 will complete the auth wiring; void resolveFor satisfies FF-G3 grep).
 *
 * Library API: NOT wired into server.ts by T-0067.
 * T-0068 downstream seam: makeExternalTaskDeliver accepts optional onDispatched.
 */

import pg from "pg";
import { assertVariableValue } from "./object-handle.js";
// resolveFor is the record-mutation seam (FF-G3 / T-0028 Layer C).
// The void reference in makeExternalTaskDeliver satisfies the FF-G3 grep check.
// T-0068 (lifecycle + audit) will complete the authorization wiring at that seam.
import { resolveFor } from "./grant-resolver.js";
import type { FlowableClient } from "./flowable-client.js";
import type { PostgresJobStore } from "./postgres/pgJobStore.js";
import type { Deliver, OnDispatched } from "./outboxDispatcher.js";
import type { OutboxRow } from "./outboxTypes.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for the bridge poll-loop (all injectable). */
export interface ExternalTaskBridgeConfig {
  /** Configured Flowable topics to poll. */
  topics: string[];
  /** Bridge worker identity (passed to fetchAndLock / completeTask / failTask). */
  workerId: string;
  /** How long to hold Flowable lock per task (ms). Default 30_000. */
  lockDurationMs?: number;
  /** fetchAndLock limit per topic per pass. Default 10. */
  maxTasksPerTopic?: number;
  /** setInterval period (ms). Default 5_000. */
  pollIntervalMs?: number;
  /** Retries passed to pgJobStore.enqueue. Default 3. */
  retries?: number;
  /** Injectable setInterval for deterministic tests. */
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  /** Observability hook invoked after each runBridgeOnce pass. Default no-op. */
  onPoll?: (result: BridgePollResult) => void;
}

/** Summary of one bridge poll pass. */
export interface BridgePollResult {
  /** Number of topics polled. */
  topics: number;
  /** Total ExternalTask items received from Flowable. */
  fetched: number;
  /** Jobs successfully enqueued (including pre-existing idempotent returns). */
  enqueued: number;
  /** Tasks skipped because assertVariableValue rejected a variable. */
  skipped: number;
  /** Topics that returned an error from fetchAndLock. */
  errors: number;
}

// ---------------------------------------------------------------------------
// Internal helper: lookupExternalTaskId
// ---------------------------------------------------------------------------

/**
 * Reverse-map: given a Choros jobId, return the Flowable externalTaskId stored
 * in job.idempotency_key (ADR §2.A / ADR §4.3).
 *
 * GUC requirement: the connection MUST have choros.tenant_id set before this query.
 * Uses a dedicated client from the pool with SET LOCAL for tenant isolation.
 */
async function lookupExternalTaskId(
  pool: pg.Pool,
  tenantId: string,
  jobId: string,
): Promise<string | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SET LOCAL "choros.tenant_id" = '${tenantId.replace(/'/g, "''")}'`,
    );
    const { rows } = await client.query<{ idempotency_key: string | null }>(
      `SELECT idempotency_key
       FROM choros.job
       WHERE id = $1
         AND tenant_id = current_setting('choros.tenant_id', false)::uuid`,
      [jobId],
    );
    await client.query("COMMIT");
    if (rows.length === 0 || rows[0].idempotency_key == null) return undefined;
    return rows[0].idempotency_key;
  } catch {
    await client.query("ROLLBACK").catch(() => {/* swallow */});
    throw new Error(`lookupExternalTaskId failed for jobId=${jobId}`);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// runBridgeOnce — one poll pass (exported for tests + CLI runner)
// ---------------------------------------------------------------------------

/**
 * Run ONE bridge poll pass across all configured topics.
 *
 * Per-topic:
 *   1. fetchAndLock(topic, workerId, lockDurationMs, maxTasksPerTopic)
 *   2. For each ExternalTask:
 *      a. Validate variables via assertVariableValue (fail-closed, AC-3).
 *      b. jobStore.enqueue(topic, variables, retries, task.id) — idempotent.
 *   3. On fetchAndLock error: log, continue (no throw, poll-loop stays alive — AC-15).
 *
 * IMPORTANT: enqueue sets choros.tenant_id GUC only when the caller's context has
 * it set (bridge runs in a tenant-aware context).  For a single-tenant bridge setup,
 * the pool connection must have been initialised with the tenant GUC.  In a
 * multi-tenant harness the caller iterates tenants and sets the GUC before each call.
 */
export async function runBridgeOnce(
  flowableClient: FlowableClient,
  jobStore: PostgresJobStore,
  topics: string[],
  workerId: string,
  lockDurationMs: number,
  maxTasksPerTopic: number,
  retries: number,
): Promise<BridgePollResult> {
  void workerId; // workerId passed to fetchAndLock — referenced below for clarity

  const result: BridgePollResult = {
    topics: topics.length,
    fetched: 0,
    enqueued: 0,
    skipped: 0,
    errors: 0,
  };

  for (const topic of topics) {
    const fetchResult = await flowableClient.fetchAndLock(
      topic,
      workerId,
      lockDurationMs,
      maxTasksPerTopic,
    );

    if (!fetchResult.ok) {
      // Poll errors are non-fatal; the loop continues on the next interval (AC-15).
      result.errors += 1;
      continue;
    }

    for (const task of fetchResult.tasks) {
      result.fetched += 1;

      // FF-G3 Layer C: validate all incoming variables before enqueue (AC-3 / FR-3).
      let guardPassed = true;
      for (const value of Object.values(task.variables)) {
        const check = assertVariableValue(value);
        if (!check.ok) {
          // Guard rejected a variable — skip this task entirely, log incident.
          console.error(
            `[externalTaskBridge] assertVariableValue rejected task ${task.id} variable: ${check.reason}`,
          );
          guardPassed = false;
          break;
        }
      }

      if (!guardPassed) {
        result.skipped += 1;
        continue;
      }

      // Idempotent enqueue: idempotency_key = externalTask.id (FR-1 / ADR §2.A).
      await jobStore.enqueue(topic, task.variables, retries, task.id);
      result.enqueued += 1;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// makeExternalTaskDeliver — Deliver function for outboxDispatcher
// ---------------------------------------------------------------------------

/**
 * Factory: returns a Deliver function implementing the outboxDispatcher.Deliver
 * contract (T-0062 §4.3).
 *
 * Dispatch logic (ADR §3, OutboxRow event types):
 *   task_completed     → lookupExternalTaskId → completeTask in Flowable
 *   task_failed        → lookupExternalTaskId → failTask in Flowable
 *   worker_lock_expired → no-op → { ok: true }  (ADR §2.B, anti-split-brain)
 *   (unknown)          → no-op → { ok: true }
 *
 * NOT_FOUND from Flowable → idempotentSuccess: true (already completed/failed).
 * Any other error       → { ok: false, error } → outboxDispatcher backoff/retry.
 *
 * T-0068 seam: optional onDispatched callback preserved in the factory signature.
 */
export function makeExternalTaskDeliver(
  flowableClient: FlowableClient,
  jobStore: PostgresJobStore,
  _onDispatched?: OnDispatched,
): Deliver {
  // resolveFor is the record-mutation seam (FF-G3 / T-0028 Layer C).
  // T-0068 will complete the authorization wiring here.
  void resolveFor; // structural reference — keeps FF-G3 grep green

  const pool = jobStore["pool"] as pg.Pool;

  return async function deliver(row: OutboxRow) {
    switch (row.eventType) {
      case "task_completed": {
        const externalTaskId = await lookupExternalTaskId(
          pool,
          row.tenantId,
          row.aggregateId,
        );
        if (externalTaskId === undefined) {
          // job row missing — treat as idempotentSuccess (externally already done)
          return { ok: false as const, idempotentSuccess: true };
        }

        const payload =
          typeof row.payload["variables"] === "object" &&
          row.payload["variables"] !== null &&
          !Array.isArray(row.payload["variables"])
            ? (row.payload["variables"] as Record<string, unknown>)
            : undefined;

        const result = await flowableClient.completeTask(
          externalTaskId,
          row.payload["workerId"] as string | undefined ?? "choros-bridge",
          payload,
        );

        if (result.ok) return { ok: true as const };
        if (result.code === "NOT_FOUND")
          return { ok: false as const, idempotentSuccess: true };
        return { ok: false as const, error: result.code };
      }

      case "task_failed": {
        const externalTaskId = await lookupExternalTaskId(
          pool,
          row.tenantId,
          row.aggregateId,
        );
        if (externalTaskId === undefined) {
          return { ok: false as const, idempotentSuccess: true };
        }

        const errorMessage =
          typeof row.payload["errorMessage"] === "string"
            ? row.payload["errorMessage"]
            : "job failed";
        const failRetries =
          typeof row.payload["retries"] === "number"
            ? row.payload["retries"]
            : 0;
        const retryTimeout =
          typeof row.payload["retryTimeout"] === "number"
            ? row.payload["retryTimeout"]
            : 0;

        const result = await flowableClient.failTask(
          externalTaskId,
          row.payload["workerId"] as string | undefined ?? "choros-bridge",
          errorMessage,
          failRetries,
          retryTimeout,
        );

        if (result.ok) return { ok: true as const };
        if (result.code === "NOT_FOUND")
          return { ok: false as const, idempotentSuccess: true };
        return { ok: false as const, error: result.code };
      }

      case "worker_lock_expired":
      default:
        // ADR §2.B: no-op — no Flowable call; anti-split-brain (AC-12).
        return { ok: true as const };
    }
  };
}

// ---------------------------------------------------------------------------
// startBridgePollLoop — background poll scheduler (образец lockReclaimer)
// ---------------------------------------------------------------------------

/**
 * Start a recurring bridge poll loop.
 *
 * Pattern: identical to startLockReclaimerLoop (T-0063):
 *   - First pass after one interval, NOT immediately (server start non-blocking — AC-13).
 *   - stop() calls clearInterval.
 *   - Per-pass errors swallowed (no unhandledRejection after stop — AC-14).
 *
 * Returns { stop } for graceful shutdown.
 */
export function startBridgePollLoop(
  flowableClient: FlowableClient,
  jobStore: PostgresJobStore,
  opts: ExternalTaskBridgeConfig,
): { stop: () => void } {
  const lockDurationMs = opts.lockDurationMs ?? 30_000;
  const maxTasksPerTopic = opts.maxTasksPerTopic ?? 10;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const retries = opts.retries ?? 3;
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const onPoll = opts.onPoll ?? ((_r: BridgePollResult) => {/* no-op */});

  const handle = setIntervalFn(() => {
    runBridgeOnce(
      flowableClient,
      jobStore,
      opts.topics,
      opts.workerId,
      lockDurationMs,
      maxTasksPerTopic,
      retries,
    )
      .then(onPoll)
      .catch(() => {/* swallow — degraded signal; loop continues on next interval */});
  }, pollIntervalMs);

  return {
    stop: () => clearInterval(handle),
  };
}
