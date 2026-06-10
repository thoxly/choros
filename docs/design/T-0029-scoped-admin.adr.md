# ADR · T-0029 — Scoped administration (E3.3)

**Phase:** DESIGN. **Status:** `ready` (no founder gate; GT-1 for E3.3 signed).
**Spec:** `docs/specs/T-0029-scoped-admin.spec.md` (17 AC). **Machine contract:**
`docs/design/T-0029.adr.contract.json` (schema `schemas/adr.schema.json`, 0 errors).
**Base:** worktree `task/T-0029-scoped-admin`, branched from `dev` `bc4c3c5`.

---

## 1. Decision (one paragraph)

Administration is **not a subsystem** — it is the pattern *hold a delegable grant on
`mgmt_object:X`*. T-0029 (a) declares that pattern precisely, (b) ships **one new pure
module** `src/core/scoped-admin.ts` exporting `validateAdminDelegation(admin, target, oracle)`
— a **thin composition** that reuses the T-0018 lattice (`grant-lattice.ts`) **verbatim**
along **both** narrowing axes, and (c) bootstraps the already-seeded but grant-less genesis
`tenant-owner` into a real, fully-capable mgmt-admin via **one additive idempotent migration**
(`026_genesis_owner_seed.sql`). The checker is **pure / IO-free** (the `AncestryOracle` is
injected); the DB write-path that calls it before `INSERT` and the editor UI are **T-0030**.
`grant-resolver.ts` and `grant-lattice.ts` are **not edited** (additive-only). **No new tenant
table** — mgmt-grants ride the existing `grant` + `role_assignment` tables. Genesis-owner
identity is an **injected boolean**, never derived inside the lattice.

The two axes:

1. **Resource/org-scope axis (the delegated grant).** Reuse `validateNarrowing(adminGrant,
   childGrant, oracle)` over the admin's covering mgmt-grant — `child.scope ⊑ adminGrant.scope`,
   `adminGrant.delegable === true`, non-widening facet/constraint. **No re-implementation of
   subset math.**
2. **Org/admin-boundary axis (the assignment & target).** The admin may act only within the org
   subtree(s) their administering assignment's `org_scope` admits. Reuse
   `isNarrowerOrEqual(target.targetOrgScope, admin.adminOrgScope, oracle)` over `hierarchy:"org"`.
   **No new algebra.**

Self-elevation (FR-3) is **not a separate rule** — it is a corollary: a self-elevating write
has a child that is not `⊑` the granter on some axis, so one of the two gates rejects it. The
adversarial fuzz proof (FF-4) mirrors `grant-lattice.adversarial.test.ts`.

---

## 2. Mechanism & module boundary

`src/core/scoped-admin.ts` (NEW, pure). It **imports** from `./grant-lattice.js`:
`Grant`, `ScopeElement`, `AncestryOracle`, `NarrowingResult`, `validateNarrowing`,
`isNarrowerOrEqual`. It exports:

```ts
export const MGMT_OBJECT_KINDS = [
  "mgmt_object:role", "mgmt_object:agent",
  "mgmt_object:process", "mgmt_object:grant",
] as const;                                   // frozen day-1 kind set (AC-1, NF-7)

export interface AdminContext {
  isGenesisOwner: boolean;                    // INJECTED — never derived in the lattice
  adminGrants: Grant[];                       // covering, confirmed, in-window, delegable mgmt_object:* grants
  adminOrgScope: ScopeElement;                // hierarchy:"org" — the admin/org ceiling (assignment org_scope ∪)
}

export type DelegationTarget =
  | { kind: "grant";      childGrant: Grant;        targetOrgScope: ScopeElement }
  | { kind: "assignment"; targetOrgScope: ScopeElement };

export type AdminDelegationResult =
  | { ok: true }
  | { ok: false; reason:
        | "scope_widens" | "facet_widens" | "constraint_widens"   // ← NarrowingResult, verbatim
        | "parent_non_delegable" | "free_form_non_delegable"      // ← NarrowingResult, verbatim
        | "org_scope_widens"                                      // ← NEW admin/org-boundary axis
        | "no_admin_authority" };                                 // ← NEW non-owner, no covering grant

export function validateAdminDelegation(
  admin: AdminContext, target: DelegationTarget, oracle: AncestryOracle,
): AdminDelegationResult;                      // PURE — no DB/net/LLM IO; never mutates/persists
```

**Decision order (frozen for T-0030 / T-0039):**

1. **Freeform owner-only.** If `target.kind === "grant"` and `target.childGrant.scope` is
   `freeform`: accept **only** if `admin.isGenesisOwner` (the write-path forces `delegable=false`
   on it, reusing T-0018 FR-6); a non-owner freeform mint ⇒ `free_form_non_delegable`.
2. **Org-axis gate** (the admin/org boundary; **owner exempt** — it is the un-parented root).
   If `!admin.isGenesisOwner` **and**
   `!isNarrowerOrEqual(target.targetOrgScope, admin.adminOrgScope, oracle)` ⇒ `org_scope_widens`.
3. **Owner short-circuit.** If `admin.isGenesisOwner` ⇒ `{ok:true}` (no parent-subset check —
   there is no parent above the owner; FR-4).
4. **No-authority.** Else if no `admin.adminGrants` member covers the target ⇒ `no_admin_authority`.
5. **Resource-axis gate.** For `kind === "grant"`, return
   `validateNarrowing(coveringAdminGrant, target.childGrant, oracle)` (its reasons surface
   verbatim). For `kind === "assignment"`, the org-axis gate (step 2) **is** the whole check — an
   assignment delegates org reach, not a resource grant.

**Covering grant:** a member of `admin.adminGrants` whose `resourceType` equals the child's
mgmt-object kind, whose `operation` equals the child's, and `delegable === true`. If several
cover, accept-if-**any** admits a valid narrowing (most-specific selection is not required day-1).

> **Why the org-axis gate runs before the owner short-circuit returns** — the owner is exempt
> from the org gate (it owns the whole forest), so step 2 only fires for non-owners; step 3 then
> returns for the owner. This ordering keeps "owner needs no parent" and "delegated admin is
> subtree-bounded" as two clean, separately-testable branches (FF-6, FF-7).

### Why this is the right size (rubric ось 5 — proportionality)

The whole new module is **wiring, not math**: two existing primitives composed behind one typed
result. No new lattice element, no new containment function, no new table, no HTTP route. The
day-1 ACs are provable by the pure checker + adversarial fitness + a live seed probe — exactly
the verifiability the spec asks for, and nothing more.

---

## 3. The genesis seed (migration 026) — and the forest-root resolution

`migrations/026_genesis_owner_seed.sql`, **additive** (numbered ≥ 026; 022 = T-0034, 023–025 =
T-0062 are reserved in flight), **idempotent** (stable UUIDs + `ON CONFLICT DO NOTHING`),
**INSERT-only** into the existing `employee` / `grant` / `role_assignment` tables (no DDL).

It seeds:

1. **A genesis-owner employee** `e-owner` (kind `human`, `position_id NULL`),
   `d0000000-…-00ff` — the human the owner role is assigned to.
2. **16 delegable mgmt-grants** on the `tenant-owner` role (`e0000000-…-0001`): the four
   `mgmt_object:{role,agent,process,grant}` kinds × `{create,read,update,delete}`, plus an
   `invoke` grant on `mgmt_object:agent` (the E5.1 hiring/invoke shape), `delegable = true`.
   IDs prefix `e1000000-…`.
3. **One confirmed genesis assignment** (`f0000000-…-00ff`) binding `e-owner → tenant-owner`,
   `confirmed_by` set (⇒ effective per the T-0022 contract), `source='genesis'`.

### The "tenant-root org node" seam (design decision, not an escalation)

The spec FR-5 says the owner's mgmt-grant scope is the "tenant-root org node … so it covers
every subtree." **Live finding:** the dev org is a **3-root forest** — `fin`, `cs`, `plat` all
have `parent_id NULL` (verified on an isolated Postgres after applying 001–021). There is **no
single org node above them**.

Two ways to give the owner forest-wide reach:

- **Synthesize a single root department and re-parent fin/cs/plat under it** — rejected: it
  requires **editing** migration 014's existing seeds, which violates additive-only (AC-17), and
  mutates the org-tree shape other tasks read.
- **Use an org-`set` scope** `{kind:"set", members:[node(fin), node(cs), node(plat)]}` —
  **chosen**. The lattice already supports scope-sets; the union covers every subtree; zero DDL
  edit; **no new algebra** (NF-2). A child grant within any one subtree is `⊑` the set (the set's
  `isNarrowerOrEqual` already returns true when the child fits *some* member). The genesis
  assignment's `org_scope` uses the same org-set as the admin/org ceiling.

This is a **design seam resolved within ratified scope** (the spec §6 hands "tenant-root" to the
architect), not a product decision — so it is recorded here, not escalated.

### Live verification (done in DESIGN)

On a throwaway isolated Postgres (`POSTGRES_PORT=55456`, own volume, **torn down after**):
applied 001–021 then the draft 026, **twice**. Result: **16** owner mgmt-grants, **1** confirmed
genesis assignment, all FKs satisfied; the **second run inserted 0 rows** and counts were
identical (`ON CONFLICT DO NOTHING` proven idempotent). This is the AC-12 live probe authored
now and activated under the T-0053 db job.

---

## 4. Compatibility surface (FE-W23-0008 — importers as contract)

T-0029 **adds** a public module and **forces no edit** to any existing export.

- `grant-lattice.ts` — **imported, not modified.** New consumer `scoped-admin.ts` depends on
  `Grant`, `ScopeElement`, `AncestryOracle`, `NarrowingResult`, `validateNarrowing`,
  `isNarrowerOrEqual`. The frozen `grant-lattice.adversarial.test.ts` / `grant-lattice.test.ts`
  keep importing the same symbols unchanged — no break.
- `grant-resolver.ts` — **byte-for-byte untouched** (FF-11; mirrors the `grant-resolver-isolation.sh`
  frozen-files git-diff pattern).
- `known_tenant_tables.txt` / `cross_tenant.test.ts` — **unchanged** (FF-16, vacuous AC-16
  branch): no new tenant table; `grant`/`role`/`role_assignment` are already registered and
  already have `seedRowForTable` cases.
- **New frozen surfaces for siblings (NF-7):** `MGMT_OBJECT_KINDS`, `AdminContext.isGenesisOwner`
  (injected boolean), and the `AdminDelegationResult` discriminated union are consumed by T-0030
  (write-API/UI) and T-0039 (LLM-proposes). Their names/shapes are fixed here.

---

## 5. Fitness functions (architecture as CI)

Full machine list in `T-0029.adr.contract.json`. Summary by axis:

| FF | Guards | AC | CI check |
|---|---|---|---|
| FF-1 | `mgmt_object:*` first-class + `MGMT_OBJECT_KINDS` frozen | AC-1 | `tsc` fixture + vitest |
| FF-2/3 | accept ⊑ / reject widening, typed reason, no mutation | AC-2/3 | vitest (frozen-input) |
| FF-4 | adversarial no-self-elevation fuzz (LCG, leak=0) | AC-4 | `scoped-admin.adversarial.test.ts` |
| FF-5/6 | non-delegable/freeform; injected owner root | AC-5/6 | vitest |
| FF-7 | delegated admin subtree-bounded | AC-7 | vitest org-oracle |
| FF-8 | no second authority subsystem | AC-8 | `scoped-admin-isolation.sh` grep + no-`CREATE TABLE` |
| FF-9 | no new scope algebra (imports lattice, no parallel fn) | AC-9 | `scoped-admin-isolation.sh` |
| FF-10 | pure/IO-free + determinism | AC-10 | isolation grep + property test |
| FF-11 | `grant-resolver.ts` (and lattice) unchanged | AC-11 | git-diff-quiet |
| FF-12/13 | seed present+idempotent; one owner per tenant | AC-12/13 | live db double-run + static count-lint |
| FF-14 | revoke removes capability at authority layer | AC-14 | vitest (empty adminGrants ⇒ `no_admin_authority`) |
| FF-15 | audit obligation on mgmt-grant issue/revoke | AC-15 | static lint (call sites in T-0030) + emit-shape test |
| FF-16 | tenant-table/cross-tenant coherence (vacuous) | AC-16 | no-`CREATE TABLE` + unchanged `known_tenant_tables.txt` |
| FF-17 | migration ≥ 026, additive, T-0013 invariants | AC-17 | `scoped-admin-isolation.sh` numbering/diff |

New fitness script `ci/checks/scoped-admin-isolation.sh` (coder authors it; modeled on
`grant-resolver-isolation.sh`) carries FF-8/9/10/11/17 and is appended to the `npm run fitness`
chain (orchestrator-merge-safe append).

---

## 6. Out of scope (re-stated for the coder)

HTTP write-routes / grant-editor UI (**T-0030**); LLM-proposes (**T-0039**); DB-backed
`getGrants` JOIN (**T-0053**); read-path PDP for `mgmt_object` handles (`grant-resolver.ts`
**not** edited); agent hiring runtime / Keycloak (**T-0043/E5**); `role_criticality` /
dual-control (**T-0040/44**); SoD (**T-0032**); pooled provisioning. T-0029 ships **the pure
checker + its frozen contract + the idempotent seed** — nothing more.

---

## 7. Runtime / deploy target

**Local / container.** The pure module runs entirely inside `npm run ci`
(`tsc`/`eslint`/`vitest`/`fitness`) — no external resource. The seed migration runs against the
dev-silo Postgres (`docker-compose`, T-0053) — **no founder/GT-4 external resource** (dev silo
only). The live AC-12/13/16 probes activate under the existing T-0053 `db` CI job. No
`runtime_target` escalation.
