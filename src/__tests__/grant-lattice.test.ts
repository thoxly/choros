/**
 * Fitness tests for the T-0018 grant scope-lattice algebra.
 * Each describe block maps to a fitness function (FF-1..FF-9) and its AC ids.
 *
 * FF-1  → AC-3  : ⊑ total & decidable
 * FF-2  → AC-4  : hierarchy-node subset
 * FF-3  → AC-5  : tag-set & interval subset
 * FF-4  → AC-6  : scope-set subset
 * FF-5  → AC-7  : meet (⊓) closure
 * FF-6  → AC-8  : canonical form idempotence + order-independence
 * FF-7  → AC-9, NF-3 : monotonic narrowing / no self-elevation
 * FF-8  → AC-10 : free-form owner-only / non-delegable
 * FF-9  → AC-13 : validity window = capability
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
  BOTTOM,
  isBottom,
  normalize,
  isNarrowerOrEqual,
  meet,
  validateNarrowing,
  isEffective,
} from "../core/grant-lattice.js";

// ---------------------------------------------------------------------------
// Shared test fixtures & helpers
// ---------------------------------------------------------------------------

/** A simple in-memory ancestry oracle for tests. */
function makeOracle(edges: Array<[string, string]>): AncestryOracle {
  // edges: [child, parent]
  const map = new Map<string, Set<string>>();
  const addEdge = (child: string, parent: string): void => {
    if (!map.has(child)) map.set(child, new Set());
    map.get(child)!.add(parent);
  };
  for (const [child, parent] of edges) {
    addEdge(child, parent);
  }
  // transitive closure via BFS
  const ancestors = (id: string): Set<string> => {
    const visited = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const p of (map.get(cur) ?? [])) {
        if (!visited.has(p)) {
          visited.add(p);
          queue.push(p);
        }
      }
    }
    return visited;
  };
  return {
    isDescendantOrSelf(hierarchy, descendantId, ancestorId) {
      void hierarchy;
      if (descendantId === ancestorId) return true;
      return ancestors(descendantId).has(ancestorId);
    },
  };
}

/**
 * Oracle for a three-level hierarchy:
 *   app-1
 *     └─ reg-1
 *          └─ rec-1
 *     └─ reg-2
 *          └─ rec-2
 *   app-2
 *     └─ reg-3
 */
const treeOracle = makeOracle([
  ["reg-1", "app-1"],
  ["rec-1", "reg-1"],
  ["reg-2", "app-1"],
  ["rec-2", "reg-2"],
  ["reg-3", "app-2"],
]);

const noOpOracle: AncestryOracle = {
  isDescendantOrSelf: (_h, a, b) => a === b,
};

// Scope-element constructors for readability
function node(nodeId: string, hierarchy: "resource" | "org" = "resource"): ScopeElement {
  return { kind: "node", hierarchy, nodeId, nodeLevel: "application" };
}
function tags(...t: string[]): ScopeElement {
  return { kind: "tags", tags: t };
}
function interval(axis: string, lo: number, hi: number): ScopeElement {
  return { kind: "interval", axis, lo, hi };
}
function setOf(...members: AtomElement[]): ScopeElement {
  return { kind: "set", members };
}

/** Build a minimal valid Grant for use in validateNarrowing tests. */
function makeGrant(
  scope: GrantScope,
  opts?: {
    delegable?: boolean;
    resourceFacet?: unknown;
    constraint?: unknown;
    validFrom?: number;
    validUntil?: number;
  },
): Grant {
  return {
    tenantId: "tenant-a",
    id: "grant-id",
    roleId: "role-id",
    resourceType: "application" as ResourceType,
    operation: "read" as Operation,
    scope,
    delegable: opts?.delegable ?? true,
    grantedBy: "actor",
    resourceFacet: opts?.resourceFacet,
    constraint: opts?.constraint,
    validFrom: opts?.validFrom,
    validUntil: opts?.validUntil,
    createdAt: 1000,
  };
}

// ---------------------------------------------------------------------------
// FF-1 / AC-3 — ⊑ is total & decidable over the fixture matrix
// ---------------------------------------------------------------------------

describe("FF-1 / AC-3: ⊑ total & decidable", () => {
  /**
   * Matrix of all pairs from the following elements. isNarrowerOrEqual must:
   *  - return a boolean (never throw, never undefined)
   *  - satisfy the FR-3 truth table
   */
  const elements: ScopeElement[] = [
    BOTTOM,
    node("app-1"),
    node("reg-1"),
    node("rec-1"),
    node("app-2"),
    node("reg-3"),
    tags("a", "b"),
    tags("a", "b", "c"),
    tags("x"),
    interval("amount", 0, 100),
    interval("amount", 10, 50),
    interval("price", 0, 100),
    setOf(node("reg-1") as AtomElement, tags("a") as AtomElement),
    setOf(node("app-1") as AtomElement),
  ];

  it("returns a boolean for every pair — never throws, never unknown", () => {
    for (const a of elements) {
      for (const b of elements) {
        const result = isNarrowerOrEqual(a, b, treeOracle);
        expect(typeof result).toBe("boolean");
      }
    }
  });

  it("⊥ ⊑ every element (vacuously)", () => {
    for (const b of elements) {
      expect(isNarrowerOrEqual(BOTTOM, b, treeOracle)).toBe(true);
    }
  });

  it("no non-empty element ⊑ ⊥", () => {
    for (const a of elements) {
      if (isBottom(a)) continue;
      expect(isNarrowerOrEqual(a, BOTTOM, treeOracle)).toBe(false);
    }
  });

  it("every element ⊑ itself (reflexivity for non-set elements)", () => {
    for (const a of elements) {
      // ⊥ ⊑ ⊥ is true (special case handled)
      expect(isNarrowerOrEqual(a, a, treeOracle)).toBe(true);
    }
  });

  it("cross-kind non-set comparisons are false", () => {
    expect(isNarrowerOrEqual(node("app-1"), tags("a"), treeOracle)).toBe(false);
    expect(isNarrowerOrEqual(node("app-1"), interval("amount", 0, 100), treeOracle)).toBe(false);
    expect(isNarrowerOrEqual(tags("a"), interval("amount", 0, 100), treeOracle)).toBe(false);
    expect(isNarrowerOrEqual(interval("amount", 0, 100), node("app-1"), treeOracle)).toBe(false);
    expect(isNarrowerOrEqual(tags("a"), node("app-1"), treeOracle)).toBe(false);
    expect(isNarrowerOrEqual(interval("amount", 0, 100), tags("a"), treeOracle)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FF-2 / AC-4 — hierarchy-node subset (subtree containment)
// ---------------------------------------------------------------------------

describe("FF-2 / AC-4: hierarchy-node subset", () => {
  it("descendant ⊑ ancestor = true", () => {
    expect(isNarrowerOrEqual(node("reg-1"), node("app-1"), treeOracle)).toBe(true);
    expect(isNarrowerOrEqual(node("rec-1"), node("app-1"), treeOracle)).toBe(true);
    expect(isNarrowerOrEqual(node("rec-1"), node("reg-1"), treeOracle)).toBe(true);
  });

  it("same node ⊑ itself = true (reflexive)", () => {
    expect(isNarrowerOrEqual(node("app-1"), node("app-1"), treeOracle)).toBe(true);
    expect(isNarrowerOrEqual(node("rec-1"), node("rec-1"), treeOracle)).toBe(true);
  });

  it("ancestor ⊑ descendant = false (wider)", () => {
    expect(isNarrowerOrEqual(node("app-1"), node("reg-1"), treeOracle)).toBe(false);
    expect(isNarrowerOrEqual(node("app-1"), node("rec-1"), treeOracle)).toBe(false);
    expect(isNarrowerOrEqual(node("reg-1"), node("rec-1"), treeOracle)).toBe(false);
  });

  it("disjoint subtree ⊑ subtree = false", () => {
    expect(isNarrowerOrEqual(node("reg-2"), node("reg-1"), treeOracle)).toBe(false);
    expect(isNarrowerOrEqual(node("app-2"), node("app-1"), treeOracle)).toBe(false);
    expect(isNarrowerOrEqual(node("reg-3"), node("reg-1"), treeOracle)).toBe(false);
  });

  it("different hierarchies are incomparable (false)", () => {
    const orgNode = node("app-1", "org");
    const resourceNode = node("app-1", "resource");
    expect(isNarrowerOrEqual(orgNode, resourceNode, treeOracle)).toBe(false);
    expect(isNarrowerOrEqual(resourceNode, orgNode, treeOracle)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FF-3 / AC-5 — tag-set & interval subset
// ---------------------------------------------------------------------------

describe("FF-3 / AC-5: tag-set and interval subset", () => {
  it("{a,b} ⊑ {a,b,c} = true", () => {
    expect(isNarrowerOrEqual(tags("a", "b"), tags("a", "b", "c"), noOpOracle)).toBe(true);
  });

  it("{a,d} ⊑ {a,b,c} = false (d not in parent)", () => {
    expect(isNarrowerOrEqual(tags("a", "d"), tags("a", "b", "c"), noOpOracle)).toBe(false);
  });

  it("{a,b,c} ⊑ {a,b} = false (child is wider)", () => {
    expect(isNarrowerOrEqual(tags("a", "b", "c"), tags("a", "b"), noOpOracle)).toBe(false);
  });

  it("identical tag sets: ⊑ is reflexive", () => {
    expect(isNarrowerOrEqual(tags("x", "y"), tags("x", "y"), noOpOracle)).toBe(true);
  });

  it("[10,40] ⊑ [0,50] = true", () => {
    expect(isNarrowerOrEqual(interval("amount", 10, 40), interval("amount", 0, 50), noOpOracle)).toBe(true);
  });

  it("[10,60] ⊑ [0,50] = false (hi widens)", () => {
    expect(isNarrowerOrEqual(interval("amount", 10, 60), interval("amount", 0, 50), noOpOracle)).toBe(false);
  });

  it("[0,50] ⊑ [10,40] = false (lo widens)", () => {
    expect(isNarrowerOrEqual(interval("amount", 0, 50), interval("amount", 10, 40), noOpOracle)).toBe(false);
  });

  it("mismatched axis ⇒ incomparable (false)", () => {
    expect(isNarrowerOrEqual(interval("amount", 0, 100), interval("price", 0, 100), noOpOracle)).toBe(false);
  });

  it("same interval ⊑ itself = true", () => {
    expect(isNarrowerOrEqual(interval("amount", 5, 15), interval("amount", 5, 15), noOpOracle)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FF-4 / AC-6 — scope-set subset
// ---------------------------------------------------------------------------

describe("FF-4 / AC-6: scope-set subset", () => {
  const parentSet = setOf(
    node("app-1") as AtomElement,
    tags("a", "b", "c") as AtomElement,
  );

  it("an element ⊑ a set iff it fits inside one member", () => {
    // node("reg-1") ⊑ node("app-1") → node("reg-1") ⊑ parentSet
    expect(isNarrowerOrEqual(node("reg-1"), parentSet, treeOracle)).toBe(true);
    // tags("a") ⊑ tags("a","b","c") → tags("a") ⊑ parentSet
    expect(isNarrowerOrEqual(tags("a"), parentSet, treeOracle)).toBe(true);
    // tags("x") not in any member
    expect(isNarrowerOrEqual(tags("x"), parentSet, treeOracle)).toBe(false);
    // interval escapes both members
    expect(isNarrowerOrEqual(interval("amount", 0, 100), parentSet, treeOracle)).toBe(false);
  });

  it("A ⊑ B iff every member of A is ⊑ B", () => {
    const childSet = setOf(
      node("reg-1") as AtomElement,
      tags("a") as AtomElement,
    );
    expect(isNarrowerOrEqual(childSet, parentSet, treeOracle)).toBe(true);
  });

  it("a member escaping any parent member → false", () => {
    const escapingChild = setOf(
      node("reg-1") as AtomElement,
      interval("amount", 0, 100) as AtomElement, // escapes parentSet
    );
    expect(isNarrowerOrEqual(escapingChild, parentSet, treeOracle)).toBe(false);
  });

  it("A ⊑ A (set reflexivity)", () => {
    const s = setOf(node("app-1") as AtomElement, tags("a") as AtomElement);
    expect(isNarrowerOrEqual(s, s, treeOracle)).toBe(true);
  });

  it("⊥ ⊑ any set", () => {
    expect(isNarrowerOrEqual(BOTTOM, parentSet, treeOracle)).toBe(true);
  });

  it("non-empty set ⋢ ⊥", () => {
    expect(isNarrowerOrEqual(parentSet, BOTTOM, treeOracle)).toBe(false);
  });

  it("element ⊑ single-member set iff element ⊑ the member", () => {
    const s = setOf(node("app-1") as AtomElement);
    expect(isNarrowerOrEqual(node("reg-1"), s, treeOracle)).toBe(true);
    expect(isNarrowerOrEqual(node("app-2"), s, treeOracle)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FF-5 / AC-7 — meet (⊓) closure
// ---------------------------------------------------------------------------

describe("FF-5 / AC-7: meet closure", () => {
  const admissibleKinds = new Set(["node", "tags", "interval", "set"]);

  function isAdmissible(s: ScopeElement): boolean {
    return admissibleKinds.has(s.kind);
  }

  it("meet always returns an admissible element — never throws", () => {
    const elements: ScopeElement[] = [
      BOTTOM,
      node("app-1"),
      node("reg-1"),
      node("app-2"),
      tags("a", "b"),
      tags("b", "c"),
      interval("amount", 0, 100),
      interval("amount", 50, 200),
      setOf(node("app-1") as AtomElement, tags("a") as AtomElement),
    ];
    for (const x of elements) {
      for (const y of elements) {
        const r = meet(x, y, treeOracle);
        expect(isAdmissible(r)).toBe(true);
      }
    }
  });

  it("disjoint node ⊓ node = ⊥", () => {
    expect(isBottom(meet(node("app-1"), node("app-2"), treeOracle))).toBe(true);
    expect(isBottom(meet(node("reg-1"), node("reg-2"), treeOracle))).toBe(true);
  });

  it("ancestor ⊓ descendant = descendant", () => {
    const r = meet(node("app-1"), node("reg-1"), treeOracle);
    expect(r.kind).toBe("node");
    expect((r as { nodeId: string }).nodeId).toBe("reg-1");
  });

  it("descendant ⊓ ancestor = descendant", () => {
    const r = meet(node("reg-1"), node("app-1"), treeOracle);
    expect(r.kind).toBe("node");
    expect((r as { nodeId: string }).nodeId).toBe("reg-1");
  });

  it("same node ⊓ same node = that node", () => {
    const r = meet(node("app-1"), node("app-1"), treeOracle);
    expect(r.kind).toBe("node");
    expect((r as { nodeId: string }).nodeId).toBe("app-1");
  });

  it("interval ⊓ interval = overlap", () => {
    const r = meet(interval("amount", 0, 100), interval("amount", 50, 200), noOpOracle);
    expect(r.kind).toBe("interval");
    expect((r as { lo: number }).lo).toBe(50);
    expect((r as { hi: number }).hi).toBe(100);
  });

  it("interval ⊓ interval with no overlap = ⊥", () => {
    expect(isBottom(meet(interval("amount", 0, 10), interval("amount", 20, 30), noOpOracle))).toBe(true);
  });

  it("tags ⊓ tags = intersection", () => {
    const r = meet(tags("a", "b", "c"), tags("b", "c", "d"), noOpOracle);
    expect(r.kind).toBe("tags");
    expect((r as { tags: string[] }).tags.sort()).toEqual(["b", "c"]);
  });

  it("tags ⊓ tags with empty intersection = ⊥", () => {
    expect(isBottom(meet(tags("a", "b"), tags("c", "d"), noOpOracle))).toBe(true);
  });

  it("distinct non-set kinds ⊓ = ⊥", () => {
    expect(isBottom(meet(node("app-1"), tags("a"), treeOracle))).toBe(true);
    expect(isBottom(meet(node("app-1"), interval("amount", 0, 100), treeOracle))).toBe(true);
    expect(isBottom(meet(tags("a"), interval("amount", 0, 100), treeOracle))).toBe(true);
  });

  it("⊥ ⊓ anything = ⊥", () => {
    expect(isBottom(meet(BOTTOM, node("app-1"), treeOracle))).toBe(true);
    expect(isBottom(meet(node("app-1"), BOTTOM, treeOracle))).toBe(true);
    expect(isBottom(meet(BOTTOM, BOTTOM, treeOracle))).toBe(true);
  });

  it("set ⊓ element = pairwise meets, ⊥ members dropped", () => {
    const s = setOf(node("app-1") as AtomElement, tags("a", "b") as AtomElement);
    // meet(s, tags("a")) = tags intersection from the tags member
    const r = meet(s, tags("a"), noOpOracle);
    expect(r.kind).toBe("tags");
    expect((r as { tags: string[] }).tags).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// FF-6 / AC-8 — canonical form: idempotence + order-independence
// ---------------------------------------------------------------------------

describe("FF-6 / AC-8: canonical form idempotence and order-independence", () => {
  it("normalize(normalize(s)) deep-equals normalize(s) — idempotent", () => {
    const cases: ScopeElement[] = [
      node("app-1"),
      tags("c", "a", "b", "a"), // duplicates, unsorted
      interval("amount", 100, 0), // reversed
      setOf(
        tags("b", "a") as AtomElement,
        node("reg-1") as AtomElement,
      ),
      BOTTOM,
    ];
    for (const s of cases) {
      const once = normalize(s);
      const twice = normalize(once);
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    }
  });

  it("tags are sorted and de-duplicated after normalize", () => {
    const n = normalize(tags("c", "a", "b", "a"));
    expect(n.kind).toBe("tags");
    expect((n as { tags: string[] }).tags).toEqual(["a", "b", "c"]);
  });

  it("interval with reversed lo/hi is normalized to lo ≤ hi", () => {
    const n = normalize(interval("amount", 100, 0));
    expect(n.kind).toBe("interval");
    expect((n as { lo: number }).lo).toBe(0);
    expect((n as { hi: number }).hi).toBe(100);
  });

  it("isNarrowerOrEqual is order-independent: permuted set members give the same result", () => {
    const s1 = setOf(node("reg-1") as AtomElement, tags("a") as AtomElement);
    const s2 = setOf(tags("a") as AtomElement, node("reg-1") as AtomElement);
    const parent = setOf(node("app-1") as AtomElement, tags("a", "b") as AtomElement);
    expect(isNarrowerOrEqual(s1, parent, treeOracle)).toBe(
      isNarrowerOrEqual(s2, parent, treeOracle),
    );
  });

  it("meet gives identical results regardless of input member order", () => {
    const s1 = setOf(tags("a", "b") as AtomElement, tags("c", "d") as AtomElement);
    const s2 = setOf(tags("c", "d") as AtomElement, tags("a", "b") as AtomElement);
    const other = tags("b", "c");
    const r1 = normalize(meet(s1, other, noOpOracle));
    const r2 = normalize(meet(s2, other, noOpOracle));
    // Both should yield the same union of intersections (same members, possibly different order)
    // Compare by sorting the members canonically
    const sortedMembers = (s: ScopeElement): string => {
      if (s.kind !== "set") return JSON.stringify(s);
      return JSON.stringify({
        kind: "set",
        members: [...s.members].map((m) => JSON.stringify(m)).sort(),
      });
    };
    expect(sortedMembers(r1)).toBe(sortedMembers(r2));
  });

  it("non-canonical interval input is normalized", () => {
    // [50, 10] should become [10, 50]
    const n = normalize(interval("x", 50, 10));
    expect((n as { lo: number }).lo).toBe(10);
    expect((n as { hi: number }).hi).toBe(50);
  });

  it("set with redundant members has redundant ones dropped", () => {
    // tags("a") ⊑ tags("a","b") — with the no-op oracle, tags subsets are checked structurally
    const withRedundant = { kind: "set" as const, members: [
      tags("a") as AtomElement,      // narrower than the next
      tags("a", "b") as AtomElement, // wider — tags("a") is redundant
    ]};
    const n = normalize(withRedundant as ScopeElement);
    // After normalization, only the wider member should remain
    if (n.kind === "set") {
      // tags("a") ⊑ tags("a","b") is true → tags("a") is dropped
      const tagMembers = n.members.filter((m) => m.kind === "tags");
      expect(tagMembers.length).toBe(1);
      const remaining = tagMembers[0] as { tags: string[] };
      expect(remaining.tags).toEqual(["a", "b"]);
    } else {
      // If normalized to a single element (non-set), that element should be the wider one
      expect((n as { tags: string[] }).tags).toEqual(["a", "b"]);
    }
  });
});

// ---------------------------------------------------------------------------
// FF-7 / AC-9, NF-3 — monotonic narrowing / no self-elevation
// ---------------------------------------------------------------------------

describe("FF-7 / AC-9 / NF-3: monotonic narrowing and no self-elevation", () => {
  const parentGrant = makeGrant(node("app-1"), { delegable: true });

  it("child ⊑ parent (non-widening scope) → ok:true", () => {
    const child = makeGrant(node("reg-1"), { delegable: true });
    expect(validateNarrowing(parentGrant, child, treeOracle)).toEqual({ ok: true });
  });

  it("same node ⊑ parent → ok:true (equal is acceptable)", () => {
    const child = makeGrant(node("app-1"), { delegable: true });
    expect(validateNarrowing(parentGrant, child, treeOracle)).toEqual({ ok: true });
  });

  it("⊥ ⊑ parent → ok:true (empty child is always valid)", () => {
    const child = makeGrant(BOTTOM, { delegable: true });
    expect(validateNarrowing(parentGrant, child, treeOracle)).toEqual({ ok: true });
  });

  it("node widening (child is ancestor) → ok:false, reason:'scope_widens'", () => {
    const wideParent = makeGrant(node("reg-1"), { delegable: true });
    const child = makeGrant(node("app-1"), { delegable: true }); // ancestor = wider
    const result = validateNarrowing(wideParent, child, treeOracle);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("scope_widens");
  });

  it("disjoint-subtree child → ok:false, reason:'scope_widens'", () => {
    const child = makeGrant(node("app-2"), { delegable: true }); // disjoint
    const result = validateNarrowing(parentGrant, child, treeOracle);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("scope_widens");
  });

  it("tag superset child → ok:false, reason:'scope_widens'", () => {
    const parentTags = makeGrant(tags("a", "b"), { delegable: true });
    const childWider = makeGrant(tags("a", "b", "c"), { delegable: true }); // c is extra
    const result = validateNarrowing(parentTags, childWider, noOpOracle);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("scope_widens");
  });

  it("interval widening → ok:false, reason:'scope_widens'", () => {
    const parentInterval = makeGrant(interval("amount", 10, 50), { delegable: true });
    const childWider = makeGrant(interval("amount", 0, 50), { delegable: true }); // lo widens
    const result = validateNarrowing(parentInterval, childWider, noOpOracle);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("scope_widens");
  });

  it("escaping scope-set member → ok:false, reason:'scope_widens'", () => {
    const parentSet = makeGrant(
      setOf(node("app-1") as AtomElement),
      { delegable: true },
    );
    // child has app-2 which is outside parent's reach
    const childEscaping = makeGrant(
      setOf(node("reg-1") as AtomElement, node("app-2") as AtomElement),
      { delegable: true },
    );
    const result = validateNarrowing(parentSet, childEscaping, treeOracle);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("scope_widens");
  });

  it("parent non-delegable → ok:false, reason:'parent_non_delegable'", () => {
    const nonDelegable = makeGrant(node("app-1"), { delegable: false });
    const child = makeGrant(node("reg-1"), { delegable: true });
    const result = validateNarrowing(nonDelegable, child, treeOracle);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("parent_non_delegable");
  });

  it("facet widens (child absent, parent present) → ok:false, reason:'facet_widens'", () => {
    const parentWithFacet = makeGrant(node("app-1"), {
      delegable: true,
      resourceFacet: { fields: ["name"] },
    });
    const childNoFacet = makeGrant(node("reg-1"), { delegable: true }); // no facet = wider
    const result = validateNarrowing(parentWithFacet, childNoFacet, treeOracle);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("facet_widens");
  });

  it("facet narrows (child present, parent absent) → ok:true", () => {
    const parentNoFacet = makeGrant(node("app-1"), { delegable: true });
    const childWithFacet = makeGrant(node("reg-1"), {
      delegable: true,
      resourceFacet: { fields: ["name"] },
    });
    expect(validateNarrowing(parentNoFacet, childWithFacet, treeOracle)).toEqual({ ok: true });
  });

  it("constraint widens (child absent, parent present) → ok:false, reason:'constraint_widens'", () => {
    const parentWithConstraint = makeGrant(node("app-1"), {
      delegable: true,
      constraint: { status: "active" },
    });
    const childNoConstraint = makeGrant(node("reg-1"), { delegable: true });
    const result = validateNarrowing(parentWithConstraint, childNoConstraint, treeOracle);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("constraint_widens");
  });

  it("constraint equal → ok:true", () => {
    const c = { status: "active" };
    const parentWithConstraint = makeGrant(node("app-1"), {
      delegable: true,
      constraint: c,
    });
    const childSameConstraint = makeGrant(node("reg-1"), {
      delegable: true,
      constraint: { status: "active" },
    });
    expect(validateNarrowing(parentWithConstraint, childSameConstraint, treeOracle)).toEqual({ ok: true });
  });

  it("structural impossibility: no non-⊑ child returns ok:true", () => {
    // Exhaustive check over disjoint and ancestor cases
    const wideners: ScopeElement[] = [
      node("app-2"),              // disjoint
      tags("a", "b", "extra"),    // superset
      interval("amount", 0, 200), // wider interval
    ];
    const parents: Grant[] = [
      makeGrant(node("reg-1"), { delegable: true }),
      makeGrant(tags("a", "b"), { delegable: true }),
      makeGrant(interval("amount", 10, 100), { delegable: true }),
    ];

    for (const p of parents) {
      for (const wScope of wideners) {
        const childGrant = makeGrant(wScope, { delegable: true });
        const result = validateNarrowing(p, childGrant, treeOracle);
        // If child is NOT ⊑ parent, result must be ok:false
        const pScope = p.scope as ScopeElement;
        const isNarrowing = isNarrowerOrEqual(wScope, pScope, treeOracle);
        if (!isNarrowing) {
          expect(result.ok).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// FF-8 / AC-10 — free-form owner-only / non-delegable
// ---------------------------------------------------------------------------

describe("FF-8 / AC-10: free-form owner-only and non-delegable", () => {
  const freeformScope: GrantScope = { kind: "freeform", predicate: "status = 'active'" };

  it("validateNarrowing with a freeform parent → free_form_non_delegable", () => {
    const freeformParent = makeGrant(freeformScope, { delegable: true });
    const child = makeGrant(node("reg-1"), { delegable: true });
    const result = validateNarrowing(freeformParent, child, treeOracle);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("free_form_non_delegable");
  });

  it("freeform parent returns free_form_non_delegable before inspecting child (even with freeform child)", () => {
    const freeformParent = makeGrant(freeformScope, { delegable: true });
    const freeformChild = makeGrant(freeformScope, { delegable: false });
    const result = validateNarrowing(freeformParent, freeformChild, treeOracle);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("free_form_non_delegable");
  });

  it("a freeform child with a lattice parent → scope_widens (freeform ⋢ any lattice scope)", () => {
    const latticeParent = makeGrant(node("app-1"), { delegable: true });
    const freeformChild = makeGrant(freeformScope, { delegable: false });
    const result = validateNarrowing(latticeParent, freeformChild, treeOracle);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("scope_widens");
  });

  it("a non-delegable parent (regardless of freeform) → parent_non_delegable", () => {
    // non-delegable beats freeform check order
    const freeformNonDelegable = makeGrant(freeformScope, { delegable: false });
    const child = makeGrant(node("reg-1"), { delegable: true });
    const result = validateNarrowing(freeformNonDelegable, child, treeOracle);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("parent_non_delegable");
  });
});

// ---------------------------------------------------------------------------
// FF-9 / AC-13 — validity window = capability
// ---------------------------------------------------------------------------

describe("FF-9 / AC-13: validity window", () => {
  const NOW = 10_000;

  it("no bounds → always effective", () => {
    const g = makeGrant(node("app-1"));
    expect(isEffective(g, NOW)).toBe(true);
  });

  it("validFrom in the past → effective", () => {
    const g = makeGrant(node("app-1"), { validFrom: NOW - 1000 });
    expect(isEffective(g, NOW)).toBe(true);
  });

  it("validFrom == now → effective (≥ check)", () => {
    const g = makeGrant(node("app-1"), { validFrom: NOW });
    expect(isEffective(g, NOW)).toBe(true);
  });

  it("validFrom in the future → not effective", () => {
    const g = makeGrant(node("app-1"), { validFrom: NOW + 1 });
    expect(isEffective(g, NOW)).toBe(false);
  });

  it("validUntil in the future → effective (< check)", () => {
    const g = makeGrant(node("app-1"), { validUntil: NOW + 1000 });
    expect(isEffective(g, NOW)).toBe(true);
  });

  it("validUntil == now → not effective (< is strict)", () => {
    const g = makeGrant(node("app-1"), { validUntil: NOW });
    expect(isEffective(g, NOW)).toBe(false);
  });

  it("validUntil in the past → not effective (zero capability)", () => {
    const g = makeGrant(node("app-1"), { validUntil: NOW - 1 });
    expect(isEffective(g, NOW)).toBe(false);
  });

  it("in-window with both bounds → effective", () => {
    const g = makeGrant(node("app-1"), {
      validFrom: NOW - 500,
      validUntil: NOW + 500,
    });
    expect(isEffective(g, NOW)).toBe(true);
  });

  it("validFrom in the future and validUntil in the future → not effective (before window)", () => {
    const g = makeGrant(node("app-1"), {
      validFrom: NOW + 100,
      validUntil: NOW + 500,
    });
    expect(isEffective(g, NOW)).toBe(false);
  });

  it("past validUntil + past validFrom → not effective (window expired)", () => {
    const g = makeGrant(node("app-1"), {
      validFrom: NOW - 1000,
      validUntil: NOW - 1,
    });
    expect(isEffective(g, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Additional: isBottom + BOTTOM
// ---------------------------------------------------------------------------

describe("BOTTOM / isBottom", () => {
  it("BOTTOM is an empty set", () => {
    expect(BOTTOM.kind).toBe("set");
    expect((BOTTOM as { members: unknown[] }).members).toHaveLength(0);
  });

  it("isBottom(BOTTOM) = true", () => {
    expect(isBottom(BOTTOM)).toBe(true);
  });

  it("isBottom(non-empty set) = false", () => {
    expect(isBottom(setOf(node("app-1") as AtomElement))).toBe(false);
  });

  it("isBottom(non-set) = false", () => {
    expect(isBottom(node("app-1"))).toBe(false);
    expect(isBottom(tags("a"))).toBe(false);
    expect(isBottom(interval("amount", 0, 100))).toBe(false);
  });
});
