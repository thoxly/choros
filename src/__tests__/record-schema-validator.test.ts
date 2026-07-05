/**
 * T-0085 · Record-Schema Validator Unit Tests
 *
 * AC-7: validateRecordAgainstSchema validates record.data against historical schema.
 * AC-10: Tests run without DATABASE_URL (no pg, fs, net, http imports).
 *
 * Covers:
 *   - FF-RSV-3 v1 pass: record under v1 passes v1 schema validation
 *   - FF-RSV-3 v2 fail: record under v1 fails v2 schema when v2 adds required field
 *   - FF-RSV-3 missing: missing schema version in history returns error
 */

import { describe, it, expect } from 'vitest';
import {
  validateRecordAgainstSchema,
  validateRecordSchemaDefinition,
  type SchemaHistoryMap,
  type ValidationResult,
} from '../core/record-schema-validator.js';

// Type-level usage: ensures ValidationResult is exercised (AC-7 surface check).
function assertResult(r: ValidationResult): void {
  if (!r.valid && r.errors.length === 0) {
    throw new Error('invalid result has no errors');
  }
}

// ---------------------------------------------------------------------------
// AC-7: v1 pass / v2 fail / missing version
// ---------------------------------------------------------------------------

describe('record-schema-validator', () => {
  it('FF-RSV-3 v1 pass: record validates against v1 schema', () => {
    // v1 schema: only requires 'name' field (string type)
    const v1Schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    };

    const schemaHistory: SchemaHistoryMap = new Map([
      [1, v1Schema],
    ]);

    const record = {
      data: { name: 'Alice' },
      schema_version: 1,
    };

    const result = validateRecordAgainstSchema(record, schemaHistory);
    assertResult(result);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('FF-RSV-3 v2 fail: v1 record fails v2 schema when required field added', () => {
    // v2 schema: requires both 'name' and 'email'
    const v2Schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
      },
      required: ['name', 'email'],
      additionalProperties: false,
    };

    const schemaHistory: SchemaHistoryMap = new Map([
      [2, v2Schema],
    ]);

    // Record conforms to v1 (only 'name'), but we're validating against v2
    const record = {
      data: { name: 'Alice' },
      schema_version: 2,
    };

    const result = validateRecordAgainstSchema(record, schemaHistory);
    assertResult(result);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('email'))).toBe(true);
  });

  it('FF-RSV-3 missing: missing schema version returns error', () => {
    const schemaHistory: SchemaHistoryMap = new Map([
      [1, { type: 'object' }],
    ]);

    // Asking for v2, but only v1 exists in history
    const record = {
      data: { name: 'Alice' },
      schema_version: 2,
    };

    const result = validateRecordAgainstSchema(record, schemaHistory);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('schema version 2 not found in history');
  });

  it('AC-7 v1+v2: multi-version history with correct matching', () => {
    const v1Schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
    };

    const v2Schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
      },
      required: ['name', 'email'],
    };

    const schemaHistory: SchemaHistoryMap = new Map([
      [1, v1Schema],
      [2, v2Schema],
    ]);

    // Record at v1 passes v1 validation
    const v1Record = {
      data: { name: 'Alice' },
      schema_version: 1,
    };
    const v1Result = validateRecordAgainstSchema(v1Record, schemaHistory);
    expect(v1Result.valid).toBe(true);

    // Record at v2 passes v2 validation
    const v2Record = {
      data: { name: 'Bob', email: 'bob@example.com' },
      schema_version: 2,
    };
    const v2Result = validateRecordAgainstSchema(v2Record, schemaHistory);
    expect(v2Result.valid).toBe(true);

    // Record with v1 data under v2 schema fails
    const v1DataUnderV2 = {
      data: { name: 'Charlie' },
      schema_version: 2,
    };
    const mismatchResult = validateRecordAgainstSchema(v1DataUnderV2, schemaHistory);
    expect(mismatchResult.valid).toBe(false);
  });

  it('AC-10 purity: function handles type errors without crashing', () => {
    // Malformed schema should be caught by AJV and returned as error, not thrown
    const badSchema = {
      type: 'invalid-type-name',
      properties: {},
    };

    const schemaHistory: SchemaHistoryMap = new Map([
      [1, badSchema],
    ]);

    const record = {
      data: { name: 'Alice' },
      schema_version: 1,
    };

    const result = validateRecordAgainstSchema(record, schemaHistory);
    // Should return valid: false with error message, not throw
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('AC-7 empty record: empty data object validates against empty schema', () => {
    const emptySchema = {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };

    const schemaHistory: SchemaHistoryMap = new Map([
      [1, emptySchema],
    ]);

    const record = {
      data: {},
      schema_version: 1,
    };

    const result = validateRecordAgainstSchema(record, schemaHistory);
    expect(result.valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T-0263: validateRecordSchemaDefinition — field-schema authoring guard
  // -------------------------------------------------------------------------

  it('T-0263 def: a well-formed field-schema is accepted', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
        amount: { type: 'number' },
      },
      required: ['name'],
      additionalProperties: false,
    };
    const result = validateRecordSchemaDefinition(schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('T-0263 def: an empty object schema is accepted', () => {
    const result = validateRecordSchemaDefinition({});
    expect(result.valid).toBe(true);
  });

  it('T-0263 def: an unknown field `type` is rejected (AJV strict)', () => {
    const schema = { type: 'object', properties: { foo: { type: 'bogus-type' } } };
    const result = validateRecordSchemaDefinition(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('T-0263 def: a non-array `required` is rejected', () => {
    const schema = { type: 'object', required: 'name' };
    const result = validateRecordSchemaDefinition(schema);
    expect(result.valid).toBe(false);
  });

  it('T-0263 def: null / array / non-object inputs are rejected', () => {
    expect(validateRecordSchemaDefinition(null).valid).toBe(false);
    expect(validateRecordSchemaDefinition([]).valid).toBe(false);
    expect(validateRecordSchemaDefinition('schema').valid).toBe(false);
  });

  it('AC-7 additional properties: validation respects additionalProperties constraint', () => {
    // Schema disallows additional properties
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    };

    const schemaHistory: SchemaHistoryMap = new Map([
      [1, schema],
    ]);

    // Record has extra field 'age' not in schema
    const record = {
      data: { name: 'Alice', age: 30 },
      schema_version: 1,
    };

    const result = validateRecordAgainstSchema(record, schemaHistory);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('additionalProperties'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T-0444: validateRecordAgainstSchema — relation field (x-* strip)
  // -------------------------------------------------------------------------

  it('T-0444 record-write: relation schema validates a UUID string (valid:true)', () => {
    // Persisted schema retains x-relation (as stored in registry_schema_history).
    // validateRecordAgainstSchema must strip x-* before AJV compile so it does NOT
    // throw "unknown keyword x-relation" — every record write into a relation-bearing
    // registry_def was previously returning 400.
    const relationSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        kontragent: {
          type: 'string',
          'x-relation': { target_registry_id: '550e8400-e29b-41d4-a716-446655440000' },
          title: 'Контрагент',
        },
      },
      required: ['kontragent'],
    };

    const schemaHistory: SchemaHistoryMap = new Map([[1, relationSchema]]);

    const record = {
      data: { kontragent: '550e8400-e29b-41d4-a716-446655440001' },
      schema_version: 1,
    };

    const result = validateRecordAgainstSchema(record, schemaHistory);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('T-0444 record-write: relation schema rejects a non-string value (valid:false)', () => {
    // After stripping x-relation the property is { type: "string" } — a numeric
    // value must still be rejected (string type enforcement remains).
    const relationSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        kontragent: {
          type: 'string',
          'x-relation': { target_registry_id: '550e8400-e29b-41d4-a716-446655440000' },
        },
      },
      required: ['kontragent'],
    };

    const schemaHistory: SchemaHistoryMap = new Map([[1, relationSchema]]);

    const recordWithNumber = {
      data: { kontragent: 42 },
      schema_version: 1,
    };

    const result = validateRecordAgainstSchema(recordWithNumber, schemaHistory);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // T-0510: root-level x-field-order — stripped before AJV compile
  // -------------------------------------------------------------------------

  it('T-0510 definition: schema with root x-field-order passes validateRecordSchemaDefinition', () => {
    // x-field-order is a root-level annotation emitted by buildRecordSchema (T-0510).
    // The server validator must strip it before AJV compile (AJV strict rejects
    // unknown root-level keywords). This test proves the stripping is in effect.
    const schemaWithOrder = {
      type: 'object',
      additionalProperties: false,
      'x-field-order': ['name', 'amount'],
      properties: {
        name: { type: 'string', title: 'Название' },
        amount: { type: 'number', title: 'Сумма' },
      },
      required: ['name'],
    };
    const result = validateRecordSchemaDefinition(schemaWithOrder);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('T-0510 record-write: schema with root x-field-order validates record data correctly', () => {
    // The persisted schema (as stored in registry_schema_history after T-0510) will
    // carry root x-field-order. validateRecordAgainstSchema must strip it so AJV
    // does not throw "unknown keyword: x-field-order" and data validation works correctly.
    const schemaWithOrder = {
      type: 'object',
      additionalProperties: false,
      'x-field-order': ['name', 'amount'],
      properties: {
        name: { type: 'string', title: 'Название' },
        amount: { type: 'number', title: 'Сумма' },
      },
      required: ['name'],
    };

    const schemaHistory: SchemaHistoryMap = new Map([[1, schemaWithOrder]]);

    // Valid record: required name present, optional amount as number.
    const validRecord = { data: { name: 'Акмэ', amount: 9999 }, schema_version: 1 };
    const validResult = validateRecordAgainstSchema(validRecord, schemaHistory);
    expect(validResult.valid).toBe(true);
    expect(validResult.errors).toHaveLength(0);

    // Invalid record: missing required name.
    const missingRequired = { data: { amount: 100 }, schema_version: 1 };
    const missingResult = validateRecordAgainstSchema(missingRequired, schemaHistory);
    expect(missingResult.valid).toBe(false);
    expect(missingResult.errors.length).toBeGreaterThan(0);

    // Invalid record: amount as string instead of number.
    const wrongType = { data: { name: 'X', amount: 'not-a-number' }, schema_version: 1 };
    const typeResult = validateRecordAgainstSchema(wrongType, schemaHistory);
    expect(typeResult.valid).toBe(false);
    expect(typeResult.errors.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // T-0663: format:"email" (and date/date-time/uri) — AJV strict compile-time
  // "unknown format" bug. Seeded registries (migrations 073/083 — «Контрагенты»
  // contact_email, «Производственный календарь» date) carry raw JSON-Schema
  // `format` keywords the bare AJV instance did not recognise: ajv.compile()
  // THREW before validate() ever ran, so EVERY write into such a registry 400ed
  // — including a record where the email field was entirely absent. These tests
  // are RED against the pre-fix validator (bare `new Ajv()`, no ajv-formats) and
  // GREEN after registering formats in makeAjv().
  // -------------------------------------------------------------------------

  describe('T-0663: format:"email" record-schema (compile-time regression + empty-optional semantics)', () => {
    // Mirrors migrations/083_core_system_registries_seed.sql «Контрагенты» —
    // contact_email is OPTIONAL (only `name` is required).
    const kontragentySchema = {
      type: 'object',
      additionalProperties: true,
      properties: {
        name: { type: 'string', title: 'Наименование' },
        contact_email: { type: 'string', format: 'email', title: 'Email контакта' },
      },
      required: ['name'],
    };

    it('AC-a: a record with a VALID email in an optional email field saves (valid:true)', () => {
      const schemaHistory: SchemaHistoryMap = new Map([[1, kontragentySchema]]);
      const record = {
        data: { name: 'ООО Ромашка', contact_email: 'contact@romashka.example' },
        schema_version: 1,
      };
      const result = validateRecordAgainstSchema(record, schemaHistory);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('AC-b: a record with an EMPTY optional email field saves (was the reported bug — 400 regardless of value)', () => {
      const schemaHistory: SchemaHistoryMap = new Map([[1, kontragentySchema]]);

      // Variant 1: the key is present but blank (a client that sends "" rather
      // than omitting the key — the defensive case; the shipped web form omits
      // the key, but the server must not depend on that).
      const withEmptyString = { data: { name: 'ООО Ромашка', contact_email: '' }, schema_version: 1 };
      const r1 = validateRecordAgainstSchema(withEmptyString, schemaHistory);
      expect(r1.valid).toBe(true);
      expect(r1.errors).toHaveLength(0);

      // Variant 2: the key is omitted entirely (what serializeRecordData actually
      // sends for a blank optional field, per web/src/screens/records-form.js).
      const withOmittedKey = { data: { name: 'ООО Ромашка' }, schema_version: 1 };
      const r2 = validateRecordAgainstSchema(withOmittedKey, schemaHistory);
      expect(r2.valid).toBe(true);
      expect(r2.errors).toHaveLength(0);
    });

    it('AC-c: a record with an INVALID (non-empty, malformed) email in a REQUIRED email field is honestly rejected', () => {
      // required email field — distinct schema from kontragentySchema (whose
      // contact_email is optional) so this test proves format validation is
      // NOT silently disabled by the T-0663 fix — a genuinely malformed,
      // non-empty email value must still 400.
      const requiredEmailSchema = {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          contact_email: { type: 'string', format: 'email' },
        },
        required: ['name', 'contact_email'],
      };
      const schemaHistory: SchemaHistoryMap = new Map([[1, requiredEmailSchema]]);

      const badEmail = { data: { name: 'ООО Ромашка', contact_email: 'not-an-email' }, schema_version: 1 };
      const badResult = validateRecordAgainstSchema(badEmail, schemaHistory);
      expect(badResult.valid).toBe(false);
      expect(badResult.errors.length).toBeGreaterThan(0);
      expect(badResult.errors.some((e) => e.includes('email'))).toBe(true);

      // A required-but-absent email field must still be rejected (required
      // governs presence; the T-0663 empty-string carve-out is not a backdoor
      // around `required`).
      const missingEmail = { data: { name: 'ООО Ромашка' }, schema_version: 1 };
      const missingResult = validateRecordAgainstSchema(missingEmail, schemaHistory);
      expect(missingResult.valid).toBe(false);
      expect(missingResult.errors.length).toBeGreaterThan(0);

      // A valid, non-empty email in the required field passes.
      const goodEmail = { data: { name: 'ООО Ромашка', contact_email: 'sales@romashka.example' }, schema_version: 1 };
      const goodResult = validateRecordAgainstSchema(goodEmail, schemaHistory);
      expect(goodResult.valid).toBe(true);
      expect(goodResult.errors).toHaveLength(0);
    });

    it('validateRecordSchemaDefinition: a record_schema authoring format:"email" is accepted (no compile throw)', () => {
      // The T-0263 authoring guard shares the same makeAjv() factory — a schema
      // author declaring format:"email" directly (not just via the x-email
      // round-trip convention) must not 400 at registry_def create/update time.
      const result = validateRecordSchemaDefinition(kontragentySchema);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('format:"date" / format:"date-time" (migrations 073/083: not_after, prod-kalendar.date) compile and validate', () => {
      // Mirrors migrations/083 «Производственный календарь» (date, required) and
      // migrations/073 vendor-crm (not_after: format "date", activation_key_issued_at:
      // format "date-time") — the same compile-time "unknown format" bug applied to
      // every non-email format keyword these seeds use.
      const calendarSchema = {
        type: 'object',
        additionalProperties: true,
        properties: {
          date: { type: 'string', format: 'date', title: 'Дата' },
          is_working_day: { type: 'boolean' },
          activation_key_issued_at: { type: 'string', format: 'date-time' },
        },
        required: ['date', 'is_working_day'],
      };
      const schemaHistory: SchemaHistoryMap = new Map([[1, calendarSchema]]);

      const valid = validateRecordAgainstSchema(
        { data: { date: '2026-07-05', is_working_day: true, activation_key_issued_at: '2026-07-05T10:00:00Z' }, schema_version: 1 },
        schemaHistory,
      );
      expect(valid.valid).toBe(true);
      expect(valid.errors).toHaveLength(0);

      // Optional date-time field left blank (empty string) still saves.
      const blankOptional = validateRecordAgainstSchema(
        { data: { date: '2026-07-05', is_working_day: false, activation_key_issued_at: '' }, schema_version: 1 },
        schemaHistory,
      );
      expect(blankOptional.valid).toBe(true);

      // A malformed, non-empty date is still honestly rejected.
      const badDate = validateRecordAgainstSchema(
        { data: { date: 'not-a-date', is_working_day: true }, schema_version: 1 },
        schemaHistory,
      );
      expect(badDate.valid).toBe(false);
      expect(badDate.errors.length).toBeGreaterThan(0);
    });
  });
});
