# ADR · T-0017 — Org Structure: tenant, department (tree), position, employee

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-10
**Task:** E3.1 — `tenant`, `department` (adjacency-list tree), `position`, `employee(kind ∈ {human, agent})`
**Spec:** `docs/specs/T-0017-org-structure.spec.md` (status: ready, AC-1..AC-19)
**Foundation (do NOT contradict):**
- `docs/design/T-0013-tenant-isolation.adr.md` — tenant_id leading, FORCE RLS, default-DENY, `choros_app` NOBYPASSRLS, `SET LOCAL` contract
- `docs/design/T-0115-tenant-rls.adr.md` — `ci/checks/known_tenant_tables.txt` is the RLS CI invariant; new tenant tables MUST be added
- `docs/design/T-0054-keycloak-compose.adr.md` — Keycloak realm users by `preferred_username`; employee slugs MUST match fixture IDs
- `docs/design/T-0018-grant-authority.adr.md` — `grant.role_id` will FK to `role(tenant_id, id)` in T-0022; `employee.id` will be the FK target for `assignment`

**Siblings built after this, not here:**
- T-0020 (E5.1) — `agent_card(employee_id, …)` thin extension; `kind=agent` rows are seeded here
- T-0022 (E3.2) — `role`, `assignment(employee_id, role_id, org_scope SET, …)` first consumer of `employee.id`
- T-0019 (E4.1) — `actor_event.actor` references `employee.id`

---

## 1. Decision

**Adopt adjacency-list tree for `department`, a single `employee` table polymorphic on `kind ∈ {human,agent}`, a dev-seed migration block seeded from the canonical `ORG_SEED` fixture, and a DB-backed access layer `src/db/org.ts` behind the existing HTTP route surface.**

### 1.1 Tree mechanism for `department`

Chosen: **adjacency-list** (`parent_id uuid NULL FK → department(tenant_id, id)`).

Rationale: the spec pins `parent_id` explicitly (FR-2), depth is unbounded but practically shallow (≤5 levels expected), the workload is read-heavy/write-rare (org chart changes infrequently), and the codebase already uses raw SQL with `pg` (NF-4: no ORM). Closure-table or `ltree` would add either a multi-row write protocol (closure) or a Postgres extension (ltree) — both are over-engineering for a structure that is queried depth-first or in-full by the HTTP layer. A recursive CTE (`WITH RECURSIVE`) is available when subtree traversal is needed (T-0022 org-scope resolution); this is autonomous implementation detail. Cycle prevention (AC-9) is an application-layer pre-insert check (path ancestry walk); a DB-level cycle trigger is an autonomous improvement — the spec allows either.

### 1.2 Employee polymorphism

One `employee` table with `kind text NOT NULL CHECK (kind IN ('human', 'agent'))`. No `human_employee` or `agent_employee` tables. The `service` type in the current fixture maps to `kind = 'agent'` (both are automated actors; the finer AI-vs-connector distinction is deferred to `agent_card`, T-0020). This is the spec invariant (FR-4, §6 analyst decision).

### 1.3 Seed source

The existing `ORG_SEED` constant in `src/http/org.ts` is the canonical fixture; it is **transcribed verbatim** into the migration dev-seed block (`ON CONFLICT DO NOTHING`). No UUID generation at seed-time for employee slugs — the slugs themselves (`e-kravtsova`, `a-recon`, etc.) serve as the idempotency key via the `(tenant_id, slug)` unique constraint. Department and position IDs are stable UUIDs generated once and hardcoded in the migration (idempotent).

### 1.4 Access layer placement

New module `src/db/org.ts` containing async DB query functions (`listOrgTree`, `findEmployeeById`, `listHumanEmployees`). The existing route registration functions in `src/http/org.ts` and `src/http/auth.ts` are updated to call `src/db/org.ts` when `DATABASE_URL` is set (Postgres path), falling back to the in-memory `ORG_SEED` when not (dev-no-db path). The public export symbols `findEmployee` and `listSelectableUsers` in `src/http/org.ts` are **preserved** (same signatures, same callers: `src/http/auth.ts`, `src/http/inbox.ts`) — they become thin wrappers that delegate to the DB layer. This satisfies FE-W23-0008: no frozen-test symbol deletion.

### 1.5 Test seam breakages owned by coder

Three existing test files have hardcoded counts that T-0017 changes:

| File | Current value | New value after T-0017 | Fix |
|---|---|---|---|
| `ci/checks/db/two_tenant.test.ts` line 58 | `expect(n).toBe(10)` | 16 (T-0116 adds 2, T-0017 adds 4) | update to dynamic: read from `schema_migrations` or assert `>= 16` |
| `ci/checks/db/schema.test.ts` lines 144–148 | exactly 2 FK pairs | 5 new FK pairs added (department→tenant, department.parent→department, position→department, employee→position; `tenant` has no FK) | update to assert a superset not equality — either `.toEqual(expect.arrayContaining([...]))` or expand the expected array |
| `ci/checks/db/cross_tenant.test.ts` `seedRowForTable` switch | no cases for 4 new tables | needs 4 new `case` branches (tenant, department, position, employee) with correct FK-order seeding | additive `case` blocks |

The `coder` MUST fix these three seams as part of the BUILD phase. This ADR documents them as known break points, not as escalation items.

---

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| **ltree extension for department tree** | Requires `CREATE EXTENSION ltree` — non-standard Postgres; tests must run on vanilla PG. Adjacency-list + recursive CTE is zero-extension and sufficient for the expected depth (≤5). |
| **Closure-table for department tree** | Requires additional `department_closure(ancestor, descendant)` table and multi-row transactional writes on every department mutation. Adds schema complexity without benefit at expected scale. Adjacency-list is proportional. |
| **Separate `human_employee` + `agent_employee` tables** | Violates the spec invariant (FR-4, §6 analyst decision); doubles the join surface for T-0022 assignment; the finer distinction (AI vs connector) belongs in `agent_card` (T-0020). Rejected by spec. |
| **Storing employee kind as a boolean `is_human`** | Less extensible than `kind text CHECK`; if a third kind is ever needed, a boolean becomes a migration; text CHECK is explicit. `CHECK (kind IN ('human', 'agent'))` is the spec-mandated shape. |
| **Seeding via a separate seed script (not in migration)** | The spec explicitly pins seeds inside migrations 013-016 (`ON CONFLICT DO NOTHING`); a separate script creates a second bring-up path (violates NF-4 one-path principle from T-0053). Seeds stay in migrations. |
| **New DB module under `src/core/` (alongside pgJobStore)** | `src/core/` holds domain logic and store abstractions. The org queries are HTTP-layer I/O, not domain logic. `src/db/` is the correct layer for DB query modules backing HTTP routes (parallel to `src/core/postgres/` for job-domain queries). |
| **Generating UUIDs for employee IDs (replacing slugs)** | Breaks the Keycloak JWT → employee resolution chain (T-0054: `employee.slug = jwt.preferred_username`). The spec freezes slugs as `id` values in the DB. Employee `id` in the DB is a UUID; the `slug` field is the human-readable key used by Keycloak. |
| **`position` as a tree (positions hang off other positions)** | Explicitly out of scope per spec §4. Positions hang off departments only. |

---

## 3. Object model

### 3.1 `tenant` table

| Field | Type | Constraints |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | Leading PK column. **Special**: equals `id` — the tenant row IS the tenant root |
| `id` | `uuid NOT NULL` | PK is `(tenant_id, id)` where `tenant_id = id` by definition |
| `slug` | `text NOT NULL` | UNIQUE globally (tenants don't share slugs) |
| `display_name` | `text NOT NULL` | — |
| `created_at` | `bigint NOT NULL` | epoch-ms |

RLS policy: `USING (id = current_setting('choros.tenant_id', true)::uuid)` — the tenant row is visible iff its `id` matches the GUC. Default-DENY preserved.

> **Note on `tenant_id = id`**: the `tenant` table is self-anchoring. `tenant_id` is still the leading PK column (satisfying the T-0013 convention); it equals `id` for every row. This is by design: the convention is a structural invariant, not a relational invariant requiring a circular FK.

### 3.2 `department` table

| Field | Type | Constraints |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | Leading PK column, FK → `tenant(tenant_id, id)` |
| `id` | `uuid NOT NULL` | PK is `(tenant_id, id)` |
| `parent_id` | `uuid NULL` | FK → `department(tenant_id, id)` (self-ref, same tenant); NULL = root |
| `slug` | `text NOT NULL` | UNIQUE `(tenant_id, slug)` |
| `display_name` | `text NOT NULL` | — |
| `created_at` | `bigint NOT NULL` | epoch-ms |
| `updated_at` | `bigint NOT NULL` | epoch-ms |

FK constraint bodies: `FOREIGN KEY (tenant_id, id) REFERENCES choros.tenant(tenant_id, id)` (on `tenant_id`) and `FOREIGN KEY (tenant_id, parent_id) REFERENCES choros.department(tenant_id, id)` (self-ref). Cycle guard: application-layer check (ancestor walk before INSERT/UPDATE parent_id).

### 3.3 `position` table

| Field | Type | Constraints |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | Leading PK column |
| `id` | `uuid NOT NULL` | PK is `(tenant_id, id)` |
| `department_id` | `uuid NOT NULL` | FK → `department(tenant_id, id)` |
| `slug` | `text NOT NULL` | UNIQUE `(tenant_id, department_id, slug)` |
| `title` | `text NOT NULL` | — |
| `created_at` | `bigint NOT NULL` | epoch-ms |
| `updated_at` | `bigint NOT NULL` | epoch-ms |

FK constraint: `FOREIGN KEY (tenant_id, department_id) REFERENCES choros.department(tenant_id, id)`.

### 3.4 `employee` table

| Field | Type | Constraints |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | Leading PK column |
| `id` | `uuid NOT NULL` | PK is `(tenant_id, id)` |
| `position_id` | `uuid NULL` | FK → `position(tenant_id, id)`, nullable (agents may be unassigned) |
| `kind` | `text NOT NULL` | `CHECK (kind IN ('human', 'agent'))` |
| `slug` | `text NOT NULL` | UNIQUE `(tenant_id, slug)`; = Keycloak `preferred_username` for humans |
| `display_name` | `text NOT NULL` | — |
| `created_at` | `bigint NOT NULL` | epoch-ms |
| `updated_at` | `bigint NOT NULL` | epoch-ms |

FK constraint: `FOREIGN KEY (tenant_id, position_id) REFERENCES choros.position(tenant_id, id)`.

### 3.5 Dev seed values (from `ORG_SEED`)

**Tenant row:** `{ id: <DEV_TENANT_UUID>, tenant_id: <DEV_TENANT_UUID>, slug: 'dev', display_name: 'Dev Silo' }`. The `DEV_TENANT_UUID` is a stable hardcoded UUID in the migration (e.g. `'a0000000-0000-0000-0000-000000000001'`).

**Departments (3):** fin / cs / plat — stable UUIDs hardcoded in migration, slugs matching fixture.

**Positions (8):** fin-ctrl, fin-appr, fin-cfo, cs-l1, cs-l2, plat-int, plat-svc — stable UUIDs, slugs matching fixture.

**Employees (10):** 7 human + 3 agent (fixture `type:agent` and `type:service` both → `kind='agent'`).

| Slug | Kind | Position slug |
|---|---|---|
| e-kravtsova | human | fin-ctrl |
| a-recon | agent | fin-ctrl |
| a-invoice | agent | fin-appr |
| e-mironov | human | fin-appr |
| e-larina | human | fin-cfo |
| a-triage | agent | cs-l1 |
| e-orlov | human | cs-l1 |
| e-savina | human | cs-l1 |
| e-petrov | human | cs-l2 |
| e-belov | human | plat-int |
| s-ledger | agent | plat-svc |
| s-ocr | agent | plat-svc |

> Note: ORG_SEED has 10 employees (7 human + 3 named agents + 2 service workers = 12 total). Re-counting: `e-kravtsova, e-mironov, e-larina, e-orlov, e-savina, e-petrov, e-belov` = 7 human; `a-recon, a-invoice, a-triage` = 3 agents; `s-ledger, s-ocr` = 2 service. Total = 12 employees seeded.

### 3.6 Access-layer module `src/db/org.ts`

```typescript
// Exported async functions (backed by pg Pool from DATABASE_URL):
listOrgTree(pool: Pool, tenantId: string): Promise<OrgDepartment[]>
findEmployeeById(pool: Pool, tenantId: string, slug: string): Promise<(OrgPerson & { position: string; department: string }) | null>
listHumanEmployees(pool: Pool, tenantId: string): Promise<Array<{ id: string; name: string; position: string; department: string }>>
```

The `pool` is threaded from the server startup (same pool as job store), or a dedicated pool if `DATABASE_URL` is set and the job store is in-memory. Fall-back: when `DATABASE_URL` is absent, callers continue to use the `ORG_SEED` path in `src/http/org.ts` — no regression for dev-without-db.

### 3.7 `src/http/org.ts` compatibility contract

The following exported symbols MUST be preserved with identical TypeScript signatures (callers: `src/http/auth.ts`, `src/http/inbox.ts`):

```typescript
export function findEmployee(employeeId: string): OrgPerson & { position: string; department: string } | null
export function listSelectableUsers(): Array<{ id: string; name: string; position: string; department: string }>
export function registerOrgRoutes(router: Router, _store?: JobStore): void
```

Under migration 016 + seed present, `findEmployee` and `listSelectableUsers` delegate to `src/db/org.ts` (async, called via `await`). The signatures become async-internally but the existing synchronous contract for the in-memory path (no `DATABASE_URL`) is preserved. The HTTP route handlers are already async so the await boundary is transparent to callers. `inbox.ts` uses `findEmployee` to annotate `mine` — it receives a resolved value, no signature breakage.

---

## 4. Migration plan (013–016)

### Migration 013 — `tenant` table

```sql
CREATE TABLE choros.tenant (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL,
  slug       text NOT NULL,
  display_name text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (slug)
);
ALTER TABLE choros.tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON choros.tenant
  USING (id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (id = current_setting('choros.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON choros.tenant TO choros_app;
-- Dev seed
INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
VALUES ('<DEV_TENANT_UUID>', '<DEV_TENANT_UUID>', 'dev', 'Dev Silo', 0)
ON CONFLICT DO NOTHING;
```

### Migration 014 — `department` table

Creates `department` with self-referential FK. Dev seed: 3 root department rows (fin/cs/plat).

### Migration 015 — `position` table

Creates `position` with FK to `department`. Dev seed: 8 position rows.

### Migration 016 — `employee` table

Creates `employee` with FK to `position` (nullable). Dev seed: 12 employee rows (7 human, 5 agent). At this point the org data is live in the DB and `GET /api/org` MUST switch to reading from tables.

All four migrations follow the T-0013 pattern: `ENABLE`/`FORCE ROW LEVEL SECURITY`, `default-DENY` policy body, `GRANT SELECT INSERT UPDATE DELETE TO choros_app`, seeds guarded by `ON CONFLICT DO NOTHING`.

---

## 5. API seam

After migration 016 is applied:

| Route | Before T-0017 | After T-0017 |
|---|---|---|
| `GET /api/org` | `ORG_SEED` in-memory | DB query via `src/db/org.ts:listOrgTree` |
| `GET /api/org/employee/:id` | `findEmployee(id)` from `ORG_SEED` | `findEmployeeById(pool, tenantId, id)` from DB |
| `GET /api/users` | `listSelectableUsers()` from `ORG_SEED` | `listHumanEmployees(pool, tenantId)` from DB |
| `GET /api/me` (dev-auth) | `findEmployee(id)` from `ORG_SEED` | `findEmployeeById(pool, tenantId, id)` from DB |

Response shape is **backwards-compatible** with the web frontend:
```json
{ "departments": [ { "id": "fin", "name": "Финансы", "positions": [ { "id": "fin-ctrl", "title": "...", "people": [ { "id": "e-kravtsova", "name": "...", "type": "human" } ] } ] } ] }
```
`type` in the JSON response = `employee.kind` from DB (`"human"` or `"agent"`).

The dev-tenant GUC is set from `process.env.DEV_TENANT_ID` (defaulting to the hardcoded seed UUID) before org DB queries. This follows the `SET LOCAL` contract (T-0013).

---

## 6. Fitness functions

### FF-ORG-1 — FORCE RLS on all four new tables

**Rule:** `tenant`, `department`, `position`, `employee` all have `relrowsecurity AND relforcerowsecurity = true`.
**CI check:** `ci/checks/db/schema.test.ts` `FF-RLS` describe-block already iterates `KNOWN_TENANT_TABLES` (dynamic); adding the 4 tables to `known_tenant_tables.txt` automatically covers them. Zero new test code required for this fitness function.

### FF-ORG-2 — `known_tenant_tables.txt` completeness

**Rule:** after T-0017, `ci/checks/known_tenant_tables.txt` contains exactly the 12 tables: `job`, `application`, `registry_def`, `record`, `audit_event`, `audit_head`, `grant`, `object_handle`, `tenant`, `department`, `position`, `employee` (T-0116 adds its own 2; orchestrator merges additive).
**CI check:** `ci/checks/db/schema.test.ts` `FF-RLS` "no choros base table missing from fixture" test — static grep or exact-match vitest assertion. `coder` updates the file; CI verifies no unknown table exists in the DB without a corresponding entry in the txt file.

### FF-ORG-3 — `tenant_id` leading column on all FK constraints from new tables

**Rule:** `department → tenant`, `department.parent → department`, `position → department`, `employee → position` — all FK constraints have `tenant_id` as the first key column.
**CI check:** `ci/checks/db/schema.test.ts` `FF-LEAD` "every composite FK on a tenant table leads with tenant_id" — already iterates `KNOWN_TENANT_TABLES`. Automatic once the 4 tables are in the txt file.

### FF-ORG-4 — FK pairs updated in `schema.test.ts`

**Rule:** `schema.test.ts` `FF-FK-RESOLVE` "Exactly the two designed FKs" assertion is a known breakage point. After T-0017 the set of FK pairs is: `record→registry_def`, `registry_def→application`, `department→tenant`, `department→department` (self-ref via parent_id), `position→department`, `employee→position`.
**CI check:** `coder` updates the `expect(pairs).toEqual(...)` assertion to the full 6-element sorted array. This is a BUILD-phase fix, not a design change.

### FF-ORG-5 — `two_tenant.test.ts` migration count updated

**Rule:** `expect(n).toBe(10)` in `two_tenant.test.ts` becomes `expect(n).toBe(16)` (or `>= 16`) after migrations 011-016 are applied. The spec notes T-0116 holds 011-012 and T-0017 holds 013-016; total = 16 from migration files 001-016.
**CI check:** `coder` updates the hardcoded count assertion to `toBe(16)` as a BUILD-phase fix.

### FF-ORG-6 — `cross_tenant.test.ts` seed coverage for new tables

**Rule:** `seedRowForTable` must have `case` branches for `tenant`, `department`, `position`, `employee` with correct FK-order seeding (tenant before department, department before position, position before employee).
**CI check:** `coder` adds the 4 `case` branches (additive). AC-6 (cross-tenant probe passes for all `KNOWN_TENANT_TABLES`) will fail until these are added.

### FF-ORG-7 — No second actor-table

**Rule:** No migration file in 013-016 creates a table named `human_employee`, `agent_employee`, `org_user`, or any variant other than `employee`.
**CI check:** `grep -E 'CREATE TABLE.*_employee|CREATE TABLE.*org_user' migrations/01[3-6]_*.sql` → zero matches. Add to `npm run fitness:static`.

### FF-ORG-8 — Employee kind CHECK constraint enforced

**Rule:** `INSERT INTO choros.employee (... kind ...) VALUES (... 'robot' ...)` rejects with PG error code `23514` (check constraint violation).
**CI check:** `ci/checks/db/` — new test file `org-structure.test.ts` (owned by coder/tester) with AC-10 assertion. Or as additional `describe` block in `behavior.test.ts`.

### FF-ORG-9 — Dev seed idempotency

**Rule:** Running migrations twice (runner called twice) produces the same row count for all four new tables. No unique constraint error on re-run.
**CI check:** `ci/checks/db/two_tenant.test.ts` `FF-2: runner is idempotent` — already tests re-run. Since seeds use `ON CONFLICT DO NOTHING`, this test covers idempotency automatically once the migration count assertion is updated.

### FF-ORG-10 — `GET /api/org` reads real tables after migration 016

**Rule:** After applying migrations and dev seed, `GET /api/org` response is NOT served from `ORG_SEED` constant (the constant may still exist as a migration-seed source but must not be the live HTTP response source).
**CI check:** `src/__tests__/org.e2e.test.ts` currently tests structure/counts — update `AC-3` assertion to also check `departments.length >= 3` from DB. Add a new `describe` block that verifies `ORG_SEED` is not directly serialised (e.g., compare `departments[0].id` against the known DB-generated value, not the in-memory string). Alternatively: set up a dedicated `org-structure.e2e.test.ts` using a real DB connection (in the `db` CI job, not the unit job).

### FF-ORG-11 — Tenant-scoped FK cross-tenant rejection

**Rule:** An INSERT into `department` with a `tenant_id` that doesn't match the FK target `tenant(tenant_id, id)` is rejected by Postgres (FK violation). Same for `position → department` and `employee → position`.
**CI check:** New test in `org-structure.test.ts` (or `behavior.test.ts`): insert a department row for TENANT_A referencing TENANT_B's tenant row → FK violation (error code `23503`).

### FF-ORG-12 — `org.ts` public exports preserved (FE-W23-0008)

**Rule:** `findEmployee`, `listSelectableUsers`, and `registerOrgRoutes` remain exported from `src/http/org.ts` with unchanged TypeScript signatures. Frozen callers (`src/http/auth.ts`, `src/http/inbox.ts`) continue to import from `./org.js` without modification.
**CI check:** TypeScript compilation (`npm run build` / `tsc --noEmit`) — type error if signature changes. Additionally: `grep "from './org'" src/http/auth.ts src/http/inbox.ts` still resolves — static check.

---

## 7. Traceability

| AC | Covered by |
|---|---|
| AC-1 | `known_tenant_tables.txt` + FF-ORG-2; schema.test.ts FF-RLS iterates dynamically |
| AC-2 | same as AC-1 for `department` |
| AC-3 | same as AC-1 for `position` |
| AC-4 | same as AC-1 for `employee` |
| AC-5 | FF-ORG-1; schema.test.ts FF-RLS checks ENABLE+FORCE; behavior.test.ts FF-DENY covers default-DENY |
| AC-6 | FF-ORG-6; cross_tenant.test.ts with 4 new seed cases |
| AC-7 | FF-ORG-3; schema.test.ts FF-LEAD iterates all KNOWN_TENANT_TABLES |
| AC-8 | FF-ORG-11; new behavioral test cross-tenant FK rejection |
| AC-9 | §1.1 cycle guard (app-layer pre-insert check); FF-ORG-8 (behavioral test for AC-9) |
| AC-10 | FF-ORG-8; `CHECK (kind IN ('human', 'agent'))` DDL constraint |
| AC-11 | FF-ORG-9; seeds use `ON CONFLICT DO NOTHING`; two_tenant.test.ts idempotency re-run |
| AC-12 | UNIQUE `(tenant_id, slug)` on employee; existing FF-SCOPE pattern in behavior.test.ts |
| AC-13 | §5 API seam; FF-ORG-10; org.e2e.test.ts updated |
| AC-14 | §5 API seam; `GET /api/org/employee/:id` backed by `findEmployeeById` from DB |
| AC-15 | §5 API seam; `GET /api/users` backed by `listHumanEmployees` with `kind='human'` filter |
| AC-16 | §5 API seam; `GET /api/me` dev-auth slug lookup against real `employee` table |
| AC-17 | §3.5 seed (5 agents: a-recon, a-invoice, a-triage, s-ledger, s-ocr); `GET /api/users` excludes agents |
| AC-18 | FF-ORG-7; grep check on migration files 013-016 |
| AC-19 | FF-ORG-2; `known_tenant_tables.txt` exact-set check in schema.test.ts |

---

## 8. Runtime target

Postgres in the silo docker-compose stack (T-0053, running). The `choros_app` role (NOBYPASSRLS, non-owner) executes org queries via `SET LOCAL choros.tenant_id` inside transactions. The dev-seed tenant UUID is hardcoded in migration 013; in production, the tenant row is provisioned at silo-setup time (founder-gated GT-4, out of scope here). No new infrastructure beyond what T-0053 already provisions.
