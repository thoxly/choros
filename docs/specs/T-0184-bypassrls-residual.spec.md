# Spec · T-0184 — Residual BYPASSRLS reads: explicit WHERE tenant_id + pool-role fitness

**Status:** ready  
**Phase:** SPEC  
**Date:** 2026-06-11  
**Source review:** `docs/reviews/T-0141.review.md` (R-1 · role_gap_evidence)

---

## 1. Context

T-0141 closed all BYPASSRLS-class reads in `src/db/org.ts` by adding explicit
`WHERE tenant_id = $1` to every tenant-scoped query on the `choros_migrator`
(BYPASSRLS) pool. The T-0141 review (R-1) identified one surviving site of the
same class: `src/db/audit-grant-trail.ts` — `queryGrantTrail` reads
`choros.audit_event` relying **only** on the `SET LOCAL choros.tenant_id` GUC
inside `withTenant`. Because the pool role is `choros_migrator` (BYPASSRLS), RLS
is bypassed and the GUC-only guard is insufficient.

The same review documented a **test-apparatus role-mismatch** (root cause 1c):
the existing cross-tenant fitness suite (`ci/checks/db/cross_tenant.test.ts`)
proves isolation via `appUrl()` = `choros_app` (NOBYPASSRLS), but the runtime
read endpoints connect via `DATABASE_URL` = `choros_migrator` (BYPASSRLS). A
missing explicit `WHERE tenant_id` on a migrator-pool read is structurally
invisible to this suite.

---

## 2. Scope audit — GUC-only reads on the migrator pool

The following table is the **exhaustive result** of the scope analysis. Every
read-path query executed through `getOrgPool()` / a pool that resolves to
`DATABASE_URL` (= `choros_migrator`, BYPASSRLS) was checked for an explicit
`WHERE tenant_id = $1` predicate.

### 2.1 Confirmed GUC-only reads (IN SCOPE for this task)

| # | File | Line range | Function / query | Table | Issue |
|---|------|------------|------------------|-------|-------|
| R-1 | `src/db/audit-grant-trail.ts` | 169–185 | `queryGrantTrail` (SELECT) | `choros.audit_event` | No `WHERE tenant_id` clause; isolation relies solely on `SET LOCAL choros.tenant_id` GUC, which BYPASSRLS ignores |

### 2.2 Confirmed clean (explicit WHERE tenant_id present)

| File | Notes |
|------|-------|
| `src/db/org.ts` — `listOrgTree` | Fixed by T-0141 (dept/pos/emp each carry `WHERE tenant_id = $1`) |
| `src/db/org.ts` — `findEmployeeById` | Fixed by T-0141 |
| `src/db/org.ts` — `listHumanEmployees` | Fixed by T-0141 |
| `src/db/org.ts` — `isGenesisOwnerForTenant` | Has `WHERE ra.tenant_id = $1` |
| `src/db/org.ts` — `loadAdminContext` (3 queries) | All carry `WHERE … tenant_id = $1` |
| `src/http/grants.ts` — `loadRoleEffectiveGrants` | `WHERE tenant_id = $1 AND role_id = $2` |
| `src/http/grants.ts` — `assertRoleExists` | `WHERE tenant_id = $1 AND id = $2` |
| `src/http/grants.ts` — `assertEmployeeExists` | `WHERE tenant_id = $1 AND id = $2` |
| `src/http/grants.ts` — `fetchGrantRow` | `WHERE tenant_id = $1 AND id = $2` |
| `src/http/grants.ts` — `fetchRoleAssignmentRow` | `WHERE tenant_id = $1 AND id = $2` |
| `src/http/grants.ts` — `handleSecondConfirm` (SELECT) | `WHERE tenant_id = $1 AND id = $2` |

### 2.3 Intentionally unscoped (by design — not a gap)

| File | Function | Reason |
|------|----------|--------|
| `src/db/org.ts` — `resolveActorTenant` | Global slug → tenant lookup; resolves the tenant before the GUC is known. Cross-tenant by design; used only for dev-mode actor header resolution. |
| `src/db/org.ts` — `resolveTenantBySlug` | Global slug → tenant UUID lookup. Same rationale. |
| `src/db/audit-writer.ts` — GUC reads in `PgAuditWriter` | Runs inside the caller's `withTenant` tx; reads `current_setting` to source tenant_id for the preimage. Called from within a write path that already has the GUC set. No independent read hazard. |

---

## 3. Functional requirements

**FR-1.** `queryGrantTrail` in `src/db/audit-grant-trail.ts` MUST add an explicit
`WHERE tenant_id = $1` predicate to the `SELECT … FROM choros.audit_event` query,
binding the `tenantId` parameter already passed to `withTenant`.

**FR-2.** The fix MUST be additive: under a NOBYPASSRLS connection the explicit
`WHERE tenant_id = $1` is redundant but correct (RLS would already filter); no
behaviour change for the non-BYPASSRLS path.

**FR-3.** A new **pool-role fitness test** MUST prove that the `queryGrantTrail`
DAO, when called against the actual runtime pool role (`choros_migrator`,
BYPASSRLS), cannot return rows belonging to a different tenant (planted-tenant
cross-read scenario).

**FR-4.** The self-test for the new fitness check MUST demonstrate that the check
can detect a failure (it must be able to go red).

**FR-5.** All existing passing tests MUST continue to pass after the change.

---

## 4. Non-functional requirements

**NF-1.** The fix mirrors the pattern already established in `src/db/org.ts`
(T-0141): the explicit `WHERE tenant_id = $1` parameter is the `tenantId`
argument already present in the function signature — no new parameter, no
interface change.

**NF-2.** The new fitness test MUST use `migratorUrl()` (= `DATABASE_URL` =
`choros_migrator`, BYPASSRLS) as its pool — not `appUrl()` — so it exercises the
actual runtime connection role (closing the role_gap documented in R-1 / 1c).

**NF-3.** The fitness test MUST plant a second tenant with its own `audit_event`
rows, then prove zero cross-read from within tenant A's context.

**NF-4.** The fitness test file belongs in `ci/checks/db/` alongside the existing
DB-gated checks. It requires a live DB (`DATABASE_URL`) and MUST `SKIP` gracefully
(not fail) when `DATABASE_URL` is absent.

**NF-5.** No changes to `ci/checks/known_tenant_tables.txt`, no DDL, no new
migrations. The fix is pure application-layer (SQL query text only).

---

## 5. Out of scope

- **Stage-2 candidate:** Migrating the read pool from `choros_migrator`
  (BYPASSRLS) to `choros_app` (NOBYPASSRLS) as the long-term structural fix.
  This would make RLS the primary guard and the explicit `WHERE tenant_id` the
  defence-in-depth layer. This is the right long-term direction but requires
  splitting `DATABASE_URL` into separate migrator/app URLs in the runtime config
  (previously tracked as T-0022 / `APP_DATABASE_URL`). Explicitly deferred to
  a follow-up task; not part of this task.
- Changes to grant-trail HTTP endpoint behaviour (routing, filters, pagination,
  error codes).
- Changes to `audit-writer.ts` (write path; GUC usage there is correct).
- Changes to `resolveActorTenant` / `resolveTenantBySlug` (intentionally global;
  already documented in T-0141 ADR §7).
- Closing the role_gap in other `ci/checks/db/` tests — this task adds one new
  migrator-pool fitness check only for the grant-trail DAO.

---

## 6. Acceptance criteria

### AC-1 — Fix present in audit-grant-trail.ts (test)

`src/db/audit-grant-trail.ts`, function `queryGrantTrail`: the SQL string passed
to `client.query()` MUST contain a `WHERE … tenant_id = $` predicate that binds
the `tenantId` argument (i.e., `tenant_id` appears in the WHERE clause as a
bound parameter, not only in the GUC `SET LOCAL`).

**Verifiable as:** test  
Static fitness check (grep on source) confirms presence of `WHERE.*tenant_id`
in the query string inside `queryGrantTrail`.

### AC-2 — Cross-tenant isolation via migrator pool (test / DB-gated)

A new fitness test in `ci/checks/db/` using `migratorUrl()` (BYPASSRLS pool):

1. Plants `audit_event` rows under TENANT_A and TENANT_B (via migrator, same
   pattern as `cross_tenant.test.ts`).
2. Calls `queryGrantTrail(pool, TENANT_A, {})` where `pool` connects via
   `migratorUrl()`.
3. Asserts that ALL returned rows have `tenant_id = TENANT_A` (zero TENANT_B
   rows in the result).

**Verifiable as:** test (DB-gated, skips gracefully when `DATABASE_URL` absent)

### AC-3 — Self-test: check can fail (fitness)

The fitness test from AC-2 MUST include a `SELF-TEST` block that verifies the
check can go red. The self-test plants a TENANT_B row, calls the DAO without the
WHERE fix (using a raw SQL probe that omits `WHERE tenant_id`), and asserts that
the raw query CAN return the TENANT_B row — confirming that the planted data is
visible to the migrator role and that the only thing preventing cross-read is the
explicit `WHERE tenant_id`.

**Verifiable as:** fitness (self-test marker in file; assertion logic present)

### AC-4 — Existing tests unbroken (test)

`npm test` (vitest) continues to pass with no regressions after the fix. The
existing `grant-trail.adversarial.test.ts`, `grant-trail.e2e.test.ts`, and all
frozen e2e suites remain green.

**Verifiable as:** test

### AC-5 — Static fitness check: WHERE clause presence in source (fitness)

A static (no-DB) shell fitness check (`ci/checks/`) confirms that the
`queryGrantTrail` function body contains `WHERE.*tenant_id` via a grep probe. The
check exits non-zero if the predicate is absent (regression guard). The check
MUST include a `# SELF-TEST` section that verifies failure when the clause is
absent from a synthetic source string.

**Verifiable as:** fitness (static, no DB required)

### AC-6 — TypeScript compiles cleanly (fitness)

`npx tsc --noEmit` exits 0 after the change. No new type errors introduced.

**Verifiable as:** fitness (static)

---

## 7. Self-test discipline (AC-3 / AC-5 detail)

All new fitness checks in this task MUST carry a `# SELF-TEST` (shell) or
`SELF-TEST` comment (TS) section that:

- For **AC-3 (DB-gated TS test):** inserts a tenant_B audit_event row, runs a
  raw SELECT without `WHERE tenant_id` via the migrator pool, and asserts the row
  IS visible (i.e., the BYPASSRLS pool really does see all rows without a WHERE
  — proving the fix is load-bearing).
- For **AC-5 (static shell):** passes a synthetic source string that lacks
  `WHERE.*tenant_id` through the grep and asserts the grep fails (i.e., the
  check correctly detects absence).

---

## 8. Blocking questions

None. The scope is fully determined by the review finding and the codebase audit.
Implementation approach is clear (mirror the T-0141 org.ts pattern). No
founder-level ambiguity.
