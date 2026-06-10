/**
 * T-0033: Data-classification + value-aware masking + typed facets +
 * from→to guards — pure TS, no DB/IO/LLM.
 *
 * This module raises the T-0021 gateway facet from all-or-nothing
 * field-presence to a **(class × grant)** value-aware projection, WITHOUT
 * opening a second resolution edge. It owns:
 *  - the stable, enumerable `DataClass` axis (the shared join symbol S-1/S-3 read);
 *  - the closed `Transform` value-transform vocabulary + the pure `applyTransform`;
 *  - the `ClassificationSource` injected port (pure static-now; Postgres RLS DAO
 *    lands in T-0053, mirroring GrantSource/RecordSource);
 *  - the typed, schema-versioned `TypedFacet` descriptor (an ADDITIVE widening of
 *    T-0015's frozen `Facet = {fields: string[]}` — object-handle.ts is NOT edited);
 *  - the masking decision `maskFields(...)` (the body grant-resolver's projection
 *    delegates to when a ClassificationSource is present);
 *  - the `from→to` reclassification guard `evaluateReclassification(...)`.
 *
 * Three NON-NEGOTIABLE invariants are inherited from T-0021 and the red-lines:
 *  - Single projection — value-masking is folded into the ONE projectFields
 *    call inside the ONE resolveFor core; no second handle→fields export.
 *  - Rights-derived-only — every masking decision derives solely from T-0018
 *    grant rows (clearance) + the data_classification rows. No parallel
 *    field-ACL / field-visibility store (a sibling check bans the tokens).
 *  - Pure / static-now / fail-closed — no pg/fs/net/http import; classification
 *    read through the injected port; doubt resolves to MORE masking, never less.
 *
 * Semantic contract: docs/design/T-0033-data-classification.adr.md §2–§4.
 */

import { type Grant, type Operation, isEffective } from "./grant-lattice.js";

// ---------------------------------------------------------------------------
// The shared, stable, enumerable class axis (AC-14)
// ---------------------------------------------------------------------------

/**
 * The shared, stable, enumerable classification axis. Ordered MOST→LEAST
 * visible for the monotone transform table (index 0 = most visible / least
 * sensitive). S-1 (`egress_policy`, T-0041) and S-3 (`role_criticality`,
 * T-0040) join on THIS exact symbol — they import `DataClass`, they do NOT
 * redeclare it. `data_classification` carries NO egress column (that is
 * T-0041's table, keyed on `class`).
 */
export type DataClass = "public" | "internal" | "confidential" | "restricted";

/**
 * The canonical ordering of `DataClass`, most→least visible. The index in this
 * array is the field's "sensitivity rank": a higher index is MORE sensitive
 * (less visible). Direction and clearance comparisons read off this ordering —
 * there is no second authority algebra (NF-2).
 */
export const DATA_CLASS_ORDER: readonly DataClass[] = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;

/**
 * The sensitivity rank of a class (0 == most visible == `public`). Returns -1
 * for a value not in the closed `DataClass` set (a corrupt row) — callers treat
 * a negative/unknown rank as MAXIMALLY sensitive (fail-closed, NF-3).
 */
function classRank(value: string): number {
  return DATA_CLASS_ORDER.indexOf(value as DataClass);
}

/** Total predicate: is `value` a member of the closed DataClass set? */
function isDataClass(value: unknown): value is DataClass {
  return typeof value === "string" && classRank(value) >= 0;
}

// ---------------------------------------------------------------------------
// Closed value-transform vocabulary (AC-5)
// ---------------------------------------------------------------------------

/**
 * The closed value-transform vocabulary. `drop` == capability-not-text (the key
 * is OMITTED entirely — the pre-T-0033 all-or-nothing absence, the maximal
 * mask). The other four leave the key PRESENT with a (possibly transformed)
 * value, so masking spans presence AND value (strictly richer than T-0021).
 */
export type Transform = "reveal" | "partial" | "redact" | "hash" | "drop";

/** Fixed sentinel a `redact` transform produces (present key, opaque value). */
const REDACTED_SENTINEL = "[redacted]";

/**
 * Pure, deterministic, non-reversible digest (djb2-style, same family as
 * object-handle's `deriveHandleId`). NO key custody — crypto is out of scope
 * (spec §6-A #12); this is a stable token, not an encryption. Determinism is a
 * contract (AC-13): equal input ⇒ equal digest.
 */
function digest(input: string): string {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = (Math.imul(31, h1) + c) >>> 0;
    h2 = (Math.imul(29, h2) + c) >>> 0;
  }
  const part1 = h1.toString(16).padStart(8, "0");
  const part2 = h2.toString(16).padStart(8, "0");
  return `${part1}${part2}`;
}

/**
 * Pure value transform. Deterministic; no IO; no key custody. Total over the
 * closed `Transform` set. `drop` is handled by the caller (key omission) — when
 * called directly it returns `undefined` (the value a dropped key would carry).
 *
 *  - `reveal`  → the raw value (pass-through).
 *  - `partial` → a structurally value-aware reveal of a non-sensitive remainder
 *                (last-4 of a string, e.g. `"****1234"`; short/empty strings →
 *                fully masked `"****"`; NON-strings degrade to `redact` — a
 *                partial reveal of a non-string is not safely expressible).
 *                Value-level (AC-5): present and deeply-different from raw.
 *  - `redact`  → the fixed `"[redacted]"` sentinel (present key, opaque value).
 *  - `hash`    → a deterministic, pure, non-reversible digest string.
 *  - `drop`    → `undefined` (the caller omits the key — capability-not-text).
 */
export function applyTransform(value: unknown, transform: Transform): unknown {
  switch (transform) {
    case "reveal":
      return value;
    case "partial":
      if (typeof value !== "string") {
        // A partial reveal of a non-string is not safely expressible ⇒ redact.
        return REDACTED_SENTINEL;
      }
      if (value.length <= 4) return "****";
      return `****${value.slice(-4)}`;
    case "redact":
      return REDACTED_SENTINEL;
    case "hash":
      // Stable string form so equal logical values digest equally (AC-13).
      return digest(typeof value === "string" ? value : JSON.stringify(value));
    case "drop":
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Classification rows + injected port (mirrors GrantSource/RecordSource)
// ---------------------------------------------------------------------------

/**
 * One classification row — the TS mirror of a `data_classification` table row.
 * `(resourceType, facetField, facetSchemaVersion)` is the lookup key; `class`
 * is the assigned `DataClass`.
 */
export interface ClassificationRow {
  resourceType: string; // T-0018 ResourceType (string-compatible)
  facetField: string; // the record-schema field name
  facetSchemaVersion: number; // the schema version this row classifies
  class: DataClass;
}

/**
 * rev-2 (R-1): the port returns a governance-bearing envelope, not a bare
 * `ClassificationRow[]`. `governed` is TRUE iff resource type `R` has >=1
 * classification row under ANY version (the source computes it from the SAME
 * scan/state it uses for `rows` — no second query, no second store). `rows` is
 * STILL only the rows for the requested `(resourceType, facetSchemaVersion)`
 * pair — the per-version slice is unchanged. The two states `governed`
 * distinguishes (ADR §10.1): U (ungoverned ⇒ legacy raw floor) vs. G (governed
 * ⇒ a field with no resolvable class for this version fails closed, never raw).
 * `governed` is monotone-safe: a source that cannot prove the resource
 * ungoverned MUST return `true` (fail-closed bias, NF-3).
 */
export interface ClassificationLookup {
  governed: boolean; // R is under classification governance (any version)
  rows: ClassificationRow[]; // rows for exactly (resourceType, facetSchemaVersion)
}

/**
 * Injected port — pure static-now; the RLS-scoped Postgres DAO lands in T-0053
 * (mirrors `GrantSource`/`RecordSource`). The resolver calls it ONLY AFTER a
 * covering grant is found — it never reads classification for a record it has
 * no grant for. Returns a `ClassificationLookup` (the governance bit + the rows
 * for the `(resourceType, facetSchemaVersion)` pair) in ONE read — an empty
 * `rows` slice on a `governed` resource is a fail-closed signal (max mask, no
 * widening), never an error (ADR §10.2/§10.4).
 */
export interface ClassificationSource {
  getClassifications(
    resourceType: string,
    facetSchemaVersion: number,
  ): ClassificationLookup;
}

// ---------------------------------------------------------------------------
// Typed, schema-versioned facet descriptor (additive widening of T-0015 Facet)
// ---------------------------------------------------------------------------

/**
 * Typed, schema-versioned facet descriptor. This is an ADDITIVE widening of
 * T-0015's frozen `Facet = {fields: string[]}`: every `Facet` is structurally a
 * `TypedFacet` with `schemaVersion` omitted (treated as version `0`). The typed
 * shape lives HERE — object-handle.ts is NOT edited; the shape is accepted
 * structurally where `handle.facet` flows in.
 */
export interface TypedFacet {
  fields: string[];
  schemaVersion: number;
}

/**
 * Total reader of a facet's schema version. A facet with no `schemaVersion`
 * (the legacy T-0015 `Facet`) or `undefined` reads as version `0` (unversioned).
 * A facet whose `schemaVersion` has no matching classification rows fails closed
 * to maximal masking (AC-4/AC-12) — that policy lives in `maskFields`, not here.
 */
export function readFacetVersion(
  facet: { fields: string[]; schemaVersion?: number } | undefined,
): number {
  if (facet === undefined) return 0;
  const v = facet.schemaVersion;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ---------------------------------------------------------------------------
// Clearance (rights-derived-only — derived from covering grant rows)
// ---------------------------------------------------------------------------

/**
 * Reader clearance — the maximum `DataClass` the subject's COVERING grant rows
 * confer for this resource. `null` == no classified clearance (⇒ every
 * classified field maximally masked). Derived FROM the grant rows the resolver
 * already computed — NOT a field-name lookup, NOT a new store (AC-8/FR-8).
 */
export type Clearance = DataClass | null;

/**
 * Read a grant's clearance token, if any. Clearance is carried as a typed
 * marker on the grant's EXISTING opaque `constraint` surface (a `clearance`
 * member whose value is a `DataClass`) — NO schema change to `Grant`, NO new
 * column, NO parallel field-ACL/field-visibility store. `constraint` is read
 * FIRST because `resourceFacet` is also the field-narrowing token (a
 * whole-resource grant keeps `resourceFacet` strictly absent, so its clearance
 * must ride on `constraint`); `resourceFacet` is consulted as a fallback only
 * for grants that explicitly co-locate the marker there. A grant with no
 * clearance token confers no classified clearance.
 */
function grantClearance(grant: Grant): DataClass | null {
  const fromConstraint = readClearanceMarker(grant.constraint);
  if (fromConstraint !== null) return fromConstraint;
  return readClearanceMarker(grant.resourceFacet);
}

/** Structurally read a `{ clearance: DataClass }` marker off an opaque value. */
function readClearanceMarker(opaque: unknown): DataClass | null {
  if (opaque === null || typeof opaque !== "object") return null;
  const c = (opaque as Record<string, unknown>)["clearance"];
  return isDataClass(c) ? c : null;
}

/**
 * Derive the reader's clearance from the COVERING grant rows (the same rows
 * `resolveFor` step 3 already computed). Returns the MAXIMUM (most sensitive)
 * `DataClass` any covering grant confers, or `null` if none does. Pure function
 * of the grant rows — rights-derived-only (AC-8). The optional `nowMs` lets the
 * caller restrict to effective grants; when omitted, all supplied grants count
 * (the resolver already filtered to effective covering grants).
 */
export function deriveClearance(
  coveringGrants: Grant[],
  nowMs?: number,
): Clearance {
  let best: Clearance = null;
  let bestRank = -1;
  for (const g of coveringGrants) {
    if (nowMs !== undefined && !isEffective(g, nowMs)) continue;
    const c = grantClearance(g);
    if (c === null) continue;
    const r = classRank(c);
    if (r > bestRank) {
      bestRank = r;
      best = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// (class × clearance) → transform selection (AC-6)
// ---------------------------------------------------------------------------

/**
 * Select the value transform for a `(fieldClass, clearance)` pair. MONOTONE and
 * keyed ONLY on the pair — never on field name (AC-6): two differently-named
 * fields sharing a class + clearance get the SAME transform; re-classifying a
 * field to a different class yields a DIFFERENT transform.
 *
 * Rule (a monotone ladder over the sensitivity gap = fieldRank - clearanceRank):
 *  - clearance ≥ class (gap ≤ 0)  ⇒ `reveal`   (fully cleared reader).
 *  - exactly one step below (gap 1) ⇒ `partial` (a present, transformed value).
 *  - two steps below (gap 2)        ⇒ `redact`  (present sentinel).
 *  - three+ steps below (gap ≥ 3)   ⇒ `hash`    (present opaque digest).
 *  - clearance === null OR class corrupt ⇒ `drop` (maximal mask, key omitted).
 *
 * The ladder is monotone (NF-3): a wider gap never yields a MORE-revealing
 * transform. Doubt (null clearance, unknown class) resolves to `drop`.
 */
export function selectTransform(
  fieldClass: DataClass,
  clearance: Clearance,
): Transform {
  const fieldRank = classRank(fieldClass);
  // Unknown/corrupt field class ⇒ maximal mask (fail-closed).
  if (fieldRank < 0) return "drop";
  // No classified clearance at all ⇒ maximal mask.
  if (clearance === null) return "drop";
  const clearanceRank = classRank(clearance);
  if (clearanceRank < 0) return "drop";

  const gap = fieldRank - clearanceRank;
  if (gap <= 0) return "reveal";
  if (gap === 1) return "partial";
  if (gap === 2) return "redact";
  return "hash";
}

// ---------------------------------------------------------------------------
// The masking fold — REPLACES projectFields' body when classifications present
// ---------------------------------------------------------------------------

/**
 * Context for a value-aware mask: the classification rows for the resolved
 * `(resourceType, facetSchemaVersion)`, the reader's clearance, and the facet
 * schema version. `undefined` (no ClassificationSource) ⇒ legacy behaviour.
 */
export interface MaskContext {
  governed: boolean; // rev-2 (R-1) — R is under classification governance (any version)
  rows: ClassificationRow[]; // for (resourceType, facetSchemaVersion)
  clearance: Clearance;
  facetSchemaVersion: number;
}

/**
 * The masking fold. The body grant-resolver's `projectFields` delegates to when
 * a `MaskContext` is present. Returns a NEW object containing the visible field
 * names, each value transformed per `(class × clearance)`:
 *  - a field with NO resolvable class for this version forks on `ctx.governed`
 *    (rev-2 / R-1, ADR §10.3): on an UNGOVERNED resource (`governed: false`,
 *    state U) it is kept raw (legacy floor — classification is additive); on a
 *    GOVERNED resource (`governed: true`, state G) it fails closed to maximal
 *    mask (`drop`, key omitted) — NEVER raw. This covers both "this version has
 *    zero rows" (AC-12 version boundary) and "this version has rows but not for
 *    `f`" (AC-4).
 *  - a field WITH a classification row gets `selectTransform(class, clearance)`;
 *    `drop` omits the key (capability-not-text), the others leave it PRESENT
 *    with a transformed value.
 *  - a field whose row's `class` is corrupt (not a `DataClass`) ⇒ maximal mask.
 *
 * `ctx === undefined` ⇒ the legacy projectFields behaviour (raw copy of every
 * visible key) — backward-compatible (the pre-T-0033 floor).
 *
 * Pure / deterministic / no IO (the rows are supplied; the port read happened
 * upstream). Same (visibleFieldSet, rawFields, ctx) ⇒ deeply-equal output.
 */
export function maskFields(
  rawFields: Record<string, unknown>,
  visibleFieldSet: ReadonlySet<string>,
  ctx: MaskContext | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Index the rows by facetField for THIS schema version only (AC-4/AC-12: a
  // row for a different version does not classify this facet).
  const classByField = new Map<string, string>();
  if (ctx !== undefined) {
    for (const r of ctx.rows) {
      if (r.facetSchemaVersion === ctx.facetSchemaVersion) {
        classByField.set(r.facetField, r.class);
      }
    }
  }

  for (const key of Object.keys(rawFields)) {
    if (!visibleFieldSet.has(key)) continue;
    const raw = rawFields[key];

    // No mask context ⇒ legacy raw copy.
    if (ctx === undefined) {
      out[key] = raw;
      continue;
    }

    const cls = classByField.get(key);
    if (cls === undefined) {
      // rev-2 (R-1): governance decides raw-vs-fail-closed (ADR §10.3).
      if (ctx.governed) {
        // State G: governed resource, no class for THIS version/field ⇒
        // unknown class ⇒ maximal mask. Key omitted (capability-not-text),
        // NEVER raw — the fail-closed version boundary (AC-4/AC-12, NF-3).
        continue;
      }
      // State U: ungoverned resource ⇒ legacy raw floor (classification is
      // additive; absence of governance is not a new denial of raw data).
      out[key] = raw;
      continue;
    }

    // Classified field ⇒ (class × clearance) transform. A corrupt class (not a
    // DataClass) drives selectTransform to the maximal `drop` (fail-closed).
    const transform = isDataClass(cls)
      ? selectTransform(cls, ctx.clearance)
      : "drop";
    if (transform === "drop") {
      // Key omitted — capability-not-text, the maximal mask.
      continue;
    }
    out[key] = applyTransform(raw, transform);
  }

  return out;
}

// ---------------------------------------------------------------------------
// from→to reclassification guard (pure validator; AC-10/AC-11)
// ---------------------------------------------------------------------------

/** The direction of a reclassification (down == WIDENING visibility). */
export type ReclassDirection = "up" | "down" | "lateral";

/** The decision a reclassification guard returns. */
export interface ReclassDecision {
  allowed: boolean;
  direction: ReclassDirection;
  reason: "ok" | "no_op_grant" | "direction_forbidden" | "unknown_class";
}

/**
 * Classify the direction of a `from→to` reclassification.
 *  - `down`    iff `to` is MORE visible (lower sensitivity rank) than `from` —
 *              a down-classification WIDENS reach, the privileged case (AC-11).
 *  - `up`      iff `to` is MORE sensitive (higher rank).
 *  - `lateral` iff equal rank.
 */
export function classifyDirection(
  from: DataClass,
  to: DataClass,
): ReclassDirection {
  const fromRank = classRank(from);
  const toRank = classRank(to);
  if (toRank < fromRank) return "down";
  if (toRank > fromRank) return "up";
  return "lateral";
}

/**
 * Read a grant's permitted reclassification direction, if any. Carried as a
 * typed marker on the grant's EXISTING opaque `constraint` / `resourceFacet`
 * surface (a `reclass` member whose value is a `ReclassDirection`) — NO schema
 * change to `Grant`, NO new authority algebra (NF-2). A grant with no marker
 * permits the (least-privileged) `up` direction only — fail-closed: a grant
 * that does not explicitly confer down-classification cannot widen visibility.
 */
function grantReclassDirection(grant: Grant): ReclassDirection {
  const fromConstraint = readReclassMarker(grant.constraint);
  if (fromConstraint !== null) return fromConstraint;
  const fromFacet = readReclassMarker(grant.resourceFacet);
  if (fromFacet !== null) return fromFacet;
  return "up";
}

/** Structurally read a `{ reclass: ReclassDirection }` marker off an opaque. */
function readReclassMarker(opaque: unknown): ReclassDirection | null {
  if (opaque === null || typeof opaque !== "object") return null;
  const r = (opaque as Record<string, unknown>)["reclass"];
  if (r === "up" || r === "down" || r === "lateral") return r;
  return null;
}

/**
 * Does a permitted direction subsume the requested direction? A `down`-permitted
 * grant subsumes every direction (down is the most privileged — it widens
 * visibility). A `lateral`-permitted grant subsumes `lateral` and `up`. An
 * `up`-permitted grant subsumes only `up`. This monotone subsumption is the
 * floor E4.6 dual-control keys on (AC-11) — it owns no new lattice math; it is a
 * total order over three direction tokens.
 */
function directionPrivilege(d: ReclassDirection): number {
  // Higher == more privileged.
  switch (d) {
    case "down":
      return 2;
    case "lateral":
      return 1;
    case "up":
      return 0;
  }
}

/**
 * The `from→to` reclassification guard. Pure validator (FR-5/FR-6, AC-10/AC-11):
 * changing a field's `class` is a `transition`/`approve` op routed through
 * `resolveFor` — never a raw write. This derives `allowed` from the SAME op-grant
 * rows the mutation guard already polices (it owns no new lattice math).
 *
 *  1. `from`/`to` must both be valid `DataClass` (a corrupt class ⇒
 *     `unknown_class`, fail-closed).
 *  2. The op must be a reclassification op-class (`transition` or `approve`); a
 *     non-reclass op confers no reclassification authority ⇒ `no_op_grant`.
 *  3. At least one covering grant must permit a direction that SUBSUMES the
 *     requested direction (down-classification needs explicit down authority);
 *     otherwise `direction_forbidden`.
 *
 * `coveringGrants` are the grants the gateway already resolved as covering the
 * reclassification handle for `op` — rights-derived-only; this guard adds no
 * second authority subsystem.
 */
export function evaluateReclassification(
  from: DataClass,
  to: DataClass,
  op: Operation,
  coveringGrants: Grant[],
): ReclassDecision {
  // 1. Both classes must be valid (fail-closed on a corrupt class).
  if (!isDataClass(from) || !isDataClass(to)) {
    return {
      allowed: false,
      direction: "lateral",
      reason: "unknown_class",
    };
  }

  const direction = classifyDirection(from, to);

  // 2. Reclassification is a transition/approve op-class action only.
  if (op !== "transition" && op !== "approve") {
    return { allowed: false, direction, reason: "no_op_grant" };
  }

  // 3. A covering grant must permit a direction that subsumes the request.
  const need = directionPrivilege(direction);
  const permitted = coveringGrants.some(
    (g) => directionPrivilege(grantReclassDirection(g)) >= need,
  );
  if (!permitted) {
    return { allowed: false, direction, reason: "direction_forbidden" };
  }

  return { allowed: true, direction, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Audit obligation shape (MAY emit; durable append → T-0053)
// ---------------------------------------------------------------------------

/**
 * The static-now T-0016 audit-obligation shape a value-suppressing mask
 * decision or a reclassification MAY produce (AC-16). Durable append is deferred
 * to T-0053 (matches T-0021 FR-8); the shape is DEFINED and PRODUCIBLE here, not
 * threaded into the frozen `ResolvedView` (no payload widening).
 */
export interface ClassificationAuditObligation {
  type: "mask_decision" | "reclassification";
  actor: string;
  subject: string;
  via: "grant_resolver" | "classification";
  decision: unknown;
}

/**
 * Build the audit-obligation shape for a value-suppressing mask decision
 * (`via="grant_resolver"`). Pure; producible in static-now (AC-16).
 */
export function maskAuditObligation(
  actor: string,
  subject: string,
  decision: unknown,
): ClassificationAuditObligation {
  return {
    type: "mask_decision",
    actor,
    subject,
    via: "grant_resolver",
    decision,
  };
}

/**
 * Build the audit-obligation shape for a reclassification transition
 * (`via="classification"`). Pure; producible in static-now (AC-16).
 */
export function reclassAuditObligation(
  actor: string,
  subject: string,
  decision: ReclassDecision,
): ClassificationAuditObligation {
  return {
    type: "reclassification",
    actor,
    subject,
    via: "classification",
    decision,
  };
}
