# Spec · T-0023 — Budget schema + reservation semantics (E4.9)

- **Task:** T-0023 (epic E4.9, architecture, prio 70, day-1, GT-1 auto-approved 2026-06-08)
- **Phase:** SPEC · role `analyst`
- **Deps (dev base b6a1cd6):** E2.1 tenant isolation (T-0013, migration 001/013/RLS guards), E2.3 grant authority table (T-0018, migration 008). All budget tables carry `tenant_id` (T-0013 contract).
- **Status:** `ready` — no BLOCKING questions (see §9).

---

## 0. Authority chain

| Source | What it mandates |
|---|---|
| `playbooks/rbac-backlog.md#E4.9` (GT-1, 2026-06-08) | `instance_budget`, `agent_budget(window)`, `reservation(tool_call_id, held, ttl)`, `spend_ledger`(append-only); two-ceiling AND-composition; reservation semantics; all tables tenant-isolated |
| `playbooks/rbac-discovery-phase1-hypothesis.md §4` | Reservations + idempotent `tool_call_id` + reduce-over-ledger (fix for racey check-then-decrement); `remaining` cache = advisory; hard-cap = removed capability (RL-3/D-022); exhaustion → soft-gate downgrade |
| `playbooks/rbac-discovery-phase1-hypothesis.md §5` | Budget tables in the canonical day-1 data model |
| `docs/decisions.md D-022` | Operational LLM-spend allowed within corridor + hard spend-cap at provider; "no external obligations" = RL-3; budget semantics MUST enable hard ceilings |
| `constitution/red-lines.md RL-3` | No external/binding spend without founder gate; platform MUST enforce hard ceilings |
| T-0020 spec §FR-9 / `docs/specs/T-0020-agent-card.spec.md` | `agent_card.budget_policy_id uuid NULL` references the table this task owns (see §5 Seam) |

---

## 1. What we build (one sentence)

Four tenant-isolated tables — `instance_budget`, `agent_budget`, `reservation`, `spend_ledger` — implementing **two-ceiling AND-composed budget semantics** via **reservation semantics**: reserve `max_cost` before a call → finalize `actual ≤ held` on completion → TTL-auto-release on abandonment; `spend_ledger` is the ground truth; remaining caches are advisory and fully reconstructable.

Day-1 scope = **schema + semantics** (reservation / spend / release contracts). Runtime enforcement at the agent call boundary is Stage-2 (E5.9).

---

## 2. Scope boundary (day-1 vs Stage-2)

| In scope (T-0023, day-1) | Out of scope |
|---|---|
| All four table schemas with T-0013 isolation invariants | Agent-runtime reservation enforcement at call boundary (E5.9, Stage-2, UNAPPROVED) |
| Reservation semantics: reserve / finalize-spend / finalize-release / TTL rules | Autonomy downgrade on budget exhaustion (E5.7, Stage-2) |
| `spend_ledger` append-only constraint + reduce-over-ledger contract | Billing, invoicing, monetization |
| `remaining` advisory cache columns on `instance_budget` + `agent_budget` | HTTP endpoints reading or writing budget rows (future task) |
| Dev seed (idempotent, migrations 034–035 range) | LLM provider cost tracking (not stored here) |
| `known_tenant_tables.txt` update | Reservation expiry sweep job (implementation detail of E5.9) |
| FK stub from `agent_card.budget_policy_id → instance_budget` seam (see §5) | `budget_exceeded` flag in Demiurge's own budget-ledger (separate system) |

---

## 3. Functional requirements

### FR-1 — `instance_budget` table

`instance_budget` is a **tenant-isolated, FORCE-RLS** table. One row per process-instance budget cap.

| Column | Type | Nullable | Description |
|---|---|---|---|
| `tenant_id` | `uuid NOT NULL` | No | Leading PK component. T-0013 invariant. |
| `id` | `uuid NOT NULL` | No | Budget-policy identifier. Referenced by `agent_card.budget_policy_id`. |
| `process_instance_id` | `text NULL` | Yes | Flowable process instance id (BPMN correlator). NULL = template policy not yet bound to an instance. |
| `currency` | `text NOT NULL` | No | ISO-4217 code or `'token'`. E.g. `'USD'`, `'token'`. Immutable after creation. |
| `ceiling` | `numeric(18,6) NOT NULL` | No | Hard spend cap for this instance. MUST be > 0. |
| `remaining_cache` | `numeric(18,6) NOT NULL` | No | Advisory cache: `ceiling − sum(spend_ledger finalized entries) − sum(open reservations)`. Updated on finalize/release; NOT the authoritative balance. |
| `created_at` | `bigint NOT NULL` | No | Unix epoch milliseconds. |
| `updated_at` | `bigint NOT NULL` | No | Unix epoch milliseconds. |

PK: `(tenant_id, id)`.
Constraint: `ceiling > 0`; `remaining_cache >= 0` (advisory; may temporarily go negative under TTL race — see FR-5).

### FR-2 — `agent_budget` table

`agent_budget` is a **tenant-isolated, FORCE-RLS** table. One row per agent-window budget cap. An agent budget is a sliding or fixed window (e.g. daily/monthly/per-instance cap on one specific agent's spend).

| Column | Type | Nullable | Description |
|---|---|---|---|
| `tenant_id` | `uuid NOT NULL` | No | Leading PK component. T-0013 invariant. |
| `id` | `uuid NOT NULL` | No | Budget entry identifier. |
| `employee_id` | `uuid NOT NULL` | No | FK → `employee(tenant_id, id)` with `kind = 'agent'`. The agent this cap applies to. |
| `window_kind` | `text NOT NULL` | No | Budget window type: `'instance'` | `'daily'` | `'monthly'` | `'total'`. Immutable after creation. |
| `window_ref` | `text NULL` | Yes | Window reference identifier (e.g. Flowable process instance id for `'instance'`; ISO date for `'daily'`). NULL = open/global cap. |
| `currency` | `text NOT NULL` | No | ISO-4217 code or `'token'`. Must match `instance_budget.currency` for the same process instance when both apply. |
| `ceiling` | `numeric(18,6) NOT NULL` | No | Hard per-agent-window spend cap. MUST be > 0. |
| `remaining_cache` | `numeric(18,6) NOT NULL` | No | Advisory cache, same semantics as `instance_budget.remaining_cache`. |
| `created_at` | `bigint NOT NULL` | No | Unix epoch milliseconds. |
| `updated_at` | `bigint NOT NULL` | No | Unix epoch milliseconds. |

PK: `(tenant_id, id)`.
Index: `(tenant_id, employee_id, window_kind, window_ref)` — typical lookup key.
Constraint: `ceiling > 0`.

### FR-3 — `reservation` table

`reservation` is a **tenant-isolated, FORCE-RLS** table. One row per outstanding cost reservation for an agent tool call.

| Column | Type | Nullable | Description |
|---|---|---|---|
| `tenant_id` | `uuid NOT NULL` | No | Leading PK component. T-0013 invariant. |
| `id` | `uuid NOT NULL` | No | Reservation identifier. |
| `tool_call_id` | `text NOT NULL` | No | Idempotency key: the exact same `tool_call_id` MUST be rejected as a duplicate if a reservation for it already exists (open or finalized). UNIQUE per tenant. |
| `instance_budget_id` | `uuid NULL` | Yes | FK → `instance_budget(tenant_id, id)`. The instance ceiling this reservation is held against. NULL = no instance ceiling. At least one of `instance_budget_id` / `agent_budget_id` MUST be non-NULL. |
| `agent_budget_id` | `uuid NULL` | Yes | FK → `agent_budget(tenant_id, id)`. The agent-window ceiling this reservation is held against. NULL = no agent ceiling. |
| `held` | `numeric(18,6) NOT NULL` | No | Amount pre-committed. MUST be > 0. The actual spend will be ≤ `held`. |
| `currency` | `text NOT NULL` | No | Currency matching the referenced budget rows. |
| `status` | `text NOT NULL` | No | `'open'` | `'spent'` | `'released'`. State machine defined in FR-5. |
| `expires_at` | `bigint NOT NULL` | No | Unix epoch milliseconds. TTL: if `status = 'open'` and `now() > expires_at`, the reservation is logically auto-released (may be swept lazily). MUST be set to a future time on INSERT. |
| `created_at` | `bigint NOT NULL` | No | Unix epoch milliseconds. |
| `finalized_at` | `bigint NULL` | Yes | Unix epoch milliseconds. Set when `status` moves to `'spent'` or `'released'`. |

PK: `(tenant_id, id)`.
Unique: `(tenant_id, tool_call_id)` — idempotency enforcement at DB layer.
Constraint: `held > 0`; `status IN ('open', 'spent', 'released')`; `instance_budget_id IS NOT NULL OR agent_budget_id IS NOT NULL`.

### FR-4 — `spend_ledger` table

`spend_ledger` is a **tenant-isolated, FORCE-RLS, append-only** table. Authoritative record of all committed spend. No UPDATE or DELETE allowed at the DB layer.

| Column | Type | Nullable | Description |
|---|---|---|---|
| `tenant_id` | `uuid NOT NULL` | No | Leading PK component. T-0013 invariant. |
| `id` | `uuid NOT NULL` | No | Ledger row identifier. |
| `reservation_id` | `uuid NOT NULL` | No | FK → `reservation(tenant_id, id)`. The reservation this spend finalizes. |
| `tool_call_id` | `text NOT NULL` | No | Denormalized from `reservation` for ledger completeness. |
| `employee_id` | `uuid NOT NULL` | No | FK → `employee(tenant_id, id)`. The agent that incurred the spend. |
| `instance_budget_id` | `uuid NULL` | Yes | FK → `instance_budget(tenant_id, id)`. Denormalized. |
| `agent_budget_id` | `uuid NULL` | Yes | FK → `agent_budget(tenant_id, id)`. Denormalized. |
| `amount` | `numeric(18,6) NOT NULL` | No | Actual spend. MUST be > 0 and ≤ `reservation.held`. |
| `currency` | `text NOT NULL` | No | ISO-4217 code or `'token'`. |
| `description` | `text NULL` | Yes | Human-readable label (e.g. tool name, model name). |
| `recorded_at` | `bigint NOT NULL` | No | Unix epoch milliseconds. |

PK: `(tenant_id, id)`.
Index: `(tenant_id, instance_budget_id, recorded_at)` — reconstruct instance balance.
Index: `(tenant_id, agent_budget_id, recorded_at)` — reconstruct agent balance.
Append-only invariant: DB-level `NO UPDATE / NO DELETE` enforced via a trigger (same pattern as `audit_event`, T-0016).

### FR-5 — Reservation state machine + semantic rules

The `reservation.status` column tracks the lifecycle:

```
OPEN → SPENT   (finalize with actual ≤ held; writes a spend_ledger row)
OPEN → RELEASED (explicit release or TTL expiry; no spend_ledger row)
```

Semantic rules (these are WHAT, not HOW; implementation is for architect/coder):

1. **Reserve:** A new `reservation` row is inserted with `status = 'open'`, `held = max_cost`, `expires_at = now + ttl`. Both ceilings (`instance_budget.remaining_cache` and `agent_budget.remaining_cache`) are decremented by `held`. If decrementing would bring EITHER remaining below zero, the reservation INSERT MUST be rejected.

2. **Idempotency:** An INSERT with a `tool_call_id` that already exists in `reservation` for that `tenant_id` MUST be rejected by the UNIQUE constraint. The caller retries by reading the existing row — it does not insert again.

3. **Finalize-spend:** `status → 'spent'`, `finalized_at = now`. A `spend_ledger` row is inserted with `amount = actual ≤ held`. The cache difference `(held − actual)` is returned to both budgets' `remaining_cache`.

4. **Finalize-release:** `status → 'released'`, `finalized_at = now`. The full `held` amount is returned to both budgets' `remaining_cache`. No `spend_ledger` row.

5. **TTL auto-release:** A reservation with `status = 'open'` and `expires_at < now()` is logically released. Lazy sweep or eager check at reserve-time are both permitted. The authoritative balance is always reconstructable without the cache (see FR-7).

6. **Two-ceiling AND-gate:** An action is allowed iff `min(instance_remaining, agent_remaining) ≥ max_cost`. If either ceiling is absent (NULL), that ceiling is unconstrained. The gate must be evaluated atomically (not check-then-decrement with a race window).

### FR-6 — T-0013 isolation invariants (inherited, non-negotiable)

All four tables must satisfy T-0013 invariants:
- `tenant_id NOT NULL`, no default, leading PK column, leading column of every composite index.
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY; ALTER TABLE ... FORCE ROW LEVEL SECURITY;`
- Default-DENY RLS policy: `USING (tenant_id = current_setting('choros.tenant_id', true)::uuid) WITH CHECK (...)`.
- `choros_app` role: `SELECT, INSERT, UPDATE, DELETE`; no DDL.
- Access only via `SET LOCAL choros.tenant_id = ...` inside a transaction.

### FR-7 — Authoritative balance reconstruction

The `remaining_cache` columns are advisory and MAY be stale (e.g., after a TTL sweep). The authoritative remaining balance for any budget is:

```
remaining = ceiling
          − SUM(spend_ledger.amount WHERE budget_id = X)
          − SUM(reservation.held WHERE budget_id = X AND status = 'open' AND expires_at >= now())
```

This reconstruction MUST be possible using only the four tables produced by this task. No external state is required.

### FR-8 — `known_tenant_tables.txt` update

All four tables (`agent_budget`, `instance_budget`, `reservation`, `spend_ledger`) MUST be added to `ci/checks/known_tenant_tables.txt` in alphabetical order. The cross-tenant CI tests iterate over this file; each new table must pass existing cross-tenant probes without test-source modification.

### FR-9 — Dev seed

Migrations 034–035 MUST include idempotent (`ON CONFLICT DO NOTHING`) dev seed data for the dev silo tenant (`a0000000-0000-0000-0000-000000000001`): at minimum one `instance_budget` row and one `agent_budget` row for agent `a-recon` with a nominal ceiling, so downstream integration tests can exercise reservation semantics against real rows.

### FR-10 — Dormancy: no runtime budget enforcement on day-1

No Choros runtime code path (HTTP handlers, PDP/grant-resolver, job-store, external-task worker) MUST enforce budget gates on day-1. The tables exist and are writable via the provisioning path; budget enforcement at the agent call boundary is Stage-2 (E5.9). Fitness check verifies no runtime read of `reservation` or `spend_ledger` in enforcement context.

---

## 4. Non-functional requirements

### NF-1 — Append-only `spend_ledger`

`spend_ledger` rows MUST NOT be updated or deleted at the DB layer. Enforced via a trigger identical in spirit to T-0016's `audit_event` append-only trigger. A direct `UPDATE` or `DELETE` on `spend_ledger` must raise an exception.

### NF-2 — Numeric precision

All monetary/token amounts use `numeric(18,6)`: 18 total digits, 6 decimal places. This accommodates sub-cent token pricing (e.g., $0.000010/token) and large ceilings without floating-point rounding. The precision is a non-negotiable invariant; all four tables use `numeric(18,6)` for all amount columns.

### NF-3 — Currency homogeneity

A `reservation` MUST reference budget rows with matching `currency`. Mixing `'USD'` and `'token'` in the same reservation is undefined behavior and MUST be rejected. (Implementation is for architect/coder; the semantic invariant is: a reservation applies only within one currency domain.)

### NF-4 — Migration seam

Migrations for this task use slots **034** (and **035** if needed). Slot 032 is occupied by T-0020 (`agent_card`). Slot 033 is reserved (per prompt). The migration runner (`migrations/run.mjs`) is idempotent; re-running produces no error.

### NF-5 — No new TypeScript runtime module

T-0023 delivers only: migration files, seed data, a `known_tenant_tables.txt` update, and this spec. No new TypeScript module, no new HTTP endpoint, no new test file beyond migration fitness checks.

### NF-6 — Zero-dep migration

Migrations 034–035 carry no external runtime dependencies beyond Postgres. They must apply cleanly in the existing CI Postgres container.

---

## 5. Seam with T-0020 (`agent_card.budget_policy_id`)

T-0020 (`agent_card`) declares `budget_policy_id uuid NULL` as a placeholder FK toward the table this task defines. The seam contract:

- **T-0020's invariant (already frozen):** `budget_policy_id` is `uuid NULL` without FK if T-0023 is not yet applied; the FK is added by T-0023 or a follow-up migration. The column is nullable; the migration still succeeds if applied before T-0023.

- **T-0023's obligation (this spec):** T-0023 MUST define `instance_budget` with PK `(tenant_id, id)`. After T-0023 is applied, the FK `agent_card.budget_policy_id → choros.instance_budget(tenant_id, id)` becomes resolvable. T-0023 MUST add this FK via an `ALTER TABLE` in migration 034 or 035 (`ADD CONSTRAINT IF NOT EXISTS ... FOREIGN KEY (tenant_id, budget_policy_id) REFERENCES choros.instance_budget(tenant_id, id)` on `agent_card`) — only if the `agent_card` table exists. This ADD CONSTRAINT block is guarded by an existence check; if T-0020 has not been applied, the block is skipped without error.

- **Semantic interpretation:** `agent_card.budget_policy_id` points to an `instance_budget` row functioning as the **policy template** for agent invocations. When an agent is started on a process instance, the runtime (Stage-2, E5.9) will resolve the actual ceiling from this policy row. On day-1 the FK column exists and is nullable; no runtime consumption occurs.

---

## 6. Explicit out of scope

- Agent-runtime budget enforcement at call boundary (E5.9, Stage-2, UNAPPROVED).
- Autonomy downgrade on budget exhaustion (E5.7, Stage-2).
- Reservation expiry sweep job (E5.9 implementation detail).
- HTTP endpoints reading or writing budget rows (future task).
- Billing, invoicing, external payment processing.
- Cost estimation / pricing tables.
- `budget_exceeded` flag in Demiurge's own orchestration budget-ledger (separate system, `docs/decisions.md D-023`).
- LLM provider cost-tracking integration.
- Budget policy authoring UI.

---

## 7. Downstream contracts (frozen seams for consumers)

### C-1 · E5.9 (budget reservation runtime enforcement) — read/write contract

When Stage-2 E5.9 enforces budget gates at agent call-time:
1. **Reserve path:** INSERT into `reservation` with `tool_call_id`, `held = max_cost`, `expires_at`. Must pass FR-5 rule 1 (AND-gate check) atomically.
2. **Idempotency path:** same `tool_call_id` → DB UNIQUE constraint rejects duplicate; caller reads existing row.
3. **Finalize-spend path:** UPDATE `reservation.status = 'spent'`; INSERT `spend_ledger` row with `amount ≤ held`.
4. **Finalize-release path:** UPDATE `reservation.status = 'released'`; no `spend_ledger` row.
5. **Balance reconstruction:** always possible via FR-7 formula without cache.

### C-2 · T-0020 (`agent_card`) — FK seam

`instance_budget(tenant_id, id)` is the FK target for `agent_card.budget_policy_id`. Table and PK are fixed by this spec. T-0023 adds the FK on `agent_card` after `instance_budget` exists (see §5).

### C-3 · any future budget-admin API — table shape

The four table shapes defined here (FR-1 through FR-4) are the stable surface. Future API tasks MUST NOT alter column semantics without a new migration and spec amendment.

---

## 8. Acceptance criteria

| ID | Text | Verifiable as |
|---|---|---|
| AC-1 | Migration file `migrations/034_budget_schema.sql` (or split 034/035) exists; creates all four tables (`instance_budget`, `agent_budget`, `reservation`, `spend_ledger`) in the `choros` schema. | fitness |
| AC-2 | All four tables have `tenant_id uuid NOT NULL` as the leading column of the PK. | fitness |
| AC-3 | All four tables have `FORCE ROW LEVEL SECURITY` and a default-DENY RLS policy `USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)`. | test |
| AC-4 | Cross-tenant read on any of the four tables (tenant B context, tenant A data) returns 0 rows. | test |
| AC-5 | Cross-tenant write on any of the four tables (tenant B context, tenant A `tenant_id`) is rejected. | test |
| AC-6 | `choros_app` role has `SELECT, INSERT, UPDATE, DELETE` on all four tables and no DDL. | test |
| AC-7 | `spend_ledger`: a direct `UPDATE` on an existing row raises an exception (append-only trigger). | test |
| AC-8 | `spend_ledger`: a direct `DELETE` on an existing row raises an exception (append-only trigger). | test |
| AC-9 | `reservation.tool_call_id` has a UNIQUE constraint per tenant: inserting two `reservation` rows with the same `(tenant_id, tool_call_id)` is rejected. | test |
| AC-10 | `reservation.held > 0` CHECK constraint: inserting a row with `held = 0` is rejected; `held = 0.000001` is accepted. | test |
| AC-11 | `reservation.status` CHECK constraint: values `'open'`, `'spent'`, `'released'` are accepted; any other value is rejected. | test |
| AC-12 | `reservation`: the constraint `instance_budget_id IS NOT NULL OR agent_budget_id IS NOT NULL` is enforced: inserting a row with both NULLs is rejected. | test |
| AC-13 | `instance_budget.ceiling > 0` CHECK constraint: `ceiling = 0` is rejected. | test |
| AC-14 | `agent_budget.ceiling > 0` CHECK constraint: `ceiling = 0` is rejected. | test |
| AC-15 | `spend_ledger.amount > 0` CHECK constraint: `amount = 0` is rejected. | test |
| AC-16 | All amount columns (`ceiling`, `remaining_cache`, `held`, `amount`) are `numeric(18,6)`: a value with 6 decimal places (e.g. `0.000001`) is stored without rounding. | test |
| AC-17 | Authoritative balance reconstruction (FR-7): after inserting 3 `spend_ledger` rows and 1 open `reservation`, the formula `ceiling − SUM(spend) − SUM(open_held)` returns a value consistent with the sum of amounts. | test |
| AC-18 | `ci/checks/known_tenant_tables.txt` contains `agent_budget`, `instance_budget`, `reservation`, `spend_ledger`; cross-tenant CI tests pass for all four tables without modification to test source. | fitness |
| AC-19 | Dev seed: after applying migrations, the dev silo has at least one `instance_budget` row and one `agent_budget` row for agent `a-recon`, all `ON CONFLICT DO NOTHING`. | test |
| AC-20 | The FK on `agent_card.budget_policy_id → instance_budget(tenant_id, id)` is added (if `agent_card` table exists); migration succeeds if `agent_card` does not exist. | fitness |
| AC-21 | Migrations 034–035 are idempotent: running the migration runner twice produces no error. | test |
| AC-22 | `tsc --noEmit`, eslint, and `npm run fitness` (existing) are all green after migrations are added. | fitness |
| AC-23 | No Choros runtime code path (HTTP handlers, PDP, job-store, engine guard) imports or reads `reservation` or `spend_ledger` in an enforcement context on day-1. `grep -rE 'reservation|spend_ledger' src/` returns 0 matches in `.ts` files outside `__tests__/migrations/`. | fitness |

---

## 9. BLOCKING questions

**None.** All design questions resolved by GT-1-signed sources:
- Table set and column names: ratified in `rbac-backlog.md#E4.9` and `rbac-discovery-phase1-hypothesis.md §4,§5`.
- Reservation semantics: reserve→finalize/release + TTL: ratified in hypothesis §4 (§6-A #3).
- Two-ceiling AND-composition: ratified.
- `spend_ledger` append-only: ratified (same pattern as `audit_event`, T-0016).
- Dormancy line (day-1 schema, Stage-2 enforcement): ratified by D-C.
- Migration slots 034/035: derived from prompt (032=T-0020, 033=reserved, 034/035=T-0023).
- `budget_policy_id` seam: T-0020 spec §FR-9 explicitly defers FK resolution to T-0023.

Status: **ready** — no founder escalation required.
