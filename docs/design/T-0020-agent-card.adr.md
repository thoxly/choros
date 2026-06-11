# ADR · T-0020 — Agent Card Schema (dormant)

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-11
**Spec:** `docs/specs/T-0020-agent-card.spec.md` (status: ready, AC-1..AC-17) · `docs/specs/T-0020.spec.contract.json`
**Foundation (do NOT contradict):**
- `docs/design/T-0013-tenant-isolation.adr.md` — FORCE RLS, default-DENY, tenant_id leading PK, choros_app NOBYPASSRLS.
- `docs/design/T-0115-tenant-rls.adr.md` — `ci/checks/known_tenant_tables.txt` CI invariant; new tenant table MUST be added.
- `docs/design/T-0054-keycloak-compose.adr.md` — agent service-account clients in realm-choros.json; linkage key = `employee.slug` ↔ KC `clientId` (§3.5).
- `migrations/016_employee.sql` (T-0017) — `employee` table; `kind IN ('human','agent')`; 5 agent rows seeded.
- `migrations/031_grant_confirmed2_by.sql` (T-0044) — migration 031 occupied; T-0020 uses **032**.

> This ADR is a **REAL migration** design. Postgres is live on this base (migrations
> 001–031 applied on dev). T-0020 emits **`migrations/032_agent_card.sql`** plus an
> additive `ci/checks/known_tenant_tables.txt` entry. It fixes the *invariants, object
> model, contracts, and fitness functions* any correct implementation MUST satisfy; the
> **coder** writes the SQL/grants/triggers/seed and the frozen contract fixtures.
>
> Each fitness function carries a concrete `ci_check` and a gating note:
> **static-now** = runs in today's `npm run ci` (tsc/eslint + `ci/checks/*` shell lints);
> **live-DB** = live-Postgres probe wired into `fitness:db` (`vitest run --dir
> ci/checks/db`) / the migration CI job.

---

## 1. Decision

One new tenant table **`agent_card`** (migration 032) holds the per-agent LLM
configuration and control parameters. It is a standard T-0013 tenant table (`tenant_id`
NOT NULL **leading PK column**, `ENABLE`+`FORCE` RLS, default-DENY policy on
`choros.tenant_id`, `choros_app NOBYPASSRLS`, all access via `withTenant`). The table is
**schema-layer only on day-1**: its columns are stored and writable (by the provisioning
path T-0042), but no Choros runtime component reads or enforces them. The runtime that
consumes `autonomy_threshold`, `budget_policy_id`, and `llm_secret_handle` at call-time
is Stage-2 (E5.7/E5.9/E5.10). The dormancy invariant is enforced by FF-6 (grep gate).

The `kind='agent'` constraint (FR-2) is enforced by a **BEFORE INSERT OR UPDATE trigger**
on `agent_card` that checks `employee.kind` of the referenced row: if it is not `'agent'`
the trigger raises `foreign_key_violation`. This is the correct pattern because Postgres
does not support FK constraints targeting a partial index; the trigger provides the same
semantic guarantee at the cost of one extra lookup per write (acceptable — agent_card
writes are rare provisioning events, not hot-path operations).

`budget_policy_id` is declared `uuid NULL` **without FK constraint** — the `instance_budget`
table (T-0023) may not exist at migration time, and a FK to a non-existent table fails.
T-0023 or a follow-up migration adds the FK when the target table is created. Similarly,
`escalation_rule_id` is `uuid NULL` without FK — the `escalation_rule` table is Stage-2.
Both columns accept any UUID or NULL today; the FK guards are deferred.

The `kc_client_id` column is the **authoritative KC ↔ agent_card linkage key** (frozen
seam for T-0042/T-0024/T-0043/T-0060): `employee.slug` identifies the agent in Choros;
`agent_card.kc_client_id` holds the KC `clientId` of the service-account client. For the
three agents in `realm-choros.json` (`agent-recon`, `agent-invoice`, `agent-triage`) the
link is exact. For `s-ledger` and `s-ocr` (service workers without KC clients in T-0054),
the seed uses the employee slug as a placeholder `kc_client_id`; T-0042 owns creating KC
clients for them.

---

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| **Columns on `employee` (Option A)** | Every human row carries 7 nullable agent-only columns; schema intent muddier; the FK targets for `budget_policy_id`/`escalation_rule_id` would sit on the table that owns the isolation invariant. The backlog's own SQL signature `agent_card(employee_id, …)` and the D-C model ("per-agent card") both confirm a distinct entity. Explicitly resolved in spec §0. |
| **Partial unique index as FK target** | Postgres 16 does not support FK constraints referencing a partial index (`CREATE UNIQUE INDEX ... WHERE kind='agent'` as FK target raises an error). The trigger approach is the standard pattern for polymorphic FK constraints. |
| **Runtime-enforced dormancy (feature flag / env var)** | A runtime flag can be toggled by mistake; a grep-based CI fitness check is structural and cannot be bypassed without a CI-visible diff. Static check is lower complexity and higher reliability. |
| **`CHECK (kind='agent')` on agent_card.employee_id** | A plain `CHECK` constraint cannot cross-reference another table's column — it would be a constant `true`. Triggers are the correct mechanism for cross-table invariants. |

---

## 3. Object model

### 3.1 `agent_card` — tenant-isolated, per-agent configuration card

PK: `(tenant_id, employee_id)` — one card per agent employee.
Unique: `(tenant_id, kc_client_id)` — one KC service-account per card per tenant.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `tenant_id` | `uuid NOT NULL` | No | Leading PK; FK→`employee(tenant_id, id)` tenant side; T-0013 leading convention. |
| `employee_id` | `uuid NOT NULL` | No | FK→`employee(tenant_id, id)`; kind='agent' enforced by trigger (FR-2). |
| `kc_client_id` | `text NOT NULL` | No | KC `clientId` of the agent's service-account client. UNIQUE per tenant. Frozen seam for T-0042/T-0024/T-0043/T-0060. |
| `llm_endpoint` | `text NULL` | Yes | BYO-LLM base URL. NULL = not configured. Stage-2 runtime. |
| `llm_model` | `text NULL` | Yes | Model identifier. NULL = not configured. Stage-2 runtime. |
| `llm_secret_handle` | `text NULL` | Yes | RL-3 opaque handle; NOT a raw API key (T-0025 owns lifecycle). Min accepted length: 512 chars. |
| `autonomy_threshold` | `numeric(5,4) NULL` | Yes | [0.0–1.0] CHECK; NULL = not enforced (dormant). |
| `budget_policy_id` | `uuid NULL` | Yes | Future FK→`instance_budget` (T-0023); no FK at day-1. |
| `escalation_rule_id` | `uuid NULL` | Yes | Future FK→`escalation_rule` (Stage-2); no FK at day-1. |
| `created_at` | `bigint NOT NULL` | No | Unix epoch milliseconds. |
| `updated_at` | `bigint NOT NULL` | No | Unix epoch milliseconds. |

### 3.2 `choros.agent_card_check_employee_kind()` — enforcement function

A `BEFORE INSERT OR UPDATE OF employee_id` trigger function that selects `kind` from
`choros.employee WHERE tenant_id=NEW.tenant_id AND id=NEW.employee_id` and raises
`foreign_key_violation` if `kind IS DISTINCT FROM 'agent'`. Runs for all roles including
`choros_migrator` (defence in depth). The trigger is named
`agent_card_employee_kind_check`.

---

## 4. Contracts

### C-1 · Write contract (T-0042 provisioning)

When T-0042 "hires" an agent:
1. An `employee` row with `kind='agent'` MUST exist (or be created atomically in the same
   transaction) before the `agent_card` INSERT.
2. An `agent_card` row MUST be inserted for that `employee_id` with `kc_client_id`= the KC
   clientId of the newly created service-account client.
3. LLM fields and `autonomy_threshold` MAY be NULL at hire time.

### C-2 · Read contract (T-0024 invoke-grant)

When an invoke-grant check needs to verify target is an agent:
- Join `employee WHERE kind='agent'` OR probe `agent_card` for the `employee_id`.
- `kc_client_id` is available as the KC identity anchor.

### C-3 · Secret-handle column contract (T-0025)

`agent_card.llm_secret_handle text NULL` holds only opaque handles (reference, not
credential value). T-0025 owns create/rotate/revoke lifecycle. Raw API keys MUST NOT be
stored here. Column has no length constraint below 512 chars.

### C-4 · Agent-identity contract (T-0043)

`agent_card.employee_id` (tenant-scoped) is the agent identity key for toolset-from-grants
queries. `kc_client_id` maps to the JWT subject's service account.

### C-5 · KC linkage frozen seam (T-0060)

`employee.slug` → KC `clientId` → `agent_card.kc_client_id`.
KC service-account's `preferred_username` = `service-account-<clientId>` (KC 25 standard).
JWT `actor_type` claim = `"agent"` for service-account tokens (T-0054 §3.3 mapper).
T-0060 uses `service-account-<kc_client_id>` to resolve `employee` from JWT — T-0020 only
provides the column and seeds the fixture.

---

## 5. Fitness functions

### FF-1 · `migrations/032_agent_card.sql` exists and has correct structure

**Rule:** File `migrations/032_agent_card.sql` exists in the repo; contains `CREATE TABLE
choros.agent_card` with `PRIMARY KEY (tenant_id, employee_id)`, `UNIQUE (tenant_id,
kc_client_id)`, and all 11 columns listed in §3.1.

**ci_check (static-now):**
```sh
# ci/checks/agent_card_ddl.sh
set -euo pipefail
F="migrations/032_agent_card.sql"
[ -f "$F" ] || { echo "MISSING $F" >&2; exit 1; }
grep -qE 'CREATE TABLE choros\.agent_card' "$F"          || exit 1
grep -qE 'PRIMARY KEY \(tenant_id, employee_id\)'        "$F" || exit 1
grep -qE 'UNIQUE \(tenant_id, kc_client_id\)'            "$F" || exit 1
grep -qE 'tenant_id\s+uuid\s+NOT NULL'                   "$F" || exit 1
grep -qE 'employee_id\s+uuid\s+NOT NULL'                 "$F" || exit 1
grep -qE 'kc_client_id\s+text\s+NOT NULL'               "$F" || exit 1
grep -qE 'llm_endpoint'                                  "$F" || exit 1
grep -qE 'llm_model'                                     "$F" || exit 1
grep -qE 'llm_secret_handle'                             "$F" || exit 1
grep -qE 'autonomy_threshold'                            "$F" || exit 1
grep -qE 'budget_policy_id'                              "$F" || exit 1
grep -qE 'escalation_rule_id'                            "$F" || exit 1
grep -qE 'created_at'                                    "$F" || exit 1
grep -qE 'updated_at'                                    "$F" || exit 1
echo "FF-1 OK"
```
**Covers:** AC-1.

---

### FF-2 · RLS correctly configured

**Rule:** `migrations/032_agent_card.sql` contains `FORCE ROW LEVEL SECURITY` and a
policy with `current_setting('choros.tenant_id', true)::uuid`.

**ci_check (static-now):**
```sh
F="migrations/032_agent_card.sql"
grep -qE 'FORCE ROW LEVEL SECURITY' "$F" || exit 1
grep -qE "current_setting\('choros\.tenant_id', true\)" "$F" || exit 1
echo "FF-2 OK"
```
**Covers:** AC-2 (static); live verification in `fitness:db` cross-tenant test (AC-3/AC-4).

---

### FF-3 · Cross-tenant isolation at live-DB level

**Rule:** In `fitness:db` (`vitest run --dir ci/checks/db`), `cross_tenant.test.ts` iterates
`KNOWN_TENANT_TABLES` (which MUST include `agent_card`). For `agent_card`:
- SELECT in TENANT_A context with `WHERE tenant_id=TENANT_B` returns 0 rows.
- INSERT with `tenant_id=TENANT_B` in TENANT_A context is rejected.

**ci_check (live-DB):** existing `cross_tenant.test.ts` already iterates
`KNOWN_TENANT_TABLES`; adding `agent_card` to `known_tenant_tables.txt` (FF-4) is
sufficient. The `seedRowForTable` dispatcher MUST include an `agent_card` case (see §6).

**Covers:** AC-3, AC-4.

---

### FF-4 · `known_tenant_tables.txt` contains `agent_card`

**Rule:** `ci/checks/known_tenant_tables.txt` contains the line `agent_card`. Alphabetical
insertion point: after `actor_event_seq` (alphabetically: `ag` > `ac`).

**ci_check (static-now):**
```sh
grep -qxF 'agent_card' ci/checks/known_tenant_tables.txt || { echo "MISSING agent_card in known_tenant_tables.txt" >&2; exit 1; }
echo "FF-4 OK"
```
**Covers:** AC-8.

---

### FF-5 · `choros_app` DML grants (no DDL)

**Rule:** `migrations/032_agent_card.sql` contains `GRANT SELECT, INSERT, UPDATE, DELETE
ON choros.agent_card TO choros_app` and does NOT contain `GRANT ... CREATE` or `GRANT ALL`.

**ci_check (static-now):**
```sh
F="migrations/032_agent_card.sql"
grep -qE 'GRANT SELECT, INSERT, UPDATE, DELETE ON choros\.agent_card TO choros_app' "$F" || exit 1
! grep -qE 'GRANT (ALL|CREATE)' "$F" || exit 1
echo "FF-5 OK"
```
**Covers:** AC-13.

---

### FF-6 · Dormancy: no `src/` runtime code reads `agent_card`

**Rule:** No `.ts` file under `src/` (excluding `__tests__/migrations/`) imports or
references `agent_card`. The table exists; it is NOT read by any HTTP handler, PDP,
job-store, or engine guard on day-1.

**ci_check (static-now):**
```sh
# ci/checks/agent_card_dormant.sh
set -euo pipefail
HITS=$(grep -r 'agent_card' src/ --include='*.ts' \
       | grep -v '__tests__/migrations/' | wc -l)
[ "$HITS" -eq 0 ] || {
  echo "FAIL: agent_card referenced in src/ runtime code ($HITS hits):" >&2
  grep -r 'agent_card' src/ --include='*.ts' | grep -v '__tests__/migrations/' >&2
  exit 1
}
echo "FF-6 OK: agent_card dormant in src/"
```
**Covers:** AC-12 (the literal AC-12 grep gate).

---

### FF-7 · `kind='agent'` trigger present in migration

**Rule:** `migrations/032_agent_card.sql` contains a BEFORE trigger (or trigger creation)
referencing `agent_card_check_employee_kind` and is applied ON `agent_card` BEFORE INSERT
OR UPDATE.

**ci_check (static-now):**
```sh
F="migrations/032_agent_card.sql"
grep -qE 'agent_card_check_employee_kind' "$F" || exit 1
grep -qE 'BEFORE INSERT OR UPDATE.*agent_card|BEFORE.*agent_card.*INSERT OR UPDATE' "$F" || exit 1
echo "FF-7 OK"
```
**Covers:** AC-5 (structural guard present); live verification in `fitness:db` migration test.

---

### FF-8 · `autonomy_threshold` CHECK present in DDL

**Rule:** `migrations/032_agent_card.sql` contains a CHECK constraint on
`autonomy_threshold` bounding the domain to [0, 1].

**ci_check (static-now):**
```sh
F="migrations/032_agent_card.sql"
grep -qE 'autonomy_threshold.*BETWEEN 0 AND 1|autonomy_threshold >= 0.*<= 1|autonomy_threshold.*0.*1' "$F" || exit 1
echo "FF-8 OK"
```
**Covers:** AC-7 (static structure); live tested in `fitness:db`.

---

### FF-9 · `escalation_rule_id` has NO FK constraint in migration

**Rule:** `migrations/032_agent_card.sql` declares `escalation_rule_id uuid NULL` but does
NOT contain a `FOREIGN KEY ... escalation_rule` reference.

**ci_check (static-now):**
```sh
F="migrations/032_agent_card.sql"
! grep -qE 'FOREIGN KEY.*escalation_rule|REFERENCES.*escalation_rule' "$F" || {
  echo "FAIL: escalation_rule_id must NOT have FK in migration 032" >&2; exit 1
}
echo "FF-9 OK"
```
**Covers:** AC-17.

---

### FF-10 · `budget_policy_id` has NO FK constraint in migration 032

**Rule:** `migrations/032_agent_card.sql` declares `budget_policy_id uuid NULL` but does
NOT contain a `REFERENCES instance_budget` clause.

**ci_check (static-now):**
```sh
F="migrations/032_agent_card.sql"
! grep -qE 'REFERENCES.*instance_budget|FOREIGN KEY.*budget_policy' "$F" || {
  echo "FAIL: budget_policy_id must NOT have FK in migration 032 (T-0023 deferred)" >&2
  exit 1
}
echo "FF-10 OK"
```
**Covers:** AC-16.

---

### FF-11 · Dev seed present with 5 agent rows + correct `kc_client_id` values

**Rule:** `migrations/032_agent_card.sql` contains `ON CONFLICT DO NOTHING` seed for the
5 agent employees with correct `kc_client_id` values matching `realm-choros.json`.

**ci_check (static-now):**
```sh
F="migrations/032_agent_card.sql"
grep -qE 'agent-recon'   "$F" || exit 1
grep -qE 'agent-invoice' "$F" || exit 1
grep -qE 'agent-triage'  "$F" || exit 1
grep -qE 's-ledger'      "$F" || exit 1
grep -qE 's-ocr'         "$F" || exit 1
grep -qE 'ON CONFLICT DO NOTHING' "$F" || exit 1
echo "FF-11 OK"
```
**Covers:** AC-9, AC-11 (partial — seed idempotency).

---

### FF-12 · `cross_tenant.test.ts` dispatcher has `agent_card` case

**Rule:** `ci/checks/db/cross_tenant.test.ts` contains a `case 'agent_card':` branch in
the `seedRowForTable` dispatcher so the generic cross-tenant test can seed a valid row.
The seed function for `agent_card` must insert an `employee` row with `kind='agent'` first
(or reuse the pre-seeded `empIdA`/`empIdB` agent employees from the beforeAll block),
then insert an `agent_card` row with a unique `kc_client_id`.

**ci_check (static-now):**
```sh
grep -qE "case 'agent_card'" ci/checks/db/cross_tenant.test.ts || {
  echo "FAIL: missing agent_card case in cross_tenant.test.ts seedRowForTable" >&2; exit 1
}
echo "FF-12 OK"
```
**Covers:** AC-3, AC-4, AC-8 (live side of the cross-tenant invariant).

---

## 6. Coder notes: `cross_tenant.test.ts` seed dispatcher extension

The `seedRowForTable` switch in `ci/checks/db/cross_tenant.test.ts` must be extended with
an `agent_card` case. The `agent_card` row requires:
1. A pre-existing `employee` row with `kind='agent'` in the same tenant.
2. A unique `kc_client_id` per tenant (use a random suffix to avoid collision with the
   dev-silo seed already present in the DB).

Suggested pattern (reuses the `empIdA`/`empIdB` agent employees seeded in the `employee`
case, which use `kind='agent'` by convention in the existing seed helper `seedEmployeeRow`):

```typescript
case 'agent_card': {
  // Reuse the pre-seeded agent employee from the 'employee' case.
  const empId = tenantId === TENANT_A ? seedState.empIdA : seedState.empIdB;
  const kcId  = `ct-agent-${uuid().slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.agent_card
       (tenant_id, employee_id, kc_client_id, created_at, updated_at)
     VALUES ($1, $2, $3, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, empId, kcId],
  );
  break;
}
```

**IMPORTANT:** `seedEmployeeRow` currently inserts `kind='human'` (default in the helper).
The coder MUST either:
- (a) change `seedEmployeeRow` to accept a `kind` parameter and pass `'agent'` here, OR
- (b) create a separate `seedAgentEmployeeRow` helper that inserts `kind='agent'`.

Option (a) is preferred (less code duplication). Existing callers of `seedEmployeeRow` pass
no kind argument; they must be updated to pass `'human'` explicitly after the parameter
is added (backward-compatible default).

---

## 7. Traceability

| AC | Covered by |
|---|---|
| AC-1 | FF-1 (static DDL structure check) + live-DB migration test |
| AC-2 | FF-2 (static FORCE RLS + policy grep) + live-DB FORCE RLS query |
| AC-3 | FF-3 (live-DB: cross_tenant.test.ts iterates KNOWN_TENANT_TABLES) |
| AC-4 | FF-3 (same live-DB test, write isolation) |
| AC-5 | FF-7 (trigger present in DDL); live-DB: INSERT human employee_id rejected |
| AC-6 | FF-7 (trigger present); live-DB: INSERT agent employee_id accepted |
| AC-7 | FF-8 (CHECK constraint in DDL); live-DB: threshold=1.5 rejected, others accepted |
| AC-8 | FF-4 (known_tenant_tables.txt contains agent_card) + FF-12 (dispatcher case) |
| AC-9 | FF-11 (seed rows in migration) + live-DB: 5 agent_card rows after migration |
| AC-10 | FF-1 (UNIQUE clause in DDL); live-DB: duplicate kc_client_id rejected |
| AC-11 | FF-11 (ON CONFLICT DO NOTHING in seed); live-DB: idempotent run |
| AC-12 | FF-6 (grep dormancy check) |
| AC-13 | FF-5 (GRANT ... DML in DDL) + live-DB: privilege query |
| AC-14 | FF-1 + FF-2 (DDL structure); tsc/eslint/fitness all run clean |
| AC-15 | FF-1 (llm_secret_handle text NULL — no length constraint); live-DB: 512-char accepted |
| AC-16 | FF-10 (no budget_policy_id FK in migration 032) |
| AC-17 | FF-9 (no escalation_rule_id FK in migration 032) |

---

## 8. DDL-verified decisions (live Postgres proof)

The following invariants were tested on a live isolated Postgres 16 instance
(`POSTGRES_PORT=55493`) against migration 032 applied on top of migrations 001-016:

1. **`kind='agent'` trigger** (FR-2): INSERT with `kind='human'` employee rejected with
   `foreign_key_violation` — VERIFIED.
2. **`autonomy_threshold` CHECK** (NF-4): value `1.5` rejected; `0.0`, `0.5`, `1.0`, `NULL`
   all accepted — VERIFIED.
3. **UNIQUE `(tenant_id, kc_client_id)`** (AC-10): duplicate `kc_client_id` in same tenant
   rejected with `unique_violation` — VERIFIED.
4. **Dev seed (5 rows)** (AC-9): all 5 agent employees have `agent_card` rows with correct
   `kc_client_id` values — VERIFIED.
5. **`choros_app` grants** (AC-13): SELECT, INSERT, UPDATE, DELETE granted; no DDL — VERIFIED.
6. **`llm_secret_handle` 512 chars** (AC-15): accepted without error — VERIFIED.
7. **`escalation_rule_id` / `budget_policy_id` no FK** (AC-16/17): arbitrary UUIDs accepted
   without FK violation — VERIFIED.
8. **Idempotent seed** (AC-11): re-running `ON CONFLICT DO NOTHING` seed block inserts 0
   rows, no error — VERIFIED.
9. **FORCE RLS** (AC-2): `relforcerowsecurity=t` confirmed in `pg_class` — VERIFIED.

Container (isolated, single-volume) was destroyed after validation; no prod state affected.
