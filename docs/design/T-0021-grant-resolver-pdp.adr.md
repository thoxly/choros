# ADR · T-0021 — `grant_resolver` / Data-Access Gateway (PDP)

**Status:** ready (no escalation — well-specified by the GT-1 hypothesis)
**Phase:** DESIGN
**Date:** 2026-06-10
**Task:** E2.5 — Data-access gateway / PDP (`grant_resolver`); the single object read/write chokepoint
**Spec consumed:** `docs/specs/T-0021-grant-resolver-pdp.spec.md` (AC-1..AC-15)
**Foundation (do NOT contradict):**
- `docs/design/T-0015-object-handles.adr.md` — the `resolveHandle(handle, subject): Promise<ResolvedView>` port, `ObjectHandle`/`ResolveSubject`/`ResolvedView`/`Facet`, `denyAllResolver` (this ADR *fills in* the port; it does not change its shape).
- `docs/design/T-0018-grant-authority.adr.md` — the `grant` authority algebra (`Grant`, `Operation`, `ResourceType`, `ScopeElement`, `isNarrowerOrEqual`, `meet`, `isEffective`, `AncestryOracle`). The resolver is its **read-path consumer**; §2 of T-0018 pins "tools, masked fields, record-rights are *derived projections* resolved by T-0021 — there is no second permission subsystem" and explicitly defers the PDP runtime to T-0021 (T-0018 §8.1).
- `docs/design/T-0014-registry-model.adr.md` §5 (`ResourceRef`), `docs/design/T-0013-tenant-isolation.adr.md` (tenant partition), `docs/design/T-0016-audit-floor.adr.md` (audit obligation shape).

**Backlog/hypothesis:** `playbooks/rbac-backlog.md#E2.5` · hypothesis §1 caveat ("without the gateway, field-projection degrades to an advisory UI filter and the thesis is theater"), §3 Q2 (`tool.declares` = a claim the gateway verifies), Q10 (one `grant_resolver` → human form fields & agent read-payload = same filtered view), §6-A #1 (gateway chokepoint, MVP-day-1) / #6 (value-aware masking, rights bound at action-time / TOCTOU).

**Siblings consumed-by / not-built-here:** T-0053 (Postgres `GrantSource`/`RecordSource` + RLS DAO — the DB-permission form of "no direct DAO path") · T-0027 (BPMN deploy-linter) · T-0028 (engine state-mutation guard) · T-0033/E4.3 (richer value-aware masking grammar).

---

## 1. Context

The thesis: the atom of permission is a resource-operation grant; tools and form-fields are
**derived projections** of one `grant` table. The sparring (§1 caveat) forced one enforcement
condition: this "one projection" only *holds* if every object read/write routes through a
**data-access gateway (PDP)** — because the engine copies objects into variables/connectors,
"processes reference objects" is a convention, not enforcement. T-0015 closed the *handle*
side (variables carry opaque handles, never records) and fixed the **resolution seam**
`resolveHandle` with a deny-all default. T-0018 built the *authority algebra* (the closed scope
lattice + validity window). **T-0021 is the seam's body**: the one function that turns a handle
into grant-filtered fields, live, at action-time, identically for a human form and an agent.

This is the highest-leverage task in the authority core: it is the chokepoint the whole thesis
rests on. The design discipline is therefore *negative* as much as positive — the resolver must
make the wrong thing **impossible**, not merely tested: one projection function (so human≠agent
divergence cannot be written), grants resolved per call (so a mint-time snapshot cannot exist),
authority derived from grant rows only (so a second permission subsystem cannot accrete).

---

## 2. Decision

**Build `src/core/grant-resolver.ts`: a thin, pure-TS PDP that *implements* T-0015's
`HandleResolver` port (exported as `grantResolver` via a `makeGrantResolver(deps)` factory),
replacing `denyAllResolver` at the seam without changing the port's shape. On every
`resolveHandle(handle, subject)` call it (1) tenant-gates the handle against the subject
fail-closed; (2) resolves the subject's grant set *at call time* through an injected `GrantSource`
port — never a mint-time snapshot — keeping only grants that are `isEffective(grant, now)`
(T-0018), whose `operation` matches the requested op, and whose `scope` *contains* the handle's
`ResourceRef` (mapped to a resource-hierarchy `ScopeElement`) under T-0018's
`isNarrowerOrEqual(handleScope, grant.scope, ancestry)`; (3) fails closed
(`{denied:true, reason}`) on no covering grant / cross-tenant / out-of-window / absent record,
with `reason` drawn only from the fixed T-0015 union `"no_grant" | "cross_tenant" | "not_found"`;
and (4) on success fetches the raw record via an injected `RecordSource` port and returns
`{denied:false, ref, fields}` where `fields` is produced by exactly ONE pure projection function
`projectFields(rawFields, visibleFieldSet)` — `visibleFieldSet` being the union of covering
grants' facet field-names intersected with the handle's optional `Facet`. The human-form path and
the agent-payload path are the SAME call (`ResolveSubject` is identity-only; it has no human/agent
flag), so they reach the same projection with the same `(grants, ref)` and receive byte-identical
fields — equivalence by construction, not by test. The authority math (containment, validity,
meet) stays in T-0018; the resolver orchestrates. The Postgres-backed ports + RLS DAO ("no direct
DAO path" as a DB-permission fact) land in T-0053; the deploy/runtime guards in T-0027/T-0028.**

---

## 3. Rejected alternatives

| Option | Why not |
|---|---|
| **Bake the grant set / a capability token into the handle at mint time (resolve from the handle's own grants)** | Binds rights at task-creation, the exact TOCTOU hazard §6-A #6 forbids: a grant revoked between mint and resolve would still authorize. T-0015 already rejected a baked-in capability for the same reason. Authority MUST be re-derived live from `subject` + the current grant table on every call. |
| **Cache the resolved view (store `{denied:false, fields}` for reuse / write it back into the variable)** | A cached view *is* a payload in the variable map (re-opens the T-0015 leak) and serves **stale, unfiltered** data after the grant narrows. Resolution is action-time and stateless per call; any future cache (deferred) is keyed by `subject+grant` behind the gateway, never on the handle. |
| **Two filter paths (a UI/form filter and an agent/payload filter)** | This is precisely the divergence the hypothesis warns turns the thesis into theater (§1 caveat): two filters drift, and a field visible to one but not the other is a silent leak or silent denial. There is exactly ONE `projectFields`; both callers are the same identity-only `resolveHandle` call. Divergence is made unwritable, not merely tested. |
| **A second authority subsystem (a record-ACL / field-visibility table the resolver consults alongside grants)** | Two sources of truth for "who may see this field"; they drift. Hypothesis §3 Q5 / §6-A #2 and T-0018 §2/NF-1: record-rights and masked fields are *derived* from grant rows in ONE table. The resolver derives the field set from grants only; FF-A4 (T-0018's `single-authority` lint) forbids a parallel store. |
| **Resolver re-implements the lattice (its own subtree/interval containment)** | A second copy of the authority math drifts from T-0018 and violates proportionality (rubric axis 5). The resolver *calls* `isNarrowerOrEqual`/`isEffective`/`meet`; it owns only the handle→scope mapping, the grant-filter orchestration, and the field projection. |
| **Resolve fields directly from a DAO inside the resolver now (no `RecordSource` port)** | Couples the static-now pure core to a record store that does not exist yet and pre-empts the T-0053 RLS DAO. The record read is a **port** (`RecordSource`), in-memory now, Postgres+RLS in T-0053 — that is where "no direct DAO path" becomes a DB-permission fact. Keeping it a port keeps the core pure and testable today. |
| **Make `resolveHandle` synchronous (drop the `Promise`)** | T-0015 fixed the port as `Promise<ResolvedView>` (the live grant/record reads are async behind a DB in T-0053). Changing it to sync breaks the port contract (architect rule 7). The static-now ports return resolved promises; the signature is preserved. |

---

## 4. Object model & contracts

> All new symbols live in `src/core/grant-resolver.ts`. It **imports types from** `object-handle.ts`
> (`ObjectHandle`, `ResolveSubject`, `ResolvedView`, `ResourceRef`, `Facet`, `HandleResolver`) and
> `grant-lattice.ts` (`Grant`, `Operation`, `ScopeElement`, `AncestryOracle`, `isNarrowerOrEqual`,
> `isEffective`, `meet`). It **adds no export** to those modules and edits none of their exports.

### 4.1 New ports (injected — pure static-now, Postgres in T-0053)

| Entity | Field | Type | Note |
|---|---|---|---|
| `GrantSource` | `getGrants` | `(subject: ResolveSubject, nowMs: number) => Promise<Grant[]>` | The subject's *current* grants (via role assignments), resolved AT CALL TIME. In-memory now; RLS-scoped DB query in T-0053. The resolver passes `nowMs` so validity is decided against resolve-time. |
| `RecordSource` | `getRecord` | `(ref: ResourceRef) => Promise<Record<string, unknown> \| null>` | Raw record fields for a `record`-kind ref; `null` ⇒ absent (⇒ `not_found`). In-memory now; RLS DAO in T-0053. The resolver only calls this AFTER a covering grant is found (never reads a record it has no grant for). |
| `ResolverDeps` | `grants` | `GrantSource` | factory input |
| `ResolverDeps` | `records` | `RecordSource` | factory input |
| `ResolverDeps` | `ancestry` | `AncestryOracle` | resource-hierarchy containment fact (T-0018), injected; `now?: () => number` optional override for tests (defaults to `Date.now`). |

### 4.2 The resolve request (operation-aware)

`HandleResolver.resolveHandle(handle, subject)` is the frozen T-0015 port. The default operation
is `read` (the read-path). For the write-path, the resolver also exposes an **internal**
operation-parameterized core `resolveFor(handle, subject, op)` used by `resolveHandle` (op=`read`)
and by the engine write-path callers (op ∈ create/update/delete/approve/transition). `resolveFor`
is **not** a second handle→fields export of a *different* shape — it returns the same
`ResolvedView` and is the single decision core; `resolveHandle` is the read-path facade over it.
(Single-chokepoint lint FF-R5 asserts no *additional* handle→fields edge of a divergent shape.)

### 4.3 Contracts (signatures)

```ts
// src/core/grant-resolver.ts  (additive; implements the T-0015 port)
import {
  type ObjectHandle, type ResolveSubject, type ResolvedView,
  type ResourceRef, type Facet, type HandleResolver,
} from "./object-handle.js";
import {
  type Grant, type Operation, type ScopeElement, type AncestryOracle,
  isNarrowerOrEqual, isEffective,
} from "./grant-lattice.js";

export interface GrantSource {
  getGrants(subject: ResolveSubject, nowMs: number): Promise<Grant[]>;
}
export interface RecordSource {
  getRecord(ref: ResourceRef): Promise<Record<string, unknown> | null>;
}
export interface ResolverDeps {
  grants: GrantSource;
  records: RecordSource;
  ancestry: AncestryOracle;
  now?: () => number;            // defaults to Date.now; overridable in tests
}

// Map a handle's identity-only ResourceRef to a resource-hierarchy scope element
// (the leaf the grant scope must CONTAIN). Pure; the only handle->scope adapter.
export function refToScope(ref: ResourceRef): ScopeElement;

// THE single projection function. Human-form and agent-payload paths both call it.
// Returns a NEW object containing only the visible field names (absent, not null,
// for masked fields). Deterministic; no IO.
export function projectFields(
  rawFields: Record<string, unknown>,
  visibleFieldSet: ReadonlySet<string>,
): Record<string, unknown>;

// Derive the visible field set from covering grants' facets ∩ the handle Facet.
// A covering grant with NO facet => whole-resource (all rawFields keys visible).
export function visibleFields(
  coveringGrants: Grant[],
  handleFacet: Facet | undefined,
  rawFields: Record<string, unknown>,
): Set<string>;

// The operation-parameterized decision core (single source of truth).
export function resolveFor(
  deps: ResolverDeps,
  handle: ObjectHandle,
  subject: ResolveSubject,
  op: Operation,
): Promise<ResolvedView>;

// The factory: returns a HandleResolver whose resolveHandle = resolveFor(.., "read").
// This is what swaps in for denyAllResolver at the T-0015 seam (signature UNCHANGED).
export function makeGrantResolver(deps: ResolverDeps): HandleResolver;
```

### 4.4 The decision algorithm (`resolveFor`)

1. **Tenant-gate (fail-closed, first):** if `handle.tenantId !== subject.tenantId` ⇒
   `{ denied: true, reason: "cross_tenant" }`. No grant/record read happens. (NF-3, AC-2.)
2. **Resolve grants at call-time:** `now = (deps.now ?? Date.now)()`;
   `all = await deps.grants.getGrants(subject, now)`. (FR-2 / AC-3.)
3. **Filter to covering grants:** `handleScope = refToScope(handle.ref)`. Keep `g ∈ all` iff
   `g.tenantId === subject.tenantId` **and** `g.operation === op` **and**
   `isEffective(g, now)` (T-0018) **and**
   `isNarrowerOrEqual(handleScope, g.scope, deps.ancestry)` (T-0018 ⊑ — the handle's leaf must
   sit *inside* the grant's scope). (FR-3, FR-6, AC-4, AC-7, AC-8.)
4. **Fail-closed if none:** `covering.length === 0` ⇒ `{ denied: true, reason: "no_grant" }`.
   (FR-5, AC-1.)
5. **Fetch the record (only now):** `raw = await deps.records.getRecord(handle.ref)`;
   `raw === null` ⇒ `{ denied: true, reason: "not_found" }`. (AC-9.)
6. **Project once:** `vis = visibleFields(covering, handle.facet, raw)`;
   `fields = projectFields(raw, vis)`; return `{ denied: false, ref: handle.ref, fields }`.
   (FR-4, AC-5, AC-6.)

> **`visibleFields` rule.** Start from `∅`. For each covering grant: if it has **no** facet,
> union in ALL keys of `raw` (whole-resource read). If it has a facet `{fields:[...]}`, union in
> those names. Then, if the **handle** carries a `Facet`, intersect the result with the handle's
> facet field names (the handle's narrowing token can only *shrink* the view, never widen it).
> Field names not in the final set are **absent** from the projected object (physically absent,
> not `null` — capability-not-text). Richer value-aware/row-level masking is T-0033.

### 4.5 The human==agent equivalence — a structural property

`ResolveSubject` is `{ tenantId, subjectId }` — **identity only, no caller-kind flag**. A human
form rendering a record and an agent assembling a read-payload both invoke the *same*
`resolveHandle(handle, subject)` (or `resolveFor(.., "read")`), reaching the *same*
`projectFields(raw, vis)`. There is no branch on "is this a human?" anywhere in the resolver, and
no second projection function exists (FF-R5 + FF-R2 lint/test). Therefore, for one
`(grant set, ref, record)`, the two callers receive **deep-equal** views *by construction* — the
test (AC-5) confirms the property the design makes unbreakable.

---

## 5. Build plan (static-now) & what defers

**BUILD (T-0021, now) creates exactly:**
- `src/core/grant-resolver.ts` — the module above (ports, `refToScope`, `visibleFields`,
  `projectFields`, `resolveFor`, `makeGrantResolver`). Pure; imports only types/fns from
  `object-handle.ts` + `grant-lattice.ts`. **Edits no existing export.**
- `src/__tests__/grant-resolver.test.ts` — the vitest fitness suite (FF-R1..FF-R7 below) with
  in-memory `GrantSource`/`RecordSource`/`AncestryOracle` fixtures.
- `ci/checks/grant-resolver-isolation.sh` — additivity/no-second-subsystem lint (FF-R6).
- (extends the existing `ci/checks/single-resolver.sh` invariant — honored, not rewritten — via
  FF-R5 which asserts `object-handle.ts` is unchanged and no new divergent handle→fields export.)

**Wiring note (additive, non-breaking):** the seam swap (`denyAllResolver` → `makeGrantResolver(deps)`)
happens **at the composition root** where a resolver is injected, NOT by editing `object-handle.ts`
(which keeps shipping `denyAllResolver` as the safe default). T-0021 provides the implementation;
the call-site that injects it is wired where the gateway is composed (engine/connector boundary,
hardened in T-0028). Static-now, the test injects it directly.

**Defers:**
- **T-0053:** the Postgres-backed `GrantSource` (RLS-scoped grant query) + `RecordSource` (RLS DAO)
  + the DB role-permission posture that makes "no direct DAO path" a *database* fact (AC-14), not
  only a TS structural one. The durable T-0016 audit append of the resolve obligation (FR-8).
- **T-0027:** BPMN deploy-time linter — variables bind handles only (AC-15, deploy half).
- **T-0028:** engine runtime guard — the engine carries only handles and mutates only via the
  gateway; this is where `makeGrantResolver` becomes the *enforced* sole path at runtime (AC-15,
  runtime half).
- **T-0033/E4.3:** richer value-aware masking / data-classification / egress grammar; the facet
  here is the minimal opaque field-name narrowing token.

---

## 6. Fitness functions (CI gating — the BUILD acceptance contract)

Each is an executable rule for `npm run ci` (`tsc --noEmit && eslint src && npm run fitness && vitest run`).
`gating` = static-now (runnable today) or activates-in-T-0053/T-0027/T-0028 (probe authored later).

| FF | Rule | ci_check | gating |
|---|---|---|---|
| **FF-R1** | **Action-time binding (revoke→deny):** a `GrantSource` returning a covering grant at t0 and empty at t1 ⇒ resolve at t0 `{denied:false}`, at t1 `{denied:true,"no_grant"}`; out-of-window grant ⇒ `no_grant`. Resolver never caches a mint-time snapshot. | `vitest run src/__tests__/grant-resolver.test.ts -t "action-time"` (AC-3, AC-4) | static-now |
| **FF-R2** | **Human==agent identical-fields:** for one `(grants, ref, record)`, a human-form call-site and an agent-payload call-site return **deep-equal** `{denied:false, ref, fields}`; exactly one `projectFields` is invoked by both. | `vitest run … -t "human==agent"` (AC-5) | static-now |
| **FF-R3** | **Default-deny / fail-closed:** no covering grant ⇒ `no_grant`; cross-tenant handle ⇒ `cross_tenant` (before any grant/record read); absent record ⇒ `not_found`; op-mismatch ⇒ `no_grant`. No path returns `{denied:false}` without a covering grant. | `vitest run … -t "fail-closed"` (AC-1, AC-2, AC-7, AC-9) | static-now |
| **FF-R4** | **Scope containment + projection:** ref inside a granted subtree resolves; ref outside ⇒ `no_grant`; visible field set = covering-grant facets ∩ handle Facet; masked fields are **absent** (not null) from `fields`. | `vitest run … -t "containment\|projection"` (AC-6, AC-8) | static-now |
| **FF-R5** | **Single chokepoint (structural):** `resolveHandle` stays the sole handle→fields port; `ci/checks/single-resolver.sh` green; `git diff` shows `object-handle.ts` unchanged; no new export maps a handle to record fields with a shape diverging from `ResolvedView`. | `bash ci/checks/single-resolver.sh && bash ci/checks/grant-resolver-isolation.sh` (AC-10) | static-now |
| **FF-R6** | **No second authority subsystem / additive:** `grant-resolver.ts` imports nothing from `pg/fs/net/http/jobStore`; introduces no `*_acl`/`field_visibility`/`record_rights` store; the decision & field set are computed solely via T-0018 grant rows; edits no existing export of `object-handle.ts`/`grant-lattice.ts`/`types.ts`. | `ci/checks/grant-resolver-isolation.sh`: grep for forbidden imports + parallel-authority tokens; `git diff --name-only` asserts no frozen export touched (AC-11) | static-now |
| **FF-R7** | **Purity / port-conformance:** two invocations with deeply-equal inputs (ports return same data, same injected `now`) return deeply-equal outputs; `makeGrantResolver(deps)` type-checks as `HandleResolver` and can replace `denyAllResolver` at the seam with no signature change. | `vitest run … -t "pure\|port-conformance"` + `tsc --noEmit` (AC-12, AC-13) | static-now |
| **FF-R8** | **No-direct-DAO-path (DB-enforced):** outside the gateway, no Postgres role can `SELECT` record fields; RLS + role-permissions make the resolver's `RecordSource` the only read path. | live-DB probe authored in T-0053 (AC-14) | activates-in-T-0053 |
| **FF-R9** | **Engine carries only handles & mutates only via gateway:** BPMN linter rejects raw-object bindings at deploy; engine guard blocks direct object mutation at runtime, routing all reads/writes through `makeGrantResolver`. | deploy-linter check (T-0027) + runtime guard test (T-0028) (AC-15) | activates-in-T-0027 / T-0028 |

---

## 7. Traceability (AC → design)

| AC | covered_by |
|---|---|
| AC-1 | §4.4 step 4 (no covering grant ⇒ `no_grant`); FF-R3 |
| AC-2 | §4.4 step 1 (tenant-gate first, no grant/record read); FF-R3 |
| AC-3 | §2 + §4.4 step 2 (grants resolved at call-time via `GrantSource`); §3 (rejected: baked-in/snapshot); FF-R1 |
| AC-4 | §4.4 step 3 (`isEffective(g, now)`); FF-R1 |
| AC-5 | §4.5 (one projection, identity-only subject, structural equivalence); FF-R2 |
| AC-6 | §4.4 step 6 + `visibleFields` rule (facet ∩ handle Facet; absent not null); FF-R4 |
| AC-7 | §4.4 step 3 (`g.operation === op`); §4.2 (op-aware `resolveFor`); FF-R3 |
| AC-8 | §4.4 step 3 (`isNarrowerOrEqual(handleScope, g.scope)`) + §4.3 `refToScope`; FF-R4 |
| AC-9 | §4.4 step 5 (`getRecord === null` ⇒ `not_found`); FF-R3 |
| AC-10 | §4.2 note (single decision core) + §5 (no new divergent edge); FF-R5 |
| AC-11 | §3 (rejected: second subsystem) + §4.4 (field set from grants only); FF-R6 |
| AC-12 | §4.1 (all IO behind ports, `now` injectable) + NF-1; FF-R7 |
| AC-13 | §2 + §4.3 (`makeGrantResolver(deps): HandleResolver`, port unchanged); FF-R7 |
| AC-14 | §5 defers (T-0053 RLS DAO / DB role-perms); FF-R8 |
| AC-15 | §5 defers (T-0027 deploy linter / T-0028 engine guard); FF-R9 |

---

## 8. Runtime target

**Local / in-process (static-now).** The resolver is a pure TS module in the existing Node app;
its fitness suite runs under `vitest` in `npm run ci` with no external resource. The
Postgres-backed ports + RLS DAO (T-0053) require the founder-gated Postgres-in-compose
(`runtime_target` for that task = container, GT-4); **not requested here** — T-0021 needs no
external resource.

## 9. Compatibility notes (architect rule 7)

- **Implements, does not change, the T-0015 `HandleResolver` port.** `resolveHandle(handle,
  subject): Promise<ResolvedView>` signature is preserved verbatim; `makeGrantResolver(deps)`
  returns a `HandleResolver`. `denyAllResolver` keeps shipping from `object-handle.ts` as the safe
  default; the swap is a composition-root injection, not an export edit.
- **Imports only existing exports** of `object-handle.ts` (`ObjectHandle`, `ResolveSubject`,
  `ResolvedView`, `ResourceRef`, `Facet`, `HandleResolver`) and `grant-lattice.ts` (`Grant`,
  `Operation`, `ScopeElement`, `AncestryOracle`, `isNarrowerOrEqual`, `isEffective`). No symbol in
  those modules — nor in `types.ts` — is renamed, removed, or re-signed; FF-R6 lints `git diff` to
  prove it. The `ResolvedView` reason union (`"no_grant" | "cross_tenant" | "not_found"`) is used
  exactly as T-0015 froze it — the resolver introduces no new reason value.
- **Honors `ci/checks/single-resolver.sh`** (T-0015's FF-A5) rather than weakening it; FF-R5 runs
  it and additionally asserts `object-handle.ts` is byte-unchanged by this task.
- **Honors T-0018's `single-authority` posture** (FF-A4): the resolver adds no parallel authority
  store; FF-R6 greps for `*_acl`/`field_visibility`/`record_rights` tokens.

## 10. Escalation

None. This task is central but **well-specified** by the ratified GT-1 hypothesis (§1 caveat,
§3 Q2/Q10, §6-A #1/#6) and the merged T-0015 (the port) and T-0018 (the authority algebra, which
explicitly defers the PDP to T-0021). No product-direction fork is opened: the resolver composes
the existing authority math behind the existing port; the static-now/deferred boundary is already
drawn by those ADRs. No cross-vendor product loop is required.
