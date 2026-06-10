# ADR · T-0067 — E6.2 · External Task ↔ JobStore Bridge

**Status:** ready  
**Date:** 2026-06-11  
**Author:** architect (Demiurge DESIGN phase)

---

## 1. Context

Flowable holds a queue of External Tasks. When a BPMN process reaches a
`<serviceTask activiti:type="external-worker">` node, Flowable creates an
External Task bound to a topic string. Choros must:

1. Periodically **poll** Flowable (fetchAndLock) for each configured topic.
2. **Enqueue** polled tasks into its JobStore (`idempotency_key = externalTask.id`).
3. **Deliver** enqueued jobs to external workers through the existing HTTP API.
4. **Signal** Flowable on job completion (`completeTask`) or failure (`failTask`).

This forms the "bridge cycle". The prior tasks establish:
- **T-0064**: `FlowableClient` with `fetchAndLock / completeTask / failTask` (wire
  contract frozen in ADR §4.5 and `T-0064.pr-handoff.json`).
- **T-0062**: `pgJobStore.enqueue(topic, variables, retries, idempotencyKey?)` +
  outboxDispatcher with `Deliver` and `idempotentSuccess` semantics.
- **T-0063**: `lockReclaimer` / `sweepExpiredLocks` emitting `worker_lock_expired`
  outbox incidents.

Two autonomous design decisions remain (T-0067 DESIGN owns them per spec §6):

- **(A)** How to store and reverse-look up `jobId ↔ externalTaskId`.
- **(B)** What `deliver()` does for `event_type = 'worker_lock_expired'`.

---

## 2. Decision

> **Minimal-artifact bridge with idempotency_key as the sole jobId↔externalTaskId
> map, and a no-op deliver for `worker_lock_expired` incidents.**

### Decision A — jobId ↔ externalTaskId: idempotency_key field (PK lookup)

`pgJobStore.enqueue` already stores `idempotencyKey` in the `choros.job`
column `idempotency_key` (`migrations/023`). Because `idempotency_key =
externalTask.id` (established by FR-1/FR-2), the reverse mapping on the
complete/fail path is:

```sql
SELECT idempotency_key
FROM choros.job
WHERE id = $1;      -- PK lookup → O(1)
```

This is sufficient without a new table, new column, or migration:

- The `job.id` is the table primary key — lookup is O(1) on the existing
  primary-key index.
- The `idempotency_key` column is already nullable text ≤ 255; for bridge-
  created jobs it is always non-null (enforced by bridge logic at enqueue time).
- Survives restart: the row persists in Postgres; re-reading after a bridge
  restart gives the same `externalTaskId`.
- No extra JOIN or auxiliary table is required.

**Rejected alternatives — see §6.**

### Decision B — deliver() for `worker_lock_expired`: no-op, return `{ ok: true }`

When the lock-sweep (T-0063) reclaims an expired Choros lock, it emits an
outbox row with `event_type = 'worker_lock_expired'`, `aggregateId = jobId`.
The bridge's `deliver()` handles this event type as a **no-op**:

```typescript
case 'worker_lock_expired':
  return { ok: true };  // no Flowable call
```

Rationale:

1. **Flowable manages its own lock timeout independently.** `fetchAndLock` passes
   `lockDurationMs` to Flowable; Flowable will release the external task lock
   when that duration expires. Choros and Flowable lock clocks are independent.
2. **Calling `failTask(retries=0)` while Choros is retrying creates split-brain.**
   T-0063 re-queues the job (`CREATED`, `retries--`) when `retriesLeft > 0`.
   If the bridge simultaneously called `failTask(retries=0)`, Flowable would
   mark the external task as terminally failed, while Choros is still trying
   to deliver it. The next successful Choros delivery would call `completeTask`,
   which would receive `NOT_FOUND` from Flowable (task already failed/removed) —
   an `idempotentSuccess`. But the process instance would already have gone down
   the error boundary, not the completion path. Incorrect semantics.
3. **When `retriesLeft = 0`, the job is in FAILED state.** The worker's original
   `POST /external-task/:id/fail` call will go through the normal fail-path
   (outbox row with `event_type = 'task_failed'`) and call `failTask` in Flowable
   correctly when dispatched. The sweep incident is redundant in this case; a
   no-op is safe.
4. **Lock-sweep timing vs Flowable lock timing:** if Flowable's lock expires
   before Choros's lock expires, Flowable puts the task back in the queue.
   The bridge's next poll interval will re-fetch it, producing a new `job` row
   in Choros (idempotent: same `idempotency_key` → returns existing job, no
   duplicate). If Choros's lock expires before Flowable's, sweep fires — the
   job is re-queued in Choros; Flowable still has the lock, and `fetchAndLock`
   will NOT return it until Flowable's lock also expires. When it does, the
   bridge re-fetches and re-delivers from Choros — again idempotent.

This design keeps the bridge stateless w.r.t. lock sweep incidents: it neither
over-signals Flowable nor races against its engine-side timeout.

---

## 3. Object Model

### ExternalTaskBridge (new module `src/core/externalTaskBridge.ts`)

```typescript
// Configuration for the bridge (all injectable)
interface ExternalTaskBridgeConfig {
  topics: string[];           // configured topics to poll
  workerId: string;           // bridge worker identity (e.g. "choros-bridge-1")
  lockDurationMs: number;     // how long to hold Flowable lock (default 30_000)
  maxTasksPerTopic: number;   // fetchAndLock limit per topic per pass (default 10)
  pollIntervalMs: number;     // setInterval period (default 5_000)
  retries: number;            // retries passed to pgJobStore.enqueue (default 3)
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  onPoll?: (result: BridgePollResult) => void;  // observability hook
}

interface BridgePollResult {
  topics: number;
  fetched: number;
  enqueued: number;
  skipped: number;      // assertVariableValue rejection count
  errors: number;       // fetchAndLock failures per topic
}
```

### ExternalTaskBridge public surface

```typescript
// One poll pass (exported for tests + CLI runner)
async function runBridgeOnce(
  flowableClient: FlowableClient,
  jobStore: PostgresJobStore,
  topics: string[],
  workerId: string,
  lockDurationMs: number,
  maxTasksPerTopic: number,
  retries: number,
): Promise<BridgePollResult>

// Background loop (образец startLockReclaimerLoop)
function startBridgePollLoop(
  flowableClient: FlowableClient,
  jobStore: PostgresJobStore,
  opts: ExternalTaskBridgeConfig,
): { stop: () => void }

// Deliver function (wired into outboxDispatcher)
// Implements the Deliver = (row: OutboxRow) => Promise<DispatchResult> contract
function makeExternalTaskDeliver(
  flowableClient: FlowableClient,
  jobStore: PostgresJobStore,
): Deliver
```

### Row-level link: `job.idempotency_key = externalTask.id`

| Field | Type | Source | Used for |
|---|---|---|---|
| `job.id` | UUID PK | randomUUID() at enqueue | Choros job identity |
| `job.idempotency_key` | text ≤255 | `externalTask.id` (Flowable UUID) | dedup at enqueue; reverse-map at complete/fail |
| `job.topic` | text | `externalTask.topic` (echoed) | 1:1 convention; no transform |

No new table, no new migration required for the bridge mapping.

### OutboxRow event types consumed by bridge deliver()

| `event_type` | `aggregateId` | Bridge action |
|---|---|---|
| `task_completed` | jobId | lookup `idempotency_key`, call `completeTask(externalTaskId, workerId, payload)` |
| `task_failed` | jobId | lookup `idempotency_key`, call `failTask(externalTaskId, workerId, errorMessage, retries, retryTimeout)` |
| `worker_lock_expired` | jobId | no-op → `{ ok: true }` |
| (unknown) | * | no-op → `{ ok: true }` |

---

## 4. Contracts

### 4.1 runBridgeOnce

```typescript
async function runBridgeOnce(
  flowableClient: FlowableClient,  // injected mock in tests
  jobStore: PostgresJobStore,
  topics: string[],
  workerId: string,
  lockDurationMs: number,
  maxTasksPerTopic: number,
  retries: number,
): Promise<BridgePollResult>
```

Per-topic loop:
1. `flowableClient.fetchAndLock(topic, workerId, lockDurationMs, maxTasksPerTopic)`
2. For each `ExternalTask`:
   a. Validate each variable via `assertVariableValue(value)`. Failure → log
      incident, continue to next task.
   b. `jobStore.enqueue(topic, task.variables, retries, task.id)`.
3. On `FetchResult.ok === false`: log error, continue to next topic (no throw).

### 4.2 makeExternalTaskDeliver — Deliver contract

```typescript
type Deliver = (row: OutboxRow) => Promise<DispatchResult>
```

Dispatch logic:

```
switch row.eventType:
  'task_completed':
    externalTaskId = await lookupExternalTaskId(jobStore.pool, row.tenantId, row.aggregateId)
    if not found → return { ok: true, idempotentSuccess: true }  // job deleted/missing
    result = await flowableClient.completeTask(externalTaskId, workerId, payload)
    if result.ok → return { ok: true }
    if result.code === 'NOT_FOUND' → return { ok: false, idempotentSuccess: true }
    → return { ok: false, error: result.code }

  'task_failed':
    externalTaskId = await lookupExternalTaskId(...)
    if not found → return { ok: true, idempotentSuccess: true }
    result = await flowableClient.failTask(externalTaskId, workerId,
               row.payload.errorMessage, row.payload.retries, row.payload.retryTimeout)
    if result.ok → return { ok: true }
    if result.code === 'NOT_FOUND' → return { ok: false, idempotentSuccess: true }
    → return { ok: false, error: result.code }

  'worker_lock_expired' | unknown:
    → return { ok: true }
```

### 4.3 lookupExternalTaskId (internal helper)

```typescript
async function lookupExternalTaskId(
  pool: pg.Pool,
  tenantId: string,
  jobId: string,
): Promise<string | undefined>
// SELECT idempotency_key FROM choros.job
// WHERE id = $1 AND tenant_id = <GUC>
// Returns undefined if not found (idempotentSuccess path)
```

**GUC requirement**: caller must `SET LOCAL choros.tenant_id = tenantId` in
the transaction before this query. In practice, `deliver()` receives the
tenantId from `row.tenantId`; the pool connection must have the GUC set.
Deliver uses a dedicated connection with `SET LOCAL` (образец outboxDispatcher
claimBatch pattern).

### 4.4 startBridgePollLoop

```typescript
function startBridgePollLoop(
  flowableClient: FlowableClient,
  jobStore: PostgresJobStore,
  opts: ExternalTaskBridgeConfig,
): { stop: () => void }
```

Pattern: identical to `startLockReclaimerLoop` (T-0063):
- `setIntervalFn` default = `setInterval`
- First pass after one interval (not immediately)
- `stop()` calls `clearInterval`
- Per-pass errors swallowed (no unhandledRejection after stop)

### 4.5 FF-G3 compliance in bridge file

The file `src/core/externalTaskBridge.ts` MUST contain:
```typescript
import { assertVariableValue } from "./object-handle.js";
import { resolveFor } from "./grant-resolver.js";
```
And both `assertVariableValue` and `resolveFor` must appear as grep-visible
references. `assertVariableValue` is called on variables before enqueue
(runBridgeOnce, FR-3). `resolveFor` is referenced structurally at the
complete-path variable-processing seam (T-0068 will complete wiring; identical
to the pattern in `flowable-client.ts:448`).

### 4.6 Wiring in server.ts (library API, not auto-wired)

The bridge is a **library module**: `startBridgePollLoop` and
`makeExternalTaskDeliver` are exported from `src/core/externalTaskBridge.ts`
but NOT wired into `src/server.ts` by T-0067. Rationale:

- `lockReclaimer` is also a library (not wired into server.ts); consistent.
- T-0068 (lifecycle + audit) is downstream and may add `onDispatched` at wire
  time. Wiring at T-0067 would bypass that seam or require re-touch.
- The coder wires in `src/server.ts` ONLY when T-0068 has resolved the
  `onDispatched` seam, or when directed separately. T-0067 coder produces the
  module; wiring is a follow-up step (noted in Notes).

---

## 5. Fitness Functions

| ID | Rule | CI check |
|---|---|---|
| FF-T0067-1 | `runBridgeOnce` with 2 mock tasks → 2 jobs enqueued, topic = task.topic | `vitest run src/__tests__/externalTaskBridge.test.ts` (AC-1, AC-4) |
| FF-T0067-2 | Repeated `runBridgeOnce` with same task IDs → 0 new jobs (idempotency) | vitest AC-2 |
| FF-T0067-3 | `assertVariableValue` rejection in one task → that job NOT created; other tasks proceed | vitest AC-3 |
| FF-T0067-4 | `externalTaskId` recoverable from `jobId` after restart (SELECT idempotency_key WHERE id=jobId) | vitest AC-5 |
| FF-T0067-5 | `deliver('task_completed')` calls `completeTask` exactly once with correct args | vitest AC-6 |
| FF-T0067-6 | `completeTask` returns `NOT_FOUND` → `idempotentSuccess: true` → row goes to 'dispatched' | vitest AC-7 |
| FF-T0067-7 | `completeTask` returns `ENGINE_UNAVAILABLE` → `{ ok: false }` → backoff/retry/dead | vitest AC-8 |
| FF-T0067-8 | `deliver` with completeTask variables passes `assertVariableValue` + `resolveFor` ref; `flowable-bridge-contract.sh` exits 0 | `npm run fitness:flowable` (FF-G3 active) AC-9 |
| FF-T0067-9 | `deliver('task_failed')` calls `failTask` exactly once with correct args | vitest AC-10 |
| FF-T0067-10 | `failTask` returns `NOT_FOUND` → `idempotentSuccess: true` | vitest AC-11 |
| FF-T0067-11 | `deliver('worker_lock_expired')` returns `{ ok: true }` (no-op); no exception | vitest AC-12 |
| FF-T0067-12 | `startBridgePollLoop` first pass after one interval, not immediately; `stop()` halts loop | vitest AC-13, AC-14 |
| FF-T0067-13 | `fetchAndLock` ENGINE_UNAVAILABLE → loop continues; next tick is normal call | vitest AC-15 |
| FF-T0067-14 | E2E smoke: `bridge-e2e-smoke.sh` — deploy BPMN → start instance → `runBridgeOnce` → job in JobStore → POST /external-task/:id/complete → deliver → completeTask in Flowable → instance complete; exit 0 | `npm run fitness:flowable:bridge` (AC-16, AC-17, AC-18) |
| FF-T0067-15 | E2E smoke: idempotency_key = externalTask.id; repeat poll → 0 new jobs | included in bridge-e2e-smoke.sh (AC-17) |
| FF-T0067-16 | E2E smoke: FF-G3 green (assertVariableValue + resolveFor in bridge file) | `flowable-bridge-contract.sh` stays exit 0 after bridge added (AC-18) |
| FF-T0067-17 | `cross_tenant.test.ts` remains green; if new table added → in known_tenant_tables.txt (no new table in this design) | `npm run fitness:db` (AC-19) |
| FF-T0067-18 | `tsc --noEmit` exit 0; `eslint src/` exit 0; `vitest run` 0 regressions | `npm run ci` (AC-20) |
| FF-T0067-19 | Migrations ≥030 if added: run×2 = nothing to apply on second pass (no new migration in this design; fitness is vacuously satisfied) | `node migrations/run.mjs` ×2 (AC-21) |

---

## 6. Rejected Alternatives

### A1 — Separate `job_external_task` mapping table

Maintain a `choros.job_external_task (job_id UUID PK, external_task_id text NOT NULL)`
table with a FK to `choros.job`.

**Why not:** Unnecessary. `job.idempotency_key` IS the `externalTaskId` — the
column is already stored, indexed (partial unique), and persists across restarts.
A separate table would double-store the same data, require a new migration (030+),
update `known_tenant_tables.txt`, and add a JOIN on every complete/fail path.
The spec explicitly asks whether `idempotency_key` is "sufficient for the reverse
mapping on the complete path" — it is (PK lookup, O(1), survives restart).

### A2 — Store externalTaskId in job.variables

Pack `{ __externalTaskId: "..." }` into the job's `variables` JSON blob.

**Why not:** Pollutes the variables contract (variables are the business payload
from the BPMN process, not transport metadata). The T-0028 assertVariableValue
guard runs on variables — injecting a transport field requires excepting it.
idempotency_key is the purpose-built carrier.

### B1 — Call `failTask(retries=0)` for `worker_lock_expired`

When a Choros lock expires, signal Flowable with a terminal fail.

**Why not:** Creates split-brain when Choros has `retriesLeft > 0` (job
re-queued as CREATED). Flowable terminates the task while Choros retries
delivery. The final successful `completeTask` would hit `NOT_FOUND` → treated
as `idempotentSuccess`, but the process instance already went down the error
boundary, not the completion path. Incorrect observable behavior.

When `retriesLeft = 0`, the job is FAILED, and the standard `task_failed` outbox
row (from the worker's `POST /external-task/:id/fail` call) already handles the
Flowable signaling correctly via the normal deliver path.

### B2 — Conditionally call `failTask` when `retriesLeft = 0`

Parse the `worker_lock_expired` payload, and only call `failTask(retries=0)`
if `retriesLeft = 0`.

**Why not:** When `retriesLeft = 0`, the job transitioned to FAILED via the
sweep. The worker had already called `POST /external-task/:id/fail` OR the
sweep force-failed it. In the former case, the `task_failed` outbox row handles
Flowable signaling. In the latter (sweep-killed terminal), there is no worker
signal — but by the time sweep kills the job, Flowable's own lock timeout
(typically much shorter than the sweep interval) has also fired, making the
external task available for re-fetch or ending it via the engine's own retry
counter. Calling `failTask` at this late point races with Flowable's engine-side
retry/incident logic. No-op is cleaner and avoids this race without loss of
correctness.

---

## 7. Traceability

| AC | Covered by |
|---|---|
| AC-1 | FF-T0067-1: runBridgeOnce creates 2 jobs for 2 mock tasks |
| AC-2 | FF-T0067-2: idempotency via idempotency_key conflict |
| AC-3 | FF-T0067-3: assertVariableValue rejection skips one task, others proceed |
| AC-4 | FF-T0067-1: job.topic = externalTask.topic (1:1 pass-through) |
| AC-5 | FF-T0067-4: SELECT idempotency_key FROM job WHERE id=jobId after restart |
| AC-6 | FF-T0067-5: deliver task_completed calls completeTask once with correct args |
| AC-7 | FF-T0067-6: NOT_FOUND → idempotentSuccess → dispatched |
| AC-8 | FF-T0067-7: ENGINE_UNAVAILABLE → retry/dead path |
| AC-9 | FF-T0067-8: FF-G3 bridge-contract.sh stays green |
| AC-10 | FF-T0067-9: deliver task_failed calls failTask once |
| AC-11 | FF-T0067-10: NOT_FOUND → idempotentSuccess |
| AC-12 | FF-T0067-11: worker_lock_expired → no-op DispatchResult |
| AC-13 | FF-T0067-12: first poll after one interval |
| AC-14 | FF-T0067-12: stop() halts loop, no unhandledRejection |
| AC-15 | FF-T0067-13: fetchAndLock failure → loop continues |
| AC-16 | FF-T0067-14: E2E bridge smoke full cycle |
| AC-17 | FF-T0067-15: E2E idempotency check |
| AC-18 | FF-T0067-16: FF-G3 in E2E smoke |
| AC-19 | FF-T0067-17: cross_tenant green; no new table (NF-6 vacuous) |
| AC-20 | FF-T0067-18: tsc / eslint / vitest 0 regressions |
| AC-21 | FF-T0067-19: migration idempotency (no new migration) |

---

## 8. Runtime Target

`container` — same Postgres + Flowable docker-compose stack as T-0062/T-0063.
No new services. No new migrations (the bridge mapping reuses `job.idempotency_key`
from migration 023). No external resource beyond the existing Flowable container.

The bridge poll-loop runs inside the Choros Node.js process (same as
lockReclaimer, outboxDispatcher). No separate deployment unit required.

---

## 9. Downstream Seam for T-0068

`makeExternalTaskDeliver` accepts an optional `onDispatched?: OnDispatched`
(образец outboxDispatcher `RunOutboxOptions.onDispatched`). T-0067 passes
`undefined` (no-op). T-0068 fills this seam for audit_event/actor_event recording.

The seam is exposed at the wiring point (server.ts integration) — T-0067 coder
produces the module; wiring (including `onDispatched`) is deferred to T-0068
or a dedicated wiring step.
