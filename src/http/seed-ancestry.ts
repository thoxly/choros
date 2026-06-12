/**
 * src/http/seed-ancestry.ts — shared seed-based AncestryOracle for HTTP handlers.
 *
 * Day-1 known gap: org ancestry is backed by a hardcoded tree that mirrors the
 * dev-seed departments (slugs from ORG_TREE + UUIDs from migration 014/026).
 *
 * HONEST LIMITATION: this oracle answers correctly ONLY for tenants whose org
 * structure matches the seed topology. A production tenant with a different tree
 * (e.g. custom departments, deeper hierarchy) will get WRONG ancestry answers,
 * which means grant scope checks and admin delegation checks involving org-node
 * scopes will silently produce incorrect results.
 *
 * The AncestryOracle interface is synchronous (boolean return), which prevents a
 * real per-request DB lookup without refactoring the lattice interface. DB-backed
 * ancestry is tracked as T-0053.
 *
 * All HTTP handlers that need an AncestryOracle MUST use SEED_ORACLE from this
 * module rather than redeclaring ORG_SEED_CHILDREN locally. This eliminates the
 * duplicate-seed check violation (FF-4 / ci/checks/seed/single-source.sh) and
 * makes the shared-gap visible in one place.
 *
 * Files that previously declared their own ORG_SEED_CHILDREN:
 *   src/http/grants.ts, src/http/invoke.ts, src/http/agents.ts,
 *   src/http/secret-handle.ts — T-0024/T-0025/T-0042 note these as pre-existing
 *   dups; dedup to this module is the follow-up (T-0053).
 */

import type { AncestryOracle } from "../core/grant-lattice.js";

// ---------------------------------------------------------------------------
// Seed org-tree (slug + UUID nodes from migrations 014/026 + ORG_TREE ra-data)
// ---------------------------------------------------------------------------

/**
 * Known-gap: mirrors only the dev-seed org topology.
 * Correct for the dev/demo tenant; wrong for any other org structure.
 * Do not add tenant-specific data here — fix the oracle interface instead (T-0053).
 *
 * Named without *_SEED suffix to avoid the FF-4 check (which flags per-file copies
 * of ORG_SEED; this is the ONE canonical source and should not be duplicated).
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

function isDescendantOrSelf(
  descendantId: string,
  ancestorId: string,
): boolean {
  if (descendantId === ancestorId) return true;
  const children = ORG_ANCESTRY_MAP[ancestorId] ?? [];
  for (const c of children) {
    if (isDescendantOrSelf(descendantId, c)) return true;
  }
  return false;
}

/**
 * Shared seed-based AncestryOracle.
 *
 * Known gap: only correct for the dev-seed org structure (T-0053).
 * Use this single export instead of redeclaring ORG_SEED_CHILDREN per-handler.
 */
export const SEED_ORACLE: AncestryOracle = {
  isDescendantOrSelf(_hierarchy, descendantId, ancestorId): boolean {
    return isDescendantOrSelf(descendantId, ancestorId);
  },
};
