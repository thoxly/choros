# Spec · T-0020 — Agent Card Schema (dormant)

**Title:** E5.1 · Agent card schema: `agent_card` table keyed to `employee(kind=agent)` — day-1 schema, runtime-dormant
**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-06-11
**Task:** E5.1 — `employee(kind=agent)` + `agent_card(employee_id, llm_endpoint, llm_model, llm_secret_handle, autonomy_threshold, budget_policy_id, escalation_rule_id)`. Schema day-1; runtime behavior keyed off these fields is Stage-2.
**Authoritative sources (do NOT re-open):**
- `playbooks/rbac-backlog.md#E5.1` (GT-1, founder-signed 2026-06-08) — canonical column set, dormancy line, D-C declaration.
- `playbooks/rbac-backlog.md` §Model recap — "Agent = polymorphic employee: same `employee` table, same grant model; per-agent card adds BYO-LLM endpoint + secret-handle + reserved budget + autonomy threshold (E5)."
- `playbooks/rbac-backlog.md` §Day-1 ÷ Stage-2 line — "Agent card/columns exist day-1 but are runtime-dormant."
- `CONCEPT.md` §3 (agent card in org structure) + §8 (A2A / service-account, OAuth 2.0).
- `docs/design/T-0054-keycloak-compose.adr.md` — agent service-accounts (`clientId = agent-*`, `serviceAccountsEnabled: true`); linkage key = `employee.slug` matches KC client's `clientId` (pattern established by T-0054 §3.5).
- `docs/design/T-0013-tenant-isolation.adr.md` — every org table obeys T-0013 invariants.
- `docs/design/T-0115-tenant-rls.adr.md` — `ci/checks/known_tenant_tables.txt` is the RLS CI invariant; a new tenant table MUST be added.

**Foundation (do NOT contradict):**
- `migrations/016_employee.sql` (T-0017) — `employee` table exists with `kind IN ('human', 'agent')` CHECK, 5 agent rows seeded (`a-recon`, `a-invoice`, `a-triage`, `s-ledger`, `s-ocr`).
- `migrations/031_grant_confirmed2_by.sql` (T-0044 in-flight) — migration 031 is occupied; T-0020 must start from **032**.

**Downstream contract consumers (these tasks read the `agent_card` schema; their implementations are NOT in scope here):**
- **T-0042 (E5.2)** — agent-provisioning "hire": must INSERT an `agent_card` row when `employee(kind=agent)` is created.
- **T-0024 (E5.4)** — invoke-grant: reads `employee.id` + `agent_card.employee_id` to verify the invocation target is an agent.
- **T-0025 (E5.5)** — BYO-LLM secret-handle custody: `agent_card.llm_secret_handle` carries the RL-3 opaque handle (not a raw key); T-0025 owns the secret-handle resolution mechanism.
- **T-0043 (E5.3)** — mcp_tool registry: joins `agent_card` to determine agent identity; reads `employee.id` for toolset-from-grants query.

---

## 0. Design decision: separate table vs. added columns on `employee`

The backlog entry says "agent_card columns" (implying columns could be on `employee`), but also
spells out the table name `agent_card(employee_id, …)`. Two options were weighed:

**Option A — columns directly on `employee`:** simpler migration (one ALTER TABLE), no JOIN for
the common agent-lookup path. Disadvantage: every human-employee row carries 7 nullable
agent-only columns; schema intent is muddier; FK constraints to `budget_policy_id` and
`escalation_rule_id` would sit on the `employee` table itself, which already owns the isolation
invariant.

**Option B — separate `agent_card` table:** clean normalization — the card only exists for
`kind = 'agent'` rows; a DB-enforced partial existence guarantee is possible (all agent employees
SHOULD have a card, enforced by the provisioning path T-0042). The D-C model ("per-agent card
adds …") implies a distinct entity. The backlog's own SQL signature `agent_card(employee_id, …)`
confirms a table. Future columns (Stage-2: `confidence_source`, `autonomy_floor`) land cleanly
without polluting `employee`.

**Decision: Option B — `agent_card` as a separate table.** This is consistent with the backlog's
own naming, the D-C entity model, and the cleanliness principle. The migration seam (032) adds
one new tenant table.

---

## 1. Summary

Extend the Choros schema with an `agent_card` table, one row per agent employee (WHERE
`kind = 'agent'`), carrying the agent's LLM configuration and control parameters. The table is
a **schema-layer artifact only**: its columns are stored and readable, but no Choros runtime
component reads or enforces them on day-1. The runtime that consumes `autonomy_threshold`,
`budget_policy_id`, and `llm_secret_handle` at call-time is Stage-2 (E5.7/E5.9/E5.10). A
Keycloak client-id linkage column (`kc_client_id`) records the corresponding KC service-account
clientId, completing the employee ↔ Keycloak identity chain for agents.

---

## 2. Functional Requirements

### FR-1 — `agent_card` table

`agent_card` is a **tenant-isolated, FORCE-RLS** table with the following column set:

| Column | Type | Nullable | Description |
|---|---|---|---|
| `tenant_id` | `uuid NOT NULL` | No | Leading PK component; FK → `employee(tenant_id, id)` with tenant. |
| `employee_id` | `uuid NOT NULL` | No | FK → `employee(tenant_id, id)` constrained to `kind = 'agent'` (see FR-2). |
| `kc_client_id` | `text NOT NULL` | No | Keycloak `clientId` of the agent's service-account client (e.g. `agent-recon`). UNIQUE per tenant. |
| `llm_endpoint` | `text NULL` | Yes | BYO-LLM base URL (e.g. `https://api.openai.com/v1`). NULL = not yet configured. |
| `llm_model` | `text NULL` | Yes | Model identifier (e.g. `gpt-4o`). NULL = not yet configured. |
| `llm_secret_handle` | `text NULL` | Yes | RL-3 opaque handle resolving to the client-hosted LLM API credential. **Never** a raw API key. NULL = not yet bound. |
| `autonomy_threshold` | `numeric(5,4) NULL` | Yes | Soft gate [0.0–1.0]: confidence below this triggers Stage-2 downgrade (E5.7). NULL = not enforced (dormant). |
| `budget_policy_id` | `uuid NULL` | Yes | FK → `instance_budget` or equivalent budget-policy row (E4.9 / T-0023). NULL = not yet set. |
| `escalation_rule_id` | `uuid NULL` | Yes | FK → an escalation rule definition (future schema; for now: nullable FK not yet resolvable). NULL = not yet set. |
| `created_at` | `bigint NOT NULL` | No | Unix epoch milliseconds. |
| `updated_at` | `bigint NOT NULL` | No | Unix epoch milliseconds. |

PK: `(tenant_id, employee_id)` — one card per agent employee.
Unique: `(tenant_id, kc_client_id)` — one KC client per card per tenant.

### FR-2 — Constraint: card only for agent employees

An `agent_card` row MUST NOT reference an `employee` row with `kind = 'human'`. This is enforced
at the DB layer via a check constraint or a FK join with a partial unique index (implementation
detail for architect/coder; the invariant is: INSERT into `agent_card` with an `employee_id` whose
`kind ≠ 'agent'` MUST be rejected).

### FR-3 — T-0013 isolation invariants (inherited, non-negotiable)

All T-0013 invariants apply to `agent_card`:
- `tenant_id NOT NULL`, no default, leading PK column, leading column of every composite index.
- `FORCE ROW LEVEL SECURITY` + default-DENY policy (`USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)`).
- `choros_app` role: `SELECT, INSERT, UPDATE, DELETE` on `agent_card`; no DDL.
- Access only via `SET LOCAL choros.tenant_id = ...` inside a transaction.

### FR-4 — `ci/checks/known_tenant_tables.txt` update

`agent_card` MUST be added to `ci/checks/known_tenant_tables.txt` (alphabetical position:
before `actor_event`). The cross-tenant CI tests iterate over this file; the new table MUST pass
the existing cross-tenant probes without modification to the test itself.

### FR-5 — Dev seed (idempotent, migration 032)

Migration 032 MUST include a seed block for the 5 agent employees already in the dev silo, with
`ON CONFLICT DO NOTHING`. Seed data:

| `employee_id` (suffix) | `kc_client_id` | LLM fields | `autonomy_threshold` |
|---|---|---|---|
| `d0000000-...-0002` (`a-recon`) | `agent-recon` | NULL | NULL |
| `d0000000-...-0003` (`a-invoice`) | `agent-invoice` | NULL | NULL |
| `d0000000-...-0006` (`a-triage`) | `agent-triage` | NULL | NULL |
| `d0000000-...-0011` (`s-ledger`) | `s-ledger` | NULL | NULL |
| `d0000000-...-0012` (`s-ocr`) | `s-ocr` | NULL | NULL |

For `s-ledger` and `s-ocr`: no Keycloak service-account clients currently exist in the realm
JSON (T-0054 only created `agent-recon`, `agent-invoice`, `agent-triage`, plus
`agent-orchestrator` as representative). For the dev seed, `kc_client_id` is seeded as their
slug (`s-ledger`, `s-ocr`) as a placeholder. T-0042 (agent provisioning) owns the creation of
additional KC clients for service workers — that is out of scope here. The seed is still
idempotent and the column constraint UNIQUE per tenant allows these placeholder values.

### FR-6 — Dormancy: no runtime reads from `agent_card` on day-1

No Choros runtime code path (HTTP handlers, PDP/grant-resolver, job-store, external-task
worker) MUST read `agent_card` rows on day-1. The table exists; it is writable via the
provisioning path (T-0042); it is NOT read by any gate, engine, or policy enforcer. The columns
`autonomy_threshold`, `budget_policy_id`, and `llm_secret_handle` are stored but not enforced.
This dormancy is enforced by the fitness check FF-6.

### FR-7 — Keycloak client-id linkage contract (frozen seam for T-0042/T-0024/T-0043/T-0025)

The `kc_client_id` column is the **authoritative link** between an `agent_card` row and its
Keycloak service-account client. The linkage pattern established by T-0054 §3.5:
- `employee.slug` = the slug used in the org fixture (e.g. `a-recon`).
- `agent_card.kc_client_id` = the Keycloak `clientId` of the service-account client (e.g. `agent-recon`).
- The KC token's `preferred_username` for a service account is `service-account-<clientId>` (Keycloak 25 standard).
- The JWT's `actor_type` claim is `"agent"` for all service-account tokens (T-0054 §3.3 mapper).

This linkage is **fixed by this spec** and consumed by downstream tasks. T-0020 does NOT
implement JWT → employee resolution (that is T-0060). T-0020 does NOT provision KC clients
(that is T-0042). T-0020 ONLY provides the column and seeds the dev fixture.

### FR-8 — `escalation_rule_id` FK placeholder

At day-1, there is no `escalation_rule` table in the schema. `escalation_rule_id` is declared
as `uuid NULL` WITHOUT a FK constraint (the FK is deferred to the Stage-2 task that defines
escalation rules). This is explicit: the column exists to hold the future FK once the target
table is created.

### FR-9 — `budget_policy_id` FK constraint

`budget_policy_id` references `instance_budget` from E4.9/T-0023. At the time T-0020 is
applied, T-0023 may not yet exist. The FK constraint MUST be deferred:
- If T-0023 is already applied (migrations include `instance_budget`), the FK is a standard
  `REFERENCES choros.instance_budget(tenant_id, id)`.
- If T-0023 is not yet applied, `budget_policy_id` is declared as `uuid NULL` WITHOUT FK
  (to be added by T-0023 or a follow-up migration). The architect/coder phase resolves the
  ordering: the invariant is that the column is nullable and the FK is not missing a
  target at migration-run time.

---

## 3. Non-Functional Requirements

### NF-1 — Zero-dep migration

Migration 032 is a `CREATE TABLE ... ON CONFLICT DO NOTHING` seed. It carries no new runtime
dependencies. It must apply idempotently (re-run = no error).

### NF-2 — `known_tenant_tables.txt` update

`agent_card` added, one line, alphabetical order. The cross-tenant test requires no source
change — it reads the file dynamically.

### NF-3 — `llm_secret_handle` is NOT a secret at rest

`llm_secret_handle` stores an **opaque handle** (a reference, not a secret value). The actual
credential lives in the client-hosted environment. A raw API key MUST NOT be stored in this
column. The enforcement of this constraint is the responsibility of T-0025 (the secret-handle
custody task), not T-0020. This spec documents the invariant so T-0025 can reference it.

### NF-4 — `autonomy_threshold` range

`numeric(5,4)` enforces values in the range [−9.9999, 9.9999] at the type level; a DB-level
CHECK constraint `autonomy_threshold BETWEEN 0 AND 1` is REQUIRED to pin the domain to [0, 1].
NULL = threshold not configured (dormant).

### NF-5 — Migration seam

Migration numbers 031 is occupied by T-0044. T-0020 uses migration **032**. If T-0020 is
applied before T-0044, the file will be 032_agent_card.sql and the runner applies it in order.
If applied after, same result. The runner (`migrations/run.mjs`) is idempotent by design.

### NF-6 — No new TS runtime module

T-0020 delivers only: a migration file, a seed, a `known_tenant_tables.txt` update, and this
spec. No new TypeScript module, no new HTTP endpoint, no new test file. Those belong to T-0042
(provisioning API) and T-0043 (mcp_tool registry).

---

## 4. Explicit Out of Scope

- Agent provisioning API (`POST /agents`, hire-flow) — T-0042.
- Invoke-grant logic (request vs. command) — T-0024.
- BYO-LLM secret-handle resolution and custody — T-0025.
- `mcp_tool` registry and toolset-from-grants query — T-0043.
- Agent runtime: autonomy downgrade, budget enforcement, A2A call-graph breakers — E5.7–E5.10 (Stage-2, parked).
- Egress policy enforcement at agent call-time — E5.10 (Stage-2).
- `instance_budget` / `agent_budget` / `spend_ledger` schema — T-0023 (E4.9).
- Escalation rule table — future Stage-2 task.
- Keycloak service-account provisioning for `s-ledger` / `s-ocr` — T-0042.
- JWT → employee resolution using `kc_client_id` — T-0060.
- Any HTTP endpoints reading or writing `agent_card` — T-0042.
- Flowable/BPMN agent-task integration — future E5 tasks.

---

## 5. Downstream contracts (frozen seams — BLOCKING for consumers)

The following contracts are fixed by this spec. Downstream tasks MUST NOT implement
incompatible assumptions:

### C-1 · T-0042 (agent provisioning) — write contract

When T-0042 "hires" an agent employee:
1. An `employee` row with `kind = 'agent'` MUST already exist (or be created atomically).
2. An `agent_card` row MUST be inserted for that `employee_id` with `kc_client_id` = the KC
   clientId of the newly created service-account client.
3. LLM fields and `autonomy_threshold` MAY be NULL at hire time.

### C-2 · T-0024 (invoke-grant) — read contract

When an invoke-grant check needs to verify that a target is an agent:
1. Join `employee WHERE kind = 'agent'` OR probe `agent_card` for the `employee_id`.
2. The `kc_client_id` column is available as the KC identity anchor if needed.

### C-3 · T-0025 (BYO-LLM secret-handle) — column contract

`agent_card.llm_secret_handle text NULL` is the column that holds the opaque handle. T-0025
is responsible for the handle lifecycle (create, rotate, revoke). T-0025 MUST NOT store a raw
API key in this column. T-0020 does not enforce this at the DB layer (it is a business-rule
invariant).

### C-4 · T-0043 (mcp_tool registry) — agent-identity contract

`agent_card.employee_id` (tenant-scoped) is the agent identity key for toolset-from-grants
queries. The column `kc_client_id` maps to the JWT subject's service account if needed.

---

## 6. Acceptance Criteria

| ID | Text | Verifiable as |
|---|---|---|
| AC-1 | Migration file `migrations/032_agent_card.sql` exists; has `CREATE TABLE choros.agent_card` with PK `(tenant_id, employee_id)`, UNIQUE `(tenant_id, kc_client_id)`, and all 11 columns from FR-1. | fitness |
| AC-2 | `agent_card` has `FORCE ROW LEVEL SECURITY` and a `USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)` policy. | test |
| AC-3 | A cross-tenant read on `agent_card` (tenant B context, tenant A data) returns 0 rows. | test |
| AC-4 | A cross-tenant write on `agent_card` (tenant B context, tenant A `tenant_id`) is rejected (0 rows inserted / RLS violation). | test |
| AC-5 | INSERT into `agent_card` referencing an `employee.id` with `kind = 'human'` is rejected at the DB layer (check constraint or equivalent). | test |
| AC-6 | INSERT into `agent_card` referencing an `employee.id` with `kind = 'agent'` succeeds. | test |
| AC-7 | `autonomy_threshold` CHECK constraint: a value of `1.5` is rejected; `0.0`, `0.5`, `1.0` are accepted; NULL is accepted. | test |
| AC-8 | `ci/checks/known_tenant_tables.txt` contains the line `agent_card`; the cross-tenant CI tests pass for `agent_card` without modification to the test source. | fitness |
| AC-9 | Dev seed: after applying migration 032, all 5 agent employees (`a-recon`, `a-invoice`, `a-triage`, `s-ledger`, `s-ocr`) have an `agent_card` row with matching `kc_client_id`. | test |
| AC-10 | `kc_client_id` UNIQUE constraint per tenant: inserting two `agent_card` rows with the same `(tenant_id, kc_client_id)` is rejected. | test |
| AC-11 | Migration 032 is idempotent: running the runner twice (re-applying 032) produces no error. | test |
| AC-12 | No Choros runtime code path (HTTP handlers, PDP, job-store, engine guard) imports or reads `agent_card` on day-1. Verified by: `grep -r 'agent_card' src/` returns 0 matches in any `.ts` file outside `__tests__/migrations/`. | fitness |
| AC-13 | `choros_app` role has `SELECT, INSERT, UPDATE, DELETE` on `agent_card` and no DDL. | test |
| AC-14 | `tsc --noEmit`, eslint, and `npm run fitness` (existing) are all green after migration 032 is added. | fitness |
| AC-15 | `llm_secret_handle` column is `text NULL`: a 512-character string is accepted (opaque handle); column has no length constraint below 512. | test |
| AC-16 | `budget_policy_id` is `uuid NULL`; if `instance_budget` table does not exist at migration time, the column has no FK constraint and migration still succeeds (see FR-9). | fitness |
| AC-17 | `escalation_rule_id` is `uuid NULL` with NO FK constraint in migration 032 (the target table does not exist yet). | fitness |

---

## 7. BLOCKING questions

**None.** All design questions were resolved by the founder-signed backlog (GT-1, 2026-06-08):
- Column set: ratified in `playbooks/rbac-backlog.md#E5.1`.
- Table vs. columns decision: resolved by analysis (§0 of this spec) consistent with the backlog's own naming.
- Dormancy line: signed by D-C.
- Migration seam (032): derived from T-0044-in-flight owning 031.
- Escalation FK deferral: autonomous implementation detail (target table doesn't exist yet).

Status: **ready** — no founder escalation required.
