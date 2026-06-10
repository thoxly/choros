# Spec · T-0064 — E6.1 · REST-клиент движка (Engine REST Client)

**Phase:** SPEC · **Status:** ready (no blocking questions) · **Date:** 2026-06-10
**Task:** E6.1 — Typed Flowable REST client in TS core: deploy BPMN, start process instance,
fetch-and-lock external tasks, complete external task, fail external task
**Raw TZ:** `playbooks/mvp-backlog.md` §E6.1
**Deps:** T-0058 (Flowable service live — seam frozen in `docs/pr/T-0058.pr-handoff.json`),
T-0028 (engine mutation guard — FF-G3 dormant contract activates at `src/bridge/` or
`src/core/flowable*.ts` creation)
**Consumed by:** T-0067 (E6.2 external-task ↔ JobStore mapping), T-0068 (E6.3 lifecycle +
audit), E8.2 (BPMN deploy from modeller)
**Seam refs:**
- `docs/pr/T-0058.pr-handoff.json` §downstream_seams_frozen.T-0064_rest_client`
- `ci/checks/flowable-bridge-contract.sh` (FF-G3) — activates for this task
- `docs/design/T-0028-engine-mutation-guard.adr.md` §8 (Layer C invariants)

---

## 0. Pre-conditions (inputs frozen by T-0058)

T-0058 is merged to dev. The following seams are frozen and MUST NOT be changed by T-0064:

| Seam | Value |
|---|---|
| Base URL (internal compose DNS) | `http://flowable:8082/flowable-rest/service` |
| Base URL (host-side, CI) | `http://localhost:8082/flowable-rest/service` |
| Auth scheme | HTTP Basic: user `admin`, password `${FLOWABLE_REST_APP_ADMIN_PASSWORD}` |
| Smoke process key | `chorosSmoke` |
| Smoke external-task topic | `smoke-topic` |
| BPMN deploy endpoint | `POST /repository/deployments` (multipart, `deployment` field) |
| Start instance endpoint | `POST /runtime/process-instances` (JSON `{"processDefinitionKey":"..."}`) |

The Flowable REST image (`flowable/flowable-rest:7.1.0`) is proven: deploy BPMN → HTTP 201,
start instance → HTTP 201, runtime query → total ≥ 1. External-task fetch-and-lock and
complete endpoints (`/runtime/external-jobs/*`) are part of the same Flowable 7 REST surface
(Swagger confirmed in spike).

---

## 1. Summary

Build a **typed TypeScript REST client** (`src/core/flowable-client.ts`) that encapsulates
all Flowable REST API calls needed by the Choros engine adapter layer: deploy a BPMN process
definition, start a process instance, fetch-and-lock external tasks by topic, complete an
external task (with optional payload), and fail an external task (with retry count). The client
reads its base URL and credentials from environment variables, applies configurable retry /
timeout behaviour, maps HTTP errors to typed error values, and is covered by unit tests with a
mock HTTP layer. Live integration tests run against the Flowable container started in CI.

The client is **the first code that triggers FF-G3** (T-0028 bridge contract): the file
`src/core/flowable-client.ts` matches the activation pattern `src/core/flowable*.ts`.
Therefore every result-return path in this file MUST call `assertVariableValue` (from
`src/core/object-handle.ts`) before storing any process-variable value, and every record
mutation MUST route through `resolveFor` (from `src/core/grant-resolver.ts`). FF-G3 will
be active and green as part of this task's CI gate.

---

## 2. Functional requirements

- **FR-1 — `deployBpmn(xml: string): Promise<DeployResult>`**
  Deploy a BPMN XML document to the engine.
  Success: HTTP 201 → `{ ok: true; deploymentId: string }`.
  Failure: typed error value; details below (§3).

- **FR-2 — `startInstance(processDefinitionKey: string, variables?: Record<string, unknown>): Promise<StartResult>`**
  Start a new process instance by process definition key, optionally supplying initial
  process variables. Variables MUST be validated with `assertVariableValue` before they are
  sent to the engine (fail-closed; no variable of record type may be injected into an
  instance at start time).
  Success: HTTP 201 → `{ ok: true; instanceId: string }`.
  Failure: typed error value.

- **FR-3 — `fetchAndLock(topic: string, workerId: string, lockDurationMs: number, maxTasks: number): Promise<FetchResult>`**
  Fetch and lock up to `maxTasks` external tasks by topic. Uses the Flowable 7 REST
  endpoint (`POST /runtime/external-jobs/acquire`). Returns the list of locked tasks or an
  empty array (never throws on an empty queue).
  Success: HTTP 200 → `{ ok: true; tasks: ExternalTask[] }`.

- **FR-4 — `completeTask(taskId: string, workerId: string, variables?: Record<string, unknown>): Promise<CompleteTaskResult>`**
  Complete a locked external task. If `variables` are provided they MUST be validated with
  `assertVariableValue` before they are sent (same guard as FR-2 — fail-closed; on failure
  return `{ ok: false; code: "RECORD_IN_PAYLOAD" }` and do NOT call the engine).
  Success: HTTP 204 → `{ ok: true }`.

- **FR-5 — `failTask(taskId: string, workerId: string, errorMessage: string, retries: number, retryTimeoutMs: number): Promise<FailTaskResult>`**
  Report failure on a locked external task, setting retry count. No variables are carried;
  no `assertVariableValue` call needed.
  Success: HTTP 204 → `{ ok: true }`.

- **FR-6 — Config from environment.**
  Client reads `FLOWABLE_BASE_URL` (default `http://flowable:8082/flowable-rest/service`),
  `FLOWABLE_REST_APP_ADMIN_USER_ID` (default `admin`), and
  `FLOWABLE_REST_APP_ADMIN_PASSWORD` (required; no hardcoded fallback in production path).
  Dev default password `choros_flowable_dev_pw` is permitted only through
  `no-committed-secret.sh` ALLOWED_DEV_DEFAULTS (already registered by T-0058).

- **FR-7 — Retries and timeouts.**
  Each outbound call applies: configurable request timeout (default 10 000 ms) and
  configurable retry count on transient errors (5xx, network error) with exponential backoff
  (default: 3 retries, base delay 500 ms, max delay 5 000 ms). 4xx errors are NOT retried.

- **FR-8 — Typed error mapping.**
  All HTTP/network errors map to typed error values (never throw untyped exceptions at the
  call-site). Minimum typed codes: `"ENGINE_UNAVAILABLE"` (5xx after retries exhausted),
  `"NOT_FOUND"` (404), `"CONFLICT"` (409), `"UNAUTHORIZED"` (401), `"BAD_BPMN"` (400 on
  deploy), `"RECORD_IN_PAYLOAD"` (client-side guard), `"TIMEOUT"`, `"UNKNOWN"`.

- **FR-9 — Zero new infrastructure.**
  The client is a pure TS module with no new containers, schemas, or compose changes.
  It imports `assertVariableValue` from `src/core/object-handle.ts` and `resolveFor` from
  `src/core/grant-resolver.ts` (these already exist; imports are additive).

---

## 3. Non-functional requirements

- **NF-1 — Zero direct `fetch`/HTTP framework dependency added.**
  Use the Node 20 built-in `fetch` (available since Node 18.0 stable). No new `node_modules`
  entry for HTTP unless the existing `package.json` already provides one. If Node built-in
  `fetch` is used, it must be consistently mockable in vitest unit tests via `vi.spyOn` or
  `vi.stubGlobal`.

- **NF-2 — Additive only.**
  The client does NOT modify `src/core/types.ts`, `src/core/jobStore.ts`, or any frozen
  module. New exports are additive. `tsc --noEmit` passes without warnings added.

- **NF-3 — FF-G3 active and green.**
  Because `src/core/flowable-client.ts` matches `src/core/flowable*.ts`, the FF-G3 probe
  activates. The file MUST contain calls to `assertVariableValue` (FR-2, FR-4) and
  `resolveFor` (FR-4 record-mutation path) so that `ci/checks/flowable-bridge-contract.sh`
  exits 0 when the bridge is present and compliant.

- **NF-4 — No secret hardcoded outside `${VAR:-dev_default}` form.**
  Admin password follows the same pattern as T-0058: only `choros_flowable_dev_pw` as a
  dev default, only in compose / env, never as a TS string literal. `no-committed-secret.sh`
  must remain green.

- **NF-5 — Unit tests deterministic, no real HTTP.**
  All unit tests for the client (FR-1..FR-5) run without a live Flowable instance (mock HTTP).
  Live integration tests are clearly separated (e.g., `.integration.test.ts` suffix or
  `describe.skipIf(!process.env.FLOWABLE_INTEGRATION)`) and are added to the CI `flowable`
  job only.

- **NF-6 — Pre-existing fitness suite remains green.**
  `npm run fitness` (all existing checks including FF-G1..FF-G8, FF-FL-1..FF-FL-12, and all
  RBAC checks) stays green after this task.

---

## 4. Out of scope

- **Mapping External Task ↔ JobStore topic** — T-0067 (E6.2) owns this.
- **Lifecycle events and unified audit** — T-0068 (E6.3) owns this. The client does NOT write
  to the audit log.
- **Keycloak / JWT auth to Flowable** — not in MVP scope; T-0058 uses Basic Auth; this client
  follows the same pattern. Upgrading to JWT is a future task.
- **Flowable history API** — not needed by E6.1.
- **Process management UI / catalog** — E8 owns modeller; E7 owns inbox.
- **Production Flowable config / JVM tuning** — E0.7 (founder-gated, RL-1).
- **BPMN linting before deploy** — the linter (T-0027) is a separate call-site concern; the
  client's `deployBpmn()` does not call the linter internally. T-0067/E8.2 wires them together.

---

## 5. Acceptance criteria

| ID | Text | Verifiable as |
|---|---|---|
| AC-1 | `src/core/flowable-client.ts` exists and `tsc --noEmit` passes with zero new type errors. | fitness |
| AC-2 | `deployBpmn(xml)` sends `POST /repository/deployments` (multipart) and returns `{ ok: true; deploymentId: string }` on HTTP 201 — verified by unit test with mocked HTTP. | test |
| AC-3 | `deployBpmn(xml)` returns `{ ok: false; code: "BAD_BPMN" }` on HTTP 400 (malformed BPMN) — unit test. | test |
| AC-4 | `startInstance(key)` sends `POST /runtime/process-instances` with `{"processDefinitionKey": key}` and returns `{ ok: true; instanceId: string }` on HTTP 201 — unit test. | test |
| AC-5 | `startInstance(key, variables)` where `variables` contains a raw record object (matches `assertVariableValue` rejection) returns `{ ok: false; code: "RECORD_IN_PAYLOAD" }` WITHOUT calling the engine — unit test. | test |
| AC-6 | `fetchAndLock(topic, workerId, lockMs, max)` sends `POST /runtime/external-jobs/acquire` and returns `{ ok: true; tasks: ExternalTask[] }` on HTTP 200 — unit test. | test |
| AC-7 | `fetchAndLock` with an empty queue (HTTP 200, empty `data` array) returns `{ ok: true; tasks: [] }` without error — unit test. | test |
| AC-8 | `completeTask(taskId, workerId)` sends `POST /runtime/external-jobs/{taskId}` (or the proven Flowable 7 complete endpoint) and returns `{ ok: true }` on HTTP 204 — unit test. | test |
| AC-9 | `completeTask(taskId, workerId, variables)` where `variables` contains a raw record object returns `{ ok: false; code: "RECORD_IN_PAYLOAD" }` WITHOUT calling the engine — unit test. | test |
| AC-10 | `completeTask(taskId, workerId, variables)` where all variables pass `assertVariableValue` calls the engine and returns `{ ok: true }` on HTTP 204 — unit test. | test |
| AC-11 | `failTask(taskId, workerId, msg, retries, retryMs)` sends the correct Flowable 7 fail endpoint and returns `{ ok: true }` on HTTP 204 — unit test. | test |
| AC-12 | On HTTP 5xx (first call), the client retries up to the configured limit before returning `{ ok: false; code: "ENGINE_UNAVAILABLE" }` — unit test with mocked HTTP sequence. | test |
| AC-13 | On request timeout (no response within `timeoutMs`), the client returns `{ ok: false; code: "TIMEOUT" }` — unit test. | test |
| AC-14 | **FF-G3 active and green:** `bash ci/checks/flowable-bridge-contract.sh` exits 0 after this task (bridge present and compliant: `assertVariableValue` and `resolveFor` both referenced in `src/core/flowable-client.ts`). | fitness |
| AC-15 | **Live deploy smoke (CI):** with Flowable running (`docker compose up -d postgres flowable`), calling `deployBpmn(choros-smoke.bpmn20.xml content)` returns `{ ok: true; deploymentId: <non-empty string> }`. | fitness |
| AC-16 | **Live start-instance smoke (CI):** after deploy, calling `startInstance("chorosSmoke")` returns `{ ok: true; instanceId: <non-empty string> }`. | fitness |
| AC-17 | **Live fetch-and-lock smoke (CI):** after starting an instance with a `smoke-topic` external task, calling `fetchAndLock("smoke-topic", "ci-worker", 30000, 1)` returns `{ ok: true; tasks: [{ id: <string>, topic: "smoke-topic", ... }] }`. | fitness |
| AC-18 | **Live complete smoke (CI):** calling `completeTask(task.id, "ci-worker")` on the fetched task returns `{ ok: true }` and the process instance advances (runtime query returns the instance as completed or no longer in the running list). | fitness |
| AC-19 | All pre-existing fitness functions (`npm run fitness`) remain green — `no-committed-secret.sh`, `flowable-bridge-contract.sh`, `mutation-gateway-isolation.sh`, FF-FL-1..FF-FL-12, FF-G1..FF-G8, RBAC checks. | fitness |
| AC-20 | `FLOWABLE_BASE_URL`, `FLOWABLE_REST_APP_ADMIN_USER_ID`, `FLOWABLE_REST_APP_ADMIN_PASSWORD` are the only env vars introduced; their names are present in `src/core/flowable-client.ts`. | fitness |

---

## 6. BLOCKING questions

None. All seams are frozen by T-0058, the proven REST endpoints are confirmed by the spike
(`spikes/flowable-oss/measurements.json`, `run.sh deadletter/cmd_up`), and the FF-G3
activation contract is fully specified in `docs/design/T-0028-engine-mutation-guard.adr.md`
§8. No product-direction fork is open.

---

## 7. Traceability

| Requirement | AC |
|---|---|
| FR-1 deployBpmn | AC-2, AC-3, AC-15 |
| FR-2 startInstance (variables guard) | AC-4, AC-5, AC-16 |
| FR-3 fetchAndLock | AC-6, AC-7, AC-17 |
| FR-4 completeTask (variables guard) | AC-8, AC-9, AC-10, AC-18 |
| FR-5 failTask | AC-11 |
| FR-6 config from env | AC-20 |
| FR-7 retries/timeouts | AC-12, AC-13 |
| FR-8 typed error mapping | AC-3, AC-9, AC-12, AC-13 |
| FR-9 zero new infra | AC-1, AC-19 |
| NF-3 FF-G3 active | AC-14 |
| NF-5 unit tests no real HTTP | AC-2..AC-13 (unit) |
| NF-6 pre-existing fitness green | AC-19 |
