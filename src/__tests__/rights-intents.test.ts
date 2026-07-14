/**
 * T-0223 · D-2 intent operations — STATIC property tests (pure TS, no DB).
 *
 * These pin the load-bearing security invariant of the substitute intent:
 *
 *   I-2 / FF-SUB-3 — a substitution can NEVER be broader than the substituted
 *   principal. The substitute endpoint mints a Tier-2 grant ONLY when
 *   validateNarrowing(parentGrant, ttlChildGrant, oracle).ok === true; a
 *   constructed widening child (scope-superset / facet-widen / constraint-widen)
 *   is rejected with the matching typed reason and never persisted. This test
 *   exercises the EXACT gate the endpoint calls (validateNarrowing) over the
 *   exact child shape it mints, so the static coverage transfers to the live path.
 *
 *   FF-INTENT-2 / I-1 — the substitute mint loans only grants returned by the
 *   T-0035 mint-site filter eligibleForTier2 (non-inheritable excluded), and the
 *   minted child is non-delegable (delegable=false) — the loaned authority cannot
 *   be re-delegated.
 *
 * Why static: validateNarrowing + eligibleForTier2 are pure; the widening
 * rejection is a property of the gate, not of Postgres. The live DB suite
 * (ci/checks/db/rights-intents.db.test.ts) exercises the HTTP path end-to-end.
 */
import { describe, it, expect } from "vitest";
import {
  type Grant,
  type AncestryOracle,
  validateNarrowing,
} from "../core/grant-lattice.js";
import {
  type SubstitutionRule,
  eligibleForTier2,
} from "../core/substitution.js";

const T = "a0000000-0000-0000-0000-000000000001";
const ROLE = "e0000000-0000-0000-0000-000000000002";

// A flat oracle: a node is a descendant-or-self only of itself. Under it the only
// way child.scope ⊑ parent.scope holds is structural equality / subset.
const flatOracle: AncestryOracle = {
  isDescendantOrSelf(_h, descendant, ancestor) {
    return descendant === ancestor;
  },
};

const FIN_NODE = {
  kind: "node" as const,
  hierarchy: "org" as const,
  nodeId: "b0000000-0000-0000-0000-000000000001",
  nodeLevel: "department" as const,
};
const TREASURY_NODE = {
  kind: "node" as const,
  hierarchy: "org" as const,
  nodeId: "b0000000-0000-0000-0000-000000000099",
  nodeLevel: "department" as const,
};

function parentGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    tenantId: T,
    id: "p0000000-0000-0000-0000-000000000001",
    roleId: ROLE,
    resourceType: "mcp://ledger.invoices" as Grant["resourceType"],
    operation: "read" as Grant["operation"],
    scope: FIN_NODE as Grant["scope"],
    delegable: true,
    grantedBy: "seed",
    createdAt: 0,
    ...overrides,
  };
}

/** The child shape the substitute endpoint mints: identical scope/facet/constraint, delegable=false, TTL'd. */
function mintedChild(parent: Grant, overrides: Partial<Grant> = {}): Grant {
  return {
    tenantId: T,
    id: "c0000000-0000-0000-0000-000000000001",
    roleId: ROLE,
    resourceType: parent.resourceType,
    resourceFacet: parent.resourceFacet,
    operation: parent.operation,
    scope: parent.scope,
    constraint: parent.constraint,
    delegable: false,
    grantedBy: "intent:substitute",
    validFrom: 1_000,
    validUntil: 2_000,
    createdAt: 1_000,
    ...overrides,
  };
}

describe("T-0223 I-2 / FF-SUB-3 — substitution ⊆ substituted (validateNarrowing gate)", () => {
  it("ACCEPTS the mint when the child equals the parent scope (the endpoint's actual mint shape)", () => {
    const parent = parentGrant();
    const child = mintedChild(parent);
    const r = validateNarrowing(parent, child, flatOracle);
    expect(r.ok).toBe(true);
    // The loaned grant is non-re-delegable (I-2).
    expect(child.delegable).toBe(false);
  });

  it("REJECTS a widening substitution — child scope is a SUPERSET of the parent (scope_widens)", () => {
    const parent = parentGrant({ scope: FIN_NODE as Grant["scope"] });
    // A constructed widening child: a different (broader / unrelated) org node.
    const widening = mintedChild(parent, { scope: TREASURY_NODE as Grant["scope"] });
    const r = validateNarrowing(parent, widening, flatOracle);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scope_widens");
  });

  it("REJECTS a constraint-widening substitution — parent has a ceiling, child drops it (constraint_widens)", () => {
    const parent = parentGrant({
      resourceType: "mcp://payments.initiate" as Grant["resourceType"],
      operation: "invoke" as Grant["operation"],
      constraint: { amount_le: 250000 },
    });
    // Child without the constraint = unconstrained = WIDER.
    const widening = mintedChild(parent, { constraint: undefined });
    const r = validateNarrowing(parent, widening, flatOracle);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("constraint_widens");
  });

  it("REJECTS loaning a non-delegable parent (parent_non_delegable) — the endpoint skips it", () => {
    const parent = parentGrant({ delegable: false });
    const child = mintedChild(parent);
    const r = validateNarrowing(parent, child, flatOracle);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("parent_non_delegable");
  });
});

describe("T-0223 I-1 / FF-INTENT-2 — substitute loans only eligible (inheritable) grants", () => {
  function rule(overrides: Partial<SubstitutionRule> = {}): SubstitutionRule {
    return {
      tenantId: T,
      id: "r0000000-0000-0000-0000-000000000001",
      absentEmployeeId: "d0000000-0000-0000-0000-000000000004",
      substituteEmployeeId: "d0000000-0000-0000-0000-000000000002",
      roleId: ROLE,
      orgScope: FIN_NODE,
      ttlGrantId: null,
      nonInheritableExcluded: true,
      proposedBy: null,
      confirmedBy: "actor",
      validFrom: 1_000,
      validUntil: 2_000,
      source: "intent:substitute",
      createdBy: "actor",
      createdAt: 1_000,
      updatedAt: 1_000,
      ...overrides,
    };
  }

  it("drops {non_inheritable:true} grants from the loaned subset", () => {
    const inheritable = parentGrant();
    const sensitive = parentGrant({
      id: "p0000000-0000-0000-0000-000000000002",
      constraint: { non_inheritable: true },
    });
    const eligible = eligibleForTier2(rule(), [inheritable, sensitive]);
    expect(eligible.map((g) => g.id)).toEqual([inheritable.id]);
  });
});
