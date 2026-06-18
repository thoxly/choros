/**
 * T-0085 · Record-Schema Validator
 *
 * Pure TypeScript module — no pg, fs, net, http, child_process, import.meta, process.env.
 * Validates record.data against historical JSON Schema for record.schema_version.
 * DATABASE_URL-free: unit-testable without DB connection.
 *
 * Exports:
 *   - SchemaHistoryMap: Map<number, object> — version → JSON Schema object
 *   - ValidationResult: { valid: boolean; errors: string[] }
 *   - validateRecordAgainstSchema(record, schemaHistory): ValidationResult
 *   - validateRecordSchemaDefinition(schema): ValidationResult  (T-0263 — schema-definition check)
 *
 * Implementation: AJV (pure in-process JSON Schema validator).
 * Caller is responsible for hydrating SchemaHistoryMap from registry_schema_history rows.
 */

import { Ajv } from 'ajv';
import type { ErrorObject } from 'ajv';

// ---------------------------------------------------------------------------
// Exported types (frozen public surface per ADR T-0085 §3.5)
// ---------------------------------------------------------------------------

/**
 * Map from schema version (integer) to JSON Schema object.
 * Key = version number; value = full JSON Schema for that version.
 * Caller hydrates from registry_schema_history rows.
 */
export type SchemaHistoryMap = Map<number, object>;

/**
 * Result of validating a record against its schema version.
 * valid = true iff record.data conforms to schema_version schema.
 * errors = array of validation error strings (AJV error messages or custom).
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Exported function (frozen public surface per ADR T-0085 §3.5)
// ---------------------------------------------------------------------------

/**
 * Validates record.data against the historical schema for record.schema_version.
 *
 * @param record - object with { data: object; schema_version: number }
 * @param schemaHistory - Map<version, JSON Schema object>
 * @returns ValidationResult: { valid: boolean; errors: string[] }
 *
 * Returns { valid: false, errors: ['schema version N not found in history'] }
 * if schemaHistory has no entry for record.schema_version.
 *
 * Pure: no pg/fs/net/http/child_process/import.meta/process.env.
 */
export function validateRecordAgainstSchema(
  record: { data: object; schema_version: number },
  schemaHistory: SchemaHistoryMap,
): ValidationResult {
  const schema = schemaHistory.get(record.schema_version);
  if (!schema) {
    return {
      valid: false,
      errors: [`schema version ${record.schema_version} not found in history`],
    };
  }

  // Initialize AJV (fresh instance to avoid state leaks).
  const ajv = new Ajv();

  try {
    // Compile the schema for this version.
    const validate = ajv.compile(schema);

    // Validate the record data against the schema.
    const valid = validate(record.data);

    if (valid) {
      return { valid: true, errors: [] };
    }

    // Extract error messages from AJV validation errors.
    const errors = (validate.errors ?? []).map(
      (err: ErrorObject) => `${err.schemaPath}: ${err.message ?? 'validation failed'}`,
    );

    return { valid: false, errors };
  } catch (err: unknown) {
    // Catch AJV compilation or validation exceptions.
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [`schema validation error: ${message}`],
    };
  }
}

// ---------------------------------------------------------------------------
// Schema-definition validation (T-0263 — registry_def field-schema authoring)
// ---------------------------------------------------------------------------

/**
 * Validates that `schema` is itself a well-formed JSON Schema definition — i.e.
 * that it is a non-null object AJV can compile in strict mode. This is the
 * field-schema authoring guard for registry_def create/update: a registry_def's
 * record_schema describes the application's record fields (properties = field map,
 * required = required-field array, each field carrying a `type`), so before we
 * persist it we confirm AJV accepts it as a compilable schema.
 *
 * This reuses the SAME AJV machinery as validateRecordAgainstSchema (one
 * validator, not two) — strict mode (AJV default) rejects malformed field
 * definitions (e.g. an unknown `type`, a non-object `properties`, a non-array
 * `required`), which surface as ValidationResult.errors for a 400 response.
 *
 * Pure: no pg/fs/net/http/child_process/import.meta/process.env.
 *
 * @param schema - the candidate record_schema (caller has already confirmed it is
 *                 a plain JSON object — array/null are rejected here defensively).
 * @returns ValidationResult: { valid: boolean; errors: string[] }
 */
export function validateRecordSchemaDefinition(schema: unknown): ValidationResult {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return {
      valid: false,
      errors: ['record_schema must be a JSON object (a JSON-Schema definition)'],
    };
  }

  // Fresh AJV instance (no state leak) — strict mode (default) is the field-def guard.
  const ajv = new Ajv();
  try {
    // compile() throws in strict mode if the schema definition is malformed
    // (unknown type, properties not an object, required not an array, …).
    ajv.compile(schema as object);
    return { valid: true, errors: [] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [`invalid record_schema definition: ${message}`],
    };
  }
}
