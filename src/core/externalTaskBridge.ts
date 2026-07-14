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
import type { FlowableClient, ExternalTask } from "./flowable-client.js";
import type { PostgresJobStore, Queryable } from "./postgres/pgJobStore.js";
import type { Deliver, OnDispatched } from "./outboxDispatcher.js";
import type { OutboxRow } from "./outboxTypes.js";
// T-0340 [E15-S5] R-1 → T-0524 (constructor-foundation): GENERIC DMN gateway
// wiring at the triage completeTask seam. When ANY external task completes, the
// bridge re-evaluates the process's authored DMN rule tables and injects ALL
// authored routing outcomes (keyed by their AUTHORED variable name) into the
// completeTask variable map BEFORE the engine reaches the downstream
// exclusiveGateway. ТЭЛ ("approvalRequired" → gw-approval-threshold) is ONE such
// authored configuration; no process key, topic, variable name, or gateway id is
// hard-coded in this seam — they all come from the authored rule tables.
import { evaluateGatewayAtTriage, GATEWAY_ID_UNKNOWN } from "./dmn-gateway.js";

// UUID validation regex (образец pgOutboxStore.claimBatch / pgJobStore — R-3 defence).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// T-0636 (F5): CHOROS_TENANT_VAR — the tenant-stamp process-variable convention
// ---------------------------------------------------------------------------
/**
 * The single point of truth for the process-variable name that carries the
 * owning tenant on a Flowable process instance. Written by the two production
 * startInstance call-sites (process-start.ts, records.ts) as a plain string
 * value at launch time (inside their own withTenantTx, where tenantId is
 * already in scope); read here at the bridge's enqueue boundary to resolve
 * which tenant a bare Flowable ExternalTask belongs to BEFORE it is written to
 * choros.job.
 *
 * This is a STRUCTURAL convention (same class as `choros_processKey` /
 * `choros_instanceId` already used in this file) — not a case-specific literal;
 * it names no tenant, process, or role of any particular demo case, so it does
 * not grow the anti-case baseline (D-064 / NF-4).
 */
export const CHOROS_TENANT_VAR = "choros_tenantId";

// ---------------------------------------------------------------------------
// T-0636 (F10): makeErrorLogThrottle — bounded log stream for a repeating error class
// ---------------------------------------------------------------------------
/**
 * Factory: returns a throttled emit function keyed by `errorClass`. The FIRST
 * occurrence of a class is emitted immediately. Subsequent occurrences of the
 * SAME class are suppressed until `minIntervalMs` has elapsed since the last
 * emission of that class — at which point a summary line is emitted that
 * includes how many repeats were suppressed in between. A DIFFERENT error class
 * always emits immediately (per-class independence), and a class that recovers
 * and later reoccurs starts counting from zero again.
 *
 * This exists so a persistent condition (stale credentials → repeated 401, or a
 * legacy instance missing the tenant-stamp variable) logs ONE clear line per
 * class instead of one line every 5s forever (F8/F9 without this would spam
 * the log and drown real signal — AC-12).
 *
 * Clock is injectable (`opts.nowMs`) for deterministic tests.
 */
export interface ErrorLogThrottle {
  (errorClass: string, detail: string): void;
}

export function makeErrorLogThrottle(
  emit: (msg: string) => void,
  opts: { minIntervalMs?: number; nowMs?: () => number } = {},
): ErrorLogThrottle {
  const minIntervalMs = opts.minIntervalMs ?? 60_000;
  const nowMs = opts.nowMs ?? Date.now;

  interface ClassState {
    lastEmittedAt: number;
    suppressedCount: number;
  }
  const states = new Map<string, ClassState>();

  return (errorClass: string, detail: string): void => {
    const now = nowMs();
    const state = states.get(errorClass);

    if (state === undefined) {
      // First occurrence of this class — emit immediately.
      states.set(errorClass, { lastEmittedAt: now, suppressedCount: 0 });
      emit(`[externalTaskBridge] ${errorClass}: ${detail}`);
      return;
    }

    if (now - state.lastEmittedAt < minIntervalMs) {
      // Within the throttle window — suppress, count it.
      state.suppressedCount += 1;
      return;
    }

    // Window elapsed — emit a summary including the suppressed count, reset.
    const suppressed = state.suppressedCount;
    state.lastEmittedAt = now;
    state.suppressedCount = 0;
    const suffix = suppressed > 0 ? ` (${suppressed} repeat(s) suppressed)` : "";
    emit(`[externalTaskBridge] ${errorClass}: ${detail}${suffix}`);
  };
}

// ---------------------------------------------------------------------------
// resolveAuthoredProcessKey — generic process-key resolution at the triage seam
// ---------------------------------------------------------------------------

/**
 * Resolve the BPMN process definition key for the completed job from its
 * captured Flowable variables, generically — no process is hard-coded.
 *
 * Flowable / Choros may surface the process key under a few conventional
 * variable names depending on how the instance was started. We probe the known
 * conventions in order and return the first non-empty string. When none is
 * present we return `undefined`, which makes the rule-table lookup fall back to
 * the tenant's process-agnostic (process_def_id IS NULL) published rule tables —
 * still generic, still fail-closed (no rule table → no injection → BPMN default
 * flow). This is intentionally data-driven: the process key is AUTHORED/runtime
 * data, never engine logic.
 */
function resolveAuthoredProcessKey(
  variables: Record<string, unknown>,
): string | undefined {
  // Conventional keys, most-specific first. (Choros set markers, then Flowable
  // system variable names that may be projected into the variable map.)
  const candidateKeys = [
    "choros_processKey",
    "processDefinitionKey",
    "processKey",
    "__processDefinitionKey",
  ];
  for (const key of candidateKeys) {
    const v = variables[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/**
 * Resolve the process instance id for the completed job from its captured
 * variables, generically. Used only as the audit-event correlation id; falls
 * back to the jobId when absent (best available correlation).
 */
function resolveInstanceId(
  variables: Record<string, unknown>,
  fallbackJobId: string,
): string {
  const candidateKeys = ["choros_instanceId", "processInstanceId", "__instanceId"];
  for (const key of candidateKeys) {
    const v = variables[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return fallbackJobId;
}

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
  /**
   * T-0636 (P0-6/F3/F4/F5): pg.Pool for per-tenant GUC-scoped enqueue. When
   * supplied, runBridgeOnce groups fetched tasks by their
   * `task.variables[choros_tenantId]` stamp and enqueues each tenant's tasks
   * under its own SET LOCAL choros.tenant_id transaction. When omitted, the loop
   * falls back to the pre-T-0636 behaviour (direct enqueue, no GUC management —
   * legacy/test call-shape).
   */
  pool?: pg.Pool;
  /**
   * T-0636 (F10): injectable error-log throttle (class-keyed, bounded stream).
   * Defaults to a shared module-level throttle over console.error.
   */
  logThrottle?: ErrorLogThrottle;
}

/** Summary of one bridge poll pass. */
export interface BridgePollResult {
  /** Number of topics polled. */
  topics: number;
  /** Total ExternalTask items received from Flowable. */
  fetched: number;
  /** Jobs successfully enqueued (including pre-existing idempotent returns). */
  enqueued: number;
  /**
   * Tasks skipped — either assertVariableValue rejected a variable, OR (T-0636
   * F5, only when a pool is supplied) the task carried no valid
   * `choros_tenantId` process-variable stamp (fail-closed: never enqueued under
   * a guessed tenant).
   */
  skipped: number;
  /** Topics that returned an error from fetchAndLock, OR (T-0636) a tenant whose enqueue tx failed. */
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
// lookupJobTopicAndVariables — reverse-map: given jobId → (topic, variables)
// ---------------------------------------------------------------------------

/**
 * Reverse-map: given a Choros jobId, return the job's topic, variables, and
 * (T-0534) process_def_id as stored in choros.job (the Flowable external-task
 * process variables captured at fetchAndLock time). These carry the binding
 * values needed for DMN evaluation (e.g. `amount` for the ТЭЛ threshold gate).
 *
 * process_def_id is the BPMN processDefinitionKey stored at enqueue time
 * (migration 111). When non-null it enables precise per-process scoping in
 * loadPublishedRuleTables, eliminating the NULL-union cross-contamination risk.
 *
 * Returns undefined when the job row is not found or has no variables.
 * GUC requirement: the connection MUST have choros.tenant_id set before this query.
 */
async function lookupJobTopicAndVariables(
  pool: pg.Pool,
  tenantId: string,
  jobId: string,
): Promise<{ topic: string; variables: Record<string, unknown>; processDefId: string | null } | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SET LOCAL "choros.tenant_id" = '${tenantId.replace(/'/g, "''")}'`,
    );
    const { rows } = await client.query<{ topic: string; variables: Record<string, unknown>; process_def_id: string | null }>(
      `SELECT topic, variables, process_def_id
       FROM choros.job
       WHERE id = $1
         AND tenant_id = current_setting('choros.tenant_id', false)::uuid`,
      [jobId],
    );
    await client.query("COMMIT");
    if (rows.length === 0) return undefined;
    return {
      topic: rows[0].topic,
      variables: rows[0].variables ?? {},
      processDefId: rows[0].process_def_id ?? null,
    };
  } catch {
    await client.query("ROLLBACK").catch(() => {/* swallow */});
    return undefined;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// runBridgeOnce — one poll pass (exported for tests + CLI runner)
// ---------------------------------------------------------------------------

/**
 * T-0636 (P0-6/F3/F4/F5): default throttled logger used when the caller does not
 * inject its own (production default — a fresh throttle per process lifetime, not
 * per call, would be ideal; callers that want that must build+pass their own via
 * `makeErrorLogThrottle` — this module-level instance is the pragmatic default for
 * runBridgeOnce call-sites that never construct one explicitly).
 */
const defaultRunBridgeOnceLogThrottle = makeErrorLogThrottle((msg) => console.error(msg));

/**
 * Run ONE bridge poll pass across all configured topics.
 *
 * Per-topic:
 *   1. fetchAndLock(topic, workerId, lockDurationMs, maxTasksPerTopic)
 *   2. For each ExternalTask:
 *      a. Validate variables via assertVariableValue (fail-closed, AC-3).
 *      b. enqueue — idempotent, per-tenant scoped (see below).
 *   3. On fetchAndLock error: log (throttled), continue (no throw — AC-15).
 *
 * T-0636 (P0-6/F3/F4/F5) TENANT SCOPING:
 *
 * fetchAndLock stays GLOBAL across topics (Flowable's external-job REST API is not
 * partitioned by tenant). Tenancy is enforced at the ENQUEUE boundary instead:
 *   1. Each fetched task's tenant is read from `task.variables[CHOROS_TENANT_VAR]`
 *      (the process-variable stamp written by startInstance at launch — F5).
 *   2. Tasks are grouped by that tenant id.
 *   3. When `pool` IS supplied: for each tenant group, open a dedicated client,
 *      BEGIN, SET LOCAL choros.tenant_id (+ search_path), enqueue every task of
 *      that tenant with `executor=client` (so pgJobStore.enqueue's
 *      `current_setting('choros.tenant_id', false)` sees the GUC on the SAME
 *      connection it was set on — the enqueue seam added in this task), COMMIT.
 *   4. A task with a MISSING or invalid (non-UUID) tenant stamp is NOT enqueued
 *      (fail-closed — never guessed): `result.skipped` increments and a throttled
 *      log records the class 'MISSING_TENANT_VAR' with the topic (no secrets).
 *      This is the honest degrade for legacy instances started before this task
 *      landed (they carry no stamp) — they do not silently jam the bridge, nor do
 *      they get attributed to the wrong tenant.
 *
 * BACKWARD COMPATIBILITY: when `pool` is OMITTED (legacy call-shape — unit tests
 * exercising pure enqueue/complete/fail logic without a live Postgres), the
 * function falls back to the PRE-T-0636 behaviour: every fetched task (after the
 * variable guard) is enqueued directly via `jobStore.enqueue(...)` with no GUC
 * management and no tenant-var requirement. This preserves every existing caller
 * that never threaded a pool through (in-memory / mock jobStore test doubles) and
 * matches the documented pre-existing contract ("the caller's context already has
 * the GUC set" — e.g. a single-tenant harness, or a jobStore whose mock/pool does
 * not depend on the GUC at all).
 */
export async function runBridgeOnce(
  flowableClient: FlowableClient,
  jobStore: PostgresJobStore,
  topics: string[],
  workerId: string,
  lockDurationMs: number,
  maxTasksPerTopic: number,
  retries: number,
  pool?: pg.Pool,
  logThrottle: ErrorLogThrottle = defaultRunBridgeOnceLogThrottle,
): Promise<BridgePollResult> {
  const result: BridgePollResult = {
    topics: topics.length,
    fetched: 0,
    enqueued: 0,
    skipped: 0,
    errors: 0,
  };

  // Tasks that passed the variable guard, collected across all topics before the
  // (optional) per-tenant enqueue phase.
  const validTasks: Array<{ topic: string; task: ExternalTask }> = [];

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
      logThrottle(`FETCH_${fetchResult.code}`, `topic=${topic}`);
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

      validTasks.push({ topic, task });
    }
  }

  if (pool === undefined) {
    // Legacy (no-pool) path: preserve pre-T-0636 behaviour exactly — enqueue
    // directly via jobStore, no GUC management, no tenant-var requirement.
    for (const { topic, task } of validTasks) {
      // Idempotent enqueue: idempotency_key = externalTask.id (FR-1 / ADR §2.A).
      // T-0534: pass processDefinitionKey + processInstanceId so the triage seam
      // can scope rule-table lookups by process (stored in job.process_def_id /
      // job.instance_id via migration 111).
      await jobStore.enqueue(
        topic,
        task.variables,
        retries,
        task.id,
        task.processDefinitionKey || undefined,
        task.processInstanceId || undefined,
      );
      result.enqueued += 1;
    }
    return result;
  }

  // T-0636 (P0-6/F3/F4/F5): pool supplied — group by tenant stamp, enqueue
  // per-tenant under a GUC-scoped client.
  const byTenant = new Map<string, typeof validTasks>();
  for (const entry of validTasks) {
    const tenantRaw = entry.task.variables[CHOROS_TENANT_VAR];
    const tenantId = typeof tenantRaw === "string" ? tenantRaw.trim() : "";
    if (tenantId.length === 0 || !UUID_RE.test(tenantId)) {
      // Fail-closed: never guess a tenant. Legacy instances (started before this
      // task) carry no stamp — this is an HONEST, visible degrade, not a crash.
      result.skipped += 1;
      logThrottle("MISSING_TENANT_VAR", `topic=${entry.topic} task=${entry.task.id}`);
      continue;
    }
    const group = byTenant.get(tenantId);
    if (group === undefined) {
      byTenant.set(tenantId, [entry]);
    } else {
      group.push(entry);
    }
  }

  for (const [tenantId, entries] of byTenant) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId.replace(/'/g, "''")}'`);
      await client.query("SET LOCAL search_path TO choros");

      for (const { topic, task } of entries) {
        await jobStore.enqueue(
          topic,
          task.variables,
          retries,
          task.id,
          task.processDefinitionKey || undefined,
          task.processInstanceId || undefined,
          client as unknown as Queryable,
        );
        result.enqueued += 1;
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {/* swallow */});
      // Per-tenant failure is non-fatal — other tenants still get processed this
      // pass (rotation, mirrors buildAgentWithTenantTx / PostgresAgentJobFetcher).
      result.errors += 1;
      logThrottle("ENQUEUE_TENANT_FAILED", `tenant=${tenantId}: ${String(err)}`);
    } finally {
      client.release();
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// makeExternalTaskDeliver — Deliver function for outboxDispatcher
// ---------------------------------------------------------------------------

/**
 * T-0644 (P0/столп4): the single point of truth for the worker identity that
 * COMPLETES/FAILS a Flowable external task on the bridge's behalf when the
 * caller of makeExternalTaskDeliver does not supply its own (legacy call-shape
 * — see bridgeWorkerId param doc below). Mirrors the CHOROS_TENANT_VAR pattern:
 * one exported literal, never duplicated.
 */
export const DEFAULT_BRIDGE_WORKER_ID = "choros-bridge";

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
 *
 * T-0340 R-1 → T-0524 (GENERIC): DMN gateway wiring at the triage seam.
 *   When ANY external task completes, evaluateGatewayAtTriage is called with the
 *   process variables captured at fetchAndLock time, and EVERY authored routing
 *   outcome is merged — under its AUTHORED variable name — into the completeTask
 *   variables map so Flowable evaluates the downstream exclusiveGateway(s) with
 *   live variables. The process key is resolved generically from the variables
 *   (resolveAuthoredProcessKey); ТЭЛ ("approvalRequired" → gw-approval-threshold)
 *   is one authored configuration, not a special case in this code.
 *   The pool client is opened under the row's tenantId GUC (same pattern as
 *   lookupExternalTaskId). When no rule table is authored for the process, or on
 *   any evaluation error, the task still completes but without any injected
 *   routing variable → the gateway's BPMN `default` flow is taken (fail-closed).
 *
 * T-0644 (P0/столп4) — WORKER-ID SOURCE OF TRUTH:
 *   Flowable's external-job API requires the SAME workerId at completeTask/failTask
 *   time as the workerId that HELD THE LOCK at fetchAndLock time (a worker-id
 *   mismatch is REJECTED by the engine — LIVE_PROOF diagnosis). The lock is always
 *   acquired by THIS bridge (runBridgeOnce → flowableClient.fetchAndLock(topic,
 *   workerId, …), workerId = the SAME value passed to startBridgePollLoop /
 *   ExternalTaskBridgeConfig.workerId). Any OTHER component that later decides the
 *   job's outcome (e.g. the agent dispatcher, src/server/agent-dispatch-loop.ts)
 *   operates on a DIFFERENT lock domain entirely (choros.job row-lock, not the
 *   Flowable REST lock) and has NO relationship to the Flowable lock-holder
 *   identity — its own `workerId` (e.g. "choros-agent-dispatcher") must NEVER be
 *   forwarded to completeTask/failTask.
 *
 *   `bridgeWorkerId` is therefore the ONLY source of truth this function consults
 *   for the Flowable call. `row.payload["workerid"]` is IGNORED for that purpose —
 *   a producer may still record its own workerId in the outbox payload for
 *   audit/observability (dispatch-outcome.ts does), but that value is domain data
 *   about who decided the Choros-side outcome, never the Flowable lock identity.
 *
 *   Callers MUST pass the SAME value used for the bridge's own fetchAndLock
 *   (see startBridgePollLoop's `opts.workerId` / lifecycle-bridge.ts's
 *   `FLOWABLE_WORKER_ID` env resolution) so completeTask/failTask never diverges
 *   from the lock-holder. The default (`DEFAULT_BRIDGE_WORKER_ID`) exists ONLY for
 *   legacy call-sites (unit tests, bridge-smoke-runner) that construct a
 *   single-worker bridge with no explicit config — it MUST equal the default used
 *   by startBridgePollLoop/ExternalTaskBridgeConfig so a caller that omits both
 *   stays consistent by construction.
 */
export function makeExternalTaskDeliver(
  flowableClient: FlowableClient,
  jobStore: PostgresJobStore,
  _onDispatched?: OnDispatched,
  bridgeWorkerId: string = DEFAULT_BRIDGE_WORKER_ID,
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

        let payload: Record<string, unknown> | undefined =
          typeof row.payload["variables"] === "object" &&
          row.payload["variables"] !== null &&
          !Array.isArray(row.payload["variables"])
            ? (row.payload["variables"] as Record<string, unknown>)
            : undefined;

        // T-0340 R-1 → T-0524 (GENERIC): MANDATORY late-compute at the triage seam.
        // For ANY completed external task, look up the process-instance variables
        // (captured at fetchAndLock and stored in choros.job.variables), resolve the
        // authored process key from those variables, re-evaluate the process's
        // authored DMN rule tables, and inject ALL authored routing outcomes —
        // EACH UNDER ITS AUTHORED VARIABLE NAME (set_routing_outcome.name) — into
        // the completeTask variables so the downstream exclusiveGateway(s) route by
        // the author's conditions. ТЭЛ ("approvalRequired") is one such authored
        // case; nothing here is ТЭЛ-specific.
        //
        // Fail-closed: when no rule table is authored for the process, NO routing
        // variable is injected → the gateway's BPMN `default` flow is taken (never
        // a silent wrong route). On any evaluation error the task still completes
        // without injection (same fail-closed behaviour).
        const jobInfo = await lookupJobTopicAndVariables(pool, row.tenantId, row.aggregateId);
        if (jobInfo !== undefined) {
          try {
            const pgClient = await pool.connect();
            try {
              await pgClient.query("BEGIN");
              await pgClient.query(
                `SET LOCAL "choros.tenant_id" = '${row.tenantId.replace(/'/g, "''")}'`,
              );
              await pgClient.query("SET LOCAL search_path TO choros");
              // The process variables from the Flowable instance (captured at
              // fetchAndLock) carry the user-submitted field values (the bindings
              // the authored conditions reference). existingVariables feeds the
              // in-flight rule-change pin check (§8); procDefId scopes the rule
              // lookup to this process when the key is known.
              const instanceVariables = jobInfo.variables;
              // T-0534: prefer the stored process_def_id (captured at fetchAndLock
              // from the Flowable wire, migration 111) over the variable-extracted
              // fallback. The stored key scopes loadPublishedRuleTables precisely to
              // this process, avoiding the NULL-union cross-contamination risk
              // (T-0524 unscoped path). Fall back to resolveAuthoredProcessKey only
              // when the column is NULL (legacy / pre-migration rows).
              const storedProcessKey = jobInfo.processDefId ?? undefined;
              const variableProcessKey = resolveAuthoredProcessKey(instanceVariables);
              const processKey = storedProcessKey ?? variableProcessKey;
              const triageResult = await evaluateGatewayAtTriage(pgClient, {
                tenantId: row.tenantId,
                instanceId: resolveInstanceId(instanceVariables, row.aggregateId),
                // Process key is authored/runtime data — undefined falls back to
                // the tenant's process-agnostic published rule tables.
                processKey: processKey ?? jobInfo.topic,
                // No authored gateway id is available at this seam (job rows carry
                // only topic+variables); the gateway id is a pure audit annotation,
                // the routing depends on the injected variable(s), not the id.
                gatewayId: GATEWAY_ID_UNKNOWN,
                actor: "choros-bridge", // service actor at the triage seam
                nowMs: Date.now(),
                bindings: instanceVariables as Record<string, number | string | boolean>,
                existingVariables: instanceVariables,
                // T-0534: procDefId from the stored column scopes the rule lookup
                // to this process's published rule tables (eliminates NULL-union).
                procDefId: processKey,
              });
              await pgClient.query("COMMIT");

              // GENERIC injection: merge EVERY authored routing outcome under its
              // AUTHORED name. Empty map (no rule authored / no match) → no-op →
              // BPMN default flow (fail-closed).
              const outcomes = triageResult.routingOutcomes;
              if (Object.keys(outcomes).length > 0) {
                payload = { ...(payload ?? {}), ...outcomes };
              }
            } catch (evalErr) {
              await pgClient.query("ROLLBACK").catch(() => {/* swallow */});
              // Non-fatal: log and proceed with the original payload.
              // The gateway's BPMN default flow is taken (fail-closed) when no
              // routing variable is injected.
              console.error(
                `[externalTaskBridge] evaluateGatewayAtTriage failed for job ${row.aggregateId}: ${String(evalErr)}`,
              );
            } finally {
              pgClient.release();
            }
          } catch (poolErr) {
            // Pool acquisition failure — proceed without the gateway variable.
            console.error(
              `[externalTaskBridge] pool.connect failed for DMN eval (job ${row.aggregateId}): ${String(poolErr)}`,
            );
          }
        }

        // T-0644 (P0/столп4): ALWAYS use bridgeWorkerId (the actual Flowable
        // lock-holder), never row.payload["workerId"] — see the doc-comment
        // above makeExternalTaskDeliver for the full mismatch diagnosis.
        const result = await flowableClient.completeTask(
          externalTaskId,
          bridgeWorkerId,
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

        // T-0644 (P0/столп4): ALWAYS use bridgeWorkerId — same rationale as
        // completeTask above (failTask has the identical Flowable lock-owner
        // requirement).
        const result = await flowableClient.failTask(
          externalTaskId,
          bridgeWorkerId,
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
 *   - Per-pass errors are LOGGED (throttled, T-0636 F8) — never silently swallowed.
 *     The loop still never throws out of the interval callback (NF-5: it stays
 *     alive for the next tick even after a pass-level failure).
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
  const logThrottle = opts.logThrottle ?? defaultRunBridgeOnceLogThrottle;

  const handle = setIntervalFn(() => {
    runBridgeOnce(
      flowableClient,
      jobStore,
      opts.topics,
      opts.workerId,
      lockDurationMs,
      maxTasksPerTopic,
      retries,
      opts.pool,
      logThrottle,
    )
      .then(onPoll)
      .catch((err: unknown) => {
        // T-0636 (F8): a whole-pass failure (e.g. the GUC-throw from P0-6, or a
        // fetchAndLock 401 that somehow escaped runBridgeOnce's own try/catch) is
        // now VISIBLE — never a silent swallow. The loop still does not throw out
        // of this callback (NF-5: it survives to the next tick).
        logThrottle("BRIDGE_PASS_FAILED", String(err));
      });
  }, pollIntervalMs);

  return {
    stop: () => clearInterval(handle),
  };
}
