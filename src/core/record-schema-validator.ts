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
 *
 * T-0663: AJV's default instance knows NOTHING about the JSON-Schema-standard
 * `format` keyword (email/date/date-time/uri/…) — with `strict` at its default
 * (true), `ajv.compile()` THROWS "unknown format ... ignored in schema" the
 * moment it sees ANY `format` keyword it doesn't recognise. This is a
 * compile-time failure: it happens before validate() ever inspects the record
 * data, so a registry_def whose schema carries `format:"email"` 400s on EVERY
 * write — including one where the email field is entirely absent/empty. See
 * ADR-T0663-email-format-record.md for the full incident writeup. Fix: register
 * the standard formats via ajv-formats on both AJV instances in this file (one
 * shared factory, §makeAjv below) so `format` keywords compile AND validate
 * correctly instead of being silently unknown.
 */

import { Ajv } from 'ajv';
import type { ErrorObject, Format, FormatDefinition } from 'ajv';
// ajv-formats ships an `export default` .d.ts over an actual CJS runtime module
// (no "type":"module" in its package.json) — under this repo's Node16 module
// resolution WITHOUT esModuleInterop, a plain `import addFormats from
// 'ajv-formats'` default-import mis-resolves to the module namespace object
// (TS2349 "not callable"), and so does `import addFormats = require(...)`
// used bare. `import ajvFormatsNs = require('ajv-formats')` + calling
// `ajvFormatsNs.default(ajv)` is the form that type-checks cleanly under this
// repo's Node16-without-esModuleInterop config — the same underlying default
// export the plain `require('ajv-formats')(ajv)` call would reach at runtime
// (verified: module.exports = exports = formatsPlugin; exports.default =
// formatsPlugin — both point at the identical function).
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ajvFormatsNs = require('ajv-formats');

/**
 * T-0663: JSON Schema's `format` keyword only constrains the SHAPE of a value
 * that is present — whether the value is allowed to be ABSENT at all is a
 * separate concern the schema already expresses via `required`. ajv-formats'
 * built-in `email`/`date`/`uri`/… string checkers do not know this convention:
 * they reject `""` just like any other malformed string, so a record_schema's
 * OPTIONAL email field with an untouched/blank UI control 400s if the empty
 * string ever reaches the validator (e.g. a client that sends `email: ""`
 * instead of omitting the key — the shipped web form omits it, but the server
 * is the source of truth and must not depend on that).
 *
 * We wrap each STRING format validator so `""` always passes the FORMAT check;
 * `required` (and AJV's own presence machinery) remains the sole authority over
 * whether the field may be blank at all. A non-empty malformed value
 * (`"not-an-email"`) is still rejected exactly as before — this only carves out
 * the empty string.
 *
 * ajv-formats registers each format in one of several shapes (verified against
 * the installed ajv-formats@3 at the module's Node runtime):
 *   - a compiled RegExp                 (email, uri, hostname, ipv4, ipv6, …)
 *   - a plain validate function         (uri, regex, byte, …)
 *   - a FormatDefinition object with a `.validate` (string|RegExp|function)
 *     (date, time, date-time, int32/int64/float/double, …)
 *   - the literal `true`/a boolean      (password, binary — no-op formats)
 * Only the numeric FormatDefinitions (int32/int64/float/double: `type:"number"`)
 * and the boolean no-ops are left untouched — everything else is string-shaped
 * and gets the empty-string carve-out.
 */
function emptyStringTolerant(format: Format): Format {
  if (typeof format === 'boolean' || typeof format === 'string') {
    // boolean: no-op format (e.g. password/binary) — nothing to wrap.
    // string: `format` naming ANOTHER already-registered format by name — ajv-formats
    // never registers this shape itself; pass through unchanged (safe default).
    return format;
  }
  if (format instanceof RegExp) {
    const re = format;
    return (str: string): boolean => str === '' || re.test(str);
  }
  if (typeof format === 'function') {
    // A bare FormatValidator<string> (ajv's Format union also allows
    // FormatValidator<number>, but ajv-formats never registers a bare function
    // for a number-typed format — those always come as a FormatDefinition<number>
    // object with an explicit type:"number", handled — untouched — below).
    const fn = format as (s: string) => boolean;
    return (str: string): boolean => str === '' || fn(str);
  }
  if (format.type === 'number') {
    return format; // numeric FormatDefinition (int32/int64/float/double) — not a string check
  }
  if (format.async === true) {
    return format; // async string format — none registered by ajv-formats today; leave untouched
  }
  // Remaining shape: FormatDefinition<string> (type is "string" or undefined, sync).
  // TS's conditional-type encoding of FormatDefinition<T> can't statically rule out
  // the number-typed sibling from this branch (type? is optional), but the two
  // `type === 'number'` / `async === true` guards above already excluded every
  // shape whose `validate` takes anything other than a string at runtime — the
  // cast documents that runtime guarantee rather than widening it. The return
  // value is built as a fresh object typed explicitly as FormatDefinition<string>
  // (rather than spread onto the still union-typed `format`) so the wrapped
  // `validate` — always `(s: string) => boolean` — type-checks against the
  // string-only branch of Format, not the number-typed sibling.
  const stringFormat = format as FormatDefinition<string>;
  const validate = stringFormat.validate;
  if (typeof validate === 'string' || validate instanceof RegExp) {
    // validate is itself a string/RegExp pattern (FormatDefinition<string> shorthand).
    const re = validate instanceof RegExp ? validate : new RegExp(validate);
    const wrapped: FormatDefinition<string> = {
      ...stringFormat,
      validate: (str: string): boolean => str === '' || re.test(str),
    };
    return wrapped;
  }
  const fn = validate;
  const wrapped: FormatDefinition<string> = {
    ...stringFormat,
    validate: (str: string): boolean => str === '' || fn(str),
  };
  return wrapped;
}

/**
 * Single factory for this module's two AJV instances (validateRecordAgainstSchema,
 * validateRecordSchemaDefinition) — both need the exact same format vocabulary so
 * a schema that compiles for one behaves identically for the other.
 *
 * ajv-formats registers the full "formats" draft-07 vocabulary; we deliberately
 * DO NOT pass a `formats` allowlist so the DEFAULT set from ajv-formats prevails
 * (JSON-Schema-standard string formats: date, time, date-time, email — RFC 5321
 * mailbox grammar — uri, uri-reference, uuid, ipv4, ipv6, hostname, regex, …).
 * Registering the full set costs nothing (pure regex/predicates, no I/O) and
 * means any of these keywords a schema author reaches for (not just email/date)
 * compiles and validates correctly, rather than failing one keyword at a time as
 * each is separately discovered in production.
 *
 * After registering, every string-shaped format is wrapped with
 * emptyStringTolerant() (see above) so an optional field left blank never
 * fails the FORMAT check — only `required` governs presence.
 */
function makeAjv(): Ajv {
  const ajv = new Ajv();
  ajvFormatsNs.default(ajv);
  for (const name of Object.keys(ajv.formats)) {
    const current = ajv.formats[name];
    if (current) {
      ajv.addFormat(name, emptyStringTolerant(current));
    }
  }
  return ajv;
}

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

  // Initialize AJV (fresh instance to avoid state leaks; T-0663: with formats registered).
  const ajv = makeAjv();

  try {
    // T-0444: Strip x-* extensions before compile (same as validateRecordSchemaDefinition).
    // The persisted schema retains x-relation; the strip is compile-local only.
    const compilableSchema = stripXExtensions(schema as Record<string, unknown>);

    // Compile the schema for this version.
    const validate = ajv.compile(compilableSchema);

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
 * T-0444: AJV strict mode rejects ALL unknown keywords, including the x-* extension
 * convention (JSON Schema §6.4: "x-" prefixed keywords SHOULD be ignored by validators
 * that don't know them, but AJV strict enforces the stricter "error on unknown" policy).
 * We strip x-* keys from each property definition before compiling, then treat the
 * stripped schema as the AJV-compilable structural skeleton. The original schema (with
 * x-relation) is persisted and returned as-is; only compilation uses the stripped form.
 * This is additive and non-destructive: the x-relation contract (PINNED for T-0445)
 * is preserved in the database.
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

  // T-0444: Strip x-* keywords from each property definition so AJV strict mode
  // can compile the structural skeleton. The persisted schema retains x-* keys.
  const strippedSchema = stripXExtensions(schema as Record<string, unknown>);

  // Fresh AJV instance (no state leak; T-0663: with formats registered) — strict
  // mode (default) is the field-def guard.
  const ajv = makeAjv();
  try {
    // compile() throws in strict mode if the schema definition is malformed
    // (unknown type, properties not an object, required not an array, …).
    ajv.compile(strippedSchema);
    return { valid: true, errors: [] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [`invalid record_schema definition: ${message}`],
    };
  }
}

/**
 * T-0444 / T-0510: Produce a stripped copy of a record_schema where:
 *   1. Every property definition has its `x-*` keys removed (AJV strict rejects them).
 *      This covers x-relation (T-0444), x-rollup (T-0452), x-money (T-0509).
 *   2. Root-level `x-*` keys are removed (T-0510 added `x-field-order` at the root
 *      level; AJV strict rejects unknown root keywords just as it rejects unknown
 *      per-property keywords).
 *
 * Returns a new object; the original is not mutated.
 */
function stripXExtensions(schema: Record<string, unknown>): Record<string, unknown> {
  // Strip root-level x-* keys (T-0510: x-field-order lives here).
  const rootStripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!k.startsWith('x-')) rootStripped[k] = v;
  }

  const props = rootStripped['properties'];
  if (props === null || typeof props !== 'object' || Array.isArray(props)) {
    return rootStripped; // no properties to strip → return root-stripped copy
  }
  const strippedProps: Record<string, unknown> = {};
  for (const [key, propDef] of Object.entries(props as Record<string, unknown>)) {
    if (propDef !== null && typeof propDef === 'object' && !Array.isArray(propDef)) {
      const stripped: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(propDef as Record<string, unknown>)) {
        if (!k.startsWith('x-')) stripped[k] = v;
      }
      strippedProps[key] = stripped;
    } else {
      strippedProps[key] = propDef;
    }
  }
  return { ...rootStripped, properties: strippedProps };
}
