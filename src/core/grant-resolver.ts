/**
 * T-0021: grant_resolver / Data-Access Gateway (PDP) — pure TS, no DB/IO/LLM.
 *
 * This module IS the body of the resolution seam T-0015 fixed: the single
 * function that turns an opaque ObjectHandle into grant-filtered record fields,
 * live, at action-time, identically for a human form and an agent payload.
 *
 * It IMPLEMENTS T-0015's `HandleResolver` port (exported via the
 * `makeGrantResolver(deps)` factory) without changing the port's shape; it
 * REPLACES `denyAllResolver` at the composition root, never by editing
 * object-handle.ts. It is the read-path consumer of the T-0018 authority
 * algebra — it owns NO lattice math of its own (it calls isNarrowerOrEqual /
 * isEffective) and introduces NO second authority subsystem: the decision and
 * the visible field set are derived solely from T-0018 grant rows.
 *
 * Design discipline is negative: the wrong thing is made IMPOSSIBLE, not merely
 * tested.
 *  - One projection function (so human != agent divergence cannot be written).
 *  - Grants resolved per call via an injected port (so a mint-time snapshot
 *    cannot exist — action-time / TOCTOU-safe).
 *  - Authority derived from grant rows only (so a second permission subsystem
 *    cannot accrete).
 *
 * Semantic contract: docs/design/T-0021-grant-resolver-pdp.adr.md §2, §4.
 * Static-now: all IO is behind injected ports (GrantSource / RecordSource /
 * AncestryOracle). The Postgres-backed ports + RLS DAO land in T-0053.
 */

import {
  type ObjectHandle,
  type ResolveSubject,
  type ResolvedView,
  type ResourceRef,
  type Facet,
  type HandleResolver,
} from "./object-handle.js";
import {
  type Grant,
  type Operation,
  type ScopeElement,
  type AncestryOracle,
  isNarrowerOrEqual,
  isEffective,
} from "./grant-lattice.js";

// ---------------------------------------------------------------------------
// Injected ports (pure static-now; Postgres + RLS DAO in T-0053)
// ---------------------------------------------------------------------------

/**
 * The subject's CURRENT grants (via role assignments), resolved AT CALL TIME.
 * The resolver passes `nowMs` so the same instant decides validity. In-memory
 * now; an RLS-scoped DB query in T-0053. Never a mint-time snapshot.
 */
export interface GrantSource {
  getGrants(subject: ResolveSubject, nowMs: number): Promise<Grant[]>;
}

/**
 * Raw record fields for a `record`-kind ref. `null` ⇒ the record is absent
 * (⇒ `not_found`). In-memory now; the RLS DAO in T-0053. The resolver only
 * calls this AFTER a covering grant is found — it never reads a record it has
 * no grant for.
 */
export interface RecordSource {
  getRecord(ref: ResourceRef): Promise<Record<string, unknown> | null>;
}

/**
 * Factory input. `now` is overridable in tests (defaults to Date.now), so the
 * core stays pure (NF-1): equal inputs + same injected `now` ⇒ equal output.
 */
export interface ResolverDeps {
  grants: GrantSource;
  records: RecordSource;
  ancestry: AncestryOracle;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// handle → scope adapter (the only handle->scope mapping; no lattice math)
// ---------------------------------------------------------------------------

/**
 * Map a handle's identity-only ResourceRef to the resource-hierarchy
 * ScopeElement (the leaf node the grant's scope must CONTAIN). This is the
 * single handle→scope adapter; it owns no containment math (that is T-0018's
 * isNarrowerOrEqual). Pure.
 *
 * Each ResourceRef kind maps to a resource-hierarchy node at the matching
 * NodeLevel; the nodeId is the kind's own identity component (the leaf the
 * grant scope is tested to contain via the injected AncestryOracle).
 */
export function refToScope(ref: ResourceRef): ScopeElement {
  switch (ref.kind) {
    case "application":
      return {
        kind: "node",
        hierarchy: "resource",
        nodeId: ref.applicationId,
        nodeLevel: "application",
      };
    case "registry":
      return {
        kind: "node",
        hierarchy: "resource",
        nodeId: ref.registryId,
        nodeLevel: "registry",
      };
    case "record":
      return {
        kind: "node",
        hierarchy: "resource",
        nodeId: ref.recordId,
        nodeLevel: "record",
      };
  }
}

// ---------------------------------------------------------------------------
// Field projection — THE single projection function (human == agent)
// ---------------------------------------------------------------------------

/**
 * THE single projection function. The human-form path and the agent-payload
 * path BOTH call it (via resolveFor). Returns a NEW object containing only the
 * visible field names; masked fields are physically ABSENT (not null —
 * capability-not-text). Deterministic; no IO.
 */
export function projectFields(
  rawFields: Record<string, unknown>,
  visibleFieldSet: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rawFields)) {
    if (visibleFieldSet.has(key)) {
      out[key] = rawFields[key];
    }
  }
  return out;
}

/**
 * Extract the facet field-names a covering grant confers, if any.
 *
 * The visible field names of a grant are its T-0021 `Facet` shape
 * `{ fields: string[] }` carried on the grant's optional `resourceFacet`
 * (T-0018 Grant.resourceFacet is `unknown` — the minimal opaque field-name
 * narrowing token of T-0015/T-0018; richer grammar is T-0033). A grant with no
 * well-formed facet confers the WHOLE resource (returns undefined ⇒ all keys).
 */
function grantFacetFields(grant: Grant): string[] | undefined {
  const facet = grant.resourceFacet;
  if (facet === null || typeof facet !== "object") return undefined;
  const fields = (facet as Record<string, unknown>)["fields"];
  if (!Array.isArray(fields)) return undefined;
  // A facet present narrows to its named fields (only string names count). An
  // explicit empty facet confers no fields — it cannot silently widen reach.
  return fields.filter((f): f is string => typeof f === "string");
}

/**
 * Derive the visible field set from the covering grants' facets, intersected
 * with the handle's optional narrowing Facet.
 *
 * Rule (ADR §4.4):
 *  - Start from ∅.
 *  - For each covering grant: NO facet ⇒ union in ALL keys of `raw`
 *    (whole-resource read); a facet `{fields:[...]}` ⇒ union in those names.
 *  - Then, if the HANDLE carries a Facet, INTERSECT with the handle's facet
 *    field names — the handle's narrowing token can only SHRINK the view,
 *    never widen it.
 */
export function visibleFields(
  coveringGrants: Grant[],
  handleFacet: Facet | undefined,
  rawFields: Record<string, unknown>,
): Set<string> {
  const allKeys = Object.keys(rawFields);
  const fromGrants = new Set<string>();

  for (const grant of coveringGrants) {
    const facetFields = grantFacetFields(grant);
    if (facetFields === undefined) {
      // Whole-resource read: every raw key becomes visible.
      for (const k of allKeys) fromGrants.add(k);
    } else {
      for (const f of facetFields) fromGrants.add(f);
    }
  }

  if (handleFacet === undefined) {
    return fromGrants;
  }

  // Handle facet narrows (intersects) — it can only shrink.
  const handleSet = new Set(handleFacet.fields);
  const narrowed = new Set<string>();
  for (const f of fromGrants) {
    if (handleSet.has(f)) narrowed.add(f);
  }
  return narrowed;
}

// ---------------------------------------------------------------------------
// The decision core (single source of truth, operation-parameterized)
// ---------------------------------------------------------------------------

/**
 * The operation-parameterized decision core (ADR §4.2 / §4.4). `resolveHandle`
 * (op=`read`) and the engine write-path callers (op ∈ create/update/delete/
 * approve/transition) BOTH go through this single core. It is NOT a second
 * handle→fields export of a divergent shape — it returns the same `ResolvedView`.
 *
 *  1. Tenant-gate (fail-closed, FIRST): handle tenant != subject tenant ⇒
 *     `cross_tenant` — no grant or record is read.
 *  2. Resolve grants AT CALL-TIME via the injected port with the same `now`.
 *  3. Filter to covering grants: same tenant ∧ operation match ∧ isEffective(now)
 *     ∧ isNarrowerOrEqual(handleScope, grant.scope, ancestry).
 *  4. Fail closed if none ⇒ `no_grant`.
 *  5. Fetch the record (ONLY now): null ⇒ `not_found`.
 *  6. Project ONCE and return `{ denied:false, ref, fields }`.
 */
export async function resolveFor(
  deps: ResolverDeps,
  handle: ObjectHandle,
  subject: ResolveSubject,
  op: Operation,
): Promise<ResolvedView> {
  // 1. Tenant-gate, fail-closed, before any grant/record read (NF-3, AC-2).
  if (handle.tenantId !== subject.tenantId) {
    return { denied: true, reason: "cross_tenant" };
  }

  // 2. Resolve grants at call-time (FR-2, AC-3). Single `now` decides validity.
  const now = (deps.now ?? Date.now)();
  const all = await deps.grants.getGrants(subject, now);

  // 3. Filter to covering grants (FR-3, FR-6, AC-4, AC-7, AC-8).
  const handleScope = refToScope(handle.ref);
  const covering = all.filter((g) => {
    if (g.tenantId !== subject.tenantId) return false;
    if (g.operation !== op) return false;
    if (!isEffective(g, now)) return false;
    // A grant's scope may be free-form (owner-only, outside the lattice); only
    // lattice scope elements participate in resource-containment here.
    if (!isLatticeScope(g.scope)) return false;
    return isNarrowerOrEqual(handleScope, g.scope, deps.ancestry);
  });

  // 4. Fail closed if no covering grant (FR-5, AC-1).
  if (covering.length === 0) {
    return { denied: true, reason: "no_grant" };
  }

  // 5. Fetch the record — only after a covering grant is found (AC-9).
  const raw = await deps.records.getRecord(handle.ref);
  if (raw === null) {
    return { denied: true, reason: "not_found" };
  }

  // 6. Project once (FR-4, AC-5, AC-6).
  const vis = visibleFields(covering, handle.facet, raw);
  const fields = projectFields(raw, vis);
  return { denied: false, ref: handle.ref, fields };
}

/**
 * A grant's scope is a lattice ScopeElement (delegable) iff it is one of the
 * four admissible kinds. A `freeform` scope is owner-only / non-delegable and
 * does not participate in resource-hierarchy containment.
 */
function isLatticeScope(scope: Grant["scope"]): scope is ScopeElement {
  return (
    scope.kind === "node" ||
    scope.kind === "tags" ||
    scope.kind === "interval" ||
    scope.kind === "set"
  );
}

// ---------------------------------------------------------------------------
// The factory — swaps in for denyAllResolver at the T-0015 seam
// ---------------------------------------------------------------------------

/**
 * Build a HandleResolver whose `resolveHandle` is the read-path facade over the
 * single decision core (`resolveFor(.., "read")`). This is what swaps in for
 * `denyAllResolver` at the T-0015 seam — the port signature is UNCHANGED
 * (architect rule 7). The swap is a composition-root injection; object-handle.ts
 * keeps shipping `denyAllResolver` as the safe default and is not edited.
 */
export function makeGrantResolver(deps: ResolverDeps): HandleResolver {
  return {
    resolveHandle(
      handle: ObjectHandle,
      subject: ResolveSubject,
    ): Promise<ResolvedView> {
      return resolveFor(deps, handle, subject, "read");
    },
  };
}
