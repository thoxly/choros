# Spec · T-0041 — BYO-LLM Data-Egress Policy Axis

**Title:** E4.8 · `egress_policy(class, allowed_endpoint)` — day-1 schema/policy axis, runtime enforcement Stage-2
**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-06-11
**Task:** E4.8 — a new first-class policy axis: which classification classes of data may egress to which
client-hosted LLM endpoint. Day-1 = schema + policy expressibility + isolation. Runtime gate at
agent call-time = Stage-2 (E5.10 / T-0045, parked).

**Authoritative sources (do NOT re-open):**
- `playbooks/rbac-backlog.md#E4.8` (GT-1, founder-signed 2026-06-08) — canonical axis, dormancy line,
  Stage-2 cut for runtime enforcement.
- `playbooks/rbac-discovery-phase1-hypothesis.md` §5, §6-A #7 — "BYO-LLM data egress = a new
  first-class policy axis — which fields may egress to which client-hosted endpoint; not derivable
  from CRUD grants."
- D-B / D-C declarations (hypothesis §7) — day-1 = schema; Stage-2 = agent-runtime-specific enforcement.

**Foundation (do NOT contradict — T-0033 done, data-classification axis is live):**
- `src/core/data-classification.ts` (T-0033) — exports `DataClass` (`"public" | "internal" |
  "confidential" | "restricted"`) and `DATA_CLASS_ORDER`. T-0041's `egress_policy` table joins on
  `class: DataClass` as the shared axis. T-0041 imports `DataClass`; it does NOT redeclare it.
- `docs/design/T-0033-data-classification.adr.md` §9 seam S-1 — "T-0041 / E4.8 egress_policy:
  `DataClass` is the join axis; `egress_policy(class, allowed_endpoint)` imports `DataClass`, does
  not redeclare it. No egress column in `data_classification`."
- `docs/design/T-0033-data-classification.adr.md` §3.3 — `data_classification` DDL explicitly
  excludes an egress column; the `egress_policy` table is T-0041's table, keyed on `class`.
- `docs/design/T-0013-tenant-isolation.adr.md` — every tenant table obeys T-0013 invariants.
- `docs/design/T-0115-tenant-rls.adr.md` — `ci/checks/known_tenant_tables.txt` is the RLS CI
  invariant; a new tenant table MUST be added.
- `migrations/031_grant_confirmed2_by.sql` — last applied migration (031); T-0041 uses **038**
  (039 reserved for a second table if needed — see §0).

**Downstream contract consumers (these tasks consume the `egress_policy` schema; NOT in scope here):**
- **T-0045 (E5.10 / Stage-2)** — runtime BYO-LLM egress gate at agent call-time: enforces
  `egress_policy` at the `llm_endpoint` egress boundary. Parked until founder opens Stage-2.

**Parallel scoped-out siblings (no overlap):**
- T-0025 (E5.5) — BYO-LLM secret-handle custody: the mechanism for resolving `llm_secret_handle`
  to an actual credential. NOT related to data-egress policy.
- T-0033 (E4.3) — data-classification: defines `DataClass` axis and the `data_classification`
  table. T-0041 reads `DataClass` but does not extend that table.
- T-0040 (E4.5) — role-criticality: reads `DataClass` from the same `data-classification.ts` source.

**Note on T-0118 (parallel, hash-transform keyed digest):** T-0118 changes the semantics of the
`hash` transform. T-0041 does NOT depend on hash-transform mechanics. The `egress_policy` axis
controls WHICH DATA CLASSES may egress to WHICH ENDPOINT — it operates at the class level, not
at the value-transform level. No coupling to T-0118.

---

## 0. Migration seam

The orchestrator has allocated **migration 038** to T-0041 (migration 039 is the reserve slot if a
second DDL file is needed — e.g., if seed rows for dev are split out). Migrations 032–037 are
allocated to other in-flight tasks; T-0041 MUST NOT use those numbers.

---

## 1. Summary

The hypothesis (§6-A #7) identified that BYO-LLM data egress is **not derivable from CRUD grants**:
even if a reader has a `read` grant on a field, that field's egress to a specific external LLM
endpoint may be prohibited by the organization's data-handling policy. The egress policy is a
**new first-class policy axis** — a separate table, distinct from grants and from data-classification
— that answers: "for this tenant, is a field of class `C` permitted to leave to endpoint `E`?"

Day-1 scope: the `egress_policy` table is **schema-present, tenant-isolated, CRUD-accessible, and
policy-expressible**. No runtime component enforces it on day-1 (the gate at agent call-time is
E5.10, Stage-2). The table is dormant from the runtime perspective, exactly as `agent_card` is dormant
for agent runtime.

The axis is a **per-tenant declarative allowlist**: each row says "class `C` MAY egress to endpoint
pattern `E`". Absence of a row means egress is NOT permitted (deny-by-default / closed set).

---

## 2. Where it lands (integration surface — for `architect`)

- **`egress_policy` table** — `migrations/038_egress_policy.sql`, same tenant-table contract as all
  T-0013-governed tables: `tenant_id` leading, RLS `ENABLE`+`FORCE`, tenant-isolation policy,
  `choros_app` DML grant, listed in `ci/checks/known_tenant_tables.txt`.
- **No new TypeScript runtime module.** T-0041 is schema-only. The only TS artifact is the shared
  `DataClass` type imported from `data-classification.ts` (already implemented). No new `src/core/`
  module is required for day-1.
- **No edit to existing source files** — `data-classification.ts`, `grant-lattice.ts`,
  `grant-resolver.ts`, `object-handle.ts` are NOT modified.

---

## 3. Functional Requirements

### FR-1 — `egress_policy` table

`egress_policy` is a **tenant-isolated, FORCE-RLS** table expressing which data classes are allowed
to egress to which client-hosted LLM endpoint patterns. Minimum column set:

| Column | Type | Nullable | Description |
|---|---|---|---|
| `tenant_id` | `uuid NOT NULL` | No | Leading PK component; determines tenant scope. |
| `id` | `uuid NOT NULL` | No | Row identity. PK component. |
| `class` | `text NOT NULL` | No | A `DataClass` value (`public`, `internal`, `confidential`, `restricted`). CHECK constraint enumerates the closed set. |
| `allowed_endpoint` | `text NOT NULL` | No | The client-hosted LLM endpoint pattern this row permits (e.g. a base URL or URL prefix such as `https://api.openai.com/v1`). |
| `description` | `text NULL` | Yes | Human-readable rationale for this policy row (optional, informational). |
| `created_at` | `bigint NOT NULL` | No | Epoch-ms creation timestamp. |
| `updated_at` | `bigint NOT NULL` | No | Epoch-ms last-update timestamp. |

PK: `(tenant_id, id)`.

Logical uniqueness constraint: `(tenant_id, class, allowed_endpoint)` — one policy row per
(tenant, class, endpoint) combination. A duplicate is a conflicting allow, not an additive one.

### FR-2 — Tenant isolation

`egress_policy` satisfies ALL T-0013 tenant-isolation invariants:
- `tenant_id` is the leading PK component.
- `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.
- Tenant-isolation policy: `USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)`
  with identical `WITH CHECK` clause.
- `GRANT SELECT, INSERT, UPDATE, DELETE ON egress_policy TO choros_app`.
- Table name `egress_policy` appended to `ci/checks/known_tenant_tables.txt` (alphabetical).

### FR-3 — Closed `class` values

The `class` column has a CHECK constraint enumerating the same closed set as `DataClass`:
`CHECK (class IN ('public', 'internal', 'confidential', 'restricted'))`. A row with an unknown
class value is rejected at DB level. This is the same class vocabulary as `data_classification.class`
(T-0033) — the join axis is type-compatible by construction.

### FR-4 — Deny-by-default semantics (schema invariant, not runtime enforcement)

The table expresses an allowlist: **the absence of a row for `(class, allowed_endpoint)` means
egress is NOT permitted** for that combination. This deny-by-default interpretation is the
semantic contract the Stage-2 runtime gate (T-0045) will enforce. The schema must not imply the
opposite: there MUST be no default "allow-all" row seeded for any tenant in the dev seed.

### FR-5 — No dependency on secret-handle resolution

The `egress_policy` table refers to endpoints by their base URL pattern (a text string), NOT by
a secret-handle reference. The BYO-LLM secret custody (T-0025) is out of scope. The endpoint
pattern is a readable, policy-level identifier, not a credential.

### FR-6 — `known_tenant_tables.txt` update

`ci/checks/known_tenant_tables.txt` MUST be updated with `egress_policy` in the same commit
that adds the migration. The cross-tenant CI tests MUST pass for `egress_policy` without
modification to the test source code.

### FR-7 — No runtime code reads `egress_policy` on day-1

No Choros runtime module (`src/**/*.ts`) imports or queries `egress_policy` on day-1. The table
is schema-dormant (same pattern as `agent_card`, T-0020).

---

## 4. Non-Functional Requirements

### NF-1 — Tenant cross-isolation

A row inserted under tenant A is invisible to a session bound to tenant B. The `FORCE RLS`
mechanism achieves this without application-level filtering.

### NF-2 — No parallel policy store

There MUST be no second egress-policy representation (e.g., a config file, environment variable,
or hardcoded list) inside `src/`. The DB table is the single source of truth for the egress-policy
axis. The `ci/checks/data-classification-isolation.sh` check (extended, or a new sibling check)
MUST assert the absence of `egress_policy` hardcoding outside the migration/test files.

### NF-3 — Migration idempotency

Migration `038_egress_policy.sql` MUST be idempotent: re-running the migration runner produces
no error.

### NF-4 — No new npm dependency

T-0041 introduces no new npm package dependency.

### NF-5 — Migration seam

Only migration number 038 (and optionally 039 for a seed file) may be used. No file numbered
032–037 or 040+ is added by this task.

### NF-6 — Frozen foundations untouched

`data-classification.ts`, `grant-lattice.ts`, `grant-resolver.ts`, `object-handle.ts`, and all
pre-existing migration files are byte-unchanged by T-0041's commit. `tsc --noEmit` passes.

### NF-7 — Schema dormancy verifiable

The table is dormant: `grep -r 'egress_policy' src/` (excluding `__tests__/`, `migrations/`,
and `ci/`) returns zero matches. The fitness check asserts this post-commit.

---

## 5. Out of scope

- **Runtime egress enforcement at agent call-time (E5.10 / T-0045)** — Stage-2, parked. T-0041
  produces the table and policy; T-0045 reads it at agent invocation and blocks disallowed field
  egress.
- **BYO-LLM secret-handle custody (T-0025 / E5.5)** — the mechanism for resolving `llm_secret_handle`.
  T-0041 references endpoints by text, not handles.
- **UI for managing egress policies** — admin surfaces for CRUD on `egress_policy` rows are
  downstream (frontend tasks, not specified here).
- **Endpoint-pattern matching semantics** — whether `allowed_endpoint` is a prefix, exact match,
  or glob is a Stage-2 / T-0045 design concern. Day-1, the column is a stored text string.
- **Per-field granularity (field-level egress)** — the signed axis is `(class, endpoint)`, not
  `(field, endpoint)`. Field granularity is derivable from class via the T-0033 classification
  table; T-0041 does not add per-field rows.
- **Hash-transform keyed digest mechanics (T-0118)** — T-0118 changes hash-transform semantics.
  T-0041 is at the class/endpoint policy level; it does not interact with transform mechanics.
- **Budget/cost policy (`instance_budget`, `agent_budget`) (T-0023 / E4.9)** — separate axis.
- **SoD constraints over egress policies** — out of scope for this task.
- **Audit of egress-policy changes** — T-0016 / T-0031 are the audit mechanisms; T-0041 MUST
  produce timestamps but does not implement an audit-log writer.

---

## 6. Acceptance Criteria

| ID | Criterion | Verifiable as |
|---|---|---|
| **AC-1** | Migration file `migrations/038_egress_policy.sql` exists; creates table `choros.egress_policy` with PK `(tenant_id, id)`, UNIQUE `(tenant_id, class, allowed_endpoint)`, and all columns from FR-1. | fitness |
| **AC-2** | `egress_policy` has `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`. | test |
| **AC-3** | Tenant-isolation policy: `USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)` with identical `WITH CHECK` clause. | test |
| **AC-4** | Cross-tenant read: a row inserted under tenant A returns 0 rows when session is bound to tenant B. | test |
| **AC-5** | Cross-tenant write: an INSERT with tenant A's `tenant_id` under tenant B's session is rejected (RLS violation). | test |
| **AC-6** | `class` CHECK constraint: INSERT with `class = 'top_secret'` is rejected; INSERT with each of `public`, `internal`, `confidential`, `restricted` succeeds. | test |
| **AC-7** | Logical uniqueness: a second INSERT with the same `(tenant_id, class, allowed_endpoint)` is rejected by the UNIQUE constraint. | test |
| **AC-8** | `choros_app` role has `SELECT, INSERT, UPDATE, DELETE` on `egress_policy` and no DDL rights. | test |
| **AC-9** | `ci/checks/known_tenant_tables.txt` contains `egress_policy`; the cross-tenant CI tests pass for `egress_policy` without modification to test source. | fitness |
| **AC-10** | Migration 038 is idempotent: running the migration runner twice produces no error. | test |
| **AC-11** | No Choros runtime code imports or reads `egress_policy` on day-1: `grep -r 'egress_policy' src/` (excluding `__tests__/`, `migrations/`, `ci/`) returns 0 matches in any `.ts` file. | fitness |
| **AC-12** | Migration seam: T-0041's commit adds ONLY files numbered 038 (and optionally 039); no file numbered 032–037 or 040+ is introduced. | fitness |
| **AC-13** | Frozen foundations: `data-classification.ts`, `grant-lattice.ts`, `grant-resolver.ts`, `object-handle.ts`, and all pre-existing migration files are byte-unchanged; `tsc --noEmit` passes. | fitness |
| **AC-14** | No dev-seed rows of the form "allow all" in migration 038/039; any seeded rows are labeled per a specific test-tenant policy and are NAMED (not a wildcard class or catch-all endpoint). If no seed rows are provided, the table starts empty for the dev tenant (deny-by-default). | fitness |
| **AC-15** | `description` column is nullable; a row with `description = NULL` is accepted. | test |
| **AC-16** | The `class` column value in `egress_policy` rows is compatible with the `DataClass` type exported from `src/core/data-classification.ts`; a static TS type-level contract test asserts `egress_policy.class` is assignable to `DataClass`. | fitness |

---

## 7. Seams declared (sibling tasks — interface points, not implemented here)

| Seam | Consumer | What T-0041 provides |
|---|---|---|
| **S-1 (T-0045 / E5.10)** | Stage-2 runtime egress gate (parked) | `egress_policy` table with `(tenant_id, class, allowed_endpoint)` rows; T-0045 queries this table at agent-call egress boundary to decide block/pass. |
| **S-2 (T-0033 / E4.3)** | Data-classification axis | `DataClass` is the join key shared between `data_classification.class` and `egress_policy.class`. T-0041 imports `DataClass` from T-0033's module; it does NOT add an egress column to `data_classification`. |
| **S-3 (T-0020/T-0025 / E5.1/E5.5)** | Agent card, BYO-LLM secret custody | `agent_card.llm_endpoint` is the runtime source of the `allowed_endpoint` value T-0045 will look up in `egress_policy`. T-0041 does not read `agent_card`; T-0045 joins them at Stage-2. |
