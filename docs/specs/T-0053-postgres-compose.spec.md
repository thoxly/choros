# T-0053 · Postgres-in-compose + idempotent migrations Spec

**Title:** E0.3 · Postgres service in docker-compose + idempotent migrations (engine DB + JSONB object-model)
**Task type:** architecture (approved GT-1)
**Status:** ready (no blocking questions)
**Authored:** 2026-06-10
**Authoritative sources (do NOT re-open):**
- `docs/design/stack-and-fleet-ops.md` (ratified founder 2026-06-10) — PostgreSQL 16, one instance per контур, schemas `ACT_*` (engine, Liquibase) + `choros_*` (core, our migrations).
- `docs/design/tenancy-and-delivery.md` §4 (multi-tenant-first), §9 (7 day-1 guards), §11 (priority).
- `CONCEPT.md` §6 (stack: Postgres = engine tables + JSONB object model), §11 (Postgres is the load-bearing bottleneck).
- Ratified design ADRs whose object model this task materializes: `T-0013` (tenant isolation), `T-0014` (registry model: `application`/`registry_def`/`record`), `T-0016` (audit floor: `audit_event`/`audit_head`), `T-0018` (`grant`), `T-0015` (object handles — `object_handle`).

---

## 0. Frozen seam (given by orchestrator — FE-0006/0007 — recorded as a constraint, NOT re-decided here)

The parallel sister task **T-0114** (`JobStore → Postgres`) is built on the seam below. This spec fixes it as a **given**; T-0053 owns and must deliver it exactly so T-0114 can build against it. Implementation MUST NOT alter the seam.

- **Migration catalog:** `migrations/` at the repo root; files named `NNN_<name>.sql`; applied in **lexicographic order** (`001_…` before `002_…`).
- **Migration runner:** a zero-dependency `node` script (owned by T-0053). Bookkeeping table `schema_migrations(version text primary key, applied_at timestamptz)`. **Idempotency = already-applied versions are skipped.**
- **T-0053 owns:** `docker-compose.yml` (a `postgres:16` service, dev creds via env), the runner, **baseline migrations `001`–`009`**, wiring Postgres into CI (`.github/workflows/ci.yml`), and **adding the `pg` dependency to `package.json` (the SINGLE place it is ever added).**
- **T-0114 owns:** migrations from `010_` onward, its own store code; it does NOT touch `docker-compose.yml` / the runner / `package.json`; it connects via the `DATABASE_URL` env var.

---

## 1. Summary

T-0053 is the **infrastructure task that materializes the Postgres substrate** every prior Choros design ADR (T-0013/14/15/16/18) was written against. It delivers: (a) a `postgres:16` service in `docker-compose.yml` with dev credentials supplied via environment; (b) a zero-dependency Node **migration runner** with `schema_migrations` bookkeeping and skip-applied idempotency; (c) the **baseline `choros_*` schema** as ordered SQL migrations `001`–`009`, encoding the **already-ratified object model** (the JSONB object model of CONCEPT §6 — `application`/`registry_def`/`record`, plus the work queue, audit floor, grant authority, and object-handle tables) with the **full T-0013 §3.1 tenant-table convention baked in from migration #1** (tenant_id NOT NULL leading PK, scoped uniqueness, FORCE RLS + default-DENY, leading-column indexes/FKs); (d) the **DB roles and database/schema readiness** the design requires — the non-owner / non-superuser / non-BYPASSRLS app role, the separate migrator/owner role, and the `ACT_*` schema/role readiness for a future Flowable (the engine itself is NOT installed here); (e) the **CI gate** that stands up Postgres, runs all migrations, **re-runs them to prove idempotency**, and runs the migration suite with **≥2 tenants** present (the anti-decorative-`tenant_id` guard, tenancy §9 guard 5).

This is the substrate that flips the prior ADRs' `live-T-0053` fitness functions from "authored, not yet wired" to "live and gating". The deployment shape is **silo** (one tenant per instance); server deploy stays founder-gated (E0.7, out of scope here).

---

## 2. Scope boundary

T-0053 builds **infrastructure**: the compose Postgres service, the migration mechanism, the baseline `choros_*` schema (including the JSONB object model over the existing ratified domain types), `ACT_*` readiness (database/roles/schema creation; **Flowable itself is NOT installed in this task**), and the CI gate running migrations with ≥2 tenants.

What T-0053 does **not** decide and is free to delegate to DESIGN/BUILD (autonomous per red-lines — "СУБД-детали, индексация, compose"): the exact `NNN_<name>.sql` file split across `001`–`009`, per-column DDL spelling, index choices, the precise compose service options (volume/healthcheck/port), and the runner's internal structure. This spec fixes **WHAT** must hold and the **machine-checkable acceptance criteria**, not the **HOW**.

---

## 3. Functional Requirements

### FR-1 · Postgres service in docker-compose

- `docker-compose.yml` MUST exist at the repo root and define a service running **PostgreSQL 16**.
- Connection parameters (host, port, db name, user, password) MUST be supplied via **environment variables** with **dev (non-prod) defaults**; no prod credential is committed (RL-1).
- The service MUST come up to a ready/accepting-connections state unattended (so CI and the runner can connect without manual steps).

### FR-2 · Idempotent migration runner (zero-dep Node)

- A migration runner implemented as a **zero-dependency Node script** (only Node builtins + the `pg` client) MUST apply every `migrations/NNN_<name>.sql` in **lexicographic order**.
- The runner MUST maintain a bookkeeping table **`schema_migrations(version text primary key, applied_at timestamptz)`** and record each applied version.
- **Idempotency:** running the runner a second time (no new files) MUST apply **zero** additional migrations and leave the schema and `schema_migrations` unchanged. Already-recorded versions are skipped.
- The runner connects via the **`DATABASE_URL`** env var (the seam T-0114 also uses), running as the **migrator/owner** role.
- A migration failure MUST abort the run non-zero (no partial bookkeeping for a file whose SQL did not fully apply).

### FR-3 · Baseline `choros_*` schema (migrations 001–009) — ratified object model only

- The baseline migrations MUST create the `choros_*` core tables whose object model is **already ratified** in a signed ADR, and ONLY those (no table for an undesigned entity):
  - the **work queue** `job` table (T-0013 §3.2 / stack ADR — successor of the in-memory `JobStore`);
  - the **JSONB object model** of CONCEPT §6: `application`, `registry_def` (carries `record_schema jsonb`), `record` (carries `data jsonb`) per T-0014 §3;
  - the **audit floor** `audit_event` (append-only, hash-chained) and `audit_head` per T-0016 §3;
  - the **grant authority** `grant` table per T-0018 §4;
  - the **object-handle** addressing table `object_handle` per T-0015 (the persisted addressing id `object_handle.id` referenced by `ObjectHandle.handleId`).
- Tables whose object model is **NOT yet designed** (e.g. `role` / `assignment` — T-0017/T-0022, undesigned at authoring time) MUST NOT be created in the baseline, and no baseline table may carry a **foreign key to a non-existent table**. Where a ratified table's ADR names an FK to an undesigned table (e.g. `grant.role_id → role`), that FK is **deferred** to the migration that creates the referenced table (a later task), and its absence in the baseline MUST NOT block migration apply. This avoids a forward-reference that cannot resolve.
- Each baseline table MUST be a valid SQL artifact that applies cleanly on an empty PostgreSQL 16 instance via the runner.

### FR-4 · T-0013 tenant-table convention on every tenant table (from migration #1)

Every tenant-owned baseline table (all of FR-3 except none — all listed are tenant tables) MUST, **structurally in the DDL**, satisfy the T-0013 §3.1 convention:

- `tenant_id uuid NOT NULL` with **no default**, as the **leading column of the primary key**, of **every composite index**, and of **every composite foreign key**.
- All business-key uniqueness is **scoped**: `UNIQUE (tenant_id, <business_key>)`, never on `<business_key>` alone (e.g. `application (tenant_id, slug)`, `registry_def (tenant_id, application_id, slug)`).
- `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`.
- A single **default-DENY** posture: with no permissive policy no rows are visible/modifiable; access granted only by one permissive policy keyed on the transaction-local GUC `current_setting('choros.tenant_id', true)` (the GUC spelling fixed by T-0013 ADR §3.5) for both `USING` and `WITH CHECK`.

### FR-5 · DB roles provisioned (app role vs migrator/owner role)

- A migration (or the compose init path) MUST provision two distinct DB roles:
  - **`choros_app`** — `NOSUPERUSER`, **`NOBYPASSRLS`**, **not the owner** of any tenant table; granted only the DML it needs per table (`SELECT/INSERT/UPDATE/DELETE`, except `audit_event` which is `SELECT/INSERT` only per T-0016 §3.1); **no DDL**. This is the runtime connection role.
  - **`choros_migrator`** — owns the tenant tables, holds DDL, runs migrations; **never used at runtime**.
- The app role MUST be the role the application is expected to connect as (the runtime `DATABASE_URL` resolves to `choros_app`; the runner uses `choros_migrator`).

### FR-6 · `ACT_*` engine-schema readiness (NOT Flowable itself)

- The substrate MUST be **ready for a future Flowable** to own its `ACT_*` tables on the **same single Postgres instance** (stack ADR §1): i.e. the database exists and a role/schema arrangement is in place such that Flowable's own Liquibase migrations could create `ACT_*` without colliding with `choros_*`.
- **Flowable itself (the engine container, its Liquibase run, BPMN deploy) is explicitly NOT installed or run in T-0053** — that is E0.5, founder-gated (S-1). This FR is satisfied by leaving room (separate schema/role boundary), not by standing up the engine.

### FR-7 · CI gate: migrations run, are idempotent, and pass with ≥2 tenants

- CI (`.github/workflows/ci.yml`) MUST stand up a Postgres 16 service, run the runner against an empty DB (all migrations apply), **run the runner again** (idempotency — zero new applications), and run a **multi-tenant migration check** that seeds **≥2 distinct `tenant_id`** values into the tenant tables and asserts no unique-constraint violation / no cross-tenant merge (tenancy §9 guard 5; the anti-decorative-`tenant_id` guard).
- This new CI work MUST integrate with the existing pipeline (`npm run ci`) such that the gate is **integration-honest** (D-056): green on the task branch ⇒ green on `dev` (the DB job pins its own Postgres service; tests do not depend on ambient build state; test discovery excludes `.claude/worktrees/**`).
- Adding the `pg` dependency to `package.json` is done **only here** (the single place per the frozen seam).

---

## 4. Non-Functional Requirements

### NF-1 · Zero-dependency runner

The migration runner adds **no dependency** beyond the `pg` client (which itself is the single added dep). No migration framework (Flyway/Liquibase for `choros_*`, ORM, etc.). Plain SQL files + Node, consistent with the repo's zero-dep core discipline and the stack ADR (our `choros_*` migrations are ours, not Liquibase — Liquibase is Flowable's for `ACT_*` only).

### NF-2 · Structural isolation, not discipline

Tenant isolation in the baseline schema MUST be a **structural property of the DDL** (NOT NULL + scoped uniqueness + FORCE RLS + non-BYPASSRLS app role), reproducing T-0013 NF-2: bypassing it requires a deliberate, CI-visible schema change, not a forgotten `WHERE`.

### NF-3 · Silo / pooled single code-path

One schema, one set of migrations, one RLS code-path for silo (N=1) and future pooled (N>1). No migration branch keyed on deployment mode (tenancy NF-1).

### NF-4 · Reproducible, unattended bring-up

`docker compose up` + the runner MUST bring a working, fully-migrated DB up from nothing with **no manual SQL** — this is also the dev environment and the basis of every silo deploy.

### NF-5 · Dev/prod credential separation

Only **non-prod** credentials appear in the repo/compose defaults. Prod credentials are founder-held (RL-1) and injected at deploy time (E0.7); this task commits none.

---

## 5. Out of Scope

1. **Installing / running Flowable** (the `ACT_*` engine container, its Liquibase migrations, BPMN deploy) — E0.5, founder-gated (S-1). T-0053 leaves `ACT_*` room only (FR-6).
2. **`JobStore → Postgres` store code and migrations `010_`+** — owned by the sister task **T-0114**; T-0053 provides the substrate + the `job` baseline table, not the store rewrite.
3. **Keycloak service / realm** — E0.4. Per-request `iss/aud/tenant-claim` validation logic is T-0013/identity tasks, not this infra task.
4. **`role` / `assignment` tables** (T-0017/T-0022) and any table whose object model is not yet a ratified ADR — explicitly excluded from the baseline (FR-3).
5. **Server provisioning / prod deploy** (`/srv/choros`, Tailscale) — E0.7, founder-gated (GT-4). No server is touched.
6. **The unified `docker-compose: dev + prod` stack** wiring core + Keycloak + Flowable together — E0.6. T-0053 adds the Postgres service only.
7. **PgBouncer / connection pooling, partitioning, archival, history-cleanup** — later scaling stages (stack ADR S1+); not built now.
8. **The application's `withTenant` runtime wrapper and live RLS-probe tests authored by T-0013** — T-0053 supplies the DB so those `live-T-0053` checks can run; writing the application wrapper is T-0114/identity tasks. T-0053 delivers the DB-side acceptance (FR-4/FR-5/FR-7), not the TS runtime API.

---

## 6. Acceptance Criteria

All ACs are CI-checkable (`test` = a CI test against the live Postgres service; `fitness` = a CI fitness/lint script; `manual` = a documented manual check). Tenant-table assertions iterate over the maintained known-tenant-tables CI fixture.

---

**AC-1** — compose defines a Postgres 16 service that comes up ready
```
manual/test: `docker compose up -d <pg-service>` (or the CI service container) reaches
an accepting-connections state; `SELECT version();` reports PostgreSQL 16.x.
Connection params come from env with dev defaults (no committed prod secret).
```
`verifiable_as: test`

**AC-2** — runner applies all migrations on an empty DB
```
test: against an empty Postgres 16, run the migration runner. Exit code 0.
Every file in migrations/ has a row in schema_migrations(version,...).
All baseline choros_* tables (FR-3 list) exist.
```
`verifiable_as: test`

**AC-3** — runner is idempotent (re-run applies nothing)
```
test: run the runner a second time with no new files. Exit 0; the count of rows
in schema_migrations is unchanged; no DDL re-executed (re-run does not error on
already-existing objects). Diff of schema_migrations before/after = empty.
```
`verifiable_as: test`

**AC-4** — bookkeeping table shape is exactly the frozen seam
```
test: schema_migrations has columns (version text PRIMARY KEY, applied_at timestamptz).
Inserting a duplicate version raises a primary-key violation.
```
`verifiable_as: test`

**AC-5** — every baseline tenant table has FORCE RLS enabled
```
test: SELECT relname FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid
  WHERE relkind='r' AND relname = ANY($known_tenant_tables)
    AND NOT (relrowsecurity AND relforcerowsecurity);
Result set MUST be empty.
```
`verifiable_as: test`

**AC-6** — default-DENY: no tenant context ⇒ 0 rows from the app role
```
test: as choros_app, with NO `SET LOCAL choros.tenant_id`, seed rows (via migrator),
then `SELECT count(*)` on each tenant table MUST be 0.
```
`verifiable_as: test`

**AC-7** — tenant_id is the leading column of every composite index and FK on tenant tables
```
fitness: ci/checks/tenant_id_leading.sql (or equiv) — for each multi-column index
(pg_index) and FK (pg_constraint contype='f') on a known tenant table, the column at
position 1 MUST be tenant_id. Any violation = build failure.
```
`verifiable_as: fitness`

**AC-8** — scoped uniqueness holds; same business key allowed across tenants, forbidden within one
```
test: insert (tenant-A, slug='X') into application → ok; (tenant-B, slug='X') → ok;
(tenant-A, slug='X') again → unique-constraint violation. (Run as migrator to bypass
RLS for the cross-tenant seed.)
```
`verifiable_as: test`

**AC-9** — tenant_id NOT NULL enforced at the DB layer
```
test: as choros_migrator, insert a row with tenant_id = NULL into any tenant table →
NOT NULL constraint violation.
```
`verifiable_as: test`

**AC-10** — app role lacks BYPASSRLS and superuser; is not a table owner
```
test: connect as choros_app; SELECT rolbypassrls, rolsuper FROM pg_roles
  WHERE rolname = current_user; MUST be (f, f).
Also: choros_app is NOT the owner of any table in $known_tenant_tables
  (pg_class.relowner != choros_app's oid for every tenant table).
```
`verifiable_as: test`

**AC-11** — migrator/owner role is separate and owns the tenant tables
```
test: every known tenant table is owned by choros_migrator (pg_class.relowner =
choros_migrator oid). choros_migrator holds DDL; choros_app does not (a CREATE TABLE
as choros_app MUST fail with insufficient privilege).
```
`verifiable_as: test`

**AC-12** — app role has only the intended DML; audit_event is SELECT/INSERT-only for app
```
test: choros_app can SELECT/INSERT/UPDATE/DELETE on a regular tenant table within
tenant context; choros_app's UPDATE or DELETE on audit_event MUST fail with
insufficient privilege (T-0016 §3.1). choros_app has no DDL grant.
```
`verifiable_as: test`

**AC-13** — migrations are idempotent AND consistent with ≥2 tenants (anti-decorative tenant_id)
```
test (blocking, tenancy §9 guard 5): after applying all migrations, seed ≥2 distinct
tenant_id values into the tenant tables; re-run the full migration suite. Assert: no
unique-constraint violation, no scoped-uniqueness degeneration to global, no implicit
cross-tenant merge. This is the guard that catches any constraint that silently
becomes global when N=1.
```
`verifiable_as: test`

**AC-14** — no baseline table references an undesigned (non-existent) table
```
fitness/test: every FK in the baseline schema (pg_constraint contype='f') resolves to a
table that the baseline also creates. No FK targets role/assignment or any table not in
the baseline set. (Confirms FR-3 forward-reference rule: migrations apply with no
dangling FK target.)
```
`verifiable_as: test`

**AC-15** — JSONB object-model columns are present and typed jsonb
```
test: registry_def.record_schema is jsonb NOT NULL; record.data is jsonb NOT NULL;
audit_event.payload is jsonb NOT NULL; grant scope column is jsonb (per T-0018 §4).
(Confirms the CONCEPT §6 "JSONB object model" is materialized, not stubbed.)
```
`verifiable_as: test`

**AC-16** — ACT_* readiness without installing Flowable
```
test/manual: a role/schema boundary exists such that Flowable's Liquibase could create
ACT_* on the same instance without colliding with choros_* (e.g. a dedicated schema or
role grant). Flowable is NOT installed: no ACT_* table exists after T-0053 migrations
(SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'act\_%' = 0).
```
`verifiable_as: test`

**AC-17** — CI is integration-honest with the Postgres service
```
test: the ci workflow runs a Postgres 16 service, runs the runner + idempotency re-run
+ the ≥2-tenant check, and `npm run ci` stays green. The DB job pins its own Postgres
(no ambient dependency); test discovery excludes `.claude/worktrees/**` (D-056).
```
`verifiable_as: test`

**AC-18** — `pg` dependency added exactly once, in package.json
```
fitness: package.json declares `pg` as a dependency. No other manifest/lockfile in the
repo adds a Postgres client (the single-place seam). Runner imports only Node builtins +
`pg`.
```
`verifiable_as: fitness`

---

## 7. Open Items (non-blocking — implementer awareness)

These are tracked for DESIGN/BUILD; none require a founder decision before implementation begins (they are autonomous СУБД/compose/indexing details per red-lines).

- **File split across `001`–`009`:** the exact mapping of tables to the nine baseline migration files (one table per file vs. grouped, where role provisioning lives) is the architect/coder's call. The constraint is only: 9 ordered files, lexicographic apply, the FR-3 table set present, no dangling FK.
- **Role provisioning location:** whether `choros_app` / `choros_migrator` are created by a `00x_roles.sql` migration, by a compose init script, or by an env-driven entrypoint — implementation choice, as long as AC-10/11/12 hold and prod creds stay founder-held.
- **`ACT_*` boundary mechanism:** dedicated schema vs. dedicated role grant for the future Flowable — implementer's choice (AC-16 is the only constraint).
- **Known-tenant-tables CI fixture:** AC-5/6/7/14 iterate over a maintained list; every future migration that adds a tenant table must append to it. Implementation convention, not a design ambiguity.
- **`grant.role_id` FK deferral:** the FK to `role` is added by the later migration that creates `role` (T-0022); the baseline `grant` table carries the `role_id uuid NOT NULL` column without the cross-table FK (AC-14). The architect confirms this is the intended deferral, not a missing constraint.

---

## 8. Blocking questions

**None.** The high-leverage forks this task touches are all already founder-ratified: the stack (PostgreSQL 16, one instance, `ACT_*` + `choros_*`, Flowable-as-infra) in `stack-and-fleet-ops.md` (2026-06-10); multi-tenant-first + the 7 day-1 guards + silo-now in `tenancy-and-delivery.md` (§4/§9/§11, GT-1 2026-06-08); the JSONB object model in `CONCEPT.md` §6. The object model of every baseline table is fixed by a ratified ADR (T-0013/14/15/16/18). The frozen seam (catalog, runner, ownership split) is set by the orchestrator. Everything left open is a СУБД/indexing/compose detail delegated to implementation (DESIGN/BUILD), which red-lines mark as autonomous — not a founder gate.
