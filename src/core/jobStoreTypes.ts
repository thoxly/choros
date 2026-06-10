/**
 * Shared result-union types for JobStore.complete() and JobStore.fail().
 * Extracted to a separate module so both InMemoryJobStore and PostgresJobStore
 * can import them without circular dependencies (T-0114).
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
