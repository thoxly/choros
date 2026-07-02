/**
 * src/core/read-visibility.ts — T-0570 (D3): READ-path record-visibility gate.
 *
 * PURE, IO-FREE. No import from pg, http, https, net, fetch, fs, child_process,
 * grant-resolver.ts (no circular import — this module is a NEW leaf the resolver
 * seam wires in, not a rewrite of it). Mirrors the purity discipline of
 * sandbox-gate.ts / field-visibility.ts / data-classification.ts.
 *
 * THE PROBLEM (LIMITATION-018, spec §0): `GET /api/records` and
 * `GET /api/records/:id` filter ONLY by tenant-RLS + sandbox/draft-tier gate —
 * neither resolves a READ grant on the individual record ROW. This module is the
 * checkpoint that closes that gap: it decides, for one already-loaded row, at
 * one instant, over an already-resolved grant set, whether the row is readable.
 *
 * THE DECISION (ADR §2.3/§4.3): `isRecordReadable` mirrors the EXACT containment
 * predicate `resolveFor` already uses for actions (grant-resolver.ts:589-607) —
 * `grants.some(g => g.operation==="read" && isEffective(g,nowMs) &&
 * isLatticeScope(g.scope) && isNarrowerOrEqual(recordResourceScope(row.recordId),
 * g.scope, ancestry))`. This is NOT a second authority math (NF-5): it calls the
 * SAME `isNarrowerOrEqual`/`isEffective` from grant-lattice.ts (frozen, only
 * imported) over the SAME `Grant[]` shape the rest of the PDP resolves.
 *
 * THE ROOT SENTINEL (ADR §2.1): `RESOURCE_ROOT_NODE_ID` is a single, platform-wide
 * constant `nodeId` at `nodeLevel:"application"` that the composite resource-
 * ancestry oracle (src/db/resource-ancestry.ts) treats as "covers every resource
 * node in this tenant's resource tree" — an O(1) rule, no per-tenant ancestry map
 * needed for the default-open grant. It is NOT a hardcoded tenant UUID (FF-RP-6/
 * FF-RP-7 anti-case): differentiation across tenants is done by RLS + the explicit
 * tenant filter on the record SELECT (NF-3), never by this nodeId.
 *
 * NOT IMPORTED: pg, fs, net, http, node:crypto, process.env, grant-resolver.ts,
 * data-classification.ts, object-handle.ts (no circular dependency, no second
 * authority path — FR-7 / NF-5).
 */

import {
  type Grant,
  type ScopeElement,
  type AncestryOracle,
  isNarrowerOrEqual,
  isEffective,
} from "./grant-lattice.js";

// ---------------------------------------------------------------------------
// Platform constants (NF-4 anti-case: NOT case-specific role/slug/persona strings)
// ---------------------------------------------------------------------------

/**
 * Sentinel node id for the tenant-wide "root of the resource hierarchy" — the
 * scope a default-open READ grant targets. ONE value shared by every tenant
 * (ADR §2.1/§2.2): differentiation across tenants is RLS + the explicit
 * `tenant_id` filter on the record SELECT, never this nodeId (NF-3).
 *
 * `nodeLevel:"application"` so it type-checks as an existing NodeLevel (no new
 * lattice kind, FF-RP-8) — the composite resource-ancestry oracle special-cases
 * this exact id at rule 2 (`isDescendantOrSelf("resource", d, RESOURCE_ROOT_NODE_ID)
 * === true` for ANY descendant `d`), giving the default grant O(1) "covers
 * everything in this tenant's resource tree" reach without materializing a map.
 */
export const RESOURCE_ROOT_NODE_ID = "00000000-0000-0000-0000-0000000000r0";

/**
 * Platform role slug that holds the default-open READ grant (ADR §2.2). Seeded
 * alongside role-configurator (T-0373) — NOT a case-specific persona/role name
 * (NF-4 / FF-RP-7 anti-case: this is a platform primitive, not `role-approver`,
 * `soglasovanie`, etc.).
 */
export const READER_ROLE_SLUG = "role-reader";

// ---------------------------------------------------------------------------
// recordResourceScope — the SAME handle→scope shape refToScope produces for a
// record ResourceRef (grant-resolver.ts:213-219), rebuilt here so this module
// never imports grant-resolver.ts (no circular dependency).
// ---------------------------------------------------------------------------

/**
 * Build the resource-hierarchy `ScopeElement` a record's id maps to — byte-
 * identical in shape to `refToScope({kind:"record", recordId, ...})` in
 * grant-resolver.ts. Pure; no lattice math owned here (isNarrowerOrEqual is
 * still the only containment authority, NF-5).
 */
export function recordResourceScope(recordId: string): ScopeElement {
  return {
    kind: "node",
    hierarchy: "resource",
    nodeId: recordId,
    nodeLevel: "record",
  };
}

// ---------------------------------------------------------------------------
// isLatticeScope — mirrors grant-resolver.ts's local guard (a grant's scope
// participates in lattice containment iff it is not the `freeform` kind).
// ---------------------------------------------------------------------------

function isLatticeScope(scope: Grant["scope"]): scope is ScopeElement {
  return scope.kind !== "freeform";
}

// ---------------------------------------------------------------------------
// RowAncestry — the inline per-row ancestry the composite oracle walks for a
// NON-root (narrow) grant scope (ADR §2.1 rule 3 / §4.3). Sourced from the
// ALREADY-SELECTED page (records.ts SELECT already carries r.registry_id,
// rd.application_id) — no additional query per row (NF-1).
// ---------------------------------------------------------------------------

export interface RowAncestry {
  recordId: string;
  registryId: string;
  applicationId: string;
}

// ---------------------------------------------------------------------------
// isRecordReadable — the single READ-visibility predicate (ADR §4.3)
// ---------------------------------------------------------------------------

/**
 * Decide whether ONE already-loaded row is readable by the actor whose covering
 * grants are `grants` (already resolved by the SAME `getGrantsForSubject` DAO the
 * rest of the PDP uses — single-resolver, FR-7).
 *
 * Mirrors `resolveFor`'s covering-grant filter EXACTLY (grant-resolver.ts:589-
 * 607): a grant covers this row iff its operation is `"read"`, it is effective
 * at `nowMs`, its scope is a lattice scope (not freeform), and the record's
 * resource-node scope is narrower-or-equal to the grant's scope under `ancestry`.
 *
 * Pure; no IO. Caller resolves `grants`/`ancestry` ONCE per HTTP request (NF-1);
 * this function is the O(1)-per-row check applied over the already-loaded page.
 */
export function isRecordReadable(
  row: RowAncestry,
  grants: readonly Grant[],
  ancestry: AncestryOracle,
  nowMs: number,
): boolean {
  const recordScope = recordResourceScope(row.recordId);
  return grants.some((g) => {
    if (g.operation !== "read") return false;
    if (!isEffective(g, nowMs)) return false;
    if (!isLatticeScope(g.scope)) return false;
    return isNarrowerOrEqual(recordScope, g.scope, ancestry);
  });
}
