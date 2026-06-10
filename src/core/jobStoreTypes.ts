/**
 * Shared result-union types for JobStore.complete() and JobStore.fail().
 * Extracted to a separate module so both InMemoryJobStore and PostgresJobStore
 * can import them without circular dependencies (T-0114).
 */

/** The four gate-failure codes shared by complete and fail. */
export type ErrorCode = "NOT_FOUND" | "NOT_LOCKED" | "LOCK_EXPIRED" | "NOT_OWNER";

/** Discriminated result union returned by JobStore.complete(). */
export type CompleteResult = { ok: true } | { ok: false; code: ErrorCode };

/** Discriminated result union returned by JobStore.fail(). */
export type FailResult = { ok: true } | { ok: false; code: ErrorCode };
