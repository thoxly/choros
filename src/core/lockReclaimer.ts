/**
 * lockReclaimer — фоновый poll-цикл активного lock-reclaim (T-0063, E1.3).
 *
 * Образец T-0062 outboxDispatcher: двухфазный проход (cross-tenant bucket discovery
 * + per-tenant sweepExpiredLocks). Poll-mode (setInterval), Postgres-only, no broker.
 *
 * Clock injection + setIntervalFn injection для детерминированных тестов (NF-5/ADR §3.5).
 * FF-13: нет импорта из http/ — нет циклической зависимости core→http.
 */
import type { PostgresJobStore } from "./postgres/pgJobStore.js";
import type { PostgresOutboxStore } from "./postgres/pgOutboxStore.js";
import type { SweepResult } from "./jobStoreTypes.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LockReclaimerOptions {
  /** Частота прохода (мс). Дефолт 30_000. */
  sweepIntervalMs?: number;
  /** Инъектируемый setInterval для детерминированных тестов. */
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  /** Observability-хук: вызывается после каждого runSweepOnce. Дефолт no-op. */
  onSweep?: (result: RunSweepResult) => void;
}

export interface RunSweepResult {
  tenants: number;
  reclaimed: number;
  failed: number;
  incidents: number;
}

// ---------------------------------------------------------------------------
// runSweepOnce — one cross-tenant pass
// ---------------------------------------------------------------------------

/**
 * Run ONE sweep pass across all tenants with expired LOCKED jobs.
 *
 * Phase-1 (no GUC): jobStore.getLockedExpiredBuckets(now) → (tenantId, expiredCount).
 * Phase-2 (per-tenant): jobStore.sweepExpiredLocks(now, outboxStore, tenantId).
 *
 * Returns aggregated counts.
 */
export async function runSweepOnce(
  jobStore: PostgresJobStore,
  outboxStore: PostgresOutboxStore,
  bucketsFn: (before: number) => Promise<Array<{ tenantId: string; expiredCount: number }>>
): Promise<RunSweepResult> {
  // Snapshot time once for the bucket-discovery phase; sweepExpiredLocks uses
  // the injected clock internally (FF-14).
  const now = Date.now();
  const result: RunSweepResult = { tenants: 0, reclaimed: 0, failed: 0, incidents: 0 };

  const buckets = await bucketsFn(now);
  result.tenants = buckets.length;

  for (const { tenantId } of buckets) {
    let sweep: SweepResult;
    try {
      sweep = await jobStore.sweepExpiredLocks(outboxStore, tenantId);
    } catch {
      // Per-tenant error is non-fatal for the overall pass (other tenants continue).
      continue;
    }
    result.reclaimed += sweep.reclaimed;
    result.failed += sweep.failed;
    result.incidents += sweep.incidents;
  }

  return result;
}

// ---------------------------------------------------------------------------
// startLockReclaimerLoop — фоновый планировщик
// ---------------------------------------------------------------------------

/**
 * Start a recurring sweep loop. First pass runs after sweepIntervalMs (not immediately
 * — does not block server startup). Returns { stop } for graceful shutdown.
 */
export function startLockReclaimerLoop(
  jobStore: PostgresJobStore,
  outboxStore: PostgresOutboxStore,
  opts?: LockReclaimerOptions
): { stop: () => void } {
  const sweepIntervalMs = opts?.sweepIntervalMs ?? 30_000;
  const setIntervalFn = opts?.setIntervalFn ?? setInterval;
  const onSweep = opts?.onSweep ?? ((_r: RunSweepResult) => {/* no-op */});

  const bucketsFn = (before: number) =>
    jobStore.getLockedExpiredBuckets(before);

  const handle = setIntervalFn(() => {
    runSweepOnce(jobStore, outboxStore, bucketsFn)
      .then(onSweep)
      .catch(() => {/* swallow — degraded signal is in workerIncidents health metric */});
  }, sweepIntervalMs);

  return {
    stop: () => clearInterval(handle),
  };
}
