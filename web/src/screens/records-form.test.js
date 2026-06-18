/**
 * web/src/screens/records-form.test.js
 *
 * Unit tests for the T-0267 record-entry pure logic (records-form.js):
 *   - schemaToFormFields maps record_schema → ordered form-field descriptors
 *     with the right input kind per type and required markers;
 *   - serializeRecordData produces a `data` payload the BACKEND record validator
 *     ACCEPTS for valid input (numbers as numbers, booleans as booleans, blank
 *     optionals omitted) and that valid required data passes;
 *   - validateRecordValues catches missing required + bad numbers client-side;
 *   - mapRecordError / extractFieldErrors surface the API contract honestly.
 *
 * The "accepted by the real validator" guarantee is verified directly: we import
 * `ajv` (the SAME dependency the backend uses — src/core/record-schema-validator.ts
 * runs `new Ajv()` over the registry_def record_schema) and assert the serialized
 * data validates exactly as the server would.
 */

import { describe, it, expect } from 'vitest';
import { Ajv } from 'ajv';
import {
  INPUT_KIND,
  schemaToFormFields,
  blankRecordValues,
  validateRecordValues,
  serializeRecordData,
  schemaToColumns,
  formatCellValue,
  mapRecordError,
  extractFieldErrors,
} from './records-form.js';

// A representative record_schema exactly like the field-constructor emits.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', title: 'Имя' },
    age: { type: 'integer', title: 'Возраст' },
    score: { type: 'number' }, // no title → label falls back to key
    active: { type: 'boolean', title: 'Активен' },
    note: { type: 'string', title: 'Заметка' },
  },
  required: ['name', 'age'],
};

// Mirror of how the backend validates a record's data (default Ajv, not strict).
function backendValidate(schema, data) {
  const ajv = new Ajv();
  const validate = ajv.compile(schema);
  const valid = validate(data);
  return { valid, errors: validate.errors || [] };
}

describe('INPUT_KIND', () => {
  it('maps primitive types to controls', () => {
    expect(INPUT_KIND.string).toBe('text');
    expect(INPUT_KIND.number).toBe('number');
    expect(INPUT_KIND.integer).toBe('number');
    expect(INPUT_KIND.boolean).toBe('checkbox');
  });
});

describe('schemaToFormFields', () => {
  it('derives ordered fields with type, label, required, inputKind', () => {
    const fields = schemaToFormFields(SCHEMA);
    expect(fields.map((f) => f.key)).toEqual(['name', 'age', 'score', 'active', 'note']);
    expect(fields[0]).toMatchObject({ key: 'name', type: 'string', label: 'Имя', required: true, inputKind: 'text' });
    expect(fields[1]).toMatchObject({ key: 'age', type: 'integer', required: true, inputKind: 'number' });
    // no title → label falls back to the raw key
    expect(fields[2]).toMatchObject({ key: 'score', type: 'number', label: 'score', required: false, inputKind: 'number' });
    expect(fields[3]).toMatchObject({ key: 'active', type: 'boolean', required: false, inputKind: 'checkbox' });
    expect(fields[4].required).toBe(false);
  });

  it('falls back to string for an unsupported persisted type', () => {
    const fields = schemaToFormFields({ type: 'object', properties: { x: { type: 'array' } } });
    expect(fields[0]).toMatchObject({ key: 'x', type: 'string', inputKind: 'text' });
  });

  it('tolerates absent / malformed schemas', () => {
    expect(schemaToFormFields(null)).toEqual([]);
    expect(schemaToFormFields(undefined)).toEqual([]);
    expect(schemaToFormFields({})).toEqual([]);
    expect(schemaToFormFields({ properties: [] })).toEqual([]);
    expect(schemaToFormFields([])).toEqual([]);
  });
});

describe('blankRecordValues', () => {
  it('starts strings/numbers as "" and booleans as false', () => {
    const v = blankRecordValues(schemaToFormFields(SCHEMA));
    expect(v).toEqual({ name: '', age: '', score: '', active: false, note: '' });
  });
});

describe('validateRecordValues', () => {
  const fields = schemaToFormFields(SCHEMA);

  it('flags missing required string and number', () => {
    const { valid, errors } = validateRecordValues(fields, { name: '', age: '', score: '', active: false, note: '' });
    expect(valid).toBe(false);
    expect(errors.name).toBeTruthy();
    expect(errors.age).toBeTruthy();
    // optional empties are fine
    expect(errors.score).toBeUndefined();
    expect(errors.note).toBeUndefined();
  });

  it('rejects non-numeric and non-integer numbers', () => {
    const r1 = validateRecordValues(fields, { name: 'A', age: 'abc', score: '', active: false, note: '' });
    expect(r1.errors.age).toBeTruthy();
    const r2 = validateRecordValues(fields, { name: 'A', age: '1.5', score: '', active: false, note: '' });
    expect(r2.errors.age).toBeTruthy(); // integer field, fractional value
    const r3 = validateRecordValues(fields, { name: 'A', age: '7', score: 'x', active: false, note: '' });
    expect(r3.errors.score).toBeTruthy(); // optional number but non-numeric typed
  });

  it('passes valid input (booleans always valid)', () => {
    const { valid, errors } = validateRecordValues(fields, { name: 'Алиса', age: '30', score: '9.5', active: true, note: '' });
    expect(valid).toBe(true);
    expect(errors).toEqual({});
  });
});

describe('serializeRecordData → accepted by the real backend validator', () => {
  const fields = schemaToFormFields(SCHEMA);

  it('types numbers as numbers, booleans as booleans, omits blank optionals', () => {
    const data = serializeRecordData(fields, { name: 'Алиса', age: '30', score: '9.5', active: true, note: '' });
    expect(data).toEqual({ name: 'Алиса', age: 30, score: 9.5, active: true });
    expect(typeof data.age).toBe('number');
    expect(typeof data.score).toBe('number');
    expect(typeof data.active).toBe('boolean');
    expect('note' in data).toBe(false); // blank optional string omitted
    // The decisive check: the SAME validator the server runs accepts it.
    expect(backendValidate(SCHEMA, data).valid).toBe(true);
  });

  it('emits required false boolean correctly', () => {
    const schema = {
      type: 'object', additionalProperties: false,
      properties: { agreed: { type: 'boolean' } }, required: ['agreed'],
    };
    const f = schemaToFormFields(schema);
    const data = serializeRecordData(f, { agreed: false });
    expect(data).toEqual({ agreed: false });
    expect(backendValidate(schema, data).valid).toBe(true);
  });

  it('omits a blank optional number (no NaN, no type error)', () => {
    const data = serializeRecordData(fields, { name: 'Боб', age: '5', score: '', active: false, note: '' });
    expect('score' in data).toBe(false);
    expect(data).toEqual({ name: 'Боб', age: 5, active: false });
    expect(backendValidate(SCHEMA, data).valid).toBe(true);
  });

  it('a string value of a number key would be REJECTED by the server (proves typing matters)', () => {
    // Sanity: had we sent age as a string, the backend would reject it.
    expect(backendValidate(SCHEMA, { name: 'X', age: '30' }).valid).toBe(false);
    // Our serializer never does that for valid input:
    const data = serializeRecordData(fields, { name: 'X', age: '30', score: '', active: false, note: '' });
    expect(typeof data.age).toBe('number');
  });

  it('does not emit keys outside the schema (additionalProperties:false safe)', () => {
    const data = serializeRecordData(fields, { name: 'A', age: '1', score: '', active: false, note: '', bogus: 'x' });
    expect('bogus' in data).toBe(false);
    expect(backendValidate(SCHEMA, data).valid).toBe(true);
  });
});

describe('schemaToColumns', () => {
  it('produces columns in schema order with labels', () => {
    const cols = schemaToColumns(SCHEMA);
    expect(cols.map((c) => c.key)).toEqual(['name', 'age', 'score', 'active', 'note']);
    expect(cols[0]).toEqual({ key: 'name', label: 'Имя', type: 'string' });
    expect(cols[2]).toEqual({ key: 'score', label: 'score', type: 'number' });
  });
});

describe('formatCellValue', () => {
  it('renders booleans, nullish, primitives, objects', () => {
    expect(formatCellValue(true, 'boolean')).toBe('Да');
    expect(formatCellValue(false, 'boolean')).toBe('Нет');
    expect(formatCellValue(null, 'string')).toBe('—');
    expect(formatCellValue(undefined, 'number')).toBe('—');
    expect(formatCellValue(42, 'number')).toBe('42');
    expect(formatCellValue('hi', 'string')).toBe('hi');
    expect(formatCellValue({ a: 1 }, 'string')).toBe('{"a":1}');
    // a stray boolean value under a non-boolean column still reads sanely
    expect(formatCellValue(true, 'string')).toBe('Да');
  });
});

describe('mapRecordError', () => {
  it('maps 409 to the pick-registry kind', () => {
    const r = mapRecordError(409, { error: { code: 'CONFLICT', message: 'ambiguous' } });
    expect(r.kind).toBe('pick-registry');
    expect(r.message).toMatch(/выберите/i);
  });

  it('surfaces the 400 AJV server message', () => {
    const msg = 'data does not conform to registry_def schema: #/properties/age/type: must be integer';
    const r = mapRecordError(400, { error: { code: 'VALIDATION', message: msg } });
    expect(r.kind).toBe('message');
    expect(r.message).toBe(msg);
  });

  it('handles 401/403/404 and generic fallback', () => {
    expect(mapRecordError(401, null).message).toMatch(/авторизован/i);
    expect(mapRecordError(403, { error: { message: 'blocked' } }).message).toBe('blocked');
    expect(mapRecordError(404, null).message).toMatch(/не найден/i);
    expect(mapRecordError(500, null).message).toMatch(/HTTP 500/);
  });
});

describe('extractFieldErrors', () => {
  it('attributes AJV detail to recognised fields only', () => {
    const msg = 'data does not conform to registry_def schema: #/properties/age/type: must be integer; #/properties/score/type: must be number';
    const out = extractFieldErrors(msg, new Set(['name', 'age', 'score']));
    expect(out.age).toMatch(/integer/i);
    expect(out.score).toMatch(/number/i);
    expect(out.name).toBeUndefined();
  });

  it('ignores unknown keys and non-string input', () => {
    const msg = '#/properties/ghost/type: must be string';
    expect(extractFieldErrors(msg, ['name'])).toEqual({});
    expect(extractFieldErrors(undefined, ['name'])).toEqual({});
    expect(extractFieldErrors(null, new Set())).toEqual({});
  });
});
