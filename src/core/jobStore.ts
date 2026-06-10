/**
 * Public surface of the JobStore subsystem (T-0114).
 *
 * Re-exports InMemoryJobStore as `JobStore` alias — all existing importers of
 * `JobStore` (unit tests, HTTP handlers) continue to work unchanged (FF-5).
 * Frozen unit-test files (jobStore.test.ts, fetchLock.test.ts, completeFail.test.ts)
 * import `{ JobStore }` from here and instantiate InMemoryJobStore transparently.
 *
 * PostgresJobStore is exported separately for production wiring in server.ts.
 * Result-union types (CompleteResult, FailResult, ErrorCode) are re-exported here
 * for backward compatibility with all existing importers (FF-6).
 */

// Backward-compat alias: `JobStore` = InMemoryJobStore (FF-5)
export { InMemoryJobStore as JobStore } from "./inMemoryJobStore.js";

// Named Postgres implementation for production wiring
export { PostgresJobStore } from "./postgres/pgJobStore.js";

// Result-union types — re-exported from jobStoreTypes.ts (FF-6)
export type { CompleteResult, FailResult, ErrorCode } from "./jobStoreTypes.js";
