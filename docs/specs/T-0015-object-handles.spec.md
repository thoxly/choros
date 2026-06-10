# Spec · T-0015 — Opaque Object Handles

**Phase:** SPEC · **Status:** ready (no founder escalation) · **Date:** 2026-06-10
**Task:** E2.4 — Opaque object handles (`object_handle`)
**Raw TZ:** `playbooks/rbac-backlog.md` §E2.4
**Deps:** E2.1 (T-0013 tenant isolation), consumes E2.2 (T-0014 `ResourceRef` record identity)
**Consumed by:** E2.5 (T-0021 data-access gateway / PDP — the *only* resolver of a handle), E2.6 (T-0027 BPMN deploy-linter), E2.7 (T-0028 engine state-mutation guard)

---

## 1. What we are building (one sentence)

A **structurally opaque reference type** — `object_handle` — such that engine process
variables, connectors, and EL expressions can address a tenant record **only** by a handle
(tenant_id + a T-0014 `ResourceRef` UUID + minimal addressing), **never** by carrying the
record's field payload, and a handle yields a record only when resolved through the
gateway (T-0021); plus the structural invariant + fitness guard that makes "a variable
cannot hold a record payload" provable, not hoped.

---

## 2. Why this exists (load-bearing rationale)

Choros's whole authorization thesis (hypothesis §1 caveat) is that **the gateway is the
single object read/write chokepoint** (E2.5). That chokepoint is only real if nothing can
*route around* it by stashing a record payload somewhere the gateway never sees. The
dangerous somewhere is the **engine variable map** (`Job.variables: Record<string,
unknown>`), connector inputs/outputs, and EL expression operands: if a process can copy a
record's fields into a variable, then every later read of that variable is an
ungated, unfiltered, un-audited read — humans-through-engine-variables leak exactly the
way an unconstrained agent would. E2.4 closes that route: **variables carry opaque handles
only.** A handle is a *reference, not data*; the bytes a record contains never enter the
variable map. The only way to turn a handle back into (a filtered view of) a record is to
ask the gateway, which applies the grant (T-0018) at action-time.

This task **defines the handle type, the opacity invariant, and the gateway-resolution
seam (the port T-0021 implements)**. It does **not** implement the PDP, the BPMN linter, or
the engine mutation guard — those are T-0021/T-0027/T-0028 and consume this contract.

---

## 3. Functional requirements

- **FR-1 — Opaque handle type.** An `object_handle` is a typed reference carrying exactly:
  `tenant_id` (T-0013 key), a T-0014 `ResourceRef` (the immutable resource UUID it points
  at: `application | registry | record`), and minimal addressing (an opaque
  `handle_id` identity + an optional `facet` narrowing token). It carries **no record
  field / payload value** of the addressed object.
- **FR-2 — Opacity is structural.** The handle value, as seen by the engine / connectors /
  EL, exposes **no record data** and is **not** a plain readable record object: a consumer
  holding a handle cannot read any addressed field off it without going through the
  gateway. (Branded / nominal opaque type at the TS boundary; an inert addressing token at
  the persistence boundary.)
- **FR-3 — Variable-map invariant.** A process variable value (`Job.variables[*]`,
  connector I/O, EL operand) may be a handle or a primitive/structural literal, but **must
  not** be a record payload. A record-shaped payload placed into a variable is **rejected**
  by a structural guard at the write boundary (assignment into the variable map), not
  merely flagged later.
- **FR-4 — Gateway-only resolution (the seam).** A handle is resolved to a (grant-filtered)
  record view **only** through a single resolution port — `resolveHandle(handle, subject)
  → filtered view` — that T-0021 implements. T-0015 defines this port's **signature and
  contract** (inputs, output shape, fail-closed semantics); it does **not** implement the
  PDP behind it. There is **no** other code path (no direct DAO, no `.data` accessor on the
  handle) that turns a handle into record fields.
- **FR-5 — Handle construction is reference-only.** A handle is built purely from a
  persisted resource's identity columns (a `ResourceRef`, T-0014 §5) + tenant_id; its
  constructor performs **no** record read and **no** authorization decision. Constructing a
  handle reveals nothing about the record's contents or the subject's rights.
- **FR-6 — Tenant-bound, rename-safe.** Every component of a handle is scoped under one
  `tenant_id` (a handle can never span tenants), and the resource it addresses is an
  **immutable UUID** (never a slug), so a slug/display-name rename never re-targets or
  invalidates a handle (inherits T-0014 NF-3).
- **FR-7 — Round-trip identity, not payload.** Serializing a handle (e.g. for storage in a
  persisted variable or `object_handle` row) and re-reading it yields the **same reference**
  (same tenant_id + ResourceRef + facet) and still no payload — opacity survives
  serialization.

---

## 4. Non-functional requirements

- **NF-1 — Capability-not-text.** A handle is a capability-style reference checked by the
  gateway at resolution time, never a free-text path or a smuggled payload (red-lines:
  capability-not-text).
- **NF-2 — Single resolution chokepoint.** Exactly one seam (`resolveHandle`) turns a
  handle into record fields; T-0015 introduces no second resolution path and no
  payload-bearing handle variant.
- **NF-3 — Tenant isolation inherited (T-0013).** The `object_handle` persistence (when it
  lands, T-0053) is an ordinary T-0013 tenant table (tenant_id leading, FORCE RLS,
  default-DENY, `withTenant` access); a handle is meaningless / unresolvable outside its
  tenant context.
- **NF-4 — Additive, non-breaking.** The handle is a **new** module
  (`src/core/object-handle.ts`); it does not modify existing public exports of
  `src/core/types.ts`, `src/core/grant-lattice.ts`, or `src/core/jobStore.ts`
  (FE-W23-0008 compatibility).
- **NF-5 — Deterministic, side-effect-free core.** Handle construction, opacity check, and
  the variable-guard are pure functions (no DB / IO / network / LLM); the static-now core
  is verifiable in `npm run ci` with no external resource.
- **NF-6 — Resolver-agnostic contract.** T-0015 fixes the `resolveHandle` port shape such
  that T-0021 plugs in without re-opening this task — the same discipline T-0014 used to
  hand T-0018 a closed `ResourceRef`.

---

## 5. Out of scope (explicit non-goals)

- **The PDP / `grant_resolver` runtime** behind `resolveHandle` — resolution order, grant
  evaluation, field masking, action-time (TOCTOU-safe) binding, caching — **T-0021 (E2.5)**.
  T-0015 fixes only the port the resolver implements.
- **The BPMN deploy-time linter** that rejects raw-object bindings in process definitions —
  **T-0027 (E2.6)**. T-0015 supplies the type discipline + runtime guard it enforces at
  deploy time; it does not parse BPMN.
- **The engine state-mutation guard** (forbidding direct object writes off the engine) —
  **T-0028 (E2.7)**.
- **SQL DDL / migrations / RLS policy body** for the `object_handle` table — **T-0053**
  (Postgres-in-compose). T-0015 fixes the table's columns/constraints as a contract; it
  writes no DDL.
- **The `ResourceRef` resource model itself** — already fixed by **T-0014**; T-0015
  consumes it, does not redefine it.
- **Grant semantics / the authority table** — **T-0018 (E2.3)**; the gateway applies grants
  *inside* `resolveHandle`, which is T-0021.
- **Migrating `Job.variables` storage to Postgres** — T-0053; T-0015 fixes the variable-map
  invariant + guard, not the persistence migration.

---

## 6. Acceptance criteria (machine-checkable)

Each criterion is written so it becomes a vitest test or a CI lint. `static-now` = runnable
in today's `npm run ci`; `activates-in-T-0053` = a live-DB probe authored now, gated on
Postgres. (Gating is the architect's to finalize; the criteria themselves are testable.)

| ID | Criterion | verifiable_as |
|---|---|---|
| **AC-1** | An `ObjectHandle` value carries exactly `tenantId`, a `ResourceRef` (T-0014 kind+UUIDs), an opaque `handleId`, and an optional `facet`; it has **no** record-field/payload property. A compile-time + structural fixture asserts the shape has no `data`/payload member. | test |
| **AC-2** | Opacity: given a handle, there is **no** accessor/branch that returns the addressed record's fields without calling `resolveHandle`. A fitness lint asserts no payload accessor exists on the handle type and the handle is a branded/nominal type (a raw record object is **not** assignable to `ObjectHandle`). | fitness |
| **AC-3** | Variable-map guard accepts a handle and primitive/structural literals into a process-variable value, and **rejects** a record-shaped payload (an object matching the T-0014 `record` shape, e.g. having `data` + registry identity, or a raw registry-record object) with a typed rejection — at assignment, before the value is stored. | test |
| **AC-4** | `resolveHandle(handle, subject)` port is defined with a fixed signature and **fail-closed** contract (subject without a satisfying grant ⇒ a denied/empty filtered view, never the raw record); T-0015 ships the port + a default deny-all stub, and a test asserts the stub denies. T-0021 replaces the stub with the PDP. | test |
| **AC-5** | Handle construction is reference-only: `makeHandle(resourceRef, tenantId)` builds a handle from a `ResourceRef` + tenant_id with **no** record read and **no** authorization call; a test asserts construction touches no record store and reveals no field. | test |
| **AC-6** | Tenant-bound + rename-safe: a handle's `ResourceRef` components are UUIDs (a slug/display-name value is rejected by a lint as a handle target); every component shares one `tenantId`; a cross-tenant handle (mixed tenant_ids) is rejected at construction. | fitness |
| **AC-7** | Round-trip: `parseHandle(serializeHandle(h))` deep-equals `h` (same tenant_id + ResourceRef + facet) and the serialized form contains **no** record-field value — only identity. | test |
| **AC-8** | Single resolution chokepoint: a CI lint asserts the only function that maps a handle → record fields is `resolveHandle`; no `.data`/`.fields`/`.payload` accessor exists on `ObjectHandle`, and no second resolver entry-point is exported. | fitness |
| **AC-9** | Additive/non-breaking: the new module does not change any existing export of `src/core/types.ts`, `src/core/grant-lattice.ts`, `src/core/jobStore.ts`; `git diff` touches no existing public symbol; the module imports nothing from `jobStore`/`http`/`pg`/`fs`/`net`. | fitness |
| **AC-10** | `object_handle` is a registered T-0013 tenant table (in `known_tenant_tables` fixture static-now; live FORCE RLS = (true,true); no tenant context ⇒ count 0). Static-now: fixture entry. Live: T-0053 probe. | test |

---

## 7. Blocking questions

**None.** E2.4 is well-specified: the build (`object_handle` table + handle-only variable
discipline), the acceptance (no variable holds a record; resolution is gateway-only), the
dependency (T-0013 tenant base, T-0014 `ResourceRef`), and the consumer seam (T-0021
gateway) are all fixed by the GT-1-signed hypothesis and the merged sibling ADRs. The one
forward-looking judgement — that Choros has no connector/EL/BPMN engine surface in code
*yet*, so the variable-map invariant is expressed as a type + guard the future engine MUST
use (the same "pin the invariant before the substrate exists" discipline as T-0013/T-0014/
T-0018) — is a design choice, not a scope-changing ambiguity, and is recorded for the
architect rather than escalated. Status: **ready**.
