/**
 * T-0035: Substitutions / Absences (E4.7) — pure TS, no DB/IO/LLM.
 *
 * Delivers the thin declaration layer for the two-tier substitution model:
 *
 *   Tier-1 (routing-layer stand-in, default, zero-mint): when another employee
 *   already holds the stand-in role within the org-scope, the task-routing
 *   engine reassigns; no grant is minted; the stand-in acts under their own
 *   existing role authority. substitution_rule.ttl_grant_id IS NULL.
 *
 *   Tier-2 (TTL'd delegation grant, fallback): when there is no pool holder,
 *   the future write-API mints a standard grant row with valid_until = TTL,
 *   valid_from = now, delegable = false, granted_by = 'substitution:<rule_id>',
 *   recording the grant id in substitution_rule.ttl_grant_id. Expiry is handled
 *   by the existing isEffective(grant, nowMs) path in the PDP — no new gateway
 *   code is needed (ADR §2.2, AC-10).
 *
 * This module:
 *   - Defines SubstitutionRule (TS mirror of the substitution_rule table).
 *   - Defines SubstitutionSource (injected read port; Postgres impl → T-0053).
 *   - Exports isEffectiveWindow / isRuleEffective (window predicates, pure).
 *   - Exports resolveSubstitution (pure selector over already-fetched rules).
 *   - Exports isNonInheritable (grant.constraint jsonb convention).
 *   - Exports eligibleForTier2 (Tier-2 mint-site filter, pure helper).
 *   - Exports makeInMemorySubstitutionSource (test / dev in-memory stub).
 *
 * Design discipline: no second authority subsystem. A Tier-2 grant is a T-0018
 * grant row, never a separate store. org-scope containment delegates to the
 * injected AncestryOracle via the existing isNarrowerOrEqual (T-0018). Pure:
 * all substitution state reaches this module via the injected SubstitutionSource
 * port; no IO, no pg, no fs, no net.
 *
 * Semantic contract: docs/design/T-0035-substitutions.adr.md §4.
 */

import {
  type ScopeElement,
  type AncestryOracle,
  type Grant,
  isNarrowerOrEqual,
} from "./grant-lattice.js";

// ---------------------------------------------------------------------------
// SubstitutionRule — camelCase TS mirror of the substitution_rule table row
// (string = uuid, number = bigint epoch-ms).
// ---------------------------------------------------------------------------

/**
 * One `substitution_rule` row: who substitutes for whom, over which role and
 * org-scope, across [valid_from, valid_until). The proposal/confirmation
 * contract mirrors role_assignment (T-0022): confirmedBy === null ⇒ proposal
 * (zero capability); confirmedBy !== null ⇒ effective.
 *
 * ttlGrantId:
 *   null  = Tier-1 (routing-only, no grant minted; stand-in uses own role).
 *   set   = Tier-2 (the minted TTL'd grant's id; the grant row is in choros.grant).
 *
 * orgScope: a ScopeElement of hierarchy "org" (a single node or a set of nodes).
 */
export interface SubstitutionRule {
  tenantId: string;
  id: string;
  absentEmployeeId: string;
  substituteEmployeeId: string;
  roleId: string;
  /** ScopeElement of hierarchy "org" bounding where this substitution applies. */
  orgScope: ScopeElement;
  /** null = Tier-1 (routing only, no grant minted); set = Tier-2 grant id. */
  ttlGrantId: string | null;
  /** When true, grants with constraint.non_inheritable=true are excluded from Tier-2 minting. */
  nonInheritableExcluded: boolean;
  proposedBy: string | null;
  /** null = proposal (zero capability); non-null = effective. */
  confirmedBy: string | null;
  /** Unix epoch ms; null = open start. */
  validFrom: number | null;
  /** Unix epoch ms; null = open end. */
  validUntil: number | null;
  source: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// SubstitutionSource — injected read port (Postgres-backed impl lands in T-0053)
// ---------------------------------------------------------------------------

/**
 * The injected read PORT for substitution state (mirrors GrantSource /
 * RecordSource / SodSource in structure). The Postgres-backed implementation
 * lands in T-0053 (same DAO pattern, RLS-scoped). This module ships only the
 * interface + a pure in-memory stub for tests / dev.
 *
 * Both methods return ONLY effective rules: confirmed_by IS NOT NULL AND
 * isEffectiveWindow(rule.validFrom, rule.validUntil, nowMs).
 */
export interface SubstitutionSource {
  /**
   * Returns the effective substitution rules for an absent employee at nowMs.
   * "Effective" = confirmedBy NOT NULL AND isEffectiveWindow(validFrom, validUntil, nowMs).
   */
  getActiveSubstitutions(
    tenantId: string,
    absentEmployeeId: string,
    nowMs: number,
  ): Promise<SubstitutionRule[]>;

  /**
   * Returns the active substitution rule (if any) where `substituteEmployeeId`
   * is acting for `absentEmployeeId` under `roleId` at `nowMs`. Used by the
   * gateway to verify the on_behalf_of claim.
   */
  getSubstitutionForSubstitute(
    tenantId: string,
    substituteEmployeeId: string,
    absentEmployeeId: string,
    roleId: string,
    nowMs: number,
  ): Promise<SubstitutionRule | null>;
}

// ---------------------------------------------------------------------------
// isEffectiveWindow — half-open validity window [validFrom, validUntil) at nowMs
// ---------------------------------------------------------------------------

/**
 * Returns true iff nowMs falls within the half-open window [validFrom, validUntil).
 * Null bounds are open (null validFrom ⇒ any past instant is in; null validUntil
 * ⇒ no expiry). Pure: no IO, no side effects.
 *
 * Interval semantics:
 *   from_ok  = validFrom  === null || nowMs >= validFrom
 *   until_ok = validUntil === null || nowMs <  validUntil   (half-open: strictly less)
 */
export function isEffectiveWindow(
  validFrom: number | null,
  validUntil: number | null,
  nowMs: number,
): boolean {
  const fromOk = validFrom === null || nowMs >= validFrom;
  const untilOk = validUntil === null || nowMs < validUntil;
  return fromOk && untilOk;
}

// ---------------------------------------------------------------------------
// isRuleEffective — confirmation + window combined predicate
// ---------------------------------------------------------------------------

/**
 * A rule is effective iff it is confirmed (confirmedBy !== null) AND its
 * validity window contains nowMs. Pure.
 */
export function isRuleEffective(rule: SubstitutionRule, nowMs: number): boolean {
  if (rule.confirmedBy === null) return false;
  return isEffectiveWindow(rule.validFrom, rule.validUntil, nowMs);
}

// ---------------------------------------------------------------------------
// resolveSubstitution — pure selector over already-fetched rules
// ---------------------------------------------------------------------------

/**
 * Pure selection over a pre-fetched rule array. Returns the FIRST effective
 * rule where:
 *   1. rule.absentEmployeeId === employeeId
 *   2. rule.roleId === roleId
 *   3. isNarrowerOrEqual(orgScope, rule.orgScope, ancestry) — the requested
 *      org-scope is contained by the rule's org-scope (i.e. the rule's scope
 *      covers the scope of the request).
 *   4. isRuleEffective(rule, nowMs)
 *
 * Returns null if no rule matches.
 *
 * Pure: no IO, no side effects. Delegates org-hierarchy containment math to the
 * injected AncestryOracle via the existing isNarrowerOrEqual (T-0018); no new
 * lattice algebra is introduced.
 */
export function resolveSubstitution(
  rules: SubstitutionRule[],
  employeeId: string,
  roleId: string,
  orgScope: ScopeElement,
  ancestry: AncestryOracle,
  nowMs: number,
): SubstitutionRule | null {
  for (const rule of rules) {
    if (rule.absentEmployeeId !== employeeId) continue;
    if (rule.roleId !== roleId) continue;
    if (!isRuleEffective(rule, nowMs)) continue;
    // The requested org-scope must be contained by (i.e. narrower than or equal
    // to) the rule's org-scope: isNarrowerOrEqual(child=orgScope, parent=rule.orgScope).
    if (!isNarrowerOrEqual(orgScope, rule.orgScope, ancestry)) continue;
    return rule;
  }
  return null;
}

// ---------------------------------------------------------------------------
// isNonInheritable — grant.constraint jsonb convention
// ---------------------------------------------------------------------------

/**
 * Returns true iff the grant is marked as non-inheritable for substitutes via
 * the grant.constraint jsonb convention: constraint = {"non_inheritable": true}.
 *
 * This is a structural convention (no new column, no schema change to grant).
 * At Tier-2 mint time the minting caller uses this predicate to exclude
 * non-inheritable grants when substitution_rule.non_inheritable_excluded = true.
 * Pure.
 */
export function isNonInheritable(grant: Grant): boolean {
  if (grant.constraint === null || grant.constraint === undefined) return false;
  if (typeof grant.constraint !== "object") return false;
  const c = grant.constraint as Record<string, unknown>;
  return c["non_inheritable"] === true;
}

// ---------------------------------------------------------------------------
// eligibleForTier2 — Tier-2 mint-site filter (pure helper for the write-API)
// ---------------------------------------------------------------------------

/**
 * Returns the subset of `roleGrants` that are eligible for a TTL'd substitution
 * grant under `rule`. When rule.nonInheritableExcluded is true, drops grants
 * for which isNonInheritable(g) is true. Otherwise returns all grants unchanged.
 *
 * This is a pure helper for the (out-of-scope) Tier-2 mint site: it encodes the
 * non-inheritable exclusion invariant (FR-5, AC-11) in a single, testable
 * function so that the mint site and its tests share one definition.
 * Pure: no IO, no side effects.
 */
export function eligibleForTier2(rule: SubstitutionRule, roleGrants: Grant[]): Grant[] {
  if (!rule.nonInheritableExcluded) return roleGrants;
  return roleGrants.filter((g) => !isNonInheritable(g));
}

// ---------------------------------------------------------------------------
// makeInMemorySubstitutionSource — pure in-memory stub (tests / dev)
// ---------------------------------------------------------------------------

/**
 * Creates a pure in-memory SubstitutionSource over a fixed rule array.
 * Used in unit tests and dev scenarios where no Postgres connection is available
 * (mirrors makeInMemoryGrantSource / the in-memory SodSource stub pattern).
 *
 * Both methods filter for effective rules (confirmedBy !== null, in-window) and
 * apply the exact same predicate the Postgres-backed T-0053 implementation will
 * use (C-1 of the ADR), so unit-test coverage transfers to the live DB path.
 */
export function makeInMemorySubstitutionSource(
  rules: SubstitutionRule[],
): SubstitutionSource {
  return {
    async getActiveSubstitutions(
      tenantId: string,
      absentEmployeeId: string,
      nowMs: number,
    ): Promise<SubstitutionRule[]> {
      return rules.filter(
        (r) =>
          r.tenantId === tenantId &&
          r.absentEmployeeId === absentEmployeeId &&
          isRuleEffective(r, nowMs),
      );
    },

    async getSubstitutionForSubstitute(
      tenantId: string,
      substituteEmployeeId: string,
      absentEmployeeId: string,
      roleId: string,
      nowMs: number,
    ): Promise<SubstitutionRule | null> {
      const found = rules.find(
        (r) =>
          r.tenantId === tenantId &&
          r.substituteEmployeeId === substituteEmployeeId &&
          r.absentEmployeeId === absentEmployeeId &&
          r.roleId === roleId &&
          isRuleEffective(r, nowMs),
      );
      return found ?? null;
    },
  };
}
