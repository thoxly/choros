# Spec · T-0029 — Scoped administration (E3.3)

**Epic/Story:** E3.3 — Scoped administration: *admin is an ordinary role with scoped
write-grants on `mgmt_object:*`; monotonic narrowing (no self-elevation); single genesis
`tenant-owner`; delegated administration bounded to the assignment's subtree(s).*

**Status:** `ready` (no blocking founder questions — GT-1 already signed for E3.3; the
day-1/Stage-2 line and the no-separate-admin-subsystem decision are ratified).

**Phase:** SPEC. This document is the analyst handoff; the machine-readable contract is
`docs/specs/T-0029.spec.contract.json` (schema `schemas/spec.schema.json`).

---

## 0. One-line summary

Activate administration as **ordinary grants on the reserved `mgmt_object:*` resource-type**
(no separate admin subsystem), and ship the **day-1 admin-narrowing checker** — a pure
function that, on the admin write-path, proves a delegated mgmt-grant or role-assignment is
`⊆` the granting admin's own authority along **both** axes (resource-scope via the T-0018
lattice; org/admin-scope via the T-0022 `org_scope`), with the **genesis `tenant-owner`** as
the un-parented delegation root — plus the seed wiring that makes the genesis owner a real,
fully-capable mgmt-admin and the `mgmt_object` resource-type machine-checkable.

---

## 1. Context: what already exists (do not rebuild)

The authority spine and roles layer are already merged on the `dev` base this worktree
branches from. T-0029 is **thin** — it activates a reserved resource-type and composes two
existing narrowing primitives; it introduces **no new scope algebra**.

- **`grant-lattice.ts` (T-0018, REAL).** The closed lattice `(S, ⊑, ⊓, ⊥)`, the
  `ResourceType` union *already including* `` `mgmt_object:${string}` `` (reserved, untested),
  and `validateNarrowing(parent, child, oracle)` — the proven write-time subset gate
  (`scope_widens` / `facet_widens` / `constraint_widens` / `parent_non_delegable` /
  `free_form_non_delegable`). Adversarial fuzz tests already prove no-widening for
  node/tag/interval/set/freeform/facet/constraint. **T-0029 reuses this verbatim.**
- **`grant` table (008) + `grant.role_id` FK (021, T-0022).** Grants attach to `role`, never
  to a person/agent. `delegable boolean NOT NULL DEFAULT true`. Resource identity lives in
  `scope`; `resource_type` is `text` — `mgmt_object:agent`, `mgmt_object:role`,
  `mgmt_object:process`, `mgmt_object:grant` are admissible string values today.
- **`role` (019) + `role_assignment` (020) (T-0022, REAL).** The genesis `tenant-owner` role
  is **already seeded** (slug `tenant-owner`, uuid `e0000000-…-0001`) — but it currently holds
  **zero grants** and has **zero assignments**. `role_assignment.org_scope jsonb NOT NULL`
  carries the org-hierarchy `ScopeElement` (the admin/org boundary). T-0022's ADR fixes
  `org_scope` as *"the non-widenable, lattice-shaped admin boundary; removing the assignment
  removes the capability"* — i.e. T-0029's second narrowing axis already has its column.
- **`grant-resolver.ts` (T-0021, REAL).** The read-path PDP. It maps **only**
  application/registry/record handles to scope (`refToScope`); it does **not** resolve
  `mgmt_object` handles — admin narrowing is a **write-path** concern, not a read-path one.
  **T-0029 does NOT edit `grant-resolver.ts`** (the resolver is touched only by T-0033/T-0053).

**The single biggest framing fact:** "admin" is not a mechanism. It is the pattern
*hold a delegable grant on `mgmt_object:X`*. The whole task is (a) declaring that pattern
precisely, (b) the pure checker that enforces narrowing when one admin delegates to another,
and (c) bootstrapping the genesis owner so a delegation chain can begin.

---

## 2. Functional requirements

### FR-1 — `mgmt_object:*` is a first-class, lattice-resident resource-type family

Management objects (`role`, the agent registry, processes, and the rights/grants themselves)
are administered through **ordinary `grant` rows** whose `resource_type` is a `mgmt_object:*`
value. There is **no separate admin table, admin flag, or admin role-kind**. The day-1 named
mgmt-object kinds are fixed: `mgmt_object:role`, `mgmt_object:agent`, `mgmt_object:process`,
`mgmt_object:grant` (the rights-on-rights object). A mgmt-grant's `scope` is an **org-hierarchy**
`ScopeElement` (`hierarchy:"org"`, `nodeLevel ∈ {department, position}`) — administering
management objects is scoped by *which org subtree*, exactly the org hierarchy the lattice
already supports. `operation` is drawn from the existing `Operation` union (`create`, `read`,
`update`, `delete`, plus `invoke` for `mgmt_object:agent` "hiring"/invoke per E5.1).

### FR-2 — Monotonic narrowing on the admin write-path (the core deliverable)

When an admin (holder of a delegable `mgmt_object:*` grant) **mints or edits** a *downstream*
grant or role-assignment, the write MUST be **rejected before persistence** unless it is a
structural subset of the admin's own authority. The check is a **pure function**
(`validateAdminDelegation` or equivalent — name is the architect's, the *contract* is fixed
here) composing **both narrowing axes**:

1. **Resource-scope axis (delegated grant):** for a child `grant`, reuse T-0018
   `validateNarrowing(adminGrant, childGrant, oracle)` — `child.scope ⊑ adminGrant.scope`
   over the resource (or org, for mgmt-grants) hierarchy, non-widening facet/constraint, and
   `adminGrant.delegable === true`. No re-implementation of subset math.
2. **Org/admin-scope axis (assignment & target):** the admin may only act **within the org
   subtree(s) their administering assignment's `org_scope` admits**. A delegation whose target
   (the assignee's org context, or the child grant's org scope) is **not** `⊑` the admin's
   `org_scope` SET is rejected. Containment uses the **existing** `isNarrowerOrEqual` /
   `AncestryOracle` over the org hierarchy — no new algebra.

Rejection is a **distinct typed reason** (extending or reusing T-0018's `NarrowingResult`
union; the new admin-axis rejection — e.g. `org_scope_widens` — is named in DESIGN). The
function **never mutates, never persists, never reads IO** (oracle is injected) — it is the
checker the T-0030 write-API calls before INSERT.

### FR-3 — No self-elevation (the security invariant, provable)

No admin can grant themselves, or any principal, authority they do not themselves hold. This
is **not a separate rule** — it is a corollary of FR-2: a self-elevating write has a child
scope/operation/facet that is **not** `⊑` the granter's, so `validateNarrowing` rejects it.
The spec REQUIRES an adversarial fitness proof (mirroring the existing
`grant-lattice.adversarial.test.ts` style) that for `mgmt_object:*` grants — across node /
tag / interval / set / org-subtree fuzz — a child that widens *any* axis is **always**
rejected, and the only accepted children are genuine subsets.

### FR-4 — Genesis `tenant-owner` is the un-parented delegation root

Exactly **one** `tenant-owner` role exists per tenant (already seeded, FR-1 of T-0022). The
genesis owner is the **root of the delegation lattice**: owner-minted grants are **not**
subset-checked against a parent (there is none above the owner) — `validateAdminDelegation`
takes "is this principal the genesis owner?" as an **injected boolean** (per T-0018 ADR
§"Genesis owner identity": the algebra relies only on the owner's *existence* as an injected
flag, not a lattice concern). Every grant the owner delegates **downward** becomes, from then
on, a subset-checked parent. The owner is the **only** principal that may mint a `freeform`
mgmt-grant, and any such grant is forced `delegable = false` (reuses T-0018 FR-6 verbatim).

### FR-5 — Genesis bootstrap chain (seed)

T-0029 makes the seeded genesis owner a **real, fully-capable mgmt-admin** via additive,
idempotent dev-silo seeds:

1. **mgmt-grants** on the `tenant-owner` role: delegable grants
   `{mgmt_object:role|agent|process|grant, create|read|update|delete, scope=tenant-root org
   node}` — the full management authority, rooted at the tenant's top org node so it covers
   every subtree.
2. **a genesis assignment** wiring a genesis owner **employee** (human) to the `tenant-owner`
   role, with `org_scope` = the tenant-root org node and `confirmed_by` set (effective).

Seeds are **idempotent** (stable UUIDs + `ON CONFLICT DO NOTHING`), live in new migration
file(s) numbered **from 026** (022 = T-0034, 023–025 = T-0062 are reserved in flight), and
re-running the migration set yields identical row counts. Seed ordering respects FK deps
(role → grant; employee → role_assignment).

### FR-6 — Delegated administration is bounded to the assignment's subtree(s)

A delegated (non-owner) admin — e.g. an HR admin assigned `mgmt_object:role` within the
`hr` department subtree — may create/edit roles and assignments **only within that subtree
set**. Their administering assignment's `org_scope` is the ceiling for both (a) the org scope
of any grant they mint and (b) the `org_scope` of any assignment they create. This is FR-2's
org-axis applied to the common case; the AC matrix MUST include a positive case (within
subtree → accepted) and a negative case (escaping the subtree → rejected).

### FR-7 — `mgmt_object` known to the tenant-table / cross-tenant harness

If T-0029 adds any **new** tenant table (see §4 — it likely does **not**; existing
`grant`/`role`/`role_assignment` suffice), it MUST be appended to
`ci/checks/known_tenant_tables.txt` (additively, orchestrator-merge-safe) and given its own
`case` in `cross_tenant.test.ts`'s `seedRowForTable` switch with a per-tenant
`seedRowForTable` seed row (the lesson of T-0062). If T-0029 adds **no** new table, this FR is
satisfied vacuously and the contract states so explicitly (the mgmt-grant seeds ride the
already-registered `grant` table).

### FR-8 — Removing the role removes the capability (not just hides UI)

A principal's admin capability is **only** the mgmt-grants reachable through their *confirmed,
in-window* assignments (T-0021/T-0022 resolution contract). Revoking the assignment, expiring
its window, or deleting the mgmt-grant **removes the capability at the authority layer** — not
by hiding a UI affordance. The day-1 proof is a checker/resolver-contract fitness assertion: a
subject with no confirmed in-window `mgmt_object:*` grant fails `validateAdminDelegation` for
every delegation (and the read-path resolver, when wired in T-0053, returns zero mgmt reach).

---

## 3. Non-functional requirements

- **NF-1 — No second authority subsystem.** Admin authority is expressed **solely** as `grant`
  rows (`mgmt_object:* × operation × org-scope`). A static fitness lint asserts no
  admin-specific table / flag / role-kind / ACL store is introduced (mirrors T-0018 AC-11).
- **NF-2 — No new scope algebra.** Both narrowing axes reuse `grant-lattice.ts`
  (`validateNarrowing`, `isNarrowerOrEqual`, `AncestryOracle`). T-0029 adds **no** new
  `ScopeElement` kind and **no** parallel containment path.
- **NF-3 — Pure, IO-free checker.** `validateAdminDelegation` performs no DB/network/LLM IO;
  ancestry facts are injected (oracle). Equal inputs ⇒ equal output. The DB write-path that
  *calls* it is T-0030; T-0029 ships the pure function + its contract.
- **NF-4 — `grant-resolver.ts` and `grant-lattice.ts` core untouched on read-path.** T-0029
  does NOT edit `grant-resolver.ts`. It MAY add a new pure module (e.g.
  `src/core/scoped-admin.ts`) that *imports* `grant-lattice.ts`; it MUST NOT change
  `grant-lattice.ts`'s exported signatures (additive-only if it touches that file at all).
- **NF-5 — T-0013 tenant invariants on any DDL.** Any migration T-0029 ships keeps
  tenant-isolation discipline (FORCE RLS, default-DENY, `tenant_id` leading, `choros_app`
  grant) and additive numbering from **026**; seeds are idempotent.
- **NF-6 — Genesis owner is unique per tenant.** The seed + a fitness check assert **exactly
  one** `tenant-owner` role per tenant (the lattice root cannot be ambiguous).
- **NF-7 — Forward-compat:** the `mgmt_object:*` kind set, the genesis-owner injected-flag
  contract, and the checker's typed-rejection union are the surfaces T-0030 (write-API/UI) and
  T-0039 (LLM-proposes) consume; their names/shapes are frozen here for those siblings.

---

## 4. Out of scope (explicit non-goals)

- **HTTP write-routes / grant-editor UI for minting mgmt-grants & assignments — T-0030 (E3.4).**
  T-0029 ships the **pure narrowing checker + its contract**; the write-API that calls it
  before INSERT, and the structural-grant editor surface, are T-0030. (Honest read of the
  backlog: E3.4 *is* the write/UI consumer; duplicating routes here would be the wrong seam.
  Day-1 verifiability is met by the pure checker + adversarial fitness + seed proof — no HTTP
  route is required to prove the ACs.)
- **LLM-proposes-grants / human-confirms — T-0039/E3.5.** T-0029 fixes that no grant is
  effective without `confirmed_by` (T-0022 contract); the proposal flow is E3.5.
- **DB-backed `getGrants` resolution (role_assignment→grant JOIN under RLS) — T-0053.** The
  *contract* (confirmed + in-window + org_scope-admits) is reused from T-0022; the live DB
  query is T-0053.
- **Read-path PDP enforcement for `mgmt_object` handles.** Admin narrowing is a write-path
  invariant. If mgmt-objects ever flow through the handle/PDP read-path, that mapping is a
  later concern; `grant-resolver.ts` is NOT edited here.
- **Agent provisioning / "hiring" mechanics — T-0043/E5.1+.** T-0029 reserves
  `mgmt_object:agent` + `invoke` as the *grant shape* for hiring/invoking; the agent-runtime
  and Keycloak service-account mechanics are E5.
- **`role_criticality` / dual-control on mgmt writes — T-0040/T-0044 (E4.5/E4.6).** D-A=A3
  dual-control keyed to criticality (mgmt_object writes are a flagged class) is a *separate*
  gate layered on top; T-0029 supplies the grant rows it reads, not the dual-control logic.
- **SoD over admin roles — T-0032/E4.2.**
- **Multi-tenant pooled provisioning** (silo N=1 dev seed only).

---

## 5. Acceptance criteria (machine-checkable)

`static-now` = a TS/lint/unit/fitness check runnable in today's `npm run ci`;
`live-T-0053` = a live-DB probe authored now, activated when Postgres exists. The checker
algebra (AC-2..AC-7) is **pure TS** and is fully static-now.

| ID | Text | Verifiable as |
|---|---|---|
| **AC-1** | `mgmt_object:*` is a first-class resource-type: a grant fixture with `resource_type ∈ {mgmt_object:role, mgmt_object:agent, mgmt_object:process, mgmt_object:grant}` is a structurally valid `Grant` (compile-checked against the T-0018 `ResourceType` union); a static lint asserts these are the day-1 mgmt-object kinds. | fitness |
| **AC-2** | The admin-narrowing checker accepts a delegated mgmt-grant whose `scope ⊑ adminGrant.scope` (org subtree of the admin's), with `adminGrant.delegable === true` and non-widening facet/constraint — returns `{ok:true}`. | test |
| **AC-3** | The checker **rejects before persistence** (never mutates) a delegated mgmt-grant whose org-scope **widens** the admin's (child is an ancestor/sibling-subtree, or escapes the admin's `org_scope` set) — returns a distinct typed rejection (`scope_widens` / `org_scope_widens`). | test |
| **AC-4** | **No self-elevation (adversarial):** for fuzz-generated `mgmt_object:*` parent/child pairs across node/tag/interval/set/org-subtree, a child that widens **any** axis is **always** rejected; only genuine subsets are accepted (mirrors `grant-lattice.adversarial.test.ts`). | fitness |
| **AC-5** | **Non-delegable / freeform parent rejected:** a delegation whose admin grant is `delegable=false` ⇒ `parent_non_delegable`; whose admin grant scope is `freeform` ⇒ `free_form_non_delegable`; a non-owner minting a `freeform` mgmt-grant is rejected. | test |
| **AC-6** | **Genesis owner is the un-parented root:** with the injected `isGenesisOwner=true`, an owner-minted mgmt-grant is accepted **without** a parent-subset check (no parent required); with `isGenesisOwner=false` and no covering admin grant, the same write is rejected (`no_admin_authority` / `no_grant`). | test |
| **AC-7** | **Delegated admin bounded to subtree:** an admin assigned `mgmt_object:role` within subtree `S` is accepted for a role/assignment whose org context is `⊑ S`, and rejected for one outside `S` — using the existing org `AncestryOracle`. | test |
| **AC-8** | **No second authority subsystem:** a static fitness lint asserts admin authority is expressed only as `grant` rows on `mgmt_object:*` — no admin-specific table/flag/role-kind/ACL store exists in the model fixture (mirrors T-0018 AC-11). | fitness |
| **AC-9** | **No new scope algebra:** a static check asserts the admin checker imports `isNarrowerOrEqual`/`validateNarrowing`/`AncestryOracle` from `grant-lattice.ts` and defines no new `ScopeElement` kind and no parallel containment function. | fitness |
| **AC-10** | **Checker is pure (IO-free):** a static lint asserts the admin-checker module performs no DB/network/LLM IO and accepts an injected oracle; equal inputs ⇒ equal output (property test). | fitness |
| **AC-11** | **`grant-resolver.ts` unchanged:** a static check asserts `src/core/grant-resolver.ts` is byte-for-byte unedited by this task (read-path untouched; admin narrowing is write-path). | fitness |
| **AC-12** | **Genesis seed present + idempotent:** after migrate (and a double-run), exactly the seeded mgmt-grants are attached to `tenant-owner` and exactly one confirmed genesis assignment wires the genesis owner employee → `tenant-owner` at the tenant-root org node; re-run yields identical counts (`ON CONFLICT DO NOTHING`). | test (live-T-0053) + fitness (static seed-count on a double-applied migration) |
| **AC-13** | **Exactly one genesis owner per tenant:** a fitness/seed check asserts the `tenant-owner` role is unique per tenant and the genesis assignment is the single un-parented root. | fitness (+ live-T-0053) |
| **AC-14** | **Removing the role removes the capability:** a resolver-contract/checker fixture shows a subject whose `tenant-owner` (or delegated-admin) assignment is revoked or out-of-window confers **zero** mgmt authority — `validateAdminDelegation` rejects every delegation for them (capability gone at the authority layer, not UI). | test |
| **AC-15** | **Audit obligation on mgmt-grant issuance/revocation:** every mgmt-grant create/revoke call site is accompanied by a `GrantAuditEvent` emit carrying actor, subject (`role_id`), capability (`resource_type × operation × facet`), `scope`, and (when present) `proposed_by`/`confirmed_by` (reuses T-0018 FR-7 obligation; static lint on call sites). | fitness |
| **AC-16** | **Tenant-table / cross-tenant harness coherence:** if T-0029 adds a new tenant table it appears in `known_tenant_tables.txt` and has a `seedRowForTable` case with a per-tenant seed row (cross-tenant probe green); if it adds none, a check confirms the mgmt-grant seeds ride the already-registered `grant` table and no `known_tenant_tables.txt` change is needed. | test (live-T-0053) + fitness |
| **AC-17** | **Migration numbering seam:** any migration T-0029 ships is numbered **≥ 026** (022/023–025 reserved by T-0034/T-0062 in flight), is additive (no edit to prior migrations), and keeps T-0013 invariants (FORCE RLS / default-DENY / `tenant_id` leading) on any DDL. | fitness |

---

## 6. Blocking questions

**None.** GT-1 for E3.3 is signed; the no-separate-admin-subsystem model, monotonic narrowing
as a lattice subset, the single genesis `tenant-owner`, and subtree-bounded delegation are all
ratified in the hypothesis (§3 Q3, §2), kickoff (founder positions §4.6 *"управление = роли на
управляющих объектах"* / §4.7 *"нет само-повышения + SoD"*), and the T-0018 spec/ADR (genesis
owner as injected un-parented root; `mgmt_object:*` reserved). The seam decisions that could
have been blocking are resolved within the ratified scope:

- **Day-1 = pure checker + contract + seed; HTTP write-routes/UI = T-0030.** This is a *scope*
  read, not a behaviour change — E3.4 is explicitly the write-API/editor consumer, and the ACs
  are provable without an HTTP route (pure checker + adversarial fitness + live seed probe).
  Recorded as a CONTRACT for T-0030, not an escalation.
- **New table vs reuse `grant`.** The mgmt-grant seeds ride the existing `grant` table; no new
  tenant table is required day-1. FR-7/AC-16 cover both branches so the architect is not boxed
  in, but the default (no new table) is stated.

These are design seams, not founder decisions — handed to the architect, not escalated.

---

## 7. Handoff notes for the architect (non-binding)

- The natural home is a new pure module `src/core/scoped-admin.ts` exporting
  `validateAdminDelegation(adminCtx, child, oracle)` where `adminCtx` carries the admin's
  covering mgmt-grant(s) + `org_scope` + the injected `isGenesisOwner` flag. It is a **thin
  composition** over `validateNarrowing` (resource/org-scope axis) + a `isNarrowerOrEqual`
  org-scope check (admin-boundary axis) — most lines are wiring, not new math.
- The typed rejection union extends T-0018's `NarrowingResult` with the admin-axis reasons
  (`org_scope_widens`, `no_admin_authority`); keep it a discriminated union so T-0030's API can
  surface distinct errors.
- Genesis-owner identity is an **injected boolean**, never derived inside the lattice — keep the
  algebra ignorant of "owner". The seed (FR-5) is what makes the flag true for the seeded owner.
- Mgmt-grant `scope` uses the **org** hierarchy (`hierarchy:"org"`), not resource — administering
  *role/agent/process* objects is scoped by org subtree, and that is the hierarchy the
  AncestryOracle already walks for `org_scope`.
