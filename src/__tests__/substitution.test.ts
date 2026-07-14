/**
 * T-0035 · FF-SUB8 unit tests — substitution.ts purity and selection semantics.
 *
 * Covers:
 *   AC-6  — proposal (confirmedBy null) ⇒ zero capability (not returned by in-memory source)
 *   AC-7  — expired rule (nowMs ≥ validUntil) ⇒ not returned
 *   AC-8  — resolveSubstitution → null when no effective rule matches
 *   AC-9  — resolveSubstitution → rule when effective rule matches (scope containment)
 *   AC-10 — Tier-2 grant: delegable=false, isEffective past valid_until ⇒ false
 *   AC-11 — eligibleForTier2 drops {non_inheritable:true} grants when excluded
 *
 * All IO is behind in-memory ports (SubstitutionSource via makeInMemorySubstitutionSource).
 * No DB, no pg, no fs. Tests pin their own environment (D-056 discipline).
 */
import { describe, it, expect } from "vitest";
import {
  type SubstitutionRule,
  type SubstitutionSource,
  isEffectiveWindow,
  isRuleEffective,
  resolveSubstitution,
  isNonInheritable,
  eligibleForTier2,
  makeInMemorySubstitutionSource,
} from "../core/substitution.js";
import { type Grant, type AncestryOracle, isEffective } from "../core/grant-lattice.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const T = "a0000000-0000-0000-0000-000000000001";
const ABSENT_EMP = "d0000000-0000-0000-0000-000000000004";  // e-mironov
const SUBSTITUTE_EMP = "d0000000-0000-0000-0000-000000000002"; // a-recon
const ROLE_ID = "e0000000-0000-0000-0000-000000000002"; // budget-approver
const NOW = 1_000_000; // arbitrary "now"

const FIN_SCOPE = {
  kind: "node" as const,
  hierarchy: "org" as const,
  nodeId: "b0000000-0000-0000-0000-000000000001",
  nodeLevel: "department" as const,
};

/** A flat ancestry oracle: nodeId is always a descendant-or-self of itself. */
const flatOracle: AncestryOracle = {
  isDescendantOrSelf(_h, descendant, ancestor) {
    return descendant === ancestor;
  },
};

function makeRule(overrides: Partial<SubstitutionRule> = {}): SubstitutionRule {
  return {
    tenantId: T,
    id: "g0000000-0000-0000-0000-000000000001",
    absentEmployeeId: ABSENT_EMP,
    substituteEmployeeId: SUBSTITUTE_EMP,
    roleId: ROLE_ID,
    orgScope: FIN_SCOPE,
    ttlGrantId: null,
    nonInheritableExcluded: true,
    proposedBy: null,
    confirmedBy: "seed",
    validFrom: null,
    validUntil: null,
    source: "manual",
    createdBy: "seed",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    tenantId: T,
    id: "f0000000-0000-0000-0000-000000000001",
    roleId: ROLE_ID,
    resourceType: "application",
    operation: "read",
    scope: FIN_SCOPE,
    delegable: false,
    grantedBy: "substitution:g0000000-0000-0000-0000-000000000001",
    createdAt: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isEffectiveWindow
// ---------------------------------------------------------------------------

describe("isEffectiveWindow", () => {
  it("null,null ⇒ always true", () => {
    expect(isEffectiveWindow(null, null, NOW)).toBe(true);
  });

  it("nowMs < validFrom ⇒ false (before open)", () => {
    expect(isEffectiveWindow(NOW + 1, null, NOW)).toBe(false);
  });

  it("nowMs === validFrom ⇒ true (inclusive start)", () => {
    expect(isEffectiveWindow(NOW, null, NOW)).toBe(true);
  });

  it("nowMs < validUntil ⇒ true (half-open end, before expiry)", () => {
    expect(isEffectiveWindow(null, NOW + 1, NOW)).toBe(true);
  });

  it("nowMs === validUntil ⇒ false (half-open: strictly less)", () => {
    expect(isEffectiveWindow(null, NOW, NOW)).toBe(false);
  });

  it("nowMs > validUntil ⇒ false (expired)", () => {
    expect(isEffectiveWindow(null, NOW - 1, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isRuleEffective
// ---------------------------------------------------------------------------

describe("isRuleEffective", () => {
  it("confirmed + open window ⇒ true", () => {
    expect(isRuleEffective(makeRule(), NOW)).toBe(true);
  });

  it("confirmedBy null (proposal) ⇒ false — AC-6", () => {
    expect(isRuleEffective(makeRule({ confirmedBy: null }), NOW)).toBe(false);
  });

  it("expired validUntil ⇒ false — AC-7", () => {
    expect(isRuleEffective(makeRule({ validUntil: NOW - 1 }), NOW)).toBe(false);
  });

  it("validUntil in future ⇒ true", () => {
    expect(isRuleEffective(makeRule({ validUntil: NOW + 1 }), NOW)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveSubstitution — AC-8, AC-9
// ---------------------------------------------------------------------------

describe("resolveSubstitution", () => {
  it("empty rules ⇒ null — AC-8", () => {
    expect(resolveSubstitution([], ABSENT_EMP, ROLE_ID, FIN_SCOPE, flatOracle, NOW)).toBeNull();
  });

  it("no matching employeeId ⇒ null — AC-8", () => {
    const rules = [makeRule({ absentEmployeeId: "other-employee" })];
    expect(resolveSubstitution(rules, ABSENT_EMP, ROLE_ID, FIN_SCOPE, flatOracle, NOW)).toBeNull();
  });

  it("no matching roleId ⇒ null — AC-8", () => {
    const rules = [makeRule({ roleId: "other-role" })];
    expect(resolveSubstitution(rules, ABSENT_EMP, ROLE_ID, FIN_SCOPE, flatOracle, NOW)).toBeNull();
  });

  it("proposal only (confirmedBy null) ⇒ null — AC-8", () => {
    const rules = [makeRule({ confirmedBy: null })];
    expect(resolveSubstitution(rules, ABSENT_EMP, ROLE_ID, FIN_SCOPE, flatOracle, NOW)).toBeNull();
  });

  it("expired rule ⇒ null — AC-8", () => {
    const rules = [makeRule({ validUntil: NOW - 1 })];
    expect(resolveSubstitution(rules, ABSENT_EMP, ROLE_ID, FIN_SCOPE, flatOracle, NOW)).toBeNull();
  });

  it("scope not contained by rule orgScope ⇒ null — AC-8", () => {
    // Different department node; flatOracle only matches identical nodeIds.
    const otherScope = { ...FIN_SCOPE, nodeId: "b0000000-0000-0000-0000-000000000099" };
    const rules = [makeRule()]; // rule orgScope = FIN_SCOPE
    expect(resolveSubstitution(rules, ABSENT_EMP, ROLE_ID, otherScope, flatOracle, NOW)).toBeNull();
  });

  it("effective rule with matching scope ⇒ returns rule — AC-9", () => {
    const rules = [makeRule()];
    const result = resolveSubstitution(rules, ABSENT_EMP, ROLE_ID, FIN_SCOPE, flatOracle, NOW);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("g0000000-0000-0000-0000-000000000001");
  });

  it("returns first match from multiple rules — AC-9", () => {
    const rule1 = makeRule({ id: "aaaa0000-0000-0000-0000-000000000001" });
    const rule2 = makeRule({ id: "bbbb0000-0000-0000-0000-000000000002" });
    const rules = [rule1, rule2];
    const result = resolveSubstitution(rules, ABSENT_EMP, ROLE_ID, FIN_SCOPE, flatOracle, NOW);
    expect(result!.id).toBe("aaaa0000-0000-0000-0000-000000000001");
  });
});

// ---------------------------------------------------------------------------
// isNonInheritable — grant.constraint convention
// ---------------------------------------------------------------------------

describe("isNonInheritable", () => {
  it("no constraint ⇒ false", () => {
    expect(isNonInheritable(makeGrant())).toBe(false);
  });

  it("constraint = undefined ⇒ false", () => {
    expect(isNonInheritable(makeGrant({ constraint: undefined }))).toBe(false);
  });

  it("constraint = {} ⇒ false", () => {
    expect(isNonInheritable(makeGrant({ constraint: {} }))).toBe(false);
  });

  it("constraint = { non_inheritable: false } ⇒ false", () => {
    expect(isNonInheritable(makeGrant({ constraint: { non_inheritable: false } }))).toBe(false);
  });

  it("constraint = { non_inheritable: true } ⇒ true", () => {
    expect(isNonInheritable(makeGrant({ constraint: { non_inheritable: true } }))).toBe(true);
  });

  it("constraint has non_inheritable:true plus other fields ⇒ true", () => {
    expect(isNonInheritable(makeGrant({ constraint: { non_inheritable: true, other: "x" } }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// eligibleForTier2 — AC-11
// ---------------------------------------------------------------------------

describe("eligibleForTier2", () => {
  const inheritableGrant = makeGrant({ id: "f0000000-0000-0000-0000-000000000001" });
  const nonInheritableGrant = makeGrant({
    id: "f0000000-0000-0000-0000-000000000002",
    constraint: { non_inheritable: true },
  });
  const grants = [inheritableGrant, nonInheritableGrant];

  it("nonInheritableExcluded=true drops non-inheritable grants — AC-11", () => {
    const rule = makeRule({ nonInheritableExcluded: true });
    const result = eligibleForTier2(rule, grants);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("f0000000-0000-0000-0000-000000000001");
  });

  it("nonInheritableExcluded=false keeps all grants", () => {
    const rule = makeRule({ nonInheritableExcluded: false });
    const result = eligibleForTier2(rule, grants);
    expect(result).toHaveLength(2);
  });

  it("empty grants ⇒ empty result", () => {
    const rule = makeRule({ nonInheritableExcluded: true });
    expect(eligibleForTier2(rule, [])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// makeInMemorySubstitutionSource — AC-6, AC-7
// ---------------------------------------------------------------------------

describe("makeInMemorySubstitutionSource", () => {
  it("getActiveSubstitutions returns only confirmed + in-window rules — AC-6, AC-7", async () => {
    const confirmed = makeRule({ id: "cc000000-0000-0000-0000-000000000001" });
    const proposal = makeRule({ id: "pp000000-0000-0000-0000-000000000002", confirmedBy: null });
    const expired = makeRule({ id: "ee000000-0000-0000-0000-000000000003", validUntil: NOW - 1 });
    const source: SubstitutionSource = makeInMemorySubstitutionSource([confirmed, proposal, expired]);
    const results = await source.getActiveSubstitutions(T, ABSENT_EMP, NOW);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("cc000000-0000-0000-0000-000000000001");
  });

  it("getActiveSubstitutions filters by tenantId", async () => {
    const rule = makeRule({ tenantId: "other-tenant" });
    const source = makeInMemorySubstitutionSource([rule]);
    const results = await source.getActiveSubstitutions(T, ABSENT_EMP, NOW);
    expect(results).toHaveLength(0);
  });

  it("getSubstitutionForSubstitute returns matching rule", async () => {
    const rule = makeRule();
    const source = makeInMemorySubstitutionSource([rule]);
    const result = await source.getSubstitutionForSubstitute(
      T, SUBSTITUTE_EMP, ABSENT_EMP, ROLE_ID, NOW,
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe("g0000000-0000-0000-0000-000000000001");
  });

  it("getSubstitutionForSubstitute returns null when no match — AC-6 (proposal)", async () => {
    const rule = makeRule({ confirmedBy: null });
    const source = makeInMemorySubstitutionSource([rule]);
    const result = await source.getSubstitutionForSubstitute(
      T, SUBSTITUTE_EMP, ABSENT_EMP, ROLE_ID, NOW,
    );
    expect(result).toBeNull();
  });

  it("getSubstitutionForSubstitute returns null when expired — AC-7", async () => {
    const rule = makeRule({ validUntil: NOW - 1 });
    const source = makeInMemorySubstitutionSource([rule]);
    const result = await source.getSubstitutionForSubstitute(
      T, SUBSTITUTE_EMP, ABSENT_EMP, ROLE_ID, NOW,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-10: Tier-2 TTL'd grant — isEffective (T-0018) past valid_until ⇒ false
// ---------------------------------------------------------------------------

describe("AC-10: Tier-2 TTL'd grant via T-0018 isEffective", () => {
  it("Tier-2 grant with delegable=false and valid_until: isEffective = true before expiry", () => {
    const grant = makeGrant({ delegable: false, validUntil: NOW + 1000 });
    expect(isEffective(grant, NOW)).toBe(true);
    expect(grant.delegable).toBe(false);
  });

  it("Tier-2 grant: isEffective = false AT valid_until (half-open)", () => {
    const grant = makeGrant({ delegable: false, validUntil: NOW });
    expect(isEffective(grant, NOW)).toBe(false);
  });

  it("Tier-2 grant: isEffective = false past valid_until — AC-10", () => {
    const grant = makeGrant({ delegable: false, validUntil: NOW - 1 });
    expect(isEffective(grant, NOW)).toBe(false);
  });
});
