# ADR · T-0141 — Демо-тенант showcase на dev: витрина в кликабельном слайсе

**Status:** ready
**Phase:** DESIGN (architect)
**Date:** 2026-06-11
**Spec:** `docs/specs/T-0141-demo-tenant.spec.md` (18 AC)
**Authoritative frame:** `playbooks/demo-stand.md` §SP-2 (founder 2026-06-11) — invariants I-1…I-5
**Depends on:** T-0140 DONE (`seed/showcase/pack.json`, `seed/importer.ts`, `src/http/seed-write.ts`)
**Runtime target:** local/dev-container (`CHOROS_AUTH_MODE=dev`, `X-Dev-User`). No external resource.

---

## 0. Load-bearing code anchors (coder/tester: read before implementing)

These lines are the exact mechanism seams T-0141 must extend — not re-implement.

| Claim | File:line |
|---|---|
| `DEV_TENANT_ID` hardcoded fallback in `listOrgTree` / `findEmployeeById` / `listHumanEmployees` calls | `src/http/org.ts:133`, `src/http/org.ts:146`, `src/http/org.ts:167` — all call `getOrgPool(), DEV_TENANT_ID` |
| `DEV_TENANT_ID` export in db layer | `src/db/org.ts:43` — `export const DEV_TENANT_ID = process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001"` |
| `X-Dev-User` header constant | `src/http/auth.ts:29` — `export const DEV_USER_HEADER = "x-dev-user"` |
| `listSelectableUsers` DB path | `src/http/org.ts:166-167` — `return listHumanEmployees(getOrgPool(), DEV_TENANT_ID)` — hardcoded DEV_TENANT_ID |
| `GET /api/rights` serves RIGHTS_SEED exclusively | `src/http/rights.ts:163-167` — no DB/pack-file path yet |
| `GET /api/processes` serves PROCESSES_SEED exclusively | `src/http/processes.ts:139-142` — no DB/pack-file path yet |
| `seed apply/reset` CLI exists | `seed/cli.ts` (T-0140 DONE) — not yet run against live dev DB |

---

## 1. Decision (one paragraph)

T-0141 wires four minimal shims onto the T-0140 infrastructure: **(A)** resolve the actor's tenant from DB instead of the hardcoded `DEV_TENANT_ID` fallback — a `resolveActorTenant(slug) → tenantId` helper that reads `choros.employee WHERE slug=$1` without RLS (pool role is `BYPASSRLS` migrator, same pattern as `GET /api/tenants/:slug` in `seed-write.ts:632`) and is injected into `listOrgTree`, `findEmployeeById`, `listHumanEmployees` with a graceful fallback to `DEV_TENANT_ID` when `DATABASE_URL` is absent or the actor is unknown; **(B)** pack-file-serve path for `GET /api/rights` and `GET /api/processes`: when `DATABASE_URL` is set, load `seed/showcase/pack.json` (the same pack T-0140 already reads), extract `rights_cards` / `process_instances`, and return them in the existing response shape — the `RIGHTS_SEED` / `PROCESSES_SEED` in-memory constants remain unchanged as the no-DB fallback (I-2: single source for DB-backed path, fallback still exists for no-DB path); **(C)** apply the showcase seed to the live dev DB (`node seed/cli.js apply`) as a one-time operational step documented in the runbook (AC-17 / FR-1); **(D)** CI smoke that runs seed apply + endpoint count assertions without a live DB — using the pack-file-serve path for rights/processes and a test-double for org. Agent personas are **not** added to the login picker (Option A, FR-7); the AC-12 founder note is preserved in the acceptance walkthrough.

---

## 2. Mechanism — the three decisions that carry the design

### 2.1 Tenant scoping: actor-derived tenantId, DEV_TENANT_ID as fallback

**The gap (confirmed from code):** `src/http/org.ts:133,146,167` calls `listOrgTree`, `findEmployeeById`, `listHumanEmployees` with `DEV_TENANT_ID` hardcoded. This means `GET /api/org` with `X-Dev-User: e-kravtsova` returns data from the genesis-owner's dev silo, not the showcase tenant — violating AC-2/AC-3/AC-13.

**Mechanism selected:** A lightweight `resolveActorTenant(pool, actorSlug): Promise<string>` helper in `src/db/org.ts` (or `src/http/org.ts`):

```
SELECT e.tenant_id FROM choros.employee WHERE slug = $1 LIMIT 1
```

This query runs on the pool without setting the tenant GUC (pool role is `choros_migrator` BYPASSRLS — same precedent: `seed-write.ts:181-195` uses `lookupClient.query` without GUC for the slug-lookup during 409 response). It returns the UUID of the tenant that owns the employee. If the slug is not found (actor not in DB) or `DATABASE_URL` is absent → fall back to `DEV_TENANT_ID` (preserves existing dev-no-db and pre-apply behavior). The result is threaded into `listOrgTree(pool, tenantId)`, `findEmployeeById(pool, tenantId, slug)`, `listHumanEmployees(pool, tenantId)` calls.

**Minimal shim, not a refactor:** The frozen-export constraint (`src/http/org.ts` comment: "FROZEN EXPORTS: findEmployee, listSelectableUsers, registerOrgRoutes") means we cannot change the public signatures of `findEmployee(employeeId)` or `listSelectableUsers()`. The tenant resolution happens *inside* these functions: `findEmployee` already receives `employeeId`=the actor slug; it performs `resolveActorTenant(pool, employeeId)` internally before calling `findEmployeeById`. `listSelectableUsers` similarly resolves tenant from the session — but `/api/users` does not carry an actor identity (it is the pre-login endpoint). **Decision for `/api/users`:** resolve tenant from `DATABASE_URL`-backed approach: if DB present, `listHumanEmployees(pool, tenantId)` where `tenantId` is derived from the `SHOWCASE_TENANT_SLUG` env var (`showcase` default) OR from a new `DEMO_TENANT_SLUG` env var (defaulting to `showcase`). This keeps the login picker pointed at the showcase tenant without requiring an X-Dev-User header that hasn't been set yet. The `DEMO_TENANT_SLUG` is resolved to a UUID once via `resolveActorTenant` with a slug-based lookup: `SELECT id FROM choros.tenant WHERE slug = $1`.

**AC-13 satisfaction:** after this shim, `GET /api/org` with `X-Dev-User: e-kravtsova` resolves to the showcase tenant UUID, not `DEV_TENANT_ID`. The DB query is tenant-scoped via the GUC inside `withTenant`. Cross-tenant leakage is structurally impossible (RLS + GUC).

### 2.2 Display-plane serve: pack-file-serve for rights and processes

**The gap:** `GET /api/rights` (`src/http/rights.ts:163`) serves `RIGHTS_SEED` only — no pack-file path. `GET /api/processes` (`src/http/processes.ts:139`) serves `PROCESSES_SEED` only. The pack (T-0140 ADR §2.2) defined `rights_cards` and `process_instances` as display-plane, served from the pack file without DB writes.

**Mechanism:** When `DATABASE_URL` is set (pack-backed mode), both handlers load `seed/showcase/pack.json` via a tiny synchronous `loadShowcasePack()` helper (reads file, parses JSON — no schema re-validation at runtime, validation is CI-time FF-1) and return `pack.rights_cards` / `pack.process_instances` in the existing response shape:

- `GET /api/rights` → `{ roles: pack.rights_cards }` (shape: `Role[]` — each element has `id=role_slug`, `name`, `dept`, `scope`, `holders`, `grants`, `fields`; see rights.ts type definition `src/http/rights.ts:14-39`)
- `GET /api/processes` → `{ instances: pack.process_instances }` (shape: `ProcessInstance[]` — `src/http/processes.ts:16-25`)

When `DATABASE_URL` is absent → serve `RIGHTS_SEED` / `PROCESSES_SEED` as today (no behavior change). This is an **additive, one-branch shim** that preserves the no-DB fallback (I-2 / spec §4.5).

**Pack path:** `seed/showcase/pack.json` relative to the process CWD. The importer already reads it the same way (`seed/importer.ts` via `loadPack`). A `PACK_DIR` env var can override the base path if needed (coder decision).

**Response shape contract:** `GET /api/rights` must return a JSON array of objects with at least `{ role_slug, name, grants }` (AC-11). The existing `RIGHTS_SEED` `Role` type has `id` (not `role_slug`) and `name`/`grants`. **Resolution:** the pack's `rights_cards[].role_slug` is mapped to `id` in the response (i.e., `id = role_slug`) for backwards-compat with the existing frozen e2e test shape. This is a 1-field alias in the serve handler, not a schema change.

### 2.3 Seed apply on live dev DB: operational step + CI boundary

**FR-1 / AC-1:** `seed apply --tenant showcase --pack showcase` must succeed against the live dev DB. T-0140 implemented the CLI and endpoints; T-0141 provides:

1. **The operational step** (one-time): `node seed/cli.js apply --tenant showcase --pack showcase --base-url http://localhost:8080` — documented in the repo runbook (AC-17). This is idempotent (409=no-op), safe to re-run.
2. **The reset step** (AC-14/AC-15): `node seed/cli.js reset --tenant showcase` — already implemented by T-0140; T-0141 verifies it works end-to-end and documents it.
3. **CI boundary:** The CI smoke tests (FF-APPLY-1) run `seed apply` + endpoint assertions against a migrated test DB (as in T-0140 FF-9). Live-DB probes (`ci/checks/db-probe`) require a running DB and are gated separately. Unit/integration tests that do not need a running DB (FF-PACK-2, FF-SCOPE-3, FF-DISPLAY-4) run always.

### 2.4 Login picker: FR-3 / AC-4 — DEMO_TENANT_SLUG-scoped /api/users

`GET /api/users` is the pre-login endpoint; it has no `X-Dev-User` header. Current path: `listSelectableUsers()` → `listHumanEmployees(getOrgPool(), DEV_TENANT_ID)`. After T-0141: `listHumanEmployees(getOrgPool(), resolvedDemoTenantId)` where `resolvedDemoTenantId` = result of `SELECT id FROM choros.tenant WHERE slug = $1` with `$1 = DEMO_TENANT_SLUG env (default: "showcase")`. When DB absent → DEV_TENANT_ID fallback. This returns the 7 human employees (or ≥ 6, NF-5) from the showcase tenant, satisfying the login picker. Agent employees remain excluded (FR-7 / Option A).

---

## 3. Object model — new entities and contracts

### 3.1 New helpers (not exported as new public API — internal extensions)

| Helper | Location | Signature |
|---|---|---|
| `resolveActorTenant` | `src/db/org.ts` | `(pool: Pool, actorSlug: string) => Promise<string>` — returns tenant UUID or `DEV_TENANT_ID` fallback |
| `resolveTenantBySlug` | `src/db/org.ts` | `(pool: Pool, tenantSlug: string) => Promise<string>` — used for `DEMO_TENANT_SLUG` resolution in `/api/users` |
| `loadShowcasePack` | `src/http/pack-serve.ts` (new thin module) | `() => Pack` — reads `seed/showcase/pack.json`, no schema re-validation at runtime |

### 3.2 Env vars (new, documented in runbook)

| Var | Default | Purpose |
|---|---|---|
| `DEMO_TENANT_SLUG` | `showcase` | Tenant slug used by `/api/users` (pre-login picker) and display-plane serve |
| `PACK_DIR` | `seed` | Base directory for pack files (optional override for CI) |

### 3.3 Frozen exports — compatibility contract (FE-W23-0008)

The following symbols are imported by other modules and MUST NOT change signature:

| Symbol | Importers | Contract |
|---|---|---|
| `findEmployee(employeeId: string)` | `src/http/auth.ts:494`, `src/http/inbox.ts` | Signature unchanged — internal tenant resolution is added transparently |
| `listSelectableUsers()` | `src/http/auth.ts:467` | Signature unchanged — demo-tenant scope added internally |
| `registerOrgRoutes(router, _store?)` | `src/server.ts` | Signature unchanged |

### 3.4 API routes — updated behavior (no new routes)

| Route | Before T-0141 | After T-0141 |
|---|---|---|
| `GET /api/org` | Serves DEV_TENANT_ID data | Serves actor's tenant data (resolveActorTenant fallback to DEV_TENANT_ID) |
| `GET /api/users` | Serves DEV_TENANT_ID humans | Serves DEMO_TENANT_SLUG humans (fallback DEV_TENANT_ID) |
| `GET /api/rights` | Serves RIGHTS_SEED always | Serves pack.rights_cards when DB present; RIGHTS_SEED otherwise |
| `GET /api/processes` | Serves PROCESSES_SEED always | Serves pack.process_instances when DB present; PROCESSES_SEED otherwise |

No new routes are added (AC-5 / AC-6 / AC-7 / AC-8 / AC-10 use existing routes).

### 3.5 Display-plane serve shape mapping

`rights_cards` → `Role` shape:
```
pack.rights_cards[i].role_slug  → role.id
pack.rights_cards[i].name       → role.name
pack.rights_cards[i].dept       → role.dept
pack.rights_cards[i].scope      → role.scope
pack.rights_cards[i].holders    → role.holders   (same type)
pack.rights_cards[i].grants     → role.grants    (same type: {res,uri,ops,scope})
pack.rights_cards[i].fields     → role.fields    (same type: {name,a})
```

`process_instances` → `ProcessInstance` shape: verbatim (pack shape = ProcessInstance type per T-0140 ADR §3.10 / `src/http/processes.ts:16-25`).

---

## 4. Contracts — API signatures and test probes

### 4.1 Test probes without live DB (unit/integration — always runnable in CI)

These tests verify the shim logic without a running database:

```
// probe 1: resolveActorTenant falls back when DB absent
TEST: DATABASE_URL unset → resolveActorTenant(pool, "any-slug") returns DEV_TENANT_ID
// probe 2: pack-serve returns correct counts when pack present
TEST: loadShowcasePack() → rights_cards.length === 8, process_instances.length === 8
// probe 3: response shape mapping
TEST: mapRightsCard(pack.rights_cards[0]) → has id, name, grants fields
// probe 4 (self-test): FF check can fail
TEST: if rights_cards.length !== 8, FF-PACK-2 exits non-zero
```

### 4.2 Live-DB probes (require running dev DB — conditional CI gate)

These probes run in the `fitness:db` CI stage after `seed apply`:

```
probe:db:1  GET /api/tenants/showcase       → 200 { id: uuid, slug: "showcase" }       (AC-1)
probe:db:2  GET /api/org (X-Dev-User: e-kravtsova) → departments.length === 3          (AC-2/AC-3)
probe:db:3  GET /api/users               → users.length >= 6, all have id/name/position/department (AC-4)
probe:db:4  GET /api/rights              → roles.length === 8, roles[*].{id,name,grants} present (AC-11)
probe:db:5  GET /api/processes           → instances.length === 8, instances[*].{id,name,status,progress} (AC-18)
probe:db:6  GET /api/org (X-Dev-User: e-kravtsova) → no department with id matching DEV_TENANT_ID data (AC-13)
probe:db:7  seed reset + GET /api/org    → departments.length === 3 (AC-14)
probe:db:8  seed reset + employees check → e-owner row present (AC-15)
```

### 4.3 AC-12 founder gate note (preserved from spec, no code required)

> **AC-12 (Option A):** Agent employees are NOT included in `GET /api/users` response. This is the selected default (FR-7). If the founder requires agent-persona login for the demo walkthrough, record as a blocking note before final gate sign-off; no code change is required for the gate itself.

---

## 5. Fitness functions (CI-enforced architecture boundaries)

| id | rule | ci_check |
|---|---|---|
| **FF-APPLY-1** | `seed apply` on clean migrated DB exits 0; `GET /api/org` → 3 depts / 7 positions / 12 employees; `GET /api/rights` → 8 role cards; `GET /api/processes` → 8 instances. Self-test: assert count mismatches produce non-zero exit. | `ci/checks/demo/seed-apply-smoke.sh` — runs apply, then asserts counts via curl; test also includes a deliberate wrong-count assertion that must fail; wired in `npm run seed:smoke`. Covers AC-1/AC-2/AC-3/AC-11/AC-18 / FR-1. |
| **FF-PACK-2** | Pack-file-serve path: when `DATABASE_URL` is set and `seed/showcase/pack.json` is present, `GET /api/rights` returns `rights_cards.length === 8` and `GET /api/processes` returns `process_instances.length === 8`. | `ci/checks/demo/pack-serve-counts.sh` — starts the server with `DATABASE_URL` and a mock pack path, asserts counts; includes a "wrong-pack" test that must fail with non-zero exit. Covers FR-9 / FR-10 / AC-11 / AC-18. |
| **FF-SCOPE-3** | Tenant scoping: `GET /api/org` with `X-Dev-User` of a showcase-tenant employee does NOT return any department with `id` matching the genesis-owner's dev silo structure. | `ci/checks/demo/no-cross-tenant-org.sh` (live-DB gate) — asserts the org response contains showcase dept slugs and does not contain known DEV_TENANT_ID dept slugs. Covers AC-13 / NF-4. |
| **FF-DISPLAY-4** | Display-plane serve does not perform DB writes: `src/http/pack-serve.ts` (and any usage in rights.ts / processes.ts) must not import `pg` and must not call any function from `src/db/*`. | `ci/checks/demo/pack-serve-no-write.sh` — `grep -E "from ['\"]pg['\"]\|from ['\"].*src/db" src/http/pack-serve.ts src/http/rights.ts src/http/processes.ts` must return zero matches. Covers I-1 / T-0140 FF-7. |
| **FF-FROZEN-5** | Frozen exports not broken: `findEmployee`, `listSelectableUsers`, `registerOrgRoutes` signatures in `src/http/org.ts` remain unchanged after T-0141 changes. | `ci/checks/demo/frozen-exports.sh` — `grep -n "export.*findEmployee\|export.*listSelectableUsers\|export.*registerOrgRoutes" src/http/org.ts` must match 3 lines with identical parameter signatures to the pre-T-0141 baseline (regex-checked). Covers FE-W23-0008. |
| **FF-FALLBACK-6** | Dev-no-DB fallback preserved: when `DATABASE_URL` is absent, `GET /api/org` / `GET /api/users` / `GET /api/rights` / `GET /api/processes` all return 200 with non-empty data (served from in-memory seeds). | `ci/checks/demo/no-db-fallback.sh` — starts server without `DATABASE_URL`, asserts all four endpoints return 200 + non-empty arrays. Covers NF-1 / spec §4.5 (RIGHTS_SEED/PROCESSES_SEED fallback retained). |
| **FF-ACTOR-7** | `resolveActorTenant` never hard-codes a UUID or slug: `src/db/org.ts` must not contain any literal UUID matching `a0000000-0000-0000-0000-000000000001` in the `resolveActorTenant` / `resolveTenantBySlug` function bodies (the fallback is allowed only via `DEV_TENANT_ID` constant, not inline). | `ci/checks/demo/no-hardcoded-tenant.sh` — grep the two function bodies for the literal dev UUID; any match fails. Covers AC-13 / T-0013 isolation invariant. |
| **FF-SELFTEST-8** | Each FF smoke script includes at least one deliberately-failing assertion to verify the check can detect regressions. | Enforced by code review rule (ADR §5 note): each `ci/checks/demo/*.sh` must contain a comment `# SELF-TEST: ...` line followed by an assertion that checks for a wrong expected value and asserts failure. Covered by `ci/checks/demo/self-test-presence.sh` which greps each check script for the `SELF-TEST` marker. |

---

## 6. Traceability (AC → design locus)

| AC | covered_by |
|---|---|
| AC-1 | §2.3 seed-apply operational step; FF-APPLY-1 |
| AC-2 | §2.1 resolveActorTenant → listOrgTree; FF-APPLY-1/FF-SCOPE-3 |
| AC-3 | §2.1 resolveActorTenant → listOrgTree counts; FF-APPLY-1 |
| AC-4 | §2.4 DEMO_TENANT_SLUG → listHumanEmployees; §4.2 probe:db:3 |
| AC-5 | §2.4 login screen populated from /api/users (existing flow, no new UI) |
| AC-6 | §3.4 GET /api/org post-login; §4.2 probe:db:2 |
| AC-7 | §2.2 GET /api/processes pack-file-serve; FF-PACK-2; §4.2 probe:db:5 |
| AC-8 | §2.2 GET /api/rights pack-file-serve; FF-PACK-2; §4.2 probe:db:4 |
| AC-9 | §3.4 GET /api/audit — existing route; no new logic (empty is acceptable) |
| AC-10 | §3.4 GET /api/inbox — existing route; tenant-scoped when DB present |
| AC-11 | §2.2 pack-file-serve rights_cards; §3.5 shape mapping; FF-PACK-2; §4.2 probe:db:4 |
| AC-12 | §1 Option A selected; §4.3 founder gate note preserved |
| AC-13 | §2.1 resolveActorTenant; FF-SCOPE-3; §4.2 probe:db:6 |
| AC-14 | §2.3 seed reset operational step; §4.2 probe:db:7 |
| AC-15 | §2.3 e-owner exclude-list (T-0140 reset impl); §4.2 probe:db:8 |
| AC-16 | Existing dev-login flow (logout → picker re-appears); no new code |
| AC-17 | §2.3 runbook documentation; §3.2 env vars |
| AC-18 | §2.2 GET /api/processes pack-file-serve; FF-PACK-2; §4.2 probe:db:5 |

---

## 7. Rejected alternatives

- **New `/api/org?tenant=<slug>` query param for tenant selection** — rejected: changes the API surface consumed by the frozen e2e tests and the React frontend (`screen-org.jsx`); breaks AC-13 (caller controls tenant, not actor identity = leakage risk). Actor-derived tenant is the correct authority-respecting shape.
- **Global `TENANT_ID` env override** — rejected: single-tenant assumption breaks the multi-tenant-first data model (T-0013); the showcase tenant must be scoped to the actor, not to the process.
- **New DB table `demo_personas` to configure the picker** — rejected: over-engineered; `DEMO_TENANT_SLUG` env var + `listHumanEmployees` query is three lines; table adds schema without proportionate value (rubric axis 5).
- **Remove RIGHTS_SEED / PROCESSES_SEED constants** — rejected: spec §4.5 explicitly preserves in-memory fallbacks; T-0140 I-2 designates them as the single permitted second locus; spec §4 Out-of-scope item 5. FF-FALLBACK-6 enforces this.
- **Runtime JSON Schema re-validation of pack on every request** — rejected: expensive; pack is immutable in a running process; validation is CI-time (T-0140 FF-1). Pack loaded once per process start (or lazily cached).
- **Add agent employees to /api/users (Option B)** — rejected: spec selects Option A; founder note preserved in AC-12. Any change requires founder product-direction call.

---

## 8. Escalation

**Status: `ready`** — no blocking escalation. One preserved founder note:

**AC-12 / FR-7:** Agent personas (Option A selected) are excluded from the login picker. This is the spec default and is gate-sufficient. If the founder wants agent-persona login for the demo, this requires a product-direction decision (Option B: add agents to `/api/users` or a separate endpoint). No code change is required for the gate. This note is preserved in the walkthrough per spec §5 AC-12 and must be surfaced to the founder at gate sign-off if agent login is wanted before T-0142.

---

## 9. CI strategy: which tests run without live DB vs. live-DB probes

| Test type | DB required | CI stage | What it covers |
|---|---|---|---|
| FF-PACK-2 (pack-serve counts) | No (mock pack path) | always | FR-9/FR-10, AC-11/AC-18 |
| FF-DISPLAY-4 (no-write guard) | No | always | I-1 exception fence |
| FF-FROZEN-5 (export signatures) | No | always | FE-W23-0008 |
| FF-FALLBACK-6 (no-DB fallback) | No | always | NF-1, in-memory fallback |
| FF-ACTOR-7 (no hardcoded UUID) | No | always | AC-13 static check |
| FF-SELFTEST-8 (self-test markers) | No | always | all FF checks can detect regressions |
| FF-APPLY-1 (seed apply smoke) | Yes (test DB) | fitness:db | FR-1, AC-1/2/3/11/18 |
| FF-SCOPE-3 (no cross-tenant) | Yes (test DB) | fitness:db | AC-13, NF-4 |
| probe:db:3..8 (endpoint probes) | Yes (test DB) | fitness:db | AC-4..18 live assertions |

The `fitness:db` gate requires `DATABASE_URL` to be set; it is wired after `npm run migrate` in the CI pipeline, identical to the T-0140 FF-9 smoke gate.
