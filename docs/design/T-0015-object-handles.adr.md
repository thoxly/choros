# ADR · T-0015 — Opaque Object Handles

**Status:** ready (no founder escalation)
**Phase:** DESIGN
**Date:** 2026-06-10
**Task:** E2.4 — Opaque object handles (engine variables/connectors/EL carry handles only, never records)
**Spec:** `docs/specs/T-0015-object-handles.spec.md` + `docs/specs/T-0015.spec.contract.json` (FR-1..FR-7, NF-1..NF-6, AC-1..AC-10)
**Foundation (does NOT contradict):** `docs/design/T-0013-tenant-isolation.adr.md` (`object_handle` is a FORCE-RLS default-DENY tenant table, `tenant_id` leading, accessed via `withTenant`) · `docs/design/T-0014-registry-model.adr.md` §5 (`ResourceRef` — immutable UUID discriminated union `application | registry | record`; a handle points AT a `ResourceRef`, never at a slug) · `docs/design/T-0018-grant-authority.adr.md` (the **static-now-pure-TS-module** discipline mirrored here; the grant the gateway applies behind the seam)
**Siblings consumed-by / not-built-here:** T-0021 (E2.5 PDP/`grant_resolver` — *implements* the `resolveHandle` port defined here) · T-0027 (E2.6 BPMN deploy-linter — *enforces* the handle-only variable discipline at deploy time) · T-0028 (E2.7 engine state-mutation guard) · T-0053 (E0.3 Postgres-in-compose — the `object_handle` DDL/RLS land there)

---

## 1. Context

This is a **DESIGN-only, two-deliverable** task, in the exact shape of its merged siblings.
Choros today is an in-memory TS/Node app: `Job.variables` is a `Record<string, unknown>`
(`src/core/types.ts`), there is no Postgres, no connector framework, no BPMN/EL engine in
code yet. Like T-0013/T-0014/T-0018, T-0015 pins the **invariants, object model, contracts,
and fitness functions** any correct object-handle implementation MUST satisfy; the `pg`
`object_handle` table DDL/RLS defers to **T-0053**, and the resolver behind the seam
defers to **T-0021**.

Like T-0018 (and unlike T-0013/T-0014), T-0015 has a **static-now buildable core**: the
opaque-handle type, the opacity brand, the **variable-map guard**, the handle
constructor/serializer, and the **`resolveHandle` resolution port (with a deny-all stub)**
are **pure TS with no DB dependency**. The riskiest invariant — *a process variable can
never hold a record payload, and a handle yields a record only through the gateway* — is
therefore provable in vitest **before any engine or DB exists**, the same way T-0018 proved
monotonic narrowing early.

The load-bearing decision: a record never enters the engine substrate as **data**; it
enters only as an **opaque handle** (a tenant-scoped reference to a T-0014 `ResourceRef`),
and the **only** edge that turns a handle back into record fields is a single
gateway-resolution port. "A variable cannot hold a record" is made **structural** — a
branded opaque type plus a write-boundary guard that rejects record-shaped payloads —
not a code-review hope.

This task **does not** implement the PDP (T-0021), the BPMN linter (T-0027), or the engine
mutation guard (T-0028); it hands each of them a closed contract, exactly as T-0014 handed
T-0018 a closed `ResourceRef`.

---

## 2. Decision

**Adopt `ObjectHandle` — a branded, structurally-opaque, tenant-scoped reference type that
carries exactly `{ tenantId, ref: ResourceRef (T-0014), handleId, facet? }` and *no record
field*. Engine process variables, connector I/O, and EL operands may hold a handle or an
inert literal but never a record payload; this is enforced at the variable-write boundary
by `assertVariableValue(value)`, a structural guard that rejects any record-shaped object
(an object exposing a `ResourceRef`-record identity together with a `data`/payload, or any
value carrying addressed record fields) with a typed rejection — before the value is
stored. A handle is turned back into a (grant-filtered) record view by exactly one seam,
the resolution port `resolveHandle(handle, subject) -> Promise<ResolvedView>`, which
T-0021 implements; T-0015 ships the port type plus a default `denyAllResolver` stub that
fails closed (returns a denied view), so the chokepoint exists and is tested from day one
and T-0021 swaps the stub for the PDP without changing the contract. The handle constructor
`makeHandle(ref, tenantId)` is reference-only (no record read, no authorization), and
`serializeHandle`/`parseHandle` round-trip identity (never payload). The handle type, brand,
guard, constructor, (de)serializer, port type, and deny-all stub are built NOW as a
self-contained pure-TS module `src/core/object-handle.ts` with vitest fitness tests; the
`object_handle` Postgres table (a T-0013 tenant table) and its DDL/RLS land in T-0053, and
the resolver behind the port lands in T-0021.**

The mechanism is **proportional** (rubric axis 5): a small reference type, one nominal
brand, one structural guard predicate, one constructor, one (de)serializer, and one port
interface with a deny-all default. There is no payload cache, no handle registry runtime,
no resolution logic in this task — the logic lives at the boundary (T-0021), exactly as the
product principle demands (CONCEPT §5: thin core, logic at the edges).

### 2.1 Why opacity must be structural, not conventional (the crux)

If "variables carry handles, not records" were a *convention*, the first connector that
copies `record.data` into a variable silently re-opens the leak the entire E2 chokepoint
exists to close — and nothing fails until an auditor notices, which is the detect-not-
prevent anti-pattern T-0013 §2 rejects. So opacity is made structural on **two** edges:

1. **The handle type is branded** (a unique symbol member), so a plain record object is
   **not** assignable to `ObjectHandle` at the type level, and `ObjectHandle` exposes **no**
   member that returns addressed record fields. The only way to obtain fields is to pass the
   handle to `resolveHandle`. (FF-2, FF-8.)
2. **The variable-write boundary is guarded.** `assertVariableValue` rejects a record-shaped
   payload structurally at assignment, so even untyped/`unknown` data flowing from a
   connector cannot land a record in the variable map. (FF-3.)

Type-level opacity stops the *typed* leak; the runtime guard stops the *untyped* leak
(connectors deal in `unknown`). Both are needed; neither alone is sufficient.

### 2.2 What a handle MUST NOT carry

A handle carries **identity only**: tenant_id + the immutable `ResourceRef` UUIDs + an
opaque `handleId` + an optional `facet` narrowing token. It MUST NOT carry: any addressed
record field, the record's `data` jsonb, a denormalized snapshot, a resolved view, the
subject's grants, or a slug/display-name. The `facet` is an **opaque narrowing token**
(which slice the eventual resolver should return), interpreted by T-0021 — it is *not*
record data and is not a payload (it names fields, never values). This is the same
"reference-not-data" stance T-0014 §5 took for `ResourceRef` and T-0018 took for `scope`.

### 2.3 The resolution seam (the contract T-0021 implements)

`resolveHandle` is the **single** edge from handle to record fields. T-0015 fixes its
signature and its **fail-closed** semantics; T-0021 fills in the PDP body. Defining it here
(with a deny-all stub) means T-0021 plugs in without re-opening T-0015 — and means every
consumer (connectors, form-fields, agent read-paths) codes against the *same* seam, so a
human form-field and an agent payload get the *same* filtered view (the E2.5 thesis).

---

## 3. Rejected alternatives

| Option | Why not |
|---|---|
| **Variables hold the record object directly (`Job.variables["x"] = record`)** | This *is* the leak E2.4 exists to close: every later read of the variable is an ungated, unfiltered, un-audited read, and humans-through-variables leak exactly like an unconstrained agent (hypothesis §1 caveat). The whole gateway chokepoint (E2.5) is void if a record can sit in a variable. Rejected categorically; the handle is the only admissible record-shaped variable value. |
| **Handle carries a cached/denormalized record snapshot ("for performance")** | A snapshot *is* a payload in the variable map — it re-opens the leak and, worse, serves **stale** and **unfiltered** data (the grant may have narrowed since the snapshot). Resolution MUST be action-time (TOCTOU-safe, E2.5/T-0021); a handle therefore carries **zero** record fields. Caching, if ever, lives behind the gateway, keyed by subject+grant, never in the variable. |
| **Opacity by convention / lint only (handle is a plain object, a linter forbids `.data` reads)** | A linter catches only the spellings it knows and only typed code; a connector dealing in `unknown` bypasses it, and the leak is detect-not-prevent (T-0013 §2 anti-pattern). Opacity must be **structural**: a brand the type system enforces *plus* a runtime guard at the variable boundary that rejects record-shaped `unknown` values. |
| **Resolve handles eagerly at variable-assignment (store the resolved view, not the handle)** | Binds rights at task-creation, not action-time — the exact TOCTOU hazard E2.5 forbids (rights must bind when the read happens, not when the variable was set). It also re-introduces a payload into the variable. Resolution is lazy and gateway-only, at the moment of use. |
| **Define `resolveHandle` inside T-0021 only (no port in T-0015)** | Then T-0015's "resolution is gateway-only" is an aspiration with no compile-time anchor: connectors could grow ad-hoc resolution paths before T-0021 lands. Fixing the **port + a deny-all stub** here makes the chokepoint exist and be tested from day one (fail-closed by default), and gives T-0021 a contract to satisfy rather than invent. Mirrors T-0014 handing T-0018 a closed `ResourceRef`. |
| **Handle stores a slug / human-readable resource path** | A slug rename would silently re-target or orphan the handle (T-0014 NF-3 violated). A handle binds to the immutable `ResourceRef` UUIDs only (FF-6). |
| **Handle includes the subject's grants / a capability token baked in** | Couples the reference to a point-in-time authorization; substitution/revocation/audit all break, and it re-opens TOCTOU. A handle is **subject-independent**; authority is evaluated at resolve-time from `subject` + the live grant table (T-0018), inside `resolveHandle`. |
| **Mint the handle type inside `src/core/types.ts` / `jobStore.ts` (edit existing files)** | Collides with the frozen job-model types and the in-memory store; couples handles to the job apparatus. The handle is a **new self-contained file** `src/core/object-handle.ts` (additive, no edits to existing exports — FE-W23-0008: `types.ts`/`grant-lattice.ts`/`jobStore.ts` public symbols untouched). |

None of these re-opens a founder-ratified product decision; they are the standard
alternatives for an opaque-reference / capability model, recorded so the choice is
auditable.

---

## 4. Object model

### 4.1 `object_handle` — the persisted handle (Postgres types authoritative; DDL is T-0053)

A T-0013 tenant table (inherits §3.1 of the T-0013 ADR: `tenant_id` NOT NULL leading PK,
FORCE RLS + default-DENY, scoped uniqueness, all access via `withTenant` — not restated
per-field). It persists handle **identity only**; it has **no** record-payload column.

| Field | Type | Meaning / constraint |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK column; T-0013 RLS key. A handle is meaningless outside its tenant. |
| `id` | `uuid NOT NULL` | the opaque `handle_id`; PK is `(tenant_id, id)`. Stable, addressing-only — reveals nothing about contents. |
| `ref_kind` | `text NOT NULL` | `application \| registry \| record` — the T-0014 `ResourceRef.kind` the handle points at. |
| `application_id` | `uuid NULL` | component of the `ResourceRef` (present per `ref_kind`, T-0014 §5). |
| `registry_id` | `uuid NULL` | component of the `ResourceRef` (present for `registry`/`record`). |
| `record_id` | `uuid NULL` | component of the `ResourceRef` (present for `record`). |
| `facet` | `jsonb NULL` | opaque narrowing token (which slice/fields the resolver should return); **names fields, never holds values**. Absent ⇒ whole-resource (subject-to-grant). |
| `created_at` | `bigint NOT NULL` | unix epoch ms. |

- **No payload column.** There is deliberately **no** `data`/`snapshot`/`view` column
  (FF-1 / FF-8 enforce this). Resolving identity → fields is the gateway's job, never a
  column read.
- **`ResourceRef` component shape** matches T-0014 §5 exactly (the `null`-able components
  are populated per `ref_kind`); every populated component is an **immutable UUID**, never a
  slug (FF-6 / T-0014 NF-3).
- **TS mirror** (the `ObjectHandle` type the build delivers): see §4.2.

### 4.2 `ObjectHandle` — the static-now opaque reference type

```ts
// A unique brand: makes ObjectHandle a NOMINAL type. A plain record object is NOT
// assignable to ObjectHandle, and there is no way to forge the brand outside this module.
declare const HANDLE_BRAND: unique symbol;

// T-0014 §5 ResourceRef — re-declared structurally here (T-0014 is design-only, no code
// yet); when T-0014's ResourceRef ships as code, this aligns to it. Identity-only, UUIDs.
export type ResourceRef =
  | { kind: "application"; tenantId: string; applicationId: string }
  | { kind: "registry";    tenantId: string; applicationId: string; registryId: string }
  | { kind: "record";      tenantId: string; registryId: string;    recordId: string };

// An opaque narrowing token: names a slice/fields, carries NO record value.
export type Facet = { fields: string[] };   // minimal; richer facet grammar is E4.3/T-0033

export interface ObjectHandle {
  readonly [HANDLE_BRAND]: true;   // nominal brand — un-forgeable opacity
  readonly tenantId: string;       // T-0013 key; equals every ref component's tenant
  readonly ref: ResourceRef;       // immutable UUID identity (T-0014); never a slug
  readonly handleId: string;       // opaque addressing id (== object_handle.id)
  readonly facet?: Facet;          // optional opaque narrowing token; names fields only
  // NOTE: there is intentionally NO `data` / `fields` / `payload` / `view` member.
}
```

**Opacity is two-edged (§2.1):** the brand stops the typed leak (a record is not an
`ObjectHandle`; the handle exposes no field accessor), and `assertVariableValue` (§4.4)
stops the untyped leak.

### 4.3 Handle construction & (de)serialization (reference-only; FR-5, FR-7)

```ts
// Reference-only: builds a handle from a persisted ResourceRef + tenant. NO record read,
// NO authorization call, NO field reveal. Rejects a cross-tenant ref (mixed tenant_ids).
export function makeHandle(ref: ResourceRef, tenantId: string, facet?: Facet): ObjectHandle;
//   precondition: every tenant-scoped component of `ref` === tenantId  (else throw CrossTenantHandleError)
//   handleId is derived deterministically from (tenantId, ref, facet) identity — no DB, no record read.

// Round-trip identity, never payload. The wire form contains ONLY identity.
export function serializeHandle(h: ObjectHandle): string;   // identity-only JSON; no record field
export function parseHandle(s: string): ObjectHandle;       // re-brands; parseHandle(serializeHandle(h)) deep-equals h
```

`makeHandle` performs **no** I/O: `handleId` is a deterministic function of the handle's
identity (tenant_id + ref + facet), so the same resource+facet yields the same handle
(idempotent addressing) without ever touching a record store. Serialization carries
identity only — opacity survives the wire (FR-7 / AC-7).

### 4.4 The variable-map guard (the structural invariant; FR-3)

```ts
// The write-boundary guard for ANY process-variable value (Job.variables[*], connector
// I/O, EL operand). Accept iff the value is a handle OR an inert literal; REJECT a
// record-shaped payload. Pure, total, side-effect-free. NEVER stores; only classifies.
export type VariableValueResult =
  | { ok: true }
  | { ok: false; reason: "record_payload" | "raw_object_with_data" };

export function assertVariableValue(value: unknown): VariableValueResult;
//   ok=true  iff: isObjectHandle(value)  OR  value is a primitive (string/number/boolean/null)
//                 OR a plain array/object whose members are themselves acceptable AND it is
//                 NOT record-shaped.
//   record-shaped (REJECT) iff: value carries a record identity (a `record`-kind ResourceRef
//                 or registry_id+record_id) together with a `data`/payload field, OR exposes
//                 addressed record fields (a raw registry-record object). => reason set.

// The nominal type-guard that the brand backs (the only admissible record-shaped value).
export function isObjectHandle(value: unknown): value is ObjectHandle;
```

This is the FR-3 invariant made structural: a record payload is **rejected at assignment,
before storage**, with a typed reason — not flagged after the fact. The future engine's
variable-write path MUST call `assertVariableValue` and reject on `ok:false` (FF-3; the
deploy-time enforcement of *process definitions* is T-0027, the runtime mutation block is
T-0028 — both built on this guard).

### 4.5 The resolution seam (the port T-0021 implements; FR-4, NF-2, NF-6)

```ts
// The subject on whose behalf a handle is resolved (identity only; grants are looked up
// live from T-0018 inside the resolver — NOT carried on the handle).
export interface ResolveSubject { tenantId: string; subjectId: string; }

// The grant-filtered record view the gateway returns. `denied` is the fail-closed default.
export type ResolvedView =
  | { denied: true; reason: "no_grant" | "cross_tenant" | "not_found" }
  | { denied: false; ref: ResourceRef; fields: Record<string, unknown> }; // grant-masked fields

// THE single edge from handle -> record fields. T-0021 (E2.5 PDP) implements this.
// Fail-closed: any subject without a satisfying grant => { denied: true }.
export interface HandleResolver {
  resolveHandle(handle: ObjectHandle, subject: ResolveSubject): Promise<ResolvedView>;
}

// T-0015 ships a default that DENIES everything — the chokepoint exists & is fail-closed
// from day one; T-0021 swaps this for the PDP without changing the contract.
export const denyAllResolver: HandleResolver;
//   resolveHandle(_, _) => { denied: true, reason: "no_grant" }
```

`resolveHandle` is the **only** function in the system that maps a handle to record fields
(FF-8). Its contract — **fail-closed**, **tenant-checked** (`handle.tenantId ===
subject.tenantId` else `cross_tenant`), **action-time** (grants evaluated at call, not at
handle creation) — is fixed here; the body is T-0021. Because the same port serves
connector reads, form-field reads, and agent payloads, the E2.5 invariant ("same grant ⇒
identical field visibility for human and agent") is structurally possible.

---

## 5. Build contract (static-now — the follow-on coder's deliverable)

A coder implements the object-handle module immediately after this ADR as a self-contained
pure-TS module with vitest fitness tests. This section is the **binding contract**.

### 5.1 Module boundary & file path

- **New file:** `src/core/object-handle.ts` — self-contained, **additive**. MUST NOT modify
  `src/core/types.ts`, `src/core/grant-lattice.ts`, or `src/core/jobStore.ts` in any way
  that changes their existing exports (FE-W23-0008: those public symbols are frozen by
  `src/__tests__/*`). All new types (`ObjectHandle`, `ResourceRef`, `HandleResolver`, etc.)
  are **declared in and exported from** `object-handle.ts`.
- **Tests:** `src/__tests__/object-handle.test.ts` (vitest, matches the existing
  `src/__tests__/*.test.ts` convention picked up by `vitest run`).
- **No DB, no I/O, no network, no LLM** in this module — pure functions + types over
  in-memory values, plus a deny-all stub. (Imports nothing from `jobStore`/`http`/`pg`/
  `fs`/`net`.)

### 5.2 Public API surface (the exact exports)

```ts
// --- types ---
export type ResourceRef = /* §4.2 discriminated union, UUID identity */;
export type Facet = { fields: string[] };
export interface ObjectHandle { /* §4.2 — branded, no payload member */ }
export interface ResolveSubject { tenantId: string; subjectId: string; }
export type ResolvedView =
  | { denied: true; reason: "no_grant" | "cross_tenant" | "not_found" }
  | { denied: false; ref: ResourceRef; fields: Record<string, unknown> };
export interface HandleResolver {
  resolveHandle(handle: ObjectHandle, subject: ResolveSubject): Promise<ResolvedView>;
}
export type VariableValueResult =
  | { ok: true } | { ok: false; reason: "record_payload" | "raw_object_with_data" };

// --- construction / serialization (reference-only) ---
export function makeHandle(ref: ResourceRef, tenantId: string, facet?: Facet): ObjectHandle;
export function serializeHandle(h: ObjectHandle): string;
export function parseHandle(s: string): ObjectHandle;

// --- opacity / type-guard ---
export function isObjectHandle(value: unknown): value is ObjectHandle;

// --- the variable-map structural invariant ---
export function assertVariableValue(value: unknown): VariableValueResult;

// --- the resolution seam (T-0021 implements; deny-all default) ---
export const denyAllResolver: HandleResolver;

// --- error ---
export class CrossTenantHandleError extends Error {}
```

**Semantics are §4.2–4.5 verbatim.** `makeHandle` does no I/O and rejects a cross-tenant
ref; `assertVariableValue` is total and side-effect-free; `denyAllResolver.resolveHandle`
always returns `{ denied: true }`.

### 5.3 Fitness functions that become vitest tests NOW (AC → assertion)

| FF | Rule (asserted) | Maps AC | vitest assertion |
|---|---|---|---|
| **FF-1** | Handle shape is identity-only | AC-1 | a constructed handle has `tenantId`, `ref`, `handleId`, optional `facet` and **no** `data`/`fields`/`payload`/`view`/`snapshot` own-property; a compile fixture asserts no payload member exists |
| **FF-2** | Opacity is nominal | AC-2 | a plain record object is **not** assignable to `ObjectHandle` (compile-fixture / `@ts-expect-error`); `isObjectHandle(record)===false`; `isObjectHandle(makeHandle(...))===true`; the brand is un-forgeable outside the module |
| **FF-3** | Variable-map guard | AC-3 | `assertVariableValue(handle).ok===true`; primitives/inert literals `ok===true`; a record-shaped payload (`record`-ref + `data`, or a raw registry-record object) `ok===false` with the correct `reason`; rejection happens before any store |
| **FF-4** | Resolution seam fail-closed | AC-4 | `denyAllResolver.resolveHandle(h, subj)` resolves to `{ denied:true }` for every input; the `HandleResolver` port type compiles; a subject without a grant never receives raw fields |
| **FF-5** | Reference-only construction | AC-5 | `makeHandle(ref, tenantId)` returns a handle without reading any record store (a spy/no-store fixture proves no record access) and exposes no record field; deterministic `handleId` for equal identity |
| **FF-6** | Tenant-bound + UUID-only | AC-6, FR-6 | every `ref` component is a UUID (a slug/display-name target ⇒ lint/constructor reject); `makeHandle` with a ref whose component tenant ≠ `tenantId` throws `CrossTenantHandleError`; all components share one tenant |
| **FF-7** | Round-trip identity, no payload | AC-7 | `parseHandle(serializeHandle(h))` deep-equals `h`; the serialized string contains no record-field value (only identity keys); re-parsed handle passes `isObjectHandle` |
| **FF-8** | Single resolution chokepoint | AC-8 | a source lint asserts `resolveHandle` is the only export mapping handle→fields, `ObjectHandle` exposes no `.data/.fields/.payload`, and no second resolver entry-point is exported |

### 5.4 Which ACs are static-now (vitest NOW) vs activates-in-T-0053 (DB, deferred)

- **Static-now (vitest in this build):** AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8 —
  the entire handle type, opacity brand, variable guard, constructor/(de)serializer, and
  resolution port + deny-all stub are pure TS.
- **Static-now lint (this build or a small `ci/checks` script):** AC-2 (no payload accessor
  on the type), AC-6 (no slug as a handle target — UUID-shape check), AC-8 (single resolver
  entry-point), AC-9 (additive/no-edit to frozen exports; no DB/IO import).
- **Activates-in-T-0053 (live-DB probe authored later):** AC-10 (the `object_handle` table
  in `known_tenant_tables`; live FORCE RLS `(true,true)`; no-context ⇒ count 0). The
  fixture half of AC-10 (table name in `known_tenant_tables`) is static-now; the live RLS
  half activates in T-0053.

---

## 6. Fitness functions (CI gating — design-level)

Each is an executable rule for `npm run ci` (`tsc --noEmit && eslint src && vitest run`).
`gating` = static-now (runnable today) or activates-in-T-0053 (live-DB probe authored now,
gated on Postgres).

| FF | Rule | ci_check | gating |
|---|---|---|---|
| **FF-A1** | Handle is identity-only, branded-opaque; variable-guard rejects record payloads; round-trip preserves identity not payload; deny-all resolver fails closed | `vitest run src/__tests__/object-handle.test.ts` — the §5.3 suite (FF-1..FF-8) green | static-now |
| **FF-A2** | `ObjectHandle` TS type carries identity-only fields and is nominal (a record object is not assignable) | `tsc --noEmit` over `src/core/object-handle.ts` + a compile-time fixture with `@ts-expect-error` asserting a record object is not an `ObjectHandle` and the handle has no payload member | static-now |
| **FF-A3** | Module is self-contained & additive (no edit to frozen `types.ts`/`grant-lattice.ts`/`jobStore.ts` exports; no DB/IO import) | `ci/checks/object-handle-isolation.sh`: assert `src/core/object-handle.ts` imports nothing from `jobStore`/`http`/`pg`/`fs`/`net`; `git diff` touches no existing export in those three files (AC-9) | static-now |
| **FF-A4** | No record payload may sit in a process variable — the variable-write boundary calls `assertVariableValue` and rejects record-shaped payloads | `ci/checks/no-record-in-variable.sh`: assert no handle type exposes `.data/.fields/.payload`, and (when an engine variable-write path exists) every assignment into `Job.variables`/connector-out is guarded by `assertVariableValue`; a raw-record assignment fixture ⇒ guard rejects (AC-3) | static-now (+ engine-path enforcement T-0027/T-0028) |
| **FF-A5** | Single resolution chokepoint — `resolveHandle` is the only handle→fields edge | `ci/checks/single-resolver.sh`: grep exports for any second function returning addressed record fields from a handle (e.g. `*Resolve*`, `.data` getter on a handle) ⇒ >0 fail (AC-8, NF-2) | static-now |
| **FF-A6** | Handle binds to UUIDs not slugs; never cross-tenant | `ci/checks/handle-uuid-binding.sh`: every `ref` component in any handle fixture matches the UUID shape (sourced from a `ResourceRef`); a slug/display-name ⇒ fail; a cross-tenant ref ⇒ `makeHandle` throws (AC-6) | static-now (+ live rename test T-0053) |
| **FF-A7** | `object_handle` is a registered T-0013 tenant table, FORCE RLS, default-DENY, payload-free | `object_handle` in `known_tenant_tables` fixture (static-now); live `relrowsecurity AND relforcerowsecurity`=(t,t); no tenant context ⇒ count 0; schema check asserts no payload/`data` column (AC-10) | static-now (fixture) + activates-in-T-0053 |

---

## 7. Open items — resolved with conservative defaults (non-blocking)

- **`facet` grammar.** A handle's `facet` is an **opaque narrowing token** (`{ fields:
  string[] }`) in T-0015 — it names a slice, never carries a value. Its semantics
  (how the resolver applies it, value-aware masking) are **E4.3/T-0033**; T-0015 fixes only
  that a facet *names fields* and travels with the handle. No richer facet algebra is
  invented here.
- **`handleId` derivation.** **Decision:** `handleId` is a deterministic function of the
  handle's identity `(tenantId, ref, facet)` (stable addressing, idempotent, no DB). Whether
  it is a hash or a stored UUID at the DB layer is a T-0053 concern; the contract is only
  that equal identity ⇒ equal `handleId` and it reveals nothing about contents.
- **`ResourceRef` source.** T-0014 is design-only (no code yet), so T-0015 **re-declares**
  `ResourceRef` structurally in `object-handle.ts` (matching T-0014 §5 exactly). When
  T-0014's `ResourceRef` ships as code (T-0053), the two MUST be reconciled to one
  declaration — flagged for T-0053 as a thin seam (a structural-equality fixture guards
  against drift in the interim).
- **Engine variable-write path.** No connector/EL/BPMN engine exists in code yet, so the
  *call sites* that MUST invoke `assertVariableValue` do not exist to lint today. **Decision:**
  T-0015 ships the guard + the contract that the future variable-write path call it;
  enforcing it on process *definitions* is T-0027 (deploy-linter) and on *runtime mutation*
  is T-0028. FF-A4's call-site half activates when that path lands; its guard-behavior half
  is static-now.

---

## 8. Consequences

**Positive.**
- **The record-in-variable leak is structurally closed** (FR-3): a record payload cannot
  enter the variable map — `assertVariableValue` rejects it and the handle type cannot hold
  it — provable now in vitest, before any engine or DB exists. This is the core E2.4
  guarantee.
- **Gateway-only resolution is anchored from day one** (FR-4): the `resolveHandle` port
  exists with a fail-closed deny-all default, so "resolution is gateway-only" is a
  compile-time fact (the only handle→fields edge), not an aspiration awaiting T-0021.
- **T-0021 plugs in without rework** (NF-6): the resolver swaps the stub for the PDP behind
  an unchanged port — the same way T-0014 §5 handed T-0018 a closed `ResourceRef`.
- **Rename-safe + tenant-bound** (FR-6): handles bind to immutable UUIDs and never span
  tenants, so renames never re-target and a handle is meaningless cross-tenant.
- **The hard part ships early.** The load-bearing invariant (no payload in a variable;
  gateway-only resolution) is pure TS with no DB dependency, verified the moment the coder
  finishes — the DB work in T-0053 and the PDP in T-0021 are then mechanical.

**Negative / accepted costs.**
- `ResourceRef` is re-declared here because T-0014 is code-less; the two declarations must
  be reconciled to one when T-0014 ships as code (T-0053) — a thin, fixture-guarded seam.
- The variable-guard's *call-site enforcement* cannot be linted until an engine
  variable-write path exists (T-0027/T-0028); today only the guard's behavior is proven.
  This is the same "pin the invariant before the substrate" tradeoff as T-0013/T-0014/T-0018.
- A deterministic `handleId` means two handles to the same resource+facet are equal; if a
  future need wants per-binding handle identity, that is an additive change (a salt), not a
  contract break.

---

## 9. Non-goals (hard boundaries — MUST NOT be built in T-0015)

1. **The PDP / `grant_resolver` runtime** behind `resolveHandle` (resolution order, grant
   evaluation, field masking, action-time binding, caching, the gateway chokepoint) —
   **T-0021 (E2.5)**. T-0015 builds the port + deny-all stub, not the resolver.
2. **SQL DDL / migrations / RLS policy body for `object_handle`** — **T-0053**. This ADR
   fixes columns/constraints + the no-payload-column invariant; `CREATE TABLE`/RLS land there.
3. **The BPMN deploy-time linter** rejecting raw-object bindings in process definitions —
   **T-0027 (E2.6)**; it enforces this task's variable discipline at deploy time.
4. **The engine state-mutation guard** forbidding direct object writes — **T-0028 (E2.7)**.
5. **The `ResourceRef` resource model** — **T-0014 (E2.2)**; consumed here, not redefined.
6. **Grant semantics / the authority table** — **T-0018 (E2.3)**; applied *inside*
   `resolveHandle`, which is T-0021.
7. **Value-aware field masking / facet algebra** — **E4.3 / T-0033**; only that a facet
   *names fields* and travels with the handle is fixed.
8. **Migrating `Job.variables` storage to Postgres** — **T-0053**; T-0015 fixes the
   variable-map invariant + guard, not the persistence migration.

---

## 10. Traceability (AC → design)

| AC | Covered by |
|---|---|
| AC-1 | §4.2 `ObjectHandle` identity-only shape (no payload member) + §5.3 FF-1 / FF-A2 |
| AC-2 | §2.1 / §4.2 nominal brand + §4.4 `isObjectHandle` + §5.3 FF-2 / FF-A2 |
| AC-3 | §4.4 `assertVariableValue` write-boundary guard + §5.3 FF-3 / FF-A4 |
| AC-4 | §4.5 `resolveHandle` port + `denyAllResolver` fail-closed + §5.3 FF-4 |
| AC-5 | §4.3 `makeHandle` reference-only (no record read) + §5.3 FF-5 |
| AC-6 | §4.2/§4.3 UUID-only ref + cross-tenant reject (`CrossTenantHandleError`) + §5.3 FF-6 / FF-A6 |
| AC-7 | §4.3 `serializeHandle`/`parseHandle` round-trip identity + §5.3 FF-7 |
| AC-8 | §4.5 single `resolveHandle` edge + §2.1 no payload accessor + §5.3 FF-8 / FF-A5 |
| AC-9 | §5.1 additive module boundary + FF-A3 (no edit to frozen exports; no DB/IO import) |
| AC-10 | §4.1 `object_handle` as T-0013 tenant table (no payload column) + FF-A7 |

---

## 11. Runtime target

**Local** for the static-now deliverable: the `object-handle.ts` pure-TS module (type,
brand, guard, constructor, (de)serializer, port + deny-all stub) runs in `npm run ci` with
no external resource. The `object_handle` **table** activates in the Postgres silo stack
(founder home server `/srv/choros`, deploy founder-gated GT-4) at **T-0053** — same infra
as T-0013/T-0014/T-0018, **no new infra dependency** introduced by T-0015. T-0015 itself
provisions nothing.

---

## 12. Escalation

None. T-0015 sits entirely inside the GT-1-signed RBAC hypothesis (§1 caveat, §5
`object_handle`) and the merged T-0013/T-0014/T-0018 foundation; it introduces no new
high-leverage product fork. The handle is a thin, UUID-only opaque reference + a single
fail-closed resolution port handed to T-0021 — a contract, not a direction-setting decision.
The module is **purely additive** (no public surface of `types.ts`/`grant-lattice.ts`/
`jobStore.ts` is touched — architect rule 7 compat-check: zero broken importers).
Direction pre-approved — `status: ready`.
