/**
 * T-0029: Scoped administration (E3.3) — pure TS, no DB/IO/LLM.
 *
 * Administration is NOT a subsystem. It is the pattern *hold a delegable grant
 * on `mgmt_object:X`*. This module ships the day-1 admin-narrowing checker —
 * `validateAdminDelegation` — a THIN composition that reuses the T-0018 lattice
 * (`grant-lattice.ts`) VERBATIM along BOTH narrowing axes:
 *
 *   1. Resource/org-scope axis (the delegated grant): `validateNarrowing`
 *      proves `child.scope ⊑ adminGrant.scope`, `adminGrant.delegable === true`,
 *      non-widening facet/constraint. No re-implementation of subset math.
 *   2. Org/admin-boundary axis (the assignment & target): the admin may act only
 *      within the org subtree(s) their administering assignment's `org_scope`
 *      admits. Reuse `isNarrowerOrEqual` over `hierarchy:"org"`. No new algebra.
 *
 * Self-elevation (FR-3) is NOT a separate rule — it is a corollary: a
 * self-elevating write has a child not `⊑` the granter on some axis, so one of
 * the two gates rejects it.
 *
 * The genesis `tenant-owner` is the un-parented delegation root: owner-minted
 * grants are NOT subset-checked against a parent (there is none above the owner).
 * `isGenesisOwner` is an INJECTED boolean — the algebra is kept ignorant of
 * "owner"; the migration 026 seed is what makes the flag true for the seeded owner.
 *
 * PURE: no DB/network/LLM IO; the `AncestryOracle` is injected; never mutates,
 * never persists. The DB write-path that CALLS this before INSERT and the editor
 * UI are T-0030. `grant-resolver.ts` / `grant-lattice.ts` are NOT edited.
 *
 * Semantic contract: §2 of docs/design/T-0029-scoped-admin.adr.md.
 */

import {
  type Grant,
  type ScopeElement,
  type AncestryOracle,
  type NarrowingResult,
  validateNarrowing,
  isNarrowerOrEqual,
} from "./grant-lattice.js";

// ---------------------------------------------------------------------------
// Frozen day-1 mgmt-object kind set (AC-1, NF-7)
// ---------------------------------------------------------------------------

/**
 * The day-1 management-object kinds. Admin authority over each is expressed
 * as ordinary `grant` rows whose `resourceType` is one of these `mgmt_object:*`
 * values — there is NO separate admin table/flag/role-kind (NF-1/AC-8).
 *
 * Frozen here for the siblings that consume it: T-0030 (write-API/UI) and
 * T-0039 (LLM-proposes).
 *
 * T-0469 [auth] — the three ORG-OBJECT kinds (`department`, `position`,
 * `employee`) are added so that org-structure authoring (the seed-write.ts
 * routes) is DELEGABLE: a holder of a covering, delegable
 * `mgmt_object:department|position|employee` grant gains owner-like authoring
 * power over those objects WITHOUT being the genesis owner. This is the
 * mechanism the `role-constructor-admin` role is built on (owner-rights MINUS
 * owner-deletion). NOTE: there is deliberately NO `mgmt_object:employee:delete`
 * delegation in role-constructor-admin and NO `mgmt_object:assignment` kind —
 * employee DELETION and any role_assignment mutation (incl. the tenant-owner
 * assignment) remain OWNER-ONLY. Adding a kind here only makes the OBJECT
 * delegable; which OPERATIONS a given role may delegate is decided by the
 * grant rows seeded for that role (see registerTenant role-constructor-admin).
 */
export const MGMT_OBJECT_KINDS = [
  "mgmt_object:role",
  "mgmt_object:agent",
  "mgmt_object:process",
  "mgmt_object:grant",
  // T-0469 — org-structure objects, delegable for role-constructor-admin.
  "mgmt_object:department",
  "mgmt_object:position",
  "mgmt_object:employee",
] as const;

/** A day-1 mgmt-object resource-type literal. */
export type MgmtObjectKind = (typeof MGMT_OBJECT_KINDS)[number];

/** True iff `t` is one of the frozen day-1 mgmt-object kinds. */
export function isMgmtObjectKind(t: string): t is MgmtObjectKind {
  return (MGMT_OBJECT_KINDS as readonly string[]).includes(t);
}

// ---------------------------------------------------------------------------
// Checker contract (NF-7 — frozen for T-0030 / T-0039)
// ---------------------------------------------------------------------------

/**
 * The administering principal's authority context.
 *
 * `isGenesisOwner` is INJECTED — never derived inside the lattice (FR-4). The
 * `adminGrants` are the covering, confirmed, in-window, delegable `mgmt_object:*`
 * grants reachable through the admin's assignment(s); `adminOrgScope` is the
 * org/admin ceiling (the union of the administering assignment's `org_scope`).
 */
export interface AdminContext {
  /** INJECTED — the seeded genesis `tenant-owner`; the un-parented delegation root. */
  isGenesisOwner: boolean;
  /** Covering, confirmed, in-window, delegable `mgmt_object:*` grants. */
  adminGrants: Grant[];
  /** `hierarchy:"org"` — the admin/org ceiling (assignment org_scope ∪). */
  adminOrgScope: ScopeElement;
}

/**
 * What the admin is trying to delegate downward.
 *
 *  - `grant`: minting/editing a downstream `grant` row — both axes apply.
 *  - `assignment`: binding a principal within an org subtree — the org-axis gate
 *    IS the whole check (an assignment delegates org reach, not a resource grant).
 *
 * `targetOrgScope` is the org context the delegation lands in (the child grant's
 * org scope, or the assignee's org context) — checked `⊑ adminOrgScope`.
 */
export type DelegationTarget =
  | { kind: "grant"; childGrant: Grant; targetOrgScope: ScopeElement }
  | { kind: "assignment"; targetOrgScope: ScopeElement };

/**
 * Typed rejection union — extends T-0018's `NarrowingResult` with the two
 * admin-axis reasons. Kept a discriminated union so T-0030's API surfaces
 * distinct errors (NF-7).
 *
 *   - `scope_widens` / `facet_widens` / `constraint_widens`
 *     / `parent_non_delegable` / `free_form_non_delegable`  ← NarrowingResult, verbatim
 *   - `org_scope_widens`   ← NEW: target escapes the admin's org/admin boundary
 *   - `no_admin_authority` ← NEW: non-owner with no covering mgmt-grant
 */
export type AdminDelegationResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "scope_widens"
        | "facet_widens"
        | "constraint_widens"
        | "parent_non_delegable"
        | "free_form_non_delegable"
        | "org_scope_widens"
        | "no_admin_authority";
    };

// ---------------------------------------------------------------------------
// validateAdminDelegation — the FR-2 admin write-path gate
// ---------------------------------------------------------------------------

/**
 * validateAdminDelegation(admin, target, oracle) — the admin write-path gate.
 *
 * PURE — no DB/net/LLM IO; never mutates, never persists. The T-0030 write-API
 * calls this BEFORE `INSERT`; a rejection blocks persistence.
 *
 * Decision order (frozen for T-0030 / T-0039 — ADR §2):
 *
 *   1. Freeform owner-only. A `grant` target whose `childGrant.scope` is
 *      `freeform` is accepted ONLY if `admin.isGenesisOwner` (the write-path
 *      forces `delegable=false` on it, reusing T-0018 FR-6); a non-owner freeform
 *      mint ⇒ `free_form_non_delegable`.
 *   2. Org-axis gate (the admin/org boundary; owner exempt — it is the
 *      un-parented root that owns the whole forest). If `!isGenesisOwner` and
 *      `!isNarrowerOrEqual(target.targetOrgScope, admin.adminOrgScope)` ⇒
 *      `org_scope_widens`.
 *   3. Owner short-circuit. If `isGenesisOwner` ⇒ `{ok:true}` (no parent-subset
 *      check — there is no parent above the owner; FR-4).
 *   4. No-authority. Else if no `adminGrants` member covers the target ⇒
 *      `no_admin_authority`.
 *   5. Resource-axis gate. For `kind === "grant"`, return
 *      `validateNarrowing(coveringAdminGrant, childGrant, oracle)` (its reasons
 *      surface verbatim). For `kind === "assignment"`, the org-axis gate (step 2)
 *      IS the whole check.
 */
export function validateAdminDelegation(
  admin: AdminContext,
  target: DelegationTarget,
  oracle: AncestryOracle,
): AdminDelegationResult {
  // --- Step 1: Freeform owner-only ----------------------------------------
  // A freeform child scope is outside the lattice — only the genesis owner may
  // mint one (T-0018 FR-6); a non-owner freeform mint is rejected up front.
  if (target.kind === "grant" && target.childGrant.scope.kind === "freeform") {
    if (admin.isGenesisOwner) {
      return { ok: true };
    }
    return { ok: false, reason: "free_form_non_delegable" };
  }

  // --- Step 2: Org-axis gate (admin/org boundary; owner exempt) ------------
  // The owner owns the whole forest, so this gate only fires for non-owners.
  // The target's org context must be ⊑ the admin's org ceiling.
  if (!admin.isGenesisOwner) {
    if (!isNarrowerOrEqual(target.targetOrgScope, admin.adminOrgScope, oracle)) {
      return { ok: false, reason: "org_scope_widens" };
    }
  }

  // --- Step 3: Owner short-circuit (un-parented root; FR-4) ----------------
  if (admin.isGenesisOwner) {
    return { ok: true };
  }

  // --- Step 4: No-authority (non-owner with no covering mgmt-grant) --------
  // For a grant target, "covers" requires resourceType+operation match and a
  // valid narrowing; for an assignment target, the org-axis gate (step 2) IS
  // the whole check, so any delegable admin grant suffices as authority.
  if (target.kind === "assignment") {
    const hasAuthority = admin.adminGrants.some((g) => g.delegable);
    if (!hasAuthority) {
      return { ok: false, reason: "no_admin_authority" };
    }
    // Org reach already proven by step 2.
    return { ok: true };
  }

  // --- Step 5: Resource-axis gate (kind === "grant") -----------------------
  // Find covering admin grants: same mgmt-object resourceType, same operation,
  // delegable. Accept if ANY admits a valid narrowing (most-specific selection
  // is not required day-1, ADR §2).
  const child = target.childGrant;
  const covering = admin.adminGrants.filter(
    (g) =>
      g.delegable &&
      g.resourceType === child.resourceType &&
      g.operation === child.operation,
  );

  if (covering.length === 0) {
    return { ok: false, reason: "no_admin_authority" };
  }

  // Accept-if-any: the first covering grant that yields a clean narrowing wins.
  // Otherwise surface the rejection reason from the last evaluated covering grant
  // (deterministic: the covering list order is the admin.adminGrants order).
  let lastReject: Exclude<NarrowingResult, { ok: true }> | null = null;
  for (const adminGrant of covering) {
    const r = validateNarrowing(adminGrant, child, oracle);
    if (r.ok) {
      return { ok: true };
    }
    lastReject = r;
  }

  // No covering grant admitted the narrowing — surface the verbatim reason.
  return lastReject ?? { ok: false, reason: "scope_widens" };
}
