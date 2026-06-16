/**
 * T-0081 / E11.10 — Per-role field visibility: most-restrictive-wins post-filter
 *
 * Pure TS, no DB/IO/env. Zеркало purity-дисциплины data-classification.ts и
 * floor1-editor.ts.
 *
 * This module closes the §6 most-restrictive-wins gap: today visibleFields() in
 * grant-resolver.ts UNIONs field-sets across covering grants (most-PERMISSIVE).
 * roleFieldVisibility() receives the SAME already-filtered covering grants +
 * unionVisible and returns an INTERSECTION-based effective set that can only
 * NARROW unionVisible, never widen it.
 *
 * Semantic contract: docs/design/T-0081-field-visibility.adr.md §5, §6, §8.
 *
 * Authority-argument (no second path, no value-leak):
 *  1. Единственный PDP: видимость выводится ТОЛЬКО из covering-грантов, уже
 *     отфильтрованных resolveFor (tenant ∧ op ∧ effective ∧ scope). Этот модуль
 *     НЕ резолвит гранты, НЕ читает запись, НЕ читает БД.
 *  2. Только сужает: eff = unionVisible \ hideSet ⊆ unionVisible. Монотонно
 *     fail-closed: сомнение (роль не конферит поле явно) ⇒ скрыть.
 *  3. Нет утечки значения: скрытый ключ омитится в projectFields ДО любого
 *     clearance-маскинга (F-2/F-6). Значение не попадает в ResolvedView.fields.
 *
 * NOT IMPORTED: pg, fs, net, http, node:crypto, process.env, grant-lattice, data-classification,
 * object-handle, grant-resolver (no circular dependency, no second authority path).
 */

// ---------------------------------------------------------------------------
// Import — ONLY Grant type (same type the caller already has; no second resolution)
// ---------------------------------------------------------------------------
import { type Grant } from "./grant-lattice.js";

// ---------------------------------------------------------------------------
// FieldVisibilityPolicy (ADR §4.1 — pinned shape, no new store)
// ---------------------------------------------------------------------------

/**
 * Which record JSONB-keys are under per-role visibility (role-scoped), so that
 * most-restrictive intersection applies ONLY to them (not to whole-resource keys
 * where union-floor semantics would otherwise be broken).
 *
 * This is a pure input — NOT a new authority store. It is assembled by the edge
 * layer from the existing record_schema + data_classification rows (both already
 * exist; no new migration per ADR §11). When roleScopedFields is empty the
 * most-restrictive layer is a no-op (NF-1 byte-identical).
 */
export interface FieldVisibilityPolicy {
  /**
   * Names of JSONB-keys in the record schema whose visibility is per-role-scoped.
   * Derived from record_schema (fields with role-narrowing) + classification —
   * NOT a new authority-store, a projection of existing schema facts.
   * Empty set ⇒ no-op (backward-compatible, NF-1).
   */
  readonly roleScopedFields: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// FieldProjection (ADR §6.1 — edge-layer redaction marker)
// ---------------------------------------------------------------------------

/**
 * One field in a single-form response (edge layer, NOT in src/core PDP output).
 * Two structurally distinct states — impossible to confuse present-but-null
 * with redacted (ADR §6.1 Decision 4, F-3):
 *
 *   - visible: true  → field is present with its (possibly masked) value.
 *   - visible: false → field is redacted: key physically absent in PDP output;
 *                      edge carries label/id only — NO value key (F-3).
 *
 * T-0080 (cross-ref hop) reuses this exact shape for cross-reference redaction.
 */
export type FieldProjection =
  | { key: string; visible: true; value: unknown }
  | { key: string; visible: false; redacted: true; label: string };

// ---------------------------------------------------------------------------
// Helpers — derive per-role field-narrowing set from a single covering grant
// ---------------------------------------------------------------------------

/**
 * Extract the field-names a covering grant confers, if any.
 * Mirrors grantFacetFields in grant-resolver.ts but is LOCAL to this pure module
 * (no cross-import of grant-resolver internals; the caller supplies covering
 * grants from the same resolution step).
 *
 * Returns:
 *  - undefined → whole-resource grant (strictly-absent facet)
 *  - string[]  → the named fields (may be empty if malformed ⇒ fail-closed zero)
 */
function grantConferredFields(grant: Grant): string[] | undefined {
  const facet = grant.resourceFacet;
  // Strictly-absent ⇒ whole-resource (confers every field).
  if (facet === undefined || facet === null) return undefined;
  // Present but not an object ⇒ malformed ⇒ fail-closed zero.
  if (typeof facet !== "object") return [];
  const fields = (facet as Record<string, unknown>)["fields"];
  if (!Array.isArray(fields)) return [];
  // Only string field names count; non-strings are dropped.
  return fields.filter((f): f is string => typeof f === "string");
}

// ---------------------------------------------------------------------------
// roleFieldVisibility — THE pure most-restrictive post-filter (ADR §5.1)
// ---------------------------------------------------------------------------

/**
 * Per-role most-restrictive visible set over the T-0021 union-floor.
 *
 * Pure; no IO/DB/env. Derives everything from:
 *  @param coveringGrants  Grants resolveFor already filtered as covering
 *                         (tenant ∧ op ∧ effective ∧ scope) — the SAME grants.
 *  @param unionVisible    Result of visibleFields(covering, handleFacet, raw)
 *                         (axis-A union-floor) — most-restrictive only narrows.
 *  @param policy          Which keys are role-scoped; empty ⇒ no-op (NF-1).
 *
 * Rule (ADR §5, pinned):
 *  - If field f ∉ roleScopedFields → f stays in effective set unchanged (union-floor holds).
 *  - If field f ∈ roleScopedFields → f visible iff EVERY covering grant confers it
 *    (whole-resource OR facet ∋ f). Otherwise f goes to hideSet.
 *  - effectiveVisible = unionVisible \ hideSet ⊆ unionVisible (only narrows).
 *  - redactedFields = role-scoped fields that were in unionVisible but are now hidden.
 *
 * Monotone fail-closed: a role not conferring f explicitly ⇒ f is hidden.
 * A whole-resource grant confers every field (including role-scoped ones), so
 * a viewer whose EVERY role has whole-resource access still sees every field.
 *
 * @returns { effectiveVisible, redactedFields }
 */
export function roleFieldVisibility(
  coveringGrants: Grant[],
  unionVisible: ReadonlySet<string>,
  policy: FieldVisibilityPolicy,
): { effectiveVisible: Set<string>; redactedFields: string[] } {
  // Fast path: no role-scoped fields ⇒ no-op (NF-1 byte-identical to pre-T-0081).
  if (policy.roleScopedFields.size === 0) {
    return {
      effectiveVisible: new Set(unionVisible),
      redactedFields: [],
    };
  }

  // Fast path: no covering grants ⇒ nothing to show (should never reach here
  // because resolveFor denies before calling us, but be safe).
  if (coveringGrants.length === 0) {
    return {
      effectiveVisible: new Set(unionVisible),
      redactedFields: [],
    };
  }

  // For each covering grant, determine which fields it confers:
  //   - undefined (whole-resource) ⇒ confers ALL fields (including role-scoped)
  //   - string[]                   ⇒ confers exactly those names
  //
  // A role-scoped field f is visible iff EVERY grant confers it.
  // We compute this as: f is in hideSet iff any grant does NOT confer f.

  const hideSet = new Set<string>();

  for (const field of unionVisible) {
    // Only apply most-restrictive logic to role-scoped fields.
    if (!policy.roleScopedFields.has(field)) continue;

    // Check every covering grant: if ANY does not confer `field`, add to hideSet.
    for (const grant of coveringGrants) {
      const conferred = grantConferredFields(grant);
      if (conferred === undefined) {
        // Whole-resource grant: confers everything, including this role-scoped field.
        continue;
      }
      // Facet-narrowed grant: must explicitly include the field.
      if (!conferred.includes(field)) {
        hideSet.add(field);
        break; // One dissenting grant is enough to hide.
      }
    }
  }

  // effectiveVisible = unionVisible \ hideSet  (eff ⊆ unionVisible — only narrows)
  const effectiveVisible = new Set<string>();
  for (const f of unionVisible) {
    if (!hideSet.has(f)) {
      effectiveVisible.add(f);
    }
  }

  // redactedFields = role-scoped fields that were in unionVisible but now hidden.
  const redactedFields: string[] = [];
  for (const f of hideSet) {
    if (unionVisible.has(f)) {
      redactedFields.push(f);
    }
  }

  return { effectiveVisible, redactedFields };
}

// ---------------------------------------------------------------------------
// serverProjectForm — edge-layer single-form projection (ADR §6.2 Decision 5)
// ---------------------------------------------------------------------------

/**
 * Build the single-form projection (edge layer, NOT the PDP) from an already-
 * redacted ResolvedView.fields + redactedFields list + a form field schema.
 *
 * For each form field:
 *  - key present in resolvedFields → { visible: true, value }
 *  - key in redactedFields        → { visible: false, redacted: true, label }
 *  - key absent from both         → omitted (field not applicable for this viewer)
 *
 * Redaction is server-side: the value was NEVER placed in resolvedFields by the
 * PDP (physical key absence in capability-not-text). This edge function only
 * assembles the already-safe projection into the UI-policy shape.
 *
 * @param formFieldKeys   Ordered list of field keys in the form definition.
 * @param fieldLabels     Map of key → display label (from record schema).
 * @param resolvedFields  The already-redacted fields from ResolvedView.fields.
 * @param redactedFields  Fields physically absent (returned by roleFieldVisibility).
 * @returns FieldProjection[] — one entry per applicable form field.
 */
export function serverProjectForm(
  formFieldKeys: string[],
  fieldLabels: Record<string, string>,
  resolvedFields: Record<string, unknown>,
  redactedFields: string[],
): FieldProjection[] {
  const redactedSet = new Set(redactedFields);
  const result: FieldProjection[] = [];

  for (const key of formFieldKeys) {
    if (key in resolvedFields) {
      result.push({ key, visible: true, value: resolvedFields[key] });
    } else if (redactedSet.has(key)) {
      // Redacted: label/id only — no value key (F-3, ADR §6.1).
      const label = fieldLabels[key] ?? key;
      result.push({ key, visible: false, redacted: true, label });
    }
    // Otherwise: field not applicable for this viewer (not present, not redacted) — omit.
  }

  return result;
}
