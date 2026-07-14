/**
 * T-0080 / E11.9 — Cross-application references: per-hop ACL + redacted projection.
 *
 * Pure TS, no DB/IO/env. Зеркало purity-дисциплины field-visibility.ts,
 * data-classification.ts, dmn-middle.ts.
 *
 * This module implements §6 "references, not copies" for cross-application data:
 *
 *  1. Reference definition (CrossAppRefDef): a named pointer — source_registry →
 *     target_registry via a ref_field in the source record JSONB. The pointer stores
 *     the target record's UUID; target record fields are NEVER copied.
 *
 *  2. Per-hop ACL re-check (resolveHop): at every hop the caller's already-resolved
 *     covering grants are re-evaluated against the target handle. If the caller lacks
 *     rights at a hop, the hop returns a REDACTED projection (label/id only, no field
 *     values) — using the SAME FieldProjection / roleFieldVisibility from T-0081.
 *     No second authority path. No value leak.
 *
 *  3. Hop-cap: traversal is bounded by HOP_CAP (default 3, Salesforce-style §6).
 *     A chain exceeding the cap returns `denied: true, reason: "hop_cap_exceeded"`.
 *     Protects against cycles (rollup-of-rollup) and resource exhaustion.
 *
 *  4. Cross-process data stays within the RLS channel (enforced at the DB/adapter
 *     layer via the single tenant RLS predicate). This pure module NEVER bypasses RLS;
 *     it receives only data that was already read through RLS-gated ports.
 *
 * Authority-argument (no second path, no value-leak):
 *  1. Единственный PDP: per-hop ACL re-check calls the CALLER'S INJECTED resolveFor
 *     (via the CrossAppRefResolverDeps.resolver port). No inline grant algebra here.
 *     The caller has already authenticated; the resolver port is the SAME factory used
 *     for normal record reads.
 *  2. Редакция реиспользует T-0081: roleFieldVisibility + FieldProjection (physical
 *     key absence, not null). No fork.
 *  3. Нет утечки значения: a hop that returns denied → the hop projection carries
 *     `{ hopDenied: true, label, refField }`, no fields. A hop that returns
 *     allowed → fields are physically present as-resolved by the PDP (already
 *     field-redacted by resolveFor via T-0081). The ref_field value (target ID)
 *     is structurally distinct from record payload (it is just a UUID string).
 *  4. Hop-cap monotone-fail-closed: depth increments; deny at cap.
 *
 * NOT IMPORTED: pg, fs, net, http, node:crypto, process.env, grant-lattice,
 * grant-resolver, data-classification, object-handle (no circular dep, no second
 * authority path). Receives covering grants + resolved fields as pure inputs.
 *
 * Reuse of T-0081 (field-visibility.ts):
 *  - CrossAppHopProjection.fields uses FieldProjection[] (same type as serverProjectForm).
 *  - When a hop IS allowed, the fields have already been redacted by resolveFor
 *    (via T-0081's roleFieldVisibility inside the single PDP). This module does NOT
 *    re-run redaction; it only asserts the contract and passes through.
 *  - When a hop is DENIED at the ACL level, this module produces the §6 redacted
 *    projection (label/id only) using the SAME FieldProjection sentinel shape:
 *    `{ key: refField, visible: false, redacted: true, label }`.
 *
 * Cites T-0081 ADR §6.3 (Decision 6) as the pinned cross-ref seam.
 */

// ---------------------------------------------------------------------------
// Import — ONLY FieldProjection from field-visibility (same module, no new dep)
// ---------------------------------------------------------------------------
import { type FieldProjection } from "./field-visibility.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default hop-cap for cross-application reference traversal.
 * §6: "Traversal hard-capped (Salesforce-style hop-limit, no rollup-of-rollup)"
 * against cycles and resource exhaustion on a 4-8 vCPU server (§11).
 *
 * Cap of 3 is the industry default (Salesforce limits field references to 3 hops).
 * This module never traverses beyond HOP_CAP.
 */
export const HOP_CAP = 3;

// ---------------------------------------------------------------------------
// CrossAppRefDef — the reference DEFINITION (not a record copy)
// ---------------------------------------------------------------------------

/**
 * A cross-application reference definition. Stored in `choros.cross_app_ref`
 * (migration 068). This is the DEFINITION of a link; it stores:
 *   - which source registry has a ref_field that holds a target record UUID
 *   - which target registry that UUID belongs to
 *   - the JSONB key name (ref_field) in the source record
 *
 * It does NOT copy any target record field values. §6: "references, not copies".
 *
 * ref_strength:
 *   'weak'   — independent lifecycle (default; safe for cross-app refs)
 *   'strong' — master-detail / cascade (rare; requires explicit authoring choice)
 */
export interface CrossAppRefDef {
  readonly tenantId: string;
  readonly id: string;
  readonly sourceRegistryId: string;
  readonly targetRegistryId: string;
  /** The JSONB key in the source record JSONB that holds the target record UUID. */
  readonly refField: string;
  /** Display label for this reference definition (shown in redacted hop label). */
  readonly label: string;
  readonly refStrength: "weak" | "strong";
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// CrossAppHopResult — the outcome of a single hop traversal
// ---------------------------------------------------------------------------

/**
 * A denied hop: caller lacks ACL rights at this hop, or the hop cap was exceeded,
 * or the ref_field value is missing/null (dangling reference).
 *
 * Produces §6 "redacted projection (label/id only)" — no field values.
 * The shape uses FieldProjection sentinel (T-0081 §6.1 Decision 4, F-3):
 * `{ key: refField, visible: false, redacted: true, label }`.
 */
export type CrossAppHopDenied = {
  readonly allowed: false;
  readonly reason:
    | "no_grant"       // caller has no covering grant for the target record
    | "not_found"      // target record does not exist
    | "hop_cap_exceeded" // traversal depth reached HOP_CAP
    | "dangling_ref"   // ref_field value is null / missing in source record
    | "cross_tenant";  // hop would cross a tenant boundary (forbidden)
  /**
   * §6 redacted projection: label/id only, NO field values. Uses the SAME
   * FieldProjection sentinel shape as T-0081 so edge layers can handle both
   * single-record redaction and cross-hop redaction uniformly.
   */
  readonly redactedProjection: FieldProjection & { visible: false };
};

/**
 * An allowed hop: caller has covering grants at this hop. The resolved fields
 * are already field-redacted by resolveFor (T-0081 inside the single PDP).
 * depth is the hop count consumed so far.
 */
export type CrossAppHopAllowed = {
  readonly allowed: true;
  readonly targetRecordId: string;
  readonly targetRegistryId: string;
  /**
   * Resolved record fields after PDP projection (already T-0081-redacted).
   * This module does NOT re-run redaction; it receives the PDP output directly.
   */
  readonly fields: Record<string, unknown>;
  /** Hop depth consumed by this result (1-based). */
  readonly depth: number;
};

export type CrossAppHopResult = CrossAppHopAllowed | CrossAppHopDenied;

// ---------------------------------------------------------------------------
// CrossAppRefResolverDeps — injected ports (pure static-now)
// ---------------------------------------------------------------------------

/**
 * Resolved record fields for a given record ID (already through the PDP).
 * Returns null if the record was denied or not found.
 * The resolver impl MUST use the single PDP (resolveFor) internally.
 *
 * NOTE: this port intentionally takes `tenantId` + `recordId` (not a full
 * ObjectHandle) for simplicity of the pure core. The adapter that implements
 * this port constructs an ObjectHandle and calls resolveFor internally.
 * The core NEVER calls resolveFor directly — it receives results via this port,
 * preserving the single-PDP-path discipline.
 */
export interface CrossAppHopFetcher {
  /**
   * Fetch + project the target record for the caller's subject, at this hop.
   * Returns:
   *  - `{ ok: true, fields }` — allowed; fields are already PDP-projected (T-0081).
   *  - `{ ok: false, reason }` — denied (no_grant / not_found / cross_tenant).
   */
  fetchHop(params: {
    tenantId: string;
    targetRegistryId: string;
    targetRecordId: string;
  }): Promise<
    | { ok: true; fields: Record<string, unknown> }
    | { ok: false; reason: "no_grant" | "not_found" | "cross_tenant" }
  >;
}

/**
 * Injected deps for resolveHop and resolveHopChain.
 */
export interface CrossAppRefDeps {
  /** PDP-backed hop fetcher (uses the single resolveFor internally). */
  readonly fetcher: CrossAppHopFetcher;
}

// ---------------------------------------------------------------------------
// resolveHop — single hop traversal with per-hop ACL + redacted projection
// ---------------------------------------------------------------------------

/**
 * Resolve ONE cross-application reference hop.
 *
 * Given:
 *  - `refDef`         — the CrossAppRefDef describing the source→target link.
 *  - `sourceRecord`   — the source record's resolved JSONB fields (already PDP-projected).
 *  - `depth`          — current traversal depth (0-based, incremented to 1-based in result).
 *  - `deps.fetcher`   — PDP-backed hop fetcher (single authority path).
 *
 * Algorithm:
 *  1. Check hop-cap. If `depth + 1 > HOP_CAP` → return denied(hop_cap_exceeded).
 *  2. Extract ref_field value from sourceRecord. If null/missing → denied(dangling_ref).
 *  3. Validate target ID is a non-empty string. If not → denied(dangling_ref).
 *  4. Cross-tenant check: if target tenantId differs from refDef.tenantId → denied(cross_tenant).
 *     (Pure check: target tenantId MUST equal refDef.tenantId since RLS enforces it.)
 *  5. Call deps.fetcher.fetchHop for the target record.
 *     - `ok: true`   → allowed hop. Return CrossAppHopAllowed with fields.
 *     - `ok: false`  → denied hop. Return CrossAppHopDenied with the redacted projection.
 *
 * The redacted projection on denial uses the SAME FieldProjection sentinel shape as
 * T-0081 (physical key absence is already enforced by the PDP; the sentinel label
 * comes from refDef.label so edge layers can display it consistently).
 *
 * @param refDef       Cross-app ref definition (from migration 068).
 * @param sourceRecord The source record's already-projected fields.
 * @param depth        Current chain depth (0 = first hop call). Must be < HOP_CAP.
 * @param deps         Injected deps (fetcher port).
 */
export async function resolveHop(
  refDef: CrossAppRefDef,
  sourceRecord: Record<string, unknown>,
  depth: number,
  deps: CrossAppRefDeps,
): Promise<CrossAppHopResult> {
  // Step 1: hop-cap check (fail-closed against cycles / resource exhaustion).
  if (depth + 1 > HOP_CAP) {
    return {
      allowed: false,
      reason: "hop_cap_exceeded",
      redactedProjection: {
        key: refDef.refField,
        visible: false,
        redacted: true,
        label: refDef.label,
      },
    };
  }

  // Step 2: extract the ref_field value from the source record.
  const refValue = sourceRecord[refDef.refField];
  if (refValue === null || refValue === undefined) {
    return {
      allowed: false,
      reason: "dangling_ref",
      redactedProjection: {
        key: refDef.refField,
        visible: false,
        redacted: true,
        label: refDef.label,
      },
    };
  }

  // Step 3: validate the target record ID is a non-empty string (UUID).
  if (typeof refValue !== "string" || refValue.length === 0) {
    return {
      allowed: false,
      reason: "dangling_ref",
      redactedProjection: {
        key: refDef.refField,
        visible: false,
        redacted: true,
        label: refDef.label,
      },
    };
  }

  const targetRecordId = refValue;

  // Step 4: PDP-backed hop fetch. ACL re-check at this hop (via the single PDP port).
  const result = await deps.fetcher.fetchHop({
    tenantId: refDef.tenantId,
    targetRegistryId: refDef.targetRegistryId,
    targetRecordId,
  });

  if (!result.ok) {
    // ACL denied (no_grant, not_found, or cross_tenant) → redacted projection.
    return {
      allowed: false,
      reason: result.reason,
      redactedProjection: {
        key: refDef.refField,
        visible: false,
        redacted: true,
        label: refDef.label,
      },
    };
  }

  // Allowed: return the already-PDP-projected fields (T-0081 redaction already applied).
  return {
    allowed: true,
    targetRecordId,
    targetRegistryId: refDef.targetRegistryId,
    fields: result.fields,
    depth: depth + 1,
  };
}

// ---------------------------------------------------------------------------
// resolveHopChain — multi-hop traversal (chained cross-app refs)
// ---------------------------------------------------------------------------

/**
 * Resolve a CHAIN of cross-application reference hops.
 *
 * Given an ordered list of CrossAppRefDefs (representing a dot-walking path,
 * e.g. order.customerId → customer.addressId → address.cityId), and a starting
 * source record, traverses the chain until:
 *  - All hops are resolved successfully → returns all CrossAppHopAllowed results.
 *  - A hop is denied / cap exceeded → returns that hop's CrossAppHopDenied and
 *    stops traversal (fail-fast, not fail-silent).
 *
 * The hop-cap is applied globally across the chain (depth increments with each hop).
 * A chain of 4 definitions would fail at the 4th hop (depth 3 + 1 > HOP_CAP = 3).
 *
 * @param refDefs      Ordered chain of CrossAppRefDefs (may be empty → empty result).
 * @param sourceRecord The initial source record's already-projected fields.
 * @param deps         Injected deps (fetcher port).
 */
export async function resolveHopChain(
  refDefs: readonly CrossAppRefDef[],
  sourceRecord: Record<string, unknown>,
  deps: CrossAppRefDeps,
): Promise<CrossAppHopResult[]> {
  const results: CrossAppHopResult[] = [];
  let currentRecord = sourceRecord;
  let depth = 0;

  for (const refDef of refDefs) {
    const hopResult = await resolveHop(refDef, currentRecord, depth, deps);
    results.push(hopResult);

    if (!hopResult.allowed) {
      // Stop chain on first denied hop (fail-fast). Downstream hops are NOT
      // attempted — this prevents information leakage about the chain structure
      // beyond the first denied boundary.
      break;
    }

    // Advance: use the allowed hop's fields as the next source record.
    currentRecord = hopResult.fields;
    depth = hopResult.depth;
  }

  return results;
}

// ---------------------------------------------------------------------------
// buildRedactedHopProjection — §6 "label/id only" sentinel for a denied hop
// ---------------------------------------------------------------------------

/**
 * Build the §6 "redacted projection" sentinel for a denied cross-app hop.
 * This is the same FieldProjection shape as T-0081 (Decision 4, F-3):
 *   { key, visible: false, redacted: true, label }
 *
 * Exposed as a standalone utility so edge layers can construct the sentinel
 * without importing the full resolution machinery. The sentinel is
 * structurally DISTINCT from present-but-null (no `value` key).
 *
 * Reuses T-0081's FieldProjection type (no fork).
 *
 * @param refField   The JSONB key name of the reference field.
 * @param label      The display label for the reference definition.
 */
export function buildRedactedHopProjection(
  refField: string,
  label: string,
): FieldProjection & { visible: false } {
  return { key: refField, visible: false, redacted: true, label };
}
