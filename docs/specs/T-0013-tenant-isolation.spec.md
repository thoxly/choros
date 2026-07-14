# T-0013 · Tenant Isolation Foundation Spec

**Title:** E2.1 · Tenant isolation foundation: shared schema + tenant_id + RLS + day-1 guards
**Status:** ready (no blocking questions)
**Authored:** 2026-06-09
**Authoritative source:** `choros/docs/design/tenancy-and-delivery.md` (GT-1, 2026-06-08)

---

## Note on title vs. §9 guard count

The task title says "6 non-negotiable guards". The founder-approved design doc §9
lists **7** day-1 guards. §9 is authoritative (signed GT-1). This spec uses the full
7-guard set from §9. The discrepancy is a title artefact — no founder action needed.

---

## 1. Summary

Choros stores every piece of business data (org structure, roles, inbox, audit log,
process variables, JSONB object model) in a **single PostgreSQL schema**. From the
very first migration, every tenant-owned table carries a `tenant_id NOT NULL` column
as its **leading composite key component**. Row-Level Security (RLS) is active on
every tenant table with a **default-DENY policy**, and the application always connects
as a non-owner / non-superuser / non-BYPASSRLS role. Seven engineering guards (§9 of
the tenancy ADR) are treated as non-negotiable correctness conditions from day 1, not
deferred hardening.

The deployment default is **silo** (one tenant per Postgres instance / docker-compose
stack). Even so, the RLS apparatus runs in silo-N=1 so that there is exactly one
isolation code-path, one audit narrative, and zero drift between silo and future
pooled modes.

---

## 2. Scope boundary

This task is a **design-deliverable** task. It defines the invariants, guards, and
acceptance criteria that any correct implementation MUST satisfy. The actual SQL DDL,
migration files, and RLS policy definitions land in T-0053 (once Postgres exists in
the stack). This spec does NOT order anyone to write migration code today.

---

## 3. Functional Requirements

### FR-1  Scoped data model

- Every table that stores tenant-owned data (org structure, roles, users, inbox items,
  jobs, process instances, audit events, JSONB objects, and all future domain tables)
  MUST carry a `tenant_id` column of type `uuid` (or a stable opaque identifier type
  chosen at DDL time).
- `tenant_id` MUST be declared `NOT NULL` with no default value in every such table.
- Uniqueness constraints MUST be **scoped**: `(tenant_id, <business_key>)`, never on
  `<business_key>` alone.
- `tenant_id` MUST be the **leading column** of every composite index and every
  composite foreign-key on tenant tables. This is mandatory for query planner
  efficiency and correct partition pruning.
- On-prem / silo (N=1 tenant) uses the identical schema — there is no special
  single-tenant code path.

### FR-2  RLS apparatus active everywhere (including silo N=1)

- Every tenant table MUST have `ALTER TABLE … FORCE ROW LEVEL SECURITY` applied.
- Every tenant table MUST have a **default-DENY RLS policy**: rows are hidden unless a
  permissive policy explicitly allows access.
- A permissive READ/WRITE policy grants access when
  `current_setting('app.current_tenant_id', true) = tenant_id::text` (or equivalent
  agreed variable name, to be fixed in T-0053).
- No table may use `SECURITY DEFINER` views or functions to bypass these policies for
  app-level operations.

### FR-3  Application connection role

- The application (TS core, background workers, Flowable external workers) connects to
  Postgres using a dedicated **app role** that:
  - is NOT a superuser,
  - does NOT have the `BYPASSRLS` attribute,
  - does NOT own the tenant tables (owner is a separate migration role),
  - has only the DML privileges required for normal operation (SELECT, INSERT, UPDATE,
    DELETE on tenant tables — no DDL).
- The migration / DDL role is separate and is NEVER used at runtime.

### FR-4  Tenant context via SET LOCAL only

- Tenant context MUST be set exclusively via `SET LOCAL app.current_tenant_id = '...'`
  (or `set_config('app.current_tenant_id', ..., true)` — the `true` flag scopes the
  setting to the current transaction).
- Session-level `SET` for tenant context is FORBIDDEN in application code because
  PgBouncer transaction-pooling can reuse a connection in a new request without
  resetting session state, leaking the context from one request to another.
- Every database interaction on behalf of a tenant MUST occur inside an explicit
  transaction that opens with the `SET LOCAL` call.

### FR-5  Fail-closed tenant context in async / background / Flowable workers

- Any code path that runs asynchronously (timers, queue consumers, scheduled jobs,
  Flowable external-worker callbacks) MUST explicitly set tenant context before
  touching any tenant table.
- If the tenant context is absent or cannot be determined, the operation MUST FAIL
  (throw / abort the job / return an error) rather than execute globally across all
  tenants.
- "Fail globally" — executing a query without a tenant context that would silently
  return or mutate data across all tenants — is a **hard defect**.

### FR-6  Tenant-scoped audit log

- The audit log table is itself a tenant-owned table subject to FR-1 and FR-2.
- An audit event for tenant A MUST NOT be visible to a query running in tenant B's
  context.
- The audit log MUST NOT contain a query path that allows cross-tenant reads (e.g., no
  admin-facing query that reads audit rows without a tenant filter and is reachable
  from app-role code).

### FR-7  Keycloak token claims validated per request

- On every inbound request (HTTP, WebSocket, or worker invocation) the application MUST
  validate:
  1. JWT signature (standard),
  2. `iss` (issuer) — must match the expected Keycloak realm URL for the deployment,
  3. `aud` (audience) — must match the configured client ID,
  4. tenant claim — the token's tenant identifier must match the tenant the request is
     acting on.
- A token that passes signature validation but fails any of the three additional checks
  MUST be rejected with a 401/403 response. The application MUST NOT rely on JWT
  signature alone as proof of tenant membership.
- In silo deployments the dedicated realm makes cross-tenant token delivery physically
  impossible, but the validation logic runs regardless (defense-in-depth; single
  code-path).

---

## 4. Non-Functional Requirements

### NF-1  Zero drift between modes

One schema, one RLS code-path for both silo (N=1) and future pooled (N>1). No
conditional branches in migration scripts or RLS policies keyed on deployment mode.

### NF-2  Schema-enforced, not discipline-enforced

Tenant isolation MUST be a structural property of the database schema (NOT NULL,
scoped unique constraints, FORCE RLS, app-role lack of BYPASSRLS), not solely a
code-review discipline. Bypassing isolation requires deliberate schema changes, not a
missing `WHERE` clause.

### NF-3  One audit narrative

Because the RLS apparatus is active in silo-N=1, the 152-ФЗ / GDPR audit narrative is
identical for both deployment modes. There is no "relaxed silo audit path" that would
need to be separately validated when pooled is enabled later.

### NF-4  Leading-column index discipline

`tenant_id` as the leading index column is mandatory on all tenant tables to keep
queries correct under partial-index misses and to ensure future partition pruning works
without schema changes.

### NF-5  Token validation latency

Claim validation (iss / aud / tenant-claim) runs on every request. It MUST NOT add
meaningful latency beyond the existing JWT signature verification (all checks are
local, no network round-trip required).

---

## 5. Out of Scope

The following are explicitly NOT part of T-0013:

1. **Running Postgres migrations / DDL** — T-0053 (Postgres does not exist in the
   stack yet). T-0013 defines invariants; T-0053 implements them.
2. **Pooled-mode build** — deferred by founder decision (tenancy-and-delivery.md §5,
   §11). The foundation must be compatible with pooled; building pooled is not in
   scope.
3. **Billing / quota / SaaS-tier features** — explicitly deferred (§11).
4. **Flowable engine table isolation** — Flowable `TENANT_ID_` columns on engine
   tables are Flowable's concern; this spec covers Choros core tables only. The
   integration boundary is specified in FR-5 (fail-closed in external workers).
5. **Keycloak realm provisioning / silo onboarding automation** — operational concern
   (docker-compose provisioning). Not a correctness invariant of this spec.
6. **Cell registry / fleet management** — §10 concern, separate task.
7. **152-ФЗ legal validation** — §12 open item, requires a lawyer, not an engineering
   guard.
8. **RBAC / authorization model** — role-level access control (who can do what within
   a tenant) is the subject of E3 tasks. T-0013 covers cross-tenant isolation only.
9. **jobStore migration from in-memory Map to Postgres** — referenced in §12 as a
   future migration step; not part of the foundation spec itself.

---

## 6. Acceptance Criteria

Each of the seven §9 day-1 guards maps to one or more AC below. All ACs are CI-
checkable test or fitness-function assertions.

---

### Guard 1 → AC-1, AC-2, AC-3 (app role, FORCE RLS, default-DENY)

**AC-1** — App-role lacks BYPASSRLS
```
CI test: connect as the app role; execute
  SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user;
Result MUST be 'f'. Fail if 't'.
```
`verifiable_as: test`

**AC-2** — FORCE RLS active on every tenant table
```
CI test / fitness function: after running all migrations, execute
  SELECT relname FROM pg_class
  JOIN pg_namespace ON pg_class.relnamespace = pg_namespace.oid
  WHERE nspname = 'public'
    AND relkind = 'r'
    AND relname IN (<list of known tenant tables>)
    AND NOT relrowsecurity;
Result set MUST be empty. Any row is a failure.
```
`verifiable_as: test`

**AC-3** — Default-DENY: no rows visible without tenant context
```
CI test: as app role, with NO SET LOCAL tenant context, execute
  SELECT count(*) FROM <each tenant table>;
Every count MUST return 0. Any non-zero count is a failure.
```
`verifiable_as: test`

---

### Guard 2 → AC-4 (SET LOCAL only; session-level SET forbidden)

**AC-4** — Tenant context visible only within the transaction that set it
```
CI test:
  Connection 1 (app role):
    BEGIN;
    SET LOCAL app.current_tenant_id = '<tenant-A-uuid>';
    -- verify rows of tenant A are visible (count > 0)
    COMMIT;
    -- After commit, without a new SET LOCAL:
    SELECT count(*) FROM <tenant table>;
    -- MUST return 0 (context gone after transaction end).
  Connection 1 (app role), session-level:
    SET app.current_tenant_id = '<tenant-A-uuid>';  -- session-level
    BEGIN; COMMIT;
    -- In new transaction without SET LOCAL:
    SELECT count(*) FROM <tenant table>;
    -- MUST return 0 if RLS policy requires transaction-local setting.
    -- (Demonstrates that policies are keyed on transaction-local config.)
Fail if any query outside a SET LOCAL transaction returns tenant rows.
```
`verifiable_as: test`

---

### Guard 3 → AC-5 (tenant_id leading column)

**AC-5** — tenant_id is the leading column of all composite indexes and FKs on tenant tables
```
CI fitness function: after migrations, query pg_index / pg_constraint;
for every multi-column index and FK on a tenant table:
  the first column MUST be tenant_id (attnum matches position 1).
Any violation is a build failure.
Script lives in ci/checks/tenant_id_leading_check.sql (or equivalent).
```
`verifiable_as: fitness`

---

### Guard 4 → AC-6, AC-7 (CI test: cross-tenant leak from real app role)

**AC-6** — App-role query in tenant-A context returns ZERO rows from tenant B
```
CI test (blocking):
  Seed: insert rows for tenant-A and tenant-B in the same table.
  Connect as app role.
  BEGIN; SET LOCAL app.current_tenant_id = '<tenant-A-uuid>';
  SELECT count(*) FROM <tenant table> WHERE tenant_id = '<tenant-B-uuid>';
  COMMIT;
  Result MUST be 0. Non-zero is a build failure.
```
`verifiable_as: test`

**AC-7** — App-role cannot UPDATE/DELETE rows of another tenant
```
CI test (blocking):
  As app role with tenant-A context:
  UPDATE <tenant table> SET … WHERE tenant_id = '<tenant-B-uuid>';
  Result MUST be 0 rows affected (not an error — just 0 rows visible to modify).
  Confirm row in tenant-B is unchanged by reconnecting as migration role.
```
`verifiable_as: test`

---

### Guard 5 → AC-8 (CI test: migrations with ≥2 tenants)

**AC-8** — Migration suite runs and passes with ≥2 tenants present
```
CI test (blocking):
  After applying all migrations, seed at least 2 distinct tenant_id values
  into every tenant table.
  Run the full migration suite again (idempotency check / re-run).
  Assert: no unique-constraint violations, no scoped-uniqueness failures,
  no implicit cross-tenant merging.
  Purpose: catches any migration or constraint that silently degenerates
  to global uniqueness when N=1.
```
`verifiable_as: test`

---

### Guard 6 → AC-9 (audit log is tenant-scoped and does not leak)

**AC-9** — Audit log rows of tenant A are not readable in tenant B context
```
CI test:
  Seed audit_log rows for tenant-A and tenant-B.
  As app role with tenant-A context:
  SELECT count(*) FROM audit_log WHERE tenant_id = '<tenant-B-uuid>';
  MUST return 0.
  Also: SELECT count(*) FROM audit_log (no filter) in tenant-A context
  MUST return only tenant-A rows (RLS filters automatically).
```
`verifiable_as: test`

---

### Guard 7 → AC-10 (fail-closed in async / background / Flowable workers)

**AC-10** — Background/async operation without tenant context throws, does not execute globally
```
CI test:
  In the application test harness (not direct DB), invoke any background
  job handler (timer callback, queue consumer, Flowable external-worker
  fetch-and-lock) WITHOUT providing a tenant context.
  The invocation MUST throw / return an error / abort the job.
  It MUST NOT successfully read or write any tenant table rows.
  It MUST NOT return an aggregate result merging data from multiple tenants.
Implement as an integration test covering at least: job scheduler, inbox
consumer, and one Flowable external-worker stub.
```
`verifiable_as: test`

---

### Additional AC: Keycloak claim validation (FR-7)

**AC-11** — Request with mismatched tenant claim is rejected 401/403
```
CI / integration test:
  Issue a valid JWT signed by the correct realm but with a tenant claim
  pointing to a different tenant than the request URL/context implies.
  The HTTP response MUST be 401 or 403.
  No tenant data MUST be returned.
```
`verifiable_as: test`

**AC-12** — Request with correct signature but wrong issuer is rejected
```
CI / integration test:
  Issue a JWT signed by a test key but with iss = 'https://attacker.example/realm'.
  The HTTP response MUST be 401.
```
`verifiable_as: test`

**AC-13** — Request with correct signature and iss but wrong audience is rejected
```
CI / integration test:
  Issue a JWT from the correct realm with aud = 'wrong-client-id'.
  The HTTP response MUST be 401 or 403.
```
`verifiable_as: test`

---

### Additional AC: scoped uniqueness (FR-1)

**AC-14** — Same business key is allowed in two different tenants, forbidden within one
```
CI test:
  Insert row (tenant-A, business_key='X'). Succeeds.
  Insert row (tenant-B, business_key='X'). MUST succeed (scoped uniqueness).
  Insert row (tenant-A, business_key='X') again. MUST fail with unique-constraint
  violation.
```
`verifiable_as: test`

**AC-15** — tenant_id NOT NULL is enforced at the DB layer
```
CI test:
  Attempt to insert a row into any tenant table with tenant_id = NULL using
  the migration role (bypasses RLS but not constraints).
  MUST raise a NOT NULL constraint violation.
```
`verifiable_as: test`

---

## 7. Open Items (non-blocking)

These are tracked here for implementer awareness; none require founder decision before
implementation begins.

- **Variable name for tenant context:** `app.current_tenant_id` is used throughout
  this spec as a placeholder. The exact Postgres `set_config` key MUST be agreed in
  T-0053 and consistently referenced in all RLS policy definitions, SET LOCAL calls,
  and test harness code.
- **Tenant table enumeration:** AC-2 and AC-5 reference `<list of known tenant tables>`.
  This list MUST be maintained as part of the migration discipline — every new
  migration that creates a tenant table must add it to the CI check fixture. This is
  an implementation convention, not a design ambiguity.
- **Flowable engine tables:** Flowable's own `TENANT_ID_` columns and their isolation
  semantics are out of scope (§5 above). The integration boundary (fail-closed external
  workers, AC-10) is in scope.
