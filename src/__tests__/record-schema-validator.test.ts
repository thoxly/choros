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
});
