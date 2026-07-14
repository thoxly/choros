# Spec · T-0022 — Roles + assignments (`role`, `role_assignment` with org_scope SET, validity window, proposed_by/confirmed_by)

**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-06-10
**Task:** E3.2 — `role`; `role_assignment(employee_id, role_id, org_scope SET, valid_from/until, source, granted_by, proposed_by, confirmed_by)`. Org/admin scope is a node **or set of nodes** (cross-cutting roles → scope-sets). Roles are cross-cutting slices ("budget approver", "lawyer"); task assignment targets role/position, not a person (claim-from-pool ready).
**Authoritative source:** `playbooks/rbac-backlog.md#E3.2` (GT-1, founder-signed 2026-06-08; backlog row E3.2 → T-0022, ✓ GT-1) · `playbooks/rbac-discovery-phase1-hypothesis.md` §5 (object model: `role`/`assignment`), §2 (admin/org scope) · `CONCEPT.md` §7

**Foundation (do NOT contradict):**
- `docs/design/T-0013-tenant-isolation.adr.md` — both new tables are T-0013 tenant tables: `tenant_id` leading PK column, FORCE RLS + default-DENY policy, accessed via `choros.tenant_id` GUC (`SET LOCAL`), `choros_app` is `NOBYPASSRLS`.
- `docs/design/T-0115-tenant-rls.adr.md` — `ci/checks/known_tenant_tables.txt` is the RLS CI invariant; every new tenant table MUST be added to that file (additive lines `role`, `role_assignment`).
- `docs/design/T-0018-grant-authority.adr.md` — the `role` is **the principal** grants attach to (§"Grant attaches directly to a person/agent" rejected): humans and agents reach grants only through role assignments. `grant.role_id` (migration 008) is today a PLAIN `uuid NOT NULL` with **no FK** (the FK to `role(tenant_id, id)` was explicitly DEFERRED to this task — see 008 header comment and T-0018 ADR §1.2 / §"open items" #4). **org/admin scope on the assignment is DISTINCT from resource scope on `grant`** (ADR §"scope is resource scope", §312 #4): the resource-scope subset check in T-0018/T-0021 is NOT touched here.
- `src/core/grant-lattice.ts` (T-0018, REAL code in worktree) — the `ScopeElement` lattice already carries an **`org` hierarchy** with `NodeLevel ∈ {department, position}` (lines 18–24, 43–47): `org_scope` SET values are exactly `{ kind: "node", hierarchy: "org", nodeId, nodeLevel: "department"|"position" }` elements (or a `{ kind: "set", members: [...] }` of them). **The org-scope lattice machinery already exists**; T-0022 stores the scope-set on `role_assignment`, it does NOT add a new scope algebra.
- `src/core/grant-resolver.ts` (T-0021, REAL code in worktree) — the read-path PDP. Its `GrantSource.getGrants(subject, nowMs)` port (lines 50–57) is documented as "the subject's CURRENT grants **(via role assignments)**, resolved AT CALL TIME". `role_assignment` is the table that backs that resolution. **This spec does NOT edit `grant-resolver.ts`** — it declares the interface point that the T-0053 DB-backed port (and any parallel resolver edit, e.g. T-0033) consumes (see §0 "Resolution seam" and OS-1).
- `migrations/014_department.sql`, `015_position.sql`, `016_employee.sql` (T-0017, REAL code in worktree) — `department.id`, `position.id` are the org-tree node IDs that `org_scope` SET values reference; `employee.id` is the assignment subject. PK shape `(tenant_id, id)` is fixed; no re-keying.

**Siblings / consumers (contract fixed here, built elsewhere):**
- **T-0029 (E3.3, scoped administration)** — CONSUMER. A delegated admin's grant-issuance authority is bounded to the **subtree(s) named by their `role_assignment.org_scope` set**. This spec fixes the contract: `org_scope` is a non-widenable scope-set of `org`-hierarchy nodes; removing the assignment removes the capability (not just hides UI). T-0029 reads `role_assignment.org_scope` as the admin boundary; it does NOT redefine the column. See §"Contract for T-0029".
- **T-0039 (E3.5, LLM-proposes / human-confirms)** — CONSUMER. `proposed_by` / `confirmed_by` are **day-1 schema columns** on `role_assignment` (this task). The *workflow* that populates them (LLM proposes → human confirms; no platform-hosted LLM) is Stage-2 / T-0039 — **out of scope here**. This spec fixes the column semantics: an assignment with `confirmed_by IS NULL` is a **proposal** (not yet effective for grant resolution); `confirmed_by NOT NULL` is **confirmed**. See FR-4 and §"Contract for T-0039".
- **T-0019 (E4.1, actor_event / SoD ledger)** — SEMANTIC-COMPATIBLE, NOT FK. `actor_event` records the **role the actor held at event time** (`role_at_event`) as a point-in-time reference, deliberately **NOT** a live FK into `role` (an event must remain valid after a role is deleted/retired). This spec guarantees `role.id` is stable and never re-keyed, so a stored `role_at_event` id remains semantically resolvable. T-0019's migration (018) is in flight on another branch; **no migration-ordering coupling** beyond number allocation (this task uses 019+, see §0).
- **T-0032 (E4.2, SoD)** — CONSUMER. SoD constraints are evaluated over the **roles a subject holds** — i.e. over confirmed `role_assignment` rows. This spec guarantees the queryable shape (subject → set of confirmed, in-window roles); it does NOT implement SoD evaluation.

---

## 0. Note on scope (DESIGN + BUILD; migration authoring)

T-0022 is a **DESIGN + BUILD** task: Postgres exists (T-0053 done) and the org-structure tables (T-0017, migrations 013–016) are applied in this branch's base (dev `d948f6b`). This spec authors the **two migrations** for `role` and `role_assignment`, the `known_tenant_tables.txt` additions, and the **deferred FK** that promotes `grant.role_id` to a real foreign key. The SQL DDL is owned by the `architect`/`coder` phases; this spec pins the **invariants, table shapes, and machine-checkable acceptance criteria** those phases MUST satisfy.

### Migration number assignment (frozen by orchestrator)

In this branch's base, the last applied migration is `016_employee.sql`; `008_grant.sql` is the last `grant` migration. Two migrations are **in flight on other branches and NOT merged into this base**: **017** is held by **T-0033** (data-classification) and **018** by **T-0019** (actor_event). Therefore T-0022 MUST start at **019**:

| File | Content |
|---|---|
| `migrations/019_role.sql` | `role` table |
| `migrations/020_role_assignment.sql` | `role_assignment` table (employee_id, role_id, org_scope, validity window, proposed_by/confirmed_by) |
| `migrations/021_grant_role_fk.sql` | promote `grant.role_id` to a real FK → `role(tenant_id, id)` (the deferred FK from T-0018 / 008) |

The deferred-FK migration is split into its own file (021) so the `role` table exists first (019) and the FK is a pure additive `ALTER TABLE` — keeping each migration independently appliable. The architect MAY merge 020/021 ordering details; the **019 floor and the 3 logical units are fixed**. `ci/checks/known_tenant_tables.txt` gains **2** lines (`role`, `role_assignment`) — additive; the orchestrator merges with T-0033/T-0019's additions at merge time.

### Resolution seam (interface point — NOT edited here)

The chain `subject (employee) → role_assignment → role → grant → resolved view` is the live authority path. T-0022 owns the **first two hops as data** (`role`, `role_assignment`). The function body that walks `subject → grants` (the `GrantSource.getGrants` port in `grant-resolver.ts`) is **NOT edited by this task**:
- Today (static-now) `getGrants` is an injected in-memory port; the **DB-backed implementation** that JOINs `role_assignment → grant` under RLS lands in **T-0053** (per T-0021 ADR §5).
- T-0033 (data-classification) edits the resolver in parallel. To avoid a write-conflict, T-0022 declares the **interface point** (§"Resolution contract", OS-1) and does NOT touch `grant-resolver.ts` or `grant-lattice.ts`.

This spec therefore fixes the **column contract** the resolver's DB query will read, not the query itself.

---

## 1. Summary

Build the two tables that make a role a first-class, assignable principal: `role` (the named, cross-cutting capability bundle grants attach to) and `role_assignment` (binds an `employee` to a `role`, within an **org-scope SET** of org-tree nodes, over a **validity window** `valid_from`/`valid_until`, recording **who proposed and who confirmed** it). Promote the previously-deferred `grant.role_id` to a real FK into `role`. Both tables satisfy T-0013 tenant-isolation. `org_scope` reuses the existing T-0018 `org`-hierarchy lattice element shape (no new scope algebra). The grant-resolution read path that turns an assignment into effective grants is an **interface point** (DB wiring in T-0053); this task ships the data contract only. Migrations 019–021; `known_tenant_tables.txt` gains `role`, `role_assignment`. 22 CI-checkable acceptance criteria. No blocking questions.

---

## 2. Functional Requirements

### FR-1 — `role` table

- `role` is the **principal** that grants attach to (T-0018: grants never attach to a person/agent directly). It is a tenant table.
- Fields: `tenant_id uuid NOT NULL` (leading PK column, FK → `tenant(id)`); `id uuid NOT NULL`; `slug text NOT NULL`; `display_name text NOT NULL`; `description text NULL` (human-readable role intent, e.g. "budget approver"); `created_at bigint NOT NULL` (epoch-ms); `updated_at bigint NOT NULL`.
- PK: `(tenant_id, id)`. Uniqueness: `(tenant_id, slug)` (a role slug is unique within a tenant).
- A role is **cross-cutting**: it is NOT bound to a department or position at the role level — the scoping happens at assignment time via `org_scope`. (A "budget approver" role can be assigned within fin, cs, or any subtree.)
- All T-0013 invariants apply (FORCE RLS, default-DENY, `tenant_id` leading).
- Dev silo seed: a small, stable, idempotent set of roles sufficient to exercise the assignment + resolver path (at minimum a `tenant-owner` genesis role — the single root admin role referenced by T-0029 E3.3 — plus ≥1 cross-cutting functional role, e.g. `budget-approver`). Seeds use `ON CONFLICT DO NOTHING`; slug is the idempotency key.

### FR-2 — `role_assignment` table (the binding)

- `role_assignment` binds one `employee` to one `role`, within an org-scope set and a validity window. It is a tenant table.
- Fields:
  - `tenant_id uuid NOT NULL` (leading PK column, FK → `tenant(id)`)
  - `id uuid NOT NULL`
  - `employee_id uuid NOT NULL` (FK → `employee(tenant_id, id)`; the subject — human OR agent, identically: no fork)
  - `role_id uuid NOT NULL` (FK → `role(tenant_id, id)`)
  - `org_scope jsonb NOT NULL` (the org-scope SET — see FR-3)
  - `valid_from bigint NULL` (epoch-ms; NULL = "since beginning of time" — same `isEffective` convention as `grant`)
  - `valid_until bigint NULL` (epoch-ms; NULL = "no end"; the window is `[valid_from, valid_until)` — half-open, matching `grant-lattice.ts isEffective`: `validFrom==null || now>=validFrom) && (validUntil==null || now<validUntil`)
  - `source text NOT NULL` (provenance of the assignment, e.g. `manual`, `import`, `llm-proposed`; a free string in day-1, NOT a CHECK-constrained enum — the value set is owned by T-0039 workflow and is deliberately open here)
  - `granted_by text NOT NULL` (the actor that ultimately effected the assignment; same shape as `grant.granted_by text NOT NULL`)
  - `proposed_by text NULL` (who/what proposed the assignment — an LLM agent id in the T-0039 flow, NULL when directly created)
  - `confirmed_by text NULL` (who confirmed it; **see FR-4 — NULL ⇒ proposal, NOT-NULL ⇒ confirmed/effective**)
  - `created_at bigint NOT NULL` (epoch-ms)
  - `updated_at bigint NOT NULL`
- PK: `(tenant_id, id)`.
- All T-0013 invariants apply (FORCE RLS, default-DENY, `tenant_id` leading; every FK includes `tenant_id` on both sides — NF-2).
- Multiple assignments of the same `(employee_id, role_id)` MAY coexist if they differ by `org_scope` or validity window (e.g. the same person is "approver" in fin until Q3 and in cs from Q4). The migration does NOT impose a `UNIQUE(employee_id, role_id)` constraint — overlapping-window de-duplication is an application concern, not a schema invariant. (See OS-3.)

### FR-3 — `org_scope` SET shape (reuses the T-0018 `org` lattice element)

- `org_scope jsonb NOT NULL` stores **an org-hierarchy scope element OR a set of them**, in the exact shape of `grant-lattice.ts`'s `ScopeElement`:
  - a single org node: `{ "kind": "node", "hierarchy": "org", "nodeId": "<department.id|position.id>", "nodeLevel": "department"|"position" }`
  - a set: `{ "kind": "set", "members": [ <org node>, ... ] }` (cross-cutting roles spanning multiple subtrees)
- The `hierarchy` value MUST be `"org"` (NOT `"resource"`) — org scope is disjoint from resource scope (T-0018 ADR §38). `nodeId` MUST reference an existing `department.id` or `position.id` in the same tenant; `nodeLevel` MUST match (`department` for a department node, `position` for a position node).
- An assignment scoped to a department node covers that department's subtree per the existing `AncestryOracle` semantics (`isDescendantOrSelf` over the `org` hierarchy) — **this containment logic already exists in `grant-lattice.ts`**; T-0022 stores the scope, it does NOT re-implement containment.
- The empty set `{ "kind": "set", "members": [] }` is the lattice ⊥ (zero org reach) — a structurally-valid but capability-zero scope (default-DENY-consistent). It is permitted by the schema (the gate against meaningless assignments is application-layer, not a NOT-NULL/CHECK invariant here).
- **Validation depth:** the migration enforces `org_scope` is `NOT NULL` and valid JSON (jsonb). Deeper structural validation (that `nodeId` resolves to a live org node, that `hierarchy === "org"`) is an **application-layer / write-API invariant**, NOT a DB CHECK — consistent with how `grant.scope jsonb` is stored without a structural DB CHECK (migration 008). (See AC-9, OS-1.)

### FR-4 — `proposed_by` / `confirmed_by` semantics (day-1 columns; workflow = T-0039)

- Both columns exist day-1 (this task). The **column semantics** are fixed here; the **proposal/confirmation workflow** is T-0039 (out of scope).
- An assignment with `confirmed_by IS NULL` is a **proposal**: it is recorded but is **NOT effective** — it MUST NOT contribute grants to the resolver's `getGrants` result.
- An assignment with `confirmed_by IS NOT NULL` is **confirmed**: it is eligible to contribute grants (subject to its validity window and `org_scope`).
- `proposed_by` records the proposer (LLM agent id in the T-0039 flow); it MAY be NULL for an assignment created directly-confirmed (no separate proposal step) — in which case `proposed_by` is NULL and `confirmed_by` is the direct creator.
- The "no grant minted without confirmation" red-line (backlog E3.5 acceptance) is realized at the **resolution boundary**: the contract is that **only confirmed, in-window assignments yield grants**. This task fixes the contract in the column semantics and in the resolution contract (OS-1 / §"Resolution contract"); the resolver query that enforces it is wired in T-0053.

### FR-5 — `grant.role_id` deferred FK (promotion)

- Migration 021 promotes `grant.role_id` (today a plain `uuid NOT NULL` with no FK — migration 008) to a real FK: `FOREIGN KEY (tenant_id, role_id) REFERENCES choros.role(tenant_id, id)`.
- The FK is tenant-scoped (includes `tenant_id` on both sides — NF-2).
- After this migration, inserting a `grant` row whose `role_id` does not name an existing `role(tenant_id, id)` is rejected by the FK constraint. Any pre-existing dev-seed `grant` rows MUST reference a seeded `role.id` (the seed in FR-1 MUST cover every `role_id` referenced by existing grant seeds, or no grant seeds exist yet — the architect reconciles seed ordering).
- The `grant.role_id NOT NULL` floor (the ratified T-0018 contract the resolver reads) is unchanged; this migration only adds referential integrity.

### FR-6 — `known_tenant_tables.txt` update

- `ci/checks/known_tenant_tables.txt` MUST gain two lines: `role` and `role_assignment` (additive; the file currently ends at `employee`). The exact placement/ordering is not alphabetically enforced by the file today (it is insertion-ordered), so appending is acceptable; the orchestrator merges with T-0033/T-0019 additions.
- Both new tables MUST pass the existing `schema.test.ts` FF-2 (existence), FF-RLS (FORCE RLS), and the cross-tenant probe iterated over `KNOWN_TENANT_TABLES`.

---

## 3. Non-Functional Requirements

### NF-1 — T-0013 invariants (non-negotiable, inherited)

- Both tables: `tenant_id uuid NOT NULL` (no default), leading PK column, leading column of every composite index and FK; `ENABLE` + `FORCE ROW LEVEL SECURITY`; a default-DENY tenant-isolation policy (`USING`/`WITH CHECK` on `tenant_id = current_setting('choros.tenant_id', true)::uuid`); `GRANT SELECT, INSERT, UPDATE, DELETE ... TO choros_app`; accessed only via the `choros.tenant_id` GUC inside a transaction by the `NOBYPASSRLS` `choros_app` role.

### NF-2 — No cross-tenant FK paths

- Every FK includes `tenant_id` on both sides:
  - `role_assignment.employee_id` → `FOREIGN KEY (tenant_id, employee_id) REFERENCES choros.employee(tenant_id, id)`
  - `role_assignment.role_id` → `FOREIGN KEY (tenant_id, role_id) REFERENCES choros.role(tenant_id, id)`
  - `grant.role_id` (migration 021) → `FOREIGN KEY (tenant_id, role_id) REFERENCES choros.role(tenant_id, id)`
- A cross-tenant FK insert (child in tenant-A referencing a parent in tenant-B) is rejected by Postgres.

### NF-3 — `org_scope` is the SAME shape as the T-0018 lattice element (no second scope model)

- `org_scope` MUST serialize/deserialize as a `grant-lattice.ts` `ScopeElement` of the `org` hierarchy (or a `set` of them). No new scope grammar, no separate org-scope algebra. The org-scope containment (subtree reach) is decided by the **existing** `isNarrowerOrEqual` / `AncestryOracle` over `hierarchy: "org"`. This task introduces NO containment code.

### NF-4 — Forward compatibility (frozen keys)

- `role.id` is referenced as a point-in-time value by `actor_event.role_at_event` (T-0019, NOT a live FK) and as a live FK by `grant.role_id` (FR-5). `role.id` and the PK shape `(tenant_id, id)` are **fixed**: no renaming, no re-keying after migration.
- `role_assignment.org_scope` is read by T-0029 (admin boundary) and T-0032 (SoD over held roles). The column name and JSON shape are fixed.

### NF-5 — Migration number compliance

- The migrations MUST use file names `019_role.sql`, `020_role_assignment.sql`, `021_grant_role_fk.sql`. Numbers 017 (T-0033) and 018 (T-0019) are reserved by in-flight branches; T-0022 MUST NOT use them. No other number range is permitted for this task.

### NF-6 — Resolver untouched (parallel-edit safety)

- This task MUST NOT edit `src/core/grant-resolver.ts` or `src/core/grant-lattice.ts` (T-0033 edits the resolver in parallel). The role→grant resolution wiring is declared as an interface point (OS-1) and implemented in T-0053.

---

## 4. Out of Scope

- **The proposal/confirmation workflow (T-0039 / E3.5):** the LLM-proposes-grants → human-confirms UX/flow, the BYO-connected-agent integration, and the population of `proposed_by`/`confirmed_by` via that flow. Only the **columns** and their effective-vs-proposal **semantics** are in scope.
- **Scoped administration enforcement (T-0029 / E3.3):** the admin-delegation logic that bounds a delegated admin to their `org_scope` subtree, monotonic-narrowing of admin grants, and the `mgmt_object:*` write-grant path. T-0022 only provides the `org_scope` column T-0029 reads.
- **SoD evaluation (T-0032 / E4.2):** computing/forbidding conflicting role combinations. T-0022 only guarantees the queryable "subject → confirmed in-window roles" shape.
- **The DB-backed `GrantSource.getGrants` implementation** (the `role_assignment → grant` JOIN under RLS): this is T-0053. T-0022 ships the column contract only; `grant-resolver.ts` is NOT edited (NF-6, OS-1).
- **Role-authoring UI / structural-grant editor (T-0030 / E3.4):** composing a role's grants via UI. Not here.
- **`actor_event` / `role_at_event` (T-0019 / E4.1):** the SoD event ledger; `role.id` is its point-in-time reference target but the table is not built or FK'd here.
- **Org-node existence enforcement as a DB CHECK** on `org_scope.nodeId`: deferred to the application/write-API layer (consistent with `grant.scope jsonb` having no structural DB CHECK). The DB enforces `NOT NULL` + valid jsonb only.
- **`UNIQUE(employee_id, role_id)` or overlapping-window de-duplication:** not a schema invariant (FR-2); duplicate-suppression is an application concern.
- **Multi-tenant pooled provisioning:** silo (N=1) seeding only.
- **Delete/soft-delete/archival semantics** for roles and assignments beyond FK referential integrity.

---

## 5. Acceptance Criteria

### DB-level criteria (test / fitness — require live Postgres)

**AC-1** — `role` exists in `known_tenant_tables.txt` and `information_schema`; cross-tenant probe: context=tenant-A → only tenant-A rows; no-GUC (default-DENY) → count 0.
*verifiable_as: test*

**AC-2** — `role_assignment` exists in `known_tenant_tables.txt` and `information_schema`; cross-tenant probe passes identically to AC-1.
*verifiable_as: test*

**AC-3** — FORCE RLS on both tables: `pg_class.relrowsecurity = true AND relforcerowsecurity = true` for `role` and `role_assignment`; reconnect as `choros_app` (NOBYPASSRLS) without setting the GUC → `SELECT count = 0` on both.
*verifiable_as: test*

**AC-4** — Cross-tenant isolation: `schema.test.ts`/`cross_tenant.test.ts` iterating `KNOWN_TENANT_TABLES` passes unmodified for all pre-existing tables AND for `role` + `role_assignment` (seed tenant-A and tenant-B rows via migrator URL; probe via app URL in tenant-A context → tenant-B rows = 0).
*verifiable_as: test*

**AC-5** — `tenant_id` leading column: the static/fitness `tenant_id_leading` check passes for `role` and `role_assignment` — `tenant_id` is the first column AND the leading column of every index/FK on each table.
*verifiable_as: fitness*

**AC-6** — `role` slug uniqueness per tenant: inserting two `role` rows with the same `(tenant_id, slug)` → unique-constraint violation (23505); the same slug in a different tenant is allowed.
*verifiable_as: test*

**AC-7** — `role_assignment` FK tenant-scoping (employee): `FOREIGN KEY (tenant_id, employee_id) REFERENCES employee(tenant_id, id)` exists; inserting an assignment whose `employee_id` is absent → FK violation (23503); a cross-tenant employee reference is rejected.
*verifiable_as: test*

**AC-8** — `role_assignment` FK tenant-scoping (role): `FOREIGN KEY (tenant_id, role_id) REFERENCES role(tenant_id, id)` exists; inserting an assignment whose `role_id` is absent → FK violation (23503); a cross-tenant role reference is rejected.
*verifiable_as: test*

**AC-9** — `org_scope` is `jsonb NOT NULL`: a `role_assignment` insert with `org_scope = NULL` → NOT-NULL violation (23502); an insert with a valid `org`-node jsonb (`{"kind":"node","hierarchy":"org","nodeId":"<department.id>","nodeLevel":"department"}`) and a valid set jsonb succeeds and round-trips byte-equivalently as jsonb.
*verifiable_as: test*

**AC-10** — Validity window columns: `valid_from` and `valid_until` are `bigint NULL`; an assignment can be inserted with both NULL, with only `valid_from`, with only `valid_until`, and with both set; no DB CHECK forbids `valid_from > valid_until` (window sanity is application-layer — documented, not DB-enforced).
*verifiable_as: test*

**AC-11** — `proposed_by` / `confirmed_by` columns: both are `text NULL`; an assignment can be inserted with `confirmed_by IS NULL` (a proposal) and with `confirmed_by` set; `proposed_by` is independently nullable. Column types/nullability match this spec (queried via `information_schema.columns`).
*verifiable_as: test*

**AC-12** — `source` and `granted_by` columns: `source text NOT NULL`, `granted_by text NOT NULL`; inserting an assignment with `source = NULL` or `granted_by = NULL` → NOT-NULL violation; an arbitrary non-empty `source` string (e.g. `'manual'`, `'llm-proposed'`) is accepted (no CHECK enum).
*verifiable_as: test*

**AC-13** — `grant.role_id` is a real FK after migration 021: `information_schema.table_constraints` / `pg_constraint` shows a FOREIGN KEY on `grant` referencing `role(tenant_id, id)`; inserting a `grant` row whose `role_id` does not name an existing `role` → FK violation (23503). (Before 021 the same insert succeeded — regression guard.)
*verifiable_as: test*

**AC-14** — `grant.role_id` FK is tenant-scoped: the FK includes `tenant_id` on both sides; a `grant` in tenant-A referencing a `role.id` that exists only in tenant-B → FK violation.
*verifiable_as: test*

**AC-15** — Dev seed present + idempotent: after migrations 019–021 the dev tenant has ≥1 `role` row including a `tenant-owner` genesis role and ≥1 cross-cutting functional role; re-running the seed (`ON CONFLICT DO NOTHING`) yields the identical row count (no duplicates, no error).
*verifiable_as: test*

**AC-16** — Assignment seed wires a real employee to a real role within a real org node: the dev seed contains ≥1 `role_assignment` whose `employee_id` resolves to a seeded `employee`, `role_id` to a seeded `role`, and `org_scope` references a seeded `department.id` (hierarchy `"org"`, nodeLevel `"department"`). The assignment is idempotent on re-seed.
*verifiable_as: test*

**AC-17** — Migrations apply cleanly twice: `node migrations/run.mjs` applied against a fresh compose Postgres succeeds; 019–021 register in `schema_migrations`; a second run is a no-op (idempotent migration runner + `ON CONFLICT DO NOTHING` seeds).
*verifiable_as: test*

### Static / fitness criteria

**AC-18** — Migration numbers: this task adds exactly `migrations/019_role.sql`, `migrations/020_role_assignment.sql`, `migrations/021_grant_role_fk.sql` and NO file numbered 017 or 018 (reserved for T-0033 / T-0019). A static check over `migrations/` confirms the file set.
*verifiable_as: fitness*

**AC-19** — `known_tenant_tables.txt` gains exactly `role` and `role_assignment` (and nothing else) relative to this branch's base; the anti-decorative `schema.test.ts` guard (every choros base table is in the fixture) passes with both new tables present.
*verifiable_as: fitness*

**AC-20** — Resolver/lattice untouched (parallel-edit safety): `git diff` for this task shows NO change to `src/core/grant-resolver.ts` and NO change to `src/core/grant-lattice.ts`. A static check (diff path filter) confirms it.
*verifiable_as: fitness*

**AC-21** — `org_scope` shape conformance: a fitness check asserts every seeded `role_assignment.org_scope` parses as a `grant-lattice.ts` `ScopeElement` (node or set) with `hierarchy === "org"` and `nodeLevel ∈ {department, position}` — i.e. it is the SAME shape the lattice already understands (no second scope grammar). (Parse via the exported lattice types; no new parser is introduced.)
*verifiable_as: fitness*

**AC-22** — No second role/principal table: a static lint over migrations 019–021 finds no second role-equivalent or person-bound-grant table (e.g. no `person_grant`, no `agent_role` fork, no `human_role`); roles are one table and assignments bind both employee kinds (human/agent) through the single `role_assignment` table.
*verifiable_as: fitness*

---

## 6. Contract for downstream consumers (fixed here)

### Resolution contract (interface point — OS-1)

The grant-resolution read path that turns assignments into effective grants is wired in T-0053 (DB-backed `GrantSource.getGrants`). T-0022 fixes the contract that wiring MUST honor:

1. A subject's effective grants = grants attached (via `grant.role_id`) to roles for which the subject has a `role_assignment` that is **(a) confirmed** (`confirmed_by IS NOT NULL`), **(b) in-window** at `nowMs` (`isEffective` over `valid_from`/`valid_until`, half-open), and **(c)** whose `org_scope` admits the action's org context (org-hierarchy containment via the existing `AncestryOracle`).
2. A proposal (`confirmed_by IS NULL`) contributes **zero** grants.
3. An out-of-window assignment contributes **zero** grants (default-DENY).
4. Org-scope containment is decided by the **existing** `grant-lattice.ts` `org`-hierarchy machinery — no new algebra.

This is a **contract**, not an implementation: `grant-resolver.ts` is NOT edited here (NF-6, AC-20).

### Contract for T-0029 (scoped administration)

`role_assignment.org_scope` is the **admin boundary** for a delegated admin: their grant-issuance authority is confined to the subtree(s) named by their (confirmed, in-window) admin-role assignment's `org_scope` set. Removing the assignment removes the capability. T-0022 guarantees `org_scope` is a non-widenable, lattice-shaped scope-set; T-0029 reads it.

### Contract for T-0039 (LLM-proposes / human-confirms)

`proposed_by`/`confirmed_by` are day-1 columns with fixed semantics (FR-4): NULL `confirmed_by` ⇒ proposal (no effect); NOT-NULL ⇒ confirmed (eligible). T-0039 owns the workflow that transitions a proposal to confirmed and the `source='llm-proposed'` provenance.

### Contract for T-0019 (actor_event)

`role.id` is stable and never re-keyed (NF-4), so a point-in-time `role_at_event` reference remains semantically resolvable even after a role is retired. NOT a live FK (deliberate — an event outlives its role).

### Contract for T-0032 (SoD)

The set of roles a subject holds = the subject's confirmed, in-window `role_assignment` rows. T-0022 guarantees this is queryable; T-0032 evaluates SoD over it.

---

## 7. Blocking Questions

None. All design choices are resolvable from the GT-1-signed sources and the REAL foundation code in the worktree:

- **`org_scope` shape** — fixed by the existing `grant-lattice.ts` `org`-hierarchy `ScopeElement` (department/position node levels already defined). No new product decision: T-0022 stores the shape the lattice already defines.
- **`grant.role_id` deferred FK** — explicitly pre-authorized: migration 008's header and the T-0018 ADR name T-0022 as the task that adds it. Not a new decision.
- **`proposed_by`/`confirmed_by` day-1-as-schema, workflow-as-Stage-2** — the backlog E3.2 acceptance ("`proposed_by`/`confirmed_by` are recorded") + E3.5 split makes the column-vs-workflow boundary explicit. Not a new decision.
- **Migration numbers 019–021** — frozen by orchestrator (017 = T-0033, 018 = T-0019 in flight). Not a decision.
- **Resolution wiring deferred to T-0053, resolver not edited** — the T-0021 ADR already states the DB-backed `getGrants` lands in T-0053; T-0033 editing the resolver in parallel makes "declare interface point, don't edit" the only conflict-safe choice. Not a product decision.
- **No `UNIQUE(employee_id, role_id)`** — overlapping scoped/windowed assignments are a legitimate modeled case (same role, different subtree/window); duplicate-suppression is application-layer. Consistent with `grant` having no such constraint. Not a blocking decision.

All assignment-vs-grant, org-scope-vs-resource-scope, and proposal-vs-confirmed boundaries are derived from ratified ADRs (T-0013, T-0018, T-0021) and the GT-1 backlog, not invented.
