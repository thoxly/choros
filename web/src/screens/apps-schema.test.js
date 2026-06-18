/**
 * web/src/screens/apps-schema.test.js
 *
 * Unit tests for the T-0266 field-constructor pure logic (apps-schema.js):
 *   - buildRecordSchema produces a record_schema that the BACKEND validator
 *     (validateRecordSchemaDefinition, AJV strict) accepts;
 *   - parseRecordSchema is the inverse (round-trip);
 *   - validateFields catches empty list, bad keys, duplicate keys;
 *   - mapSchemaError surfaces the API contract honestly.
 *
 * The "accepted by the real validator" guarantee is verified two ways:
 *   1. structurally — the shape matches the seeds + validator unit tests;
 *   2. directly — we import ajv (the SAME dependency the backend validator uses)
 *      and assert ajv.compile() in strict mode accepts every emitted schema,
 *      exactly as src/core/record-schema-validator.ts::validateRecordSchemaDefinition.
 */

import { describe, it, expect } from 'vitest';
import { Ajv } from 'ajv';
import {
  FIELD_TYPES,
  FIELD_TYPE_VALUES,
  validateField,
  validateFields,
  buildRecordSchema,
  parseRecordSchema,
  mapSchemaError,
  blankField,
} from './apps-schema.js';

// Mirror of src/core/record-schema-validator.ts::validateRecordSchemaDefinition.
// If ajv.compile throws (strict-mode rejection), the schema would 400 at the API.
function backendAccepts(schema) {
  const ajv = new Ajv();
  try {
    ajv.compile(schema);
    return true;
  } catch {
    return false;
  }
}

describe('apps-schema · supported types', () => {
  it('offers only AJV-strict-compilable primitive types', () => {
    for (const t of FIELD_TYPE_VALUES) {
      const schema = { type: 'object', properties: { f: { type: t } }, additionalProperties: false };
      expect(backendAccepts(schema)).toBe(true);
    }
  });

  it('does not offer `format` (AJV strict throws on unknown formats)', () => {
    // sanity: the editor must never emit format — prove format would be rejected
    const withFormat = { type: 'object', properties: { f: { type: 'string', format: 'email' } } };
    expect(backendAccepts(withFormat)).toBe(false);
  });

  it('type labels are present for every type value', () => {
    expect(FIELD_TYPES.every((t) => typeof t.label === 'string' && t.label.length > 0)).toBe(true);
  });
});

describe('apps-schema · buildRecordSchema', () => {
  it('assembles a schema the backend validator accepts', () => {
    const fields = [
      { key: 'company_name', type: 'string', title: 'Компания', required: true },
      { key: 'amount', type: 'number', title: 'Сумма', required: false },
      { key: 'active', type: 'boolean', title: '', required: false },
    ];
    const schema = buildRecordSchema(fields);
    expect(schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        company_name: { type: 'string', title: 'Компания' },
        amount: { type: 'number', title: 'Сумма' },
        active: { type: 'boolean' }, // no title → no empty title key emitted
      },
      required: ['company_name'],
    });
    expect(backendAccepts(schema)).toBe(true);
  });

  it('preserves field ORDER in properties', () => {
    const fields = [
      { key: 'zeta', type: 'string', required: false },
      { key: 'alpha', type: 'integer', required: false },
      { key: 'mid', type: 'boolean', required: false },
    ];
    const schema = buildRecordSchema(fields);
    expect(Object.keys(schema.properties)).toEqual(['zeta', 'alpha', 'mid']);
  });

  it('omits `required` entirely when no field is required', () => {
    const schema = buildRecordSchema([{ key: 'note', type: 'string', required: false }]);
    expect('required' in schema).toBe(false);
    expect(backendAccepts(schema)).toBe(true);
  });

  it('never emits `format`', () => {
    const schema = buildRecordSchema([{ key: 'email_addr', type: 'string', title: 'E', required: true }]);
    expect(JSON.stringify(schema).includes('format')).toBe(false);
    expect(backendAccepts(schema)).toBe(true);
  });

  it('an empty field list yields an empty-but-valid schema', () => {
    const schema = buildRecordSchema([]);
    expect(schema).toEqual({ type: 'object', additionalProperties: false, properties: {} });
    expect(backendAccepts(schema)).toBe(true);
  });
});

describe('apps-schema · parseRecordSchema (round-trip)', () => {
  it('round-trips buildRecordSchema output back to the field list', () => {
    const fields = [
      { key: 'company_name', type: 'string', title: 'Компания', required: true },
      { key: 'amount', type: 'number', title: 'Сумма', required: false },
    ];
    const parsed = parseRecordSchema(buildRecordSchema(fields));
    expect(parsed).toEqual([
      { key: 'company_name', type: 'string', title: 'Компания', required: true },
      { key: 'amount', type: 'number', title: 'Сумма', required: false },
    ]);
  });

  it('parses a seed-style schema (056 external-participant)', () => {
    const seed = {
      type: 'object',
      properties: {
        display_name: { type: 'string', title: 'Наименование' },
        kind: { type: 'string', title: 'Тип', enum: ['counterparty', 'visitor'] },
        note: { type: 'string', title: 'Примечание' },
      },
      required: ['display_name', 'kind'],
    };
    const parsed = parseRecordSchema(seed);
    expect(parsed.map((f) => f.key)).toEqual(['display_name', 'kind', 'note']);
    expect(parsed.find((f) => f.key === 'kind').required).toBe(true);
    expect(parsed.find((f) => f.key === 'note').required).toBe(false);
  });

  it('falls back to "string" for a persisted type the editor does not offer', () => {
    const parsed = parseRecordSchema({ properties: { x: { type: 'object' } } });
    expect(parsed[0].type).toBe('string');
  });

  it('tolerates absent/garbage schemas', () => {
    expect(parseRecordSchema(null)).toEqual([]);
    expect(parseRecordSchema([])).toEqual([]);
    expect(parseRecordSchema({})).toEqual([]);
    expect(parseRecordSchema({ properties: 'nope' })).toEqual([]);
  });
});

describe('apps-schema · validateFields', () => {
  it('rejects an empty field list', () => {
    const r = validateFields([]);
    expect(r.valid).toBe(false);
    expect(r.formError).toBeTruthy();
  });

  it('flags bad/missing keys and bad types', () => {
    const r = validateFields([
      { key: '', type: 'string' },
      { key: '1bad', type: 'string' },
      { key: 'ok', type: 'nope' },
    ]);
    expect(r.valid).toBe(false);
    expect(r.fieldErrors[0].key).toBeTruthy();
    expect(r.fieldErrors[1].key).toBeTruthy();
    expect(r.fieldErrors[2].type).toBeTruthy();
  });

  it('flags duplicate keys on both occurrences', () => {
    const r = validateFields([
      { key: 'dup', type: 'string' },
      { key: 'dup', type: 'number' },
    ]);
    expect(r.valid).toBe(false);
    expect(r.fieldErrors[0].key).toBeTruthy();
    expect(r.fieldErrors[1].key).toBeTruthy();
  });

  it('accepts a well-formed list', () => {
    const r = validateFields([
      { key: 'company_name', type: 'string', required: true },
      { key: 'amount', type: 'number', required: false },
    ]);
    expect(r.valid).toBe(true);
    expect(r.formError).toBeNull();
  });
});

describe('apps-schema · validateField / blankField', () => {
  it('blankField is a valid-typed empty row needing a key', () => {
    const b = blankField();
    expect(FIELD_TYPE_VALUES.includes(b.type)).toBe(true);
    expect(validateField(b).key).toBeTruthy(); // empty key → error
  });
});

describe('apps-schema · mapSchemaError', () => {
  it('400 → server message surfaced', () => {
    const m = mapSchemaError(400, { error: { code: 'VALIDATION', message: 'invalid record_schema: bad' } });
    expect(m.message).toContain('invalid record_schema');
    expect(m.field).toBeUndefined();
  });

  it('409 CONFLICT (slug) targets the slug field', () => {
    const m = mapSchemaError(409, { error: { code: 'CONFLICT', message: 'slug taken' } });
    expect(m.field).toBe('slug');
  });

  it('409 destructive_schema_change → no field, explains override', () => {
    const m = mapSchemaError(409, { error: { code: 'destructive_schema_change', message: 'x' } });
    expect(m.field).toBeUndefined();
    expect(m.message).toMatch(/разрушительн/i);
  });

  it('401 → re-login hint', () => {
    expect(mapSchemaError(401, null).message).toMatch(/авторизована/i);
  });

  it('404 → not found', () => {
    expect(mapSchemaError(404, null).message).toMatch(/не найден/i);
  });
});
