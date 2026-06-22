/**
 * src/core/form-submit-validator.ts — T-0400 [D7-2]
 *
 * RUNTIME form-submit validation: enforces the PD-9 invariant ("forms reference
 * only existing variables") AT SUBMIT TIME, closing the JSONB-drift gap identified
 * in spec §2 and T-0396.
 *
 * Gap (pre-T-0400): `applyStepResult` wrote formValues into the entity JSONB with
 * NO runtime re-validation — unknown keys silently landed in JSONB, enum options
 * weren't checked, fields removed from the live record_schema (drift) weren't caught.
 *
 * This module is the PURE validation core (no I/O — purity discipline identical to
 * binding-compat.ts / field-type-dictionary.ts). The DB-side loading (reading
 * form_binding.fields and registry_def.record_schema on the open tx client) lives
 * in src/db/step-applier.ts (the only I/O caller).
 *
 * Three validation rules (spec §3.2 / D7-2):
 *   1. UNKNOWN-KEY REJECTION: keys in submittedValues not declared in
 *      BindingField[].key → REJECT. Do not write them to JSONB.
 *   2. ENUM VALIDATION: for enum fields (contract==='enum' OR type==='enum'),
 *      the submitted value must appear in BindingField.options[]. If options is
 *      absent or empty, the enum check is skipped (backward compat — old
 *      snapshots pre-T-0399 may lack options).
 *   3. SCHEMA-DRIFT DETECTION: keys declared in BindingField[] but absent from
 *      the live record_schema.properties catch fields removed after the binding
 *      was authored. Drifted fields are flagged; if they appear in submittedValues
 *      they are also rejected as unknown keys (rule 1 subsumes them).
 *
 * Provenance fields (decision, approved_by, comment) are set by the server AFTER
 * the spread — they are NOT part of form_binding.fields and are never validated
 * here. The caller strips proto-pollution keys before passing submittedValues.
 *
 * What this module does NOT do:
 *   - Does NOT validate provenance / canonical fields (server controls those).
 *   - Does NOT validate types beyond enum (AJV on the full record schema handles
 *     type coercion — that is D7-3's domain).
 *   - Does NOT check required-ness (a field may be optional; the form only submits
 *     what the user filled in — missing-optional is valid).
 *   - Does NOT do I/O (pure function — no pg, no fs, no env reads).
 *
 * Pure: no pg / node:fs / node:http / node:net / child_process / import.meta /
 * process.env. Passes FF-NB-3 purity gate.
 */

import type { BindingField } from "./binding-compat.js";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * A single validation finding from validateFormSubmit.
 *
 *   unknown_key   — key present in submittedValues but NOT declared in BindingField[].
 *                   This key must NOT be written to JSONB.
 *   enum_mismatch — key present in submittedValues, field is enum-typed, submitted
 *                   value is NOT in BindingField.options[].
 *   schema_drift  — key declared in BindingField[] but NOT in live record_schema
 *                   properties. The binding references a field that no longer exists
 *                   in the live schema (authoring-time vs run-time drift).
 */
export type FormSubmitViolationType =
  | "unknown_key"
  | "enum_mismatch"
  | "schema_drift";

export interface FormSubmitViolation {
  type: FormSubmitViolationType;
  key: string;
  message: string;
}

/**
 * Outcome of validateFormSubmit.
 *
 *   ok: true  — all three rules pass; safeValues contains only validated keys
 *               (provenance fields are NOT included — the caller appends them).
 *   ok: false — one or more violations found; safeValues is absent.
 */
export type FormSubmitValidationResult =
  | { ok: true; safeValues: Record<string, unknown> }
  | { ok: false; violations: FormSubmitViolation[] };

// ---------------------------------------------------------------------------
// Record-schema property set helper
// ---------------------------------------------------------------------------

/**
 * Extract the set of top-level property keys from a JSON-Schema object.
 * Returns an empty Set when the schema is absent or has no `properties`.
 * Record schemas follow the pattern:
 *   { type: "object", properties: { <key>: { type: ... }, … }, required: […] }
 */
export function extractSchemaPropertyKeys(
  recordSchema: unknown,
): ReadonlySet<string> {
  if (
    recordSchema === null ||
    recordSchema === undefined ||
    typeof recordSchema !== "object" ||
    Array.isArray(recordSchema)
  ) {
    return new Set<string>();
  }
  const props = (recordSchema as Record<string, unknown>)["properties"];
  if (props === null || props === undefined || typeof props !== "object" || Array.isArray(props)) {
    return new Set<string>();
  }
  return new Set<string>(Object.keys(props as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// isEnumField — heuristic from BindingField
// ---------------------------------------------------------------------------

/**
 * Returns true iff this BindingField describes an enum: the field carries an
 * explicit `contract: 'enum'` (T-0399 D7-K) OR its `type` is the legacy
 * `'enum'` string (pre-T-0399 snapshots that lack the contract field).
 */
function isEnumField(field: BindingField): boolean {
  return field.contract === "enum" || field.type === "enum";
}

// ---------------------------------------------------------------------------
// PROTO_KEYS — must match the set in inbox.ts (kept in sync, not imported from
// there to preserve the purity of this module).
// ---------------------------------------------------------------------------

const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// ---------------------------------------------------------------------------
// validateFormSubmit — the pure core
// ---------------------------------------------------------------------------

/**
 * Validate submitted form values against the binding contract and live schema.
 *
 * @param submittedValues  — client-supplied formValues (already proto-stripped by
 *                           caller; provenance keys not yet added).
 * @param bindingFields    — BindingField[] from form_binding.fields (the snapshot
 *                           authored when the form was built). May carry contract /
 *                           options from T-0399 D7-K.
 * @param liveRecordSchema — The live registry_def.record_schema JSON-Schema object
 *                           for the approvals (or target) registry. Used for
 *                           schema-drift detection (rule 3). Pass `undefined` or
 *                           `null` to skip drift detection (backward compat when the
 *                           schema cannot be loaded).
 *
 * @returns FormSubmitValidationResult:
 *   ok=true  → safeValues (only validated keys; provenance fields NOT included).
 *   ok=false → violations (caller returns 422 or similar; nothing written).
 *
 * The canonical provenance keys (decision, approved_by, comment) are excluded from
 * `submittedValues` by the caller's proto-strip pass and are NOT part of
 * BindingField[] — so they are never reported as unknown_key violations here.
 *
 * STEP_CLASS_MARKER_KEY (__step_class) is the F1 marker stored in form_binding.fields
 * as an array member — it must not be validated against submitted values. It is
 * excluded from the binding-field set used here.
 */
export function validateFormSubmit(
  submittedValues: Record<string, unknown>,
  bindingFields: BindingField[],
  liveRecordSchema?: unknown,
): FormSubmitValidationResult {
  const violations: FormSubmitViolation[] = [];

  // Build the binding field map (key → BindingField), excluding the internal
  // __step_class marker (that is a form_binding implementation detail, not a
  // user-submitted field).
  const STEP_CLASS_MARKER = "__step_class";
  const fieldMap = new Map<string, BindingField>();
  for (const field of bindingFields) {
    if (field.key === STEP_CLASS_MARKER) continue;
    fieldMap.set(field.key, field);
  }

  // Live schema property keys (for drift detection).
  const schemaKeys = extractSchemaPropertyKeys(liveRecordSchema);
  const hasSchemaDrift = schemaKeys.size > 0; // skip drift check when schema unavailable

  // --- Rule 3 (schema drift): BindingField keys not in live schema ------------
  // Check ALL binding fields regardless of whether the user submitted a value for
  // them — a drifted field is a data-contract integrity issue at authoring time.
  if (hasSchemaDrift) {
    for (const [key] of fieldMap) {
      if (!schemaKeys.has(key)) {
        violations.push({
          type: "schema_drift",
          key,
          message: `field "${key}" is declared in form binding but no longer exists in the live record schema (schema drift)`,
        });
      }
    }
  }

  // --- Rules 1 & 2: per-submitted-key checks ---------------------------------
  // safeValues accumulates only the validated keys.
  const safeValues: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(submittedValues)) {
    // Defensive: proto keys should have been stripped by the caller already,
    // but strip them here as a second layer (defense-in-depth).
    if (PROTO_KEYS.has(key)) continue;

    const field = fieldMap.get(key);
    if (field === undefined) {
      // Rule 1: unknown key — not declared in form binding.
      violations.push({
        type: "unknown_key",
        key,
        message: `submitted key "${key}" is not declared in form_binding.fields`,
      });
      // Do NOT include this key in safeValues.
      continue;
    }

    // Rule 2: enum validation — only when options are present (T-0399 D7-K).
    if (isEnumField(field)) {
      const options = field.options;
      if (Array.isArray(options) && options.length > 0) {
        // The submitted value must be a string (enum values are strings) and must
        // appear in the declared options list.
        if (typeof value !== "string" || !options.includes(value)) {
          violations.push({
            type: "enum_mismatch",
            key,
            message:
              `field "${key}" is an enum; submitted value ${JSON.stringify(value)} is not in options [${options.map((o) => JSON.stringify(o)).join(", ")}]`,
          });
          continue;
        }
      }
      // If options absent/empty: enum option list not carried → skip check
      // (backward compat with pre-T-0399 snapshots).
    }

    // Value is valid: include in safeValues.
    safeValues[key] = value;
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }
  return { ok: true, safeValues };
}
