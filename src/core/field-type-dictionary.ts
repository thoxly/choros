/**
 * src/core/field-type-dictionary.ts — T-0337 [E15-S4]
 *
 * UNIFIED FIELD-TYPE DICTIONARY — one canonical vocabulary shared across:
 *   1. registry_def.record_schema (JSON Schema / AJV validation layer)
 *   2. form_binding.fields        (DB binding layer: process → field list)
 *   3. form-schema.ts FieldDef    (server-side form validation rules)
 *   4. form-defs.js               (client UI widget classes — read-only ref)
 *
 * Before this module, each layer maintained its own ad-hoc type strings:
 *   form-schema.ts  : "text" | "textarea" | "number" | "date" | "enum" | "boolean"
 *   form_binding    : "string" | "number" | "boolean" (migration 045 seed)
 *   record_schema   : JSON Schema "type": "string" | "number" | "boolean" + "enum"
 *
 * This module canonicalises the mapping so deriving validation rules from a
 * registry_def.record_schema is mechanical and consistent.
 *
 * Pure data + pure functions — no I/O, no DB, no network, no env reads.
 * Mirrors the purity discipline of form-schema.ts / form-validator.ts.
 */

// ---------------------------------------------------------------------------
// Canonical FieldType (re-exported from form-schema.ts — single definition)
// ---------------------------------------------------------------------------

/**
 * The single canonical field-type vocabulary for Choros forms.
 *
 * Maps to:
 *   JSON Schema type  → FieldType
 *   ─────────────────────────────────────────────────────────────────────
 *   string (no enum)  → "text"     (default; use "textarea" via x-choros-widget)
 *   string + enum[]   → "enum"     (select / radio; options = enum values)
 *   number / integer  → "number"   (numeric input)
 *   boolean           → "boolean"  (checkbox)
 *   string + format=date  → "date"     (date picker; dd.MM.yyyy)
 *   string + format=uri   → "url"      (URL input)
 *   string + format=email → "email"    (email input)
 *   string + x-choros-widget=textarea → "textarea" (multi-line)
 *
 * form-defs.js widget class mapping (read-only ref for UI layer):
 *   "text"      → .fjs-form-field-textfield
 *   "textarea"  → .fjs-form-field-textarea
 *   "number"    → .fjs-form-field-number
 *   "date"      → .fjs-form-field-datetime
 *   "enum"      → .fjs-form-field-select / .fjs-form-field-radio
 *   "boolean"   → .fjs-form-field-checkbox / .fjs-form-field-checklist
 */
export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "enum"
  | "boolean"
  | "url"
  | "email"
  | "person"
  | "multi-select";

// ---------------------------------------------------------------------------
// form_binding FieldType vocabulary (DB layer: the stored type in form_binding.fields)
// ---------------------------------------------------------------------------

/**
 * The type vocabulary used in form_binding.fields (DB binding layer).
 *
 * LEGACY (migration 045 seed): the original binding used "string" / "number" /
 * "boolean" (coarse JSON types). The canonical mapping below lets code that reads
 * form_binding.fields convert to FieldType without special-casing.
 *
 * New form_binding rows should use FieldType directly. The legacy values are
 * kept here for backward compatibility with existing seeds.
 */
export type BindingFieldType =
  | FieldType           // preferred: use canonical FieldType in new rows
  | "string"            // legacy alias for "text"
  | "integer";          // legacy alias for "number"

// ---------------------------------------------------------------------------
// Mapping: binding type → canonical FieldType
// ---------------------------------------------------------------------------

/**
 * Normalise a form_binding.fields[].type value (which may use the legacy coarse
 * vocabulary from migration 045) to the canonical FieldType.
 *
 * "string"  → "text"
 * "integer" → "number"
 * Everything else is passed through unchanged (it is already a FieldType, or
 * unknown — callers should treat unknown as "text" for safe degradation).
 */
export function normaliseBindingType(raw: string): FieldType {
  switch (raw) {
    case "string":  return "text";
    case "integer": return "number";
    // Already a FieldType — pass through.
    case "text":
    case "textarea":
    case "number":
    case "date":
    case "enum":
    case "boolean":
    case "url":
    case "email":
    case "person":
    case "multi-select":
      return raw;
    default:
      // Unknown type: degrade to "text" (safe; server will accept strings).
      return "text";
  }
}

// ---------------------------------------------------------------------------
// Mapping: JSON Schema property → FieldType
// (Used by form-schema-derive.ts to derive FieldDef[] from record_schema)
// ---------------------------------------------------------------------------

/**
 * Shape of a single JSON Schema property definition as stored in
 * registry_def.record_schema.properties[key].
 *
 * We only read the fields relevant to FieldType derivation; additionalProperties
 * are ignored (AJV handles validation of the rest).
 */
export interface JsonSchemaProperty {
  readonly type?: string | readonly string[];
  /** If present, the field is an enum with this allowed-values set. */
  readonly enum?: readonly unknown[];
  /** Hint for multi-line text widgets. */
  readonly "x-choros-widget"?: string;
  /** JSON Schema date format hint. */
  readonly format?: string;
  /** Human-readable field label (JSON Schema "title"). */
  readonly title?: string;
  /** Optional description. */
  readonly description?: string;
}

/**
 * Derive the canonical FieldType from a JSON Schema property definition.
 *
 * Mapping rules (applied in order):
 *   1. enum[] present                → "enum"    (regardless of type)
 *   2. type = "boolean"              → "boolean"
 *   3. type = "number" | "integer"   → "number"
 *   4. format = "date"               → "date"
 *   5. format = "uri"                → "url"
 *   6. format = "email"              → "email"
 *   7. x-choros-widget = "textarea"  → "textarea"
 *   8. type = "string" (default)     → "text"
 *   9. unknown / absent              → "text"    (safe degradation)
 */
export function deriveFieldType(prop: JsonSchemaProperty): FieldType {
  // 1. Enum (select / radio) — takes precedence over raw type.
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return "enum";
  }

  const rawType = Array.isArray(prop.type)
    ? (prop.type as string[]).find((t) => t !== "null") ?? "string"
    : (prop.type as string | undefined) ?? "string";

  // 2. Boolean
  if (rawType === "boolean") return "boolean";

  // 3. Numeric
  if (rawType === "number" || rawType === "integer") return "number";

  // 4. Date (string + format: date)
  if (rawType === "string" && prop.format === "date") return "date";

  // 5. URL (string + format: uri)
  if (rawType === "string" && prop.format === "uri") return "url";

  // 6. Email (string + format: email)
  if (rawType === "string" && prop.format === "email") return "email";

  // 7. Multi-line text (string + x-choros-widget: textarea)
  if (rawType === "string" && prop["x-choros-widget"] === "textarea") return "textarea";

  // 6-7. Default to text
  return "text";
}

// ---------------------------------------------------------------------------
// Widget class lookup (for documentation / UI layer awareness — not used server-side)
// ---------------------------------------------------------------------------

/**
 * Returns the primary form-js CSS class for a FieldType.
 * Informational only — the actual widget is rendered client-side in form-defs.js.
 * Exported so the UI derivation layer (if any) can stay consistent.
 */
export function fieldTypeToWidgetClass(type: FieldType): string {
  switch (type) {
    case "text":         return "fjs-form-field-textfield";
    case "textarea":     return "fjs-form-field-textarea";
    case "number":       return "fjs-form-field-number";
    case "date":         return "fjs-form-field-datetime";
    case "enum":         return "fjs-form-field-select";
    case "boolean":      return "fjs-form-field-checkbox";
    case "url":          return "fjs-form-field-textfield";
    case "email":        return "fjs-form-field-textfield";
    case "person":       return "fjs-form-field-textfield";
    case "multi-select": return "fjs-form-field-select";
    default: {
      // Exhaustiveness guard — the cast asserts all FieldType values are handled above.
      void (type as never);
      return "fjs-form-field-textfield";
    }
  }
}
