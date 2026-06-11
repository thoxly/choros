# ADR · T-0023 — Budget schema + reservation semantics (E4.9)

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-11
**Task:** E4.9 — `instance_budget`, `agent_budget`, `reservation` (idempotent `tool_call_id` + TTL), `spend_ledger` (append-only); two-ceiling AND-composed budget semantics
**Spec:** `docs/specs/T-0023-budget-schema.spec.md` (status: ready, AC-1..AC-23, commit 25e2358)
**Foundation (do NOT contradict):**
- `docs/design/T-0013-tenant-isolation.adr.md` — `tenant_id` leading PK, `ENABLE`+`FORCE ROW LEVEL SECURITY`, default-DENY policy `USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)`, `choros_app` NOBYPASSRLS non-owner, `SET LOCAL choros.tenant_id` contract
- `migrations/006_audit_event.sql` (T-0016) — append-only enforced two ways: (a) `GRANT SELECT, INSERT only` to `choros_app`; (b) `BEFORE UPDATE`/`BEFORE DELETE` trigger raising `ERRCODE = 'restrict_violation'` for ALL roles incl. owner. `spend_ledger` copies this pattern verbatim.
- `migrations/016_employee.sql` (T-0017) — `employee(tenant_id, id)` is the FK target for `agent_budget.employee_id` and `spend_ledger.employee_id`; agent `a-recon` = `d0000000-0000-0000-0000-000000000002`; dev tenant = `a0000000-0000-0000-0000-000000000001`.
- `migrations/021_grant_role_fk.sql` (T-0022) — pattern for an additive, named, tenant-scoped FK in its own migration file; the `agent_card` FK seam follows this shape, guarded by an existence check.

**Seam siblings (built elsewhere, not here):**
- T-0020 (E5.1) `agent_card` — declares `budget_policy_id uuid NULL` with no FK. **Live-DB fact (silo, 2026-06-11):** migration `032_agent_card` IS applied and `agent_card.budget_policy_id uuid NULL` exists with no FK yet. T-0023's guarded `ALTER TABLE ... ADD CONSTRAINT` therefore fires in the silo; on a fresh CI Postgres where `agent_card` is absent the guard skips it without error.
- E5.9 (Stage-2, UNAPPROVED) — runtime reservation enforcement; consumes these tables. Day-1 they are dormant (FR-10).

---

## 1. Decision

**Add four tenant-isolated, FORCE-RLS tables in a single migration `034_budget_schema.sql` — `instance_budget`, `agent_budget`, `reservation`, `spend_ledger` — following the T-0013 isolation pattern exactly. `spend_ledger` is append-only via the T-0016 trigger + `SELECT, INSERT`-only grant. The two-ceiling AND-gate and reserve→finalize/release lifecycle are encoded as DDL constraints (CHECK, UNIQUE, composite FK, NOT-NULL) that make the invariants enforceable without any runtime code; the balance is always reconstructable from `spend_ledger` + open `reservation` rows, with `remaining_cache` as a pure advisory column. The `agent_card.budget_policy_id → instance_budget(tenant_id, id)` FK is added in the same migration behind an existence + duplicate guard. No new TypeScript module ships (NF-5); day-1 enforcement is dormant (FR-10).**

### 1.1 One migration file (034), not two

The spec reserves slots 034 and 035. All four tables + trigger + guarded FK + dev seed fit in one ordered file with correct intra-file FK ordering (`instance_budget` → `agent_budget` → `reservation` → `spend_ledger`, all tenant-scoped composite FKs resolve within the file; `employee` is a pre-existing dependency from migration 016). A single file is the proportional choice: the migration runner (`run.mjs`) applies each file in one transaction, so all four tables + the FK land atomically — there is no partial-apply window. **Slot 035 is left unused** (reserved, not consumed); a follow-up amendment may claim it without renumbering. This honours the seam rule (034/035 are mine; 032/036+ are not) while keeping the bring-up to one path (NF-4).

### 1.2 Append-only `spend_ledger` = T-0016 pattern verbatim

`spend_ledger` reuses the exact mechanism proven by `audit_event` (migration 006), validated live in this design run:
- `GRANT SELECT, INSERT ON choros.spend_ledger TO choros_app` — **no UPDATE, no DELETE** for the runtime role (defence layer a).
- A `BEFORE UPDATE`/`BEFORE DELETE` trigger calling `choros.spend_ledger_immutable()` which `RAISE EXCEPTION ... USING ERRCODE = 'restrict_violation'` — rejects mutation for **all** roles including the table owner `choros_migrator` (defence layer b). This is what AC-7/AC-8 assert.

The other three tables (`instance_budget`, `agent_budget`, `reservation`) carry full `SELECT, INSERT, UPDATE, DELETE` because their `remaining_cache` / `status` / `finalized_at` columns are mutable by design (finalize/release transitions).

### 1.3 Invariants live in DDL, not runtime

The spec's semantic rules (FR-5) are translated to DDL so they hold without any TypeScript on day-1:
- `reservation.held > 0`, `instance_budget.ceiling > 0`, `agent_budget.ceiling > 0`, `spend_ledger.amount > 0` → CHECK constraints (AC-10, AC-13, AC-14, AC-15).
- `reservation.status IN ('open','spent','released')` → CHECK (AC-11).
- `reservation`: `instance_budget_id IS NOT NULL OR agent_budget_id IS NOT NULL` → CHECK (AC-12).
- `reservation` idempotency → `UNIQUE (tenant_id, tool_call_id)` (AC-9).
- All amounts `numeric(18,6)` (NF-2, AC-16).

What stays out of DDL (correctly, per spec — these are Stage-2 runtime behaviours, FR-10):
- The **AND-gate decrement** (FR-5 rule 1/6) and **TTL auto-release** (FR-5 rule 5) are NOT DB triggers. They are the atomic reserve/finalize transaction logic that E5.9 implements. Day-1 the schema only makes them *expressible* (the columns and the reconstruction formula FR-7 exist); it does not enforce them. Encoding the decrement as a trigger now would (a) be runtime enforcement, violating FR-10, and (b) prejudge the E5.9 atomicity design. **Rejected — see §2.**
- `remaining_cache` is advisory and MAY drift (FR-7); no constraint ties it to the ledger. The authoritative balance is the FR-7 reconstruction query.

### 1.4 Currency homogeneity (NF-3) is a runtime invariant, not a day-1 constraint

A `reservation` must reference budget rows of matching currency. Cross-row currency equality cannot be expressed as a single-table CHECK without a trigger or a denormalised copy. Per FR-10 (no day-1 enforcement) and proportionality (§1.3), this is documented as a **C-1 consumer contract** for E5.9, not a day-1 trigger. The `reservation.currency` column exists so the runtime can validate it. **Fitness FF-BUD-8 pins this as a contract obligation, not a green-on-day-1 DB check.**

### 1.5 No runtime read on day-1 (FR-10 / AC-23)

No `src/**/*.ts` outside `__tests__/migrations/` may reference `reservation` or `spend_ledger`. Enforced by a static grep fitness check (FF-BUD-10). T-0023 ships zero TypeScript (NF-5).

---

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| **AND-gate decrement + balance enforcement as a DB trigger on `reservation` INSERT** | Violates FR-10 (no day-1 runtime enforcement) and prejudges the E5.9 atomicity design (advisory-lock vs `SELECT ... FOR UPDATE` vs serializable retry is E5.9's call). The reconstruction formula FR-7 + CHECK constraints already make the invariant *expressible*; enforcing it is Stage-2. Schema, not behaviour, is day-1. |
| **`remaining_cache` maintained by trigger to stay exactly = ledger − open-reservations** | The spec explicitly makes the cache *advisory* and reconstructable (FR-7); a maintaining trigger would be the very runtime enforcement FR-10 defers, and would couple the cache to a specific TTL-sweep policy that belongs to E5.9. Cache is a plain column updated by the (future) finalize/release transaction. |
| **Two migration files (034 tables, 035 FK seam)** | The grant_role_fk precedent (021) split a deferred FK into its own file because the target table (`role`) was created in a *different* migration (019). Here `instance_budget` is created in the *same* file as the FK that targets it, and the runner applies one file per transaction — splitting buys nothing and adds a second file to keep ordered. One file (034); 035 left reserved. |
| **`ENUM` type for `reservation.status` / `agent_budget.window_kind`** | A Postgres `ENUM` is a schema object requiring its own `CREATE TYPE` and a migration to extend; `text` + CHECK is the codebase convention (`employee.kind`, migration 016) and keeps additions to a one-line CHECK change. Matches the ratified shape. |
| **`spend_ledger` as a partition / separate hash-chain like `audit_event`** | `audit_event` carries `prev_hash`/`row_hash` because it is the tamper-evident audit floor (T-0016). `spend_ledger` is an append-only financial ledger but the spec (FR-4) does not mandate hash-chaining — append-only via trigger is the ratified requirement (NF-1). Adding a hash chain would be unrequested scope. |
| **Surrogate single-column PK `id` + separate `tenant_id` column** | Violates the T-0013 invariant: `tenant_id` MUST be the *leading PK column*. PK is `(tenant_id, id)` on all four tables. |
| **FK from `spend_ledger`/`reservation` to `instance_budget`/`agent_budget` as single-column (`id` only)** | Tenant-scoped composite FKs `(tenant_id, x_id) → (tenant_id, id)` are the T-0013/NF-2 rule (leading `tenant_id` on every FK; cross-tenant FK references are rejected). Single-column FK would let a row in tenant A reference a budget in tenant B. All FKs are composite, tenant-leading. |

---

## 3. Object model (full DDL contract for coder/tester)

All four tables: schema `choros`; PK `(tenant_id, id)`; `ENABLE`+`FORCE ROW LEVEL SECURITY`; policy `<table>_tenant_isolation USING (tenant_id = current_setting('choros.tenant_id', true)::uuid) WITH CHECK (same)`. All amount columns `numeric(18,6)`. All timestamps `bigint` (epoch-ms). Validated live (ROLLBACK probe) against the silo DB on 2026-06-11.

### 3.1 `instance_budget`

| Field | Type | Constraints |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | Leading PK column |
| `id` | `uuid NOT NULL` | PK `(tenant_id, id)`; FK target for `agent_card.budget_policy_id` |
| `process_instance_id` | `text NULL` | Flowable instance correlator; NULL = unbound template |
| `currency` | `text NOT NULL` | ISO-4217 or `'token'`; immutable by convention |
| `ceiling` | `numeric(18,6) NOT NULL` | `CHECK (ceiling > 0)` → `instance_budget_ceiling_positive` |
| `remaining_cache` | `numeric(18,6) NOT NULL` | Advisory; no constraint vs ledger (FR-7) |
| `created_at` | `bigint NOT NULL` | epoch-ms |
| `updated_at` | `bigint NOT NULL` | epoch-ms |

Grant: `SELECT, INSERT, UPDATE, DELETE TO choros_app`.

### 3.2 `agent_budget`

| Field | Type | Constraints |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | Leading PK column |
| `id` | `uuid NOT NULL` | PK `(tenant_id, id)` |
| `employee_id` | `uuid NOT NULL` | `FOREIGN KEY (tenant_id, employee_id) REFERENCES choros.employee(tenant_id, id)` |
| `window_kind` | `text NOT NULL` | `CHECK (window_kind IN ('instance','daily','monthly','total'))` → `agent_budget_window_kind_chk` |
| `window_ref` | `text NULL` | window reference; NULL = open/global cap |
| `currency` | `text NOT NULL` | ISO-4217 or `'token'` |
| `ceiling` | `numeric(18,6) NOT NULL` | `CHECK (ceiling > 0)` → `agent_budget_ceiling_positive` |
| `remaining_cache` | `numeric(18,6) NOT NULL` | Advisory |
| `created_at` | `bigint NOT NULL` | epoch-ms |
| `updated_at` | `bigint NOT NULL` | epoch-ms |

Index: `agent_budget_lookup_idx ON (tenant_id, employee_id, window_kind, window_ref)` (leading `tenant_id`, FF-LEAD-clean).
Grant: `SELECT, INSERT, UPDATE, DELETE TO choros_app`.

### 3.3 `reservation`

| Field | Type | Constraints |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | Leading PK column |
| `id` | `uuid NOT NULL` | PK `(tenant_id, id)` |
| `tool_call_id` | `text NOT NULL` | `UNIQUE (tenant_id, tool_call_id)` — idempotency key (AC-9) |
| `instance_budget_id` | `uuid NULL` | `FOREIGN KEY (tenant_id, instance_budget_id) REFERENCES choros.instance_budget(tenant_id, id)` |
| `agent_budget_id` | `uuid NULL` | `FOREIGN KEY (tenant_id, agent_budget_id) REFERENCES choros.agent_budget(tenant_id, id)` |
| `held` | `numeric(18,6) NOT NULL` | `CHECK (held > 0)` → `reservation_held_positive` |
| `currency` | `text NOT NULL` | matches referenced budget rows (NF-3, runtime-validated) |
| `status` | `text NOT NULL` | `CHECK (status IN ('open','spent','released'))` → `reservation_status_chk` |
| `expires_at` | `bigint NOT NULL` | epoch-ms TTL |
| `created_at` | `bigint NOT NULL` | epoch-ms |
| `finalized_at` | `bigint NULL` | epoch-ms; set on spent/released |

Table CHECK: `reservation_at_least_one_budget CHECK (instance_budget_id IS NOT NULL OR agent_budget_id IS NOT NULL)` (AC-12).
Grant: `SELECT, INSERT, UPDATE, DELETE TO choros_app` (status/finalized_at transitions).

### 3.4 `spend_ledger` (append-only)

| Field | Type | Constraints |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | Leading PK column |
| `id` | `uuid NOT NULL` | PK `(tenant_id, id)` |
| `reservation_id` | `uuid NOT NULL` | `FOREIGN KEY (tenant_id, reservation_id) REFERENCES choros.reservation(tenant_id, id)` |
| `tool_call_id` | `text NOT NULL` | denormalised from reservation |
| `employee_id` | `uuid NOT NULL` | `FOREIGN KEY (tenant_id, employee_id) REFERENCES choros.employee(tenant_id, id)` |
| `instance_budget_id` | `uuid NULL` | `FOREIGN KEY (tenant_id, instance_budget_id) REFERENCES choros.instance_budget(tenant_id, id)` (denorm) |
| `agent_budget_id` | `uuid NULL` | `FOREIGN KEY (tenant_id, agent_budget_id) REFERENCES choros.agent_budget(tenant_id, id)` (denorm) |
| `amount` | `numeric(18,6) NOT NULL` | `CHECK (amount > 0)` → `spend_ledger_amount_positive` |
| `currency` | `text NOT NULL` | ISO-4217 or `'token'` |
| `description` | `text NULL` | human label (tool/model name) |
| `recorded_at` | `bigint NOT NULL` | epoch-ms |

Indexes: `spend_ledger_instance_idx ON (tenant_id, instance_budget_id, recorded_at)`; `spend_ledger_agent_idx ON (tenant_id, agent_budget_id, recorded_at)` (both leading `tenant_id`).
Append-only: `choros.spend_ledger_immutable()` trigger function (`RAISE EXCEPTION ... ERRCODE='restrict_violation'`) + `BEFORE UPDATE`/`BEFORE DELETE` triggers `spend_ledger_no_update`/`spend_ledger_no_delete`.
Grant: **`SELECT, INSERT ONLY TO choros_app`** (no UPDATE/DELETE — defence layer a).

### 3.5 `agent_card.budget_policy_id` FK seam (guarded)

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='choros' AND table_name='agent_card')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_card_budget_policy_fk')
  THEN
    ALTER TABLE choros.agent_card
      ADD CONSTRAINT agent_card_budget_policy_fk
      FOREIGN KEY (tenant_id, budget_policy_id)
      REFERENCES choros.instance_budget(tenant_id, id);
  END IF;
END $$;
```

- The `IF EXISTS agent_card` guard makes the block a no-op on a fresh CI Postgres where T-0020 has not run (AC-20: "migration succeeds if agent_card does not exist").
- The `NOT EXISTS ... conname` guard makes it idempotent (re-run safe — though run.mjs skips applied versions, this protects a manual re-run, AC-21).
- Named constraint `agent_card_budget_policy_fk` so a fitness/test can assert it by name.
- **Live-validated:** in the silo (agent_card present, budget_policy_id nullable, no existing FK) the block adds the FK; the ROLLBACK probe confirmed `fk=1`.

### 3.6 Dev seed (idempotent, FR-9 / AC-19)

```sql
INSERT INTO choros.instance_budget (tenant_id, id, process_instance_id, currency, ceiling, remaining_cache, created_at, updated_at)
VALUES ('a0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001', NULL, 'USD', 100.000000, 100.000000, 0, 0)
ON CONFLICT DO NOTHING;
INSERT INTO choros.agent_budget (tenant_id, id, employee_id, window_kind, window_ref, currency, ceiling, remaining_cache, created_at, updated_at)
VALUES ('a0000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','d0000000-0000-0000-0000-000000000002','total', NULL, 'USD', 50.000000, 50.000000, 0, 0)
ON CONFLICT DO NOTHING;
```

`employee_id = d0000000-0000-0000-0000-000000000002` = agent `a-recon` (seeded by migration 016). Dev tenant = `a0000000-0000-0000-0000-000000000001`. Stable hardcoded UUIDs (prefix `b0`/`b1`) are the idempotency key via PK; `ON CONFLICT DO NOTHING`.

---

## 4. Migration plan

**`migrations/034_budget_schema.sql`** — single file, applied in one transaction by `run.mjs`. Intra-file order:
1. `CREATE TABLE instance_budget` + RLS + policy + grant + CHECK.
2. `CREATE TABLE agent_budget` (FK → employee) + RLS + policy + grant + CHECK + lookup index.
3. `CREATE TABLE reservation` (FK → instance_budget, agent_budget) + RLS + policy + grant + CHECKs + UNIQUE.
4. `CREATE TABLE spend_ledger` (FK → reservation, employee, instance_budget, agent_budget) + RLS + policy + 2 indexes; then `CREATE OR REPLACE FUNCTION spend_ledger_immutable` + 2 triggers; then `GRANT SELECT, INSERT` only.
5. Guarded `DO $$ ... ADD CONSTRAINT agent_card_budget_policy_fk ... $$` (§3.5).
6. Dev seed (§3.6).

**`ci/checks/known_tenant_tables.txt`** — append 4 entries. The file is read line-by-line; existing entries are not alphabetised (it is append-order: `job, application, …, sod_constraint`). **Append the four at the end** (`instance_budget`, `agent_budget`, `reservation`, `spend_ledger`) — the consuming tests (`schema.test.ts`, `cross_tenant.test.ts`) iterate the set, order-independent. (Spec AC-18 lists them alphabetically as a *set* requirement, not a file-ordering requirement; the file itself is unordered.)

**Slot 035:** left unused/reserved.

### 4.1 Coder BUILD-phase seam: `cross_tenant.test.ts`

`ci/checks/db/cross_tenant.test.ts` `seedRowForTable` switch MUST gain four `case` branches so the generic cross-tenant probes (AC-3/AC-4/AC-5 of T-0115, which iterate `KNOWN_TENANT_TABLES`) can seed a row per tenant. **FK-order dependency:** `instance_budget` and `agent_budget` first (agent_budget needs a seeded `employee` — already present via the existing `employee` case earlier in iteration order), then `reservation` (needs an `instance_budget` id), then `spend_ledger` (needs a `reservation` id + `employee` id). Because `KNOWN_TENANT_TABLES` order = file order, **append order matters**: put the four at the end so `employee` is already seeded; store `instance_budget`/`agent_budget`/`reservation` ids in `seedState` for the dependent cases. New seed helpers needed: `seedInstanceBudget`, `seedAgentBudget`, `seedReservation`, `seedSpendLedger`. This is a BUILD-phase additive fix owned by coder, documented here as a known seam (mirrors the T-0017 `seedRowForTable` precedent).

> **Note (pre-existing bug, not T-0023's to fix):** `seedRowForTable` is missing a `break;` after `case 'effect_resource'` (it falls through into `case 'outbox'`). The four new cases MUST each end with `break;`. Flag separately; do not replicate the fall-through.

### 4.2 No seam break in `schema.test.ts` or `two_tenant.test.ts`

- `schema.test.ts` `FF-FK-RESOLVE` uses `expect.arrayContaining([...])` — additive FK pairs (`reservation→instance_budget`, `reservation→agent_budget`, `spend_ledger→reservation`, `spend_ledger→employee`, `spend_ledger→instance_budget`, `spend_ledger→agent_budget`, `agent_budget→employee`, and `agent_card→instance_budget`) do NOT break it, **provided all FK targets are in `KNOWN_TENANT_TABLES`**. The four new tables enter the set (✓). `agent_card` is NOT in the set; its FK source is `agent_card`, target is `instance_budget` (in set) — the `FF-FK-RESOLVE` "all FKs target baseline tables" loop checks the *target* (`dst`), which is `instance_budget` ∈ set (✓). No assertion update needed.
- `two_tenant.test.ts` counts migration files dynamically (`>= filesOnDisk`) — adding 034 needs no count update. The migration-count hardcode noted in the older T-0017 ADR has since been made dynamic.
- `FF-RLS`, `FF-LEAD`, `FF-ROLE` (schema.test.ts) iterate `KNOWN_TENANT_TABLES` dynamically → automatic coverage once the txt is updated (AC-2, AC-3, AC-6 partial).

---

## 5. Downstream contracts (frozen seams)

- **C-1 · E5.9 reserve/finalize runtime:** reserve = INSERT `reservation(status='open', held=max_cost, expires_at)` after an atomic AND-gate check `min(instance_remaining, agent_remaining) ≥ max_cost` (E5.9 owns the atomicity mechanism); duplicate `tool_call_id` → `23505` (UNIQUE), caller reads existing row; finalize-spend = UPDATE `status='spent'` + INSERT `spend_ledger(amount ≤ held)`; finalize-release = UPDATE `status='released'`, no ledger row; balance always via FR-7 reconstruction. E5.9 also enforces NF-3 currency homogeneity (FF-BUD-8).
- **C-2 · T-0020 `agent_card`:** `instance_budget(tenant_id, id)` is the FK target for `agent_card.budget_policy_id`; FK named `agent_card_budget_policy_fk`, added by 034 behind a guard. Column stays nullable; no runtime consumption day-1.
- **C-3 · budget-admin API (future):** the four table shapes (§3.1–§3.4) are the stable surface; column semantics change only via a new migration + spec amendment.

---

## 6. Fitness functions

### FF-BUD-1 — Four tables exist with FORCE RLS + default-DENY policy
**Rule:** `instance_budget`, `agent_budget`, `reservation`, `spend_ledger` exist in schema `choros`, each with `relrowsecurity AND relforcerowsecurity = true` and a tenant-isolation policy `USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)`.
**CI check:** `ci/checks/db/schema.test.ts` `FF-RLS` describe-block iterates `KNOWN_TENANT_TABLES` dynamically — automatic once the four tables are appended to `ci/checks/known_tenant_tables.txt`. Zero new test code. Covers AC-1, AC-3. Live-validated in design (ROLLBACK probe: all four created + FORCE RLS + policy).

### FF-BUD-2 — `tenant_id` leads PK and every composite index/FK
**Rule:** all four tables have `tenant_id` as PK column 1; every multi-column index and FK leads with `tenant_id`.
**CI check:** `schema.test.ts` `FF-LEAD` (both `it` blocks) iterate `KNOWN_TENANT_TABLES` — automatic once tables are in the txt. Covers AC-2, AC-7(lead). Indexes `agent_budget_lookup_idx`, `spend_ledger_instance_idx`, `spend_ledger_agent_idx` all lead with `tenant_id` by construction.

### FF-BUD-3 — Cross-tenant read/write isolation on all four tables
**Rule:** from `choros_app` in TENANT_A context, SELECT/UPDATE/DELETE targeting TENANT_B rows → 0 rows / rejected.
**CI check:** `ci/checks/db/cross_tenant.test.ts` AC-1/AC-2 probes iterate `KNOWN_TENANT_TABLES`. **Requires coder to add the 4 `seedRowForTable` cases (§4.1)** so a row exists per tenant to probe. Covers AC-4, AC-5.

### FF-BUD-4 — `spend_ledger` append-only (trigger + grant)
**Rule:** a direct `UPDATE` or `DELETE` on an existing `spend_ledger` row raises an exception (`restrict_violation`); `choros_app` lacks UPDATE/DELETE privilege.
**CI check:** new `describe` in `ci/checks/db/spend-ledger.test.ts` (owned by tester): insert a reservation+ledger row via migrator, then `UPDATE`/`DELETE` → `rejects` with the trigger exception; assert `has_table_privilege('choros_app','choros.spend_ledger','UPDATE') = false`. Pattern = existing `audit-writer.chain.test.ts`. Covers AC-7, AC-8. Live-validated (ROLLBACK probe: AC7 PASS update rejected).

### FF-BUD-5 — `reservation` idempotency UNIQUE
**Rule:** two `reservation` rows with the same `(tenant_id, tool_call_id)` → second rejected with `23505`.
**CI check:** `spend-ledger.test.ts` (tester): insert two reservations same `tool_call_id` → second `rejects` `{ code: '23505' }`. Covers AC-9.

### FF-BUD-6 — CHECK constraints (positivity, status, at-least-one-budget)
**Rule:** `reservation.held > 0`, `instance_budget.ceiling > 0`, `agent_budget.ceiling > 0`, `spend_ledger.amount > 0` reject `0`; `0.000001` accepted. `reservation.status` rejects values outside `{open,spent,released}` (`23514`). `reservation` with both budget ids NULL rejected (`23514`).
**CI check:** `spend-ledger.test.ts` (tester): one `it` per constraint asserting `rejects` `{ code: '23514' }` for the violating value and success for the boundary value. Covers AC-10, AC-11, AC-12, AC-13, AC-14, AC-15. Live-validated (AC10 PASS held=0 rejected).

### FF-BUD-7 — `numeric(18,6)` precision, no rounding
**Rule:** all amount columns are `numeric` precision 18 scale 6; `0.000001` stored without rounding.
**CI check:** `spend-ledger.test.ts` (tester): query `information_schema.columns` `numeric_precision=18, numeric_scale=6` for the 7 amount columns; round-trip `0.000001`. Covers AC-16. Live-validated (AC16 = t).

### FF-BUD-8 — Currency homogeneity is a consumer contract, not a day-1 DB check
**Rule:** a `reservation`'s `currency` and its referenced budget rows' `currency` must match; mixing is rejected by E5.9 runtime (NF-3). This is NOT a day-1 DB constraint (would require a cross-row trigger = runtime enforcement, FR-10).
**CI check:** documentation/contract assertion only — `ci/checks/known_tenant_tables.txt`-adjacent static grep that the C-1 contract text in this ADR names NF-3 (no DB green/red on day-1). Flagged to E5.9 as a frozen seam. (No DB-level test on day-1; this FF is a hand-off marker.)

### FF-BUD-9 — Authoritative balance reconstruction (FR-7)
**Rule:** `ceiling − SUM(spend_ledger.amount WHERE budget_id=X) − SUM(reservation.held WHERE budget_id=X AND status='open' AND expires_at >= now())` is computable from the four tables alone and equals the expected remaining after a seeded scenario.
**CI check:** `spend-ledger.test.ts` (tester): seed 3 ledger rows + 1 open reservation against one `instance_budget`, run the FR-7 query, assert consistency. Covers AC-17.

### FF-BUD-10 — No runtime read on day-1 (dormancy)
**Rule:** `grep -rE 'reservation|spend_ledger' src/` returns 0 matches in `.ts` files outside `__tests__/migrations/`.
**CI check:** new static check `ci/checks/budget-dormancy.sh` (pattern = `grant-resolver-isolation.sh`): `grep -rnE '\b(reservation|spend_ledger)\b' src/ --include='*.ts'` filtered to exclude `__tests__/migrations/` → must be empty; non-empty → exit 1. Add to `npm run fitness`. Covers AC-10(dormancy)/AC-23. **Coder must register this script in package.json `fitness`.**

### FF-BUD-11 — `agent_card.budget_policy_id` FK added (guarded), idempotent
**Rule:** if `agent_card` exists, FK `agent_card_budget_policy_fk (tenant_id, budget_policy_id) → instance_budget(tenant_id, id)` is present; if absent, migration succeeds without it; re-run does not error.
**CI check:** `spend-ledger.test.ts` (tester, conditional): if `agent_card` table exists, assert `pg_constraint` has `agent_card_budget_policy_fk` with `src_cols=['tenant_id','budget_policy_id']`, `ref_cols=['tenant_id','id']`, `dst='instance_budget'`. `two_tenant.test.ts` idempotency re-run (already present) covers the no-error-on-rerun (AC-21). Covers AC-20, AC-21. Live-validated (ROLLBACK probe: AC20 fk=1).

### FF-BUD-12 — `known_tenant_tables.txt` completeness (anti-decorative)
**Rule:** the four tables appear in `ci/checks/known_tenant_tables.txt`; no `choros` base table is in the DB but absent from the fixture.
**CI check:** `schema.test.ts` "no choros base table is missing from the known_tenant_tables fixture" (CI-strict: `inDb === known`). Covers AC-18, AC-19(partial via seed-presence).

### FF-BUD-13 — Dev seed present and idempotent
**Rule:** after migration, dev silo has ≥1 `instance_budget` row and ≥1 `agent_budget` row for `a-recon`; re-running the runner leaves counts unchanged (`ON CONFLICT DO NOTHING`).
**CI check:** `spend-ledger.test.ts` (tester): `SET LOCAL choros.tenant_id` = dev tenant, assert `count(instance_budget) >= 1` and an `agent_budget` row with `employee_id = a-recon`. `two_tenant.test.ts` FF-2 idempotency re-run covers count-stability. Covers AC-19, AC-21.

### FF-BUD-14 — `tsc`/eslint/fitness green
**Rule:** `tsc --noEmit`, `eslint src`, `npm run fitness` green after the migration + txt update + new dormancy script land. Since T-0023 ships no `.ts` (NF-5), `tsc`/eslint are unaffected by source; the new `budget-dormancy.sh` must itself pass.
**CI check:** the `ci` npm script (`tsc --noEmit && eslint src && npm run fitness && vitest run`). Covers AC-22.

---

## 7. Traceability

| AC | Covered by |
|---|---|
| AC-1 | FF-BUD-1; migration 034 creates all four tables (live-validated) |
| AC-2 | FF-BUD-2; PK `(tenant_id, id)` on all four; FF-LEAD dynamic |
| AC-3 | FF-BUD-1; ENABLE+FORCE RLS + default-DENY policy DDL |
| AC-4 | FF-BUD-3; cross_tenant.test.ts AC-1 probe + 4 new seed cases (§4.1) |
| AC-5 | FF-BUD-3; cross_tenant.test.ts AC-2 probe |
| AC-6 | FF-BUD-1/FF-ROLE; GRANT SELECT/INSERT/UPDATE/DELETE (3 tables), SELECT/INSERT (spend_ledger); choros_app no DDL (existing FF-ROLE) |
| AC-7 | FF-BUD-4; spend_ledger_no_update trigger (live-validated: rejected) |
| AC-8 | FF-BUD-4; spend_ledger_no_delete trigger |
| AC-9 | FF-BUD-5; UNIQUE (tenant_id, tool_call_id) |
| AC-10 | FF-BUD-6; reservation_held_positive CHECK (live-validated: rejected) |
| AC-11 | FF-BUD-6; reservation_status_chk CHECK |
| AC-12 | FF-BUD-6; reservation_at_least_one_budget CHECK |
| AC-13 | FF-BUD-6; instance_budget_ceiling_positive CHECK |
| AC-14 | FF-BUD-6; agent_budget_ceiling_positive CHECK |
| AC-15 | FF-BUD-6; spend_ledger_amount_positive CHECK |
| AC-16 | FF-BUD-7; numeric(18,6) all amount columns (live-validated) |
| AC-17 | FF-BUD-9; FR-7 reconstruction query over the four tables |
| AC-18 | FF-BUD-12; known_tenant_tables.txt += 4 tables; anti-decorative assertion |
| AC-19 | FF-BUD-13; dev seed instance_budget + agent_budget(a-recon), ON CONFLICT DO NOTHING |
| AC-20 | FF-BUD-11; guarded agent_card_budget_policy_fk (live-validated: fk=1) |
| AC-21 | FF-BUD-11/FF-BUD-13; run.mjs skip-applied + ON CONFLICT + NOT EXISTS guard; two_tenant.test.ts re-run |
| AC-22 | FF-BUD-14; ci script green; NF-5 no .ts shipped |
| AC-23 | FF-BUD-10; budget-dormancy.sh grep returns 0 in src/*.ts outside __tests__/migrations/ |

---

## 8. Runtime target

Postgres 16 in the silo docker-compose stack (T-0053, running — verified live this run: `choros-postgres-1`, port 55432, migrations 001–032 applied incl. `032_agent_card`). The migration runner `migrations/run.mjs` (zero-dep beyond `pg`) applies `034_budget_schema.sql` as `choros_migrator` in one transaction; `choros_app` (NOBYPASSRLS, non-owner) is the runtime role with per-table grants. No new infrastructure, no new container, no new dependency (NF-6). On a fresh CI Postgres the `agent_card` FK guard is a no-op; in the silo it fires. Day-1 the tables are dormant — no `src/` TypeScript reads them (FR-10).
