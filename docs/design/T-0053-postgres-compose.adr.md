# ADR · T-0053 — Postgres-in-compose + idempotent migrations (the choros_* substrate)

**Phase:** DESIGN · **Status:** ready (no founder escalation) · **Date:** 2026-06-10
**Task:** E0.3 — Postgres service in docker-compose + zero-dep idempotent migration runner + baseline `choros_*` schema (001–009) + DB roles + `ACT_*` readiness + integration-honest CI gate.
**Spec (input):** `docs/specs/T-0053-postgres-compose.spec.md` + `docs/specs/T-0053.spec.contract.json` (status: ready; FR-1..FR-7, NF-1..NF-5, AC-1..AC-18; no blocking questions).
**Authoritative sources (consumed, NOT re-decided):**
- `docs/design/stack-and-fleet-ops.md` (ratified founder 2026-06-10) — PostgreSQL 16, **one instance per контур**, schemas `ACT_*` (engine, Flowable's Liquibase) + `choros_*` (core, **our** migrations); `ACT_*` is **not** RLS-covered (degenerate in silo; pooled is red-line-blocked).
- `docs/design/tenancy-and-delivery.md` §4 (multi-tenant-first), §9 (7 day-1 guards), §11 (silo-now).
- Ratified object-model ADRs this task **materializes verbatim**: `T-0013` (tenant convention, GUC `choros.tenant_id`, role split), `T-0014` (`application`/`registry_def`/`record`), `T-0015` (`object_handle`), `T-0016` (`audit_event`/`audit_head` — **supersedes** T-0013 §3.3 `audit_log`), `T-0018` (`grant`).
- Existing domain code (frozen public surface — FE-W23-0008): `src/core/types.ts` (`Job`/`JobState`), `src/core/jobStore.ts`, `src/core/grant-lattice.ts`, `src/core/object-handle.ts`.

> **This ADR designs the substrate; it does not write the migrations.** It pins the
> compose shape, the runner contract, the exact baseline table set + the schema/role layout,
> the `ACT_*` boundary mechanism, the cut-line against the T-0114 sister task, and the
> fitness functions (live-DB probes + lints) that flip every upstream ADR's `live-T-0053`
> functions from "authored" to "gating". The per-column DDL spelling, the 001–009 file
> split, index choices, and compose service options (volume/healthcheck/port) are
> autonomous SUBD/compose details delegated to BUILD (spec §2, red-lines), constrained only
> by the ACs and this ADR's invariants. The `coder` and `tester` read §3–§6 as the source
> of truth.

---

## 1. Decision

Deliver the Choros Postgres substrate as **(a) one `postgres:16` service in a repo-root
`docker-compose.yml`** with all connection parameters (host/port/db/user/password) supplied
via environment variables carrying **dev-only defaults** (no prod secret committed; RL-1),
a healthcheck so bring-up is unattended; **(b) a zero-dependency Node migration runner**
(`migrations/run.mjs`, Node builtins + the `pg` client only) that applies every
`migrations/NNN_<name>.sql` in **lexicographic order** inside a per-file transaction,
records each applied file in `schema_migrations(version text primary key, applied_at
timestamptz)`, **skips already-recorded versions** (idempotency), aborts non-zero on any
SQL failure with **no bookkeeping row for a file that did not fully apply**, and connects via
`DATABASE_URL` as the **migrator/owner** role; **(c) the baseline `choros_*` schema as the
nine ordered migrations 001–009**, materializing ONLY the already-ratified object model —
`job`, `application`, `registry_def`, `record`, `audit_event`, `audit_head`, `grant`,
`object_handle` — each carrying the **full T-0013 §3.1 tenant-table convention from
migration #1** (`tenant_id uuid NOT NULL` no default as leading PK column / leading column
of every composite index & FK, scoped uniqueness, `ENABLE`+`FORCE ROW LEVEL SECURITY`,
default-DENY policy keyed on `current_setting('choros.tenant_id', true)`), plus the T-0016
append-only triggers; **(d) two DB roles** — `choros_app` (`NOSUPERUSER`, `NOBYPASSRLS`,
non-owner, per-table DML only, `audit_event` = `SELECT,INSERT` only, no DDL) and
`choros_migrator` (owns the tables, holds DDL, runs migrations, never used at runtime) —
provisioned by **migration `001`** (the first ordered file); **(e) `ACT_*` readiness as a
schema boundary** — our tables live in a dedicated **`choros` schema** owned by
`choros_migrator`, leaving the `ACT_*` namespace free for a future Flowable's own Liquibase
on the **same instance** without collision (Flowable is **NOT** installed here); and **(f)
an integration-honest CI gate** — a `db` job in `.github/workflows/ci.yml` that stands up a
pinned `postgres:16` service, runs the runner against an empty DB, **re-runs it to prove
idempotency**, then runs a **≥2-tenant** seed-and-assert suite plus the live RLS/role/FK
fitness probes — with `pg` added to `package.json` **exactly here** (the single place per
the frozen seam).

The mechanism is deliberately **proportional** (rubric axis 5): plain SQL files + ~120 lines
of Node, no migration framework (no Flyway/Liquibase for `choros_*`; Liquibase is Flowable's,
for `ACT_*` only — NF-1), no ORM, no pooling/partitioning machinery (deferred, spec §5).
The thin core is the runner + `schema_migrations`; everything else is plain DDL the upstream
ADRs already specified, enforced by the fitness functions of §6.

### 1.1 Schema layout — the load-bearing resolution (`choros` schema, not `public`)

The upstream ADRs' live RLS probes were authored against `n.nspname='public'` (illustrative,
written before this infra task). The stack ADR fixes the real layout: **`ACT_*` (Flowable)
and `choros_*` (ours) coexist on one instance.** This ADR resolves that into a concrete,
collision-proof boundary: **all baseline tables are created in a dedicated `choros` schema**
(owned by `choros_migrator`), and `ACT_*` is left to Flowable's Liquibase (which by default
creates `ACT_*`-prefixed tables; whether it targets `public` or its own schema is Flowable's
config in E0.5, out of scope). The runner sets `search_path = choros` for our migrations and
`schema_migrations` itself lives in `choros`. Consequently **every live RLS/leading-column
probe in §6 parametrizes on `nspname = 'choros'`, not `'public'`** — this supersedes the
illustrative `'public'` in T-0013 FF-2 / T-0014 / T-0016 (a probe-target detail, not an
isolation-model change; the isolation semantics are identical). `choros_app` is granted
`USAGE` on the `choros` schema and per-table DML only — never `CREATE` on any schema (no DDL).

This is an autonomous SUBD detail (spec §2 / red-lines) and is fixed here as the single
source of truth so the live probes and the `known_tenant_tables` fixture agree.

### 1.2 The `grant.role_id` forward-reference (founder-finding confirmation — FR-3/AC-14)

**Confirmed, architecturally, as the intended deferral — not a missing constraint.** The
ratified `grant` ADR (T-0018 §4.1) names `role_id` with an FK
`(tenant_id, role_id) → role(tenant_id, id)`, but `role`/`assignment` (T-0017/T-0022) are
**undesigned at authoring time** — no ratified ADR fixes their object model. The baseline
(001–009) therefore materializes `grant.role_id uuid NOT NULL` as a plain column **carrying
no cross-table FK**. Rationale:

1. **A forward-reference FK cannot resolve.** `REFERENCES role(...)` in a baseline migration
   would fail to apply on an empty DB because `role` does not exist — it would break AC-2
   (clean apply) outright. FR-3 is explicit: "no baseline table may carry a foreign key to a
   non-existent table."
2. **The column, not the FK, is the ratified contract.** T-0018 fixes that a grant's
   principal is a `role_id uuid NOT NULL` (the value-shape and not-null floor are the
   contract the resolver T-0021 consumes); the *referential* integrity to `role` is a
   property the later `role`-creating migration (T-0022) adds via
   `ALTER TABLE choros.grant ADD CONSTRAINT … FOREIGN KEY (tenant_id, role_id) REFERENCES
   choros.role(tenant_id, id)`. Deferring the FK to that migration is **additive** and
   CI-visible, and does not weaken the baseline (the NOT NULL floor still holds today).
3. **AC-14 is the guard.** A live/fitness probe asserts every baseline FK
   (`pg_constraint contype='f'`) resolves to a table the baseline also creates, and that no
   FK targets `role`/`assignment`. This makes the deferral structural: if a future baseline
   edit ever adds a dangling FK, CI fails.

This decision is recorded so T-0022 knows the FK is **its** to add, and so no reviewer reads
the missing FK as an omission. (`grant` keeps `tenant_id`-leading and scoped uniqueness; only
the cross-table `role` FK is deferred — the `record→registry_def` and `registry_def→
application` FKs, whose targets the baseline *does* create, are present in 001–009.)

### 1.3 The `job` table cut-line vs T-0114 (frozen-seam resolution — orchestrator finding)

The spec includes `job` in the FR-3 baseline list (T-0013 §3.2), while T-0114
(`JobStore→Postgres`) "owns its own store code" and migrations `010_`+. The seam says
T-0053 owns `001`–`009` and the `job` *table* is in scope; T-0114 owns the *store rewrite*
(the TS code that reads/writes `job`) and any **later** schema evolution from `010_`. **This
ADR resolves the cut cleanly: T-0053's baseline creates the full `job` table DDL** (the
T-0013 §3.2 columns + tenant convention + RLS), because (a) the spec explicitly lists it in
FR-3, (b) it is a ratified-model table (T-0013 §3.2), and (c) the ≥2-tenant CI guard (AC-13)
needs a populated tenant table set including `job`. **T-0114 does NOT re-create or duplicate
the `job` DDL**; it adds only its store code and, if it needs schema changes (new index,
column), an **additive `010_`+ migration** — never a baseline edit. The runner's
lexicographic, skip-applied contract guarantees T-0114's `010_` merges **additively**: it
appends after `009`, the runner applies only the new file, and `schema_migrations` gains one
row — no conflict with the baseline. This is the "designed so the sister's merge is additive"
requirement, satisfied by the catalog convention itself.

> If, at BUILD, a column on `job` is genuinely owned by the T-0114 store design (e.g. a
> lock-token shape the store needs), the rule is: **baseline creates the table with exactly
> the T-0013 §3.2 columns**; any column beyond that ratified set is a T-0114 `010_` additive
> migration, never smuggled into the baseline. No "minimal stub" is needed — the §3.2 column
> set is fully ratified and self-sufficient.

---

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| **A migration framework (Flyway / Liquibase / node-pg-migrate) for `choros_*`** | Adds a heavyweight runtime/CLI dependency and a second migration dialect, violating NF-1 (zero-dep, `pg` is the only added dep) and the repo's zero-dep core discipline. The stack ADR reserves Liquibase for **Flowable's `ACT_*`** only; our `choros_*` migrations are plain SQL + a ~120-line Node runner. A framework buys nothing the `schema_migrations`-skip contract doesn't already give for a linear, append-only catalog. |
| **All tables in `public` (matching the upstream ADRs' illustrative probes)** | `public` is where Flowable's Liquibase defaults its objects; sharing it invites `ACT_*`/`choros_*` collision and muddies the `choros_app` grant surface (it would inherit `public`'s default privileges). A dedicated `choros` schema (§1.1) is the clean `ACT_*`-readiness boundary (FR-6) and lets `choros_app` get `USAGE` on exactly one schema. The `'public'` in upstream probes was illustrative; re-targeting to `'choros'` is a probe detail, not a model change. |
| **Materialize `audit_log` (T-0013 §3.3) AND `audit_event`/`audit_head`** | T-0016 §1 **supersedes** the `audit_log` placeholder: there is exactly one audit table family (`audit_event` + `audit_head`). Creating `audit_log` too would be a second append-only/chain/isolation code-path — the drift T-0016 §2 forbids. Baseline creates `audit_event`+`audit_head` **only**; `audit_log` is never created, and is absent from `known_tenant_tables`. |
| **Add the `grant.role_id → role` FK in the baseline (or omit `role_id` entirely)** | Adding the FK fails to apply (no `role` table — breaks AC-2/AC-14); omitting the column breaks the T-0018 ratified contract (the resolver T-0021 reads `role_id`). The correct shape (§1.2): keep `role_id uuid NOT NULL` as a plain column, defer the FK to T-0022's migration. |
| **Provision roles via a compose entrypoint script / `POSTGRES_INITDB` only** | Then role existence is a property of the container image bootstrap, invisible to the migration history and un-rerunnable against an already-initialized DB (e.g. a managed Postgres in prod where the container entrypoint never ran). Provisioning roles in **migration `001`** (idempotent `DO $$ … CREATE ROLE IF NOT EXISTS-equivalent … $$`) makes the role layout part of the same ordered, skip-applied, CI-replayed history as the schema — one bring-up path (NF-4), portable to any Postgres. (Dev passwords for the roles come from env defaults; prod passwords are injected at deploy, RL-1.) |
| **Runner applies all files in one big transaction** | A single failure would roll back *all* prior files, and a long catalog couldn't be partially advanced; worse, some DDL (e.g. `CREATE DATABASE`, certain `ALTER SYSTEM`) cannot run in a transaction. Per-file transaction (each `NNN_*.sql` in its own `BEGIN…COMMIT`, bookkeeping row inserted in the **same** transaction as the file's SQL) gives atomic per-file apply + accurate `schema_migrations` (FR-2: no bookkeeping for a partially-applied file) and lets the catalog advance file-by-file. |
| **Idempotency via `CREATE TABLE IF NOT EXISTS` in every migration (no `schema_migrations`)** | `IF NOT EXISTS` silences re-runs but loses the applied-history record, can't detect a *changed* file, and doesn't generalize to non-idempotent statements (data seeds, `ALTER`). The frozen seam mandates `schema_migrations`-skip; idempotency = "already-recorded versions are skipped" (the runner never re-executes an applied file), which is robust regardless of statement idempotency. |
| **Install Flowable / create `ACT_*` tables now to "prove" readiness** | Out of scope (E0.5, founder-gated S-1). FR-6 readiness = leaving the `ACT_*` namespace free + the schema boundary, **not** standing up the engine. AC-16 asserts zero `ACT_*` tables exist after T-0053 migrations. |
| **Commit prod credentials / a `.env` with real secrets** | RL-1 / NF-5: only non-prod defaults appear in the repo; prod creds are founder-held and injected at deploy (E0.7). Compose reads `${POSTGRES_PASSWORD:-choros_dev_pw}`-style env with dev defaults; no real secret is committed. |

None reopen a founder-ratified fork; the stack (PG16, one instance, `ACT_*`+`choros_*`,
Flowable-as-infra), the tenancy model (RLS-everywhere, silo-now), and every baseline table's
object model are already ratified. These are the standard infra alternatives, recorded for
traceability.

---

## 3. Object model (what the baseline materializes — DDL is BUILD's, this is the contract)

All eight baseline tables are **T-0013 tenant tables** in the **`choros` schema**: each
inherits the §3.1 convention verbatim (`tenant_id uuid NOT NULL` no default, leading PK
column, leading column of every composite index/FK; `ENABLE`+`FORCE ROW LEVEL SECURITY`;
one default-DENY policy keyed on `current_setting('choros.tenant_id', true)::uuid` for both
`USING` and `WITH CHECK`; scoped uniqueness). That convention is **not** restated per table;
the per-table column sets are fixed by the ratified ADRs cited and reproduced here as the
single coder-facing list. Postgres types authoritative.

### 3.1 Infrastructure entities (T-0053-owned, not a tenant table)

| Entity | Fields | Notes |
|---|---|---|
| `schema_migrations` | `version text PRIMARY KEY`, `applied_at timestamptz NOT NULL DEFAULT now()` | Runner bookkeeping (frozen seam). In `choros` schema. **Not** a tenant table (no `tenant_id`, no RLS) — it is migration metadata, not tenant data; excluded from `known_tenant_tables`. Duplicate `version` ⇒ PK violation (AC-4). |
| `choros_app` (DB role) | `NOSUPERUSER`, `NOBYPASSRLS`, not owner of any table; `USAGE` on schema `choros`; per-table DML grants (`audit_event` = `SELECT,INSERT` only; `audit_head` = `SELECT,INSERT,UPDATE`, no `DELETE`); **no DDL / no CREATE**. Runtime connection role. | Provisioned in migration `001` (idempotent). Prod password injected at deploy (RL-1). |
| `choros_migrator` (DB role) | Owns `choros` schema + all baseline tables; holds DDL; runs the runner; never used at runtime. Postgres superuser (`rolsuper=true`, `rolbypassrls=true`) — RLS does not filter it. Runtime isolation is enforced on `choros_app` (`NOSUPERUSER`, `NOBYPASSRLS`), which cannot escalate to `choros_migrator`. | Provisioned in migration `001`. `DATABASE_URL` for the runner resolves to this role. |

### 3.2 Tenant tables (the FR-3 ratified set — exactly these eight, no more)

| Table | Source ADR | Key columns (beyond the T-0013 convention) | Scoped uniqueness | FKs (composite, tenant_id-leading) | JSONB cols |
|---|---|---|---|---|---|
| `job` | T-0013 §3.2 | `topic text NOT NULL`, `variables jsonb NOT NULL`, `state text NOT NULL` (`CREATED\|LOCKED\|COMPLETED\|FAILED`), `retries int NOT NULL`, `lock_owner text NULL`, `lock_expiry bigint NULL`, `created_at bigint NOT NULL` | PK `(tenant_id, id)` | none | `variables` |
| `application` | T-0014 §3.1 | `slug text NOT NULL`, `display_name text NOT NULL`, `description text NULL`, `created_at bigint NOT NULL`, `updated_at bigint NOT NULL` | `UNIQUE (tenant_id, slug)` | none | — |
| `registry_def` | T-0014 §3.2 | `application_id uuid NOT NULL`, `slug text NOT NULL`, `display_name text NOT NULL`, `description text NULL`, `record_schema jsonb NOT NULL`, `is_system boolean NOT NULL DEFAULT false`, `created_at`, `updated_at` | `UNIQUE (tenant_id, application_id, slug)` | `(tenant_id, application_id) → application(tenant_id, id)` | `record_schema` |
| `record` | T-0014 §3.3 | `registry_id uuid NOT NULL`, `data jsonb NOT NULL`, `created_at`, `updated_at`, `created_by text NOT NULL` | none (identity `(tenant_id,id)`) | `(tenant_id, registry_id) → registry_def(tenant_id, id)` | `data` |
| `audit_event` | T-0016 §3.1 | `seq bigint NOT NULL`, `type text NOT NULL`, `actor text NOT NULL`, `subject text NULL`, `scope jsonb NULL`, `via text NULL`, `proposed_by text NULL`, `confirmed_by text NULL`, `payload jsonb NOT NULL`, `occurred_at bigint NOT NULL`, `prev_hash bytea NOT NULL`, `row_hash bytea NOT NULL`, `vocab_version smallint NOT NULL` | PK `(tenant_id, seq)`; `UNIQUE (tenant_id, id)` | none | `scope`, `payload` |
| `audit_head` | T-0016 §3.2 | PK `(tenant_id)` (one row/tenant); `seq bigint NOT NULL`, `row_hash bytea NOT NULL`, `updated_at bigint NOT NULL`, `vocab_version smallint NOT NULL` | PK `(tenant_id)` | none | — |
| `grant` | T-0018 §4.1 | `role_id uuid NOT NULL` (**no FK — §1.2 deferral**), `resource_type text NOT NULL`, `resource_facet jsonb NULL`, `operation text NOT NULL`, `scope jsonb NOT NULL`, `constraint jsonb NULL`, `delegable boolean NOT NULL DEFAULT true`, `granted_by text NOT NULL`, `valid_from bigint NULL`, `valid_until bigint NULL`, `created_at bigint NOT NULL` | PK `(tenant_id, id)` | none in baseline (`role_id` FK deferred to T-0022) | `resource_facet`, `scope`, `constraint` |
| `object_handle` | T-0015 §4.1 | `ref_kind text NOT NULL` (`application\|registry\|record`), `application_id uuid NULL`, `registry_id uuid NULL`, `record_id uuid NULL`, `facet jsonb NULL`, `created_at bigint NOT NULL`; **no payload/data column** | PK `(tenant_id, id)` | none (component UUIDs are denormalized refs, not FKs — they point at T-0014 rows but T-0015 §4.1 fixes them as nullable components, not FK-enforced) | `facet` |

- **PK is always `(tenant_id, id)`** except `audit_event` (PK `(tenant_id, seq)`, plus
  `UNIQUE (tenant_id, id)`) and `audit_head` (PK `(tenant_id)`).
- **`grant` is a reserved word in SQL** — the table MUST be quoted (`"grant"`) or the coder
  MAY choose the table name `grant` quoted consistently; the `known_tenant_tables` fixture
  records the actual `relname` (`grant`). (Autonomous spelling detail; flagged so BUILD
  quotes it.)
- **`audit_event` / `audit_head` append-only triggers** (T-0016 §4.6) are part of the
  baseline: `audit_event_no_update`/`audit_event_no_delete` (no-mutate, all roles),
  `audit_head_advance` (forward-only `+1`), `audit_head_no_delete_trg` (no head delete).
  These are DDL the migration emits; their behavior is fitness-checked (FF-9).

### 3.3 The `known_tenant_tables` CI fixture (T-0053 **creates** it — upstream contract)

Every upstream ADR (T-0013 FF-2, T-0014 FF-1, T-0015 FF-A7, T-0016 FF-12, T-0018 FF-A7)
references `ci/checks/known_tenant_tables.txt` as a maintained fixture but none created it
(they are design-only). **T-0053 creates it**, listing exactly the eight tenant tables of
§3.2 (one `relname` per line):

```
job
application
registry_def
record
audit_event
audit_head
grant
object_handle
```

It deliberately excludes `schema_migrations` (infra metadata, not tenant data). This single
fixture is what folds all eight tables into every live RLS/leading-column/default-DENY probe
(§6). **Convention (FR-3 open item):** every future migration adding a tenant table MUST
append its `relname` here; FF-RLS fails on any FORCE-RLS-less `choros`-schema table not in
the list (anti-decorative guard, T-0013 §6 wiring).

---

## 4. Contracts

### 4.1 Migration runner (`migrations/run.mjs` — the frozen-seam runner)

```
// Zero-dep: imports only `node:*` builtins + `pg`. No framework.
// Connects via DATABASE_URL (resolves to choros_migrator). search_path = choros.
//
// 1. Ensure choros schema + schema_migrations(version text PK, applied_at timestamptz) exist
//    (CREATE SCHEMA/TABLE IF NOT EXISTS — the ONLY pre-bookkeeping idempotent step).
// 2. SELECT version FROM schema_migrations  ->  appliedSet.
// 3. List migrations/NNN_*.sql, sort LEXICOGRAPHICALLY (001 < 002 < ... < 010 < ...).
// 4. For each file whose `version` (the filename, or its NNN_<name> stem) NOT in appliedSet:
//      BEGIN;
//        run the file's SQL;
//        INSERT INTO schema_migrations(version) VALUES ($1);   // same txn as the SQL
//      COMMIT;
//    On any error: ROLLBACK that file's txn, print the failing file + error, exit(1).
//    => no schema_migrations row for a file whose SQL did not fully apply (FR-2).
// 5. Files already in appliedSet are SKIPPED (no re-execution) — idempotency (FR-2/AC-3).
// 6. Exit 0 when all pending files applied (or none pending).
//
// `version` key = the full filename stem (e.g. "001_roles_and_schema"), lexicographically
// ordered, so T-0114's "010_*" appends additively after the baseline (§1.3).
```

**Invariants the runner guarantees (asserted by FF, not by "the code is correct"):** exit 0
on clean apply with every file recorded (AC-2); a second run applies zero files and leaves
`schema_migrations` byte-identical (AC-3); a failing file aborts non-zero with no partial
bookkeeping (FR-2). The runner does **no** application logic — it only applies SQL + records
versions.

### 4.2 Compose service (`docker-compose.yml` — dev substrate)

```
services:
  postgres:                      # postgres:16
    image: postgres:16
    environment:                 # ALL via env with dev defaults; NO committed prod secret
      POSTGRES_DB:       ${POSTGRES_DB:-choros}
      POSTGRES_USER:     ${POSTGRES_USER:-choros_migrator}     # bootstrap = migrator/owner
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-choros_dev_pw}   # DEV default only (RL-1)
    ports: ["${POSTGRES_PORT:-5432}:5432"]
    healthcheck:                 # pg_isready -> unattended ready state (FR-1, NF-4)
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-choros_migrator} -d ${POSTGRES_DB:-choros}"]
      interval: 2s  timeout: 3s  retries: 30
    volumes: [ "choros_pgdata:/var/lib/postgresql/data" ]
volumes: { choros_pgdata: {} }
```

The runtime app's `DATABASE_URL` resolves to **`choros_app`** (created by migration `001`);
the runner's `DATABASE_URL` resolves to **`choros_migrator`** (the bootstrap superuser of the
container creates `choros_migrator` as owner — or the bootstrap user *is* `choros_migrator`,
coder's choice as long as AC-10/11 hold). Compose options (volume name, port mapping,
healthcheck timing) are autonomous (spec §2).

### 4.3 Role & grant layout (migration `001`, idempotent)

```sql
-- All in migration 001 (the first ordered file), idempotent (CREATE ... IF NOT EXISTS-equiv
-- via DO blocks); prod passwords injected at deploy, not committed (RL-1).
CREATE SCHEMA IF NOT EXISTS choros AUTHORIZATION choros_migrator;
-- choros_migrator: owner (created by container bootstrap or here); holds DDL.
-- choros_app: runtime role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='choros_app') THEN
    CREATE ROLE choros_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
      PASSWORD '...dev-default-or-env...';
  END IF;
END $$;
GRANT USAGE ON SCHEMA choros TO choros_app;            -- USAGE only, never CREATE
-- Per-table DML grants emitted by each table's migration (e.g.):
--   GRANT SELECT,INSERT,UPDATE,DELETE ON choros.application TO choros_app;
--   GRANT SELECT,INSERT               ON choros.audit_event TO choros_app;  -- append-only
--   GRANT SELECT,INSERT,UPDATE        ON choros.audit_head  TO choros_app;  -- no DELETE
-- choros_app is NEVER the owner; choros_migrator owns every table (default for the creator).
```

`choros_app` connection contract: `rolbypassrls = false`, `rolsuper = false`, not table
owner (T-0013 §4.2). The runtime app connects only as `choros_app`; the runner only as
`choros_migrator`.

### 4.4 ACT_* readiness (FR-6 — boundary, not engine)

Readiness = **the `choros` schema isolates our tables so Flowable's Liquibase can create
`ACT_*` on the same instance without colliding**. Concretely: (1) our tables are namespaced
in `choros`, not `public`; (2) `choros_app` has `USAGE` on `choros` only, so a future
Flowable role/schema is orthogonal; (3) no `ACT_*` table is created here (AC-16). The exact
boundary mechanism (a dedicated `flowable` schema + role, or letting Flowable own `public`)
is E0.5's call — T-0053 only guarantees `choros_*` does not occupy the `ACT_*` namespace and
the instance has room. Flowable, its Liquibase, and BPMN deploy are **not** run (S-1).

---

## 5. Traceability (AC-1..AC-18 → design)

| AC | Covered by |
|---|---|
| AC-1 (PG16 service ready, env dev defaults) | §4.2 compose + healthcheck · **FF-1** |
| AC-2 (runner applies all on empty DB) | §4.1 runner · §3.2 baseline set · **FF-2** |
| AC-3 (idempotent re-run) | §4.1 skip-applied · **FF-2** |
| AC-4 (schema_migrations shape + PK) | §3.1 `schema_migrations` · **FF-3** |
| AC-5 (FORCE RLS on every tenant table) | §3 convention · §3.3 fixture · **FF-RLS** |
| AC-6 (default-DENY: no context ⇒ 0 rows from app) | §3 default-DENY policy · §4.3 `choros_app` · **FF-DENY** |
| AC-7 (tenant_id leading on composite index & FK) | §3 convention · §3.2 FKs · **FF-LEAD** |
| AC-8 (scoped uniqueness across/within tenant) | §3.2 `UNIQUE(tenant_id,…)` · **FF-SCOPE** |
| AC-9 (tenant_id NOT NULL at DB layer) | §3 convention · **FF-SCOPE** |
| AC-10 (app role no BYPASSRLS/super, not owner) | §3.1 `choros_app` · §4.3 · **FF-ROLE** |
| AC-11 (migrator owns tables + holds DDL; app CREATE fails) | §3.1 `choros_migrator` · §4.3 · **FF-ROLE** |
| AC-12 (app DML scoped; audit_event UPDATE/DELETE fails; no DDL) | §3.1/§4.3 per-table grants · §3.2 audit append-only · **FF-ROLE / FF-APPEND** |
| AC-13 (idempotent AND ≥2 tenants, anti-decorative) | §4.1 runner · §3.2 tenant tables · **FF-2TENANT** (tenancy §9 guard 5) |
| AC-14 (no FK to undesigned table; all FKs resolve) | §1.2 `role_id` deferral · §3.2 FK set · **FF-FK-RESOLVE** |
| AC-15 (JSONB cols present & typed jsonb) | §3.2 JSONB column list · **FF-JSONB** |
| AC-16 (ACT_* readiness; zero ACT_* tables) | §1.1 / §4.4 schema boundary · **FF-ACT** |
| AC-17 (CI integration-honest with PG service) | §6 CI wiring (`db` job, pinned service) · **FF-CI** |
| AC-18 (pg added exactly once; runner imports only builtins+pg) | §1 single add · §4.1 runner imports · **FF-PG-ONCE** |

Every AC-1..AC-18 maps to at least one fitness function. The live halves also **activate**
the upstream `live-T-0053` functions (T-0013 FF-1/2/3/5/6/7/12, T-0014 FF-1..4, T-0015
FF-A7, T-0016 FF-1/3/4/5/9/10/12/13, T-0018 FF-A7/A8) by supplying the Postgres service +
the `known_tenant_tables` fixture they parametrize on.

---

## 6. Fitness functions

Each is an executable CI rule. `gating`: **static-now** = a lint/script over the migration
SQL / fixtures / `package.json` runnable in today's `npm run ci`; **live** = a probe against
the pinned `postgres:16` service in the new `db` CI job (introduced here). All baseline
tenant-table probes iterate over `ci/checks/known_tenant_tables.txt` (§3.3) and parametrize
on `nspname='choros'` (§1.1). Three new CI artifacts are introduced: the `db` job, the
`known_tenant_tables.txt` fixture, and the SQL probe set under `ci/checks/db/`.

| ID | Rule | ci_check | gating |
|---|---|---|---|
| **FF-1** | PG16 service comes up ready; conn params from env dev defaults; no committed prod secret | live: in the `db` job, the runner connects and `SELECT version()` reports `PostgreSQL 16.*`; static: lint `ci/checks/no-committed-secret.sh` asserts compose uses `${VAR:-dev_default}` form and no real secret literal is present | live + static-now |
| **FF-2** | Runner applies all migrations on empty DB (exit 0, every file recorded, all 8 tables exist) **and** is idempotent (2nd run applies 0, `schema_migrations` unchanged, no DDL re-error) | live `ci/checks/db/runner.test.ts`: run runner → exit 0, `count(schema_migrations)` = file count, each §3.2 table in `information_schema.tables` (schema `choros`); run again → exit 0, row count unchanged, diff of `schema_migrations` empty | live |
| **FF-3** | `schema_migrations(version text PK, applied_at timestamptz)`; duplicate version ⇒ PK violation | live: `information_schema.columns` shape check; insert duplicate `version` ⇒ `23505` | live |
| **FF-RLS** | Every table in `known_tenant_tables` has ENABLE+FORCE RLS | live `ci/checks/db/force_rls.sql`: `SELECT relname FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='choros' AND relkind='r' AND relname = ANY($known) AND NOT (relrowsecurity AND relforcerowsecurity)` MUST return 0 rows; **and** no `choros`-schema base table is missing from `$known` (anti-decorative) | live (activates T-0013 FF-2, T-0016 FF-12) |
| **FF-DENY** | Default-DENY: as `choros_app` with no `SET LOCAL choros.tenant_id`, count = 0 on every tenant table | live: migrator seeds rows under tenant-A; `choros_app` (no GUC) `SELECT count(*)` on each tenant table = 0 | live (activates T-0013 FF-3) |
| **FF-LEAD** | `tenant_id` is column 1 of every composite index and every FK on a tenant table | live `ci/checks/db/tenant_id_leading.sql`: for each multi-col `pg_index` and each `pg_constraint contype='f'` on a `$known` table, column at position 1 = `tenant_id`; any violation ⇒ fail | live (activates T-0013 FF-5; AC-7) |
| **FF-SCOPE** | Scoped uniqueness holds (same business key OK across tenants, dup within one ⇒ unique violation); `tenant_id NOT NULL` enforced | live: insert `(A,slug=X)` ok, `(B,slug=X)` ok, `(A,slug=X)` again ⇒ `23505`; insert `tenant_id=NULL` as migrator ⇒ `23502` (NOT NULL) | live (AC-8/AC-9) |
| **FF-ROLE** | `choros_app` `rolbypassrls=f`, `rolsuper=f`, owns no tenant table; `choros_migrator` owns every tenant table + holds DDL; `choros_app` `CREATE TABLE` fails | live: `pg_roles` for `choros_app` = `(f,f)`; `pg_class.relowner` of every `$known` table = `choros_migrator` oid (and ≠ `choros_app` oid); `CREATE TABLE` as `choros_app` ⇒ `42501` insufficient privilege | live (AC-10/11) |
| **FF-APPEND** | `choros_app` UPDATE/DELETE on `audit_event` fails (SELECT/INSERT only); the no-mutate + head triggers exist | live: as `choros_app` in tenant context, UPDATE/DELETE on `audit_event` ⇒ failure (privilege or trigger); static `ci/checks/db/audit_append_only.sh`: assert no `GRANT … (UPDATE\|DELETE) … ON … audit_event TO choros_app`, the `BEFORE UPDATE`/`BEFORE DELETE` triggers on `audit_event` present, no `DELETE` grant on `audit_head` to `choros_app`, `BEFORE DELETE` trigger on `audit_head` present | live + static-now (activates T-0016 FF-1; AC-12) |
| **FF-2TENANT** | Migrations idempotent AND consistent with ≥2 tenants; scoped uniqueness never degenerates to global; no cross-tenant merge | live `ci/checks/db/two_tenant.test.ts` (tenancy §9 guard 5, blocking): after all migrations, seed ≥2 distinct `tenant_id` into the tenant tables; re-run the full migration suite; assert no unique-constraint violation, no global-degeneration, no implicit merge | live (AC-13) |
| **FF-FK-RESOLVE** | Every baseline FK resolves to a baseline-created table; no FK targets `role`/`assignment` or any non-baseline table | live `ci/checks/db/fk_resolve.sql`: every `pg_constraint contype='f'` on a `choros`-schema table has a `confrelid` pointing at a table in the baseline set; assert `grant.role_id` carries **no** FK; assert no FK references `role`/`assignment` | live (AC-14; confirms §1.2) |
| **FF-JSONB** | JSONB object-model columns present and typed `jsonb` | live: `registry_def.record_schema`, `record.data`, `audit_event.payload`, `grant.scope` are `jsonb` and `NOT NULL` (per their ADRs); `object_handle.facet` is `jsonb` | live (AC-15; activates T-0014/T-0018 jsonb checks) |
| **FF-ACT** | `ACT_*` readiness without installing Flowable; zero `ACT_*` tables after migrations | live: `SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'act\_%'` = 0; assert a `choros` schema exists and `choros_app` lacks CREATE on any schema (room left for `ACT_*`) | live (AC-16) |
| **FF-CI** | The gate is integration-honest with the PG service: runner + idempotency re-run + ≥2-tenant check run in CI; `npm run ci` green; worktrees excluded from discovery | structural: `.github/workflows/ci.yml` has a `db` job pinning a `postgres:16` service, runs the runner + FF-2/FF-2TENANT + the live probes; `vitest.config.js` excludes `.claude/**` and `../choros-wt/**` (already present); the `db` job does not depend on ambient build state | static-now (workflow lint) + live (AC-17) |
| **FF-PG-ONCE** | `pg` declared exactly once in `package.json`; runner imports only Node builtins + `pg` | static-now `ci/checks/pg-single-dep.sh`: `package.json` lists `pg` in `dependencies`; no other manifest/lockfile in the repo adds a Postgres client (grep `web/package.json` and any other `package.json` for `"pg"` ⇒ 0); `migrations/run.mjs` imports only `node:*` + `pg` | static-now (AC-18) |

**CI wiring.** The existing `ci` job (`tsc --noEmit && eslint src && npm run fitness &&
vitest run`, with web built first) stays as-is. A **new `db` job** is added to
`.github/workflows/ci.yml`: it pins a `postgres:16` **service container** (its own DB, no
ambient dependency — integration-honest, D-056), `npm ci`, runs `node migrations/run.mjs`
against it, **re-runs it** (idempotency), runs the live probes (`ci/checks/db/*.sql` +
`*.test.ts`) and the ≥2-tenant suite. The static-now lints (`pg-single-dep.sh`,
`audit_append_only.sh`, `no-committed-secret.sh`, the workflow lint) join `npm run fitness`
so they gate on the existing job too. The `db` job's vitest invocation inherits the
worktree-excluding `vitest.config.js`. `npm run ci` stays green on the branch ⇒ green on
`dev` because the DB job pins its own service and the tenant-table set is fixed by the
`known_tenant_tables` fixture (no ambient state).

---

## 7. Compat-check (FE-W23-0008) — public-surface impact

**No existing public export is changed, moved, or removed.** T-0053 is **purely additive**
at the source level: it adds `docker-compose.yml`, `migrations/*.sql`, `migrations/run.mjs`,
`ci/checks/known_tenant_tables.txt`, `ci/checks/db/*`, the `db` CI job, and `pg` to
`package.json` `dependencies`. It does **not** edit `src/core/types.ts`,
`src/core/jobStore.ts`, `src/core/grant-lattice.ts`, or `src/core/object-handle.ts` — the
frozen public symbols (`Job`, `JobState`, `JobStore`, `makeHandle`, `assertVariableValue`,
`isNarrowerOrEqual`, `meet`, `validateNarrowing`, etc., guarded by `src/__tests__/*`) are
untouched. The TS-side store rewrite that would *consume* these tables is **T-0114's** zone,
not this task's. Zero importers break.

> One forward seam to flag for T-0114 (not a break): T-0015 §7 / T-0018 §8 note that
> `ResourceRef` is re-declared in `object-handle.ts` and the `AncestryOracle` is injected;
> when the store code lands (T-0114), the in-memory and FK-backed hierarchy facts must be
> reconciled. T-0053 supplies the FK chain (`registry_def→application`, `record→
> registry_def`) that the eventual FK-backed `AncestryOracle` reads — the DB side of that
> seam is delivered here; the reconciliation is T-0114's.

---

## 8. Runtime target

**Postgres in the silo `docker-compose` stack** (one tenant per instance), the dev
substrate locally and the basis of every silo deploy. The app connects as the
`NOBYPASSRLS`/non-owner `choros_app`; migrations run as `choros_migrator`. The CI `db` job
runs an ephemeral `postgres:16` service container.

**Founder gate (GT-4) — NOT triggered here:** server provisioning / prod deploy
(`/srv/choros`, Tailscale, prod credentials) is **E0.7**, founder-gated. T-0053 commits **no**
prod secret and provisions **no** server; it delivers the compose substrate, the runner, the
schema, and the CI gate. Standing up Flowable (`ACT_*` engine) is **E0.5**, founder-gated
(S-1) — T-0053 leaves room only.

---

## 9. Escalation

None. Every high-leverage fork this task touches is founder-ratified: the stack
(PostgreSQL 16, one instance, `ACT_*`+`choros_*`, Flowable-as-infra) in
`stack-and-fleet-ops.md` (2026-06-10); multi-tenant-first + the 7 day-1 guards + silo-now in
`tenancy-and-delivery.md` (GT-1); the object model of every baseline table in the ratified
T-0013/14/15/16/18 ADRs. The decisions made here — the `choros` schema layout (§1.1), the
`grant.role_id` FK deferral (§1.2, an explicit confirmation of the spec/analyst finding), the
`job` cut-line vs T-0114 (§1.3), per-file-transaction runner semantics (§4.1), and roles-in-
migration-`001` (§2) — are all **SUBD / compose / CI details** the red-lines mark as
**autonomous** (spec §2, §8). No product-direction fork is opened; `status: ready`.
