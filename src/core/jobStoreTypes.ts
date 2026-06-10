/**
 * Shared result-union types for JobStore.complete() and JobStore.fail().
 * Extracted to a separate module so both InMemoryJobStore and PostgresJobStore
 * can import them without circular dependencies (T-0114).
 *
 * T-0063: SweepResult added for sweepExpiredLocks return type.
 */

/**
 * Gate-failure codes for complete and fail.
 * T-0028: RECORD_IN_PAYLOAD added — payload validation fail-closed (AC-2/FR-3).
 * All four original codes are unchanged (NF-2).
 */
export type ErrorCode =
  | "NOT_FOUND"
  | "NOT_LOCKED"
  | "LOCK_EXPIRED"
  | "NOT_OWNER"
  | "RECORD_IN_PAYLOAD";

/** Discriminated result union returned by JobStore.complete(). */
export type CompleteResult = { ok: true } | { ok: false; code: ErrorCode };

/** Discriminated result union returned by JobStore.fail(). */
export type FailResult = { ok: true } | { ok: false; code: ErrorCode };

/**
 * Result of a single sweepExpiredLocks pass (T-0063, E1.3).
 * reclaimed: job-ов переведено в CREATED (retries > 0 после декремента)
 * failed:    job-ов переведено в FAILED  (retries = 0)
 * incidents: outbox-строк вставлено (= reclaimed+failed; <N если ON CONFLICT DO NOTHING)
 */
export interface SweepResult {
  reclaimed: number;
  failed: number;
  incidents: number;
}
