/**
 * T-0029 · scoped-admin checker unit tests (AC-1/2/3/5/6/7/10/14).
 *
 * The admin-narrowing checker is a THIN composition over the T-0018 lattice.
 * These tests pin the two-axis decision order and the typed-rejection contract
 * (the adversarial no-self-elevation fuzz lives in scoped-admin.adversarial.test.ts).
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
} from "../core/grant-lattice.js";
import {
  MGMT_OBJECT_KINDS,
  isMgmtObjectKind,
  validateAdminDelegation,
  type AdminContext,
  type DelegationTarget,
} from "../core/scoped-admin.js";

// ---------------------------------------------------------------------------
// Org ancestry oracle — a 3-root forest mirroring the dev seed (fin/cs/plat),
// each with a child position node, plus a disjoint other-tenant subtree.
//
//   fin ── fin-pos
//   cs  ── cs-pos
//   plat ── plat-pos
//   other ── other-pos        (a different tenant's subtree — disjoint)
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
    isDescendantOrSelf(_h, descendantId, ancestorId) {
      if (descendantId === ancestorId) return true;
      return ancestors(descendantId).has(ancestorId);
    },
  };
}

const oracle = buildOracle(ORG_EDGES);

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------
function orgNode(nodeId: string, nodeLevel: "department" | "position" = "department"): ScopeElement {
  return { kind: "node", hierarchy: "org", nodeId, nodeLevel };
}

function orgSet(...nodeIds: string[]): ScopeElement {
  return {
    kind: "set",
    members: nodeIds.map((id) => orgNode(id) as AtomElement),
  };
}

/** The 3-root forest set used by the genesis seed. */
const FOREST = orgSet("fin", "cs", "plat");

function mgmtGrant(
  resourceType: ResourceType,
  operation: Operation,
  scope: GrantScope,
  opts?: { delegable?: boolean; resourceFacet?: unknown; constraint?: unknown; id?: string },
): Grant {
  return {
    tenantId: "a0000000-0000-0000-0000-000000000001",
    id: opts?.id ?? "g",
    roleId: "e0000000-0000-0000-0000-000000000001",
    resourceType,
    operation,
    scope,
    delegable: opts?.delegable ?? true,
    grantedBy: "seed",
    resourceFacet: opts?.resourceFacet,
    constraint: opts?.constraint,
    createdAt: 0,
  };
}

/** A delegated (non-owner) admin context covering mgmt_object:role create over `scope`. */
function delegatedAdmin(
  adminGrantScope: ScopeElement,
  adminOrgScope: ScopeElement,
  resourceType: ResourceType = "mgmt_object:role",
  operation: Operation = "create",
): AdminContext {
  return {
    isGenesisOwner: false,
    adminGrants: [mgmtGrant(resourceType, operation, adminGrantScope)],
    adminOrgScope,
  };
}

const OWNER: AdminContext = {
  isGenesisOwner: true,
  adminGrants: [], // owner needs no covering grant — un-parented root
  adminOrgScope: FOREST,
};

// ---------------------------------------------------------------------------
// AC-1 — MGMT_OBJECT_KINDS frozen + mgmt_object:* is a valid ResourceType
// ---------------------------------------------------------------------------
describe("AC-1 · mgmt_object:* first-class resource-type", () => {
  it("MGMT_OBJECT_KINDS is the day-1 set + T-0469 org-object kinds (additive)", () => {
    // T-0469 [auth] — the org-object kinds (department/position/employee) were
    // ADDED so org-structure authoring is delegable for role-constructor-admin.
    // The original four day-1 kinds stay first and unchanged (additive only).
    expect([...MGMT_OBJECT_KINDS]).toEqual([
      "mgmt_object:role",
      "mgmt_object:agent",
      "mgmt_object:process",
      "mgmt_object:grant",
      "mgmt_object:department",
      "mgmt_object:position",
      "mgmt_object:employee",
    ]);
  });

  it("each kind is structurally a valid Grant.resourceType (compile + runtime)", () => {
    for (const kind of MGMT_OBJECT_KINDS) {
      const g = mgmtGrant(kind, "create", orgNode("fin"));
      expect(g.resourceType).toBe(kind);
      expect(isMgmtObjectKind(kind)).toBe(true);
    }
    expect(isMgmtObjectKind("application")).toBe(false);
    expect(isMgmtObjectKind("mgmt_object:unknown")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-2 — accept a delegated grant whose scope ⊑ adminGrant.scope
// ---------------------------------------------------------------------------
describe("AC-2 · accepts a genuine subset delegation", () => {
  it("child grant within the admin's subtree (position ⊑ department) is accepted", () => {
    const admin = delegatedAdmin(orgNode("fin"), orgNode("fin"));
    const child = mgmtGrant("mgmt_object:role", "create", orgNode("fin-pos", "position"));
    const target: DelegationTarget = {
      kind: "grant",
      childGrant: child,
      targetOrgScope: orgNode("fin-pos", "position"),
    };
    expect(validateAdminDelegation(admin, target, oracle)).toEqual({ ok: true });
  });

  it("child grant equal to the admin's scope is accepted (⊑ is reflexive)", () => {
    const admin = delegatedAdmin(orgNode("fin"), orgNode("fin"));
    const child = mgmtGrant("mgmt_object:role", "create", orgNode("fin"));
    const target: DelegationTarget = {
      kind: "grant",
      childGrant: child,
      targetOrgScope: orgNode("fin"),
    };
    expect(validateAdminDelegation(admin, target, oracle)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// AC-3 — reject widening: distinct typed reason; never mutates
// ---------------------------------------------------------------------------
describe("AC-3 · rejects widening with a distinct typed reason (no mutation)", () => {
  it("child org-scope widening the admin's org_scope ⇒ org_scope_widens", () => {
    // admin bounded to fin; target lands in cs (sibling subtree, escapes ceiling).
    const admin = delegatedAdmin(FOREST, orgNode("fin"));
    const child = mgmtGrant("mgmt_object:role", "create", orgNode("cs"));
    const target: DelegationTarget = {
      kind: "grant",
      childGrant: child,
      targetOrgScope: orgNode("cs"),
    };
    const before = JSON.stringify({ admin, target });
    const r = validateAdminDelegation(admin, target, oracle);
    expect(r).toEqual({ ok: false, reason: "org_scope_widens" });
    // Purity: inputs untouched.
    expect(JSON.stringify({ admin, target })).toBe(before);
  });

  it("child grant-scope widening (ancestor of admin grant) within org ceiling ⇒ scope_widens", () => {
    // org ceiling = forest (so org-axis passes); admin grant scope = fin;
    // child grant scope = the whole forest (wider than fin) ⇒ resource-axis rejects.
    const admin = delegatedAdmin(orgNode("fin"), FOREST);
    const child = mgmtGrant("mgmt_object:role", "create", FOREST);
    const target: DelegationTarget = {
      kind: "grant",
      childGrant: child,
      targetOrgScope: orgNode("fin"), // targetOrgScope is within ceiling; the WIDEN is on the grant scope
    };
    expect(validateAdminDelegation(admin, target, oracle)).toEqual({
      ok: false,
      reason: "scope_widens",
    });
  });
});

// ---------------------------------------------------------------------------
// AC-5 — non-delegable / freeform parent; non-owner freeform mint rejected
// ---------------------------------------------------------------------------
describe("AC-5 · non-delegable / freeform rejections", () => {
  it("covering admin grant delegable=false ⇒ parent_non_delegable", () => {
    const admin: AdminContext = {
      isGenesisOwner: false,
      adminGrants: [mgmtGrant("mgmt_object:role", "create", orgNode("fin"), { delegable: false })],
      adminOrgScope: orgNode("fin"),
    };
    const child = mgmtGrant("mgmt_object:role", "create", orgNode("fin-pos", "position"));
    const target: DelegationTarget = {
      kind: "grant",
      childGrant: child,
      targetOrgScope: orgNode("fin-pos", "position"),
    };
    // org-axis passes (within fin); no DELEGABLE covering grant ⇒ no_admin_authority
    // (the covering filter requires delegable). This is the FR-2 corollary: a
    // non-delegable grant confers no delegation authority.
    expect(validateAdminDelegation(admin, target, oracle)).toEqual({
      ok: false,
      reason: "no_admin_authority",
    });
  });

  it("covering admin grant scope=freeform ⇒ free_form_non_delegable (via validateNarrowing)", () => {
    const freeform: GrantScope = { kind: "freeform", predicate: "status='active'" };
    const admin: AdminContext = {
      isGenesisOwner: false,
      adminGrants: [mgmtGrant("mgmt_object:role", "create", freeform)],
      adminOrgScope: orgNode("fin"),
    };
    const child = mgmtGrant("mgmt_object:role", "create", orgNode("fin"));
    const target: DelegationTarget = {
      kind: "grant",
      childGrant: child,
      targetOrgScope: orgNode("fin"),
    };
    expect(validateAdminDelegation(admin, target, oracle)).toEqual({
      ok: false,
      reason: "free_form_non_delegable",
    });
  });

  it("non-owner minting a freeform mgmt-grant ⇒ free_form_non_delegable", () => {
    const admin = delegatedAdmin(orgNode("fin"), orgNode("fin"));
    const child = mgmtGrant("mgmt_object:role", "create", {
      kind: "freeform",
      predicate: "x > 0",
    });
    const target: DelegationTarget = {
      kind: "grant",
      childGrant: child,
      targetOrgScope: orgNode("fin"),
    };
    expect(validateAdminDelegation(admin, target, oracle)).toEqual({
      ok: false,
      reason: "free_form_non_delegable",
    });
  });

  it("genesis owner MAY mint a freeform mgmt-grant (the only principal that can)", () => {
    const child = mgmtGrant("mgmt_object:role", "create", {
      kind: "freeform",
      predicate: "x > 0",
    });
    const target: DelegationTarget = {
      kind: "grant",
      childGrant: child,
      targetOrgScope: orgNode("fin"),
    };
    expect(validateAdminDelegation(OWNER, target, oracle)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// AC-6 — genesis owner is the un-parented root
// ---------------------------------------------------------------------------
describe("AC-6 · genesis owner = un-parented delegation root", () => {
  it("owner-minted grant is accepted WITHOUT a parent-subset check (no adminGrants)", () => {
    const child = mgmtGrant("mgmt_object:grant", "delete", orgNode("plat"));
    const target: DelegationTarget = {
      kind: "grant",
      childGrant: child,
      targetOrgScope: orgNode("plat"),
    };
    expect(validateAdminDelegation(OWNER, target, oracle)).toEqual({ ok: true });
  });

  it("owner is exempt from the org-axis gate (owns the whole forest)", () => {
    // A target outside any seeded subtree is still accepted for the owner.
    const child = mgmtGrant("mgmt_object:role", "create", orgNode("other"));
    const target: DelegationTarget = {
      kind: "grant",
      childGrant: child,
      targetOrgScope: orgNode("other"),
    };
    expect(validateAdminDelegation(OWNER, target, oracle)).toEqual({ ok: true });
  });

  it("isGenesisOwner=false with no covering admin grant ⇒ no_admin_authority", () => {
    const admin: AdminContext = {
      isGenesisOwner: false,
      adminGrants: [], // no covering grant
      adminOrgScope: FOREST,
    };
    const child = mgmtGrant("mgmt_object:role", "create", orgNode("fin"));
    const target: DelegationTarget = {
      kind: "grant",
      childGrant: child,
      targetOrgScope: orgNode("fin"),
    };
    expect(validateAdminDelegation(admin, target, oracle)).toEqual({
      ok: false,
      reason: "no_admin_authority",
    });
  });

  it("non-owner with a covering grant but wrong operation ⇒ no_admin_authority", () => {
    // admin holds mgmt_object:role READ; tries to delegate a CREATE.
    const admin = delegatedAdmin(FOREST, FOREST, "mgmt_object:role", "read");
    const child = mgmtGrant("mgmt_object:role", "create", orgNode("fin"));
    const target: DelegationTarget = {
      kind: "grant",
      childGrant: child,
      targetOrgScope: orgNode("fin"),
    };
    expect(validateAdminDelegation(admin, target, oracle)).toEqual({
      ok: false,
      reason: "no_admin_authority",
    });
  });
});

// ---------------------------------------------------------------------------
// AC-7 — delegated admin bounded to subtree (positive + negative)
// ---------------------------------------------------------------------------
describe("AC-7 · delegated admin bounded to assignment subtree", () => {
  // An "HR admin" assigned mgmt_object:role within the `fin` subtree.
  const hrAdmin = delegatedAdmin(orgNode("fin"), orgNode("fin"));

  it("accepts a role/grant whose org context is ⊑ S (within subtree)", () => {
    const child = mgmtGrant("mgmt_object:role", "create", orgNode("fin-pos", "position"));
    const target: DelegationTarget = {
      kind: "grant",
      childGrant: child,
      targetOrgScope: orgNode("fin-pos", "position"),
    };
    expect(validateAdminDelegation(hrAdmin, target, oracle)).toEqual({ ok: true });
  });

  it("rejects a role/grant whose org context escapes S ⇒ org_scope_widens", () => {
    const child = mgmtGrant("mgmt_object:role", "create", orgNode("cs"));
    const target: DelegationTarget = {
      kind: "grant",
      childGrant: child,
      targetOrgScope: orgNode("cs"),
    };
    expect(validateAdminDelegation(hrAdmin, target, oracle)).toEqual({
      ok: false,
      reason: "org_scope_widens",
    });
  });

  it("assignment target within subtree accepted; escaping subtree ⇒ org_scope_widens", () => {
    const within: DelegationTarget = {
      kind: "assignment",
      targetOrgScope: orgNode("fin-pos", "position"),
    };
    expect(validateAdminDelegation(hrAdmin, within, oracle)).toEqual({ ok: true });

    const escaping: DelegationTarget = {
      kind: "assignment",
      targetOrgScope: orgNode("plat"),
    };
    expect(validateAdminDelegation(hrAdmin, escaping, oracle)).toEqual({
      ok: false,
      reason: "org_scope_widens",
    });
  });

  it("cross-tenant target subtree (disjoint org) ⇒ org_scope_widens", () => {
    const child = mgmtGrant("mgmt_object:role", "create", orgNode("other"));
    const target: DelegationTarget = {
      kind: "grant",
      childGrant: child,
      targetOrgScope: orgNode("other"),
    };
    expect(validateAdminDelegation(hrAdmin, target, oracle)).toEqual({
      ok: false,
      reason: "org_scope_widens",
    });
  });
});

// ---------------------------------------------------------------------------
// AC-14 — removing the role removes the capability (empty adminGrants ⇒ reject)
// ---------------------------------------------------------------------------
describe("AC-14 · revoking the assignment removes the capability at the authority layer", () => {
  it("a subject with no confirmed in-window mgmt-grant fails EVERY grant delegation", () => {
    // Simulate a revoked/out-of-window assignment: the resolver yields zero
    // mgmt_object:* grants, so adminGrants is empty and the principal is not owner.
    const revoked: AdminContext = {
      isGenesisOwner: false,
      adminGrants: [],
      adminOrgScope: FOREST, // ceiling present, but no covering grant
    };
    for (const kind of MGMT_OBJECT_KINDS) {
      const child = mgmtGrant(kind, "create", orgNode("fin"));
      const target: DelegationTarget = {
        kind: "grant",
        childGrant: child,
        targetOrgScope: orgNode("fin"),
      };
      expect(validateAdminDelegation(revoked, target, oracle)).toEqual({
        ok: false,
        reason: "no_admin_authority",
      });
    }
  });

  it("a revoked subject also fails assignment delegations (no delegable authority)", () => {
    const revoked: AdminContext = {
      isGenesisOwner: false,
      adminGrants: [],
      adminOrgScope: FOREST,
    };
    const target: DelegationTarget = {
      kind: "assignment",
      targetOrgScope: orgNode("fin-pos", "position"),
    };
    expect(validateAdminDelegation(revoked, target, oracle)).toEqual({
      ok: false,
      reason: "no_admin_authority",
    });
  });
});

// ---------------------------------------------------------------------------
// T-0469 [auth] — owner-role assignment is OWNER-ONLY (escalation carve-out).
//
// The SECURITY review proved: a role-constructor-admin holds delegable
// `mgmt_object:*` grants, which satisfy the kind:"assignment" authority check
// (any delegable mgmt grant + org reach). Without the carve-out, that admin
// could mint a tenant-owner role_assignment → self-promote → delete the owner.
// The carve-out makes assigning the owner role (assignsOwnerRole=true) require
// isGenesisOwner; normal in-scope role assignment (flag absent/false) is intact.
// ---------------------------------------------------------------------------
describe("T-0469 · owner-role assignment is OWNER-ONLY", () => {
  // A constructor-admin-like context: NOT owner, but holds a covering delegable
  // mgmt_object grant + org reach over the whole forest — exactly what makes the
  // kind:"assignment" authority check pass (the proven escalation precondition).
  const constructorAdmin: AdminContext = {
    isGenesisOwner: false,
    adminGrants: [
      mgmtGrant("mgmt_object:role", "create", FOREST, { delegable: true }),
      mgmtGrant("mgmt_object:employee", "create", FOREST, { delegable: true, id: "g2" }),
    ],
    adminOrgScope: FOREST,
  };

  it("non-owner (constructor-admin) assigning the OWNER role ⇒ owner_assignment_owner_only", () => {
    const target: DelegationTarget = {
      kind: "assignment",
      targetOrgScope: orgNode("fin"), // within reach — org-axis would otherwise pass
      assignsOwnerRole: true,
    };
    expect(validateAdminDelegation(constructorAdmin, target, oracle)).toEqual({
      ok: false,
      reason: "owner_assignment_owner_only",
    });
  });

  it("owner-role carve-out is checked FIRST — even with full org reach the non-owner is rejected", () => {
    // Whole-forest reach + covering delegable grant: every other gate passes.
    // Only the owner carve-out fires, proving it is not bypassable via authority.
    const target: DelegationTarget = {
      kind: "assignment",
      targetOrgScope: FOREST,
      assignsOwnerRole: true,
    };
    const r = validateAdminDelegation(constructorAdmin, target, oracle);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("owner_assignment_owner_only");
  });

  it("the genesis OWNER CAN assign the owner role ⇒ ok", () => {
    const target: DelegationTarget = {
      kind: "assignment",
      targetOrgScope: FOREST,
      assignsOwnerRole: true,
    };
    expect(validateAdminDelegation(OWNER, target, oracle)).toEqual({ ok: true });
  });

  it("non-owner assigning a NORMAL in-scope role (flag false) stays green — no over-restriction", () => {
    const target: DelegationTarget = {
      kind: "assignment",
      targetOrgScope: orgNode("fin"),
      assignsOwnerRole: false,
    };
    expect(validateAdminDelegation(constructorAdmin, target, oracle)).toEqual({ ok: true });
  });

  it("non-owner assigning a normal role (flag OMITTED, legacy callers) stays green", () => {
    const target: DelegationTarget = {
      kind: "assignment",
      targetOrgScope: orgNode("fin"),
    };
    expect(validateAdminDelegation(constructorAdmin, target, oracle)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// AC-10 — checker is pure: equal inputs ⇒ equal output (determinism property)
// ---------------------------------------------------------------------------
describe("AC-10 · checker is pure (deterministic)", () => {
  it("equal inputs yield deeply-equal output across repeated calls", () => {
    const admin = delegatedAdmin(orgNode("fin"), orgNode("fin"));
    const child = mgmtGrant("mgmt_object:role", "create", orgNode("fin-pos", "position"));
    const target: DelegationTarget = {
      kind: "grant",
      childGrant: child,
      targetOrgScope: orgNode("fin-pos", "position"),
    };
    const r1 = validateAdminDelegation(admin, target, oracle);
    const r2 = validateAdminDelegation(admin, target, oracle);
    const r3 = validateAdminDelegation(admin, target, oracle);
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });
});
