# Spec · T-0021 — `grant_resolver` / Data-Access Gateway (PDP)

**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-06-10
**Task:** E2.5 — Data-access gateway / PDP (`grant_resolver`); the single object read/write chokepoint
**Authoritative source:** `playbooks/rbac-backlog.md#E2.5` (GT-1, founder-signed 2026-06-08) · `playbooks/rbac-discovery-phase1-hypothesis.md` §1 (the enforcement caveat), §3 Q2/Q10, §6-A #1 (gateway chokepoint) / #6 (value-aware masking, action-time binding)
**Foundation (do NOT contradict):** `docs/design/T-0015-object-handles.adr.md` (the `resolveHandle` port + `ObjectHandle`/`ResolveSubject`/`ResolvedView`/`Facet` this spec *fills in*) · `docs/design/T-0018-grant-authority.adr.md` (the `grant` authority algebra this resolver *reads through*; tools/masked-fields/record-rights are DERIVED projections of grant rows — no second subsystem) · `docs/design/T-0014-registry-model.adr.md` §5 (`ResourceRef`) · `docs/design/T-0013-tenant-isolation.adr.md` (tenant partition) · `docs/design/T-0016-audit-floor.adr.md` (resolve decisions may emit audit obligations)
**Siblings referenced, not built here:** T-0053 (Postgres `GrantSource`/`RecordSource` + RLS DAO — the "no direct DAO path" enforced by DB perms), T-0027 (BPMN deploy-linter — variables carry handles only), T-0028 (engine state-mutation guard — engine mutates only via the gateway), T-0033/E4.3 (richer value-aware masking grammar)

---

## 0. Note on scope of this task (static-now core, deferred enforcement edges)

Choros today is an in-memory TS/Node app — there is **no Postgres, no Flowable engine, no
docker-compose**. The **resolver core** — the pure function that, given an `ObjectHandle`, a
`ResolveSubject`, and the live grant set + raw record fields, returns the grant-filtered
`ResolvedView` — is **buildable NOW** as `src/core/grant-resolver.ts` with vitest fitness
tests. It is the deliverable.

Three enforcement edges are explicitly **deferred** and this spec does not order them here:

- the **Postgres-backed `GrantSource`/`RecordSource` + the RLS DAO** that makes "no direct DAO
  path" a *database-permission* fact (not only a TS structural fact) → **T-0053**;
- the **BPMN deploy-time linter** that rejects raw-object variable bindings → **T-0027**;
- the **engine runtime guard** that ensures the engine carries only handles and mutates only
  via the gateway → **T-0028**.

Each acceptance criterion carries a `verifiable_as` and a gating note (static-now vs
activates-in-T-0053/T-0027/T-0028), mirroring T-0013 / T-0018. This task is **additive**: it
adds `src/core/grant-resolver.ts` and *implements* T-0015's `HandleResolver` port. It does
**not** edit `object-handle.ts`, `grant-lattice.ts`, or `types.ts` exports (architect rule 7).

---

## 1. Summary

`grant_resolver` is **the single chokepoint on which the whole Choros thesis rests**. Every
object read/write routes through one resolver; outside it there is no path from a handle to
record fields. It is the *read-path consumer* of the T-0018 `grant` authority algebra: it does
**not** invent a second authority subsystem — tools, masked fields, and record-level rights are
all **derived projections of grant rows** (hypothesis §1; T-0018 ADR §2). The hypothesis is
blunt about why this task is load-bearing: *"without the gateway, field-projection degrades to
an advisory UI filter and the thesis is theater"* (§1 caveat).

The resolver implements T-0015's `resolveHandle(handle, subject): Promise<ResolvedView>` port,
replacing the shipped `denyAllResolver`. Its job, given a handle (an opaque, tenant-scoped
reference to a `ResourceRef`) and an identity-only subject:

1. **Tenant-gate** — handle tenant must equal subject tenant, else `{denied:true, "cross_tenant"}`.
2. **Resolve grants at call-time** — query the *current* grant set for the subject's roles via a
   `GrantSource` port (resolved AT CALL TIME, never a creation-time snapshot), keep only grants
   effective now (`isEffective`, T-0018) whose scope **contains** the handle's `ResourceRef`
   (`isNarrowerOrEqual(handleScope, grant.scope)`, T-0018 ⊑) for the requested operation.
3. **Fail closed** — no satisfying grant ⇒ `{denied:true, "no_grant"}`.
4. **Project** — compute the visible field set as the union of grant-derived facets (intersected
   with the handle's optional narrowing `Facet`), fetch the raw record fields via a `RecordSource`
   port, and return `{denied:false, ref, fields}` with **only** the visible fields. Absent record
   ⇒ `{denied:true, "not_found"}`.

**The load-bearing property is human==agent view equivalence by construction.** `ResolveSubject`
is **identity-only** (`{tenantId, subjectId}`) — it carries *no* "human form" vs "agent payload"
flag. A human form-field render and an agent read-payload both reach the **same one projection
function** with the **same `(grant set, ref)`** and therefore receive **byte-identical** fields.
Divergence is not "tested for" — it is **structurally impossible** because there is exactly one
projection function and exactly one caller-shape.

The second load-bearing property is **action-time binding (TOCTOU-safe)**: rights are evaluated
at the moment of the read/write against the **current** grant set, never bound at handle-mint or
task-creation. A grant revoked between handle-mint and resolve ⇒ resolve denies. The handle
carries **zero** authority (T-0015 already forbids a baked-in capability token); the resolver
re-derives authority live on every call.

---

## 2. Functional requirements

- **FR-1 — Single chokepoint, implements the T-0015 port.** The resolver is exported as
  `grantResolver: HandleResolver` (an *implementation* of the port T-0015 defines), filling in
  `resolveHandle`. It is the **only** thing in the system, other than the deny-all default, that
  maps a handle to record fields. No second handle→fields export is introduced.
- **FR-2 — Action-time grant resolution.** The resolver takes its grant set from an injected
  `GrantSource` port queried **at call time** (`getGrants(subject, nowMs)`), never a snapshot
  captured at handle creation. The "now" used for validity is the resolve-call time.
- **FR-3 — Scope containment via the T-0018 lattice.** A grant *covers* the handle iff the
  handle's `ResourceRef` (mapped to a resource-hierarchy scope element) is `⊑` the grant's scope
  (`isNarrowerOrEqual`, with an injected `AncestryOracle` for resource-tree containment) AND the
  grant's operation matches the requested operation AND the grant is `isEffective(grant, now)`.
- **FR-4 — One projection function for both callers.** Field filtering is a single pure function
  `projectFields(rawFields, visibleFieldSet)`. The resolver computes `visibleFieldSet` from the
  covering grants' facets ∩ the handle's `Facet`; the human path and the agent path both call
  this one function. No alternate filter exists.
- **FR-5 — Default-deny / fail-closed.** Any of {no covering grant, out-of-validity-window grant,
  cross-tenant handle, absent record} ⇒ a `{denied:true, reason}` view with **no** `fields`. The
  reason is drawn from the fixed T-0015 union `"no_grant" | "cross_tenant" | "not_found"`.
- **FR-6 — Operation-aware.** The resolve call carries the requested `Operation` (read on the
  read-path; the same containment logic gates write-path operations create/update/delete/
  approve/transition). A grant for `read` does not authorize `update` of the same ref.
- **FR-7 — Rights are derived from grant rows only (no second subsystem).** The visible field set,
  the allow/deny decision, and any masked-field projection are computed **solely** from grant
  rows resolved through T-0018. The resolver introduces no parallel record-ACL or
  field-visibility store (NF-1 of T-0018; FF-A4).
- **FR-8 — Audit obligation on decision (shape only, static-now).** A resolve decision MAY emit a
  T-0016 audit obligation (`type`, `actor`=subject, `subject`=ref, `via`=`grant_resolver`,
  decision). In static-now the resolver returns/threads the obligation shape; the durable append
  is wired in T-0053. The resolver MUST NOT itself become a second audit store.

## 3. Non-functional requirements

- **NF-1 — Purity (static-now).** `grant-resolver.ts` is pure TS: no DB, no network, no engine,
  no `Date.now()` baked in (now is a parameter), no LLM. All IO is behind injected ports
  (`GrantSource`, `RecordSource`, `AncestryOracle`). Deterministic: equal inputs ⇒ equal output.
- **NF-2 — Additivity / compat.** Implements T-0015's `HandleResolver` interface **without
  changing its shape**. Does not edit the exports of `object-handle.ts`, `grant-lattice.ts`, or
  `types.ts`. Any field the resolver needs is read through existing exports or new local ports.
- **NF-3 — Tenant isolation.** Cross-tenant resolve is denied *before* any grant or record is
  read; the resolver never reads a record whose tenant differs from the subject's.
- **NF-4 — No payload caching in the reference.** The resolver returns a fresh view per call; it
  does not write any resolved view back into a handle or a variable (T-0015 forbids snapshots).
  Any future cache (deferred) is keyed by `subject+grant`, never stored in the handle.
- **NF-5 — Proportionate (rubric axis 5).** Thin resolver core; the authority math lives in
  T-0018 (`isNarrowerOrEqual`, `isEffective`, `meet`). The resolver orchestrates, it does not
  re-implement the lattice.

## 4. Out of scope (explicit non-goals)

- **Postgres `GrantSource`/`RecordSource` + RLS DAO** (the DB-permission form of "no direct DAO
  path") → T-0053.
- **BPMN deploy-time linter** (raw-object binding rejection) → T-0027.
- **Engine runtime state-mutation guard** (engine writes only via the gateway) → T-0028.
- **Richer value-aware masking grammar / data-classification / egress** (the facet here is the
  minimal opaque field-name narrowing token of T-0015/T-0018) → T-0033 / E4.3.
- **Toolset resolution / `mcp_tool.declares` verification** (the other grant projection) →
  T-0043 / E5.3. (This task pins the *record-fields* projection; toolset projection is a sibling
  use of the same grant rows.)
- **Durable audit append** (the resolver emits the obligation shape; the append is T-0053).
- **Substitutions / on-behalf-of routing** → T-0026 / routing layer; the resolver sees only the
  effective `subjectId`.

---

## 5. Acceptance criteria

| id | text | verifiable_as | gating |
|---|---|---|---|
| AC-1 | `grantResolver.resolveHandle(handle, subject)` with NO covering grant returns `{ denied: true, reason: "no_grant" }` and no `fields` key. | fitness | static-now |
| AC-2 | A handle whose `tenantId` differs from `subject.tenantId` returns `{ denied: true, reason: "cross_tenant" }` **without** the resolver reading any grant or record (tenant-gate is first). | fitness | static-now |
| AC-3 | **Action-time binding:** given a `GrantSource` that returns a covering grant at time t0 and an empty/revoked set at t1>t0, `resolveHandle` at t0 returns `{denied:false}` and at t1 returns `{denied:true, "no_grant"}` — the resolver re-queries grants per call and never caches a mint-time snapshot. | fitness | static-now |
| AC-4 | An otherwise-covering grant outside its validity window at resolve-now (`isEffective` false) yields `{denied:true, "no_grant"}` (out-of-window confers zero capability). | fitness | static-now |
| AC-5 | **Human==agent equivalence:** for the same `(grant set, ref, record)`, two distinct call-sites modeling a human-form render and an agent read-payload produce **deep-equal** `{denied:false, ref, fields}` — byte-identical visible fields. There is exactly ONE projection function both invoke. | fitness | static-now |
| AC-6 | The visible field set equals the union of covering grants' facet field-names intersected with the handle's `Facet` field-names (when present); fields outside that set are **absent** from the returned `fields` object (physically absent, not null). | fitness | static-now |
| AC-7 | A grant for operation `read` does not satisfy a resolve call requesting operation `update` (and vice-versa); operation mismatch ⇒ `{denied:true, "no_grant"}`. | fitness | static-now |
| AC-8 | A handle whose `ResourceRef` is **not** `⊑` any covering grant's scope (e.g. a record outside the granted subtree, by the injected `AncestryOracle`) ⇒ `{denied:true, "no_grant"}`; a ref inside the granted subtree ⇒ resolved. | fitness | static-now |
| AC-9 | When the `RecordSource` reports the ref absent, the resolver returns `{denied:true, reason:"not_found"}` and never fabricates fields. | fitness | static-now |
| AC-10 | **Single chokepoint (structural):** `resolveHandle` (on `HandleResolver`) remains the only export mapping handle→fields; `ci/checks/single-resolver.sh` stays green, and no second handle→fields edge is introduced by this task. | fitness | static-now |
| AC-11 | **No second authority subsystem:** the resolver computes its decision and field set solely from grant rows (via T-0018), introducing no parallel record-ACL/field-visibility store; the rights-derivation path is grant-rows-only. | fitness | static-now |
| AC-12 | The resolver is pure: invoked twice with deeply-equal inputs (same ports returning same data, same now) it returns deeply-equal outputs; it performs no IO outside the injected ports. | fitness | static-now |
| AC-13 | The resolver satisfies the T-0015 `HandleResolver` interface unchanged — it type-checks as `const grantResolver: HandleResolver` (or a factory returning one) and `object-handle.ts`'s `denyAllResolver` can be swapped for it at the seam with no signature change. | test | static-now |
| AC-14 | **DB enforcement (activates later):** the "no direct DAO path" is enforced by Postgres role-permissions + RLS so that no code path outside the gateway can read record fields. | manual | activates-in-T-0053 |
| AC-15 | **Deploy/runtime enforcement (activates later):** engine variables carry only handles and the engine mutates objects only via the gateway, enforced by the BPMN linter and engine guard. | manual | activates-in-T-0027 / T-0028 |

---

## 6. Blocking questions

None. The GT-1 hypothesis (§1 caveat, §3 Q2/Q10, §6-A #1/#6) and the merged T-0015/T-0018 ADRs
fully specify the chokepoint, the action-time binding, the human==agent equivalence, and the
fail-closed contract. The static-now/deferred boundary (resolver core now; DB/RLS in T-0053;
deploy/runtime guards in T-0027/T-0028) is already drawn by those ratified ADRs, so no
scope-fork requires founder direction. Status: **ready**.
