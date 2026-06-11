/**
 * outboxDispatcher — two-phase outbox delivery loop (T-0062, E1.2).
 *
 * Образец T-0116 app_timer dispatcher 1:1 (poll-mode, no broker/Redis/Kafka).
 * See docs/design/T-0062-idempotency-outbox.adr.md §4.3.
 *
 * Phase-1 (cross-tenant, no GUC): store.pendingBuckets(now) → (tenant, count).
 * Phase-2 (per-tenant tx): store.claimBatch(tenant, limit) → 'dispatching';
 *   for each claimed row deliver(row); success → markDispatched + onDispatched;
 *   failure → markRetry(backoff, maxAttempts) → 'pending' or 'dead'.
 *
 * Idempotent delivery (at-least-once): the dispatcher may crash between the
 * external effect and markDispatched. Uniqueness is the CONSUMER's job via the
 * row idempotencyKey — NOT the dispatcher (FR-6). The dispatcher only guarantees
 * each row is delivered ≥1 time and advances state monotonically (T-0019).
 *
 * Pure orchestration — no SQL, no I/O of its own; the store and `deliver` carry
 * all side effects (testable via a fake store/deliver).
 */
import type { OutboxRow } from "./outboxTypes.js";
import type { PostgresOutboxStore } from "./postgres/pgOutboxStore.js";

/**
 * Delivery result. `idempotentSuccess` lets a consumer signal "the external
 * effect was already applied" (e.g. Flowable NOT_FOUND for an already-completed
 * task — дыра №4 спеки §2.2). Either `ok` or `idempotentSuccess` → 'dispatched'.
 */
export interface DispatchResult {
  ok: boolean;
  idempotentSuccess?: boolean;
  /** Optional error string recorded on the row when neither ok nor idempotentSuccess. */
  error?: string;
}

export type Deliver = (row: OutboxRow) => Promise<DispatchResult>;

/** Seam for T-0068: invoked after a row is marked 'dispatched'. Default no-op. */
export type OnDispatched = (row: OutboxRow) => Promise<void>;

export interface RunOutboxOptions {
  /** Max rows claimed per tenant per pass. */
  batchLimit: number;
  /** Attempts ceiling; on attempts+1 >= maxAttempts the row goes 'dead'. */
  maxAttempts: number;
  /** Backoff curve (ms) as a function of the row's CURRENT attempts (before increment). */
  backoff: (attempts: number) => number;
  /** T-0068 seam; default no-op. */
  onDispatched?: OnDispatched;
  /**
   * ADDITIVE OPTION (T-0170 E-N.3): per-row maxAttempts override.
   *
   * When provided, called after each failed delivery (before markRetry).
   * Return a number to override opts.maxAttempts for THIS row only; return
   * undefined to fall through to opts.maxAttempts (the default).
   *
   * Default: undefined (old behaviour preserved — opts.maxAttempts for all rows).
   *
   * Use-case: notification rows with IMMEDIATE_DEAD_ERROR_PREFIX must die on the
   * first attempt (maxAttempts=1), while external-task rows use the shared ceiling.
   */
  perRowMaxAttempts?: (row: OutboxRow, error: string | undefined) => number | undefined;
}

export interface RunOutboxResult {
  dispatched: number;
  failed: number;
  dead: number;
}

/**
 * Run ONE outbox dispatch pass across all tenants with pending rows.
 *
 * Returns counts for observability. Does not loop forever — the caller schedules
 * repeated passes (poll-mode, как app_timer dispatcher); each pass is bounded by
 * batchLimit per tenant.
 */
export async function runOutboxOnce(
  store: PostgresOutboxStore,
  deliver: Deliver,
  opts: RunOutboxOptions
): Promise<RunOutboxResult> {
  const now = Date.now();
  const onDispatched: OnDispatched = opts.onDispatched ?? (async () => {/* no-op */});

  const result: RunOutboxResult = { dispatched: 0, failed: 0, dead: 0 };

  // Phase-1: which tenants have due pending rows (no GUC, no row data).
  const buckets = await store.pendingBuckets(now);

  for (const { tenantId } of buckets) {
    // Phase-2: claim a batch for this tenant (→ 'dispatching').
    const rows = await store.claimBatch(tenantId, opts.batchLimit);

    for (const row of rows) {
      let res: DispatchResult;
      try {
        res = await deliver(row);
      } catch (err) {
        res = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      if (res.ok || res.idempotentSuccess) {
        const advanced = await store.markDispatched(row.tenantId, row.id);
        if (advanced) {
          await onDispatched(row);
          result.dispatched += 1;
        }
        // advanced === false → a concurrent dispatcher already finished it; skip.
      } else {
        // backoff is computed from the row's CURRENT attempts (markRetry increments).
        const backoffMs = opts.backoff(row.attempts);
        const errText = res.error ?? "delivery failed";
        // T-0170: perRowMaxAttempts may override the shared ceiling (e.g. maxAttempts=1
        // for IMMEDIATE_DEAD rows). Falls back to opts.maxAttempts when undefined.
        const rowMaxAttempts =
          opts.perRowMaxAttempts !== undefined
            ? (opts.perRowMaxAttempts(row, res.error) ?? opts.maxAttempts)
            : opts.maxAttempts;
        const outcome = await store.markRetry(
          row.tenantId,
          row.id,
          backoffMs,
          errText,
          rowMaxAttempts
        );
        if (outcome === "dead") result.dead += 1;
        else if (outcome === "pending") result.failed += 1;
        // 'noop' → row already moved by a concurrent pass; ignore.
      }
    }
  }

  return result;
}

/**
 * Default exponential backoff (как withRetry T-0064): base 1000ms, doubling,
 * capped at 5 minutes. `attempts` is the count BEFORE the current failure.
 */
export function defaultBackoff(attempts: number): number {
  const base = 1000;
  const cap = 5 * 60 * 1000;
  const ms = base * Math.pow(2, Math.max(0, attempts));
  return Math.min(ms, cap);
}

// ---------------------------------------------------------------------------
// startOutboxDispatcherLoop — background poll scheduler (образец startLockReclaimerLoop)
// ---------------------------------------------------------------------------

export interface OutboxDispatcherLoopOptions extends RunOutboxOptions {
  /** Poll interval (ms). Default 1000. */
  intervalMs?: number;
  /** Injectable setInterval for deterministic tests. */
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  /** Observability hook called after each pass. Default no-op. */
  onPass?: (result: RunOutboxResult) => void;
}

/**
 * Start a recurring outbox dispatch loop. First pass runs after `intervalMs`
 * (not immediately — does not block server startup), identical to
 * startLockReclaimerLoop (T-0063). `opts.onDispatched` is the firing point the
 * lifecycle-audit callback (T-0068) attaches to: it runs for each row AFTER a
 * durable markDispatched (exactly-once). Returns { stop } for graceful shutdown
 * (clearInterval; in-flight pass errors are swallowed so a degraded engine does
 * not crash the loop).
 */
export function startOutboxDispatcherLoop(
  store: PostgresOutboxStore,
  deliver: Deliver,
  opts: OutboxDispatcherLoopOptions,
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 1000;
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const onPass = opts.onPass ?? ((_r: RunOutboxResult) => {/* no-op */});
  const runOpts: RunOutboxOptions = {
    batchLimit: opts.batchLimit,
    maxAttempts: opts.maxAttempts,
    backoff: opts.backoff,
    ...(opts.onDispatched !== undefined ? { onDispatched: opts.onDispatched } : {}),
  };

  const handle = setIntervalFn(() => {
    runOutboxOnce(store, deliver, runOpts)
      .then(onPass)
      .catch(() => {/* swallow — degraded signal; loop continues next interval */});
  }, intervalMs);

  return {
    stop: () => clearInterval(handle),
  };
}
