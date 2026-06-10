/**
 * T-0018: Closed Scope-Lattice Algebra — pure TS, no DB/IO/LLM.
 *
 * Implements the grant authority table type mirror + the (S, ⊑, ⊓, ⊥) lattice
 * over four element kinds: hierarchy-node, tag-set, numeric-interval, scope-set.
 *
 * The partial order ⊑ is structural, decidable, and total; the meet ⊓ is closed.
 * Together they power the write-time subset gate (validateNarrowing) that makes
 * monotonic narrowing provable and self-elevation structurally impossible.
 *
 * Semantic contract: §4.2–4.5 of docs/design/T-0018-grant-authority.adr.md.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Hierarchy = "resource" | "org";
export type NodeLevel =
  | "application"
  | "registry"
  | "record"
  | "department"
  | "position";
export type Operation =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "approve"
  | "transition"
  | "invoke";
export type ResourceType =
  | "application"
  | "registry"
  | "record"
  | `mgmt_object:${string}`
  | "effect_resource";

/**
 * The four admissible element kinds of the closed delegable scope lattice.
 */
export type ScopeElement =
  | { kind: "node"; hierarchy: Hierarchy; nodeId: string; nodeLevel: NodeLevel }
  | { kind: "tags"; tags: string[] }
  | { kind: "interval"; axis: string; lo: number; hi: number }
  | { kind: "set"; members: AtomElement[] };

/** A set's members are never sets themselves (flattened). */
export type AtomElement = Exclude<ScopeElement, { kind: "set" }>;

/** A free-form predicate scope — outside the lattice, owner-only, non-delegable. */
export type FreeformScope = { kind: "freeform"; predicate: string };

/** Delegable grant scope (always a lattice element). */
export type Scope = ScopeElement;

/** A grant's scope field: lattice element for delegable grants, or free-form for owner-only. */
export type GrantScope = ScopeElement | FreeformScope;

/** TypeScript mirror of the `grant` authority table row (FR-2). */
export interface Grant {
  tenantId: string;
  id: string;
  roleId: string;
  resourceType: ResourceType;
  resourceFacet?: unknown;
  operation: Operation;
  scope: GrantScope;
  constraint?: unknown;
  delegable: boolean;
  grantedBy: string;
  validFrom?: number;
  validUntil?: number;
  createdAt: number;
}

/**
 * Injected hierarchy fact — pure, no DB.
 * isDescendantOrSelf(h, a, b) = true iff a is b or a is a descendant of b in hierarchy h.
 */
export interface AncestryOracle {
  isDescendantOrSelf(
    hierarchy: Hierarchy,
    descendantId: string,
    ancestorId: string,
  ): boolean;
}

/** GrantAuditEvent — the obligation shape every create/revoke site MUST emit (FR-7). */
export type GrantAuditEvent = {
  kind: "grant.create" | "grant.revoke";
  actor: string;
  subjectRoleId: string;
  capability: { resourceType: string; operation: string; resourceFacet?: unknown };
  scope: Scope;
  proposedBy?: string;
  confirmedBy?: string;
};

// ---------------------------------------------------------------------------
// Canonical bottom ⊥ — the empty scope-set; denotes zero reach.
// ---------------------------------------------------------------------------

/** Canonical ⊥ (bottom): the empty scope-set. Confers no authority. */
export const BOTTOM: ScopeElement = Object.freeze({
  kind: "set" as const,
  members: [] as AtomElement[],
});

/** Returns true iff s is the bottom element (empty scope-set). */
export function isBottom(s: ScopeElement): boolean {
  return s.kind === "set" && s.members.length === 0;
}

// ---------------------------------------------------------------------------
// normalize — canonical form (NF-5), idempotent
// ---------------------------------------------------------------------------

/**
 * Bring a ScopeElement into canonical form:
 *  - interval: ensure lo ≤ hi (swap if reversed)
 *  - tags: sort + de-duplicate
 *  - set: flatten (no nested sets), de-duplicate members, drop ⊑-redundant members
 *
 * Idempotent: normalize(normalize(s)) deep-equals normalize(s).
 * Callers invoke this at write-time; ⊑/⊓ assume canonical inputs.
 */
export function normalize(s: ScopeElement): ScopeElement {
  switch (s.kind) {
    case "node":
      // Nodes have no internal ordering to normalize; return as-is (structurally immutable).
      return { kind: "node", hierarchy: s.hierarchy, nodeId: s.nodeId, nodeLevel: s.nodeLevel };

    case "tags": {
      const sorted = [...new Set(s.tags)].sort();
      return { kind: "tags", tags: sorted };
    }

    case "interval": {
      const lo = Math.min(s.lo, s.hi);
      const hi = Math.max(s.lo, s.hi);
      return { kind: "interval", axis: s.axis, lo, hi };
    }

    case "set": {
      // Step 1: flatten — if any member is itself a set, splice its members in.
      const flat: AtomElement[] = flattenSetMembers(s.members);

      // Step 2: normalize each atom member.
      const normalized: AtomElement[] = flat.map((m) => normalizeAtom(m));

      // Step 3: drop ⊑-redundant members.
      // If m1 ⊑ m2 (m1 narrower), drop m1 (m2 already covers at least m1's reach).
      // We use a null-oracle because redundancy within the set only applies to same-kind
      // elements whose ⊑ relationship doesn't require ancestry info — and for node elements
      // we conservatively retain both (the oracle isn't available at normalize time).
      // A safe redundancy check: m1 redundant if there exists m2 ≠ m1 with m1 ⊑ m2
      // using a no-op oracle (which only resolves same-id nodes as equal).
      const noOpOracle: AncestryOracle = {
        isDescendantOrSelf: (_h, a, b) => a === b,
      };
      const nonRedundant = dropRedundant(normalized, noOpOracle);

      if (nonRedundant.length === 0) {
        return BOTTOM;
      }
      return { kind: "set", members: nonRedundant };
    }
  }
}

/** Normalize an AtomElement (never a set). */
function normalizeAtom(a: AtomElement): AtomElement {
  const n = normalize(a as ScopeElement);
  // normalize of a non-set element is always an AtomElement
  return n as AtomElement;
}

/**
 * Flatten set members: if any member is itself a set (shouldn't happen in canonical form,
 * but may appear in raw input), splice its members in recursively.
 */
function flattenSetMembers(members: AtomElement[]): AtomElement[] {
  const result: AtomElement[] = [];
  for (const m of members) {
    // AtomElement excludes "set", so no nested set is possible via types.
    // The cast handles legacy/raw inputs.
    const raw = m as ScopeElement;
    if (raw.kind === "set") {
      const inner = flattenSetMembers((raw as { kind: "set"; members: AtomElement[] }).members);
      result.push(...inner);
    } else {
      result.push(m);
    }
  }
  return result;
}

/**
 * Drop members that are ⊑-redundant given an oracle.
 * Member m is redundant if there exists m2 in the array with m ⊑ m2 and m !== m2.
 */
function dropRedundant(members: AtomElement[], oracle: AncestryOracle): AtomElement[] {
  return members.filter((m, i) => {
    for (let j = 0; j < members.length; j++) {
      if (i === j) continue;
      const other = members[j]!;
      if (atomIsNarrowerOrEqual(m, other as ScopeElement, oracle) &&
          !atomIsNarrowerOrEqual(other as ScopeElement, m, oracle)) {
        // m ⊑ other and other ⋢ m: m is strictly narrower — drop m
        return false;
      }
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// isNarrowerOrEqual — the partial order ⊑ (structural, decidable, total)
// ---------------------------------------------------------------------------

/**
 * isNarrowerOrEqual(child, parent, oracle) — the ⊑ partial order.
 *
 * Returns true iff the child's reach is a subset of the parent's reach.
 * Always returns a boolean — never throws, never "unknown" (AC-3).
 * ⊥ ⊑ anything = true (empty set; vacuously every member contained).
 * anything ⊑ ⊥ (nonempty) = false.
 */
export function isNarrowerOrEqual(
  child: ScopeElement,
  parent: ScopeElement,
  oracle: AncestryOracle,
): boolean {
  // ⊥ ⊑ anything
  if (isBottom(child)) return true;
  // anything ⊑ ⊥ (non-empty child cannot fit in empty parent)
  if (isBottom(parent)) return false;

  // Case: child is a set — every member must be ⊑ parent
  if (child.kind === "set") {
    return child.members.every((m) =>
      isNarrowerOrEqual(m as ScopeElement, parent, oracle),
    );
  }

  // Case: parent is a set — child must fit inside at least one member
  if (parent.kind === "set") {
    return parent.members.some((m) =>
      isNarrowerOrEqual(child, m as ScopeElement, oracle),
    );
  }

  // Both are atoms — delegate to atom comparison
  return atomIsNarrowerOrEqual(child, parent, oracle);
}

/**
 * Atom-to-atom ⊑ (neither side is a set; both are non-⊥).
 * Cross-kind (non-set) ⇒ false.
 */
function atomIsNarrowerOrEqual(
  child: ScopeElement,
  parent: ScopeElement,
  oracle: AncestryOracle,
): boolean {
  if (child.kind === "node" && parent.kind === "node") {
    if (child.hierarchy !== parent.hierarchy) return false;
    return oracle.isDescendantOrSelf(child.hierarchy, child.nodeId, parent.nodeId);
  }

  if (child.kind === "tags" && parent.kind === "tags") {
    // child.tags ⊆ parent.tags
    const parentSet = new Set(parent.tags);
    return child.tags.every((t) => parentSet.has(t));
  }

  if (child.kind === "interval" && parent.kind === "interval") {
    if (child.axis !== parent.axis) return false;
    return parent.lo <= child.lo && child.hi <= parent.hi;
  }

  // Cross-kind non-set: incomparable
  return false;
}

// ---------------------------------------------------------------------------
// meet — greatest lower bound ⊓ (closed)
// ---------------------------------------------------------------------------

/**
 * meet(x, y, oracle) — greatest lower bound ⊓.
 *
 * Result is always a valid ScopeElement (node/tags/interval/set/⊥) — never throws.
 * Closed: the result is an admissible element (AC-7).
 */
export function meet(
  x: ScopeElement,
  y: ScopeElement,
  oracle: AncestryOracle,
): ScopeElement {
  // ⊥ ⊓ anything = ⊥
  if (isBottom(x) || isBottom(y)) return BOTTOM;

  // set ⊓ X = pairwise meets with ⊥ members dropped
  if (x.kind === "set") {
    const results: AtomElement[] = [];
    for (const m of x.members) {
      const r = meet(m as ScopeElement, y, oracle);
      if (!isBottom(r)) {
        results.push(r as AtomElement);
      }
    }
    if (results.length === 0) return BOTTOM;
    if (results.length === 1) return results[0]!;
    return normalize({ kind: "set", members: results });
  }

  if (y.kind === "set") {
    const results: AtomElement[] = [];
    for (const m of y.members) {
      const r = meet(x, m as ScopeElement, oracle);
      if (!isBottom(r)) {
        results.push(r as AtomElement);
      }
    }
    if (results.length === 0) return BOTTOM;
    if (results.length === 1) return results[0]!;
    return normalize({ kind: "set", members: results });
  }

  // Both atoms
  return atomMeet(x, y, oracle);
}

/**
 * Atom-to-atom meet (neither side is a set or ⊥).
 */
function atomMeet(
  x: ScopeElement,
  y: ScopeElement,
  oracle: AncestryOracle,
): ScopeElement {
  if (x.kind === "node" && y.kind === "node") {
    if (x.hierarchy !== y.hierarchy) return BOTTOM;
    // If one is ancestor of the other, the descendant is the meet
    if (oracle.isDescendantOrSelf(x.hierarchy, x.nodeId, y.nodeId)) {
      // x is descendant-or-equal of y → x is the smaller subtree
      return x;
    }
    if (oracle.isDescendantOrSelf(x.hierarchy, y.nodeId, x.nodeId)) {
      // y is descendant-or-equal of x → y is the smaller subtree
      return y;
    }
    // Disjoint subtrees
    return BOTTOM;
  }

  if (x.kind === "tags" && y.kind === "tags") {
    const xSet = new Set(x.tags);
    const intersection = y.tags.filter((t) => xSet.has(t));
    if (intersection.length === 0) return BOTTOM;
    return { kind: "tags", tags: intersection.sort() };
  }

  if (x.kind === "interval" && y.kind === "interval") {
    if (x.axis !== y.axis) return BOTTOM;
    const lo = Math.max(x.lo, y.lo);
    const hi = Math.min(x.hi, y.hi);
    if (lo > hi) return BOTTOM;
    return { kind: "interval", axis: x.axis, lo, hi };
  }

  // Distinct non-set kinds: ⊥
  return BOTTOM;
}

// ---------------------------------------------------------------------------
// validateNarrowing — the FR-5 write-time subset gate
// ---------------------------------------------------------------------------

/** Typed rejection reasons for the write-time narrowing gate. */
export type NarrowingResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "scope_widens"
        | "facet_widens"
        | "constraint_widens"
        | "parent_non_delegable"
        | "free_form_non_delegable";
    };

/**
 * validateNarrowing(parent, child, oracle) — FR-5 write-time gate.
 *
 * Pre-persistence check. Never mutates, never persists.
 * Accept iff all hold:
 *  1. parent.delegable === true
 *  2. parent.scope is not a free-form predicate
 *  3. isNarrowerOrEqual(child.scope, parent.scope) === true
 *  4. child.resourceFacet and child.constraint do not widen the parent's
 *
 * A freeform parent ⇒ free_form_non_delegable (before inspecting child).
 */
export function validateNarrowing(
  parent: Grant,
  child: Grant,
  oracle: AncestryOracle,
): NarrowingResult {
  // Gate 1: parent must be delegable
  if (!parent.delegable) {
    return { ok: false, reason: "parent_non_delegable" };
  }

  // Gate 2: parent scope must not be free-form
  if (parent.scope.kind === "freeform") {
    return { ok: false, reason: "free_form_non_delegable" };
  }

  // Also: if child scope is free-form, it cannot be delegated into a chain
  // (child free-form with a non-free-form parent: free-form child scope cannot
  // be subset of any lattice scope — isNarrowerOrEqual is false for it)
  if (child.scope.kind === "freeform") {
    return { ok: false, reason: "scope_widens" };
  }

  // Gate 3: child.scope ⊑ parent.scope
  const parentScope = parent.scope as ScopeElement;
  const childScope = child.scope as ScopeElement;

  if (!isNarrowerOrEqual(childScope, parentScope, oracle)) {
    return { ok: false, reason: "scope_widens" };
  }

  // Gate 4a: facet narrowing check
  // Conservative rule (§7 open item):
  //   - child absent, parent absent → ok (no narrowing needed)
  //   - child absent, parent present → ok (child has no facet = no narrowing applied; whole-resource access within scope)
  //     Actually: "absent ⇒ whole-resource". A child WITHOUT a facet is WIDER than a parent WITH a facet.
  //     Wait — let's re-read: "a facet only ever narrows". Parent has a facet means parent is restricted.
  //     Child without a facet = unrestricted = wider. So child absent & parent present = WIDENS.
  //   - child present, parent absent → ok (child narrows relative to whole-resource parent)
  //   - child present, parent present → must be equal or structurally narrower (conservative: equal)
  //
  // §7 conservative default: "a present parent facet requires an equal/absent-or-subset child"
  // Re-reading ADR §7: "a present child facet under an absent parent facet narrows (ok),
  //   and a present parent facet requires an equal/absent-or-subset child"
  // So: child.facet absent + parent.facet present = child is WIDER (facet_widens)
  const parentFacet = parent.resourceFacet;
  const childFacet = child.resourceFacet;

  if (parentFacet !== undefined && parentFacet !== null) {
    if (childFacet === undefined || childFacet === null) {
      // Child has no facet restriction but parent does → child is wider
      return { ok: false, reason: "facet_widens" };
    }
    // Both present: conservative check — must be deeply equal
    if (!deepEqual(childFacet, parentFacet)) {
      return { ok: false, reason: "facet_widens" };
    }
  }
  // parent facet absent: child facet present → ok (narrows), child absent → ok (equal)

  // Gate 4b: constraint narrowing check
  // §7 conservative default: delegable grants carry no constraint beyond the lattice.
  // validateNarrowing treats a child constraint not absent-or-equal-to-parent as constraint_widens.
  const parentConstraint = parent.constraint;
  const childConstraint = child.constraint;

  if (parentConstraint !== undefined && parentConstraint !== null) {
    if (childConstraint === undefined || childConstraint === null) {
      // Parent has a constraint, child doesn't → child is wider (no constraint applied)
      return { ok: false, reason: "constraint_widens" };
    }
    if (!deepEqual(childConstraint, parentConstraint)) {
      return { ok: false, reason: "constraint_widens" };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// isEffective — validity-window helper (AC-13)
// ---------------------------------------------------------------------------

/**
 * isEffective(grant, nowMs) — the single place validity is decided.
 *
 * Returns true iff the grant is within its validity window at nowMs.
 * (validFrom == null || now >= validFrom) && (validUntil == null || now < validUntil)
 * An out-of-window grant confers zero capability.
 */
export function isEffective(grant: Grant, nowMs: number): boolean {
  const fromOk = grant.validFrom === undefined || nowMs >= grant.validFrom;
  const untilOk = grant.validUntil === undefined || nowMs < grant.validUntil;
  return fromOk && untilOk;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Structural deep equality (JSON-comparable values only; used for facet/constraint checks). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length) return false;
  if (!aKeys.every((k, i) => k === bKeys[i])) return false;
  return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
}
