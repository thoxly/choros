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
import { type KeyedDigest } from "./keyed-digest.js";
import {
  type EffectSource,
  type EffectDeclaration,
  type EffectDeniedView,
  type EffectVerifyResult,
  classifyTool,
  verifyEffectGrants,
} from "./effect-resource.js";
import {
  type SodSource,
  type SodDeniedView,
  type GuardedAct,
  type EffectiveAssignment,
  evaluateSod,
} from "./sod.js";
import {
  type ActorEventInput,
  type ActorEventObjectRef,
  type ActorEventVerb,
  actorEventPrincipal,
} from "./actor-event.js";
import { type SubstitutionSource } from "./substitution.js";

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
  /**
   * T-0034 (E4.4) — external-effect resource verification port. OPTIONAL: when
   * absent the gateway degrades to the pre-T-0034 grant-only enforcement floor
   * (backward-compatible, NF-2, AC-8). When present, every `invoke`-path call
   * to `resolveFor` additionally verifies that the subject holds a grant covering
   * every `EffectDeclaration` in the tool's `declares` blob (step 3.5, ADR §4.4).
   * Denial reason: `"no_effect_grant"`. Pure static-now; the Postgres DAO lands
   * in T-0053 (mirrors GrantSource/RecordSource/ClassificationSource).
   */
  effects?: EffectSource;
  /**
   * T-0032 (E4.2) — Separation-of-Duties guard port. OPTIONAL: when absent the
   * gateway degrades to the pre-T-0032 covering-grant-only floor (backward-
   * compatible, NF-2, AC-11), exactly like `effects`/`classifications`. When
   * present, every `approve`/`transition`-path call to `resolveFor` additionally
   * (i) evaluates static + dynamic SoD (step 3.6, ADR §4.5) and (ii) on a PASS
   * appends EXACTLY ONE actor_event row via the writer (step 6.5). Denial reason:
   * `"sod_violation"`. Pure static-now; the Postgres DAO lands in T-0053
   * (mirrors GrantSource/RecordSource/ClassificationSource/EffectSource).
   */
  sod?: SodSource;
  /**
   * T-0118 (E4.3-fu) — per-tenant keyed-digest capability that closes the
   * `hash`-transform equality-oracle (TEST T-0033 `F-1-hash-equality-oracle`).
   * OPTIONAL and ADDITIVE (mirrors `classifications`/`effects`/`sod`). When
   * present, a field that resolves to the `hash` transform is masked with a
   * secret-keyed, per-`(tenant, field)` digest (HMAC-SHA256 behind the port —
   * the impure crypto lives in `keyed-digest.ts`, never in the pure core). When
   * ABSENT (pre-T-0118 wiring) the `hash` field FAILS CLOSED to `drop` — the
   * keyless djb2 is removed as a reachable masking output (D-4). The secret is
   * provisioned at the composition root from `CHOROS_MASK_DIGEST_KEY`
   * (ops-custodied silo secret — never read under `src/core/`).
   */
  keyedDigest?: KeyedDigest;
  /**
   * T-0035 (E4.7) — Substitutions / absences port. OPTIONAL: wired here for
   * the future routing layer and composition root so they can inject the
   * SubstitutionSource without a later signature break. NOT consulted inside
   * resolveFor — the PDP continues to decide purely on T-0018 grant rows (a
   * Tier-2 substitution grant is just a grant to the PDP). Backward-compatible:
   * resolveFor behavior is byte-identical when this property is absent.
   */
  substitution?: SubstitutionSource;
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
  // T-0118: thread the field/tenant identity + the bound keyed-digest fn into
  // the MaskContext so the `hash` masking path is per-tenant KEYED (closes the
  // cross-tenant equality-oracle). `tenantId` is read from the already-validated
  // `handle.tenantId` (=== subject.tenantId, checked above) — NOT re-fetched (C-5).
  // `keyedDigest` is ALWAYS passed through: absent ⇒ the `hash` field fails closed
  // to `drop` inside `maskFields` (D-4 / AC-6), even when `classifications` is
  // present. The port returning `undefined` (no key for the tenant) likewise
  // drops (D-3 / AC-5). Never the keyless digest, never raw.
  const keyedDigest = deps.keyedDigest;
  return {
    governed: lookup.governed,
    rows: lookup.rows,
    clearance,
    facetSchemaVersion,
    resourceType,
    tenantId: handle.tenantId,
    keyedDigest: keyedDigest
      ? (input) => keyedDigest.digest(input)
      : undefined,
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
 * Optional invoke context: carries the tool's `declares` blob at invoke-time
 * (T-0034 step 3.5). This is an ADDITIVE optional 5th argument — callers that
 * omit it compile unchanged and the effect-verification path is not entered
 * (backward-compatible, NF-2, AC-8).
 *
 * The `declares` field is the raw `mcp_tool.declares` jsonb value (a serialized
 * `EffectDeclaration[]`). T-0034 ADR §4.4 option 2: accept it as an additive
 * optional param rather than hoisting a record fetch.
 */
export interface InvokeContext {
  declares: unknown; // raw jsonb from mcp_tool.declares; parsed + validated inside
}

/**
 * Optional guard context for the SoD step (T-0032 step 3.6). Carries the
 * action-time attribution the SoD guard needs but that `ResolveSubject` does
 * NOT (and must not — object-handle.ts is frozen): the performer, the principal
 * (`onBehalfOf`), the resolved role, the verb, and (for `approve`) the level.
 *
 * This is an ADDITIVE optional 6th argument on `resolveFor` (mirroring T-0034's
 * optional `invokeCtx?` 5th arg). A guarded op with `deps.sod` present but
 * `guardCtx` ABSENT is FAIL-CLOSED → `sod_violation`: an unattributable
 * transition cannot be proven SoD-clean (NF-3). This is the SoD analogue of
 * T-0034's trust-boundary note, but fail-CLOSED (T-0034 treats a missing
 * invokeCtx as pure-compute; SoD treats a missing guardCtx as a denial).
 */
export interface GuardContext {
  actor: string; // the performer (employee id)
  onBehalfOf?: string | null; // the principal when ≠ performer
  roleAtEvent: string; // the role the gateway resolved the actor under
  verb: ActorEventVerb; // the verb recorded on the act
  approveLevel?: number; // required iff verb === 'approve'
}

/**
 * Map a handle's identity-only ResourceRef to the actor_event object ref the
 * SoD reader / writer key on. The three handle kinds map 1:1; pure.
 */
function refToActorEventRef(ref: ResourceRef): ActorEventObjectRef {
  switch (ref.kind) {
    case "application":
      return { objectKind: "application", applicationId: ref.applicationId };
    case "registry":
      return { objectKind: "registry", registryId: ref.registryId };
    case "record":
      return { objectKind: "record", recordId: ref.recordId };
  }
}

/**
 * Build the GuardedAct the SoD layer evaluates and the writer records, from the
 * handle's ref + the action-time GuardContext. Pure. `approveLevel` is threaded
 * only for `approve` (validateActorEventInput rejects a level on a non-approve
 * verb, and a missing level on approve — fail-closed at the writer).
 */
function buildGuardedAct(handle: ObjectHandle, guardCtx: GuardContext): GuardedAct {
  return {
    ref: refToActorEventRef(handle.ref),
    actor: guardCtx.actor,
    onBehalfOf: guardCtx.onBehalfOf ?? null,
    roleAtEvent: guardCtx.roleAtEvent,
    event: guardCtx.verb,
    approveLevel: guardCtx.approveLevel,
  };
}

/** Project a GuardedAct into the frozen T-0019 ActorEventInput (the writer's input). */
function toActorEventInput(act: GuardedAct): ActorEventInput {
  const base = {
    actor: act.actor,
    onBehalfOf: act.onBehalfOf ?? null,
    roleAtEvent: act.roleAtEvent,
    event: act.event,
    ...(act.approveLevel !== undefined ? { approveLevel: act.approveLevel } : {}),
  };
  switch (act.ref.objectKind) {
    case "application":
      return { objectKind: "application", applicationId: act.ref.applicationId, ...base };
    case "registry":
      return { objectKind: "registry", registryId: act.ref.registryId, ...base };
    case "record":
      return { objectKind: "record", recordId: act.ref.recordId, ...base };
  }
}

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
 * [3.5] When op=`invoke` AND deps.effects is present: parse the tool's `declares`
 *     blob; deny fail-closed if malformed; run verifyEffectGrants; deny on first
 *     uncovered declaration (reason: `"no_effect_grant"`). This step is INSIDE
 *     this single resolveFor body — no second resolver edge (FR-8, AC-13).
 *  5. Fetch the record (ONLY now): null ⇒ `not_found`.
 *  6. Project ONCE and return `{ denied:false, ref, fields }`.
 */
export async function resolveFor(
  deps: ResolverDeps,
  handle: ObjectHandle,
  subject: ResolveSubject,
  op: Operation,
  invokeCtx?: InvokeContext,
  guardCtx?: GuardContext,
): Promise<ResolvedView | EffectDeniedView | SodDeniedView> {
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

  // [step 3.5] T-0034 — invoke-path effect-grant verification.
  // Active ONLY when op === "invoke" AND deps.effects is present (NF-2, AC-8).
  // When EffectSource is absent the entire block is skipped — pre-T-0034 behavior
  // (grant-only enforcement floor, backward-compatible).
  if (op === "invoke" && deps.effects !== undefined) {
    const effectSource = deps.effects;
    // Parse the declares blob via classifyTool.
    // classifyTool returns { pure: true } for empty [], { pure: false, effects: [...] }
    // for valid non-empty declarations, or { pure: false, effects: [] } for malformed.
    // Malformed input: effects[] is empty but pure is false → indicates parse failure.
    // We must distinguish "empty declares (pure tool)" from "malformed declares (fail-closed)".
    // Strategy: classifyTool on the raw blob; if raw is an array and classifyTool says
    // pure:true → no declarations to check (AC-2); if raw is malformed or unknown-kind →
    // classifyTool returns pure:false with effects:[] → deny fail-closed (AC-9/FR-6).
    //
    // IMPORTANT: do NOT use `?? []` — null is a valid "provided but malformed" value that
    // must trigger fail-closed (AC-9). `?? []` would make `null` behave as `[]` (pure-compute),
    // defeating the fail-closed invariant. Use `undefined` as the "not provided" sentinel only.
    //
    // TRUST BOUNDARY — EffectSource present + invokeCtx absent ⇒ treated as pure-compute (declares=[]).
    // This is DISTINCT from the NF-2 backward-compat floor (EffectSource absent ⇒ block skipped entirely).
    // Here EffectSource IS wired (composition root opted into T-0034 enforcement), yet the caller omitted
    // invokeCtx — the resolver trusts the caller's implicit assertion that the tool carries no mcp_tool.declares
    // context and proceeds as pure-compute.  This bypasses effect-grant verification by design (ADR §4.4
    // option 2: no signature break for callers that omit the 5th arg).
    // Composition-root authors: any invoke of an effecting tool MUST pass invokeCtx with a valid `declares`
    // array; omitting it bypasses effect verification silently (NF-2 floor applies).
    // See T-0034 ADR §4.4 for the full rationale.
    const declares: unknown = invokeCtx !== undefined ? invokeCtx.declares : [];
    const profile = classifyTool(declares);
    // Pure-compute tool (empty declares): no effect verification needed — proceed (AC-8 compat, AC-6).
    // Malformed: profile.pure=false but effects=[] when raw is not a valid array or has bad kinds.
    // Distinguish: if raw array is empty → profile.pure=true → skip. If raw is non-empty
    // and valid → profile.pure=false, effects non-empty. If raw is malformed → profile.pure=false, effects=[].
    let declarations: EffectDeclaration[];
    if (profile.pure) {
      // Empty, valid declares → no effect verification needed.
      declarations = [];
    } else if (profile.effects.length === 0) {
      // Malformed input → fail-closed (AC-9, FR-6, NF-3).
      return { denied: true, reason: "no_effect_grant" };
    } else {
      declarations = profile.effects;
    }
    // All declarations covered → proceed; any uncovered → deny (AC-5, AC-7, FF-ER5).
    const result: EffectVerifyResult = verifyEffectGrants(
      declarations,
      all, // pass ALL grants so verifyEffectGrants can check effect_resource grants
      now,
      effectSource,
      subject.tenantId,
    );
    if (!result.ok) {
      return { denied: true, reason: "no_effect_grant" };
    }
  }

  // [step 3.6] T-0032 — SoD guard. Active ONLY when op ∈ {approve, transition}
  // AND deps.sod is present (NF-2 backward-compat floor when absent). On a
  // violation → { denied:true, reason:"sod_violation" }, short-circuiting BEFORE
  // the record fetch and BEFORE the writer — ZERO actor_event rows (AC-10).
  const isGuardedOp = op === "approve" || op === "transition";
  let guardedAct: GuardedAct | undefined;
  if (isGuardedOp && deps.sod !== undefined) {
    // A guarded op with deps.sod present but guardCtx absent ⇒ fail-closed
    // (an unattributable transition cannot be proven SoD-clean — NF-3).
    if (guardCtx === undefined) {
      return { denied: true, reason: "sod_violation" };
    }
    const sod = deps.sod;
    guardedAct = buildGuardedAct(handle, guardCtx);
    const principal = actorEventPrincipal({
      actor: guardCtx.actor,
      onBehalfOf: guardCtx.onBehalfOf,
    });
    let principalAssignments: EffectiveAssignment[];
    let decision;
    try {
      principalAssignments = await sod.effectiveAssignmentsOf(principal);
      decision = await evaluateSod(sod, deps.ancestry, guardedAct, principalAssignments);
    } catch {
      return { denied: true, reason: "sod_violation" }; // fail-closed (NF-3).
    }
    if (decision.violated) {
      return { denied: true, reason: "sod_violation" }; // zero actor_event rows.
    }
  }

  // 5. Fetch the record — only after a covering grant is found (AC-9).
  const raw = await deps.records.getRecord(handle.ref);
  if (raw === null) {
    return { denied: true, reason: "not_found" }; // still zero actor_event rows.
  }

  // [step 6.5] T-0032 — on a guarded op that PASSED grant ∧ SoD ∧ record fetch,
  // append EXACTLY ONE actor_event row recording the act (AC-10).
  // validateActorEventInput runs INSIDE the writer (AC-14); a rejection there is
  // fail-closed (the act cannot be recorded ⇒ the transition is denied).
  if (isGuardedOp && deps.sod !== undefined && guardedAct !== undefined) {
    try {
      await deps.sod.writer.appendActorEvent(toActorEventInput(guardedAct));
    } catch {
      return { denied: true, reason: "sod_violation" }; // fail-closed (NF-3).
    }
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
      // op="read" never reaches the invoke-path effect check (step 3.5 is
      // `op === "invoke"` guarded); the return type is always `ResolvedView`.
      // The cast is safe: EffectDeniedView is structurally { denied: true } and
      // HandleResolver.resolveHandle is typed Promise<ResolvedView>, so we cast
      // the widened return down — the read path never emits "no_effect_grant".
      return resolveFor(deps, handle, subject, "read") as Promise<ResolvedView>;
    },
  };
}
