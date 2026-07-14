/**
 * src/http/seed-ancestry.ts — shared seed-based AncestryOracle for HTTP handlers.
 *
 * HISTORICAL (T-0053 day-1 gap, NOW SUPERSEDED for production by T-0515):
 * org ancestry used to be backed ONLY by a hardcoded tree (ORG_ANCESTRY_MAP)
 * mirroring the dev-seed departments (slugs from ORG_TREE + UUIDs from migration
 * 014/026). That oracle answered correctly ONLY for tenants whose org structure
 * matched the seed topology — a production/self-registered tenant with its own
 * department tree got WRONG ancestry answers, silently corrupting grant-scope
 * and admin-delegation checks for org-node scopes.
 *
 * T-0515 FIX: HTTP handlers now build a per-request oracle from the tenant's
 * REAL choros.department tree via `loadTenantOrgAncestry(pool, tenantId)`
 * (src/db/org-ancestry.ts) and pass THAT to the validate-/covers-/isNarrower-
 * calls. SEED_ORACLE is retained ONLY as a pure, DB-free fallback/fixture (its
 * map mirrors the dev-seed and is used by unit tests that inject an oracle); it
 * is no longer the source of truth in production handlers.
 *
 * The shared traversal (`makeOrgAncestryOracle`) is the SINGLE walk used by both
 * SEED_ORACLE and the DB-backed oracle — they differ ONLY in the children map
 * source, so containment semantics are byte-for-byte identical.
 */

import type { AncestryOracle, Hierarchy } from "../core/grant-lattice.js";

// ---------------------------------------------------------------------------
// Shared traversal — pure walk over an injected adjacency map (ancestor → children)
// ---------------------------------------------------------------------------

/**
 * makeOrgAncestryOracle — build a synchronous AncestryOracle from a children map.
 *
 * `children[ancestorId]` lists the DIRECT children (department ids/slugs) of
 * `ancestorId`. The oracle answers `isDescendantOrSelf(_, descendantId,
 * ancestorId)` by a depth-first descent from `ancestorId` looking for
 * `descendantId`:
 *   - descendantId === ancestorId           → true  (self).
 *   - descendantId reachable via the chain   → true  (containment).
 *   - unknown ids / no path                  → false (conservative).
 * Cycle-safe via a visited set (defends against a malformed/cyclic map).
 *
 * The `hierarchy` param is preserved for interface-compat but the org tree is
 * the only hierarchy this map models (resource hierarchy is handled elsewhere,
 * unchanged). The walk is hierarchy-agnostic — callers pass the org map.
 */
export function makeOrgAncestryOracle(
  children: ReadonlyMap<string, readonly string[]> | Record<string, readonly string[]>,
): AncestryOracle {
  const get = (id: string): readonly string[] => {
    if (children instanceof Map) return children.get(id) ?? [];
    return (children as Record<string, readonly string[]>)[id] ?? [];
  };

  function descend(descendantId: string, ancestorId: string, visited: Set<string>): boolean {
    if (descendantId === ancestorId) return true;
    if (visited.has(ancestorId)) return false;
    visited.add(ancestorId);
    for (const c of get(ancestorId)) {
      if (descend(descendantId, c, visited)) return true;
    }
    return false;
  }

  return {
    isDescendantOrSelf(_hierarchy: Hierarchy, descendantId: string, ancestorId: string): boolean {
      return descend(descendantId, ancestorId, new Set<string>());
    },
  };
}

// ---------------------------------------------------------------------------
// Seed org-tree (slug + UUID nodes from migrations 014/026 + ORG_TREE ra-data)
// ---------------------------------------------------------------------------

/**
 * Known-gap fixture: mirrors only the dev-seed org topology.
 * NOT the source of truth in production handlers (T-0515) — those build the
 * oracle from the real department tree. Kept for DB-free unit tests/fallback.
 */
const ORG_ANCESTRY_MAP: Record<string, string[]> = {
  org: ["fin", "cs", "plat", "sales"],
  fin: ["fin-calc", "fin-approve", "fin-treasury"],
  cs: ["cs-l1", "cs-l2"],
  sales: ["sales-smb", "sales-ent"],
  // UUID forest root departments (migration 014/026 seed):
  "b0000000-0000-0000-0000-000000000001": [], // fin dept
  "b0000000-0000-0000-0000-000000000002": [], // cs dept
  "b0000000-0000-0000-0000-000000000003": [], // plat dept
};

/**
 * Shared seed-based AncestryOracle — DB-free fixture.
 *
 * Production handlers now build the oracle from the tenant's real department
 * tree via loadTenantOrgAncestry (T-0515). This export remains for unit tests
 * and as a pure fallback; it uses the SAME traversal as the DB-backed oracle.
 */
export const SEED_ORACLE: AncestryOracle = makeOrgAncestryOracle(ORG_ANCESTRY_MAP);
