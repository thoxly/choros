/**
 * src/db/resource-ancestry.ts — T-0570 (D3): composite resource-ancestry oracle.
 *
 * CLOSES THE GAP the T-0570 spec/ADR §1.1/§2.1 name explicitly: the
 * `AncestryOracle` actually wired in production for `hierarchy:"resource"`
 * scopes (`makeOrgAncestryOracle`, src/http/seed-ancestry.ts) IGNORES the
 * `hierarchy` param and only ever walks the org (department) adjacency map —
 * it has no notion of the record→registry_def→application resource chain. A
 * grant scoped `{kind:"node", hierarchy:"resource", nodeLevel:"application",
 * nodeId:X}` therefore could NOT cover a record node today: the oracle would
 * answer `false` for `isDescendantOrSelf("resource", recordId, X)` no matter
 * what X is (org map has no resource ids in it).
 *
 * THIS MODULE builds a COMPOSITE oracle:
 *   - `hierarchy === "org"`      → delegates to the injected org oracle
 *                                  UNCHANGED (no semantic change to org checks).
 *   - `hierarchy === "resource"` → answers via TWO rules, in order:
 *       1. self:                    descendantId === ancestorId            → true
 *       2. root sentinel:           ancestorId === RESOURCE_ROOT_NODE_ID   → true
 *          (O(1) — "the resource root covers every resource node in this
 *          tenant's tree"; this is what makes the single default-open READ
 *          grant, scoped at the root, cover every record without a per-tenant
 *          ancestry map load.)
 *       3. otherwise: climb the descendant's `record → registry → application`
 *          chain (read INLINE from the already-selected page's `rowIndex` — no
 *          extra DB round-trip per row, NF-1) and check whether `ancestorId`
 *          appears anywhere on that chain. This is what lets a FUTURE narrower
 *          grant (scoped at a specific registry or application node) cover a
 *          record without a bespoke oracle rewrite (FR-3 sujenie-as-config).
 *
 * `refToScope` in grant-resolver.ts is UNCHANGED (record → record-node scope);
 * this oracle is the ONLY new code — containment still runs through the frozen
 * `isNarrowerOrEqual` (grant-lattice.ts). No new lattice kind, no second
 * containment math (NF-5 / FF-RP-8).
 *
 * Pure composition function — no pg import, no network here; `orgOracle` and
 * `rowIndex` are both supplied by the caller (records.ts composition point),
 * which is where the one DB round-trip (org ancestry load) and the in-memory
 * page-derived rowIndex are actually built.
 */

import type { AncestryOracle, Hierarchy } from "../core/grant-lattice.js";
import { RESOURCE_ROOT_NODE_ID, type RowAncestry } from "../core/read-visibility.js";

/**
 * Build the composite `hierarchy:"resource"`+`hierarchy:"org"` AncestryOracle.
 *
 * @param orgOracle  The existing org-hierarchy oracle (e.g.
 *                   `loadTenantOrgAncestry(pool, tenantId)`), delegated to
 *                   UNCHANGED for `hierarchy === "org"` queries.
 * @param rowIndex   Per-request map `recordId → { registryId, applicationId }`
 *                   built from the ALREADY-SELECTED page of records.ts (the
 *                   SELECT already carries `r.registry_id` / `rd.application_id`
 *                   per row) — never a separate query per row (NF-1). A record id
 *                   absent from `rowIndex` (never selected this request) yields
 *                   `false` for any non-root, non-self ancestor query — this
 *                   oracle only ever answers about rows the caller actually loaded.
 */
export function makeResourceAncestryOracle(
  orgOracle: AncestryOracle,
  rowIndex: ReadonlyMap<string, RowAncestry>,
): AncestryOracle {
  return {
    isDescendantOrSelf(
      hierarchy: Hierarchy,
      descendantId: string,
      ancestorId: string,
    ): boolean {
      if (hierarchy === "org") {
        return orgOracle.isDescendantOrSelf(hierarchy, descendantId, ancestorId);
      }

      // hierarchy === "resource"
      // Rule 1: self.
      if (descendantId === ancestorId) return true;
      // Rule 2: root sentinel — O(1) "covers everything in the resource tree".
      if (ancestorId === RESOURCE_ROOT_NODE_ID) return true;
      // Rule 3: climb the inline record → registry → application chain.
      const row = rowIndex.get(descendantId);
      if (row === undefined) return false;
      if (row.registryId === ancestorId) return true;
      if (row.applicationId === ancestorId) return true;
      return false;
    },
  };
}
