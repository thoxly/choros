# ADR · T-0028 — Engine State-Mutation Guard

**Status:** ready (no escalation)
**Phase:** DESIGN
**Date:** 2026-06-10
**Task:** E2.7 — Engine state-mutation guard: forbid object mutation except via the gateway
**Spec consumed:** `docs/specs/T-0028-engine-mutation-guard.spec.md` (AC-1..AC-10)
**Foundation (do NOT contradict):**
- `docs/design/T-0015-object-handles.adr.md` — `assertVariableValue`, `isObjectHandle`, `ObjectHandle`, `parseHandle` in `src/core/object-handle.ts` (T-0015's deliverable, already merged). T-0028 enforces the call-site half of FF-A4 that T-0015 deferred.
- `docs/design/T-0021-grant-resolver-pdp.adr.md` — `resolveFor(deps, handle, subject, op)` in `src/core/grant-resolver.ts` (T-0021's deliverable, already merged). FF-R9 / AC-15 of T-0021 activate here.
- `docs/design/T-0018-grant-authority.adr.md` — `Operation` enum; `op ∈ {create, update, delete, approve, transition}` are the typed write ops.
- `src/core/jobStore.ts` — `JobStore.complete(workerId, jobId): CompleteResult`; the only current external-task result-return path.
- `src/core/object-handle.ts` — `assertVariableValue(value): VariableValueResult`; `isObjectHandle`; `VariableValueResult`; fully recursive already (plain arrays/objects recurse into members).

**Sibling seam (T-0114):** T-0114 (JobStore→Postgres) is in REVIEW and will merge to dev before T-0028's BUILD starts. T-0114 delivers `PostgresJobStore` + `InMemoryJobStore` (TestDouble) behind one interface, with an atomic CTE on `complete/fail`, and migration `010_`. The guard is designed as a PURE VALIDATOR that the BUILD author wires into the `complete`-path of BOTH store implementations — one source of truth, zero duplication.

**Siblings not-built-here:**
- T-0027 (BPMN deploy-time linter — static guard on process definitions at deploy time)
- T-0053 (Postgres-backed `GrantSource`/`RecordSource` + RLS DAO)
- T-0058 / T-0064 / T-0067 (Flowable external-task bridge — when the guard's assertions become structurally mandatory)

---

## 1. Context

Choros today is an in-memory TS/Node app without a BPMN engine. The literal reading of E2.7 ("the engine cannot write objects directly") has no engine substrate to enforce against yet. This ADR pins what the guard IS today and what it CONTRACTS for the future.

The three-layer scope model from the spec is adopted verbatim:

- **Layer A:** structural isolation — a writable record accessor must not escape the gateway module boundary. Enforced by `ci/checks/mutation-gateway-isolation.sh`.
- **Layer B:** `JobStore.complete` payload guard — the one structural location where an external worker returns results to the system. Guards every variable value in the payload with `assertVariableValue`; rejects fail-closed (code `RECORD_IN_PAYLOAD`).
- **Layer C:** deferred Flowable bridge contract — sealed here as FF-G3 (a probe that activates when the bridge path exists).

---

## 2. Decision

**The guard is the existing `assertVariableValue` from `src/core/object-handle.ts`, called at the
`complete`-path of every `JobStore` implementation. No new module is introduced for the guard itself:
`assertVariableValue` is already the single source of truth for "is this a valid process-variable
value?" (T-0015, FF-A4). The BUILD author wires the call into `complete` — additive, no new exports,
no new functions.**

Three concrete deliverables:

1. **`JobStore.complete` payload parameter (additive API extension):** `complete` gains an optional
   third parameter `payload?: Record<string, unknown>` (no change to the two-argument overload; the
   existing signature compiles unchanged). When `payload` is provided, every value in it is validated
   with `assertVariableValue` before the job state is advanced. A single `ok:false` result rejects
   the entire `complete` call — all-or-nothing, fail-closed — returning `{ ok: false, code: "RECORD_IN_PAYLOAD" }`.
   The job remains in `LOCKED` state. On success (all values pass), the validated payload values are
   stored alongside the job update (stored in `Job.result?: Record<string, unknown>` — an additive
   field on `Job`). Without a payload the existing behavior is byte-identical to today.

2. **`ci/checks/mutation-gateway-isolation.sh` (new CI check, Layer A):** A bash script that (a)
   asserts no module outside `src/core/grant-resolver.ts` imports a symbol from a writable record
   accessor (`*mutate*`, `*write*`, `*persist*` function names applied to record fields); (b) asserts
   `assertVariableValue` IS called in the `complete` method of `src/core/jobStore.ts` (call-site
   presence); (c) asserts no new parallel write path (no new function mapping `ResourceRef` →
   record fields outside the gateway composition). Exits 0 when green; non-zero on violation.

3. **`ci/checks/flowable-bridge-contract.sh` (deferred probe, Layer C / FF-G3):** A bash script
   authored now that exits 0 when the Flowable bridge path (`src/bridge/` or `src/core/flowable*.ts`
   etc.) does not exist (bridge not yet built). When the bridge path exists, the script asserts that
   every bridge result-return file calls `assertVariableValue` and routes record mutations through
   `resolveFor`. This gives T-0058+ a machine-verifiable contract sealed by T-0028.

**The `fail` path is NOT modified.** `JobStore.fail` accepts `retries` and `retryTimeoutMs` only
— it carries no worker-supplied result payload. The seam for mutation injection is `complete`, not
`fail`. The spec is explicit on this: "`JobStore.complete` is the one structural location today."

**JSON-encoded-string decision (record-in-JSON-string):** A string value in the payload whose
JSON.parse-ed content is a record object is **passed as-is (ok: true)**. Rationale: strings are
inert literals; `assertVariableValue` is "pure, total, side-effect-free" and NEVER parses string
contents (that would open an unlimited attack surface: every string in a payload would need deep
parse-and-check). If a downstream path attempts to store the decoded record object (calling
`assertVariableValue` on the decoded result), it will be rejected at that boundary. The string
itself is not a record object. This is consistent with T-0015's design: the guard classifies
VALUE TYPES, not the semantic content of strings.

---

## 3. Rejected alternatives

| Option | Why not |
|---|---|
| **New `src/core/variable-guard.ts` module wrapping `assertVariableValue`** | `assertVariableValue` already exists in `object-handle.ts` and is the single source of truth (FF-A4, T-0015). Adding a wrapper module adds indirection without adding invariant. The BUILD contract is: call the existing function directly; the isolation check confirms the call site. "Single source" means no wrapper. |
| **Inline the guard check inside `complete` without importing `object-handle.ts`** | Would duplicate the record-detection logic, diverging from T-0015's canonical implementation. Two copies drift; one wins silently. The only correct import is `assertVariableValue` from `object-handle.ts`. |
| **Guard at `enqueue` time instead of `complete` time** | `enqueue` is producer-side; it already receives variables the caller provides (under the caller's own type discipline). The threat model is the EXTERNAL WORKER returning a result — that is the `complete` path. Guarding at `enqueue` does not protect against a malicious/buggy worker injecting a record via `complete`. Both paths must be guarded; this task covers the `complete` seam as the only current seam. |
| **Validate payload in a middleware layer (router/handler) above the store** | The router level is not the right place: a record object could be constructed in application code and passed directly to `complete` without going through HTTP. The guard must be at the store boundary — the last defense before state mutation. This also means the guard is tested at the unit level, not the HTTP level. |
| **Parse JSON strings and check their content (`JSON.parse` inside `assertVariableValue`)** | Violates the "pure, total, side-effect-free" contract; opens an unbounded attack surface (every string becomes a potential payload to decode); breaks the existing `ok: true` contract for string primitives that T-0015 already established. Rejected: strings are inert literals, not objects. |
| **Validate `fail` payload too** | `fail` carries no worker-supplied result payload today (only `retries` + `retryTimeoutMs`). Modifying `fail` would be scope creep; no seam exists. The spec is clear: the seam is `complete`. |
| **Store the payload on the `Job` type by modifying `types.ts`** | Adding a `result` field to the `Job` interface in `types.ts` requires edits to the frozen file (FE-W23-0008). Instead: `result` is added to the `Job` type in `types.ts` — this is an additive field (no existing field removed/changed), which the compatibility rule permits. See §5 (compat-check). |

---

## 4. Object model and contracts

### 4.1 Changes to existing types (all additive)

| Symbol | File | Change |
|---|---|---|
| `Job.result` | `src/core/types.ts` | New optional field: `readonly result?: Record<string, unknown>` — carries the validated payload from `complete`. Additive; all existing `Job` shapes remain valid (field absent = no payload). |
| `ErrorCode` | `src/core/jobStore.ts` | Union extended: `"NOT_FOUND" \| "NOT_LOCKED" \| "LOCK_EXPIRED" \| "NOT_OWNER" \| "RECORD_IN_PAYLOAD"`. Existing four codes are UNCHANGED. |
| `CompleteResult` | `src/core/jobStore.ts` | Unchanged signature. The new `RECORD_IN_PAYLOAD` code flows through the existing `{ ok: false; code: ErrorCode }` variant — no type-level break. |
| `JobStore.complete` | `src/core/jobStore.ts` | Third parameter added: `payload?: Record<string, unknown>`. Calling `complete(workerId, jobId)` without a payload is byte-identical to today. |

### 4.2 New CI check files (no new TS modules)

| File | Purpose | Layer |
|---|---|---|
| `ci/checks/mutation-gateway-isolation.sh` | Structural isolation: no writable accessor outside gateway; `assertVariableValue` called at `complete` boundary; no new parallel write path | A |
| `ci/checks/flowable-bridge-contract.sh` | Deferred probe: exits 0 when bridge path absent; activates when bridge path exists | C / FF-G3 |

### 4.3 Contracts (type-level)

```ts
// src/core/types.ts — additive field on Job
export interface Job {
  // ... all existing fields unchanged ...
  readonly result?: Record<string, unknown>;  // NEW: validated complete-payload result
}

// src/core/jobStore.ts — additive parameter + new error code
export type ErrorCode =
  | "NOT_FOUND"
  | "NOT_LOCKED"
  | "LOCK_EXPIRED"
  | "NOT_OWNER"
  | "RECORD_IN_PAYLOAD";  // NEW

// complete signature — third parameter is additive (optional)
complete(
  workerId: string,
  jobId: string,
  payload?: Record<string, unknown>  // NEW optional parameter
): CompleteResult;
// CompleteResult unchanged: { ok: true } | { ok: false; code: ErrorCode }
// On RECORD_IN_PAYLOAD: { ok: false, code: "RECORD_IN_PAYLOAD" }, job state NOT advanced.
// On success with payload: job advances to COMPLETED, job.result = validated payload values.
// On success without payload: byte-identical to existing behavior.
```

### 4.4 Guard algorithm at `complete`

```
complete(workerId, jobId, payload?):
  1. [existing gate] NOT_FOUND → NOT_LOCKED → LOCK_EXPIRED → NOT_OWNER (unchanged)
  2. [new] if payload provided:
       for each value in Object.values(payload):
         r = assertVariableValue(value)    // from object-handle.ts, recursive
         if !r.ok → return { ok: false, code: "RECORD_IN_PAYLOAD" }
                    // job state NOT advanced; all-or-nothing
  3. [existing + extended] advance job to COMPLETED, set result = payload (if provided)
     return { ok: true }
```

`assertVariableValue` is already recursive over arrays and plain objects (T-0015 implementation).
The guard does not need to implement its own recursion — it calls the existing function on each
top-level payload value. The existing function handles nested values (arrays/objects) internally
(fail-closed, depth-bounded by the existing implementation's stack depth).

### 4.5 T-0114 seam (BUILD instruction)

The BUILD author MUST:
1. Rebase the T-0028 branch onto `dev` AFTER T-0114 merges.
2. Wire `assertVariableValue` into the `complete`-path of BOTH store implementations
   (`InMemoryJobStore` and `PostgresJobStore`) delivered by T-0114. The call is identical in both:
   validate payload values before the CTE / Map mutation.
3. NOT redefine `JobStore` structures from T-0114 — only additive call + tests.
4. The `InMemoryJobStore` (TestDouble) from T-0114 is the test double used for T-0028's unit tests.

---

## 5. Compatibility notes (architect rule 7 / FE-W23-0008)

### 5.1 Files modified and impact

| File | Nature of change | Importers at risk |
|---|---|---|
| `src/core/types.ts` | Add `result?: Record<string, unknown>` to `Job` (additive field) | All tests that construct a `Job` literal — they are unaffected because `result` is optional. `tsc --noEmit` passes. |
| `src/core/jobStore.ts` | Add `RECORD_IN_PAYLOAD` to `ErrorCode`; add optional `payload?` param to `complete` | Tests using exhaustive `switch (code)` with `assertNever` WILL need to add the new case — this is the one breaking-ish change. `completeFail.test.ts` uses `handleCompleteResult` with an assertNever. This is ACCEPTABLE and EXPECTED: adding an error code widens the union; exhaustive handlers must be updated. The spec calls this out (NF-2: "no existing code removed or renamed" — check; the new code is additive). |
| `src/core/object-handle.ts` | NOT MODIFIED — only imported | Zero impact. |
| `src/core/grant-resolver.ts` | NOT MODIFIED — only imported for the bridge contract clause | Zero impact. |
| `src/core/grant-lattice.ts` | NOT MODIFIED | Zero impact. |

### 5.2 Exhaustive-switch migration (completeFail.test.ts)

`completeFail.test.ts::handleCompleteResult` currently exhausts `NOT_FOUND | NOT_LOCKED | LOCK_EXPIRED | NOT_OWNER` and uses `assertNever`. The BUILD author MUST add `case "RECORD_IN_PAYLOAD": return "record-in-payload";` to this switch. The compiler error from `tsc --noEmit` will surface this automatically — it is a compile-time signal, not a silent break.

---

## 6. Fitness functions (CI gating)

| FF | Rule | ci_check | gating |
|---|---|---|---|
| **FF-G1** | **Isolation — no writable accessor outside gateway:** `ci/checks/mutation-gateway-isolation.sh` exits 0; no module outside `src/core/grant-resolver.ts` imports a record-mutating symbol; no new `*mutate*/*write*/*persist*` function mapping a `ResourceRef` to record fields appears outside the gateway composition. | `bash ci/checks/mutation-gateway-isolation.sh` (AC-1, AC-6) | static-now |
| **FF-G2** | **`assertVariableValue` call-site present at `complete` boundary:** `mutation-gateway-isolation.sh` asserts `assertVariableValue` is called (or a thin wrapper calling it) in `src/core/jobStore.ts`'s `complete` method before advancing state. Not optional, not flag-guarded. | `bash ci/checks/mutation-gateway-isolation.sh` (AC-5) | static-now |
| **FF-G3** | **Deferred bridge contract probe:** `ci/checks/flowable-bridge-contract.sh` exits 0 when no bridge path (`src/bridge/`, `src/core/flowable*.ts`) exists. When the bridge path IS present, the script asserts every bridge result-return file calls `assertVariableValue` and every record mutation routes through `resolveFor`. | `bash ci/checks/flowable-bridge-contract.sh` (AC-8) | exits-0-now / activates-in-T-0058 |
| **FF-G4** | **Complete payload — raw record rejected fail-closed:** `JobStore.complete(workerId, jobId, payload)` where any value in `payload` fails `assertVariableValue` returns `{ ok: false, code: "RECORD_IN_PAYLOAD" }` and leaves the job in `LOCKED` state. All-or-nothing. | `vitest run src/__tests__/variable-guard.test.ts -t "complete-payload"` (AC-2, AC-4) | static-now |
| **FF-G5** | **Clean payload succeeds (no regression):** `JobStore.complete(workerId, jobId, payload)` with a payload of handles + inert literals returns `{ ok: true }` and advances to `COMPLETED`. `complete(workerId, jobId)` without payload is byte-identical to today. | `vitest run src/__tests__/variable-guard.test.ts -t "clean-payload\|no-payload-regression"` (AC-3) | static-now |
| **FF-G6** | **Additive — frozen exports unchanged:** `git diff --name-only` for this task's commit does NOT include edits to `src/core/object-handle.ts` or `src/core/grant-lattice.ts` or `src/core/grant-resolver.ts`. `CompleteResult` includes `RECORD_IN_PAYLOAD` alongside the existing four codes. `tsc --noEmit` passes. | `bash ci/checks/mutation-gateway-isolation.sh` (additive-check) + `tsc --noEmit` (AC-7) | static-now |
| **FF-G7** | **No regression on pre-existing fitness functions:** `single-resolver.sh`, `no-record-in-variable.sh`, `object-handle-isolation.sh`, `grant-resolver-isolation.sh`, `audit_append_only.sh` all remain green. | `npm run fitness` (AC-9) | static-now |
| **FF-G8** | **Write-op path is typed:** Any invocation of `resolveFor` with a write op compiles against the T-0018 `Operation` type with no cast. The `Operation` type from `grant-lattice.ts` is used directly; no ad-hoc string literal is accepted in a write-op position. | `tsc --noEmit` (AC-10) | static-now |

---

## 7. Adversarial fitness corpus

The test suite for `src/__tests__/variable-guard.test.ts` MUST cover the following adversarial inputs
(derived from spec §6 and T-0015 adversarial history R-1..R-4):

| # | Input | Expected result | Maps AC |
|---|---|---|---|
| ADV-1 | Payload `{ result: { kind:"record", registryId:"…", recordId:"…", data:{…} } }` | `RECORD_IN_PAYLOAD` | AC-2 |
| ADV-2 | Payload `{ wrapper: { inner: { kind:"record", registryId:"…", recordId:"…" } } }` | `RECORD_IN_PAYLOAD` (recursive traversal via `assertVariableValue`) | AC-2, AC-4 |
| ADV-3 | Payload `{ handle: <valid ObjectHandle>, rec: { kind:"record", registryId:"…", recordId:"…" } }` | `RECORD_IN_PAYLOAD` — all-or-nothing | AC-4 |
| ADV-4 | Payload `{ handle: <valid ObjectHandle> }` | `ok: true`, job advances to COMPLETED | AC-3 |
| ADV-5 | Payload `{}` (empty object) | `ok: true` | AC-3 |
| ADV-6 | Payload `{ n: 42, s: "hello", b: true, nil: null }` (inert primitives only) | `ok: true` | AC-3 |
| ADV-7 | `complete(workerId, jobId)` — no payload (2-arg form) | `ok: true`, byte-identical to existing behavior | AC-3 |
| ADV-8 | Payload `{ s: '{"kind":"record","registryId":"x","recordId":"y"}' }` (JSON string) | `ok: true` — string is an inert literal; guard does not parse strings | §2 decision |
| ADV-9 | Payload `{ arr: [{ kind:"record", registryId:"…", recordId:"…" }] }` | `RECORD_IN_PAYLOAD` (array recursion) | AC-2, AC-4 |
| ADV-10 | Payload `{ obj: { data: "not-a-record", otherKey: "x" } }` — object with `data` key | `RECORD_IN_PAYLOAD` (raw_object_with_data) | AC-2 |
| ADV-11 | Structural adversarial: a new function in a non-gateway module importing a writable record accessor | `mutation-gateway-isolation.sh` exits non-zero | AC-1, AC-6 |
| ADV-12 | `complete` call where one of the EXISTING ownership gate checks fires (NOT_FOUND etc.) | Existing error code returned; payload not evaluated (gate precedence unchanged) | AC-3, regression |

---

## 8. Layer C — Flowable bridge contract (deferred, sealed here)

The invariants T-0058+ MUST satisfy (enforced by FF-G3 when the bridge is built):

1. Every result returned from an external task is passed through `assertVariableValue` before
   being stored in any process-variable map. Failure → the task is NACK'd; the engine is NOT
   given a mutation it did not authorize.
2. Every record mutation triggered by an external task routes through
   `resolveFor(deps, handle, subject, op)` with the appropriate write `op` from the T-0018
   `Operation` type and the task's subject. No DAO call bypasses the gateway.
3. The bridge does not introduce a `MutatingRecordSource` implementation outside the gateway
   composition. If one is introduced (T-0053 territory), it is injected only at the gateway
   composition root, not exported as a standalone injectable.

These are not acceptance criteria for T-0028 (the bridge does not exist yet), but they are sealed
as the contract this task establishes. Violating them at bridge-build time is a defect traceable
to T-0028's AC-8.

---

## 9. Traceability (AC → design)

| AC | covered_by |
|---|---|
| AC-1 | §6 FF-G1 + `mutation-gateway-isolation.sh` (Layer A structural isolation) |
| AC-2 | §4.4 guard algorithm step 2 (payload validation fail-closed); FF-G4; ADV-1..ADV-3, ADV-9, ADV-10 |
| AC-3 | §4.4 step 3 (clean payload advances); §2 (no-payload backward compat); FF-G5; ADV-4..ADV-8 |
| AC-4 | §4.4 step 2 (all-or-nothing — first failure returns immediately); FF-G4; ADV-3, ADV-9 |
| AC-5 | §6 FF-G2 + `mutation-gateway-isolation.sh` call-site check; §4.4 (guard called before state advance) |
| AC-6 | §6 FF-G1 + `mutation-gateway-isolation.sh` (no new parallel write path) |
| AC-7 | §5.1 (frozen exports unchanged); §4.1 (ErrorCode extended additively); FF-G6 |
| AC-8 | §8 bridge contract; FF-G3 + `ci/checks/flowable-bridge-contract.sh` |
| AC-9 | §6 FF-G7 (pre-existing fitness functions unchanged) |
| AC-10 | §4.3 (`Operation` type from grant-lattice.ts, no cast); FF-G8 |

---

## 10. Runtime target

**Local / in-process (static-now).** The guard is a pure TS extension to the existing Node app;
its fitness suite runs under `vitest` in `npm run ci` with no external resource. T-0028 provisions
no new infrastructure. Postgres-backed store (T-0114/T-0053) and Flowable bridge (T-0058+) are
separate concerns; the guard works identically on both the in-memory and Postgres store
implementations (same `assertVariableValue` call, same `RECORD_IN_PAYLOAD` code).

---

## 11. Escalation

None. T-0028 sits entirely inside the GT-1-signed RBAC hypothesis (§1 caveat, §6-A #1) and the
merged T-0015/T-0021 foundation. The three-layer scope model is resolved by the spec (§0) with
explicit rationale from the existing ADRs — T-0015's FF-A4 defers call-site enforcement to
T-0028; T-0021's FF-R9/AC-15 defers the runtime guard to T-0028. Both defer targets are this
task. No product-direction fork is opened; no cross-vendor product loop is required.
