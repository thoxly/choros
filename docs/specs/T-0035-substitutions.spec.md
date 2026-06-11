# Spec · T-0035 — Substitutions / Absences

**Title:** E4.7 · Substitutions/absences: routing-layer stand-in default; TTL'd grant fallback; `on_behalf_of ≠ performed_by`
**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-06-11
**Task:** E4.7 — absence routing, TTL'd delegation grant, non-inheritable exclusion, end-to-end `on_behalf_of ≠ performed_by` discipline.
**Authoritative sources (do NOT re-open):**
- `playbooks/rbac-backlog.md#E4.7` (GT-1, founder-signed 2026-06-08) — canonical three-clause behavior.
- `playbooks/rbac-discovery-phase1-hypothesis.md` §3 Q6 — "default = routing-layer (stand-in already holds role, nothing minted); fallback = TTL'd grant (TTL = removed capability on read-path); non-inheritable set excluded; `on_behalf_of ≠ performed_by` preserved."
- `CONCEPT.md` §7 — "Замещения и отсутствия. Задача назначается на роль/должность, а не на человека: claim из пула, авто-переназначение при отпуске."

**Foundation (do NOT contradict):**
- `migrations/008_grant.sql` (T-0018) — `grant(tenant_id, id, role_id, resource_type, resource_facet, operation, scope, constraint, delegable, granted_by, valid_from, valid_until, created_at)`.
- `migrations/030_grant_proposed_confirmed.sql` (T-0030) — `proposed_by`, `confirmed_by` additive columns on `grant`.
- `migrations/031_grant_confirmed2_by.sql` (T-0044) — `confirmed2_by` additive column on `grant` and `role_assignment`.
- `migrations/020_role_assignment.sql` (T-0022) — `role_assignment(tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until, source, granted_by, proposed_by, confirmed_by, created_at, updated_at)`.
- `migrations/018_actor_event.sql` (T-0019) — `actor_event(tenant_id, seq, id, object_kind, ..., actor, on_behalf_of, role_at_event, event, approve_level, detail, ts, vocab_version)`.
- `src/core/grant-lattice.ts` (T-0018) — `Grant`, `isEffective`, `isNarrowerOrEqual`, `validateNarrowing`. `validFrom`/`validUntil` are the existing validity window; this task's TTL rides them.
- `src/core/grant-resolver.ts` (T-0021) — `resolveFor`, `makeGrantResolver`. New logic in NEW modules; grant-resolver.ts touched only additively (optional `substitution?: SubstitutionSource` in `ResolverDeps`).
- `src/core/actor-event.ts` (T-0019) — `on_behalf_of` as the principal-attribution field, distinct from `actor` (performer).

**Dependency tasks (DONE; this spec does NOT re-open their contracts):**
- T-0022 (E3.2) — `role_assignment` table, `org_scope`, validity window, `confirmed_by` contract.
- T-0019 (E4.1) — `actor_event` ledger, `actor`/`on_behalf_of` invariants, closed verb set.

**Migration allocation (from orchestrator — do NOT deviate):**
- Migration **036**: primary DDL (new `substitution_rule` table + TTL column on `grant` if needed, or additive alternative — see FR-4).
- Migration **037**: reserved (use ONLY if 036 requires a split; else 037 is not created). Numbers 032–035 and 038+ are forbidden.

**Parallel-safety constraint (other tasks touch the same core):**
- New logic MUST reside in new modules (e.g. `src/core/substitution.ts`).
- `grant-resolver.ts`, `grant-lattice.ts`, `types.ts`, `actor-event.ts` are touched ONLY additively — no line removed, no existing export signature changed.
- The only permitted additive touch to `ResolverDeps` in `grant-resolver.ts` is one optional property `substitution?: SubstitutionSource`.

---

## 0. Conceptual model

Absences / substitutions have a two-tier design:

**Tier 1 — Routing-layer stand-in (default, no grant minted):** when a task targets a role/position pool and one or more other employees already hold that role within the relevant org scope, the task-routing engine reassigns the task to the stand-in. No new grant row is created; the stand-in uses their existing role-based authority. This is the cheap, zero-privilege-escalation path. It covers the common case: "Ivanova is on leave; Petrov already holds the same Budget-Approver role in the same department — tasks flow to Petrov."

**Tier 2 — TTL'd delegation grant (fallback, grant minted with expiry):** when there is no existing pool holder for the stand-in role, a temporary (TTL'd) grant is minted for the substitute. The TTL is set via `valid_until` on the `grant` row. When `valid_until` elapses, `isEffective` returns `false` and the grant confers ZERO capability (it is not deleted — deletion would break the audit trail). The non-inheritable set is explicitly excluded from any TTL'd grant.

**`on_behalf_of ≠ performed_by` discipline:** when a substitute acts, the `actor_event` row records the substitute as `actor` (performer) and the absent principal as `on_behalf_of`. SoD queries attribute to `COALESCE(on_behalf_of, actor)` (the principal), not the performer — this is the T-0019 contract and must be preserved end-to-end.

---

## 1. Summary

T-0035 delivers:
1. A `substitution_rule` table recording who substitutes for whom, over what role, for what validity window.
2. A `SubstitutionSource` port and a pure `resolveSubstitution` function that the routing engine and the gateway can consult.
3. A TTL'd grant path: the existing `grant.valid_until` (epoch-ms) is the TTL; no new column is required on `grant` — the TTL is set at mint-time. Non-inheritable grants are excluded by a flag on the `substitution_rule` row.
4. An `on_behalf_of` threading contract: any action taken by a substitute MUST carry the absent principal's `employee_id` in `on_behalf_of`; the gateway enforces this at write-path (`actor_event` append via T-0032/T-0021 path).
5. Migration 036 adding `substitution_rule`; migration 037 reserved for a split if needed.

---

## 2. Functional Requirements

### FR-1 — `substitution_rule` table

A `substitution_rule` row declares that `substitute_employee_id` may act in place of `absent_employee_id` for tasks/grants scoped to `role_id` within `org_scope`, over `[valid_from, valid_until)`.

| Column | Type | Nullable | Description |
|---|---|---|---|
| `tenant_id` | `uuid NOT NULL` | No | Leading PK component; T-0013 invariant. |
| `id` | `uuid NOT NULL` | No | Stable surrogate PK component. |
| `absent_employee_id` | `uuid NOT NULL` | No | The absent principal (FK → `employee(tenant_id, id)`). |
| `substitute_employee_id` | `uuid NOT NULL` | No | The performing substitute (FK → `employee(tenant_id, id)`). |
| `role_id` | `uuid NOT NULL` | No | The role being delegated (FK → `role(tenant_id, id)`). |
| `org_scope` | `jsonb NOT NULL` | No | The org-hierarchy ScopeElement (T-0018 lattice, hierarchy=`org`) bounding where this substitution applies. Reuses the T-0022 `role_assignment.org_scope` shape: a single `{kind:node, hierarchy:org, ...}` or `{kind:set, members:[...]}`. |
| `ttl_grant_id` | `uuid NULL` | Yes | If this substitution required a Tier-2 TTL'd grant, the `grant.id` of that row; NULL for Tier-1 (routing-only). |
| `non_inheritable_excluded` | `boolean NOT NULL DEFAULT TRUE` | No | When TRUE, grants flagged as non-inheritable on this role are excluded from the TTL'd delegation. SHALL default to TRUE (safe default). |
| `proposed_by` | `text NULL` | Yes | Proposer of the substitution rule (employee id or system actor string). |
| `confirmed_by` | `text NULL` | Yes | Confirmer (same contract as `role_assignment.confirmed_by`): NULL = proposal, NOT NULL = effective. |
| `valid_from` | `bigint NULL` | Yes | Unix epoch ms; NULL = since beginning. |
| `valid_until` | `bigint NULL` | Yes | Unix epoch ms; NULL = no end. |
| `source` | `text NOT NULL` | No | How this rule was created (e.g. `"manual"`, `"api"`, `"system"`). |
| `created_by` | `text NOT NULL` | No | Employee id or system actor string that created the row. |
| `created_at` | `bigint NOT NULL` | No | Unix epoch ms. |
| `updated_at` | `bigint NOT NULL` | No | Unix epoch ms. |

PK: `(tenant_id, id)`.
CHECK: `absent_employee_id != substitute_employee_id` — a person cannot substitute for themselves.
CHECK: `valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until` — window sanity.

### FR-2 — Confirmation contract (mirroring T-0022)

A `substitution_rule` row is ONLY effective when `confirmed_by IS NOT NULL`. A proposed (unconfirmed) rule is recorded but contributes zero capability. This mirrors the `role_assignment` contract (T-0022 / migration 020).

### FR-3 — T-0013 isolation invariants

`substitution_rule` is a tenant-isolated table:
- `tenant_id NOT NULL`, no default, leading PK column.
- `FORCE ROW LEVEL SECURITY` + default-DENY policy (`USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)`).
- `choros_app` role: `SELECT, INSERT, UPDATE, DELETE`; no DDL.

### FR-4 — TTL'd grant: reuse `grant.valid_until` (no new column on `grant`)

When a Tier-2 substitution is needed (no existing pool holder), the substitution API mints a standard `grant` row with:
- `valid_until` = the substitution TTL (epoch ms).
- `valid_from` = now.
- `delegable = false` (a substitute's TTL'd grant is never re-delegable).
- `source = "substitution"` (this is a new source string, not a new column — it rides `granted_by` or a detail field; the architect resolves whether `granted_by` carries a structured source or a new `source` text column is added to `grant`; see NF-4).
- The TTL'd `grant.id` is recorded in `substitution_rule.ttl_grant_id`.

When `valid_until` elapses, `isEffective(grant, nowMs)` returns `false`. The gateway (`resolveFor`) already filters out ineffective grants (step 3 of the decision core). No additional code is needed in the gateway for expiry — TTL expiry is handled by the existing validity window logic.

TTL'd grant minting is NOT in scope for this task's TS module (it is a write-path operation owned by the provisioning/API layer). This spec fixes the WHAT (the contract and the schema): the `grant` row shape that a TTL'd substitution must produce.

### FR-5 — Non-inheritable exclusion

When `non_inheritable_excluded = TRUE` on a `substitution_rule`, no grant whose `resource_type` or `resource_facet` is marked as non-inheritable by the classification/grant model is included in the Tier-2 TTL'd grant set for that rule.

The non-inheritable flag is a property of the **grant itself**: a grant row whose `constraint` jsonb contains `{"non_inheritable": true}` is considered non-inheritable. The spec fixes this shape (see NF-5).

At Tier-2 mint time: the minting caller MUST query the absent principal's grants for `role_id`, filter out those with `constraint.non_inheritable = true`, and only mint TTL'd grants for the non-excluded set.

At Tier-1 (routing only): the stand-in uses their own grants; no exclusion logic is needed since no grant is minted.

### FR-6 — `SubstitutionSource` port (pure, injected)

A new `SubstitutionSource` interface is defined in `src/core/substitution.ts`:

```
interface SubstitutionSource {
  // Returns the effective substitution rules for an absent employee at nowMs.
  // "effective" = confirmed_by NOT NULL AND isEffective-window(valid_from, valid_until, nowMs).
  getActiveSubstitutions(
    tenantId: string,
    absentEmployeeId: string,
    nowMs: number,
  ): Promise<SubstitutionRule[]>;

  // Returns the active substitution rule (if any) where subject is a substitute.
  // Used by the gateway to verify the on_behalf_of claim.
  getSubstitutionForSubstitute(
    tenantId: string,
    substituteEmployeeId: string,
    absentEmployeeId: string,
    roleId: string,
    nowMs: number,
  ): Promise<SubstitutionRule | null>;
}
```

`SubstitutionRule` is the TS mirror of the `substitution_rule` table row (camelCase, string for uuid, number for bigint).

The Postgres-backed implementation lands in T-0053 (same pattern as `GrantSource` / `RecordSource`). T-0035 ships only the interface + a pure in-memory stub for tests.

### FR-7 — `resolveSubstitution` pure function

A pure function `resolveSubstitution(rules: SubstitutionRule[], employeeId: string, roleId: string, orgScope: ScopeElement, ancestry: AncestryOracle, nowMs: number): SubstitutionRule | null` is exported from `src/core/substitution.ts`.

It returns the first effective rule where:
- `rule.absentEmployeeId === employeeId` (or the inverse query direction: stand-in lookup).
- `rule.roleId === roleId`.
- The rule's `org_scope` contains `orgScope` (i.e. `isNarrowerOrEqual(orgScope, rule.orgScope, ancestry) === true`).
- `isEffectiveWindow(rule.validFrom, rule.validUntil, nowMs) === true`.
- `rule.confirmedBy !== null`.

Returns `null` if no rule matches. Pure: no IO, no side effects.

### FR-8 — `on_behalf_of` threading contract

When the routing engine or an API layer processes a substitution-backed action, it MUST supply `on_behalf_of = absentEmployeeId` and `actor = substituteEmployeeId` to `resolveFor`'s `GuardContext` (already defined in `grant-resolver.ts` from T-0032). The gateway appends `actor_event` rows with these two distinct fields. SoD continues to attribute to `COALESCE(on_behalf_of, actor)` (i.e. the absent principal).

No new field is added to `GuardContext` for T-0035; the existing `onBehalfOf?: string | null` field is the carrier.

### FR-9 — Additive-only touch to `grant-resolver.ts`

The only permitted change to `grant-resolver.ts` is the addition of one optional property to `ResolverDeps`:

```
substitution?: SubstitutionSource;
```

No existing property, function, or export is renamed, removed, or signature-changed. The substitution path is inactive when the property is absent (backward-compatible floor, NF-2 pattern).

### FR-10 — `known_tenant_tables.txt` update

`substitution_rule` MUST be added to `ci/checks/known_tenant_tables.txt` (alphabetical position). The cross-tenant CI tests iterate over this file; the new table MUST pass existing cross-tenant probes without modification to the test source.

### FR-11 — Dev seed (idempotent, migration 036)

Migration 036 MUST include a minimal dev-silo seed: one confirmed substitution rule where `a-recon` (agent) substitutes for `e-mironov` (human fin-approver) under the `budget-approver` role in the `fin` department org node. Seed uses fixed UUIDs with `ON CONFLICT DO NOTHING`. The rule is Tier-1 only (`ttl_grant_id = NULL`).

Seed UUIDs (prefix `g0000000`):
- `substitution_rule` id: `g0000000-0000-0000-0000-000000000001`
- `absent_employee_id`: `d0000000-0000-0000-0000-000000000004` (e-mironov, from 020 seed)
- `substitute_employee_id`: `d0000000-0000-0000-0000-000000000002` (a-recon, from 016 seed)
- `role_id`: `e0000000-0000-0000-0000-000000000002` (budget-approver, from 019/020 seed)
- `org_scope`: same fin-department node as in 020 seed.
- `confirmed_by = 'seed'`, `proposed_by = NULL`, `source = 'manual'`.

---

## 3. Non-Functional Requirements

### NF-1 — Migration 036 is idempotent

Migration 036 uses `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` patterns and `ON CONFLICT DO NOTHING` for seed rows. Re-running produces no error.

### NF-2 — Additive, parallel-safe changes to shared files

Any edit to shared files (`grant-resolver.ts`, `grant-lattice.ts`, `actor-event.ts`, `types.ts`) MUST be purely additive: no existing export removed, no existing signature changed, no line deleted. The only shared-file addition is the optional `substitution?: SubstitutionSource` on `ResolverDeps`.

### NF-3 — New logic in new module

The `SubstitutionSource` interface, `SubstitutionRule` type, `resolveSubstitution` function, and all helpers reside in `src/core/substitution.ts` (new file). No existing module is modified except the single additive touch to `ResolverDeps` in `grant-resolver.ts`.

### NF-4 — `grant` table: no new column (TTL rides `valid_until`)

The Tier-2 TTL path MUST NOT add a column to the `grant` table. The existing `valid_until bigint NULL` column (migration 008) is the TTL. The substitution origin is identified via `granted_by` (a text field carrying the creating actor) — no new `source` column on `grant`. If the architect determines a `source` column is needed, it is additive (`ADD COLUMN IF NOT EXISTS`) and T-0035 is the task that adds it (in migration 036 as a second statement). The spec fixes the invariant: `grant` gets at most one additive column from T-0035, numbered in migration 036.

### NF-5 — Non-inheritable flag shape on `grant.constraint`

The non-inheritable exclusion (FR-5) uses a convention on the existing `grant.constraint jsonb NULL` column: `{"non_inheritable": true}` marks a grant as non-delegable to substitutes. This is a convention (no new column, no schema change to `grant`). The `resolveSubstitution` caller queries for this shape at Tier-2 mint time. The fitness check verifies the convention is documented.

### NF-6 — `tsc --noEmit`, eslint, `npm run fitness` pass

All three CI gates MUST be green after T-0035's commit. No new module-level test file is required from this spec (the acceptance criteria cover integration/fitness checks); unit tests for `resolveSubstitution` are an implementation-phase decision.

### NF-7 — Migration seam

Migrations 032–035 are occupied by T-0020 (032), T-0040 (033, role-criticality), T-0044 (031 already applied), and other in-flight tasks. T-0035 MUST use exactly 036 (and optionally 037). No other number is permitted.

---

## 4. Explicit Out of Scope

- HTTP endpoints for creating/querying substitution rules — future API task.
- Routing-engine implementation (task-pool auto-reassignment on absence signal) — orchestrator/process-engine layer, not this task.
- Absence calendar / leave management integration — external to Choros core.
- Stage-2 agent-runtime substitution (e.g. an agent substituting for another agent at the A2A level) — Stage-2 parked.
- Postgres-backed `SubstitutionSource` implementation — T-0053 (same pattern as `GrantSource`).
- Dual-control gate for substitution-rule creation — T-0044 (E4.6) already covers criticality-based dual-control on grant/assignment changes; `substitution_rule` rows that mint Tier-2 grants are subject to T-0044 if the TTL'd grant triggers a criticality-escalating expansion.
- UI for substitution management — future front-end task.
- Automatic TTL expiry cleanup jobs — operational concern, not a schema invariant.

---

## 5. Downstream contracts (frozen seams)

### C-1 · T-0053 (Postgres compose / DB layer)

The Postgres-backed `SubstitutionSource` implementation must satisfy `SubstitutionSource` (FR-6). The join:
- Filters on `tenant_id` (RLS), `confirmed_by IS NOT NULL`, and validity window `[valid_from, valid_until)`.
- Orders by `valid_from DESC NULLS LAST` (most-recent rule first, stable tiebreak).

### C-2 · T-0044 (dual-control)

If a Tier-2 TTL'd grant would expand a criticality-(a/b/c) capability, the dual-control gate (T-0044) MUST fire on the grant mint operation. T-0035 does NOT implement this gate; it documents the invariant so T-0044 can reference it.

### C-3 · T-0019 / T-0021 (actor-event ledger / gateway)

Any substitute-backed action MUST supply `onBehalfOf = absentEmployeeId` and `actor = substituteEmployeeId` to `GuardContext`. The `actor_event` row produced MUST have `on_behalf_of = absentEmployeeId`, `actor = substituteEmployeeId`. SoD attributes to `COALESCE(on_behalf_of, actor)`.

### C-4 · Task-routing layer (future)

The routing layer consults `SubstitutionSource.getActiveSubstitutions(tenantId, absentEmployeeId, nowMs)` to find Tier-1 stand-ins. If `substitution_rule.ttl_grant_id IS NULL`, the stand-in uses their existing role — no grant is minted. If `ttl_grant_id IS NOT NULL`, the stand-in's Tier-2 grant is already live; routing proceeds.

---

## 6. Acceptance Criteria

| ID | Text | Verifiable as |
|---|---|---|
| AC-1 | Migration file `migrations/036_substitution_rule.sql` exists; has `CREATE TABLE choros.substitution_rule` with PK `(tenant_id, id)`, all columns from FR-1, CHECK `absent_employee_id != substitute_employee_id`, CHECK window sanity, and FKs to `employee` (both sides) and `role`. | fitness |
| AC-2 | `substitution_rule` has `FORCE ROW LEVEL SECURITY` and a `USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)` policy. | test |
| AC-3 | A cross-tenant read on `substitution_rule` (tenant B context, tenant A data) returns 0 rows. | test |
| AC-4 | A cross-tenant write on `substitution_rule` (tenant B context, tenant A `tenant_id`) is rejected (RLS violation). | test |
| AC-5 | INSERT into `substitution_rule` with `absent_employee_id = substitute_employee_id` is rejected (CHECK constraint). | test |
| AC-6 | A `substitution_rule` with `confirmed_by IS NULL` is NOT returned by `SubstitutionSource.getActiveSubstitutions` (proposal-only, zero capability). | test |
| AC-7 | A `substitution_rule` with `valid_until` in the past is NOT returned by `SubstitutionSource.getActiveSubstitutions` at `nowMs > valid_until`. | test |
| AC-8 | `resolveSubstitution` returns `null` when no effective rule matches `(employeeId, roleId, orgScope)`. | test |
| AC-9 | `resolveSubstitution` returns the rule when an effective rule matches, and `isNarrowerOrEqual(orgScope, rule.orgScope, ancestry) === true`. | test |
| AC-10 | A Tier-2 TTL'd grant row has `delegable = false` and `valid_until` set to the substitution TTL. After `nowMs > valid_until`, `isEffective(grant, nowMs) === false` and `resolveFor` denies with `"no_grant"`. | test |
| AC-11 | A grant with `constraint = {"non_inheritable": true}` is excluded from Tier-2 TTL'd grant minting when `non_inheritable_excluded = true` on the `substitution_rule`. | test |
| AC-12 | An `actor_event` row produced by a substitute action has `actor = substituteEmployeeId` and `on_behalf_of = absentEmployeeId` (they are distinct). | test |
| AC-13 | `src/core/substitution.ts` is a new file; `grant-resolver.ts` gains exactly one optional `substitution?: SubstitutionSource` on `ResolverDeps` and no other change. `grant-lattice.ts`, `actor-event.ts`, `types.ts` are unmodified. | fitness |
| AC-14 | `ci/checks/known_tenant_tables.txt` contains `substitution_rule`; the cross-tenant CI tests pass for the new table without modification to the test source. | fitness |
| AC-15 | Dev seed: after applying migration 036, one `substitution_rule` row exists for `a-recon` substituting `e-mironov` under `budget-approver` in `fin` org node, with `confirmed_by = 'seed'`. | test |
| AC-16 | Migration 036 is idempotent: running the migration runner twice produces no error. | test |
| AC-17 | No migration file numbered 032–035 or 038+ is introduced by T-0035's commit. | fitness |
| AC-18 | `tsc --noEmit`, eslint, and `npm run fitness` (existing) are all green after T-0035's commit. | fitness |
| AC-19 | `grant-resolver.ts` `resolveFor` behavior is unchanged when `deps.substitution` is absent: all existing tests pass with no modification. | test |
| AC-20 | The `substitution_rule.ttl_grant_id` FK references `choros."grant"(tenant_id, id)` — a Tier-1 rule with `ttl_grant_id = NULL` is stored without error; a Tier-2 rule with a valid `grant.id` FK is stored without error. | test |

---

## 7. BLOCKING questions

**None.** All design questions are resolved by the GT-1-signed backlog (2026-06-08):
- Three-tier model (routing / TTL-grant / non-inheritable exclusion): ratified in `playbooks/rbac-backlog.md#E4.7` and hypothesis §3 Q6.
- `on_behalf_of ≠ performed_by`: the T-0019 actor-event contract already pins this (migration 018, `actor_event.on_behalf_of`); T-0035 threads it through, adds no new decision.
- TTL mechanism: the `grant.valid_until` + `isEffective` path is already implemented in T-0018; T-0035 uses it as-is.
- Migration seam (036): given by the orchestrator prompt.
- Parallel safety: resolved by the new-module-only rule.

Status: **ready** — no founder escalation required.
