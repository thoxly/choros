/**
 * T-0029 ADVERSARIAL PROPERTY TESTS — scoped-admin no-self-elevation (AC-4).
 *
 * Role: independent adversarial verification. Goal: find a self-elevation leak
 * in `validateAdminDelegation` along EITHER axis (resource-scope OR org-scope)
 * across node / tag / interval / set / org-subtree fuzz — if any exists.
 *
 * Design (mirrors grant-lattice.adversarial.test.ts):
 *   - NO Math.random. Seeded LCG (deterministic, reproducible).
 *   - The CORE INVARIANT: for a non-owner admin, validateAdminDelegation returns
 *     ok:true ⟺ the child is ⊑ the admin on BOTH axes (org ceiling AND the
 *     covering grant's resource scope). Any ok:true for a non-⊑ child is a LEAK.
 *   - leak counter must end at 0.
 */

import { describe, it, expect } from "vitest";
import {
  type ScopeElement,
  type AtomElement,
  type AncestryOracle,
  type Grant,
  type GrantScope,
  type Operation,
  type ResourceType,
  isNarrowerOrEqual,
} from "../core/grant-lattice.js";
import {
  validateAdminDelegation,
  type AdminContext,
  type DelegationTarget,
} from "../core/scoped-admin.js";

// ---------------------------------------------------------------------------
// Seeded LCG (Knuth constants) — no Math.random.
// ---------------------------------------------------------------------------
function makeLcg(seed: number) {
  const a = 1664525;
  const c = 1013904223;
  let s = seed >>> 0;
  return () => {
    s = (a * s + c) >>> 0;
    return s;
  };
}
function pick<T>(arr: T[], rng: () => number): T {
  return arr[rng() % arr.length]!;
}

// ---------------------------------------------------------------------------
// Org-hierarchy oracle: a 3-root forest (fin/cs/plat) with child positions,
// plus a disjoint other-tenant subtree. Mirrors the genesis seed shape.
// ---------------------------------------------------------------------------
const ORG_EDGES: Array<[string, string]> = [
  ["fin-pos", "fin"],
  ["cs-pos", "cs"],
  ["plat-pos", "plat"],
  ["other-pos", "other"],
];
function buildOracle(edges: Array<[string, string]>): AncestryOracle {
  const childToParents = new Map<string, Set<string>>();
  for (const [child, parent] of edges) {
    if (!childToParents.has(child)) childToParents.set(child, new Set());
    childToParents.get(child)!.add(parent);
  }
  function ancestors(id: string): Set<string> {
    const visited = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const p of childToParents.get(cur) ?? []) {
        if (!visited.has(p)) {
          visited.add(p);
          queue.push(p);
        }
      }
    }
    return visited;
  }
  return {
    isDescendantOrSelf(_h, d, anc) {
      if (d === anc) return true;
      return ancestors(d).has(anc);
    },
  };
}
const oracle = buildOracle(ORG_EDGES);

// ---------------------------------------------------------------------------
// Element constructors / pools (org nodes, tags, intervals, sets).
// ---------------------------------------------------------------------------
function orgNode(nodeId: string): ScopeElement {
  return { kind: "node", hierarchy: "org", nodeId, nodeLevel: "department" };
}
function tags(...t: string[]): ScopeElement {
  return { kind: "tags", tags: t };
}
function interval(lo: number, hi: number, axis = "amount"): ScopeElement {
  return { kind: "interval", axis, lo, hi };
}
function setOf(...members: AtomElement[]): ScopeElement {
  return { kind: "set", members };
}

const ORG_NODE_IDS = ["fin", "cs", "plat", "fin-pos", "cs-pos", "plat-pos", "other", "other-pos"];

const SCOPE_POOL: ScopeElement[] = [
  ...ORG_NODE_IDS.map(orgNode),
  tags("p"),
  tags("q"),
  tags("p", "q"),
  tags("p", "q", "r"),
  interval(0, 100),
  interval(10, 50),
  interval(20, 40),
  setOf(orgNode("fin") as AtomElement, orgNode("cs") as AtomElement),
  setOf(orgNode("fin") as AtomElement, orgNode("cs") as AtomElement, orgNode("plat") as AtomElement),
  setOf(orgNode("fin") as AtomElement, tags("p") as AtomElement),
];

const MGMT_KINDS: ResourceType[] = [
  "mgmt_object:role",
  "mgmt_object:agent",
  "mgmt_object:process",
  "mgmt_object:grant",
];
const OPS: Operation[] = ["create", "read", "update", "delete"];

function mgmtGrant(
  resourceType: ResourceType,
  operation: Operation,
  scope: GrantScope,
): Grant {
  return {
    tenantId: "t",
    id: "g",
    roleId: "r",
    resourceType,
    operation,
    scope,
    delegable: true,
    grantedBy: "seed",
    createdAt: 0,
  };
}

// ---------------------------------------------------------------------------
// CORE SECURITY INVARIANT: non-owner ok:true ⟺ ⊑ on BOTH axes.
// ---------------------------------------------------------------------------
describe("ADVERSARIAL: no self-elevation for a non-owner admin (both axes)", () => {
  it("FUZZ grant-target: ok:true ⟺ (targetOrg ⊑ ceiling) ∧ (childScope ⊑ adminGrantScope)", () => {
    const rng = makeLcg(0xA5A5_1029);
    let leakCount = 0;

    for (let i = 0; i < 4000; i++) {
      const adminGrantScope = pick(SCOPE_POOL, rng);
      const adminOrgScope = pick(SCOPE_POOL, rng);
      const childScope = pick(SCOPE_POOL, rng);
      const targetOrgScope = pick(SCOPE_POOL, rng);
      const kind = pick(MGMT_KINDS, rng);
      const op = pick(OPS, rng);

      const admin: AdminContext = {
        isGenesisOwner: false,
        adminGrants: [mgmtGrant(kind, op, adminGrantScope)],
        adminOrgScope,
      };
      const child = mgmtGrant(kind, op, childScope);
      const target: DelegationTarget = { kind: "grant", childGrant: child, targetOrgScope };

      const orgOk = isNarrowerOrEqual(targetOrgScope, adminOrgScope, oracle);
      const scopeOk = isNarrowerOrEqual(childScope, adminGrantScope, oracle);
      const shouldAccept = orgOk && scopeOk;

      const r = validateAdminDelegation(admin, target, oracle);

      if (r.ok && !shouldAccept) {
        leakCount++;
        throw new Error(
          `SELF-ELEVATION LEAK (grant): accepted a non-⊑ delegation!\n` +
            `  adminGrantScope=${JSON.stringify(adminGrantScope)} (childScope ⊑ = ${scopeOk})\n` +
            `  adminOrgScope=${JSON.stringify(adminOrgScope)} (targetOrg ⊑ = ${orgOk})\n` +
            `  childScope=${JSON.stringify(childScope)}\n  targetOrgScope=${JSON.stringify(targetOrgScope)}`,
        );
      }
      // Accept side: when both axes hold AND op/kind match (they do here), must accept.
      if (shouldAccept && !r.ok) {
        throw new Error(
          `FALSE REJECTION (grant): both axes ⊑ but rejected as ${JSON.stringify(r)}\n` +
            `  adminGrantScope=${JSON.stringify(adminGrantScope)}\n  childScope=${JSON.stringify(childScope)}\n` +
            `  adminOrgScope=${JSON.stringify(adminOrgScope)}\n  targetOrgScope=${JSON.stringify(targetOrgScope)}`,
        );
      }
    }
    expect(leakCount).toBe(0);
  });

  it("FUZZ assignment-target: ok:true ⟺ targetOrg ⊑ ceiling (org-axis is the whole check)", () => {
    const rng = makeLcg(0x7E57_BEEF);
    let leakCount = 0;

    for (let i = 0; i < 2000; i++) {
      const adminOrgScope = pick(SCOPE_POOL, rng);
      const targetOrgScope = pick(SCOPE_POOL, rng);
      // Admin holds at least one delegable mgmt grant (authority present).
      const admin: AdminContext = {
        isGenesisOwner: false,
        adminGrants: [mgmtGrant(pick(MGMT_KINDS, rng), pick(OPS, rng), pick(SCOPE_POOL, rng))],
        adminOrgScope,
      };
      const target: DelegationTarget = { kind: "assignment", targetOrgScope };

      const orgOk = isNarrowerOrEqual(targetOrgScope, adminOrgScope, oracle);
      const r = validateAdminDelegation(admin, target, oracle);

      if (r.ok && !orgOk) {
        leakCount++;
        throw new Error(
          `SELF-ELEVATION LEAK (assignment): accepted an org-widening assignment!\n` +
            `  adminOrgScope=${JSON.stringify(adminOrgScope)}\n  targetOrgScope=${JSON.stringify(targetOrgScope)}`,
        );
      }
      if (!r.ok && orgOk) {
        throw new Error(
          `FALSE REJECTION (assignment): targetOrg ⊑ ceiling but rejected as ${JSON.stringify(r)}`,
        );
      }
    }
    expect(leakCount).toBe(0);
  });

  it("FUZZ: a widening on EITHER axis is always rejected (one-axis-bad ⇒ reject)", () => {
    const rng = makeLcg(0xC0FF_EE42);
    for (let i = 0; i < 3000; i++) {
      // Force exactly one axis to widen, hold the other as a genuine subset.
      const tightOrg = orgNode("fin");
      const tightScope = orgNode("fin");
      const widenOrg = pick([orgNode("cs"), orgNode("plat"), orgNode("other")], rng);
      const widenScope = pick([orgNode("cs"), orgNode("plat"), setOf(orgNode("fin") as AtomElement, orgNode("cs") as AtomElement)], rng);
      const kind = pick(MGMT_KINDS, rng);
      const op = pick(OPS, rng);

      const widenWhich = rng() % 2; // 0 = widen org, 1 = widen grant scope

      const admin: AdminContext = {
        isGenesisOwner: false,
        adminGrants: [mgmtGrant(kind, op, tightScope)],
        adminOrgScope: tightOrg,
      };
      const childScope = widenWhich === 1 ? widenScope : tightScope;
      const targetOrgScope = widenWhich === 0 ? widenOrg : orgNode("fin-pos");
      // ensure the supposedly-tight side really is ⊑ (skip degenerate picks)
      const tightSideOk =
        widenWhich === 0
          ? isNarrowerOrEqual(childScope, tightScope, oracle)
          : isNarrowerOrEqual(targetOrgScope, tightOrg, oracle);
      if (!tightSideOk) continue;

      const child = mgmtGrant(kind, op, childScope);
      const target: DelegationTarget = { kind: "grant", childGrant: child, targetOrgScope };
      const r = validateAdminDelegation(admin, target, oracle);
      if (r.ok) {
        throw new Error(
          `SELF-ELEVATION LEAK: one-axis widening accepted!\n  widenWhich=${widenWhich}\n` +
            `  childScope=${JSON.stringify(childScope)}\n  targetOrgScope=${JSON.stringify(targetOrgScope)}`,
        );
      }
      expect(r.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Owner exemption is NOT a leak: owner accepts everything (it is the root).
// ---------------------------------------------------------------------------
describe("ADVERSARIAL: genesis owner exemption is intentional, not a leak", () => {
  it("owner (isGenesisOwner=true) accepts any target — owns the whole forest", () => {
    const owner: AdminContext = { isGenesisOwner: true, adminGrants: [], adminOrgScope: orgNode("fin") };
    for (const childScope of SCOPE_POOL) {
      for (const targetOrgScope of SCOPE_POOL) {
        const child = mgmtGrant("mgmt_object:role", "create", childScope);
        const target: DelegationTarget = { kind: "grant", childGrant: child, targetOrgScope };
        expect(validateAdminDelegation(owner, target, oracle)).toEqual({ ok: true });
      }
    }
  });
});
