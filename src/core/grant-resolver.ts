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
import {
  type ClassificationSource,
  type MaskContext,
  type Clearance,
  maskFields,
  deriveClearance,
  readFacetVersion,
} from "./data-classification.js";

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
  /**
   * T-0033 (E4.3) — value-aware masking source. OPTIONAL: when absent, the
   * gateway degrades to the pre-T-0033 all-or-nothing field-presence projection
   * (backward-compatible). When present, the final projection step folds in the
   * (class × clearance) value transform — still ONE projection call, no second
   * handle→fields edge. Pure static-now; the Postgres RLS DAO lands in T-0053
   * (mirrors GrantSource/RecordSource). A present, classified facet with rows
   * the reader is not cleared for is masked (never widened) — fail-closed.
   */
  classifications?: ClassificationSource;
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

/**
 * Map a handle's ResourceRef kind to its T-0018 `ResourceType` string (the
 * `resource_type` column the classification rows are keyed on). The three
 * handle kinds map 1:1 to the three base resource types. Pure.
 */
function refToResourceType(ref: ResourceRef): string {
  switch (ref.kind) {
    case "application":
      return "application";
    case "registry":
      return "registry";
    case "record":
      return "record";
  }
}

/**
 * Build the T-0033 value-aware MaskContext for the ONE projection call, IFF a
 * `ClassificationSource` is injected. Returns `undefined` when no source is
 * present (⇒ projectFields uses its legacy raw-copy path — backward-compatible).
 *
 * The clearance is DERIVED FROM the already-covering grant rows (rights-derived-
 * only, AC-8) — not a field-name lookup, not a new store. The facet schema
 * version comes from the handle's (optionally typed) facet (`0` if unversioned).
 * The classification lookup is read through the injected port for exactly
 * `(resourceType, facetSchemaVersion)` in ONE read (rev-2 / R-1): it carries
 * both the per-version `rows` AND the resource-level `governed` bit. On a
 * governed resource a version with no rows yields an empty `rows` array ⇒
 * maskFields fails closed (max mask), never widens (AC-4/AC-12); on an
 * ungoverned resource the legacy raw floor holds (ADR §10.2/§10.6).
 */
function buildMaskContext(
  deps: ResolverDeps,
  handle: ObjectHandle,
  covering: Grant[],
): MaskContext | undefined {
  const source = deps.classifications;
  if (source === undefined) return undefined;
  const resourceType = refToResourceType(handle.ref);
  const facetSchemaVersion = readFacetVersion(handle.facet);
  const lookup = source.getClassifications(resourceType, facetSchemaVersion);
  const clearance: Clearance = deriveClearance(covering);
  return {
    governed: lookup.governed,
    rows: lookup.rows,
    clearance,
    facetSchemaVersion,
  };
}

// ---------------------------------------------------------------------------
// Field projection — THE single projection function (human == agent)
// ---------------------------------------------------------------------------

/**
 * THE single projection function. The human-form path and the agent-payload
 * path BOTH call it (via resolveFor). Returns a NEW object containing only the
 * visible field names.
 *
 * Two modes, ONE function (T-0033 folds value-masking in here — no second
 * handle→fields export):
 *  - No `maskCtx` (pre-T-0033 / no ClassificationSource) ⇒ a raw copy of every
 *    visible key; masked fields are physically ABSENT (not null —
 *    capability-not-text). The original all-or-nothing floor.
 *  - With a `maskCtx` ⇒ delegates to `maskFields`, which applies the
 *    (class × clearance) value transform per visible field: an unclassified
 *    field stays raw, a classified field is revealed / partially-revealed /
 *    redacted / hashed / dropped per its class and the reader's clearance.
 *
 * Deterministic; no IO (the classification rows are supplied in `maskCtx`; the
 * injected-port read happened upstream in resolveFor).
 */
export function projectFields(
  rawFields: Record<string, unknown>,
  visibleFieldSet: ReadonlySet<string>,
  maskCtx?: MaskContext,
): Record<string, unknown> {
  // T-0033: when a mask context is present, fold value-masking into THIS one
  // projection function (single-projection invariant preserved). When absent,
  // maskFields(ctx=undefined) is the identical raw-copy of the legacy path.
  return maskFields(rawFields, visibleFieldSet, maskCtx);
}

/**
 * Extract the facet field-names a covering grant confers, if any.
 *
 * The visible field names of a grant are its T-0021 `Facet` shape
 * `{ fields: string[] }` carried on the grant's optional `resourceFacet`
 * (T-0018 Grant.resourceFacet is `unknown` — the minimal opaque field-name
 * narrowing token of T-0015/T-0018; richer grammar is T-0033).
 *
 * Two cases, kept strictly distinct (ADR §4.4 'visibleFields rule'):
 *  - STRICTLY ABSENT facet (`undefined`/`null`) ⇒ whole-resource read: returns
 *    `undefined` ⇒ caller unions in ALL raw keys.
 *  - PRESENT but MALFORMED facet (a non-null value whose `fields` is not a
 *    `string[]` — e.g. `{fields: 123}`, `{fields: "bad"}`, `{fields: null}`,
 *    `{fields: [1,2]}`, `{}`, or a non-object like `42`/`"x"`) ⇒ FAIL-CLOSED:
 *    returns `[]` (zero visible fields). A structurally-present facet that does
 *    not parse to a valid field-list confers NO fields — it must never silently
 *    widen to whole-resource. This is the fail-closed discipline of the
 *    authority core: doubt about a present narrowing token resolves to zero.
 */
function grantFacetFields(grant: Grant): string[] | undefined {
  const facet = grant.resourceFacet;
  // Strictly-absent facet ⇒ whole-resource (the ONLY whole-resource path).
  if (facet === undefined || facet === null) return undefined;
  // Present but not an object (e.g. a number/string) ⇒ malformed ⇒ fail-closed.
  if (typeof facet !== "object") return [];
  const fields = (facet as Record<string, unknown>)["fields"];
  // Present facet object whose `fields` is not an array ⇒ malformed ⇒ zero.
  if (!Array.isArray(fields)) return [];
  // Present, well-formed facet narrows to its named fields (only string names
  // count; non-string members are dropped). An explicit empty facet confers no
  // fields — it cannot silently widen reach.
  return fields.filter((f): f is string => typeof f === "string");
}

/**
 * Derive the visible field set from the covering grants' facets, intersected
 * with the handle's optional narrowing Facet.
 *
 * Rule (ADR §4.4):
 *  - Start from ∅.
 *  - For each covering grant: STRICTLY-ABSENT facet (undefined/null) ⇒ union in
 *    ALL keys of `raw` (whole-resource read); a well-formed facet `{fields:[...]}`
 *    ⇒ union in those names; a PRESENT-but-malformed facet ⇒ union in nothing
 *    (zero fields, fail-closed — see grantFacetFields).
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

  // 6. Project once (FR-4, AC-5, AC-6) — the ONE projection point.
  const vis = visibleFields(covering, handle.facet, raw);
  // T-0033: build the value-aware MaskContext IFF a ClassificationSource is
  // injected. Classification is read AFTER a covering grant is found (never for
  // a record we have no grant for). A present, classified facet whose version
  // has no rows fails closed inside maskFields (max mask), never widened.
  const maskCtx = buildMaskContext(deps, handle, covering);
  const fields = projectFields(raw, vis, maskCtx);
  // TODO(T-0053): FR-8 (MAY) — thread the static-now T-0016 AuditObligation
  // shape ({ type, actor, subject, via, decision }) from here once the T-0016
  // ADR fixes its return contract. The durable append is explicitly deferred to
  // T-0053 (ADR §5); the obligation shape itself is intentionally not threaded
  // yet — ResolvedView carries no audit payload in static-now.
  return { denied: false, ref: handle.ref, fields };
}

/**
 * A grant's scope is a lattice `ScopeElement` (delegable, participates in
 * resource-hierarchy containment) iff it is NOT the `freeform` kind. A
 * `freeform` scope is owner-only / non-delegable and does not participate in
 * containment here.
 *
 * Discriminating on `kind !== "freeform"` (rather than enumerating the four
 * lattice kinds) keeps this guard structurally tied to the T-0018
 * `GrantScope = ScopeElement | FreeformScope` union: if T-0018 ever adds a
 * fifth lattice kind it is automatically treated as a lattice scope, with no
 * silent divergence. `FreeformScope` is the only non-`ScopeElement` member, so
 * excluding it narrows to `ScopeElement` exactly.
 */
function isLatticeScope(scope: Grant["scope"]): scope is ScopeElement {
  return scope.kind !== "freeform";
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
