# Spec · T-0040 — `role_criticality` computation (E4.5)

**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-06-11
**Task:** E4.5 — `role_criticality(role) → {approve_or_transition, external_invoke, sensitive_read}` computed from grants + data-classification; enables D-A = A3 (T-0044 consumer). Day-1.
**Authoritative source:** `playbooks/rbac-backlog.md#E4.5` (GT-1, founder-signed 2026-06-08) ·
`playbooks/rbac-discovery-phase1-hypothesis.md` §7 (D-A = A3, signed), §5, §6-B.
**Build DAG:** Deps E2.3 (T-0021 resolver), E4.3 (T-0033 data-classification), E4.4 (T-0034 effect-resource). Consumer: T-0044 (E4.6 dual-control gate).

**Foundation (do NOT contradict — all merged on the dev base 99d6612):**
- `src/core/grant-lattice.ts` (T-0018) — `Grant`, `Operation` (`read|create|update|delete|approve|transition|invoke`),
  `ResourceType` (incl. literal `"effect_resource"`), `ScopeElement`, `isEffective`. The criticality
  function reads `Grant` rows only — it owns NO lattice math and introduces NO second authority subsystem.
- `src/core/data-classification.ts` (T-0033) — the closed `DataClass` axis
  (`public|internal|confidential|restricted`, ordered least→most sensitive), `DATA_CLASS_ORDER`,
  `deriveClearance(coveringGrants, nowMs?)` → `Clearance = DataClass | null` (reads the
  `{clearance: DataClass}` marker off `grant.constraint` / `grant.resourceFacet`). T-0033 explicitly
  names T-0040 as the `role_criticality` S-3 join that imports `DataClass` and does NOT redeclare it.
- `src/core/effect-resource.ts` (T-0034) — the `effect_resource` resource type; a held effect grant is
  `resourceType==="effect_resource" ∧ operation==="invoke"`. T-0034 names T-0040 as the consumer that
  derives the `external_invoke` bit from `effect_resource` grants.
- `migrations/019_role.sql` / `020_role_assignment.sql` / `021_grant_role_fk.sql` (T-0022) — `role` is
  the principal; `grant.role_id` is a real tenant-scoped FK to `role(tenant_id, id)`. **A role ⊃ its
  grants via `grant.role_id`** — this is the join the function consumes.
- `migrations/017_data_classification.sql` (T-0033) — `data_classification(resource_type, facet_field,
  facet_schema_version, class)`; `class` is the closed `DataClass` axis. NO egress column (that is T-0041).

**Siblings referenced, not built here:**
- T-0044 (E4.6 dual-control gate) — the consumer. On an assignment/grant change it computes the
  **effective** criticality expansion and requires **two distinct approvers iff** any of the three bits
  fires (a/b/c), single scoped-approver otherwise. **T-0044 owns the gate; T-0040 owns ONLY the
  computation + the contract it exposes.** The contract is fixed in §5 below.
- T-0041 (S-1 `egress_policy`) — parallel `DataClass` join; not consumed here.
- T-0053 (Postgres DAO) — the durable/materialized port; the in-memory `GrantSource`-style port is
  injected here, mirroring T-0021/T-0033/T-0034 deferral.

---

## 0. Scope resolution — what "role_criticality computed from grants + data-classification" means today

The signed model (recap, `rbac-backlog.md` line 33–37; hypothesis §7 D-A = A3) keys dual-control to
**capability criticality, not subtree**. Two approvers are required iff an assignment expands the
subject's ability to:

- **(a)** approve / execute a **guarded transition** → `approve_or_transition`;
- **(b)** invoke **external endpoints / integrations** → `external_invoke`;
- **(c)** read **PII / financially-sensitive data above a threshold** → `sensitive_read`.

T-0040 is the **day-1 cost of D-A = A3**: the pure, computable function that, for any role, derives those
three bits from (i) the role's grant rows (joined via `grant.role_id`) and (ii) the `data_classification`
table — **nothing else**. It is explicitly **NOT Stage-2** (hypothesis §7 D-A backlog implication).

**Derived, not stored (§6-B decision).** `role_criticality` is a **pure computation over existing rows**,
NOT a new persisted column and NOT a new table. The backlog phrasing is "computed from grants +
data-classification" and the acceptance is "derivable from its grants + the classification table". A
stored column would (1) duplicate authority state that already lives in `grant` + `data_classification`
(violating the rights-derived-only invariant the resolver enforces), and (2) require a write-path
re-derivation hook on every grant/classification change — strictly worse than recomputing on read.
Therefore: **no migration, no new table, no new column.** (Materialization for performance is a T-0053
concern if ever needed; the day-1 contract is the pure function.) Migration seam 030+ is consequently
**unused** by this task.

What is NOT yet built and IS built here: the pure `roleCriticality(...)` function + its typed contract,
in a new `src/core/role-criticality.ts`, importing `DataClass`/`deriveClearance` from T-0033, `Grant`/
`Operation`/`isEffective` from T-0018, and the effect-grant predicate semantics from T-0034 — with NO
edit to any of those frozen modules and NO migration.

---

## 1. Functional requirements

- **FR-1 (role ⊃ grants join).** The function input is the set of `Grant` rows whose `role_id` equals the
  target role's id (within one tenant). The caller supplies these rows via an injected port
  (`RoleGrantSource.getRoleGrants(tenantId, roleId)`); the function performs no IO. This mirrors T-0021's
  `GrantSource` and keeps the Postgres JOIN deferred to T-0053.

- **FR-2 (approve_or_transition bit, axis a).** `approve_or_transition === true` iff the role holds ≥1
  **effective** grant with `operation ∈ {"approve", "transition"}`. (These are the two guarded-transition
  op-classes; cf. T-0033 `evaluateReclassification` and E4.2.)

- **FR-3 (external_invoke bit, axis b).** `external_invoke === true` iff the role holds ≥1 **effective**
  grant with `resourceType === "effect_resource" ∧ operation === "invoke"` — the exact predicate T-0034's
  `verifyEffectGrants` matches at the gateway.

- **FR-4 (sensitive_read bit, axis c).** `sensitive_read === true` iff the role holds ≥1 **effective**
  `read` grant whose **conferred clearance reaches the sensitivity threshold** for some classified field.
  Concretely: `deriveClearance(readGrants, nowMs)` yields a `DataClass`, and that class's sensitivity rank
  is `≥ threshold` where the day-1 threshold is **`confidential`** (i.e. `confidential` or `restricted`).
  The "above a threshold" wording of D-A (c) is encoded as a single named constant
  `SENSITIVE_READ_THRESHOLD: DataClass = "confidential"` read off `DATA_CLASS_ORDER`. A `read` grant
  conferring only `public`/`internal` clearance does NOT set the bit (the threshold carveout).

- **FR-5 (criticality level / carveout).** The function additionally derives a level:
  `level = "critical"` iff **any** of the three bits is `true`; `level = "routine"` otherwise. This is the
  exact single-approver-carveout the acceptance requires ("a single-approver carveout is distinguishable
  from the unsafe case"): `level === "routine"` ⇔ T-0044's single-scoped-approver path;
  `level === "critical"` ⇔ T-0044's two-distinct-approver path.

- **FR-6 (effective grants only).** Out-of-window grants confer zero capability: every bit consults only
  grants for which `isEffective(grant, nowMs) === true`. `nowMs` is a function parameter (no `Date.now`
  inside the core) so the computation is pure (equal inputs + same `nowMs` ⇒ equal output).

- **FR-7 (T-0044 contract — fixed seam).** The function returns a frozen `RoleCriticality` record (§5)
  consumed by T-0044. T-0044 computes the **effective expansion** as a structural diff of two
  `RoleCriticality` records (from-state vs to-state) and requires two approvers iff any bit flips
  `false→true` (or the to-state level is `critical` and the from-state is not). **T-0040 exposes the
  computation and the record shape; the diff and the gate are T-0044.** The record shape and the
  `combineDiff(from, to)` helper signature are part of THIS contract (BLOCKING if changed).

- **FR-8 (tenant isolation, derived).** The function operates on grants already scoped to one tenant by the
  injected port (T-0053 will RLS-scope the JOIN). The function itself adds no cross-tenant edge: grants
  from a foreign tenant are never passed in, and the function never reads a global store. (No new table ⇒
  no new `known_tenant_tables` / cross-tenant fitness entry.)

- **FR-9 (export seam).** `src/core/role-criticality.ts` exports: `RoleCriticality`,
  `RoleCriticalityLevel`, `RoleGrantSource`, `roleCriticality`, `combineCriticality` (the bit-merge over a
  set of grants), `criticalityLevel`, `criticalityDiff`, and the constant `SENSITIVE_READ_THRESHOLD`.
  T-0044 imports them without re-declaration or cast.

## 2. Non-functional requirements

- **NF-1 (pure / static-now).** `src/core/role-criticality.ts` imports no `pg`/`fs`/`net`/`http`; all DB
  access is behind the injected `RoleGrantSource` port (in-memory now, Postgres DAO in T-0053). Mirrors
  T-0021/T-0033/T-0034.
- **NF-2 (no second authority subsystem / rights-derived-only).** Every bit derives **solely** from
  `Grant` rows (via T-0018 predicates) + `DataClass` (via T-0033 `deriveClearance`). No parallel
  criticality store, no `_acl`/`criticalityRights`/`critFlags` token, no second algebra. An isolation
  check (`ci/checks/role-criticality-isolation.sh`) asserts the banned tokens + the no-IO import floor.
- **NF-3 (fail-closed / fail-critical bias).** Doubt resolves toward MORE criticality, never less: a
  corrupt/unknown `operation`, a `null` clearance that cannot be proven below threshold, or a malformed
  grant counts as NOT lowering a bit. Specifically, an unparseable `operation` value on a grant is treated
  as potentially guarded (does not silently drop the `approve_or_transition` bit if the row otherwise looks
  like a transition grant) — the safe direction for a dual-control trigger is to over-, not under-,
  flag. (Concrete fail-closed rules enumerated in §4.)
- **NF-4 (no new npm dependency).** Zero-dep stdlib/TS only.
- **NF-5 (frozen-foundation).** The commit does NOT edit `grant-lattice.ts`, `data-classification.ts`,
  `effect-resource.ts`, `grant-resolver.ts`, `object-handle.ts`, or any migration. `tsc --noEmit` passes.
- **NF-6 (no migration).** No migration file is added (§0). Migration seam 030+ stays unused. No change to
  `ci/checks/known_tenant_tables.txt` or the cross-tenant fitness set.
- **NF-7 (determinism).** `roleCriticality` called twice with the same `(grants, nowMs, classifications)`
  yields deep-equal output; no IO outside the injected port.

## 3. Out of scope (explicit non-goals)

- The **dual-control gate itself** (two-vs-one approver decision, `confirmation_flag`, effective-diff
  application, WORM audit, safe-mode) — that is **T-0044 (E4.6)**.
- **Materializing** criticality into a column/table or a `data_classification`-style row — deferred to
  T-0053 if performance ever requires it; day-1 is the pure function (§0).
- The **Postgres `RoleGrantSource` DAO** — deferred to T-0053 (mirrors GrantSource/RecordSource).
- **`egress_policy` / BYO-LLM egress** criticality — that is T-0041 (S-1), a different `DataClass` join.
- Editing `grant-lattice.ts`, `data-classification.ts`, `effect-resource.ts`, `grant-resolver.ts`,
  `object-handle.ts`, or any migration.
- Wiring the function into a live screen — `web/src/screens/rights/ra-criticality.jsx` is an existing
  mockup; integrating real data is a frontend task, not E4.5.
- Stage-2 agent-runtime concerns (autonomy downgrade, A2A breakers).

## 4. Computation rules (the fail-closed decision table)

For a set `G` of the role's grants and an instant `nowMs`, with `Ge = { g ∈ G | isEffective(g, nowMs) }`:

1. **approve_or_transition** = `Ge.some(g => g.operation === "approve" || g.operation === "transition")`.
   Fail-closed: a grant whose `operation` is not in the closed `Operation` set is NOT used to clear the
   bit; it is ignored for axes a/b/c (it can never make a role *less* critical), so it never lowers a bit.
2. **external_invoke** = `Ge.some(g => g.resourceType === "effect_resource" && g.operation === "invoke")`.
3. **sensitive_read**: let `R = Ge.filter(g => g.operation === "read")`;
   `cl = deriveClearance(R, nowMs)`; bit = `cl !== null && classRank(cl) >= classRank(SENSITIVE_READ_THRESHOLD)`.
   (`SENSITIVE_READ_THRESHOLD = "confidential"`.) A `read` grant with no clearance marker contributes
   `null` and does not raise the bit; a grant conferring `confidential`/`restricted` raises it.
4. **level** = `(approve_or_transition || external_invoke || sensitive_read) ? "critical" : "routine"`.
5. **diff** (`criticalityDiff(from, to)`): for the three bits, an `expanded` flag is set iff
   `to.bit === true && from.bit === false`; `escalates = to.level === "critical" && from.level !== "critical"`.
   T-0044 keys two-approver on `escalates` (equivalently: any `expanded` bit). Cosmetic (`false→false`,
   `true→true`, or a `true→false` *narrowing*) does not escalate.

## 5. The T-0044 contract (frozen seam)

```ts
export type RoleCriticalityLevel = "routine" | "critical";

export interface RoleCriticality {
  approve_or_transition: boolean; // axis a — guarded approve/transition op held
  external_invoke: boolean;       // axis b — effect_resource invoke grant held
  sensitive_read: boolean;        // axis c — read clearance ≥ SENSITIVE_READ_THRESHOLD
  level: RoleCriticalityLevel;    // "critical" iff any axis true (the single-approver carveout)
}

export const SENSITIVE_READ_THRESHOLD: DataClass = "confidential";

// injected port — Postgres DAO deferred to T-0053
export interface RoleGrantSource {
  getRoleGrants(tenantId: string, roleId: string): Promise<Grant[]>;
}

// pure compute over an already-fetched grant set (no IO)
export function combineCriticality(grants: Grant[], nowMs: number): RoleCriticality;

// convenience: fetch via port then combine
export function roleCriticality(
  source: RoleGrantSource, tenantId: string, roleId: string, nowMs: number,
): Promise<RoleCriticality>;

export function criticalityLevel(c: { approve_or_transition: boolean; external_invoke: boolean; sensitive_read: boolean }): RoleCriticalityLevel;

export interface CriticalityDiff {
  expanded: { approve_or_transition: boolean; external_invoke: boolean; sensitive_read: boolean };
  escalates: boolean; // routine→critical
}
export function criticalityDiff(from: RoleCriticality, to: RoleCriticality): CriticalityDiff;
```

T-0044 consumes `RoleCriticality` + `criticalityDiff`; it MUST NOT recompute the bits independently
(single source of truth). Changing this shape after sign-off is a BLOCKING contract break.

## 6. Acceptance criteria (machine-checkable)

See `T-0040.spec.contract.json`. Summary: 18 ACs — bit-derivation (a/b/c), threshold carveout, level/diff,
effective-window, determinism/purity, the export seam, no-migration, and the isolation floor.

## 7. Blocking questions

None. D-A = A3 is founder-signed; the three axes, the "above a threshold" wording, the derived-not-stored
decision (§6-B), and the consumer split (T-0044 owns the gate) are all fixed by the signed map + the
existing merged foundation. The one design choice with a defensible default — the day-1 sensitivity
threshold = `confidential` — is recorded as FR-4 and is a constant the architect may tune within the
closed `DataClass` axis without a spec change (it does not alter scope or the contract shape).
