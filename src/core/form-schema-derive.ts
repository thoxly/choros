/**
 * src/core/form-schema-derive.ts — T-0337 [E15-S4]
 *
 * SINGLE-SOURCE FORM SCHEMA DERIVATION
 *
 * Derives a FormDef (server-side form validation contract) FROM a
 * registry_def.record_schema (JSON Schema object). This is the collapse of the
 * triple decoupling: instead of three independently-maintained definitions —
 *   1. form_binding.fields  (DB: process → field list, type "string"/etc.)
 *   2. form-schema.ts       (server: hardcoded FieldDef arrays per form)
 *   3. form-defs.js         (client: HTML strings in sandbox-iframe)
 * — the form schema is DERIVED from the single authoritative registry_def.record_schema.
 *
 * The derivation is one-directional:
 *   registry_def.record_schema (JSON Schema, AJV-compilable)
 *     → deriveFieldDefsFromSchema()
 *       → FieldDef[] (the same type used by form-schema.ts / form-validator.ts)
 *
 * Contract with form-defs.js (client UI layer):
 *   form-defs.js is NOT modified. It is the visual HTML layer for the two
 *   hardcoded ТЭЛ demo forms. The CI check forms-schema-binding.sh asserts that
 *   every data-field="<k>" in form-defs.js has a matching key: "<k>" in
 *   form-schema.ts — this invariant is preserved because form-schema.ts still
 *   exports the two hardcoded FormDef objects. The derivation path here is used
 *   for DYNAMIC / NEW forms whose schema is authored via the registry_def API.
 *
 * Contract with form_binding.fields (DB layer):
 *   form_binding.fields is a convenience cache / override surface (the binding
 *   tells the process which form to show). When a form_binding.fields row exists
 *   with type = "string" (legacy), normaliseBindingType() from field-type-dictionary
 *   maps it to "text". New rows should use FieldType directly. The derivation here
 *   replaces the need to maintain form_binding.fields as a SCHEMA authority — it is
 *   demoted to a process-routing hint, not a schema source.
 *
 * Pure data + pure functions — no I/O, no DB, no network, no env reads.
 * Mirrors the purity discipline of form-schema.ts / form-validator.ts.
 */

import { deriveFieldType, type JsonSchemaProperty } from "./field-type-dictionary.js";
import type { FieldDef, FormDef } from "./form-schema.js";

// ---------------------------------------------------------------------------
// JSON Schema root shape (what registry_def.record_schema looks like)
// ---------------------------------------------------------------------------

/**
 * Minimal shape of a registry_def.record_schema root object.
 * We only read `properties` and `required`; other JSON Schema keywords
 * (e.g. $schema, $id, additionalProperties, description) are ignored here.
 */
interface RecordSchemaRoot {
  readonly properties?: Record<string, JsonSchemaProperty>;
  readonly required?: readonly string[];
}

// ---------------------------------------------------------------------------
// deriveFieldDefsFromSchema — core derivation
// ---------------------------------------------------------------------------

/**
 * Derive a FieldDef[] from a JSON Schema object (registry_def.record_schema).
 *
 * For each property in schema.properties (in iteration order):
 *   - key     = property name
 *   - type    = deriveFieldType(propDef)                (field-type-dictionary)
 *   - required= key ∈ schema.required                   (top-level required array)
 *   - options = propDef.enum (string values only)       (for "enum" fields)
 *   - maxLength = propDef.maxLength                     (for text/textarea)
 *   - min / max = propDef.minimum / maximum             (for number)
 *
 * VALIDATION RULE DERIVATION (the internal blocker the spec names):
 *   The unified type dictionary maps schema↔binding↔form consistently, so
 *   form-validator.ts can use the same FieldDef whether it was hardcoded (form-schema.ts)
 *   or derived here. No separate validation codepath — one FieldDef, one validator.
 *
 * Fields that are not of type "object" at root level are skipped (not typical in
 * well-formed registry schemas, but defensive). Returns [] for null/non-object schemas.
 *
 * @param schema - the registry_def.record_schema value (parsed JSON object)
 * @returns FieldDef[] in property-iteration order
 */
export function deriveFieldDefsFromSchema(schema: unknown): FieldDef[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return [];
  }

  const root = schema as RecordSchemaRoot;
  if (!root.properties || typeof root.properties !== "object") {
    return [];
  }

  const requiredSet = new Set<string>(
    Array.isArray(root.required) ? (root.required as string[]) : [],
  );

  const fields: FieldDef[] = [];

  for (const [key, propDef] of Object.entries(root.properties)) {
    if (!propDef || typeof propDef !== "object") continue;

    const type = deriveFieldType(propDef);

    // Build the FieldDef — matches the exact shape form-validator.ts expects.
    const def: FieldDef = {
      key,
      type,
      ...(requiredSet.has(key) ? { required: true } : {}),
      // options: string enum values only (for "enum" fields)
      ...(type === "enum" && Array.isArray(propDef.enum)
        ? {
            options: (propDef.enum as unknown[])
              .filter((v): v is string => typeof v === "string"),
          }
        : {}),
      // maxLength: from JSON Schema maxLength keyword (string/textarea)
      ...(typeof (propDef as { maxLength?: unknown }).maxLength === "number"
        ? { maxLength: (propDef as { maxLength: number }).maxLength }
        : {}),
      // min / max: from JSON Schema minimum / maximum keywords (number)
      ...(typeof (propDef as { minimum?: unknown }).minimum === "number"
        ? { min: (propDef as { minimum: number }).minimum }
        : {}),
      ...(typeof (propDef as { maximum?: unknown }).maximum === "number"
        ? { max: (propDef as { maximum: number }).maximum }
        : {}),
    };

    fields.push(def);
  }

  return fields;
}

// ---------------------------------------------------------------------------
// deriveFormDefFromSchema — derives a complete FormDef with a given id
// ---------------------------------------------------------------------------

/**
 * Derive a complete FormDef from a registry_def.record_schema.
 *
 * The resulting FormDef is structurally identical to the hardcoded FormDef
 * objects in form-schema.ts and can be fed directly to validateFormSubmission
 * (via form-validator.ts) without any adaptation.
 *
 * @param formId     - the id to assign to the derived FormDef (e.g. registry slug)
 * @param schema     - the registry_def.record_schema (parsed JSON Schema object)
 * @returns FormDef  - { id: formId, fields: FieldDef[] }
 */
export function deriveFormDefFromSchema(formId: string, schema: unknown): FormDef {
  return {
    id: formId,
    fields: deriveFieldDefsFromSchema(schema),
  };
}
