# ADR · T-0013 — Tenant Isolation Foundation

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-09
**Spec:** `docs/specs/T-0013-tenant-isolation.spec.md` (status: ready, AC-1..AC-15)
**Authoritative product decision (do NOT re-open):** `choros/docs/design/tenancy-and-delivery.md` (GT-1, founder-approved 2026-06-08), esp. §4, §5, §6, §9, §11.

> This ADR is **design-only**. Choros has no Postgres today (jobStore is an in-memory
> `Map`, no `pg` dependency, no docker-compose). T-0013 fixes the *invariants, object
> model, contracts, and fitness functions* that any correct implementation MUST satisfy.
> The SQL DDL / migrations / RLS policy bodies / app-role provisioning land in **T-0053**
> (Postgres-in-compose + jobStore→Postgres migration), which is an **infra dependency of
> this design, not built here**. Each fitness function below is therefore declared with
> its concrete `ci_check` *and* a `gating` note stating whether it runs today (static
> source-level checks) or activates in T-0053 (live-DB probes) — but all are authored now
> so they cannot be "forgotten" when Postgres arrives.

---

## 1. Decision

Choros isolates tenants with a **single-schema, RLS-enforced, schema-structural** model,
identical in silo (N=1) and future pooled (N>1) — one isolation code-path, zero drift.
Every tenant-owned table carries `tenant_id uuid NOT NULL` (no default) as the **leading
column of its primary key, every composite index, and every foreign key**; all uniqueness
is **scoped** to `(tenant_id, <business_key>)`. Every tenant table has
`ENABLE` + `FORCE ROW LEVEL SECURITY` with a **default-DENY** posture: access is granted
only by a permissive policy that compares `tenant_id` against a **transaction-local**
GUC, `current_setting('choros.tenant_id', true)`. The application connects through a
dedicated **app role** that is non-superuser, non-owner, and lacks `BYPASSRLS`; a separate
**migration/owner role** holds DDL and is never used at runtime. Tenant context is set
**only** via `SET LOCAL` / `set_config('choros.tenant_id', $1, true)` inside an explicit
transaction (session-level `SET` is forbidden — it leaks across PgBouncer
transaction-pooled connections). Every async / background / Flowable-external-worker path
must establish tenant context explicitly and **fail closed** (throw / abort) if it cannot.
The `audit_log` is itself an ordinary tenant table subject to all of the above. On every
inbound request the app validates JWT signature **plus** `iss`, `aud`, and the tenant
claim against the acting tenant, rejecting mismatches with 401/403. Isolation is thus a
**structural property of the database** (NOT NULL + scoped uniqueness + FORCE RLS +
no-BYPASSRLS app role), not a code-review discipline — bypassing it requires a deliberate,
CI-visible schema change, not a forgotten `WHERE` clause.

The mechanism is deliberately **proportional**: it is the minimal standard Postgres RLS
apparatus (one GUC, one policy template, two DB roles, one fail-closed wrapper) — no
custom enforcement engine, no per-tenant schema/catalog machinery, no app-layer query
rewriter. The thin core is the policy template + the tenant-context contract; everything
else is convention enforced by the fitness functions.

---

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| **schema-per-tenant / "bridge" (one Postgres schema or DB per tenant)** | Catalog bloat in the low hundreds of tenants with no legal benefit (152-ФЗ requires residency + access control + audit, not DB-per-tenant — see source doc §8); doubles migration/test/audit surface; forces a second isolation code-path. Explicitly rejected in source doc §5. |
| **App-layer-only filtering (every query carries `WHERE tenant_id = ?`, no RLS)** | Isolation becomes discipline, not structure (violates NF-2). A single missing `WHERE` is a silent cross-tenant leak — the worst 152-ФЗ incident class (source §8). Cannot satisfy AC-3/AC-6/AC-7 (default-DENY from the DB). |
| **App role with `BYPASSRLS` (or running as table owner / superuser)** | Table owners and `BYPASSRLS` roles are exempt from RLS even with FORCE; the entire apparatus becomes decorative. Directly violates source §9 guard 1 and AC-1. |
| **Session-level `SET choros.tenant_id` (instead of `SET LOCAL`)** | PgBouncer transaction-pooling reuses a physical connection across requests without resetting session GUCs → context bleed from one tenant's request into another's (source §9 guard 2, §5 context-bleed). Forbidden. |
| **Decorative `tenant_id` with a constant `DEFAULT_TENANT`** | At N=1, global and scoped uniqueness are indistinguishable; nothing pressures the schema toward scoped keys, so retrofit to real multi-tenant is a multi-year project later (source §4 "ловушка декоративного tenant_id"). Defeated by the ≥2-tenant migration test (FF-8 / AC-8). |
| **`SECURITY DEFINER` views/functions for app reads of tenant tables** | They run with the definer's (owner) rights, bypassing the caller's RLS — a back door around default-DENY. Forbidden for app-reachable code paths (FR-2). |
| **Build pooled-RLS multi-tenant deployment now** | Founder decision (source §5, §11): build **silo only** now; pooled is laid into the foundation but not implemented until a mass cheap SaaS tier exists. The RLS apparatus still runs at N=1 so there is one code-path. |

None of these reopen the founder-approved fork; they are the standard alternatives the
GT-1 decision already weighed, recorded here for downstream traceability.

---

## 3. Object model

The object model fixes field/type truth for `coder` (T-0053) and `tester`. Types are
Postgres types; the TS-side mirror (`tenantId: string`) is noted where relevant.

### 3.1 Tenant-table convention (applies to EVERY tenant-owned table)

Every tenant-owned table (jobs, org structure, roles, users, inbox items, process
instances, JSONB objects, `audit_log`, and all future domain tables) MUST include:

| Field | Type | Constraints |
|---|---|---|
| `tenant_id` | `uuid` | `NOT NULL`, **no default**, **leading PK column**, leading column of every composite index & FK |
| `id` | `uuid` | entity identity; PK is `(tenant_id, id)` (scoped, never `id` alone) |
| `<business_key>` (where applicable) | per-entity | unique constraints are scoped: `UNIQUE (tenant_id, <business_key>)` |

RLS posture required on every such table: `ENABLE ROW LEVEL SECURITY` **and**
`FORCE ROW LEVEL SECURITY`; one default-DENY baseline (no permissive policy ⇒ no access)
plus the permissive policy in §4.3.

### 3.2 `job` (the first concrete tenant table — migrated from in-memory `JobStore`)

Mirrors `src/core/types.ts:Job`, gaining `tenant_id` as leading PK column. The 7 current
unscoped `JobStore` methods (`getById`, `listByTopic`, `listByState`,
`listByTopicAndState`, `fetchAndLock`, `complete`, `fail`) become tenant-scoped via the
ambient transaction GUC (no `tenantId` parameter threading needed — RLS filters).

| Field | Type | Notes |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK column; RLS key |
| `id` | `uuid NOT NULL` | PK is `(tenant_id, id)` |
| `topic` | `text NOT NULL` | indexed as `(tenant_id, topic, created_at)` |
| `variables` | `jsonb NOT NULL` | |
| `state` | `text NOT NULL` | enum domain `CREATED|LOCKED|COMPLETED|FAILED` |
| `retries` | `integer NOT NULL` | |
| `lock_owner` | `text NULL` | |
| `lock_expiry` | `bigint NULL` | unix epoch ms |
| `created_at` | `bigint NOT NULL` | unix epoch ms |

### 3.3 `audit_log` (tenant-scoped audit entity — source §9 guard 6)

An ordinary tenant table; same convention. No app-reachable query path may read
`audit_log` without tenant context (FR-6).

| Field | Type | Notes |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK column; RLS key |
| `id` | `uuid NOT NULL` | PK `(tenant_id, id)` |
| `actor` | `text NOT NULL` | subject who caused the event (user/worker id) |
| `action` | `text NOT NULL` | event type |
| `target` | `text NULL` | affected entity reference |
| `payload` | `jsonb NOT NULL` | structured event detail |
| `occurred_at` | `bigint NOT NULL` | unix epoch ms |

### 3.4 Database roles (DB-level entities, provisioned in T-0053)

| Entity | Attributes |
|---|---|
| `choros_app` (app role) | `NOSUPERUSER`, **`NOBYPASSRLS`**, NOT table owner; granted only `SELECT, INSERT, UPDATE, DELETE` on tenant tables; **no DDL**. The runtime connection role. |
| `choros_migrator` (migration/owner role) | owns tenant tables; holds DDL; runs migrations; **never used at runtime**. Subject to RLS unless explicitly `BYPASSRLS` for seed/verify steps — FORCE RLS means even the owner is filtered unless bypassing. |

### 3.5 Tenant-context mechanism (GUC)

| Entity | Value |
|---|---|
| Context GUC name | `choros.tenant_id` (custom GUC; final spelling fixed here — supersedes the `app.current_tenant_id` placeholder used illustratively in the spec) |
| Read in policy | `current_setting('choros.tenant_id', true)` (the `true` = "missing ⇒ NULL, don't error" ⇒ default-DENY when unset) |
| Set in app | `set_config('choros.tenant_id', $1, true)` (the third arg `true` = transaction-local) or `SET LOCAL choros.tenant_id = $1` |

---

## 4. Contracts (pseudocode — implementation is `coder`'s zone, T-0053)

### 4.1 Tenant-context API (TS core)

```ts
// The ONLY sanctioned way app/worker code touches tenant data.
// Opens a transaction, sets transaction-local tenant context, runs work, commits.
// Fail-closed: tenantId absent/blank => throw BEFORE any query (FR-5, guard 7).
function withTenant<T>(
  tenantId: string,            // required, non-empty; validated UUID
  fn: (tx: TxHandle) => Promise<T>
): Promise<T>;
// Semantics:
//   if (!isNonEmptyUuid(tenantId)) throw MissingTenantContextError;   // fail closed
//   BEGIN;
//   SELECT set_config('choros.tenant_id', tenantId, true);            // SET LOCAL
//   try { result = await fn(tx); COMMIT; return result; }
//   catch { ROLLBACK; throw; }

// Worker/async entrypoints MUST be wrapped:
//   handler(msg) -> withTenant(resolveTenant(msg), tx => ...);
//   resolveTenant returns undefined => withTenant throws => job aborts (no global run).
```

### 4.2 Connection contract

```
App runtime connection MUST authenticate as role `choros_app`.
INVARIANT: rolbypassrls(choros_app) = false; rolsuper(choros_app) = false.
App role MUST NOT be the owner of any tenant table.
No raw query against a tenant table is permitted outside a withTenant(...) transaction.
```

### 4.3 RLS policy template (one template, applied per tenant table)

```sql
-- For each tenant table T:
ALTER TABLE T ENABLE ROW LEVEL SECURITY;
ALTER TABLE T FORCE ROW LEVEL SECURITY;            -- owner is filtered too

-- default-DENY: with no permissive policy, no rows are visible/modifiable.
-- single permissive policy keyed on the transaction-local GUC:
CREATE POLICY tenant_isolation ON T
  USING       (tenant_id = current_setting('choros.tenant_id', true)::uuid)   -- read/return
  WITH CHECK  (tenant_id = current_setting('choros.tenant_id', true)::uuid);  -- insert/update
-- GUC unset => current_setting(...,true) = NULL => predicate NULL => row denied.
```

### 4.4 Keycloak per-request validation contract (FR-7)

```ts
// Runs on EVERY inbound request (HTTP / WS / worker invocation), after signature verify.
function validateToken(jwt, ctx): asserts ok | reject(401|403);
//   verify signature (standard)                                  // else 401
//   assert jwt.iss === expectedRealmIssuerUrl                    // else 401  (AC-12)
//   assert jwt.aud includes expectedClientId                     // else 401/403 (AC-13)
//   assert jwt.tenantClaim === ctx.actingTenantId                // else 401/403 (AC-11)
//   all checks are local (no network round-trip) -> negligible latency (NF-5)
```

---

## 5. Fitness functions

Each guard/invariant becomes an executable CI rule. `gating` states when it runs:
**static-now** = source-level check runnable today (grep/lint/SQL-file scan) in the
existing `npm run ci`; **live-T-0053** = live-DB probe/test that activates once Postgres
exists (authored now as the contract, wired into a `db-isolation` CI job in T-0053). All
are authored in this ADR so none can be silently dropped.

| ID | Rule | ci_check | gating |
|---|---|---|---|
| **FF-1** | App role lacks BYPASSRLS & superuser | Live: as `choros_app`, `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname=current_user;` MUST be `(f,f)`. Static-now: grep migration/role SQL forbids `BYPASSRLS`/`SUPERUSER` on the app role. | live-T-0053 (+static-now lint) |
| **FF-2** | FORCE RLS on every tenant table | Live: `SELECT relname FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='public' AND relkind='r' AND relname = ANY($tenant_tables) AND NOT (relrowsecurity AND relforcerowsecurity);` MUST return 0 rows. | live-T-0053 |
| **FF-3** | Default-DENY: no tenant context ⇒ 0 rows | Live: as `choros_app`, with no `SET LOCAL`, `SELECT count(*)` on each tenant table MUST be 0. | live-T-0053 |
| **FF-4** | Tenant context is transaction-local only (no session SET) | Static-now: lint `ci/checks/no-session-set.sh` greps `src/` for `SET <guc>` / `set_config(...,false)` not scoped to a transaction (only `SET LOCAL` / `set_config(...,true)` allowed) → fail on hit. Live: after COMMIT, `SELECT count(*)` without new SET LOCAL MUST be 0 (AC-4). | static-now (+live-T-0053) |
| **FF-5** | `tenant_id` is leading column of every composite index & FK on tenant tables | Live SQL probe `ci/checks/tenant_id_leading.sql`: for each multi-column index (`pg_index`) and FK (`pg_constraint contype='f'`) on a tenant table, assert column at position 1 is `tenant_id`; any violation = fail. | live-T-0053 |
| **FF-6** | Cross-tenant READ from real app role returns 0 | Live test: seed tenant-A & tenant-B rows; as `choros_app` with `SET LOCAL choros.tenant_id=A`, `SELECT count(*) ... WHERE tenant_id=B` MUST be 0 (and unfiltered count = A-only). | live-T-0053 |
| **FF-7** | Cross-tenant WRITE from app role affects 0 rows | Live test: as `choros_app` with context=A, `UPDATE/DELETE ... WHERE tenant_id=B` MUST report 0 rows; verify B unchanged via `choros_migrator`. | live-T-0053 |
| **FF-8** | Migrations run/idempotent with ≥2 tenants; scoped uniqueness never degenerates to global | Live test: apply all migrations, seed ≥2 distinct `tenant_id` per tenant table, re-run migration suite; assert no unique-constraint violation / no cross-tenant merge. | live-T-0053 |
| **FF-9** | `audit_log` is tenant-scoped & has no app-reachable cross-tenant read path | Live test: with context=A, `SELECT count(*) FROM audit_log WHERE tenant_id=B` = 0, and unfiltered select returns A-only. Static-now: grep forbids any app-layer `audit_log` query outside `withTenant`. | live-T-0053 (+static-now) |
| **FF-10** | Fail-closed tenant context in async/worker/Flowable paths | Integration test: invoke job scheduler, inbox consumer, and a Flowable external-worker stub WITHOUT tenant context; each MUST throw/abort and read/write 0 tenant rows. Static-now: lint asserts every registered worker entrypoint is wrapped in `withTenant`. | static-now (lint) + live-T-0053 (integration) |
| **FF-11** | Per-request iss/aud/tenant-claim validation | Integration test: (a) wrong `iss` ⇒ 401; (b) wrong `aud` ⇒ 401/403; (c) tenant-claim ≠ acting tenant ⇒ 401/403, no tenant data returned. Static-now: assert `validateToken` invoked in the request-pipeline middleware (no route bypasses it). | live-T-0053 (integration) + static-now |
| **FF-12** | Scoped uniqueness & `tenant_id NOT NULL` enforced at DB layer | Live test: same `(business_key)` succeeds across two tenants, duplicate within one tenant ⇒ unique violation; insert with `tenant_id=NULL` (as `choros_migrator`) ⇒ NOT NULL violation. | live-T-0053 |
| **FF-13** | No `SECURITY DEFINER` back door on tenant tables | Static-now: grep migration SQL forbids `SECURITY DEFINER` views/functions over tenant tables in app-reachable code. Live: `pg_proc.prosecdef` audit over functions touching tenant tables. | static-now (+live-T-0053) |

**CI wiring:** static-now checks (FF-4, FF-13, and the static halves of FF-1/9/10/11) are
added to the existing `npm run ci` pipeline as `ci/checks/*.sh` lint scripts today.
Live-T-0053 checks are authored now as `ci/checks/*.sql` and `*.test.ts` fixtures and
activated by a `db-isolation` CI job (Postgres service container) introduced in T-0053.
The known-tenant-table list (`$tenant_tables`) is a maintained CI fixture; every migration
that creates a tenant table MUST append to it (enforced by FF-2 failing on any RLS-less
public table not in an allowlist).

---

## 6. Traceability (AC-1..AC-15 → design)

| AC | Covered by |
|---|---|
| AC-1 (app role no BYPASSRLS) | §3.4 `choros_app` role · §4.2 connection contract · **FF-1** |
| AC-2 (FORCE RLS every tenant table) | §3.1 convention · §4.3 policy template · **FF-2** |
| AC-3 (no context ⇒ 0 rows / default-DENY) | §4.3 template (GUC unset ⇒ NULL ⇒ deny) · **FF-3** |
| AC-4 (SET LOCAL only; transaction-scoped) | §3.5 GUC · §4.1 `withTenant` · **FF-4** |
| AC-5 (tenant_id leading column) | §3.1 convention · **FF-5** |
| AC-6 (cross-tenant read = 0) | §4.3 USING predicate · **FF-6** |
| AC-7 (cross-tenant write = 0 rows) | §4.3 WITH CHECK predicate · **FF-7** |
| AC-8 (migrations idempotent ≥2 tenants) | §3.1 scoped uniqueness · §2 (anti-decorative) · **FF-8** |
| AC-9 (audit_log tenant-scoped) | §3.3 `audit_log` entity · **FF-9** |
| AC-10 (fail-closed async/worker) | §4.1 `withTenant` fail-closed · **FF-10** |
| AC-11 (wrong tenant claim ⇒ 401/403) | §4.4 validateToken · **FF-11** |
| AC-12 (wrong iss ⇒ 401) | §4.4 validateToken · **FF-11** |
| AC-13 (wrong aud ⇒ 401/403) | §4.4 validateToken · **FF-11** |
| AC-14 (scoped uniqueness) | §3.1 `UNIQUE(tenant_id,business_key)` · **FF-12** |
| AC-15 (tenant_id NOT NULL) | §3.1 `NOT NULL` no default · **FF-12** |

Every AC-1..AC-15 maps to at least one fitness function. (FF-13 hardens the design against
the `SECURITY DEFINER` back door — beyond the explicit ACs, derived from FR-2.)

---

## 7. Runtime target

**Postgres in a silo `docker-compose` stack** (one tenant per instance; source §5, §11),
on the founder's home server (`/srv/choros`, per product memory), deploy founder-gated.
The application connects as the non-owner / non-superuser / `NOBYPASSRLS` role
`choros_app`; migrations run as `choros_migrator`. RLS apparatus runs at N=1 (one
code-path, pooled-ready).

**Infra dependency — NOT built in T-0013:** the Postgres service itself
(`docker-compose` Postgres container, `pg` driver dependency, jobStore→Postgres migration,
the SQL DDL/migrations/RLS policy bodies, and DB-role provisioning) is delivered by
**T-0053** (E0.3). T-0013 is design-only: it authors the invariants, the object model, the
contracts, and the fitness functions (incl. their `ci_check` commands/fixtures) so they are
ready to wire the moment Postgres exists. Provisioning the server/DB host is a founder gate
(GT-4), not an autonomous system action.

---

## 8. Escalation

None. The high-leverage tenancy fork (multi-tenant-first model, silo-now/pooled-later,
RLS-everywhere, dedicated-realm identity, one artifact) is already founder-approved in
`tenancy-and-delivery.md` (GT-1). This ADR is fully consistent with that decision and
introduces no new high-leverage fork. The only naming choice made here — the context GUC
spelling `choros.tenant_id` (the spec used `app.current_tenant_id` as an explicit
placeholder, see spec §7 Open Items) — is an implementation-detail convention, not a
product-direction fork, and is fixed here as the single source of truth for T-0053.
