# Spec · T-0028 — Engine State-Mutation Guard

**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-06-10
**Task:** E2.7 — Engine state-mutation guard: forbid object mutation except via the gateway
**Authoritative source:** `playbooks/rbac-backlog.md#E2.7` (GT-1, founder-signed 2026-06-08) ·
`playbooks/rbac-discovery-phase1-hypothesis.md` §1 (the enforcement caveat), §6-A #1 (gateway
chokepoint)
**Foundation (do NOT contradict):**
- `docs/design/T-0015-object-handles.adr.md` — `assertVariableValue` write-boundary guard + the
  single `resolveHandle` port. T-0028 enforces the call-site half of FF-A4 (the guard must be
  called at every variable-write boundary in the engine path) that T-0015 deferred because no
  engine path existed yet.
- `docs/design/T-0021-grant-resolver-pdp.adr.md` — `resolveFor` is the sole read/write decision
  core; the write-path callers (`op ∈ create/update/delete/approve/transition`) must route through
  `resolveFor`, not bypass it. FF-R9 (AC-15 of T-0021) activates here.
- `docs/design/T-0018-grant-authority.adr.md` — the `grant` algebra; `Operation` enum covers
  write ops.
- `src/core/grant-resolver.ts` — the existing `resolveFor(deps, handle, subject, op)` and
  `makeGrantResolver` factory (T-0021's deliverable, already merged).
- `src/core/object-handle.ts` — `assertVariableValue`, `isObjectHandle`, `ObjectHandle`
  (T-0015's deliverable, already merged).
- `src/core/jobStore.ts` — the existing `JobStore.complete(workerId, jobId)` seam: the
  `complete` payload is the current external-task result-return path, the one structural location
  today where an external worker could inject mutations back into the system.
**Siblings referenced, not built here:**
- T-0027 (BPMN deploy-time linter — static guard on process definitions at deploy time; that is
  the deploy-path half; T-0028 is the runtime-path half)
- T-0053 (Postgres-backed `GrantSource`/`RecordSource` + RLS DAO — the DB-level "no direct DAO
  path" enforcement)
- T-0058 / T-0064 / T-0067 (Flowable external-task bridge; the full engine↔gateway integration
  seam where the guard's runtime assertions become structurally mandatory)

---

## 0. Scope resolution: what "engine state-mutation guard" means today

Choros today is an in-memory TS/Node app. **Flowable is not integrated** — no BPMN engine, no
connector framework, no EL runtime exists in code. The full engine↔gateway integration is
targeted at T-0058/T-0064/T-0067.

This means the literal reading of E2.7 ("the engine cannot write objects directly") has no
engine substrate to enforce against yet. The spec must resolve what the guard **is** today and
what it **contracts** for the future, so the architect and coder have a precise, testable target.

### Three-layer scope model (resolved here, not deferred)

**Layer A — structural isolation (build NOW):**
The `RecordSource` writable-side — i.e. any mutation of a record — exists ONLY behind
`resolveFor`. No module outside `grant-resolver.ts` + its composition root may import a writable
path to records. This is enforced structurally: the `RecordSource` port in `grant-resolver.ts`
is read-only today (`getRecord` only); a `MutatingRecordSource` port for write operations is
**sealed inside the gateway composition** and not exported as a standalone injectable. An
isolation CI check (`ci/checks/mutation-gateway-isolation.sh`) verifies that no module outside
the gateway composition imports a writable record accessor directly.

The existing `assertVariableValue` write-boundary guard (T-0015 `src/core/object-handle.ts`) is
the runtime companion: every path that writes to `Job.variables` (or any future
variable-map-equivalent) MUST call `assertVariableValue` and reject on `ok:false`. This is the
call-site half of T-0015's FF-A4 — T-0015 shipped the guard, T-0028 enforces its call sites.

**Layer B — external-task complete-payload guard (build NOW):**
The `JobStore.complete` seam is the one structural location where an external worker returns
results to the system today. A worker completing a job can pass arbitrary data back. The guard
ensures that **complete payloads may not carry raw record objects** — only handles + allowed
inert literals. This maps directly to `assertVariableValue`: the `complete` path validates every
value in the payload with `assertVariableValue` and rejects `ok:false` entries fail-closed
(returning an error to the caller, NOT silently stripping the offending fields).

This is the "runtime half" of the chokepoint for the current codebase: since the full Flowable
external-task bridge does not yet exist, `JobStore.complete` is the only mutation-return seam.
It is auditable and testable today.

**Layer C — Flowable bridge contract (deferred to T-0058+, sealed here):**
When the Flowable external-task bridge lands (T-0058/T-0064/T-0067), every result-return path
from the bridge back to the system MUST route through the gateway's `resolveFor` with the
correct write `op`, and MUST NOT carry raw record objects in the payload. This is the same
invariant as Layer B but at the bridge seam. T-0028 defines the contract that T-0058+ MUST
satisfy; it does not build the bridge. The contract is machine-verifiable when the bridge exists
via the same `assertVariableValue` + `resolveFor` checks.

---

## 1. Summary

Build structural and runtime guards that make direct object mutation — outside the gateway
(`resolveFor`) — impossible by construction in the current codebase, and seal the contract that
the future Flowable bridge must satisfy. Two deliverables: (a) an isolation CI check proving
no writable record accessor escapes the gateway module boundary; (b) a `complete`-payload guard
in `JobStore.complete` that rejects raw record objects fail-closed, using the existing
`assertVariableValue`.

---

## 2. Functional requirements

**FR-1** — **Gateway is the sole write path (structural):** No module outside
`src/core/grant-resolver.ts` and its composition root may import or invoke a writable record
accessor (any function that persists or mutates a record's fields) directly. This is a module
boundary invariant, enforceable by a static CI check.

**FR-2** — **Variable write boundary is guarded:** Every location in the codebase that writes a
value into `Job.variables` (or any future variable-map path) calls `assertVariableValue` and
rejects `{ ok: false }` payloads before storage. The guard must be called, not optional.

**FR-3** — **Complete payload validation (fail-closed):** `JobStore.complete` validates each
value in any payload data passed by a worker. A raw record object in the payload (`ok:false` from
`assertVariableValue`) causes the `complete` call to return a new error code `RECORD_IN_PAYLOAD`
and the job state is NOT advanced to `COMPLETED`. No partial acceptance: all-or-nothing.

**FR-4** — **Write ops route through `resolveFor`:** When a record mutation is needed (present
codebase: none yet; future bridge: create/update/delete/approve/transition), the call goes
through `resolveFor(deps, handle, subject, op)` with the appropriate `op` from T-0018's
`Operation` enum. No second write path is introduced.

**FR-5** — **Fail-closed on missing guard:** If the guard call is absent at a variable-write
boundary (i.e. the call site is omitted), the behaviour defaults to rejection. The guard's
absence is NOT treated as "allow" — the isolation check (FR-1) makes the omission detectable in
CI, not silent.

**FR-6** — **Bridge contract sealed (deferred enforcement):** The spec records that any future
Flowable external-task bridge (T-0058+) MUST:
(a) validate all result payloads with `assertVariableValue` before accepting them, and
(b) route all record mutations through `resolveFor` with the correct write op.
This contract is stated in the ADR and wired as a deferred fitness function (FF-G3) that
activates when the bridge is built.

---

## 3. Non-functional requirements

**NF-1** — **No new external dependencies:** The guard and isolation check are pure TS +
`node:crypto` stdlib (same posture as T-0015/T-0018/T-0021). No new packages.

**NF-2** — **Additive:** The module changes are additive. `JobStore`'s existing public API
gains one new `ErrorCode` value (`RECORD_IN_PAYLOAD`) to `CompleteResult`; no existing error
code is removed or renamed. The `complete` signature does not change. `object-handle.ts`,
`grant-lattice.ts`, and `grant-resolver.ts` exports are not modified.

**NF-3** — **No record in payload is not "strip silently":** A complete payload with a raw
record triggers a hard rejection, not a silent redaction. The caller (the worker) receives an
explicit error. This preserves the fail-closed discipline of the authority core.

**NF-4** — **CI gate:** All Layer A and Layer B fitness functions run in `npm run ci`
(`tsc --noEmit && eslint src && npm run fitness && vitest run`) with no external resource. The
deferred Layer C fitness function (FF-G3) is authored now as a probe that activates when the
bridge path exists.

**NF-5** — **Proportional scope:** T-0028 does not build the Flowable bridge, does not implement
record-mutation logic, and does not add a `MutatingRecordSource` implementation. Those are
T-0053 and T-0058+. This task is the structural guard and the seam contract.

---

## 4. Out of scope

- Building the Flowable external-task bridge (T-0058, T-0064, T-0067).
- Implementing `MutatingRecordSource` (the writable side of the record port) — deferred to T-0053
  and the bridge tasks.
- The BPMN deploy-time linter rejecting raw-object variable bindings (T-0027).
- The Postgres RLS "no direct DAO path" at the DB layer (T-0053).
- Value-aware masking, data classification, facet algebra (T-0033 / E4.3).
- Any runtime behavior keyed on the Flowable engine (tokens, BPMN execution, boundary events).
- Modifying `resolveFor` internals — T-0028 **uses** `resolveFor`, it does not rewrite it.

---

## 5. Acceptance criteria

| ID | Text | verifiable_as |
|---|---|---|
| AC-1 | **Isolation check — no writable accessor outside gateway:** `ci/checks/mutation-gateway-isolation.sh` exits 0 on the current codebase, confirming no module outside `src/core/grant-resolver.ts` imports a symbol that mutates record fields. | fitness |
| AC-2 | **Complete payload — raw record rejected fail-closed:** A `JobStore.complete` call where the payload data includes a value that `assertVariableValue` returns `{ ok:false }` for returns `{ ok:false, code:"RECORD_IN_PAYLOAD" }` and leaves the job in `LOCKED` state (unchanged). | test |
| AC-3 | **Complete payload — clean payload succeeds:** A `JobStore.complete` call with a payload containing only handles and inert literals (`assertVariableValue` returns `{ ok:true }` for all values) continues to behave as before — returns `{ ok:true }` and advances the job to `COMPLETED`. No regression. | test |
| AC-4 | **Complete payload — all-or-nothing:** A payload with one invalid value and N valid values returns `RECORD_IN_PAYLOAD`; the job does NOT advance even if only one value fails. | test |
| AC-5 | **assertVariableValue is called at the complete boundary:** A static grep over `src/core/jobStore.ts` confirms that the `complete` method calls `assertVariableValue` (or a thin wrapper that calls it) before advancing job state. The call is not optional / guarded by a flag. | fitness |
| AC-6 | **No second mutation path introduced:** `ci/checks/mutation-gateway-isolation.sh` also asserts no new `*mutate*`/`*write*`/`*persist*` function mapping a `ResourceRef` to record fields appears outside `src/core/grant-resolver.ts`. | fitness |
| AC-7 | **Additive — existing exports unchanged:** `git diff --name-only` for this task's commit does NOT include edits to `src/core/object-handle.ts`, `src/core/grant-lattice.ts`; `CompleteResult` error codes include the new `RECORD_IN_PAYLOAD` value alongside the existing four. `tsc --noEmit` passes. | fitness |
| AC-8 | **Bridge contract authored:** `docs/specs/T-0028-engine-mutation-guard.spec.md` states in §2 / FR-6 that the future Flowable bridge (T-0058+) MUST validate payloads with `assertVariableValue` and route record mutations through `resolveFor`. The deferred fitness function FF-G3 is present in `ci/checks/` as a probe (exits 0 when bridge path absent, activates when bridge path exists). | fitness |
| AC-9 | **No regression on existing CI:** All pre-existing fitness functions (`single-resolver.sh`, `no-record-in-variable.sh`, `object-handle-isolation.sh`, `grant-resolver-isolation.sh`, `audit_append_only.sh`) remain green. | fitness |
| AC-10 | **Write-op path is typed (future-proof):** Any invocation of `resolveFor` with a write `op` (not `"read"`) compiles against the T-0018 `Operation` type with no cast. The spec and ADR make clear that `op ∈ {create, update, delete, approve, transition}` are the permitted write ops — no ad-hoc string is accepted. | fitness |

---

## 6. Adversarial cases

The following adversarial inputs MUST be covered by the test suite (AC-2, AC-4):

1. **Raw record in complete payload — single field:** `{ result: { kind:"record", registryId:"…", recordId:"…", data:{…} } }` → `RECORD_IN_PAYLOAD`.
2. **Raw record disguised in nested object:** `{ wrapper: { inner: { kind:"record", … } } }` — `assertVariableValue` must recurse into plain objects; if it does NOT, this is a known gap to document and flag as future hardening (not a blocker for this task).
3. **Mixed payload (one handle, one raw record):** Only the raw record fails; the whole `complete` is rejected (all-or-nothing — AC-4).
4. **Handle in payload — passes:** A valid `ObjectHandle` value in the payload (`isObjectHandle(v) === true`) passes `assertVariableValue` and the `complete` call succeeds.
5. **Empty payload / payload with only primitives:** Passes through cleanly, no regression.
6. **`complete` without payload data parameter (backward compat):** The existing `complete(workerId, jobId)` signature with no payload changes compiles and behaves identically.
7. **Mutation attempt outside gateway (structural adversarial):** Introducing a new function in any non-gateway module that imports and calls a writable record accessor → `mutation-gateway-isolation.sh` exits non-zero. (Verified as a compile-time / grep fixture, not a runtime test.)

---

## 7. Deferred contract for T-0058+ (Flowable bridge)

When the Flowable external-task bridge lands (T-0058/T-0064/T-0067), the following invariants
MUST hold, enforced by FF-G3 (the probe authored in T-0028):

1. **Every result returned from an external task** is passed through `assertVariableValue` before
   being stored in any process-variable map. Failure → the task is NACK'd (not completed); the
   engine is NOT given a mutation it did not authorize.
2. **Every record mutation** triggered by an external task result (e.g. completing a record-write
   task) routes through `resolveFor(deps, handle, subject, op)` with the appropriate write `op`
   and the task's subject. No DAO call bypasses the gateway.
3. **The bridge does not introduce a writable `RecordSource` implementation** outside the gateway
   composition. If a `MutatingRecordSource` is introduced (T-0053 territory), it is injected
   only at the gateway composition root, not exported as a standalone injectable from any module.

These are not acceptance criteria for T-0028 (the bridge does not exist yet), but they are
sealed as the contract this task establishes. Violating them at bridge-build time is a defect
traceable to T-0028's AC-8.

---

## 8. No blocking questions

No BLOCKING questions exist. The scope decision (what "engine guard" means before engine
integration) is resolved explicitly in §0 with clear rationale from the existing foundation ADRs:
T-0015's FF-A4 defers call-site enforcement to T-0027/T-0028; T-0021's FF-R9 / AC-15 defers the
runtime guard activation to T-0028. Both defer targets are this task. No founder decision is
required — the resolution follows directly from the GT-1-signed hypothesis and the merged ADRs.
