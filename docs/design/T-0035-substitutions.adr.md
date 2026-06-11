# ADR · T-0035 — Substitutions / Absences (E4.7)

**Status:** ready (DESIGN complete; no founder escalation)
**Phase:** DESIGN
**Date:** 2026-06-11
**Task:** E4.7 — absence routing, TTL'd delegation grant, non-inheritable exclusion, end-to-end `on_behalf_of ≠ performed_by`.
**Spec:** `docs/specs/T-0035-substitutions.spec.md` (commit `0f75fbc`) + `docs/specs/T-0035.spec.contract.json`.
**Runtime target:** pure static-now TS core. `src/core/substitution.ts` is a pure module — no DB / IO / LLM; all substitution state arrives via an injected `SubstitutionSource` port. The Postgres-backed port + RLS DAO land in **T-0053** (identical pattern to `GrantSource` / `RecordSource` / `SodSource`). Migration 036 DDL runs under the `choros_migrator` role; the read path runs under `choros_app` within `withTenant` (T-0013). No new runtime process, no new dependency (zero-dep beyond the existing `pg` used only in T-0053).

---

## 1. Context

The spec is ratified (GT-1-signed backlog `playbooks/rbac-backlog.md#E4.7`, hypothesis §3 Q6). It fixes a two-tier absence model and an `on_behalf_of` discipline, and pins every seam (migration 036, new-module-only, additive `ResolverDeps` touch). This ADR adds **no new decision** — it freezes the field/type contract, the DDL sketch, the TS signatures, and the fitness functions that make the seams CI-enforceable. All 20 AC trace to a fitness function or a live-DB/unit test obligation (§9).

The design is deliberately a thin kernel: **no new authority algebra, no new validity mechanism, no new actor-event field.** Tier-1 mints nothing. Tier-2 reuses the existing `grant.valid_until` + `isEffective` validity window (T-0018) and the existing `grant.constraint` jsonb convention. The `on_behalf_of ≠ performed_by` discipline rides the existing `GuardContext.onBehalfOf` (T-0032) into the existing `actor_event.on_behalf_of` column (T-0019). Substitution is therefore a **routing/declaration layer** over already-ratified primitives, not a fourth permission subsystem.

---

## 2. Decision

1. **`substitution_rule` table (migration 036)** — a tenant-isolated declaration of who substitutes for whom, over which role and org-scope, across a validity window, with the same proposal/confirmation contract as `role_assignment` (T-0022): `confirmed_by IS NULL` ⇒ proposal (zero capability); `confirmed_by IS NOT NULL` ⇒ effective. T-0013 isolation invariants apply verbatim (tenant_id leading PK, FORCE RLS, default-DENY policy, `choros_app` DML-only). FKs include `tenant_id` on both sides (no cross-tenant FK). `ttl_grant_id` is a nullable self-typed FK into `choros."grant"(tenant_id, id)` — NULL for Tier-1, the minted grant's id for Tier-2.

2. **Two-tier model.**
   - **Tier-1 (default, zero-mint):** when another employee already holds the stand-in `role_id` within the org-scope, the (future) routing layer reassigns the task; no grant is minted; the stand-in acts under their own role authority. `substitution_rule.ttl_grant_id IS NULL`.
   - **Tier-2 (fallback, TTL'd grant):** when there is no pool holder, the (future) write-API mints a standard `grant` row with `valid_until` = the TTL, `valid_from` = now, `delegable = false`, and records the grant id in `substitution_rule.ttl_grant_id`. Expiry needs **no new code in the gateway**: `isEffective(grant, now)` already returns `false` past `valid_until`, and `resolveFor` step 3 already filters ineffective grants ⇒ denial `"no_grant"` (AC-10).

3. **`grant` table: NO new column.** The TTL rides the existing `grant.valid_until bigint NULL` (migration 008). The substitution origin is carried by `granted_by` (the existing text actor field; e.g. `"substitution:<rule_id>"`), **not** a new `source` column. The NF-4 optional escape (an additive `source` column on `grant` in 036) is **rejected by this ADR** as unnecessary — `granted_by` is sufficient to identify provenance, and adding a column to a frozen, parallel-touched table widens the blast radius for no benefit. `migrations/008_grant.sql` is therefore a **frozen file** in this task (FF-SUB4).

4. **Non-inheritable exclusion is a `grant.constraint` jsonb convention.** A grant is non-inheritable to substitutes iff its `constraint` jsonb satisfies `{"non_inheritable": true}`. No new column, no schema change to `grant`. At Tier-2 mint time the minting caller (write-API, out of scope here) MUST query the absent principal's grants for `role_id`, drop those matching this convention when `substitution_rule.non_inheritable_excluded = TRUE`, and mint TTL'd grants only for the remainder. This ADR fixes the convention shape and exports a pure predicate `isNonInheritable(grant)` from `substitution.ts` so the mint-site and tests share one definition (AC-11).

5. **`SubstitutionSource` port + `resolveSubstitution` pure function** live in the new file `src/core/substitution.ts`. The port has the two spec-fixed read methods; the pure function selects the first effective rule matching `(employeeId, roleId, orgScope)` using the **existing** `isNarrowerOrEqual` (T-0018) over the org hierarchy + the validity-window + `confirmedBy !== null` predicates. No lattice math is re-implemented (the org-containment check delegates to the injected `AncestryOracle`).

6. **Additive-only touch to `grant-resolver.ts`:** exactly one optional property `substitution?: SubstitutionSource` is added to `ResolverDeps`. No existing export, signature, or line is changed; `resolveFor` behavior is byte-identical when the property is absent (AC-19). The substitution port is **not consulted inside `resolveFor`** in this task — the resolver merely carries the wiring so the future routing layer and the composition root can inject it without a later signature break. (Rationale: routing reassignment and Tier-2 mint are write-path / orchestrator concerns, explicitly out of scope; `resolveFor` continues to decide purely on T-0018 grant rows, so no Tier-2 grant gets special-cased in the PDP — a Tier-2 grant is just a grant.)

7. **`on_behalf_of` threading** uses the existing `GuardContext.onBehalfOf` (T-0032) → `actor_event.on_behalf_of` (T-0019). A substitute action supplies `actor = substituteEmployeeId`, `onBehalfOf = absentEmployeeId`; SoD attribution stays `COALESCE(on_behalf_of, actor)` = the absent principal (T-0019 `actorEventPrincipal`). **No new field on `GuardContext` or `actor_event`** (AC-12); `actor-event.ts` is a frozen file (FF-SUB4).

8. **CI surface:** `substitution_rule` is added to `ci/checks/known_tenant_tables.txt` so the table-agnostic `cross_tenant.test.ts` sweeps it without a test-source edit (FR-10, AC-14); the new fitness script `ci/checks/substitution-isolation.sh` is appended to `npm run fitness`.

---

## 3. Rejected alternatives

| Option | Why not |
|---|---|
| New `valid_until_ttl` (or `is_substitution`) column on `grant` | NF-4 forbids a TTL column; `valid_until` + `isEffective` already are the TTL. A provenance column is also unnecessary — `granted_by` carries origin. Touching the frozen, parallel-edited `008_grant.sql` widens collision risk for zero gain. |
| New `source` text column on `grant` (the NF-4 escape hatch) | Permitted by the spec but not needed: `granted_by = "substitution:<rule_id>"` identifies provenance without a schema change. Keeping `grant` frozen is the smaller, safer kernel (rule 3 proportionality). |
| Consult `SubstitutionSource` inside `resolveFor` to auto-resolve a stand-in at decision time | Out of scope (routing-engine reassignment is orchestrator-layer, §4 of spec). It would also re-introduce a mint-time/decision-time fork into the PDP. The PDP must keep deciding on grant rows only (the T-0021 single-projection / no-second-subsystem invariant). The port is wired but unconsulted. |
| New `substitution` scope hierarchy or new lattice element kind | No new algebra is needed: org-scope containment is the existing `isNarrowerOrEqual` over hierarchy `org`. |
| Enforce `confirmed_by` / window via DB CHECK | Mirrors role_assignment (T-0022): the proposal/confirmation + window semantics are enforced at the **resolution boundary** (the port query / pure function), not by a CHECK — consistent with how `role_assignment` and `grant` store their windows. DB enforces NOT NULL + valid jsonb + the two structural CHECKs only. |
| New `actor_event` column to mark "substituted action" | No: the existing `actor ≠ on_behalf_of` pair already encodes it; `detail` can carry the rule id if a consumer needs it. Frozen file. |

---

## 4. Object model (single field/type contract)

### 4.1 DDL sketch — `migrations/036_substitution_rule.sql`

`org_scope` is a grant-lattice `ScopeElement` of hierarchy `org` (single `{kind:node,hierarchy:org,...}` or `{kind:set,members:[...]}`); the DB enforces NOT NULL + valid jsonb only (deeper structural validation is an application/write-API invariant — mirrors `role_assignment.org_scope` and `grant.scope`). Window sanity and the self-substitution ban are the **only** DB CHECKs.

```sql
-- 036 · substitution_rule (T-0035 E4.7) — who substitutes for whom, over what
-- role and org_scope, across [valid_from, valid_until). Proposal/confirmation
-- contract mirrors role_assignment (020). Tenant-isolated (T-0013). TTL'd grant
-- (Tier-2) is recorded by ttl_grant_id → choros."grant"(tenant_id, id); NULL for
-- Tier-1 (routing-only, no grant minted). ADDITIVE & IDEMPOTENT.

CREATE TABLE IF NOT EXISTS choros.substitution_rule (
  tenant_id               uuid    NOT NULL,
  id                      uuid    NOT NULL,
  absent_employee_id      uuid    NOT NULL,
  substitute_employee_id  uuid    NOT NULL,
  role_id                 uuid    NOT NULL,
  org_scope               jsonb   NOT NULL,
  ttl_grant_id            uuid    NULL,
  non_inheritable_excluded boolean NOT NULL DEFAULT TRUE,
  proposed_by             text    NULL,
  confirmed_by            text    NULL,
  valid_from              bigint  NULL,
  valid_until             bigint  NULL,
  source                  text    NOT NULL,
  created_by              text    NOT NULL,
  created_at              bigint  NOT NULL,
  updated_at              bigint  NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT substitution_rule_no_self_sub
    CHECK (absent_employee_id <> substitute_employee_id),
  CONSTRAINT substitution_rule_window_sane
    CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until),
  FOREIGN KEY (tenant_id, absent_employee_id)
    REFERENCES choros.employee(tenant_id, id),
  FOREIGN KEY (tenant_id, substitute_employee_id)
    REFERENCES choros.employee(tenant_id, id),
  FOREIGN KEY (tenant_id, role_id)
    REFERENCES choros.role(tenant_id, id),
  FOREIGN KEY (tenant_id, ttl_grant_id)
    REFERENCES choros."grant"(tenant_id, id)
);

ALTER TABLE choros.substitution_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.substitution_rule FORCE ROW LEVEL SECURITY;

CREATE POLICY substitution_rule_tenant_isolation ON choros.substitution_rule
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.substitution_rule TO choros_app;

-- Dev silo seed (AC-15): a-recon substitutes e-mironov under budget-approver in
-- the fin department org node. Tier-1 (ttl_grant_id NULL). confirmed_by='seed'.
-- Idempotent via fixed UUID PK + ON CONFLICT DO NOTHING.
INSERT INTO choros.substitution_rule
  (tenant_id, id, absent_employee_id, substitute_employee_id, role_id, org_scope,
   ttl_grant_id, non_inheritable_excluded, proposed_by, confirmed_by,
   valid_from, valid_until, source, created_by, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'g0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000004',  -- e-mironov (absent)
   'd0000000-0000-0000-0000-000000000002',  -- a-recon (substitute)
   'e0000000-0000-0000-0000-000000000002',  -- budget-approver
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, TRUE, NULL, 'seed', NULL, NULL, 'manual', 'seed', 0, 0)
ON CONFLICT DO NOTHING;
```

> **FK note.** The `(tenant_id, ttl_grant_id)` composite FK to `choros."grant"` is satisfiable with a NULL `ttl_grant_id` (a partial composite FK with a NULL column is not enforced in PostgreSQL — MATCH SIMPLE default), so Tier-1 rows store cleanly; Tier-2 rows require a live `grant.id` (AC-20). The migration is ordered after 008/016/019, all of which precede 036, so all referenced tables exist at apply time (NF-1/AC-1).

### 4.2 `substitution_rule` columns (authoritative)

| Column | SQL type | Nullable | TS mirror (`SubstitutionRule`) | TS type |
|---|---|---|---|---|
| `tenant_id` | `uuid` | NO | `tenantId` | `string` |
| `id` | `uuid` | NO | `id` | `string` |
| `absent_employee_id` | `uuid` | NO | `absentEmployeeId` | `string` |
| `substitute_employee_id` | `uuid` | NO | `substituteEmployeeId` | `string` |
| `role_id` | `uuid` | NO | `roleId` | `string` |
| `org_scope` | `jsonb` | NO | `orgScope` | `ScopeElement` (from grant-lattice.ts) |
| `ttl_grant_id` | `uuid` | YES | `ttlGrantId` | `string \| null` |
| `non_inheritable_excluded` | `boolean` | NO (DEFAULT TRUE) | `nonInheritableExcluded` | `boolean` |
| `proposed_by` | `text` | YES | `proposedBy` | `string \| null` |
| `confirmed_by` | `text` | YES | `confirmedBy` | `string \| null` |
| `valid_from` | `bigint` | YES | `validFrom` | `number \| null` |
| `valid_until` | `bigint` | YES | `validUntil` | `number \| null` |
| `source` | `text` | NO | `source` | `string` |
| `created_by` | `text` | NO | `createdBy` | `string` |
| `created_at` | `bigint` | NO | `createdAt` | `number` |
| `updated_at` | `bigint` | NO | `updatedAt` | `number` |

PK `(tenant_id, id)`. CHECK `absent_employee_id <> substitute_employee_id`. CHECK window sanity. FKs: both employee sides, role, and ttl_grant_id → grant — all composite with `tenant_id` (no cross-tenant FK).

### 4.3 TS contract — `src/core/substitution.ts` (signatures)

```ts
import {
  type ScopeElement,
  type AncestryOracle,
  type Grant,
  isNarrowerOrEqual,
} from "./grant-lattice.js";

/** camelCase TS mirror of one substitution_rule row (string=uuid, number=bigint epoch-ms). */
export interface SubstitutionRule {
  tenantId: string;
  id: string;
  absentEmployeeId: string;
  substituteEmployeeId: string;
  roleId: string;
  orgScope: ScopeElement;        // hierarchy "org"
  ttlGrantId: string | null;     // NULL=Tier-1 (routing only); set=Tier-2 grant id
  nonInheritableExcluded: boolean;
  proposedBy: string | null;
  confirmedBy: string | null;    // null=proposal (zero capability); non-null=effective
  validFrom: number | null;
  validUntil: number | null;
  source: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** The injected read PORT (Postgres-backed impl lands in T-0053). */
export interface SubstitutionSource {
  /** Effective rules for an absent employee at nowMs (confirmed + in-window). */
  getActiveSubstitutions(
    tenantId: string,
    absentEmployeeId: string,
    nowMs: number,
  ): Promise<SubstitutionRule[]>;

  /** The active rule (if any) authorizing `substitute` to act for `absent` under `role`. */
  getSubstitutionForSubstitute(
    tenantId: string,
    substituteEmployeeId: string,
    absentEmployeeId: string,
    roleId: string,
    nowMs: number,
  ): Promise<SubstitutionRule | null>;
}

/** Half-open validity window [validFrom, validUntil) at nowMs. Null bounds = open. Pure. */
export function isEffectiveWindow(
  validFrom: number | null,
  validUntil: number | null,
  nowMs: number,
): boolean;

/** A rule is effective iff confirmed AND in-window. Pure. */
export function isRuleEffective(rule: SubstitutionRule, nowMs: number): boolean;

/**
 * Pure selection over already-fetched rules. Returns the first effective rule where
 *   rule.absentEmployeeId === employeeId
 *   && rule.roleId === roleId
 *   && isNarrowerOrEqual(orgScope, rule.orgScope, ancestry)   // requested scope ⊑ rule scope
 *   && isRuleEffective(rule, nowMs)
 * else null. No IO, no side effects.
 */
export function resolveSubstitution(
  rules: SubstitutionRule[],
  employeeId: string,
  roleId: string,
  orgScope: ScopeElement,
  ancestry: AncestryOracle,
  nowMs: number,
): SubstitutionRule | null;

/** The non-inheritable convention on grant.constraint: {"non_inheritable": true}. Pure. */
export function isNonInheritable(grant: Grant): boolean;

/**
 * Tier-2 mint filter (FR-5): the subset of `roleGrants` eligible for a TTL'd
 * substitution grant under `rule`. When rule.nonInheritableExcluded is true, drops
 * grants where isNonInheritable(g). Pure helper for the (out-of-scope) mint site.
 */
export function eligibleForTier2(rule: SubstitutionRule, roleGrants: Grant[]): Grant[];

/** A pure in-memory SubstitutionSource over a fixed rule array (tests / dev). */
export function makeInMemorySubstitutionSource(rules: SubstitutionRule[]): SubstitutionSource;
```

### 4.4 The single additive touch — `grant-resolver.ts` `ResolverDeps`

```ts
// imported additively at the top of grant-resolver.ts:
import { type SubstitutionSource } from "./substitution.js";

export interface ResolverDeps {
  grants: GrantSource;
  records: RecordSource;
  ancestry: AncestryOracle;
  classifications?: ClassificationSource; // T-0033
  effects?: EffectSource;                 // T-0034
  sod?: SodSource;                         // T-0032
  substitution?: SubstitutionSource;       // T-0035 — wired, NOT consulted in resolveFor
  now?: () => number;
}
```

The import + one optional field are the **only** edits to `grant-resolver.ts`. No function body changes; `resolveFor` is byte-stable when `substitution` is absent or present (it is never read). This is the same additive pattern as `classifications?` / `effects?` / `sod?`, but with no decision-core step attached (rationale §2.6).

---

## 5. Contracts (frozen seams for downstream tasks)

- **C-1 · T-0053 (Postgres `SubstitutionSource`):** implements the port; the JOIN filters on `tenant_id` (RLS), `confirmed_by IS NOT NULL`, half-open window `[valid_from, valid_until)`, orders `valid_from DESC NULLS LAST`. Same DAO pattern as `GrantSource`/`RecordSource`/`SodSource`.
- **C-2 · T-0044 (dual-control):** if a Tier-2 TTL'd grant expands a criticality-(a/b/c) capability, the T-0044 gate fires on the grant-mint op. T-0035 documents the invariant; it does not implement the gate.
- **C-3 · T-0019 / T-0021 (actor-event / gateway):** substitute action ⇒ `GuardContext{ actor: substituteEmployeeId, onBehalfOf: absentEmployeeId }`; the appended `actor_event` row carries both distinct; SoD attributes to `COALESCE(on_behalf_of, actor)`. Uses existing fields only.
- **C-4 · Task-routing layer (future):** consults `getActiveSubstitutions`; `ttl_grant_id IS NULL` ⇒ Tier-1 (stand-in uses own role, no mint); `ttl_grant_id NOT NULL` ⇒ Tier-2 grant already live, routing proceeds.
- **C-5 · Tier-2 mint site (future write-API):** uses `eligibleForTier2(rule, roleGrants)` + `isNonInheritable` to pick the grant set; mints `grant` rows with `delegable=false`, `valid_until`=TTL, `granted_by="substitution:<rule_id>"`; writes the new grant id back to `substitution_rule.ttl_grant_id`. No new `grant` column.

---

## 6. Fitness functions (one per breakable boundary)

| ID | Rule | CI check |
|---|---|---|
| FF-SUB1 | `substitution.ts` introduces no parallel-authority/visibility store (`_acl`, `substitution_visibility`, `substitutionRights`, `substitutionAcl` absent in non-comment code) — rights derive from rules + T-0018 grant rows only. | `bash ci/checks/substitution-isolation.sh` |
| FF-SUB2 | `substitution.ts` imports no `pg`/`fs`/`net`/`http` — all state via the injected `SubstitutionSource` port (DB DAO → T-0053). | `bash ci/checks/substitution-isolation.sh` |
| FF-SUB3 | `grant-resolver.ts` import surface preserved: `resolveFor`/`makeGrantResolver`/`projectFields`/`visibleFields`/`refToScope` still exported, `grantFacetFields` present, and the substitution port is OPTIONAL (`substitution?:`). | `bash ci/checks/substitution-isolation.sh` |
| FF-SUB4 | Frozen files carry no diff in this commit: `grant-lattice.ts`, `object-handle.ts`, `actor-event.ts`, `types.ts`, `migrations/008_grant.sql`, `migrations/020_role_assignment.sql`. | `bash ci/checks/substitution-isolation.sh` |
| FF-SUB5 | Migration seam: a `migrations/036_*.sql` exists and no `032..035`/`038+` migration is introduced by this task (only 036, optionally 037). | `bash ci/checks/substitution-isolation.sh` |
| FF-SUB6 | `ci/checks/known_tenant_tables.txt` lists `substitution_rule` so the table-agnostic `cross_tenant.test.ts` sweeps it without a test edit. | `bash ci/checks/substitution-isolation.sh` |
| FF-SUB7 | Live-DB: `substitution_rule` exists with PK `(tenant_id,id)`, FORCE RLS + default-DENY policy, both CHECKs, all FKs; cross-tenant read returns 0 rows; cross-tenant write + self-substitution INSERT rejected; the seed row is present. | `npm run fitness:db` (table swept by `ci/checks/db/cross_tenant.test.ts` + `schema.test.ts` via `KNOWN_TENANT_TABLES`) |
| FF-SUB8 | `resolveSubstitution` / `isRuleEffective` purity + selection semantics (confirmed-only, in-window, scope-containment, null on no match); `eligibleForTier2` drops non-inheritable grants when excluded. | unit tests (impl phase) over `src/core/substitution.ts` |
| FF-SUB9 | `tsc --noEmit`, `eslint src`, `npm run fitness` all green. | `npm run ci` |

---

## 7. Traceability (20 AC → coverage)

| AC | Covered by |
|---|---|
| AC-1 | FF-SUB5 (036 exists) + §4.1 DDL + FF-SUB7 (`schema.test.ts` table-exists) |
| AC-2 | FF-SUB7 (`schema.test.ts` FORCE-RLS sweep over KNOWN_TENANT_TABLES) + §4.1 policy |
| AC-3 | FF-SUB7 (`cross_tenant.test.ts` cross-tenant read = 0 rows) |
| AC-4 | FF-SUB7 (`cross_tenant.test.ts` cross-tenant write rejected) |
| AC-5 | FF-SUB7 (CHECK `substitution_rule_no_self_sub`) |
| AC-6 | FF-SUB8 (`isRuleEffective`/`getActiveSubstitutions` drop `confirmedBy === null`) |
| AC-7 | FF-SUB8 (`isEffectiveWindow` drops `nowMs >= validUntil`) |
| AC-8 | FF-SUB8 (`resolveSubstitution` → null on no match) |
| AC-9 | FF-SUB8 (`resolveSubstitution` → rule when `isNarrowerOrEqual(orgScope, rule.orgScope)`) |
| AC-10 | Reuse of `isEffective`/`resolveFor` (no new code) + FF-SUB8 unit: Tier-2 grant `delegable=false`, post-`valid_until` ⇒ `resolveFor` `"no_grant"` |
| AC-11 | FF-SUB8 (`isNonInheritable` + `eligibleForTier2` exclusion) |
| AC-12 | C-3 + §2.7: existing `GuardContext.onBehalfOf` → `actor_event.on_behalf_of`; `actor ≠ on_behalf_of` |
| AC-13 | FF-SUB3 (resolver surface) + FF-SUB4 (frozen `grant-lattice.ts`/`actor-event.ts`/`types.ts`) + new-file `substitution.ts` |
| AC-14 | FF-SUB6 (table in known list) + FF-SUB7 (cross-tenant sweep, no test-source edit) |
| AC-15 | §4.1 seed + FF-SUB7 (seed-row presence probe) |
| AC-16 | NF-1: `CREATE TABLE IF NOT EXISTS` + `ON CONFLICT DO NOTHING` (idempotent re-run) |
| AC-17 | FF-SUB5 (no 032-035/038+ introduced) |
| AC-18 | FF-SUB9 (`npm run ci`: tsc + eslint + fitness green) |
| AC-19 | FF-SUB3 (additive optional `substitution?`; resolver body unchanged ⇒ existing tests pass) |
| AC-20 | FF-SUB7 (Tier-1 NULL `ttl_grant_id` stored; Tier-2 valid `grant.id` FK stored; MATCH-SIMPLE NULL composite-FK note §4.1) |

---

## 8. Live-DDL note

No `choros_migrator`-role Postgres was reachable from the worktree at design time (the local `:5432` lacks the `choros_migrator` role). Per the seam rule, the DDL is **not** applied live in this phase; its correctness is a **CI obligation**: the `db` job runs `node migrations/run.mjs` then `npm run fitness:db`, where the table-agnostic `schema.test.ts` (FORCE-RLS + table-exists) and `cross_tenant.test.ts` (read/write isolation) sweep `substitution_rule` via `KNOWN_TENANT_TABLES` — already wired by FF-SUB6. The structural CHECKs, FKs, and seed are verified there.

---

## 9. Status

**ready** — no founder escalation. Every spec decision was pre-ratified (GT-1 backlog); this ADR fixes contracts and rejects the two NF-4 escape hatches (TTL column, `source` column) in favor of the thinner kernel. The single architect judgment exercised — *do not consult `SubstitutionSource` inside `resolveFor`* (§2.6) — is a proportionality call within the spec's "routing is out of scope" boundary, not a direction change.
