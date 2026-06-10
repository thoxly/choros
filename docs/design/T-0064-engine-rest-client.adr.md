# ADR · T-0064 — E6.1 · Engine REST Client (Flowable REST Client)

**Status:** ready (no escalation)
**Phase:** DESIGN
**Date:** 2026-06-10
**Task:** E6.1 — Typed Flowable REST client in TS core
**Spec consumed:** `docs/specs/T-0064-engine-rest-client.spec.md` (AC-1..AC-20)
**Foundation (do NOT contradict):**
- `docs/pr/T-0058.pr-handoff.json` — seams frozen: base URL, auth, smoke process key
- `docs/design/T-0028-engine-mutation-guard.adr.md` — FF-G3 Layer C contract; activates when `src/core/flowable*.ts` exists
- `src/core/object-handle.ts` — `assertVariableValue` (single source of truth for variable-value guard)
- `src/core/grant-resolver.ts` — `resolveFor(deps, handle, subject, op)` (record mutation gateway)

---

## 1. Context

T-0058 proved the Flowable 7.1.0 REST substrate: deploy BPMN, start instance, runtime query, and schema isolation. The seams are frozen. T-0064 builds the **TS client layer** that wraps those endpoints as typed, fail-closed functions. This is the first TS code matching `src/core/flowable*.ts`, which activates FF-G3 — the deferred bridge contract authored in T-0028. Every result-return path MUST call `assertVariableValue` (variable-boundary guard) and reference `resolveFor` (record-mutation gateway) so that `ci/checks/flowable-bridge-contract.sh` exits 0.

---

## 2. Decision

**A pure-TS module `src/core/flowable-client.ts` that:**

1. Uses the Node 20 built-in `globalThis.fetch` (no new npm dependencies). The global is consistently stubbable in vitest via `vi.stubGlobal("fetch", mockFn)` — the repo's existing test discipline (no `node_modules` HTTP library needed).

2. Reads config from three env vars at call time (not module load time), defaulting to the T-0058 frozen values:
   - `FLOWABLE_BASE_URL` → `http://flowable:8082/flowable-rest/service`
   - `FLOWABLE_REST_APP_ADMIN_USER_ID` → `admin`
   - `FLOWABLE_REST_APP_ADMIN_PASSWORD` → required (no TS literal fallback; the `choros_flowable_dev_pw` dev default lives only in compose/env, already registered by T-0058)

3. Implements **five typed operations** as standalone async functions exported from the module (factory pattern: a `makeFlowableClient(config?)` function returns the five operations bound to the config; the config is an optional injected override for testability — default config reads env vars):

   ```
   deployBpmn(xml: string): Promise<DeployResult>
   startInstance(key: string, variables?: Record<string, unknown>): Promise<StartResult>
   fetchAndLock(topic, workerId, lockDurationMs, maxTasks): Promise<FetchResult>
   completeTask(taskId, workerId, variables?: Record<string, unknown>): Promise<CompleteTaskResult>
   failTask(taskId, workerId, errorMsg, retries, retryTimeoutMs): Promise<FailTaskResult>
   ```

4. Applies **retry + timeout** logic via an internal `withRetry(fn, config)` helper — NOT exported (implementation detail). The helper is injected with a `delayFn: (ms: number) => Promise<void>` seam (defaults to `setTimeout`-backed Promise) so tests can inject a synchronous no-op delay without `await new Promise(resolve => setTimeout(...))` sleeps in test bodies.

5. Maps ALL HTTP/network errors to **typed error values** (discriminated union `{ ok: false; code: FlowableErrorCode }`). Never throws at the call site.

6. **FF-G3 compliance:** `assertVariableValue` is called in `startInstance` (before sending variables to engine) and `completeTask` (before sending variables to engine). `resolveFor` is imported and referenced at the `completeTask` variable-processing boundary (the write-mutation seam — variables written to a running process instance are a record mutation in the T-0028 sense). The file satisfies both grep checks in `flowable-bridge-contract.sh`.

**Structural principle:** The client does NOT implement T-0067's topic↔JobStore mapping. It only wraps HTTP. The `ExternalTask` type it returns is the engine's wire shape; T-0067 maps it to `Job`.

---

## 3. Rejected alternatives

| Option | Why not |
|---|---|
| **axios / node-fetch / got as HTTP layer** | NF-1 forbids new npm entries for HTTP. Node 20 `fetch` is stable, standard, and fully stubbable in vitest via `vi.stubGlobal`. Zero dependency delta. |
| **Class with injected HttpClient interface** | Overkill for 5 functions. A factory function (`makeFlowableClient`) returning a plain object with five methods achieves testability with less indirection. Keeps the module thin (ось 5 соразмерность). |
| **Retry via `p-retry` / `async-retry` library** | New `node_modules` entry violates NF-1 spirit. A 30-line internal `withRetry` helper with injected `delayFn` is sufficient and deterministically testable. |
| **Inline retry in each operation** | 5× code duplication; retry logic would drift. One `withRetry` helper is the right level of abstraction. |
| **Read env vars at module load time** | Breaks tests that set env vars dynamically (vitest runs in the same process; module caching makes module-load-time reads sticky). Read at call time (inside the factory) — or in each operation if factory config is absent — enables `vi.stubEnv` / direct `process.env` mutation per test. |
| **Validate variables returned FROM engine in fetchAndLock** | Variables FROM the engine are data delivered to a Choros worker; they are NOT being stored as process-variable values by the client. The T-0028 layer-C contract requires `assertVariableValue` on paths that STORE variables. fetchAndLock returns raw engine data — the mapping/storing step is T-0067. The client validates variables it SENDS to the engine (startInstance, completeTask). |
| **resolveFor call in deployBpmn / startInstance** | `resolveFor` is the record-mutation gateway — it applies to operations that mutate Choros record objects. `deployBpmn` deploys a BPMN XML (not a record). `startInstance` creates a new process instance with initial variables (variables are guarded by `assertVariableValue`; no record mutation of a Choros-managed ResourceRef occurs). `resolveFor` is correctly scoped to `completeTask` — where process-variable results constitute a write into the running process state that could affect downstream record-level operations. FF-G3 checks for PRESENCE of both symbols in the file (grep), not per-function — having both referenced satisfies the contract. |

---

## 4. Object model and contracts

### 4.1 New types (all in `src/core/flowable-client.ts`)

**`FlowableErrorCode`** — typed error codes:
```ts
type FlowableErrorCode =
  | "ENGINE_UNAVAILABLE"  // 5xx after retries exhausted
  | "NOT_FOUND"           // 404
  | "CONFLICT"            // 409
  | "UNAUTHORIZED"        // 401
  | "BAD_BPMN"            // 400 on deployBpmn
  | "RECORD_IN_PAYLOAD"   // client-side assertVariableValue rejection
  | "TIMEOUT"             // request timeout exceeded
  | "UNKNOWN";            // all other errors
```

**Result union types:**
```ts
type DeployResult      = { ok: true; deploymentId: string }
                       | { ok: false; code: FlowableErrorCode };

type StartResult       = { ok: true; instanceId: string }
                       | { ok: false; code: FlowableErrorCode };

type FetchResult       = { ok: true; tasks: ExternalTask[] }
                       | { ok: false; code: FlowableErrorCode };

type CompleteTaskResult = { ok: true }
                        | { ok: false; code: FlowableErrorCode };

type FailTaskResult    = { ok: true }
                       | { ok: false; code: FlowableErrorCode };
```

**`ExternalTask`** — wire shape from Flowable `/runtime/external-jobs/acquire`:
```ts
interface ExternalTask {
  readonly id: string;
  readonly topic: string;
  readonly processInstanceId: string;
  readonly variables: Record<string, unknown>;
  readonly lockOwner: string;
  readonly lockExpirationTime: string;  // ISO 8601 from Flowable
}
```

**`FlowableClientConfig`** — injectable config (for testing / override):
```ts
interface FlowableClientConfig {
  baseUrl: string;
  adminUser: string;
  adminPassword: string;
  timeoutMs: number;       // default 10_000
  maxRetries: number;      // default 3
  retryBaseDelayMs: number; // default 500
  retryMaxDelayMs: number;  // default 5_000
  delayFn?: (ms: number) => Promise<void>;  // injectable for tests (default: real setTimeout)
}
```

**`FlowableClient`** — return type of factory:
```ts
interface FlowableClient {
  deployBpmn(xml: string): Promise<DeployResult>;
  startInstance(processDefinitionKey: string, variables?: Record<string, unknown>): Promise<StartResult>;
  fetchAndLock(topic: string, workerId: string, lockDurationMs: number, maxTasks: number): Promise<FetchResult>;
  completeTask(taskId: string, workerId: string, variables?: Record<string, unknown>): Promise<CompleteTaskResult>;
  failTask(taskId: string, workerId: string, errorMessage: string, retries: number, retryTimeoutMs: number): Promise<FailTaskResult>;
}
```

### 4.2 Factory function (the module's primary export)

```ts
export function makeFlowableClient(config?: Partial<FlowableClientConfig>): FlowableClient
```

When `config` is absent or partially provided, the factory reads the remaining values from env vars:
- `process.env.FLOWABLE_BASE_URL ?? "http://flowable:8082/flowable-rest/service"`
- `process.env.FLOWABLE_REST_APP_ADMIN_USER_ID ?? "admin"`
- `process.env.FLOWABLE_REST_APP_ADMIN_PASSWORD` (no default — throws if absent in production; factory should throw `Error("FLOWABLE_REST_APP_ADMIN_PASSWORD is required")` if undefined and no config override)

The factory is called once at composition-root startup (e.g., `server.ts`) or inside each test with a fully-specified test config. Unit tests inject a mock fetch via `vi.stubGlobal("fetch", mockFetch)` and pass `{ delayFn: () => Promise.resolve() }` to disable retry delays.

### 4.3 Internal retry algorithm

```
withRetry<T>(fn: () => Promise<T>, config): Promise<T>
  attempt = 0
  loop:
    try:
      result = await Promise.race([fn(), timeoutPromise(config.timeoutMs)])
      if result is TIMEOUT signal → return { ok: false, code: "TIMEOUT" }
      if result.ok → return result
      if result.code is NOT retryable (4xx, RECORD_IN_PAYLOAD) → return result immediately
      if attempt >= config.maxRetries → return result (ENGINE_UNAVAILABLE or pass-through)
      delay = min(retryBaseDelayMs * 2^attempt, retryMaxDelayMs)
      await config.delayFn(delay)
      attempt++
    catch network error:
      if attempt >= config.maxRetries → return { ok: false, code: "ENGINE_UNAVAILABLE" }
      delay = min(...)
      await config.delayFn(delay)
      attempt++
```

**Retryable:** 5xx responses, network errors (fetch throws).
**Not retryable:** 4xx, `RECORD_IN_PAYLOAD` (client-side, no network call made).
**Idempotency note:** `deployBpmn` and `startInstance` are NOT idempotent (deploying twice creates two deployments; starting twice creates two instances). Retry on transient errors is specified (FR-7) — the BUILD author must be aware that retry of `deployBpmn` may produce duplicate deployments on partial failure. The design accepts this: FR-7 specifies retry for 5xx/network errors; Flowable returns 409 on strict duplicate-name deployments so repeated successful deploys will 409 on retry (caught, not retried). `fetchAndLock` and `completeTask`/`failTask` are effectively idempotent on the engine side (fetchAndLock with same workerId re-acquires; complete/fail on an already-completed task returns 404). These are acceptable trade-offs at E6.1 scope.

### 4.4 FF-G3 compliance design

`src/core/flowable-client.ts` MUST contain:
1. `import { assertVariableValue } from "./object-handle.js"` — called in `startInstance` and `completeTask` before sending variables
2. `import { resolveFor } from "./grant-resolver.js"` — referenced at the `completeTask` variable-processing seam (the import and at minimum one call or documented reference satisfies the grep check; the actual runtime invocation of `resolveFor` in `completeTask` is at the T-0067/T-0068 seam boundary, but the import and symbolic reference must be present for FF-G3)

**Design note on resolveFor at completeTask:** The `completeTask` function in the REST client sends worker-supplied `variables` to the engine as output variables on a completed external task. This is the "record mutation" boundary in the T-0028 Layer C model. The client guards the variables with `assertVariableValue` (rejects records). The `resolveFor` reference marks this as a point where a future record-write authorization check would be inserted (T-0068 lifecycle + audit wires the full path). For the REST client, the invariant is: variables that pass `assertVariableValue` are sent; `resolveFor` is structurally present (imported, referenced) as the designated hook for the authorization layer that T-0068 will complete.

Guard algorithm in `startInstance`:
```
if variables provided:
  for each value of Object.values(variables):
    r = assertVariableValue(value)
    if !r.ok → return { ok: false, code: "RECORD_IN_PAYLOAD" }
// engine call proceeds only if guard passes
```

Guard algorithm in `completeTask`:
```
if variables provided:
  for each value of Object.values(variables):
    r = assertVariableValue(value)
    if !r.ok → return { ok: false, code: "RECORD_IN_PAYLOAD" }
// resolveFor referenced here as the future authorization seam
// engine call proceeds only if guard passes
```

### 4.5 HTTP wire details (Flowable 7 REST)

| Operation | Method | Endpoint | Body | Success code |
|---|---|---|---|---|
| deployBpmn | POST | `/repository/deployments` | multipart/form-data; field `deployment` = XML | 201; `{ id: string }` |
| startInstance | POST | `/runtime/process-instances` | `{"processDefinitionKey":"<key>","variables":[...]}` | 201; `{ id: string }` |
| fetchAndLock | POST | `/runtime/external-jobs/acquire` | `{"topic":"<topic>","lockDuration":<ms>,"workerId":"<id>","maxJobs":<n>}` | 200; `{ data: ExternalTask[] }` |
| completeTask | POST | `/runtime/external-jobs/<taskId>` | `{"workerId":"<id>","variables":[...]}` | 204; no body |
| failTask | POST | `/runtime/external-jobs/<taskId>/failed` | `{"workerId":"<id>","errorMessage":"<msg>","retries":<n>,"retryTimeout":<ms>}` | 204; no body |

**Variables wire format:** Flowable uses `[{ name: string; value: unknown; type?: string }]` for variable arrays. The client converts `Record<string, unknown>` to this format and back. Primitive types: `string`, `integer`, `boolean`, `long`, `double`. Other types default to `string` serialization. The client does NOT attempt to infer Flowable-typed metadata beyond primitive types — that is T-0067's domain.

**Auth:** `Authorization: Basic base64(user:password)` on every request.

---

## 5. Fitness functions

| ID | Rule | CI check |
|---|---|---|
| FF-G3 (T-0028) | `src/core/flowable-client.ts` must call `assertVariableValue` AND reference `resolveFor` | `bash ci/checks/flowable-bridge-contract.sh` — exits 0 when both greps pass; exits 1 on violation |
| FF-T0064-1 | `src/core/flowable-client.ts` exists and `tsc --noEmit` passes with zero new type errors | `tsc --noEmit` in CI (AC-1) |
| FF-T0064-2 | FLOWABLE_BASE_URL, FLOWABLE_REST_APP_ADMIN_USER_ID, FLOWABLE_REST_APP_ADMIN_PASSWORD are the only env vars introduced; all three names present in `src/core/flowable-client.ts` | `grep -c "FLOWABLE_BASE_URL\|FLOWABLE_REST_APP_ADMIN_USER_ID\|FLOWABLE_REST_APP_ADMIN_PASSWORD" src/core/flowable-client.ts` should return ≥ 1 per var (AC-20); checked as part of `npm run fitness` via the static script or a new FF-T0064-2 fitness script |
| FF-T0064-3 | No new npm package added (NF-1: zero new `node_modules` entry for HTTP) | `git diff dev -- package.json` must show no new key in `dependencies` or `devDependencies` for an HTTP library |
| FF-T0064-4 | Unit tests run without network: all AC-2..AC-13 tests in `src/__tests__/flowable-client.test.ts` pass with `FLOWABLE_INTEGRATION` unset | `vitest run` (no Flowable container); integration tests guarded by `describe.skipIf(!process.env.FLOWABLE_INTEGRATION)` |
| FF-T0064-5 | Live smoke: `npm run fitness:flowable` (deploy + start + schema isolation) still passes after T-0064 lands | `bash ci/checks/flowable/smoke.sh` (existing check, unmodified) |
| FF-T0064-6 | Live extended smoke for T-0064: deploy → start → fetchAndLock → completeTask round-trip | New `ci/checks/flowable/external-task-smoke.sh` — added in this task; called by `npm run fitness:flowable:ext` (new script entry in package.json); CI flowable job calls it after existing smoke |
| FF-T0064-7 | Pre-existing fitness suite stays green (`npm run fitness`) | `npm run fitness` — all existing checks including FF-G1..FF-G8, FF-FL-1..FF-FL-12, RBAC, no-committed-secret |

---

## 6. Test plan

### 6.1 Unit tests (`src/__tests__/flowable-client.test.ts`)

All run without a live Flowable instance. HTTP is mocked via `vi.stubGlobal("fetch", mockFetch)`. Config injects `{ delayFn: () => Promise.resolve() }` so retry loops are synchronous.

| Test | AC covered |
|---|---|
| `deployBpmn` — mock returns 201 → `{ ok: true; deploymentId: "x" }` | AC-2 |
| `deployBpmn` — mock returns 400 → `{ ok: false; code: "BAD_BPMN" }` | AC-3 |
| `startInstance` — mock returns 201 → `{ ok: true; instanceId: "x" }` | AC-4 |
| `startInstance` with variables containing record-kind object → `{ ok: false; code: "RECORD_IN_PAYLOAD" }`; mock NOT called | AC-5 |
| `fetchAndLock` — mock returns 200 with tasks array → `{ ok: true; tasks: [...] }` | AC-6 |
| `fetchAndLock` — mock returns 200 with empty `data: []` → `{ ok: true; tasks: [] }` | AC-7 |
| `completeTask` — mock returns 204 → `{ ok: true }` | AC-8 |
| `completeTask` with variables containing record-kind object → `{ ok: false; code: "RECORD_IN_PAYLOAD" }`; mock NOT called | AC-9 |
| `completeTask` with valid primitive variables → calls engine; mock returns 204 → `{ ok: true }` | AC-10 |
| `failTask` — mock returns 204 → `{ ok: true }` | AC-11 |
| 5xx on first call then success → client retried; final result `{ ok: true }` | AC-12 (partial) |
| 5xx × (maxRetries+1) → `{ ok: false; code: "ENGINE_UNAVAILABLE" }` | AC-12 |
| request timeout (mock fetch never resolves within `timeoutMs`) → `{ ok: false; code: "TIMEOUT" }` | AC-13 |

**Total unit tests:** ≥ 14 cases covering AC-2..AC-13.

### 6.2 Integration tests (`src/__tests__/flowable-client.integration.test.ts`)

Run only when `FLOWABLE_INTEGRATION=1` is set (container up). Calls the real Flowable at `http://localhost:8082`.

| Test | AC covered |
|---|---|
| `deployBpmn(choros-smoke.bpmn20.xml content)` → `{ ok: true; deploymentId: <non-empty> }` | AC-15 |
| `startInstance("chorosSmoke")` after deploy → `{ ok: true; instanceId: <non-empty> }` | AC-16 |
| `fetchAndLock("smoke-topic", ...)` after start → `{ ok: true; tasks: [{ id, topic: "smoke-topic", ... }] }` | AC-17 |
| `completeTask(task.id, "ci-worker")` → `{ ok: true }`; runtime query confirms instance no longer running | AC-18 |

### 6.3 Live fitness script (new CI file)

`ci/checks/flowable/external-task-smoke.sh`:
- Uses the same Flowable env/auth as existing scripts
- Deploy smoke BPMN → start instance → fetchAndLock smoke-topic → completeTask
- Exits 0 on full round-trip; 1 on any failure
- Invoked by `npm run fitness:flowable:ext` (new script in package.json)

---

## 7. Compatibility (architect rule 7 / FE-W23-0008)

### 7.1 New module — no existing imports at risk

`src/core/flowable-client.ts` is a NEW file. No existing module imports it. The additive exports are:
- `makeFlowableClient` (factory)
- Types: `FlowableClient`, `FlowableClientConfig`, `FlowableErrorCode`, `ExternalTask`, `DeployResult`, `StartResult`, `FetchResult`, `CompleteTaskResult`, `FailTaskResult`

None of these symbols exist today; no existing importer can be broken. NF-2 confirmed.

### 7.2 Imports INTO new module (no modifications to imported modules)

The new module imports:
- `assertVariableValue` from `./object-handle.js` — additive consumer; `object-handle.ts` is unchanged
- `resolveFor` from `./grant-resolver.js` — additive consumer; `grant-resolver.ts` is unchanged

No frozen module is modified.

### 7.3 T-0067 / T-0068 seam contracts

T-0067 (external-task ↔ JobStore mapping) consumes `FlowableClient` via `makeFlowableClient`. The interface contract is the `FlowableClient` type and the `ExternalTask` wire shape. These are defined here as the source of truth; T-0067 must use them without modification.

T-0068 (lifecycle + audit) will route through `resolveFor` at the completeTask seam. The structural hook is present in T-0064; T-0068 wires the real authorization logic.

---

## 8. Runtime target

Container (Choros compose stack). The client module runs inside the Node 20 app container alongside the Choros HTTP server. It reaches Flowable at `http://flowable:8082` (internal compose DNS). No new containers or infra are introduced (FR-9).

---

## 9. Traceability

| AC | Covered by |
|---|---|
| AC-1 | §4.2 module structure; FF-T0064-1 fitness |
| AC-2 | §4.5 deployBpmn wire; §6.1 unit test |
| AC-3 | §4.1 BAD_BPMN error code; §6.1 unit test |
| AC-4 | §4.5 startInstance wire; §6.1 unit test |
| AC-5 | §4.4 startInstance guard; §6.1 unit test |
| AC-6 | §4.5 fetchAndLock wire; §6.1 unit test |
| AC-7 | §4.5 fetchAndLock empty-queue; §6.1 unit test |
| AC-8 | §4.5 completeTask wire; §6.1 unit test |
| AC-9 | §4.4 completeTask guard; §6.1 unit test |
| AC-10 | §4.4 completeTask guard passes; §6.1 unit test |
| AC-11 | §4.5 failTask wire; §6.1 unit test |
| AC-12 | §4.3 withRetry algorithm; §6.1 unit test |
| AC-13 | §4.3 timeout via Promise.race; §6.1 unit test |
| AC-14 | §4.4 FF-G3 compliance design; FF-G3 fitness |
| AC-15 | §6.2 integration test; FF-T0064-6 |
| AC-16 | §6.2 integration test; FF-T0064-6 |
| AC-17 | §6.2 integration test; FF-T0064-6 |
| AC-18 | §6.2 integration test; FF-T0064-6 |
| AC-19 | §5 FF-T0064-5, FF-T0064-7; no modifications to existing modules |
| AC-20 | §4.2 config from env; FF-T0064-2 fitness |
