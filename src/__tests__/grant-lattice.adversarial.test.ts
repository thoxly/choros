/**
 * T-0018 ADVERSARIAL PROPERTY TESTS — scope-lattice algebra.
 *
 * Role: independent, adversarial verification by the TEST phase.
 * Goal: find widening leaks, order violations, closure failures — if any exist.
 *
 * Design choices:
 *   - NO Math.random. All generation uses a seeded LCG (deterministic, reproducible).
 *   - Property-test approach: enumerate or generate many triples and check invariants.
 *   - Each security-critical invariant has its own describe block.
 *   - Fuzz attempts explicitly construct widening inputs and assert ALL are rejected.
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
} from "../core/grant-lattice.js";

// ---------------------------------------------------------------------------
// Seeded LCG generator — NO Math.random, fully deterministic & reproducible
// ---------------------------------------------------------------------------

/**
 * Linear congruential generator (Knuth constants).
 * Returns a function that produces integers in [0, m).
 */
function makeLcg(seed: number) {
  const a = 1664525;
  const c = 1013904223;
  let s = seed >>> 0;
  return () => {
    s = ((a * s + c) >>> 0); // stays in [0, 2^32)
    return s;
  };
}

/** Pick a random element from an array (deterministic). */
function pick<T>(arr: T[], rng: () => number): T {
  return arr[rng() % arr.length]!;
}

/** Pick a random integer in [lo, hi] inclusive. */
function randInt(lo: number, hi: number, rng: () => number): number {
  return lo + (rng() % (hi - lo + 1));
}

// ---------------------------------------------------------------------------
// Ancestry oracle — a deterministic tree for property tests
// ---------------------------------------------------------------------------

/**
 * Fixed 5-node tree for all property tests:
 *
 *   root
 *   ├─ a
 *   │  ├─ a1
 *   │  └─ a2
 *   └─ b
 *      └─ b1
 *
 * Disjoint trees (root2 / x / y) have no relationship with root.
 */
const TREE_EDGES: Array<[string, string]> = [
  ["a", "root"],
  ["a1", "a"],
  ["a2", "a"],
  ["b", "root"],
  ["b1", "b"],
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
        if (!visited.has(p)) { visited.add(p); queue.push(p); }
      }
    }
    return visited;
  }
  return {
    isDescendantOrSelf(_, descendantId, ancestorId) {
      if (descendantId === ancestorId) return true;
      return ancestors(descendantId).has(ancestorId);
    },
  };
}

const oracle = buildOracle(TREE_EDGES);

// All node IDs in the tree, plus disjoint ones
const ALL_NODE_IDS = ["root", "a", "a1", "a2", "b", "b1"];
const DISJOINT_IDS = ["x", "y", "z"]; // not in the tree

// Known descendant pairs (descendant ⊑ ancestor):
const PROPER_DESCENDANT_PAIRS: Array<[string, string]> = [
  ["a", "root"], ["a1", "root"], ["a2", "root"],
  ["b", "root"], ["b1", "root"],
  ["a1", "a"], ["a2", "a"],
  ["b1", "b"],
];

// Known non-relation pairs (neither is ancestor/descendant of the other):
const DISJOINT_NODE_PAIRS: Array<[string, string]> = [
  ["a", "b"], ["a1", "a2"], ["a1", "b"], ["a1", "b1"],
  ["a2", "b"], ["a2", "b1"], ["a", "b1"],
];

// ---------------------------------------------------------------------------
// Element constructors
// ---------------------------------------------------------------------------

function node(nodeId: string): ScopeElement {
  return { kind: "node", hierarchy: "resource", nodeId, nodeLevel: "application" };
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

function makeGrant(scope: GrantScope, opts?: {
  delegable?: boolean;
  resourceFacet?: unknown;
  constraint?: unknown;
}): Grant {
  return {
    tenantId: "t",
    id: "g",
    roleId: "r",
    resourceType: "application" as ResourceType,
    operation: "read" as Operation,
    scope,
    delegable: opts?.delegable ?? true,
    grantedBy: "actor",
    resourceFacet: opts?.resourceFacet,
    constraint: opts?.constraint,
    createdAt: 0,
  };
}

// ---------------------------------------------------------------------------
// A pool of "well-formed" elements for property testing
// ---------------------------------------------------------------------------

const ATOM_POOL: AtomElement[] = [
  node("root") as AtomElement,
  node("a") as AtomElement,
  node("a1") as AtomElement,
  node("a2") as AtomElement,
  node("b") as AtomElement,
  node("b1") as AtomElement,
  node("x") as AtomElement,       // disjoint from tree
  tags("p") as AtomElement,
  tags("q") as AtomElement,
  tags("p", "q") as AtomElement,
  tags("p", "q", "r") as AtomElement,
  tags("r", "s") as AtomElement,
  interval(0, 100) as AtomElement,
  interval(10, 50) as AtomElement,
  interval(20, 40) as AtomElement,
  interval(50, 100) as AtomElement,
  interval(0, 200) as AtomElement,
];

const SCOPE_POOL: ScopeElement[] = [
  BOTTOM,
  ...ATOM_POOL,
  setOf(node("a") as AtomElement, tags("p") as AtomElement),
  setOf(node("root") as AtomElement, tags("p", "q") as AtomElement),
  setOf(node("a1") as AtomElement, interval(0, 100) as AtomElement),
  setOf(
    node("a") as AtomElement,
    tags("p") as AtomElement,
    interval(0, 100) as AtomElement,
  ),
];

// ---------------------------------------------------------------------------
// INVARIANT 1: ⊑ is a partial order
//   (1a) Reflexivity: x ⊑ x
//   (1b) Antisymmetry on canonical forms: x ⊑ y ∧ y ⊑ x ⇒ normalize(x) deepEquals normalize(y)
//   (1c) Transitivity: x ⊑ y ∧ y ⊑ z ⇒ x ⊑ z
// ---------------------------------------------------------------------------

describe("ADVERSARIAL: partial order properties of ⊑", () => {
  // (1a) Reflexivity over all elements in SCOPE_POOL
  it("(1a) reflexivity: x ⊑ x for every element in pool", () => {
    for (const x of SCOPE_POOL) {
      const result = isNarrowerOrEqual(x, x, oracle);
      if (!result) {
        throw new Error(`Reflexivity violated: x = ${JSON.stringify(x)}`);
      }
      expect(result).toBe(true);
    }
  });

  // (1a) Reflexivity over generated set combinations
  it("(1a) reflexivity: generated set elements ⊑ themselves", () => {
    const rng = makeLcg(0xDEADBEEF);
    // Generate 200 sets of 1..3 atom members
    for (let i = 0; i < 200; i++) {
      const size = 1 + (rng() % 3);
      const members: AtomElement[] = [];
      for (let k = 0; k < size; k++) {
        members.push(pick(ATOM_POOL, rng));
      }
      const s = normalize(setOf(...members));
      const result = isNarrowerOrEqual(s, s, oracle);
      if (!result) {
        throw new Error(`Reflexivity violated on generated set: ${JSON.stringify(s)}`);
      }
      expect(result).toBe(true);
    }
  });

  // (1b) Antisymmetry on canonical forms
  it("(1b) antisymmetry: x ⊑ y ∧ y ⊑ x ⇒ normalize(x) deepEquals normalize(y)", () => {
    const pool = SCOPE_POOL.map(normalize);
    for (const x of pool) {
      for (const y of pool) {
        const xy = isNarrowerOrEqual(x, y, oracle);
        const yx = isNarrowerOrEqual(y, x, oracle);
        if (xy && yx) {
          const nx = JSON.stringify(normalize(x));
          const ny = JSON.stringify(normalize(y));
          if (nx !== ny) {
            throw new Error(
              `Antisymmetry violated:\n  x=${JSON.stringify(x)}\n  y=${JSON.stringify(y)}\n  normalize(x)=${nx}\n  normalize(y)=${ny}`
            );
          }
          expect(nx).toBe(ny);
        }
      }
    }
  });

  // (1c) Transitivity: exhaustive over SCOPE_POOL triples
  it("(1c) transitivity: x ⊑ y ∧ y ⊑ z ⇒ x ⊑ z (pool triples)", () => {
    const pool = SCOPE_POOL;
    for (const x of pool) {
      for (const y of pool) {
        const xy = isNarrowerOrEqual(x, y, oracle);
        if (!xy) continue;
        for (const z of pool) {
          const yz = isNarrowerOrEqual(y, z, oracle);
          if (!yz) continue;
          const xz = isNarrowerOrEqual(x, z, oracle);
          if (!xz) {
            throw new Error(
              `Transitivity violated:\n  x=${JSON.stringify(x)}\n  y=${JSON.stringify(y)}\n  z=${JSON.stringify(z)}\n  x⊑y=true, y⊑z=true, x⊑z=FALSE`
            );
          }
          expect(xz).toBe(true);
        }
      }
    }
  });

  // (1c) Transitivity: generated node triples along the tree chain
  it("(1c) transitivity: node chains in the tree (generated)", () => {
    // Every node in the tree satisfies: leaf ⊑ mid ⊑ root ⇒ leaf ⊑ root
    const chains: Array<[string, string, string]> = [
      ["a1", "a", "root"],
      ["a2", "a", "root"],
      ["b1", "b", "root"],
    ];
    for (const [x, y, z] of chains) {
      expect(isNarrowerOrEqual(node(x), node(y), oracle)).toBe(true);
      expect(isNarrowerOrEqual(node(y), node(z), oracle)).toBe(true);
      const xz = isNarrowerOrEqual(node(x), node(z), oracle);
      if (!xz) {
        throw new Error(`Transitivity violated: node(${x}) ⊑ node(${y}) ⊑ node(${z}) but node(${x}) ⋢ node(${z})`);
      }
      expect(xz).toBe(true);
    }
  });

  // (1c) Transitivity: tag-set chains
  it("(1c) transitivity: tag-set chains", () => {
    // {p} ⊑ {p,q} ⊑ {p,q,r} ⇒ {p} ⊑ {p,q,r}
    const x = tags("p");
    const y = tags("p", "q");
    const z = tags("p", "q", "r");
    expect(isNarrowerOrEqual(x, y, oracle)).toBe(true);
    expect(isNarrowerOrEqual(y, z, oracle)).toBe(true);
    expect(isNarrowerOrEqual(x, z, oracle)).toBe(true);
  });

  // (1c) Transitivity: interval chains
  it("(1c) transitivity: interval chains", () => {
    // [20,40] ⊑ [10,50] ⊑ [0,100]
    const x = interval(20, 40);
    const y = interval(10, 50);
    const z = interval(0, 100);
    expect(isNarrowerOrEqual(x, y, oracle)).toBe(true);
    expect(isNarrowerOrEqual(y, z, oracle)).toBe(true);
    expect(isNarrowerOrEqual(x, z, oracle)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INVARIANT 2: meet is the greatest lower bound
//   (2a) meet(x,y) ⊑ x  and  meet(x,y) ⊑ y
//   (2b) z ⊑ x ∧ z ⊑ y  ⇒  z ⊑ meet(x,y)
//   (2c) Closure: meet always returns a valid admissible element
// ---------------------------------------------------------------------------

describe("ADVERSARIAL: meet is the greatest lower bound", () => {
  const admissible = (s: ScopeElement) =>
    ["node", "tags", "interval", "set"].includes(s.kind);

  // (2a) meet(x,y) ⊑ x AND meet(x,y) ⊑ y — over all pairs in pool
  it("(2a) meet(x,y) ⊑ x and ⊑ y for all pool pairs", () => {
    for (const x of SCOPE_POOL) {
      for (const y of SCOPE_POOL) {
        const m = meet(x, y, oracle);
        const mx = isNarrowerOrEqual(m, x, oracle);
        const my = isNarrowerOrEqual(m, y, oracle);
        if (!mx) {
          throw new Error(
            `meet not ⊑ x:\n  x=${JSON.stringify(x)}\n  y=${JSON.stringify(y)}\n  meet=${JSON.stringify(m)}`
          );
        }
        if (!my) {
          throw new Error(
            `meet not ⊑ y:\n  x=${JSON.stringify(x)}\n  y=${JSON.stringify(y)}\n  meet=${JSON.stringify(m)}`
          );
        }
        expect(mx).toBe(true);
        expect(my).toBe(true);
      }
    }
  });

  // (2b) z ⊑ x ∧ z ⊑ y ⇒ z ⊑ meet(x,y) — over all triples in pool
  it("(2b) z ⊑ x ∧ z ⊑ y ⇒ z ⊑ meet(x,y) for all pool triples (greatest lower bound)", () => {
    for (const x of SCOPE_POOL) {
      for (const y of SCOPE_POOL) {
        const m = meet(x, y, oracle);
        for (const z of SCOPE_POOL) {
          const zx = isNarrowerOrEqual(z, x, oracle);
          const zy = isNarrowerOrEqual(z, y, oracle);
          if (zx && zy) {
            const zm = isNarrowerOrEqual(z, m, oracle);
            if (!zm) {
              throw new Error(
                `GLB violated (z ⊑ x ∧ z ⊑ y but z ⋢ meet(x,y)):\n  x=${JSON.stringify(x)}\n  y=${JSON.stringify(y)}\n  z=${JSON.stringify(z)}\n  meet(x,y)=${JSON.stringify(m)}`
              );
            }
            expect(zm).toBe(true);
          }
        }
      }
    }
  });

  // (2c) Closure: meet always returns an admissible element — never throws
  it("(2c) meet closure: result always admissible, never throws (generated pairs)", () => {
    const rng = makeLcg(0xABCD1234);
    for (let i = 0; i < 500; i++) {
      const x = pick(SCOPE_POOL, rng);
      const y = pick(SCOPE_POOL, rng);
      let m: ScopeElement;
      expect(() => { m = meet(x, y, oracle); }).not.toThrow();
      m = meet(x, y, oracle);
      if (!admissible(m)) {
        throw new Error(
          `meet result not admissible:\n  x=${JSON.stringify(x)}\n  y=${JSON.stringify(y)}\n  result=${JSON.stringify(m)}`
        );
      }
      expect(admissible(m)).toBe(true);
    }
  });

  // Symmetry of meet: meet(x,y) and meet(y,x) should be equivalent under ⊑
  it("meet symmetry: meet(x,y) ⊑ meet(y,x) and meet(y,x) ⊑ meet(x,y) (canonical form equality)", () => {
    for (const x of SCOPE_POOL) {
      for (const y of SCOPE_POOL) {
        const mxy = normalize(meet(x, y, oracle));
        const myx = normalize(meet(y, x, oracle));
        // They should be mutually ⊑ (i.e., antisymmetric ⇒ equal canonical forms)
        const a = isNarrowerOrEqual(mxy, myx, oracle);
        const b = isNarrowerOrEqual(myx, mxy, oracle);
        if (!a || !b) {
          throw new Error(
            `meet not symmetric:\n  x=${JSON.stringify(x)}\n  y=${JSON.stringify(y)}\n  meet(x,y)=${JSON.stringify(mxy)}\n  meet(y,x)=${JSON.stringify(myx)}`
          );
        }
      }
    }
  });

  // BOTTOM absorber: ⊥ ⊓ X = ⊥ = X ⊓ ⊥
  it("BOTTOM absorber: meet(BOTTOM, X) = BOTTOM = meet(X, BOTTOM)", () => {
    for (const x of SCOPE_POOL) {
      expect(isBottom(meet(BOTTOM, x, oracle))).toBe(true);
      expect(isBottom(meet(x, BOTTOM, oracle))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// INVARIANT 3: normalize is idempotent
// ---------------------------------------------------------------------------

describe("ADVERSARIAL: normalize idempotence", () => {
  it("normalize(normalize(x)) deep-equals normalize(x) for all pool elements", () => {
    for (const x of SCOPE_POOL) {
      const once = normalize(x);
      const twice = normalize(once);
      if (JSON.stringify(once) !== JSON.stringify(twice)) {
        throw new Error(
          `normalize not idempotent:\n  x=${JSON.stringify(x)}\n  normalize(x)=${JSON.stringify(once)}\n  normalize(normalize(x))=${JSON.stringify(twice)}`
        );
      }
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    }
  });

  it("normalize is idempotent on generated sets (seeded)", () => {
    const rng = makeLcg(0x12345678);
    for (let i = 0; i < 300; i++) {
      const size = 1 + (rng() % 4);
      const members: AtomElement[] = [];
      for (let k = 0; k < size; k++) {
        members.push(pick(ATOM_POOL, rng));
      }
      const raw = setOf(...members);
      const once = normalize(raw);
      const twice = normalize(once);
      if (JSON.stringify(once) !== JSON.stringify(twice)) {
        throw new Error(
          `normalize not idempotent on generated set:\n  raw=${JSON.stringify(raw)}\n  normalize once=${JSON.stringify(once)}\n  twice=${JSON.stringify(twice)}`
        );
      }
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    }
  });

  it("normalize is order-independent: permuting tag array gives same result", () => {
    // {r,p,q} and {p,q,r} and {q,r,p} should all normalize to the same thing
    const variants = [
      tags("r", "p", "q"),
      tags("p", "q", "r"),
      tags("q", "r", "p"),
      tags("p", "r", "q"),
    ];
    const canonical = JSON.stringify(normalize(variants[0]!));
    for (const v of variants) {
      expect(JSON.stringify(normalize(v))).toBe(canonical);
    }
  });

  it("normalize is order-independent: permuting set members gives ⊑-equivalent results", () => {
    const rng = makeLcg(0xFACEB00C);
    for (let i = 0; i < 100; i++) {
      const size = 2 + (rng() % 3);
      const members: AtomElement[] = [];
      for (let k = 0; k < size; k++) {
        members.push(pick(ATOM_POOL, rng));
      }
      // Build two permutations
      const s1 = normalize(setOf(...members));
      const shuffled = [...members].reverse();
      const s2 = normalize(setOf(...shuffled));
      // They should be mutually ⊑ (canonically equal after normalize)
      const ab = isNarrowerOrEqual(s1, s2, oracle);
      const ba = isNarrowerOrEqual(s2, s1, oracle);
      if (!ab || !ba) {
        throw new Error(
          `normalize order-independence violated:\n  forward=${JSON.stringify(s1)}\n  reversed=${JSON.stringify(s2)}`
        );
      }
      expect(ab).toBe(true);
      expect(ba).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// INVARIANT 4 (CORE SECURITY): No-widening invariant
//   validateNarrowing(parent, child) returns ok:true ⟺ child.scope ⊑ parent.scope
//   (plus delegable & non-freeform checks)
//
// This is the adversarial heart: we FUZZ every axis attempting to widen.
// Any ok:true for a non-⊑ child is a security LEAK.
// ---------------------------------------------------------------------------

describe("ADVERSARIAL: no-widening security invariant (validateNarrowing)", () => {
  // --- Node axis widening attempts ---

  it("FUZZ node: ancestor node always rejected as child when parent is descendant", () => {
    for (const [descendant, ancestor] of PROPER_DESCENDANT_PAIRS) {
      const parent = makeGrant(node(descendant), { delegable: true }); // parent is narrower
      const child = makeGrant(node(ancestor), { delegable: true });    // child is WIDER
      const result = validateNarrowing(parent, child, oracle);
      if (result.ok) {
        throw new Error(
          `WIDENING LEAK: ancestor node accepted as child!\n  parent.scope=node(${descendant})\n  child.scope=node(${ancestor})\n  result=${JSON.stringify(result)}`
        );
      }
      expect(result.ok).toBe(false);
    }
  });

  it("FUZZ node: disjoint node always rejected", () => {
    for (const [a, b] of DISJOINT_NODE_PAIRS) {
      const parent = makeGrant(node(a), { delegable: true });
      const child = makeGrant(node(b), { delegable: true }); // disjoint = not ⊑
      const result = validateNarrowing(parent, child, oracle);
      if (result.ok) {
        throw new Error(
          `WIDENING LEAK: disjoint node accepted!\n  parent=node(${a})\n  child=node(${b})`
        );
      }
      expect(result.ok).toBe(false);
    }
  });

  it("FUZZ node: disjoint tree (x,y,z) always rejected against tree nodes", () => {
    for (const parentId of ALL_NODE_IDS) {
      for (const disjointId of DISJOINT_IDS) {
        const parent = makeGrant(node(parentId), { delegable: true });
        const child = makeGrant(node(disjointId), { delegable: true });
        // disjoint IDs are not in the tree → not ⊑ any tree node
        const result = validateNarrowing(parent, child, oracle);
        if (result.ok) {
          throw new Error(
            `WIDENING LEAK: disjoint node accepted!\n  parent=node(${parentId})\n  child=node(${disjointId})`
          );
        }
        expect(result.ok).toBe(false);
      }
    }
  });

  // --- Tag-set axis widening attempts ---

  it("FUZZ tags: superset of tags always rejected", () => {
    // Parent has {p,q}. Child with {p,q,X} for any X not in parent should be rejected.
    const parentTagScope = tags("p", "q");
    const extraTags = ["r", "s", "t", "u", "v", "w"];
    for (const extra of extraTags) {
      const child = makeGrant(tags("p", "q", extra), { delegable: true });
      const parent = makeGrant(parentTagScope, { delegable: true });
      const result = validateNarrowing(parent, child, oracle);
      if (result.ok) {
        throw new Error(
          `WIDENING LEAK: tag superset accepted!\n  parent.tags=[p,q]\n  child.tags=[p,q,${extra}]`
        );
      }
      expect(result.ok).toBe(false);
    }
  });

  it("FUZZ tags: completely disjoint tag set rejected", () => {
    const parent = makeGrant(tags("p", "q"), { delegable: true });
    const disjointChildren = [
      tags("r"),
      tags("s", "t"),
      tags("r", "p"),   // partial: "r" not in parent, so child has {r,p} ⊄ {p,q}
    ];
    for (const cs of disjointChildren) {
      const child = makeGrant(cs, { delegable: true });
      // Check ⊑ manually first
      const isNarrow = isNarrowerOrEqual(cs, tags("p", "q"), oracle);
      if (!isNarrow) {
        const result = validateNarrowing(parent, child, oracle);
        if (result.ok) {
          throw new Error(
            `WIDENING LEAK: non-⊑ tags accepted!\n  parent.tags=[p,q]\n  child=${JSON.stringify(cs)}`
          );
        }
        expect(result.ok).toBe(false);
      }
    }
  });

  it("FUZZ tags: generated superset always rejected", () => {
    const rng = makeLcg(0xBEEFCAFE);
    const baseTagPool = ["a", "b", "c", "d", "e"];
    for (let i = 0; i < 200; i++) {
      // Pick a subset as the parent scope
      const parentSize = 1 + (rng() % (baseTagPool.length - 1));
      const parentTags = baseTagPool.slice(0, parentSize);
      // Add at least one extra tag (guaranteed superset)
      const extraIndex = parentSize + (rng() % (baseTagPool.length - parentSize));
      if (extraIndex >= baseTagPool.length) continue; // safety
      const childTags = [...parentTags, baseTagPool[extraIndex]!];
      const parentScope = tags(...parentTags);
      const childScope = tags(...childTags);
      const isNarrow = isNarrowerOrEqual(childScope, parentScope, oracle);
      if (isNarrow) continue; // shouldn't happen, but skip if oracle says ok
      const result = validateNarrowing(
        makeGrant(parentScope, { delegable: true }),
        makeGrant(childScope, { delegable: true }),
        oracle,
      );
      if (result.ok) {
        throw new Error(
          `WIDENING LEAK: generated tag superset accepted!\n  parent.tags=${JSON.stringify(parentTags)}\n  child.tags=${JSON.stringify(childTags)}`
        );
      }
      expect(result.ok).toBe(false);
    }
  });

  // --- Interval axis widening attempts ---

  it("FUZZ interval: lo widening (child.lo < parent.lo) rejected", () => {
    const parent = makeGrant(interval(10, 90), { delegable: true });
    const loCases = [9, 5, 0, -1, -100];
    for (const lo of loCases) {
      const child = makeGrant(interval(lo, 90), { delegable: true });
      const result = validateNarrowing(parent, child, oracle);
      if (result.ok) {
        throw new Error(
          `WIDENING LEAK: interval lo-widening accepted!\n  parent=[10,90]\n  child=[${lo},90]`
        );
      }
      expect(result.ok).toBe(false);
    }
  });

  it("FUZZ interval: hi widening (child.hi > parent.hi) rejected", () => {
    const parent = makeGrant(interval(10, 90), { delegable: true });
    const hiCases = [91, 100, 200, 1000];
    for (const hi of hiCases) {
      const child = makeGrant(interval(10, hi), { delegable: true });
      const result = validateNarrowing(parent, child, oracle);
      if (result.ok) {
        throw new Error(
          `WIDENING LEAK: interval hi-widening accepted!\n  parent=[10,90]\n  child=[10,${hi}]`
        );
      }
      expect(result.ok).toBe(false);
    }
  });

  it("FUZZ interval: both-ends widening rejected", () => {
    const parent = makeGrant(interval(10, 90), { delegable: true });
    const wideChildren = [
      interval(5, 95),
      interval(0, 100),
      interval(-10, 200),
    ];
    for (const cs of wideChildren) {
      const child = makeGrant(cs, { delegable: true });
      const result = validateNarrowing(parent, child, oracle);
      if (result.ok) {
        throw new Error(
          `WIDENING LEAK: interval both-ends widening accepted!\n  parent=[10,90]\n  child=${JSON.stringify(cs)}`
        );
      }
      expect(result.ok).toBe(false);
    }
  });

  it("FUZZ interval: wrong axis rejected", () => {
    const parent = makeGrant(interval(0, 100, "amount"), { delegable: true });
    // Child with different axis: not ⊑, must be rejected
    const child = makeGrant(interval(0, 100, "price"), { delegable: true });
    const result = validateNarrowing(parent, child, oracle);
    if (result.ok) {
      throw new Error(
        `WIDENING LEAK: interval cross-axis accepted!\n  parent.axis=amount\n  child.axis=price`
      );
    }
    expect(result.ok).toBe(false);
  });

  it("FUZZ interval: generated widening (seeded)", () => {
    const rng = makeLcg(0xCAFEF00D);
    for (let i = 0; i < 300; i++) {
      // Parent interval [pLo, pHi]
      const pLo = randInt(0, 50, rng);
      const pHi = pLo + randInt(1, 50, rng);
      // Widen in one direction (guaranteed widening)
      const widenLo = pLo - randInt(1, 10, rng); // lo is smaller → wider
      const widenHi = pHi + randInt(1, 10, rng); // hi is larger → wider
      const side = rng() % 3; // 0=lo, 1=hi, 2=both

      let cLo = pLo;
      let cHi = pHi;
      if (side === 0 || side === 2) cLo = widenLo;
      if (side === 1 || side === 2) cHi = widenHi;

      const parentScope = interval(pLo, pHi);
      const childScope = interval(cLo, cHi);
      const isNarrow = isNarrowerOrEqual(childScope, parentScope, oracle);
      if (isNarrow) continue; // edge case: not actually widening, skip
      const result = validateNarrowing(
        makeGrant(parentScope, { delegable: true }),
        makeGrant(childScope, { delegable: true }),
        oracle,
      );
      if (result.ok) {
        throw new Error(
          `WIDENING LEAK: generated interval widening accepted!\n  parent=[${pLo},${pHi}]\n  child=[${cLo},${cHi}]`
        );
      }
      expect(result.ok).toBe(false);
    }
  });

  // --- Scope-set widening: adding extra members ---

  it("FUZZ scope-set: adding an extra member outside parent reach always rejected", () => {
    // Parent set = {node(a)}. Adding node(x) which is outside tree = widening.
    const parentSet = setOf(node("a") as AtomElement);
    const extraMembers = [
      node("x"),       // disjoint from tree
      node("y"),       // disjoint
      node("b"),       // sibling subtree, not under "a"
      tags("p"),       // different kind, not in parent
      interval(0, 100) as unknown as ScopeElement, // different kind
    ];
    for (const extra of extraMembers) {
      const childSet = setOf(
        node("a1") as AtomElement,             // valid narrowing
        extra as AtomElement,                  // the escape
      );
      const child = makeGrant(childSet, { delegable: true });
      const parent = makeGrant(parentSet, { delegable: true });
      const isNarrow = isNarrowerOrEqual(childSet, parentSet, oracle);
      if (!isNarrow) {
        const result = validateNarrowing(parent, child, oracle);
        if (result.ok) {
          throw new Error(
            `WIDENING LEAK: extra set member accepted!\n  parent=${JSON.stringify(parentSet)}\n  child=${JSON.stringify(childSet)}`
          );
        }
        expect(result.ok).toBe(false);
      }
    }
  });

  // --- Freeform scope: must always be rejected as child ---

  it("FUZZ freeform child: always rejected regardless of parent scope", () => {
    const freeformChild: GrantScope = { kind: "freeform", predicate: "x > 0" };
    const parentScopes: ScopeElement[] = [
      node("root"),
      node("a"),
      tags("p", "q"),
      interval(0, 100),
      setOf(node("a") as AtomElement),
      BOTTOM,
    ];
    for (const ps of parentScopes) {
      const parent = makeGrant(ps, { delegable: true });
      const child = makeGrant(freeformChild, { delegable: true });
      const result = validateNarrowing(parent, child, oracle);
      if (result.ok) {
        throw new Error(
          `WIDENING LEAK: freeform child accepted under lattice parent!\n  parent.scope=${JSON.stringify(ps)}\n  freeform predicate="x > 0"`
        );
      }
      expect(result.ok).toBe(false);
    }
  });

  it("FUZZ freeform parent: always rejected (free_form_non_delegable) regardless of child scope", () => {
    const freeformParent: GrantScope = { kind: "freeform", predicate: "status='active'" };
    const childScopes: GrantScope[] = [
      node("a"),
      tags("p"),
      interval(0, 100),
      setOf(node("a1") as AtomElement),
      BOTTOM,
      { kind: "freeform", predicate: "status='active'" },
    ];
    for (const cs of childScopes) {
      const parent = makeGrant(freeformParent, { delegable: true });
      const child = makeGrant(cs, { delegable: true });
      const result = validateNarrowing(parent, child, oracle);
      if (result.ok) {
        throw new Error(
          `WIDENING LEAK: freeform parent did not block!\n  parent.scope=freeform\n  child.scope=${JSON.stringify(cs)}`
        );
      }
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toBe("free_form_non_delegable");
    }
  });

  // --- Facet widening attempts ---

  it("FUZZ facet: child absent when parent present = widening, always rejected", () => {
    const parentFacets = [
      { fields: ["name"] },
      { filter: "status=active" },
      { columns: ["id", "type"] },
      42,
      "restricted",
    ];
    for (const facet of parentFacets) {
      const parent = makeGrant(node("a"), { delegable: true, resourceFacet: facet });
      const child = makeGrant(node("a1"), { delegable: true }); // no facet = wider
      const result = validateNarrowing(parent, child, oracle);
      if (result.ok) {
        throw new Error(
          `WIDENING LEAK: facet absent on child when parent has facet!\n  parent.facet=${JSON.stringify(facet)}`
        );
      }
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toBe("facet_widens");
    }
  });

  it("FUZZ facet: different child facet when parent has facet = widening, always rejected", () => {
    const parent = makeGrant(node("a"), {
      delegable: true,
      resourceFacet: { fields: ["name", "type"] },
    });
    const diffFacets = [
      { fields: ["name"] },          // subset, but different structure
      { fields: ["name", "extra"] },  // superset
      { filter: "status=active" },    // completely different
      null,                           // null != present
    ];
    for (const childFacet of diffFacets) {
      if (childFacet === null) {
        // null = absent = widening
        const child = makeGrant(node("a1"), { delegable: true, resourceFacet: null });
        const result = validateNarrowing(parent, child, oracle);
        // null is treated as absent (undefined || null)
        if (result.ok) {
          throw new Error(`WIDENING LEAK: null facet accepted when parent has facet`);
        }
        expect(result.ok).toBe(false);
      } else {
        const child = makeGrant(node("a1"), { delegable: true, resourceFacet: childFacet });
        const isEqual = JSON.stringify(childFacet) === JSON.stringify({ fields: ["name", "type"] });
        if (!isEqual) {
          const result = validateNarrowing(parent, child, oracle);
          if (result.ok) {
            throw new Error(
              `WIDENING LEAK: different facet accepted!\n  parent.facet=${JSON.stringify({ fields: ["name", "type"] })}\n  child.facet=${JSON.stringify(childFacet)}`
            );
          }
          expect(result.ok).toBe(false);
        }
      }
    }
  });

  // --- Constraint widening attempts ---

  it("FUZZ constraint: child absent when parent has constraint = widening, always rejected", () => {
    const parentConstraints = [
      { status: "active" },
      { level: 3 },
      { org: "sales", role: "mgr" },
    ];
    for (const constraint of parentConstraints) {
      const parent = makeGrant(node("a"), { delegable: true, constraint });
      const child = makeGrant(node("a1"), { delegable: true }); // no constraint = wider
      const result = validateNarrowing(parent, child, oracle);
      if (result.ok) {
        throw new Error(
          `WIDENING LEAK: constraint absent on child when parent has constraint!\n  parent.constraint=${JSON.stringify(constraint)}`
        );
      }
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toBe("constraint_widens");
    }
  });

  it("FUZZ constraint: different child constraint when parent has constraint = widening, rejected", () => {
    const parent = makeGrant(node("a"), {
      delegable: true,
      constraint: { status: "active" },
    });
    const childConstraints = [
      { status: "inactive" },   // different value
      { status: "active", extra: true }, // extra field
      { other: "field" },       // completely different
    ];
    for (const cc of childConstraints) {
      const child = makeGrant(node("a1"), { delegable: true, constraint: cc });
      const result = validateNarrowing(parent, child, oracle);
      if (result.ok) {
        throw new Error(
          `WIDENING LEAK: different constraint accepted!\n  parent.constraint=${JSON.stringify({ status: "active" })}\n  child.constraint=${JSON.stringify(cc)}`
        );
      }
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toBe("constraint_widens");
    }
  });

  // --- Non-delegable parent ---

  it("FUZZ non-delegable: non-delegable parent always rejected regardless of scope/facet", () => {
    const scopes: ScopeElement[] = [
      node("root"), node("a"), node("a1"),
      tags("p"), interval(0, 100), BOTTOM,
    ];
    for (const ps of scopes) {
      const parent = makeGrant(ps, { delegable: false });
      const child = makeGrant(
        // Even a BOTTOM child (narrowest possible) must be rejected
        BOTTOM,
        { delegable: true },
      );
      const result = validateNarrowing(parent, child, oracle);
      if (result.ok) {
        throw new Error(
          `WIDENING LEAK: non-delegable parent allowed delegation!\n  parent.scope=${JSON.stringify(ps)}`
        );
      }
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toBe("parent_non_delegable");
    }
  });

  // --- Cross-kind widening in scope (child is different kind than parent) ---

  it("FUZZ cross-kind: child with different atom kind than parent always rejected", () => {
    const crossPairs: Array<[ScopeElement, ScopeElement]> = [
      [node("a"),           tags("p")],
      [node("a"),           interval(0, 100)],
      [tags("p"),           node("a")],
      [tags("p"),           interval(0, 100)],
      [interval(0, 100),    node("a")],
      [interval(0, 100),    tags("p")],
    ];
    for (const [parentScope, childScope] of crossPairs) {
      const isNarrow = isNarrowerOrEqual(childScope, parentScope, oracle);
      if (!isNarrow) {
        const result = validateNarrowing(
          makeGrant(parentScope, { delegable: true }),
          makeGrant(childScope, { delegable: true }),
          oracle,
        );
        if (result.ok) {
          throw new Error(
            `WIDENING LEAK: cross-kind child accepted!\n  parent=${JSON.stringify(parentScope)}\n  child=${JSON.stringify(childScope)}`
          );
        }
        expect(result.ok).toBe(false);
      }
    }
  });

  // --- Comprehensive generated fuzz: validateNarrowing ok:true ⟺ isNarrowerOrEqual ---

  it("FUZZ comprehensive: validateNarrowing(ok=true) ⟺ isNarrowerOrEqual (seeded pairs)", () => {
    const rng = makeLcg(0xDEADF00D);
    // Only use scope elements (not freeform) to test the core invariant
    const scopePool = SCOPE_POOL; // excludes freeform
    let leakCount = 0;

    for (let i = 0; i < 500; i++) {
      const parentScope = pick(scopePool, rng);
      const childScope = pick(scopePool, rng);
      const parent = makeGrant(parentScope, { delegable: true });
      const child = makeGrant(childScope, { delegable: true });

      const expectedNarrow = isNarrowerOrEqual(childScope, parentScope, oracle);
      const result = validateNarrowing(parent, child, oracle);

      if (!expectedNarrow && result.ok) {
        leakCount++;
        throw new Error(
          `WIDENING LEAK: validateNarrowing returned ok=true but isNarrowerOrEqual=false!\n  parent.scope=${JSON.stringify(parentScope)}\n  child.scope=${JSON.stringify(childScope)}\n  isNarrowerOrEqual=${expectedNarrow}\n  result=${JSON.stringify(result)}`
        );
      }

      if (!expectedNarrow) {
        expect(result.ok).toBe(false);
      }
      // If expectedNarrow=true, result should be ok:true (no false rejections either)
      if (expectedNarrow) {
        if (!result.ok) {
          // This is a false rejection — not a security issue but correctness issue
          // Only flag if it's not a tooling gap
          // (scope ⊑ parent but validateNarrowing rejects for some non-scope reason — shouldn't happen
          //  since we don't set facet/constraint/delegable mismatches here)
        }
        expect(result.ok).toBe(true);
      }
    }
    expect(leakCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// INVARIANT 5: BOTTOM edge cases
// ---------------------------------------------------------------------------

describe("ADVERSARIAL: BOTTOM / degenerate edge cases", () => {
  it("⊥ ⊑ X for all generated X (vacuous)", () => {
    const rng = makeLcg(0xAA55AA55);
    for (let i = 0; i < 100; i++) {
      const x = pick(SCOPE_POOL, rng);
      expect(isNarrowerOrEqual(BOTTOM, x, oracle)).toBe(true);
    }
  });

  it("non-empty X ⋢ ⊥ for all generated non-empty X", () => {
    for (const x of SCOPE_POOL) {
      if (isBottom(x)) continue;
      expect(isNarrowerOrEqual(x, BOTTOM, oracle)).toBe(false);
    }
  });

  it("meet(X, X) = X up to ⊑-equivalence (idempotent meet)", () => {
    for (const x of SCOPE_POOL) {
      const m = meet(x, x, oracle);
      // m ⊑ x and x ⊑ m (they should be equivalent)
      expect(isNarrowerOrEqual(m, x, oracle)).toBe(true);
      expect(isNarrowerOrEqual(x, m, oracle)).toBe(true);
    }
  });

  it("validateNarrowing with BOTTOM child is always ok:true (BOTTOM is narrowest)", () => {
    const latticeParents: ScopeElement[] = [
      node("root"), node("a"), node("a1"),
      tags("p", "q"), interval(0, 100),
      setOf(node("a") as AtomElement, tags("p") as AtomElement),
    ];
    for (const ps of latticeParents) {
      const parent = makeGrant(ps, { delegable: true });
      const child = makeGrant(BOTTOM, { delegable: true });
      const result = validateNarrowing(parent, child, oracle);
      if (!result.ok) {
        throw new Error(
          `BOTTOM child rejected by delegable parent!\n  parent.scope=${JSON.stringify(ps)}\n  result=${JSON.stringify(result)}`
        );
      }
      expect(result.ok).toBe(true);
    }
  });

  it("empty tag set normalizes to BOTTOM behavior (no tags = unreachable)", () => {
    // tags([]) — no tags means nothing matches → effectively ⊥
    const emptyTags = tags();
    // ⊥ ⊑ emptyTags? Let's check:
    // emptyTags is { kind: "tags", tags: [] }
    // isNarrowerOrEqual(BOTTOM, emptyTags) = true (BOTTOM ⊑ everything)
    expect(isNarrowerOrEqual(BOTTOM, emptyTags, oracle)).toBe(true);
    // emptyTags ⊑ tags("p")? tags:[] ⊆ tags:["p"] = true (empty set ⊆ any set)
    expect(isNarrowerOrEqual(emptyTags, tags("p"), oracle)).toBe(true);
    // tags("p") ⊑ emptyTags? tags:["p"] ⊆ tags:[] = false
    expect(isNarrowerOrEqual(tags("p"), emptyTags, oracle)).toBe(false);
  });

  it("degenerate interval [n,n] (point interval) is valid", () => {
    const point = interval(50, 50);
    // A point interval is ⊑ a containing interval
    expect(isNarrowerOrEqual(point, interval(0, 100), oracle)).toBe(true);
    // And is NOT ⊑ a non-containing interval
    expect(isNarrowerOrEqual(point, interval(60, 100), oracle)).toBe(false);
    // And is ⊑ itself
    expect(isNarrowerOrEqual(point, point, oracle)).toBe(true);
  });

  it("cross-hierarchy nodes are always incomparable (resource vs org)", () => {
    const resourceNode: ScopeElement = { kind: "node", hierarchy: "resource", nodeId: "a", nodeLevel: "application" };
    const orgNode: ScopeElement = { kind: "node", hierarchy: "org", nodeId: "a", nodeLevel: "department" };
    expect(isNarrowerOrEqual(resourceNode, orgNode, oracle)).toBe(false);
    expect(isNarrowerOrEqual(orgNode, resourceNode, oracle)).toBe(false);
    // meet is ⊥
    expect(isBottom(meet(resourceNode, orgNode, oracle))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INVARIANT 6: validateNarrowing correctness — ok:true exactly when ⊑ holds
// (whitebox equivalence check over all non-freeform pool pairs)
// ---------------------------------------------------------------------------

describe("ADVERSARIAL: validateNarrowing ↔ isNarrowerOrEqual equivalence (whitebox)", () => {
  it("for all delegable, non-freeform pool pairs: ok ↔ isNarrowerOrEqual", () => {
    let leakFound = false;
    let leakInput = "";

    for (const ps of SCOPE_POOL) {
      for (const cs of SCOPE_POOL) {
        const parent = makeGrant(ps, { delegable: true });
        const child = makeGrant(cs, { delegable: true });
        const expected = isNarrowerOrEqual(cs, ps, oracle);
        const result = validateNarrowing(parent, child, oracle);

        if (!expected && result.ok) {
          leakFound = true;
          leakInput = `parent=${JSON.stringify(ps)} child=${JSON.stringify(cs)}`;
        }
        if (expected && !result.ok) {
          // False rejection — correctness bug (not security, but record it)
          // Note: only a defect if no other reason applies (facet/constraint are absent here)
        }

        if (!expected) expect(result.ok).toBe(false);
        if (expected) expect(result.ok).toBe(true);
      }
    }

    if (leakFound) {
      throw new Error(`WIDENING LEAK FOUND: ${leakInput}`);
    }
    expect(leakFound).toBe(false);
  });
});
