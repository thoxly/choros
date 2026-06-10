# ADR · T-0022 — Roles + assignments: `role`, `role_assignment` (org_scope SET, validity window, proposed_by/confirmed_by)

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-10
**Task:** E3.2 — `role` (the first-class assignable principal); `role_assignment(employee_id, role_id, org_scope SET, valid_from/until, source, granted_by, proposed_by, confirmed_by)`; promote the deferred `grant.role_id` FK.
**Spec:** `docs/specs/T-0022-roles-assignments.spec.md` (status: ready, AC-1..AC-22) · `docs/specs/T-0022.spec.contract.json`

**Foundation (do NOT contradict):**
- `docs/design/T-0013-tenant-isolation.adr.md` — `tenant_id` leading PK column, FORCE RLS + default-DENY, `choros_app` NOBYPASSRLS, `SET LOCAL choros.tenant_id` contract.
- `docs/design/T-0115-tenant-rls.adr.md` — `ci/checks/known_tenant_tables.txt` is the RLS CI invariant; new tenant tables MUST be added (additive `role`, `role_assignment`).
- `docs/design/T-0018-grant-authority.adr.md` — `role` IS the principal grants attach to (never a person/agent). `grant.role_id` (migration 008) is a plain `uuid NOT NULL` whose FK to `role(tenant_id, id)` was DEFERRED to this task (008 header + T-0018 §1.2 / open-items #4). **org/admin scope ≠ resource scope** — the T-0018/T-0021 resource-scope subset check is NOT touched here.
- `src/core/grant-lattice.ts` (REAL code) — the `ScopeElement` lattice already carries an `org` hierarchy with `NodeLevel ∈ {department, position}`. `org_scope` SET values are exactly those org `ScopeElement`s (node or `{kind:"set"}`). **The machinery exists; T-0022 stores the shape — no new scope algebra.**
- `src/core/grant-resolver.ts` (REAL code) — the read-path PDP; its `GrantSource.getGrants` port resolves "current grants via role assignments AT CALL TIME". `role_assignment` backs that resolution. **NOT edited here** (T-0033 edits the resolver in parallel; DB wiring is T-0053).
- `migrations/014_department.sql`, `015_position.sql`, `016_employee.sql` (REAL) — `department.id`/`position.id` are the org-tree node ids `org_scope` references; `employee.id` is the assignment subject. PK `(tenant_id, id)` fixed; composite-FK pattern `(tenant_id, fk_id)` mandatory (NF-2).

**Siblings (contract fixed here, built elsewhere):** T-0029 (reads `org_scope` as admin boundary), T-0039 (proposed_by/confirmed_by workflow), T-0019 (`role_at_event` point-in-time, NOT FK), T-0032 (SoD over confirmed roles), T-0053 (DB-backed `getGrants`).

---

## 1. Decision

**Ship three additive migrations — `019_role.sql`, `020_role_assignment.sql`, `021_grant_role_fk.sql` — plus two `known_tenant_tables.txt` lines, and update the two affected DB-fitness test files (`schema.test.ts`, `cross_tenant.test.ts`) to track the new tables and the now-real `grant.role_id` FK. `role` and `role_assignment` are plain T-0013 tenant tables; `org_scope` is a `jsonb NOT NULL` column carrying the EXISTING `grant-lattice.ts` org-`ScopeElement` shape with no new algebra and no DB structural CHECK; the proposal-vs-confirmed and role→grant resolution behaviours are fixed as a CONTRACT consumed by T-0053 — `src/core/` is untouched.**

This was validated live: an isolated Postgres was brought up, migrations 001–016 + 019–021 applied (and re-applied — idempotent no-op), and every DB-level AC was probed against real Postgres (see §6 "Live verification").

### 1.1 `role` — the principal (migration 019)

`role(tenant_id, id, slug, display_name, description NULL, created_at, updated_at)`, PK `(tenant_id, id)`, `UNIQUE (tenant_id, slug)`. A role is **cross-cutting**: NOT bound to a department/position at the role level — scoping is per-assignment via `org_scope`. `role.id` is FROZEN (NF-4): live FK target of `grant.role_id` and point-in-time reference of `actor_event.role_at_event`. T-0013 invariants applied verbatim from the sibling org tables (ENABLE+FORCE RLS, default-DENY policy on the `choros.tenant_id` GUC, DML grant to `choros_app`).

Dev seed (idempotent on `(tenant_id, slug)`): `tenant-owner` (genesis root admin role T-0029 references) + `budget-approver` (cross-cutting functional role). UUIDs `e0000000-…-0001/0002`.

### 1.2 `role_assignment` — the binding (migration 020)

All spec FR-2 columns, PK `(tenant_id, id)`, two tenant-scoped composite FKs:
`(tenant_id, employee_id) → employee(tenant_id, id)` and `(tenant_id, role_id) → role(tenant_id, id)`. **No `UNIQUE(employee_id, role_id)`** — overlapping scoped/windowed assignments are a legitimate modeled case (FR-2), consistent with `grant` having no such constraint; de-duplication is application-layer.

- **`org_scope jsonb NOT NULL`** — stores a `grant-lattice.ts` org-`ScopeElement` (`{kind:"node",hierarchy:"org",nodeId,nodeLevel}`) or a `{kind:"set",members:[…]}`. The DB enforces **NOT NULL + valid jsonb only**; structural validation (`nodeId` resolves to a live org node, `hierarchy==="org"`) is an application/write-API invariant — mirroring exactly how `grant.scope jsonb` is stored with no DB CHECK (migration 008). The empty set `{"kind":"set","members":[]}` is the lattice ⊥ (zero reach) — schema-valid, capability-zero, default-DENY-consistent.
- **Validity window** — `valid_from`/`valid_until bigint NULL` (epoch-ms), half-open `[from, until)`, same `isEffective` convention as `grant`. **No DB CHECK** forbids `valid_from > valid_until` (AC-10): window sanity is application-layer, consistent with `grant`'s window.
- **`source`/`granted_by text NOT NULL`** — free strings, no CHECK enum (the value set is owned by the T-0039 workflow). **`proposed_by`/`confirmed_by text NULL`** — semantics fixed below.

Dev seed (idempotent, fixed UUID `f0000000-…-0001`): `e-mironov` (fin-appr) → `budget-approver`, scoped to the `fin` department node, `confirmed_by` set (confirmed/effective), `proposed_by` NULL (created direct).

### 1.3 `proposed_by` / `confirmed_by` — contract, not workflow

Day-1 columns; the **workflow** (LLM-proposes → human-confirms) is T-0039. The **column semantics** are fixed here and realized at the **resolution boundary** (not a DB CHECK):
`confirmed_by IS NULL` ⇒ **proposal** (recorded, contributes ZERO grants); `confirmed_by IS NOT NULL` ⇒ **confirmed** (eligible, subject to window + `org_scope`). `proposed_by` is independently nullable.

### 1.4 `grant.role_id` deferred FK (migration 021)

Pure additive `ALTER TABLE choros."grant" ADD CONSTRAINT grant_role_id_fkey FOREIGN KEY (tenant_id, role_id) REFERENCES choros.role(tenant_id, id)`. Split into its own file so `role` (019) exists first and the migration is independently appliable. The constraint is **named** so the fitness check can assert it by name. The `grant.role_id NOT NULL` floor (the ratified T-0018 contract the resolver reads) is unchanged — this adds referential integrity only.

**Safe on existing data (verified live):** the `grant` table is EMPTY in the dev base (no migration seeds any grant row), so the FK validation pass finds no orphan `role_id`. **Seed-ordering invariant for downstream:** any FUTURE grant seed MUST reference a role seeded in 019 (019 `role` precedes any grant seed lexicographically; 008's table create precedes 019, but no 008 *data* exists to violate the FK).

### 1.5 Resolver / lattice untouched (NF-6, AC-20)

`src/core/grant-resolver.ts` and `src/core/grant-lattice.ts` are NOT edited. The role→grant resolution chain (`subject → role_assignment → role → grant → resolved view`) is declared as a **contract** (§5) consumed by the T-0053 DB-backed `getGrants` JOIN. This is the only write-conflict-safe choice given T-0033 edits the resolver in parallel. AC-20 is enforced by the existing `grant-resolver-isolation.sh` Check-3 (`git diff --quiet HEAD` over the frozen modules) — my changes touch only `migrations/` and `ci/checks/db/`, so it stays green.

---

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| A new org-scope algebra / separate `org_scope` columns (`scope_dept_id`, `scope_pos_id`) | NF-3 violation: a second scope grammar. The `grant-lattice.ts` org-`ScopeElement` already encodes node-or-set over the org hierarchy with working `AncestryOracle` containment. Reusing it as `jsonb` keeps ONE scope model; T-0029's subtree-bounding reads the same shape the lattice understands. |
| A normalized link table `role_assignment_scope(assignment_id, node_id, node_level)` for the SET | Over-engineering (rubric ax.5). The set is small (cross-cutting roles span a handful of subtrees), read whole by the resolver, and the lattice consumes a single serialized `ScopeElement`. A link table would force a re-assembly step and a second containment path. `grant.scope jsonb` set the precedent: scope-sets live as jsonb. |
| DB CHECK that `org_scope` is well-formed (`hierarchy='org'`, `nodeId` resolves) | Inconsistent with `grant.scope jsonb` (no structural CHECK). `nodeId` existence is a cross-row/cross-table predicate not expressible as a column CHECK without a trigger; the write-API is the validation seam (mirrors the whole codebase). DB enforces NOT NULL + valid jsonb (the type does that). |
| DB CHECK `valid_from <= valid_until` | Spec AC-10 explicitly forbids it (window sanity is application-layer, matching `grant`). A confirmed-but-expired window is a legitimate stored state the resolver filters at read time. |
| Fold the FK into `020` (or back-patch `008`) instead of a separate `021` | Splitting keeps each migration independently appliable and the FK a pure additive ALTER after `role` exists; back-patching `008` would rewrite frozen history and break the recorded `schema_migrations` version. |
| `UNIQUE(employee_id, role_id)` on `role_assignment` | FR-2: same role in different subtree/window is a real case; de-dup is application-layer. Consistent with `grant`. |
| Edit `grant-resolver.ts` to wire role→grant now | NF-6 / AC-20: T-0033 edits the resolver in parallel (write-conflict); DB-backed `getGrants` is T-0053 per the T-0021 ADR. T-0022 ships the column contract only. |
| A `person_grant` / `agent_role` fork for human vs agent subjects | AC-22: roles are ONE table; both employee kinds bind through the SINGLE `role_assignment` (employee.id is kind-agnostic — the org tables already unified human/agent in one `employee` table). |

---

## 3. Object model

### Entity `role` (migration 019)
| field | type | notes |
|---|---|---|
| tenant_id | uuid NOT NULL | leading PK col, no default (T-0013) |
| id | uuid NOT NULL | frozen (NF-4); FK target of grant.role_id |
| slug | text NOT NULL | UNIQUE(tenant_id, slug); idempotency key |
| display_name | text NOT NULL | |
| description | text NULL | role intent, e.g. "budget approver" |
| created_at | bigint NOT NULL | epoch-ms |
| updated_at | bigint NOT NULL | epoch-ms |

PK `(tenant_id, id)` · UNIQUE `(tenant_id, slug)` · FORCE RLS + default-DENY policy · GRANT DML to choros_app.

### Entity `role_assignment` (migration 020)
| field | type | notes |
|---|---|---|
| tenant_id | uuid NOT NULL | leading PK col |
| id | uuid NOT NULL | |
| employee_id | uuid NOT NULL | FK (tenant_id, employee_id) → employee(tenant_id, id) |
| role_id | uuid NOT NULL | FK (tenant_id, role_id) → role(tenant_id, id) |
| org_scope | jsonb NOT NULL | grant-lattice org ScopeElement (node or set); NOT NULL + valid jsonb only |
| valid_from | bigint NULL | epoch-ms; NULL = since-beginning; half-open window |
| valid_until | bigint NULL | epoch-ms; NULL = no-end; no CHECK vs valid_from |
| source | text NOT NULL | free string, no CHECK enum (T-0039 owns the value set) |
| granted_by | text NOT NULL | same shape as grant.granted_by |
| proposed_by | text NULL | proposer (LLM agent id in T-0039); NULL when direct |
| confirmed_by | text NULL | **NULL ⇒ proposal (zero grants); NOT NULL ⇒ confirmed** |
| created_at | bigint NOT NULL | epoch-ms |
| updated_at | bigint NOT NULL | epoch-ms |

PK `(tenant_id, id)` · FK employee + FK role (both tenant-scoped, NF-2) · FORCE RLS + default-DENY · GRANT DML to choros_app · **no UNIQUE(employee_id, role_id)**.

### Mutation to `grant` (migration 021)
Add named tenant-scoped FK `grant_role_id_fkey: (tenant_id, role_id) → role(tenant_id, id)`. No column/floor change.

### `org_scope` JSON shape (the EXISTING `ScopeElement`, NOT a new type)
```jsonc
// single org node:
{ "kind": "node", "hierarchy": "org", "nodeId": "<department.id|position.id>", "nodeLevel": "department"|"position" }
// set of org nodes (cross-cutting):
{ "kind": "set", "members": [ /* org-node ScopeElements */ ] }
```
`hierarchy` MUST be `"org"` (disjoint from `"resource"`). Containment = the EXISTING `AncestryOracle` / `isNarrowerOrEqual` over the org hierarchy. T-0022 introduces NO containment code.

---

## 4. Contracts (compatibility — FE-W23-0008)

T-0022 changes two **public/CI surfaces** beyond the additive migrations. Both are in `ci/checks/db/` (NOT in the AC-20 frozen `src/core/` set), so editing them is in-scope and required — silently leaving them red would be a hidden break.

### C-1 — `ci/checks/db/schema.test.ts` · FF-FK-RESOLVE breaks and MUST be updated
The current FF-FK-RESOLVE block asserts (today's reality, pre-021):
1. every FK targets a baseline table AND `expect(['role','assignment']).not.toContain(r.dst)` — **inverts** once `grant_role_id_fkey → role` exists (role is now a legitimate, baseline FK target);
2. `it('grant.role_id carries no FK')` expecting `rows` empty — **inverts** once 021 adds the FK.

**Required `coder` change:** update FF-FK-RESOLVE to (a) include `role` (and `role_assignment`) as valid baseline FK targets via the `KNOWN_TENANT_TABLES` set (they're added to the fixture), (b) remove/replace the `not.toContain('role')` line, (c) replace `grant.role_id carries no FK` with a **positive** assertion: `grant` has a FK named `grant_role_id_fkey` referencing `role(tenant_id, id)` (this becomes the AC-13 regression guard). Also add `role_assignment→employee`, `role_assignment→role`, `grant→role` to the `arrayContaining` FK-pairs list. The `FF-JSONB` block MAY gain `['role_assignment','org_scope']` (optional; AC-9's dedicated test covers it).

### C-2 — `ci/checks/db/cross_tenant.test.ts` · `seedRowForTable` dispatcher throws on the new tables and MUST gain seed cases
The test iterates `KNOWN_TENANT_TABLES` generically and routes each table through a `seedRowForTable` switch whose `default:` **throws** `unknown table`. Adding `role`/`role_assignment` to the fixture makes the AC-1/AC-2 iteration call `seedRowForTable(c, 'role', …)` → throw.

**Required `coder` change:** add `case 'role'` (insert a role row, store its id per tenant — like the dept/pos chain) and `case 'role_assignment'` (insert wiring the already-seeded employee + the new role, with a valid org-node `org_scope` and `confirmed_by` set) to the dispatcher and `seedState`. Ordering: `role` after `tenant`; `role_assignment` after `employee` + `role`. The `cross-tenant-fitness.sh` static guard (references KNOWN_TENANT_TABLES / appUrl / migratorUrl) stays satisfied — those tokens are preserved.

No other `KNOWN_TENANT_TABLES` consumer breaks: `two_tenant.test.ts` doesn't iterate the list; `object-handle.test.ts` uses a local constant; `pgTimerStore` references it only in a comment. (Verified by grep over all consumers.)

### Downstream data contracts (fixed here, built elsewhere)
- **T-0053 resolution contract:** effective grants = grants attached (via `grant.role_id`) to roles for which the subject has a `role_assignment` that is **(a) confirmed** (`confirmed_by IS NOT NULL`), **(b) in-window** (`isEffective` half-open), **(c)** whose `org_scope` admits the org context (existing `AncestryOracle`). Proposal ⇒ 0 grants; out-of-window ⇒ 0 grants. `grant-resolver.ts` NOT edited.
- **T-0029:** `org_scope` is the non-widenable, lattice-shaped admin boundary; removing the assignment removes the capability.
- **T-0039:** owns the proposal→confirmed transition + `source='llm-proposed'`.
- **T-0019:** `role.id` is stable/never re-keyed → `role_at_event` stays resolvable; NOT a live FK.
- **T-0032:** "roles a subject holds" = confirmed, in-window `role_assignment` rows (queryable shape guaranteed).

---

## 5. Fitness functions

| id | rule | ci_check |
|---|---|---|
| FF-1 | `role` & `role_assignment` exist as tenant tables, in `known_tenant_tables.txt` + `information_schema` | `schema.test.ts` FF-2 over `ALL_BASELINE` (fixture gains both) → `npm run fitness:db` |
| FF-2 | FORCE RLS (`relrowsecurity AND relforcerowsecurity`) on both; default-DENY → 0 rows without GUC under choros_app | `schema.test.ts` FF-RLS + `cross_tenant.test.ts` no-GUC probe (AC-3) |
| FF-3 | cross-tenant isolation: choros_app in tenant-A sees 0 tenant-B rows for both tables | `cross_tenant.test.ts` AC-1/AC-2 iteration over `KNOWN_TENANT_TABLES` (after C-2 seed cases) |
| FF-4 | `tenant_id` is column 1 AND leads every index/FK on both tables | `schema.test.ts` FF-LEAD (iterates `KNOWN_TENANT_TABLES`) (AC-5) |
| FF-5 | `UNIQUE(tenant_id, slug)` on `role`: dup → 23505; cross-tenant same slug OK | dedicated test on `role` (AC-6) — verified live |
| FF-6 | `role_assignment` FKs tenant-scoped: absent/cross-tenant employee or role → 23503 | dedicated test (AC-7/AC-8) — verified live |
| FF-7 | `org_scope jsonb NOT NULL`: NULL → 23502; valid node+set jsonb round-trips | dedicated test (AC-9) — verified live |
| FF-8 | window `bigint NULL` × all 4 null-combos insertable; no CHECK on from>until | dedicated test (AC-10) — verified live |
| FF-9 | `proposed_by`/`confirmed_by text NULL` independently; `source`/`granted_by text NOT NULL` (NULL → 23502) | `information_schema.columns` + insert tests (AC-11/AC-12) — verified live |
| FF-10 | `grant_role_id_fkey` exists → `role(tenant_id, id)`; bad role_id → 23503; tenant-scoped (cross-tenant role ref → 23503) | `schema.test.ts` FF-FK-RESOLVE (after C-1) + dedicated regression test (AC-13/AC-14) — verified live |
| FF-11 | seeds present + idempotent: ≥1 role incl `tenant-owner` + ≥1 functional; ≥1 assignment wiring real employee→role→dept node; re-run = same counts | seed-count test after double-run (AC-15/AC-16) — verified live (re-run no-op) |
| FF-12 | migrations apply cleanly twice (fresh compose PG); 019–021 in `schema_migrations`; 2nd run no-op | `two_tenant.test.ts` `runMigrations()` + runner idempotency (AC-17) — verified live |
| FF-13 | exactly `019_role.sql`,`020_role_assignment.sql`,`021_grant_role_fk.sql`; NO 017/018 file | static check over `migrations/` (AC-18) |
| FF-14 | `known_tenant_tables.txt` gains exactly `role`+`role_assignment`; anti-decorative guard passes | `schema.test.ts` anti-decorative block (AC-19) |
| FF-15 | `git diff` shows NO change to `src/core/grant-resolver.ts` or `src/core/grant-lattice.ts` | `grant-resolver-isolation.sh` Check-3 (`git diff --quiet HEAD`) (AC-20) |
| FF-16 | every seeded `role_assignment.org_scope` parses as a lattice `ScopeElement`, `hierarchy==='org'`, `nodeLevel ∈ {department,position}` | parse via exported lattice types over seed rows (AC-21) |
| FF-17 | no second role/principal table in 019–021 (`person_grant`/`agent_role`/`human_role`) | static lint over the 3 migration files (AC-22) |

---

## 6. Live verification (this DESIGN ran the DDL against real Postgres)

Isolated Postgres (`postgres:16`, project `t0022test`, port 55445, torn down after). Applied 001–016, then 019–021; re-ran the runner (no-op — AC-17). Probed:
- **RLS:** `role`/`role_assignment` both `relrowsecurity=t, relforcerowsecurity=t` (AC-3).
- **FKs present:** `grant_role_id_fkey → role`, `role_assignment_…_employee_id_fkey → employee`, `role_assignment_…_role_id_fkey → role` (all composite, tenant-scoped).
- **Columns:** `role_assignment` types/nullability match FR-2 exactly (org_scope jsonb NO; valid_from/until bigint YES; source/granted_by text NO; proposed_by/confirmed_by text YES).
- **Negatives:** dup slug → 23505; same slug other tenant → OK; absent employee/role → 23503; org_scope NULL → 23502; source NULL → 23502; `valid_from>valid_until` → accepted (no CHECK); grant bad role_id → 23503; grant tenant-A → role-only-in-tenant-B → 23503 (AC-6..AC-14).
- **Cross-tenant under real `choros_app` (NOBYPASSRLS):** tenant-A context → 0 tenant-B rows, only tenant-A row visible, for both new tables (AC-1/AC-2/AC-4).
- **Seeds:** role_count=2 (incl tenant-owner), ra_count=1 (e-mironov→budget-approver, org_scope=fin dept node, confirmed) (AC-15/AC-16/AC-21).

Every DB-level acceptance criterion was confirmed against live Postgres; the SQL is not theoretical.

---

## 7. Runtime / deploy target

**Container (local compose Postgres) → founder-gated dev/prod (GT-4).** No new external resource: T-0022 adds tables to the EXISTING single-Postgres substrate (T-0053). Migrations run via the existing zero-dep `migrations/run.mjs`. No founder gate beyond the standard promote-to-dev/prod that every migration already carries. No escalation: all design choices derive from GT-1-signed sources + ratified ADRs (T-0013/T-0018/T-0021), with zero blocking questions (spec §7).

---

## 8. Implementation handoff (coder scope)

1. `migrations/019_role.sql`, `020_role_assignment.sql`, `021_grant_role_fk.sql` — **drafted in this branch and live-verified** (the architect authored the DDL per §0 of the spec; coder reviews/keeps).
2. `ci/checks/known_tenant_tables.txt` — append `role` then `role_assignment` (additive; orchestrator merges with T-0033/T-0019).
3. **C-1** — update `ci/checks/db/schema.test.ts` FF-FK-RESOLVE (positive `grant_role_id_fkey` assertion; role/role_assignment as valid FK targets; extend the FK-pairs `arrayContaining`).
4. **C-2** — add `role` + `role_assignment` seed cases to `ci/checks/db/cross_tenant.test.ts` `seedRowForTable`/`seedState`.
5. Author the per-AC DB tests (AC-6..AC-16) + static fitness checks (AC-18/AC-21/AC-22) — the live probes in §6 are the executable templates.
6. Do NOT touch `src/core/grant-resolver.ts` / `src/core/grant-lattice.ts` (AC-20).
