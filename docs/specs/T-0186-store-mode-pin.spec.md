# Spec · T-0186 — Store-mode pin: tests declare in-memory store explicitly

**Status:** ready  
**Phase:** SPEC  
**Date:** 2026-06-12  
**Source review:** `docs/reviews/T-0185.review.md` §3 (pre-existing ambient DATABASE_URL failures)

---

## 1. Context

`externalWorker.e2e.test.ts` (7 tests in the "default store" suite) and
`health.test.ts` (2 tests: AC-1 and AC-4) fail when `DATABASE_URL` is present in
the ambient environment (as in the combined `npm run fitness` + DB run).

Two distinct root causes identified in T-0185 review §3:

**Cause A — externalWorker.e2e "default store":** `createServer()` with no
arguments calls `createJobStore()`, which reads `process.env.DATABASE_URL`. With
an ambient URL it creates `PostgresJobStore`. The test does not set up the
`choros.tenant_id` GUC required by the Postgres store, so every job-store call
fails with `unrecognized configuration parameter "choros.tenant_id"`.

**Cause B — health.test.ts:** `handleRequest(req, res)` triggers lazy
construction of `_defaultRouter` via `buildRouter(createJobStore(), ...)`. With
ambient `DATABASE_URL`, `createJobStore()` returns a `PostgresJobStore`, and the
health handler is `async` (awaits `store.getQueueHealth()`). The test reads
`capture.body` synchronously — before the async handler resolves — so the body is
empty and `JSON.parse("")` throws `SyntaxError`.

Both tests are correct in their assertions. The fault is that neither test declares
its store requirement explicitly: they rely implicitly on `DATABASE_URL` being
absent. Deleting `process.env.DATABASE_URL` inside tests is fragile with vitest's
forked worker model (it only affects the current worker; other workers are
unaffected, and the isolation is not guaranteed by the test framework).

---

## 2. Design decision: explicit store-mode parameter

**FR-1 (chosen seam):** `createJobStore`, `createTimerStore`, `createOutboxStore`
accept an additive optional `mode?: 'auto' | 'memory'` parameter. When
`mode === 'memory'`, the function returns the in-memory variant regardless of
`DATABASE_URL`. Default (`'auto'` or omitted) preserves existing behaviour.

**FR-2:** `createServer` accepts an additive optional third parameter
`storeMode?: 'auto' | 'memory'`, which is forwarded to the three store
factories. Zero-arg and one-arg callers (`index.ts`) are unaffected.

**FR-3:** `handleRequest` (named export for synchronous unit tests) accepts an
additive optional third parameter `storeMode?: 'auto' | 'memory'`. The
module-level lazy router cache is keyed by mode so that a 'memory'-mode call and
a subsequent 'auto'-mode call both get a valid cached router without
cross-contamination.

**FR-4:** Tests pin the store mode explicitly:
- `externalWorker.e2e.test.ts` "default store" `beforeAll`: calls
  `createServer(undefined, undefined, 'memory')`.
- `health.test.ts` all four `handleRequest(req, res)` calls: pass `'memory'` as
  third argument.

**FR-5:** Production wiring (`src/index.ts`, `src/main.ts`) remains unchanged:
no caller passes `storeMode`, so the default `'auto'` path is used — env-based
store selection is preserved.

**FR-6:** `StoreMode` type is exported from `server.ts` for downstream use (tests
import type-safely without magic strings).

---

## 3. Non-functional requirements

**NF-1:** The change is purely additive — no existing call site is modified.
`createServer()`, `createJobStore()`, `createTimerStore()`, `createOutboxStore()`,
and `handleRequest()` all retain their existing zero/one-arg call signatures
unchanged (backward-compatible extension).

**NF-2:** Vitest runs tests in forked workers. `delete process.env.DATABASE_URL`
within a test file does NOT reliably isolate against ambient env in all workers.
The explicit `storeMode` parameter is immune to this: it is a function-argument
choice, not a process-environment mutation.

**NF-3:** The mode parameter must NOT change the `http.Server` interface or the
`Router` dispatch protocol. It only affects which store implementation is
constructed.

**NF-4:** The health handler is synchronous when `store` is `InMemoryJobStore`
(the `if (store instanceof PostgresJobStore)` branch is skipped, and neither
`timerStore` nor `outboxStore` is constructed in `'memory'` mode). This satisfies
the synchronous assertion pattern in `health.test.ts`.

**NF-5:** No new files are created. All changes land in `src/server.ts` and the
two test files.

---

## 4. Out of scope

- Changing the production env-selection logic (`'auto'` mode behaviour is frozen).
- Adding a `'postgres'` explicit mode (not needed; production uses env auto-detect).
- Changing `InMemoryJobStore` or `PostgresJobStore` themselves.
- Any changes to `ci/checks/*.sh` files.
- Fixing the underlying async/synchronous mismatch in `health.test.ts` beyond
  pinning the store mode (the synchronous test pattern is intentional and correct
  for in-memory stores).

---

## 5. Acceptance criteria

### AC-1 — externalWorker.e2e.test.ts: 18 tests pass WITHOUT DATABASE_URL (test)

`npm test` (no env) runs `src/__tests__/externalWorker.e2e.test.ts` and all 18
tests (17 in "default store" suite + 1 in "AC-6 lock-expiry" suite) pass. The
"default store" `beforeAll` calls `createServer(undefined, undefined, 'memory')`.

**Verifiable as:** test

### AC-2 — externalWorker.e2e.test.ts: 18 tests pass WITH ambient DATABASE_URL (test)

`DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm test`
runs `externalWorker.e2e.test.ts` and all 18 tests pass (store is pinned to
memory; ambient URL is irrelevant).

**Verifiable as:** test

### AC-3 — health.test.ts: 4 tests pass WITHOUT DATABASE_URL (test)

`npm test` (no env) runs `health.test.ts` and all 4 tests (AC-1..AC-4) pass.
`handleRequest(req, res, 'memory')` is used in all four test bodies.

**Verifiable as:** test

### AC-4 — health.test.ts: 4 tests pass WITH ambient DATABASE_URL (test)

`DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm test`
runs `health.test.ts` and all 4 tests pass (memory pin prevents async race).

**Verifiable as:** test

### AC-5 — Production wiring unchanged: createServer() still reads DATABASE_URL (test)

`createServer()` with no arguments still calls `createJobStore()` which reads
`process.env.DATABASE_URL` (default `'auto'` mode). Confirmed by reading
`src/server.ts` — the default parameter value for `storeMode` is `'auto'` (or
undefined, behaving as `'auto'`).

**Verifiable as:** fitness (static grep)

### AC-6 — TypeScript compiles cleanly (fitness)

`npx tsc --noEmit` exits 0 after all changes. No new type errors.

**Verifiable as:** fitness (static)

### AC-7 — All other tests unbroken (test)

`npm test` (no env) exits 0 with no regressions across the full vitest suite.
Pre-existing passing tests remain passing.

**Verifiable as:** test

### AC-8 — npm run fitness exits 0 (fitness)

`npm run fitness` exits 0. No fitness checks broken by the additive change.

**Verifiable as:** fitness

---

## 6. Blocking questions

None. The design is fully determined by the T-0185 review diagnosis and the
existing `createServer` parameter pattern (AC-6 suite already passes an explicit
`JobStore` to `createServer`).
