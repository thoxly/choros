# Spec · T-0017 — Org Structure: tenant, department(tree), position, employee

**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-06-10
**Task:** E3.1 — `tenant`, `department`(tree), `position`, `employee(kind ∈ {human,agent}, position_id)` — agents share the `employee` table
**Authoritative source:** `playbooks/rbac-backlog.md#E3.1` (GT-1, founder-signed 2026-06-08) · `playbooks/rbac-discovery-phase1-hypothesis.md` §5 (object model), §3 Q7
**Foundation (do NOT contradict):**
- `docs/design/T-0013-tenant-isolation.adr.md` — every org table is a T-0013 tenant table: `tenant_id` leading, FORCE RLS + default-DENY, accessed via `choros.tenant_id` GUC, `NOBYPASSRLS` app role
- `docs/design/T-0115-tenant-rls.adr.md` — `ci/checks/known_tenant_tables.txt` is the RLS CI invariant; every new tenant table MUST be added to that file
- `docs/design/T-0054-keycloak-compose.adr.md` — dev org fixture (`src/http/org.ts`) = source of truth for 7 human users + 1 agent service-account pattern that this spec supersedes with real tables; T-0054 realm JSON and Keycloak user IDs MUST remain consistent with the new `employee` table IDs
- `docs/design/T-0018-grant-authority.adr.md` — `grant.role_id` will reference `role(tenant_id, id)` (deferred FK added in T-0022); this task seeds the `employee` table that `assignment` (T-0022) will link into

**Siblings (built after this, not here):**
- T-0020 (E5.1) — `agent_card(employee_id, …)` — thin extension ON TOP of the `employee` table built here; `kind=agent` rows are created here but the card columns land in T-0020
- T-0022 (E3.2) — `role`, `assignment(employee_id, role_id, org_scope SET, …)` — the first consumer of `employee.id` and `department`/`position` tree-node IDs as org-scope anchors
- T-0019 (E4.1) — `actor_event(object_ref, actor, …)` — `actor` references `employee.id`
- T-0053 (E0.3) — owns DDL/migrations already applied (001-010); T-0017 migrations use **numbers starting at 013** (011-012 are reserved by T-0116 / app_timer running in parallel); this spec authors migrations 013-016

---

## 0. Note on scope (design-only + migration authoring)

Unlike the earlier DESIGN-only T-0013/T-0014/T-0018 tasks, **T-0017 is a DESIGN + BUILD** task: Postgres now exists (T-0053 done, migrations 001–010 applied), so the org-structure migrations (013–016) and the known_tenant_tables update are **authored here and applied in CI**. The SQL DDL is owned by the `architect`/`coder` phases; this spec pins the **invariants, table shapes, and acceptance criteria** those phases MUST satisfy.

### Migration number assignment (frozen by orchestrator)

Migration numbers 011 and 012 are reserved for T-0116 (app_timer). T-0017 uses:

| File | Content |
|---|---|
| `migrations/013_tenant.sql` | `tenant` table |
| `migrations/014_department.sql` | `department` table (tree via `parent_id`) |
| `migrations/015_position.sql` | `position` table |
| `migrations/016_employee.sql` | `employee` table (kind column, position FK) |

`ci/checks/known_tenant_tables.txt` gains 4 new lines (`tenant`, `department`, `position`, `employee`) — additive; the orchestrator merges with T-0116's additions.

### Fixture-to-real-tables seam

**Before T-0017:** `GET /api/org` is served from the in-memory fixture `src/http/org.ts` (`ORG_SEED`). `GET /api/me` (dev-auth path) resolves identity via `findEmployee()` from the same seed.

**After T-0017:** the real Postgres tables are authoritative. The `architect` phase specifies the migration to real tables and the API seam; this spec fixes the **correctness invariants** that govern the transition:

1. The employee IDs in the real `employee` table for the dev silo MUST be the same UUIDs/slugs as the existing dev fixture IDs (`e-kravtsova`, `e-mironov`, `e-larina`, `e-orlov`, `e-savina`, `e-petrov`, `e-belov` for humans; `a-recon`, `a-invoice`, `a-triage` for agents; `s-ledger`, `s-ocr` for service workers). T-0054 realm JSON matches these IDs in `preferred_username`; changing them would break Keycloak JWT → employee resolution.
2. `GET /api/org` MAY continue to serve the in-memory fixture during the `dev` auth-mode period **until** migration 016 is applied and seeded. **After** migration 016 is applied, `GET /api/org` MUST read from the real tables.
3. `src/http/org.ts` fixture seed can be removed only after all CI tests that reference it are migrated to use real DB data. This task authors the tables; the wiring of `/api/org` to real tables is in scope for the `coder` phase (AC-13).
4. The `agent` and `service` type designations in the fixture map to `kind = 'agent'` in the new table (`service` workers are also `kind = 'agent'` — they are automated actors; see FR-4).

---

## 1. Summary

Build the four org-structure tables that form the backbone of Choros's polymorphic executor model: `tenant` (the tenancy root), `department` (tree via `parent_id`), `position` (hangs off a department), and `employee` (polymorphic: `kind ∈ {human, agent}`). Agents share the `employee` table with humans — this is the design invariant that makes E5 (agent card/rights) a thin extension rather than a parallel stack. All four tables satisfy the T-0013 tenant-isolation invariant and are added to the CI fixture.

---

## 2. Functional Requirements

### FR-1 — `tenant` table

- `tenant` is a tenant-anchor table: every other org table has `tenant_id` FK into `tenant(id)`.
- Fields: `id uuid NOT NULL` (PK); `slug text NOT NULL UNIQUE`; `display_name text NOT NULL`; `created_at bigint NOT NULL` (epoch-ms).
- Because `tenant` IS the root of tenancy (its `id` IS the `tenant_id` used everywhere), its own RLS policy is special: a row is visible iff `id = current_setting('choros.tenant_id', true)::uuid`. This is consistent with default-DENY: without a GUC, 0 rows are visible.
- The genesis row (the `tenant-owner` row) is seeded by the migration for the dev silo. In production, the tenant row is provisioned at silo-setup time (out of scope for this task).

### FR-2 — `department` table (tree)

- Fields: `tenant_id uuid NOT NULL` (leading PK column, FK → `tenant(id)`); `id uuid NOT NULL`; `parent_id uuid NULL` (FK → `department(tenant_id, id)`, nullable = root departments); `slug text NOT NULL`; `display_name text NOT NULL`; `created_at bigint NOT NULL`; `updated_at bigint NOT NULL`.
- PK: `(tenant_id, id)`. Uniqueness: `(tenant_id, slug)`.
- A `department` with `parent_id IS NULL` is a **root department**.
- The tree is **unbounded depth** but acyclic; cycle-prevention is a write-time invariant (no ancestor ⊆ descendant path). The initial implementation MAY enforce this via application-layer check; a DB-level check is autonomous implementation detail.
- All T-0013 invariants apply: FORCE RLS, default-DENY policy, `tenant_id` leading index.

### FR-3 — `position` table

- Fields: `tenant_id uuid NOT NULL` (leading PK column); `id uuid NOT NULL`; `department_id uuid NOT NULL` (FK → `department(tenant_id, id)`); `slug text NOT NULL`; `title text NOT NULL`; `created_at bigint NOT NULL`; `updated_at bigint NOT NULL`.
- PK: `(tenant_id, id)`. Uniqueness: `(tenant_id, department_id, slug)`.
- A position belongs to exactly one department. Multiple employees may hold the same position.
- All T-0013 invariants apply.

### FR-4 — `employee` table (the polymorphic executor, kinds: human / agent)

- Fields: `tenant_id uuid NOT NULL` (leading PK column); `id uuid NOT NULL`; `position_id uuid NULL` (FK → `position(tenant_id, id)`, nullable for agents not yet assigned to a position); `kind text NOT NULL CHECK (kind IN ('human', 'agent'))`; `slug text NOT NULL`; `display_name text NOT NULL`; `created_at bigint NOT NULL`; `updated_at bigint NOT NULL`.
- PK: `(tenant_id, id)`. Uniqueness: `(tenant_id, slug)`.
- `kind = 'human'`: a human employee. Linked to a Keycloak identity at the JWT-resolution layer (T-0060, out of scope here; the link key is `employee.slug = jwt.preferred_username`).
- `kind = 'agent'`: an automated actor (AI agent OR microservice worker). The existing fixture distinguishes `type: "agent"` and `type: "service"` — **both map to `kind = 'agent'`** in the new table. The finer distinction (AI vs. service-connector) is carried in `agent_card` (T-0020, out of scope here).
- **No schema fork**: there is NO separate `agent` table, NO separate `human` table. The `agent_card` extension (T-0020) adds columns in a separate table keyed to `employee(tenant_id, id)` where `kind = 'agent'`. This spec does NOT build agent_card.
- All T-0013 invariants apply.

### FR-5 — known_tenant_tables update

- `ci/checks/known_tenant_tables.txt` MUST have the following four table names added (one per line, alphabetical order maintained within the file): `department`, `employee`, `position`, `tenant`.
- The cross_tenant CI tests iterate over `KNOWN_TENANT_TABLES` and probe each one. All four new tables MUST pass the existing cross-tenant probes (AC-6).

### FR-6 — Dev fixture seeding (migrations)

- Migrations 013–016 MUST include a **dev-seed block** guarded by a check that prevents double-seeding in CI (e.g., `ON CONFLICT DO NOTHING`). The dev seed populates:
  - 1 `tenant` row matching the dev silo (id = a stable UUID, slug = `dev`).
  - The departments from the current `ORG_SEED` fixture: `fin` (Финансы), `cs` (Клиентский сервис), `plat` (Платформа).
  - The positions from the current fixture (9 positions across 3 departments).
  - All 10 employee entries from the current fixture (7 human + 3 agent), preserving their existing slug IDs. Service workers (`s-ledger`, `s-ocr`) seed as `kind = 'agent'`.
- Seeds are idempotent (`ON CONFLICT DO NOTHING`).

### FR-7 — `/api/org` seam

- After migration 016 is applied and the dev seed is present, `GET /api/org` MUST return data from the real Postgres tables, not the in-memory fixture.
- The response shape MUST remain compatible with the existing web frontend: `{ departments: [ { id, name, positions: [ { id, title, people: [ { id, name, type } ] } ] } ] }`. The field `type` in the response is the string representation of `employee.kind` (`"human"` or `"agent"`).
- `GET /api/org/employee/:id` MUST resolve from the real tables.
- `GET /api/users` (human-only list) MUST resolve from real tables (employees with `kind = 'human'`).
- The dev-auth `GET /api/me` path via `x-dev-user` header MUST continue to work, resolving against the real `employee` table (slug lookup).

---

## 3. Non-Functional Requirements

### NF-1 — T-0013 invariants (non-negotiable, inherited)

- All four tables: `tenant_id NOT NULL`, no default, leading PK column, leading column of every composite index and FK, FORCE RLS, default-DENY policy, accessed only via `choros.tenant_id` GUC `SET LOCAL` inside a transaction, by the `choros_app` role (`NOBYPASSRLS`).

### NF-2 — No orphaned FK paths

- `department.parent_id` FK is self-referential within the same tenant; the FK MUST include `tenant_id` in both sides: `FOREIGN KEY (tenant_id, parent_id) REFERENCES choros.department(tenant_id, id)`.
- `position.department_id` FK: `FOREIGN KEY (tenant_id, department_id) REFERENCES choros.department(tenant_id, id)`.
- `employee.position_id` FK (nullable): `FOREIGN KEY (tenant_id, position_id) REFERENCES choros.position(tenant_id, id)`.
- All FK paths are tenant-scoped, never crossing `tenant_id` boundaries.

### NF-3 — Single source of truth for executor identity

- After T-0017 is done, `src/http/org.ts` `ORG_SEED` is a **migration seed source only** — no runtime code path reads from it directly. The `findEmployee()` and `listSelectableUsers()` functions MUST be backed by real DB queries (via the existing DB client pattern in the codebase).

### NF-4 — Forward compatibility for T-0022 (assignment) and T-0020 (agent_card)

- `department.id` and `position.id` are the tree-node IDs used as `org_scope SET` values in `assignment` (T-0022). No renaming or re-keying is permitted after migrations are applied.
- `employee.id` is used by `agent_card(employee_id)` in T-0020. The PK shape `(tenant_id, id)` is fixed.

### NF-5 — Migration number compliance

- The four migrations MUST use file names `013_tenant.sql`, `014_department.sql`, `015_position.sql`, `016_employee.sql`. No other number range is permitted for this task.

---

## 4. Out of Scope

- `agent_card` columns (T-0020 / E5.1): the per-agent LLM endpoint, secret handle, autonomy threshold, budget policy ID, escalation rule ID.
- `role` and `assignment` tables (T-0022 / E3.2): assignment of employees to roles with org-scope.
- `actor_event` table (T-0019 / E4.1): the SoD event ledger; `employee.id` is the future `actor` FK target but the table is not built here.
- Flowable internal `ACT_ID_*` tables: Flowable has its own identity tables; Choros org structure is independent of them.
- Keycloak user provisioning (already done in T-0054): this task does NOT add Keycloak users; it creates the DB rows that match the already-existing Keycloak users.
- Multi-tenant pooled deployment: the seeding strategy here targets silo (N=1). Pooled multi-tenant provisioning is deferred per tenancy ADR.
- Deletion / soft-delete / archival of departments, positions, employees: no delete semantics are specified here. The architect may decide; constraints prevent orphan FKs.
- Position hierarchy within a department (positions as a tree): positions hang off departments, not off other positions. Any intra-department position hierarchy is out of scope.
- `tenant` table CRUD API: no `POST /api/tenants` etc. The tenant row is seeded by migration; runtime tenant provisioning is a future ops concern.

---

## 5. Acceptance Criteria

### DB-level criteria (test / fitness — require live Postgres)

**AC-1** — `tenant` is in `known_tenant_tables.txt`: the file contains the line `tenant`; the cross-tenant probe for `tenant` passes (context=dev-tenant → count ≥ 1; no-GUC → count 0).
*verifiable_as: test*

**AC-2** — `department` is in `known_tenant_tables.txt` and passes cross-tenant probe identically to AC-1.
*verifiable_as: test*

**AC-3** — `position` is in `known_tenant_tables.txt` and passes cross-tenant probe.
*verifiable_as: test*

**AC-4** — `employee` is in `known_tenant_tables.txt` and passes cross-tenant probe.
*verifiable_as: test*

**AC-5** — FORCE RLS enabled: for each of the four new tables, `pg_class.relrowsecurity = true` AND `pg_class.relforcerowsecurity = true`. Query as `choros_migrator` (bypasses RLS); then reconnect as `choros_app` (NOBYPASSRLS) without setting GUC → SELECT count = 0 for all four tables.
*verifiable_as: test*

**AC-6** — Cross-tenant isolation: cross_tenant.test.ts iterates `KNOWN_TENANT_TABLES`; after adding the 4 new tables, the test passes unmodified for all previously existing tables AND for all four new tables. Seed tenant-A and tenant-B rows in each new table via migrator URL; probe via app URL in tenant-A context → tenant-B rows = 0.
*verifiable_as: test*

**AC-7** — `tenant_id` leading column: `ci/checks/db/tenant_id_leading.sql` static check passes (or equivalent fitness function) — `tenant_id` is the first column in each table's definition AND the leading column of every index on each new table.
*verifiable_as: fitness*

**AC-8** — FK tenant-scoping: `department.parent_id` self-FK, `position.department_id` FK, and `employee.position_id` FK all include `tenant_id` on both sides (cross-tenant FK insert rejected by Postgres FK constraint).
*verifiable_as: test*

**AC-9** — Tree acyclicity: inserting a cycle in `department` (A.parent = B, B.parent = A) is rejected. The mechanism (DB trigger, check constraint, or application-layer pre-check documented in ADR) is an autonomous implementation choice; the rejection itself is the acceptance criterion.
*verifiable_as: test*

**AC-10** — `employee.kind` constraint: inserting `kind = 'robot'` (or any value outside `{human, agent}`) → CHECK constraint violation.
*verifiable_as: test*

**AC-11** — Dev seed idempotency: running the migrations twice (simulate with `ON CONFLICT DO NOTHING` re-run) produces exactly the same row count as running once. No duplicate rows, no error.
*verifiable_as: test*

**AC-12** — Employee slug uniqueness per tenant: inserting two employees with the same `(tenant_id, slug)` → unique constraint violation. Same slug in different tenants is allowed.
*verifiable_as: test*

### API / integration criteria (test)

**AC-13** — `GET /api/org` reads real tables: after migration 016 is applied and seeded, a call to `GET /api/org` (with `CHOROS_AUTH_MODE=dev`) returns a JSON body `{ departments: [...] }` where the department list matches the seeded data (≥ 3 departments; each has ≥ 1 position; each position has ≥ 1 employee). The in-memory `ORG_SEED` constant is NOT the source of the response.
*verifiable_as: test*

**AC-14** — `GET /api/org/employee/:id` resolves from DB: `GET /api/org/employee/e-kravtsova` returns 200 with `{ id: 'e-kravtsova', name: '...', type: 'human', ... }` backed by a real DB query. A non-existent ID returns 404.
*verifiable_as: test*

**AC-15** — `GET /api/users` returns only humans from DB: response contains only employees with `kind = 'human'`; no `kind = 'agent'` employee appears.
*verifiable_as: test*

**AC-16** — `GET /api/me` with `x-dev-user: e-kravtsova` resolves against real DB: returns 200 with identity matching the seeded employee row. An ID not in the DB returns 401.
*verifiable_as: test*

**AC-17** — Agent employees present in DB: the seeded employee table contains at least 3 rows with `kind = 'agent'` (matching the 3 original agent/service entries from the fixture: `a-recon`, `a-invoice`, `a-triage`); these rows are returned via `GET /api/org` under their respective positions; they do NOT appear in `GET /api/users` (humans only).
*verifiable_as: test*

### Static / fitness criteria

**AC-18** — No second actor-table: a static lint (grep or AST check) finds no second `employee`-equivalent table (e.g., no `human_employee`, `agent_employee`, `org_user`) in migrations 013–016. Agents and humans share one table.
*verifiable_as: fitness*

**AC-19** — `known_tenant_tables.txt` completeness: after T-0017 is merged, `ci/checks/known_tenant_tables.txt` contains exactly `{job, application, registry_def, record, audit_event, audit_head, grant, object_handle, tenant, department, position, employee}` (T-0116 additions are merged separately by orchestrator; this criterion covers only T-0017's additions).
*verifiable_as: fitness*

---

## 6. Blocking Questions

None. All design choices are resolvable from the GT-1-signed hypothesis (§5 object model, §3 Q7) and the existing T-0013/T-0018 foundations. The analyst confirms:

- Fixture-to-real-table seam: the `x-dev-user` dev-auth path continues to function via slug lookup against real tables — no new decision required.
- `service` type → `kind = 'agent'`: the hypothesis §5 lists `employee(kind ∈ {human,agent})` — exactly two values. Service workers (connectors) are automated actors; mapping them to `kind = 'agent'` is a direct consequence of the two-value constraint, not a new product decision.
- Migration numbers 013–016: frozen by orchestrator (T-0116 holds 011-012); no decision needed.
- The `tenant` table's own RLS (self-referential policy): the T-0013 pattern (`tenant_id = current_setting('choros.tenant_id', true)::uuid`) applies unmodified — when `tenant.id = current_setting(...)` the row is visible; absent GUC → 0 rows (default-DENY preserved).
