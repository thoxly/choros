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
  RELATION_CELL_ASYNC,
  deriveRecordLabel,
  mapRecordError,
  extractFieldErrors,
  computeRollup,
  humanizeKey,
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
    // T-0552: no title → label falls back to a humanized key (not the raw key)
    expect(fields[2]).toMatchObject({ key: 'score', type: 'number', label: 'Score', required: false, inputKind: 'number' });
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

describe('T-0552: humanizeKey label fallback', () => {
  it('humanizes a raw snake/kebab key', () => {
    expect(humanizeKey('vendor_inn')).toBe('Vendor inn');
    expect(humanizeKey('TEST')).toBe('TEST');
    expect(humanizeKey('first-name')).toBe('First name');
    expect(humanizeKey('a__b--c')).toBe('A b c');
    expect(humanizeKey('  spaced_key  ')).toBe('Spaced key');
  });

  it('returns "" for empty / non-string', () => {
    expect(humanizeKey('')).toBe('');
    expect(humanizeKey('___')).toBe('');
    expect(humanizeKey(null)).toBe('');
    expect(humanizeKey(undefined)).toBe('');
    expect(humanizeKey(42)).toBe('');
  });

  it('schemaToFormFields uses humanizeKey when title is absent', () => {
    const fields = schemaToFormFields({
      type: 'object',
      properties: { vendor_inn: { type: 'string' } },
    });
    expect(fields[0].label).toBe('Vendor inn');
  });

  it('a present title is NOT changed', () => {
    const fields = schemaToFormFields({
      type: 'object',
      properties: { vendor_inn: { type: 'string', title: 'ИНН поставщика' } },
    });
    expect(fields[0].label).toBe('ИНН поставщика');
  });

  it('schemaToColumns headers fall back to humanized key', () => {
    const cols = schemaToColumns({
      type: 'object',
      properties: { vendor_inn: { type: 'string' } },
    });
    expect(cols[0].label).toBe('Vendor inn');
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
    expect(cols[2]).toEqual({ key: 'score', label: 'Score', type: 'number' }); // T-0552: humanized key fallback
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

// ---------------------------------------------------------------------------
// T-0447: formatCellValue — relation branch + deriveRecordLabel
// ---------------------------------------------------------------------------

const SAMPLE_UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('T-0447: formatCellValue relation field', () => {
  it('returns RELATION_CELL_ASYNC for a non-empty UUID value with type="relation"', () => {
    const result = formatCellValue(SAMPLE_UUID, 'relation');
    // Must be the sentinel symbol — callers render an async component.
    expect(result).toBe(RELATION_CELL_ASYNC);
    expect(typeof result).toBe('symbol');
  });

  it('returns "—" for null relation value (no target selected)', () => {
    expect(formatCellValue(null, 'relation')).toBe('—');
  });

  it('returns "—" for undefined relation value', () => {
    expect(formatCellValue(undefined, 'relation')).toBe('—');
  });

  it('returns "—" for empty string relation value (blank optional)', () => {
    // An empty string means no record was picked — treat as absent.
    expect(formatCellValue('', 'relation')).toBe('—');
  });

  it('RELATION_CELL_ASYNC is a stable symbol identity (not recreated each call)', () => {
    const a = formatCellValue(SAMPLE_UUID, 'relation');
    const b = formatCellValue(SAMPLE_UUID, 'relation');
    expect(a).toBe(b); // same symbol reference
  });
});

describe('T-0447: deriveRecordLabel', () => {
  it('returns the first non-empty string value from data', () => {
    const rec = { id: SAMPLE_UUID, data: { name: 'Acme Corp', code: 'ACM' } };
    expect(deriveRecordLabel(rec)).toBe('Acme Corp');
  });

  it('returns a finite number value as a string when the first field is a number', () => {
    const rec = { id: SAMPLE_UUID, data: { amount: 42, note: 'hi' } };
    expect(deriveRecordLabel(rec)).toBe('42');
  });

  it('skips blank strings and finds the next non-empty value', () => {
    const rec = { id: SAMPLE_UUID, data: { empty: '', name: 'Filled' } };
    expect(deriveRecordLabel(rec)).toBe('Filled');
  });

  it('falls back to short id prefix when data has no usable string/number', () => {
    const rec = { id: '12345678-abcd-0000-0000-000000000000', data: { flag: true } };
    const label = deriveRecordLabel(rec);
    expect(label).toBe('12345678…');
  });

  it('returns "—" for null record', () => {
    expect(deriveRecordLabel(null)).toBe('—');
  });

  it('returns "—" for record with missing id and no data', () => {
    expect(deriveRecordLabel({ data: {} })).toBe('—');
  });

  it('ignores NaN and Infinity numeric values, falls back to id prefix', () => {
    const rec = { id: 'abcdef12-0000-0000-0000-000000000000', data: { val: NaN } };
    const label = deriveRecordLabel(rec);
    // NaN is not finite → skip; no other fields → id prefix
    expect(label).toBe('abcdef12…');
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

// ---------------------------------------------------------------------------
// T-0294: select and date field types in record forms
// ---------------------------------------------------------------------------

// A schema with select and date fields (as emitted by buildRecordSchema).
const SCHEMA_WITH_NEW_TYPES = {
  type: 'object',
  additionalProperties: false,
  properties: {
    deal_stage: { type: 'string', enum: ['lead', 'qualified', 'won', 'lost'], title: 'Стадия' },
    close_date: { type: 'string', title: 'Дата закрытия' }, // date stored as string
    notes: { type: 'string' },
  },
  required: ['deal_stage'],
};

describe('T-0294: select fields in records-form', () => {
  it('schemaToFormFields: detects select from enum, extracts options', () => {
    const fields = schemaToFormFields(SCHEMA_WITH_NEW_TYPES);
    const stage = fields.find((f) => f.key === 'deal_stage');
    expect(stage).toMatchObject({
      key: 'deal_stage',
      type: 'select',
      label: 'Стадия',
      required: true,
      inputKind: 'select',
      options: ['lead', 'qualified', 'won', 'lost'],
    });
  });

  it('INPUT_KIND: select maps to "select"', () => {
    expect(INPUT_KIND.select).toBe('select');
  });

  it('validateRecordValues: select required → error when blank', () => {
    const fields = schemaToFormFields(SCHEMA_WITH_NEW_TYPES);
    const { valid, errors } = validateRecordValues(fields, { deal_stage: '', close_date: '', notes: '' });
    expect(valid).toBe(false);
    expect(errors.deal_stage).toBeTruthy(); // required select, blank
    expect(errors.close_date).toBeUndefined(); // optional, blank is ok
  });

  it('validateRecordValues: select rejects value outside enum', () => {
    const fields = schemaToFormFields(SCHEMA_WITH_NEW_TYPES);
    const { valid, errors } = validateRecordValues(fields, { deal_stage: 'bogus', close_date: '', notes: '' });
    expect(valid).toBe(false);
    expect(errors.deal_stage).toMatch(/списка/);
  });

  it('validateRecordValues: select accepts a valid enum value', () => {
    const fields = schemaToFormFields(SCHEMA_WITH_NEW_TYPES);
    const { valid, errors } = validateRecordValues(fields, { deal_stage: 'won', close_date: '', notes: '' });
    expect(valid).toBe(true);
    expect(errors).toEqual({});
  });

  it('serializeRecordData: select emits the string value', () => {
    const fields = schemaToFormFields(SCHEMA_WITH_NEW_TYPES);
    const data = serializeRecordData(fields, { deal_stage: 'lead', close_date: '', notes: '' });
    expect(data.deal_stage).toBe('lead');
    expect(typeof data.deal_stage).toBe('string');
    // validate against actual schema
    expect(backendValidate(SCHEMA_WITH_NEW_TYPES, data).valid).toBe(true);
  });

  it('serializeRecordData: select blank optional → omit', () => {
    const optionalSchema = {
      type: 'object', additionalProperties: false,
      properties: { cat: { type: 'string', enum: ['a', 'b'] } },
    };
    const fields = schemaToFormFields(optionalSchema);
    const data = serializeRecordData(fields, { cat: '' });
    expect('cat' in data).toBe(false); // blank optional select omitted
    expect(backendValidate(optionalSchema, data).valid).toBe(true);
  });
});

describe('T-0294: date fields in records-form', () => {
  it('INPUT_KIND: date maps to "date"', () => {
    expect(INPUT_KIND.date).toBe('date');
  });

  it('validateRecordValues: date with valid ISO value passes', () => {
    // schemaToFormFields parses a plain type:"string" for date — not distinguishable.
    // We need a date-typed field to test date validation; use a field list directly.
    const dateField = [{ key: 'due', type: 'date', title: 'Due', label: 'Due', required: true, inputKind: 'date' }];
    const { valid } = validateRecordValues(dateField, { due: '2024-03-15' });
    expect(valid).toBe(true);
  });

  it('validateRecordValues: date required → error when blank', () => {
    const dateField = [{ key: 'due', type: 'date', title: 'Due', label: 'Due', required: true, inputKind: 'date' }];
    const { valid, errors } = validateRecordValues(dateField, { due: '' });
    expect(valid).toBe(false);
    expect(errors.due).toBeTruthy();
  });

  it('validateRecordValues: date rejects garbage string (non-ISO pattern)', () => {
    const dateField = [{ key: 'due', type: 'date', title: 'Due', label: 'Due', required: false, inputKind: 'date' }];
    const { valid, errors } = validateRecordValues(dateField, { due: 'not-a-date' });
    expect(valid).toBe(false);
    expect(errors.due).toBeTruthy();
  });

  it('validateRecordValues: date optional blank → valid (omitted)', () => {
    const dateField = [{ key: 'due', type: 'date', title: 'Due', label: 'Due', required: false, inputKind: 'date' }];
    const { valid } = validateRecordValues(dateField, { due: '' });
    expect(valid).toBe(true);
  });

  it('serializeRecordData: date emits the ISO string value', () => {
    const dateField = [{ key: 'due', type: 'date', title: 'Due', label: 'Due', required: true, inputKind: 'date' }];
    const data = serializeRecordData(dateField, { due: '2024-12-31' });
    expect(data.due).toBe('2024-12-31');
    expect(typeof data.due).toBe('string');
  });

  it('serializeRecordData: date optional blank → omit', () => {
    const dateField = [{ key: 'due', type: 'date', title: 'Due', label: 'Due', required: false, inputKind: 'date' }];
    const data = serializeRecordData(dateField, { due: '' });
    expect('due' in data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-0446: relation field type in records-form
// ---------------------------------------------------------------------------

const VALID_UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

// A record_schema with a relation field (as emitted by buildRecordSchema for a
// "relation" type field — T-0444 contract, PINNED shape).
const SCHEMA_WITH_RELATION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', title: 'Название' },
    target: {
      type: 'string',
      title: 'Связанная запись',
      'x-relation': { target_registry_id: 'aaaaaaaa-0000-0000-0000-000000000001' },
    },
  },
  required: ['target'],
};

describe('T-0446: relation fields in records-form', () => {
  it('INPUT_KIND: relation maps to "relation"', () => {
    expect(INPUT_KIND.relation).toBe('relation');
  });

  it('schemaToFormFields: detects relation from x-relation, emits inputKind and targetRegistryId', () => {
    const fields = schemaToFormFields(SCHEMA_WITH_RELATION);
    const rel = fields.find((f) => f.key === 'target');
    expect(rel).toMatchObject({
      key: 'target',
      type: 'relation',
      label: 'Связанная запись',
      required: true,
      inputKind: 'relation',
      targetRegistryId: 'aaaaaaaa-0000-0000-0000-000000000001',
    });
    // Non-relation field must remain unaffected.
    const name = fields.find((f) => f.key === 'name');
    expect(name).toMatchObject({ type: 'string', inputKind: 'text' });
    expect(name).not.toHaveProperty('targetRegistryId');
  });

  it('schemaToFormFields: field without x-relation stays string/text', () => {
    const plain = { type: 'object', properties: { x: { type: 'string' } } };
    const [f] = schemaToFormFields(plain);
    expect(f.inputKind).toBe('text');
    expect(f).not.toHaveProperty('targetRegistryId');
  });

  describe('validateRecordValues — relation field', () => {
    const fields = schemaToFormFields(SCHEMA_WITH_RELATION);

    it('rejects empty required relation', () => {
      const { valid, errors } = validateRecordValues(fields, { name: 'X', target: '' });
      expect(valid).toBe(false);
      expect(errors.target).toBeTruthy();
    });

    it('rejects a non-UUID value', () => {
      const { valid, errors } = validateRecordValues(fields, { name: 'X', target: 'not-a-uuid' });
      expect(valid).toBe(false);
      expect(errors.target).toBeTruthy();
    });

    it('accepts a valid UUID', () => {
      const { valid, errors } = validateRecordValues(fields, { name: 'X', target: VALID_UUID });
      expect(valid).toBe(true);
      expect(errors).toEqual({});
    });

    it('accepts blank optional relation (omit)', () => {
      const optionalSchema = {
        type: 'object', additionalProperties: false,
        properties: {
          ref: { type: 'string', 'x-relation': { target_registry_id: 'bbbbbbbb-0000-0000-0000-000000000002' } },
        },
      };
      const optFields = schemaToFormFields(optionalSchema);
      const { valid, errors } = validateRecordValues(optFields, { ref: '' });
      expect(valid).toBe(true);
      expect(errors.ref).toBeUndefined();
    });
  });

  describe('serializeRecordData — relation field', () => {
    const fields = schemaToFormFields(SCHEMA_WITH_RELATION);

    it('emits the UUID string under the key', () => {
      const data = serializeRecordData(fields, { name: 'Товар', target: VALID_UUID });
      expect(data.target).toBe(VALID_UUID);
      expect(typeof data.target).toBe('string');
      // The plain-string schema is AJV-valid for the persisted value.
      const relSchema = {
        type: 'object', additionalProperties: false,
        properties: { name: { type: 'string' }, target: { type: 'string' } },
        required: ['target'],
      };
      expect(backendValidate(relSchema, data).valid).toBe(true);
    });

    it('omits blank optional relation', () => {
      const optionalSchema = {
        type: 'object', additionalProperties: false,
        properties: {
          ref: { type: 'string', 'x-relation': { target_registry_id: 'bbbbbbbb-0000-0000-0000-000000000002' } },
        },
      };
      const optFields = schemaToFormFields(optionalSchema);
      const data = serializeRecordData(optFields, { ref: '' });
      expect('ref' in data).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// T-0449: collection (line-items) field type in records-form
// ---------------------------------------------------------------------------

// A collection schema as emitted by buildRecordSchema (T-0448).
// items is a typed object schema; sub-fields are scalars.
const COLLECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    order_name: { type: 'string', title: 'Название заказа' },
    lines: {
      type: 'array',
      title: 'Позиции',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          product: { type: 'string', title: 'Товар' },
          qty: { type: 'integer', title: 'Кол-во' },
          price: { type: 'number', title: 'Цена' },
          category: { type: 'string', enum: ['food', 'drink', 'other'], title: 'Категория' },
        },
        required: ['product', 'qty'],
      },
    },
  },
  required: ['lines'],
};

// Use the validateRecordAgainstSchema function from the real validator (T-0085).
// This proves the serialized data passes the actual server-side validator.
import { validateRecordAgainstSchema } from '../../../src/core/record-schema-validator.ts';

describe('T-0449: collection INPUT_KIND', () => {
  it('maps collection to "collection"', () => {
    expect(INPUT_KIND.collection).toBe('collection');
  });
});

describe('T-0449: schemaToFormFields — collection field', () => {
  const fields = schemaToFormFields(COLLECTION_SCHEMA);

  it('detects collection from type:"array"+items.type:"object"', () => {
    const linesField = fields.find((f) => f.key === 'lines');
    expect(linesField).toBeDefined();
    expect(linesField).toMatchObject({
      key: 'lines',
      type: 'collection',
      label: 'Позиции',
      required: true,
      inputKind: 'collection',
    });
    expect(Array.isArray(linesField.subFields)).toBe(true);
  });

  it('maps sub-fields to correct types and inputKinds', () => {
    const linesField = fields.find((f) => f.key === 'lines');
    const sf = Object.fromEntries(linesField.subFields.map((s) => [s.key, s]));
    // string sub-field
    expect(sf.product).toMatchObject({ type: 'string', inputKind: 'text', required: true });
    // integer sub-field
    expect(sf.qty).toMatchObject({ type: 'integer', inputKind: 'number', required: true });
    // number sub-field
    expect(sf.price).toMatchObject({ type: 'number', inputKind: 'number', required: false });
    // select sub-field (enum)
    expect(sf.category).toMatchObject({
      type: 'select',
      inputKind: 'select',
      options: ['food', 'drink', 'other'],
      required: false,
    });
  });

  it('non-collection fields remain unaffected', () => {
    const nameField = fields.find((f) => f.key === 'order_name');
    expect(nameField).toMatchObject({ type: 'string', inputKind: 'text' });
    expect(nameField).not.toHaveProperty('subFields');
  });

  it('tolerates collection with no sub-fields (empty items.properties)', () => {
    const emptySchema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {} } },
      },
    };
    const [f] = schemaToFormFields(emptySchema);
    expect(f).toMatchObject({ key: 'tags', type: 'collection', inputKind: 'collection' });
    expect(f.subFields).toEqual([]);
  });
});

describe('T-0449: blankRecordValues — collection field', () => {
  it('initializes a collection field to []', () => {
    const fields = schemaToFormFields(COLLECTION_SCHEMA);
    const vals = blankRecordValues(fields);
    expect(vals.lines).toEqual([]);
    expect(Array.isArray(vals.lines)).toBe(true);
    expect(vals.order_name).toBe(''); // non-collection unchanged
  });
});

describe('T-0449: validateRecordValues — collection field', () => {
  const fields = schemaToFormFields(COLLECTION_SCHEMA);

  it('required collection empty → error with _collection message', () => {
    const { valid, errors } = validateRecordValues(fields, { order_name: 'Test', lines: [] });
    expect(valid).toBe(false);
    expect(errors.lines).toBeDefined();
    expect(errors.lines._collection).toMatch(/строк/i);
  });

  it('required collection with a valid 2-row payload → no error', () => {
    const rows = [
      { product: 'Яблоко', qty: '3', price: '150.5', category: 'food' },
      { product: 'Кола', qty: '2', price: '', category: '' },
    ];
    const { valid, errors } = validateRecordValues(fields, { order_name: 'Заказ', lines: rows });
    expect(valid).toBe(true);
    expect(errors).toEqual({});
  });

  it('a row with a non-numeric value in an integer sub-field → per-cell error', () => {
    const rows = [{ product: 'Яблоко', qty: 'abc', price: '', category: '' }];
    const { valid, errors } = validateRecordValues(fields, { order_name: 'X', lines: rows });
    expect(valid).toBe(false);
    expect(errors.lines.rows).toBeDefined();
    expect(errors.lines.rows[0].qty).toMatch(/число/i);
  });

  it('a row with a fractional value in an integer sub-field → per-cell error', () => {
    const rows = [{ product: 'Яблоко', qty: '1.5', price: '', category: '' }];
    const { valid, errors } = validateRecordValues(fields, { order_name: 'X', lines: rows });
    expect(valid).toBe(false);
    expect(errors.lines.rows[0].qty).toMatch(/целое/i);
  });

  it('a row with a required string sub-field missing → per-cell error', () => {
    const rows = [{ product: '', qty: '1', price: '', category: '' }];
    const { valid, errors } = validateRecordValues(fields, { order_name: 'X', lines: rows });
    expect(valid).toBe(false);
    expect(errors.lines.rows[0].product).toMatch(/обязательн/i);
  });

  it('a row with a select value outside options → per-cell error', () => {
    const rows = [{ product: 'A', qty: '1', price: '', category: 'bogus' }];
    const { valid, errors } = validateRecordValues(fields, { order_name: 'X', lines: rows });
    expect(valid).toBe(false);
    expect(errors.lines.rows[0].category).toMatch(/списка/i);
  });

  it('error shape: rows array index corresponds to data row (valid rows are undefined)', () => {
    // Row 0 valid, row 1 invalid
    const rows = [
      { product: 'Яблоко', qty: '3', price: '', category: '' },
      { product: '', qty: 'bad', price: '', category: '' }, // two cell errors
    ];
    const { errors } = validateRecordValues(fields, { order_name: 'X', lines: rows });
    expect(errors.lines.rows[0]).toBeUndefined(); // row 0 valid
    expect(errors.lines.rows[1].product).toBeTruthy(); // required missing
    expect(errors.lines.rows[1].qty).toBeTruthy();    // non-numeric
  });

  it('optional collection empty → no error', () => {
    const optSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachments: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } } },
        },
      },
    };
    const optFields = schemaToFormFields(optSchema);
    const { valid } = validateRecordValues(optFields, { attachments: [] });
    expect(valid).toBe(true);
  });
});

describe('T-0449: serializeRecordData — collection field', () => {
  const fields = schemaToFormFields(COLLECTION_SCHEMA);

  it('emits an array of typed row objects (numbers as numbers)', () => {
    const rows = [
      { product: 'Яблоко', qty: '3', price: '150.5', category: 'food' },
      { product: 'Кола', qty: '2', price: '', category: '' },
    ];
    const data = serializeRecordData(fields, { order_name: 'Заказ 1', lines: rows });
    expect(Array.isArray(data.lines)).toBe(true);
    expect(data.lines).toHaveLength(2);
    expect(data.lines[0]).toMatchObject({ product: 'Яблоко', qty: 3, price: 150.5, category: 'food' });
    expect(typeof data.lines[0].qty).toBe('number');
    expect(typeof data.lines[0].price).toBe('number');
    // Blank optional cells omitted
    expect('price' in data.lines[1]).toBe(false);
    expect('category' in data.lines[1]).toBe(false);
    expect(data.lines[1]).toMatchObject({ product: 'Кола', qty: 2 });
  });

  it('drops fully-blank trailing rows', () => {
    const rows = [
      { product: 'Яблоко', qty: '1', price: '', category: '' },
      { product: '', qty: '', price: '', category: '' }, // trailing blank
    ];
    const data = serializeRecordData(fields, { order_name: 'X', lines: rows });
    expect(data.lines).toHaveLength(1);
  });

  it('optional empty collection → omit', () => {
    const optSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        tags: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' } } },
        },
      },
    };
    const optFields = schemaToFormFields(optSchema);
    const data = serializeRecordData(optFields, { tags: [] });
    expect('tags' in data).toBe(false);
  });

  it('required empty collection → emits [] (required-empty is caught by validateRecordValues)', () => {
    const data = serializeRecordData(fields, { order_name: '', lines: [] });
    // Required empty collection: serialized as [] (validation would have caught this)
    expect(data.lines).toEqual([]);
  });
});

describe('T-0449: serializeRecordData → validateRecordAgainstSchema round-trip', () => {
  const fields = schemaToFormFields(COLLECTION_SCHEMA);

  it('a 2-row collection serialized by serializeRecordData is accepted by the real validator', () => {
    const rows = [
      { product: 'Яблоко', qty: '5', price: '99', category: 'food' },
      { product: 'Кола', qty: '2', price: '', category: '' },
    ];
    const data = serializeRecordData(fields, { order_name: 'Заказ', lines: rows });

    // Use the real validator (same as the backend — T-0085).
    const schemaHistory = new Map([[1, COLLECTION_SCHEMA]]);
    const result = validateRecordAgainstSchema({ data, schema_version: 1 }, schemaHistory);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('serialized data with numbers as numbers passes; a string number would fail', () => {
    const schemaHistory = new Map([[1, COLLECTION_SCHEMA]]);

    // Hand-craft a BAD payload (qty as string) to prove AJV rejects it.
    const badData = { lines: [{ product: 'A', qty: '3' }] }; // qty string → should fail
    const badResult = validateRecordAgainstSchema({ data: badData, schema_version: 1 }, schemaHistory);
    expect(badResult.valid).toBe(false);

    // Our serializer produces the correct numeric type.
    const rows = [{ product: 'A', qty: '3', price: '', category: '' }];
    const goodData = serializeRecordData(fields, { order_name: '', lines: rows });
    const goodResult = validateRecordAgainstSchema({ data: goodData, schema_version: 1 }, schemaHistory);
    expect(goodResult.valid).toBe(true);
  });
});

describe('T-0449: formatCellValue — collection field', () => {
  it('returns «N позиций» style summary for a non-empty collection', () => {
    const twoRows = [{ product: 'A' }, { product: 'B' }];
    const result = formatCellValue(twoRows, 'collection');
    // Must contain the count and a «позиц*» word
    expect(result).toMatch(/^2\s+позиц/);
  });

  it('returns «—» for an empty collection array', () => {
    expect(formatCellValue([], 'collection')).toBe('—');
  });

  it('returns «—» for null collection value', () => {
    expect(formatCellValue(null, 'collection')).toBe('—');
  });

  it('returns «—» for undefined collection value', () => {
    expect(formatCellValue(undefined, 'collection')).toBe('—');
  });

  it('Russian grammatical forms: 1→позиция, 2→позиции, 5→позиций, 11→позиций, 21→позиция', () => {
    const arr = (n) => Array.from({ length: n }, () => ({}));
    expect(formatCellValue(arr(1), 'collection')).toBe('1 позиция');
    expect(formatCellValue(arr(2), 'collection')).toBe('2 позиции');
    expect(formatCellValue(arr(4), 'collection')).toBe('4 позиции');
    expect(formatCellValue(arr(5), 'collection')).toBe('5 позиций');
    expect(formatCellValue(arr(11), 'collection')).toBe('11 позиций');
    expect(formatCellValue(arr(21), 'collection')).toBe('21 позиция');
    expect(formatCellValue(arr(22), 'collection')).toBe('22 позиции');
  });

  it('is ADDITIVE: relation branch still returns RELATION_CELL_ASYNC (unchanged)', () => {
    const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    expect(formatCellValue(uuid, 'relation')).toBe(RELATION_CELL_ASYNC);
    expect(formatCellValue('', 'relation')).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// T-0450: LineItemsField logic — tests for the data/error model the row-table UI
// component consumes. Tests are pure-logic (node env, no DOM/RTL): they cover the
// helpers that LineItemsField depends on in records-form.js.
// Terminology: "add-row" → blank row appended to values array; "remove-row" →
// row dropped by index; "cell-edit" → value updated via onChange(fieldKey, rows).
// These are the three actions LineItemsField wires to its add/remove/setCellValue.
// ---------------------------------------------------------------------------

// A minimal collection field schema for test use
const COL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lines: {
      type: 'array',
      title: 'Позиции',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', title: 'Товар' },
          qty:  { type: 'integer', title: 'Кол-во' },
          active: { type: 'boolean', title: 'Активен' },
        },
        required: ['name', 'qty'],
      },
    },
  },
  required: ['lines'],
};

describe('T-0450 LineItemsField · blankRecordValues — add-row model', () => {
  it('collection field starts as an empty array (no rows)', () => {
    const fields = schemaToFormFields(COL_SCHEMA);
    const values = blankRecordValues(fields);
    expect(values.lines).toEqual([]);
  });

  it('schemaToFormFields: collection descriptor carries inputKind "collection" and subFields', () => {
    const fields = schemaToFormFields(COL_SCHEMA);
    const f = fields.find((x) => x.key === 'lines');
    expect(f).toBeDefined();
    expect(f.inputKind).toBe('collection');
    expect(Array.isArray(f.subFields)).toBe(true);
    expect(f.subFields.map((sf) => sf.key)).toEqual(['name', 'qty', 'active']);
    expect(f.subFields.find((sf) => sf.key === 'name').required).toBe(true);
    expect(f.subFields.find((sf) => sf.key === 'qty').required).toBe(true);
    expect(f.subFields.find((sf) => sf.key === 'active').required).toBe(false);
  });

  it('add-row simulation: appending a blank row and then another', () => {
    // Simulates what LineItemsField.addRow does: append a blank row object.
    const fields = schemaToFormFields(COL_SCHEMA);
    const f = fields.find((x) => x.key === 'lines');
    let rows = [];

    // Add first row (blank)
    const blankRow = {};
    for (const sf of f.subFields) blankRow[sf.key] = sf.type === 'boolean' ? false : '';
    rows = [...rows, blankRow];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ name: '', qty: '', active: false });

    // Add second row
    rows = [...rows, { ...blankRow }];
    expect(rows).toHaveLength(2);
  });

  it('remove-row simulation: dropping a row by index', () => {
    let rows = [
      { name: 'A', qty: '1', active: false },
      { name: 'B', qty: '2', active: true },
      { name: 'C', qty: '3', active: false },
    ];
    // Remove index 1 (simulates LineItemsField.removeRow(1))
    rows = rows.filter((_, i) => i !== 1);
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('A');
    expect(rows[1].name).toBe('C');
  });

  it('cell-edit simulation: updating a cell flows through to the rows array', () => {
    let rows = [
      { name: '', qty: '', active: false },
      { name: '', qty: '', active: false },
    ];
    // Edit row 0, cell 'name' (simulates LineItemsField.setCellValue(0, 'name', 'Laptop'))
    rows = rows.map((row, i) => i === 0 ? { ...row, name: 'Laptop' } : row);
    expect(rows[0].name).toBe('Laptop');
    expect(rows[1].name).toBe('');
  });
});

describe('T-0450 LineItemsField · validateRecordValues — per-row error shape', () => {
  const fields = schemaToFormFields(COL_SCHEMA);

  it('no error when rows are all valid', () => {
    const { valid, errors } = validateRecordValues(fields, {
      lines: [
        { name: 'Laptop', qty: '2', active: false },
        { name: 'Mouse',  qty: '1', active: true  },
      ],
    });
    expect(valid).toBe(true);
    expect(errors.lines).toBeUndefined();
  });

  it('_collection error when collection is required but rows are empty', () => {
    const { valid, errors } = validateRecordValues(fields, { lines: [] });
    expect(valid).toBe(false);
    expect(errors.lines._collection).toBeTruthy();
    // rows array is empty (no per-row errors)
    expect(errors.lines.rows).toEqual([]);
  });

  it('per-row error for a row missing a required string sub-field (name)', () => {
    const { valid, errors } = validateRecordValues(fields, {
      lines: [{ name: '', qty: '2', active: false }],
    });
    expect(valid).toBe(false);
    expect(errors.lines.rows).toHaveLength(1);
    expect(errors.lines.rows[0].name).toBeTruthy();
    expect(errors.lines.rows[0].qty).toBeUndefined(); // qty is valid
  });

  it('per-row error for a row with a non-numeric integer sub-field (qty)', () => {
    const { valid, errors } = validateRecordValues(fields, {
      lines: [{ name: 'X', qty: 'abc', active: false }],
    });
    expect(valid).toBe(false);
    expect(errors.lines.rows[0].qty).toBeTruthy();
    expect(errors.lines.rows[0].name).toBeUndefined(); // name is valid
  });

  it('per-row error for a fractional integer sub-field (qty=1.5)', () => {
    const { valid, errors } = validateRecordValues(fields, {
      lines: [{ name: 'X', qty: '1.5', active: false }],
    });
    expect(valid).toBe(false);
    expect(errors.lines.rows[0].qty).toBeTruthy();
  });

  it('row index alignment: row[0] valid, row[1] has error → rows[0]=undefined, rows[1]=error', () => {
    const { valid, errors } = validateRecordValues(fields, {
      lines: [
        { name: 'Good', qty: '1', active: false },
        { name: '',     qty: '1', active: true  }, // name missing
      ],
    });
    expect(valid).toBe(false);
    const rows = errors.lines.rows;
    expect(rows[0]).toBeUndefined();     // first row is valid
    expect(rows[1].name).toBeTruthy();  // second row has name error
  });

  it('boolean sub-field never produces a per-cell error', () => {
    const { valid, errors } = validateRecordValues(fields, {
      lines: [{ name: 'X', qty: '1', active: false }],
    });
    expect(valid).toBe(true);
    expect(errors.lines).toBeUndefined();
  });
});

describe('T-0450 LineItemsField · serializeRecordData — row array emitted', () => {
  const fields = schemaToFormFields(COL_SCHEMA);

  it('serializes a valid collection as a typed array', () => {
    const data = serializeRecordData(fields, {
      lines: [
        { name: 'Laptop', qty: '2', active: false },
        { name: 'Mouse',  qty: '1', active: true  },
      ],
    });
    expect(data.lines).toEqual([
      { name: 'Laptop', qty: 2, active: false },
      { name: 'Mouse',  qty: 1, active: true  },
    ]);
  });

  it('drops fully-blank trailing rows from the emitted array', () => {
    // NOTE: the blank-trailing-row check uses "hasContent" — a boolean sub-field
    // always counts as having content (checkbox state is definite). So to get a
    // truly blank trailing row we need a schema WITHOUT boolean sub-fields.
    // Use a simpler 2-sub-field schema (name+qty) for this test.
    const twoFieldSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        lines: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              qty:  { type: 'integer' },
            },
            required: ['name'],
          },
        },
      },
      required: ['lines'],
    };
    const twoFields = schemaToFormFields(twoFieldSchema);
    const data = serializeRecordData(twoFields, {
      lines: [
        { name: 'Laptop', qty: '1' },
        { name: '', qty: '' }, // fully blank trailing row (no boolean sub-fields)
      ],
    });
    expect(data.lines).toHaveLength(1);
    expect(data.lines[0].name).toBe('Laptop');
  });

  it('integer sub-field typed as JS number in the output', () => {
    const data = serializeRecordData(fields, {
      lines: [{ name: 'X', qty: '42', active: false }],
    });
    expect(typeof data.lines[0].qty).toBe('number');
    expect(data.lines[0].qty).toBe(42);
  });

  it('boolean sub-field emitted as real boolean regardless of checkbox state', () => {
    const data = serializeRecordData(fields, {
      lines: [
        { name: 'Y', qty: '1', active: true  },
        { name: 'N', qty: '2', active: false },
      ],
    });
    expect(data.lines[0].active).toBe(true);
    expect(data.lines[1].active).toBe(false);
  });

  it('empty array with required collection is emitted as [] (blank lines[] fails AJV required min, caught at validate)', () => {
    // serializeRecordData does not re-validate; it emits whatever the rows array contains.
    // (Blank-required is rejected by validateRecordValues before submit.)
    const data = serializeRecordData(fields, { lines: [] });
    // Required collection → still emitted (not omitted) because f.required=true
    expect(data.lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T-0453: computeRollup — pure aggregate fn + omit-on-serialize + round-trip
// ---------------------------------------------------------------------------

// A schema that includes a collection field and a computed (rollup) field.
// Emitted by buildRecordSchema (apps-schema.js) for a computed field.
const SCHEMA_WITH_COMPUTED = {
  type: 'object',
  additionalProperties: false,
  properties: {
    order_name: { type: 'string', title: 'Название заказа' },
    // collection source
    lines: {
      type: 'array',
      title: 'Позиции',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          product: { type: 'string', title: 'Товар' },
          qty: { type: 'number', title: 'Кол-во' },
          price: { type: 'number', title: 'Цена' },
        },
        required: ['product'],
      },
    },
    // computed field: sum of (price × qty)
    total: {
      type: 'number',
      title: 'Итого',
      'x-rollup': { source: 'lines', op: 'sum', value_field: 'price', factor_field: 'qty' },
    },
    // computed field: count of rows
    row_count: {
      type: 'number',
      title: 'Строк',
      'x-rollup': { source: 'lines', op: 'count', value_field: 'price' },
    },
  },
  required: ['order_name', 'lines'],
};

describe('T-0453: INPUT_KIND', () => {
  it('maps computed to "computed"', () => {
    expect(INPUT_KIND.computed).toBe('computed');
  });
});

describe('T-0453: schemaToFormFields — computed field', () => {
  const fields = schemaToFormFields(SCHEMA_WITH_COMPUTED);

  it('detects computed field from x-rollup, emits descriptor', () => {
    const totalField = fields.find((f) => f.key === 'total');
    expect(totalField).toBeDefined();
    expect(totalField).toMatchObject({
      key: 'total',
      type: 'computed',
      label: 'Итого',
      required: false, // computed fields are NEVER required
      inputKind: 'computed',
      rollupSource: 'lines',
      rollupOp: 'sum',
      rollupValueField: 'price',
      rollupFactorField: 'qty',
    });
  });

  it('non-computed fields remain unaffected', () => {
    const nameField = fields.find((f) => f.key === 'order_name');
    expect(nameField).toMatchObject({ type: 'string', inputKind: 'text' });
    expect(nameField).not.toHaveProperty('rollupSource');
    const linesField = fields.find((f) => f.key === 'lines');
    expect(linesField).toMatchObject({ type: 'collection', inputKind: 'collection' });
  });

  it('computed field without factor_field has empty rollupFactorField', () => {
    const rowCountField = fields.find((f) => f.key === 'row_count');
    expect(rowCountField).toMatchObject({ rollupFactorField: '' });
  });
});

describe('T-0453: computeRollup — op sum', () => {
  const field = {
    rollupSource: 'lines',
    rollupOp: 'sum',
    rollupValueField: 'price',
    rollupFactorField: '',
  };
  const data = {
    lines: [
      { price: 100, qty: 2 },
      { price: 50,  qty: 3 },
      { price: 200, qty: 1 },
    ],
  };

  it('sums value_field across rows', () => {
    expect(computeRollup(field, data)).toBe(350);
  });

  it('sum with factor_field: Σ value × factor (price × qty)', () => {
    const f = { ...field, rollupFactorField: 'qty' };
    // 100×2 + 50×3 + 200×1 = 200 + 150 + 200 = 550
    expect(computeRollup(f, data)).toBe(550);
  });

  it('empty source array → null', () => {
    expect(computeRollup(field, { lines: [] })).toBeNull();
  });

  it('missing source key → null', () => {
    expect(computeRollup(field, {})).toBeNull();
  });

  it('source is not an array → null', () => {
    expect(computeRollup(field, { lines: null })).toBeNull();
    expect(computeRollup(field, { lines: 'bad' })).toBeNull();
  });

  it('all cells non-numeric → null (not 0)', () => {
    expect(computeRollup(field, { lines: [{ price: 'n/a' }, { price: '' }] })).toBeNull();
  });

  it('skips non-numeric cells, sums the rest', () => {
    const d = { lines: [{ price: 10 }, { price: 'bad' }, { price: 20 }] };
    expect(computeRollup(field, d)).toBe(30);
  });

  it('numeric string values are coerced and included', () => {
    const d = { lines: [{ price: '100' }, { price: '50' }] };
    expect(computeRollup(field, d)).toBe(150);
  });
});

describe('T-0453: computeRollup — op count', () => {
  const field = { rollupSource: 'lines', rollupOp: 'count', rollupValueField: '', rollupFactorField: '' };

  it('counts all rows regardless of cell contents', () => {
    const data = { lines: [{ price: 1 }, { price: 'bad' }, { price: null }] };
    expect(computeRollup(field, data)).toBe(3);
  });

  it('empty array → null', () => {
    expect(computeRollup(field, { lines: [] })).toBeNull();
  });
});

describe('T-0453: computeRollup — op avg', () => {
  const field = { rollupSource: 'lines', rollupOp: 'avg', rollupValueField: 'price', rollupFactorField: '' };

  it('avg of 3 rows', () => {
    const data = { lines: [{ price: 10 }, { price: 20 }, { price: 30 }] };
    expect(computeRollup(field, data)).toBe(20);
  });

  it('skips non-numeric; avg of 2 out of 3 rows', () => {
    const data = { lines: [{ price: 10 }, { price: 'n/a' }, { price: 30 }] };
    expect(computeRollup(field, data)).toBe(20);
  });

  it('empty source → null', () => {
    expect(computeRollup(field, { lines: [] })).toBeNull();
  });
});

describe('T-0453: computeRollup — op min/max', () => {
  const minField = { rollupSource: 'v', rollupOp: 'min', rollupValueField: 'x', rollupFactorField: '' };
  const maxField = { rollupSource: 'v', rollupOp: 'max', rollupValueField: 'x', rollupFactorField: '' };

  const data = { v: [{ x: 30 }, { x: 5 }, { x: 20 }] };

  it('min over 3 rows', () => {
    expect(computeRollup(minField, data)).toBe(5);
  });

  it('max over 3 rows', () => {
    expect(computeRollup(maxField, data)).toBe(30);
  });

  it('all non-numeric → null', () => {
    expect(computeRollup(minField, { v: [{ x: '' }, { x: 'bad' }] })).toBeNull();
  });
});

describe('T-0453: computeRollup — edge cases', () => {
  it('null data → null', () => {
    const field = { rollupSource: 'lines', rollupOp: 'sum', rollupValueField: 'price', rollupFactorField: '' };
    expect(computeRollup(field, null)).toBeNull();
  });

  it('null field → null', () => {
    expect(computeRollup(null, { lines: [{ price: 1 }] })).toBeNull();
  });

  it('unknown op → null (degrade silently)', () => {
    const field = { rollupSource: 'lines', rollupOp: 'median', rollupValueField: 'x', rollupFactorField: '' };
    expect(computeRollup(field, { lines: [{ x: 1 }] })).toBeNull();
  });

  it('empty rollupSource → null', () => {
    const field = { rollupSource: '', rollupOp: 'sum', rollupValueField: 'x', rollupFactorField: '' };
    expect(computeRollup(field, { x: [1, 2, 3] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T-0453: serializeRecordData — computed field OMIT (THE KEY TRAP)
// ---------------------------------------------------------------------------

describe('T-0453: serializeRecordData — computed field omit', () => {
  const fields = schemaToFormFields(SCHEMA_WITH_COMPUTED);

  it('computed key is ABSENT from the serialized data', () => {
    const vals = { order_name: 'Заказ 1', lines: [{ product: 'A', qty: '2', price: '100' }] };
    const data = serializeRecordData(fields, vals);
    // The computed key must NEVER appear in the output
    expect('total' in data).toBe(false);
    expect('row_count' in data).toBe(false);
  });

  it('non-computed fields are still emitted correctly alongside computed', () => {
    const vals = { order_name: 'Заказ 1', lines: [{ product: 'A', qty: '2', price: '50' }] };
    const data = serializeRecordData(fields, vals);
    expect(data.order_name).toBe('Заказ 1');
    expect(Array.isArray(data.lines)).toBe(true);
  });

  it('serialized data passes the REAL validator (additionalProperties:false safe)', () => {
    // Prove that omitting the computed key keeps the record valid against the schema.
    // The schema has type:"number" for the computed field; AJV would reject a number
    // value under additionalProperties:false IF it weren't declared. It IS declared,
    // but it is also in properties — so omitting it is valid (it's not in required[]).
    // The critical test: AJV must not see the computed key in data, ever.
    const schemaHistory = new Map([[1, SCHEMA_WITH_COMPUTED]]);
    const vals = { order_name: 'Заказ 1', lines: [{ product: 'Товар', qty: '1', price: '100' }] };
    const data = serializeRecordData(fields, vals);
    expect('total' in data).toBe(false);   // computed OMITTED
    expect('row_count' in data).toBe(false); // computed OMITTED
    const result = validateRecordAgainstSchema({ data, schema_version: 1 }, schemaHistory);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('if someone incorrectly put a computed key in values, it is still omitted', () => {
    // Even if a caller passes total: 999 in the values (should never happen, but
    // guard-by-design), serializeRecordData must silently drop it.
    const vals = { order_name: 'X', lines: [], total: 999, row_count: 1 };
    const data = serializeRecordData(fields, vals);
    expect('total' in data).toBe(false);
    expect('row_count' in data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-0453: blankRecordValues — computed fields excluded
// ---------------------------------------------------------------------------

describe('T-0453: blankRecordValues — computed fields excluded', () => {
  const fields = schemaToFormFields(SCHEMA_WITH_COMPUTED);

  it('computed keys are absent from blank values (no user state for derived fields)', () => {
    const vals = blankRecordValues(fields);
    expect('total' in vals).toBe(false);
    expect('row_count' in vals).toBe(false);
  });

  it('non-computed fields are still initialized', () => {
    const vals = blankRecordValues(fields);
    expect(vals.order_name).toBe('');
    expect(vals.lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T-0453: validateRecordValues — computed fields skipped
// ---------------------------------------------------------------------------

describe('T-0453: validateRecordValues — computed fields skipped', () => {
  const fields = schemaToFormFields(SCHEMA_WITH_COMPUTED);

  it('computed fields produce no validation error even with missing/undefined value', () => {
    // Simulates the real flow: blank values do not include computed keys
    const vals = { order_name: 'Заказ', lines: [{ product: 'A', qty: '1', price: '50' }] };
    const { valid, errors } = validateRecordValues(fields, vals);
    expect(valid).toBe(true);
    expect(errors.total).toBeUndefined();
    expect(errors.row_count).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T-0453: formatCellValue — computed branch
// ---------------------------------------------------------------------------

describe('T-0453: formatCellValue — computed branch', () => {
  it('formats a finite number as string', () => {
    expect(formatCellValue(42, 'computed')).toBe('42');
    expect(formatCellValue(3.14, 'computed')).toBe('3.14');
    expect(formatCellValue(0, 'computed')).toBe('0');
  });

  it('returns «—» for null (no data / source empty)', () => {
    expect(formatCellValue(null, 'computed')).toBe('—');
  });

  it('returns «—» for undefined', () => {
    expect(formatCellValue(undefined, 'computed')).toBe('—');
  });

  it('returns «—» for NaN', () => {
    expect(formatCellValue(NaN, 'computed')).toBe('—');
  });

  it('returns «—» for Infinity', () => {
    expect(formatCellValue(Infinity, 'computed')).toBe('—');
  });

  it('rounds float display noise (0.1+0.2 float artifact)', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in JS float; should display as "0.3"
    const raw = 0.1 + 0.2;
    const display = formatCellValue(raw, 'computed');
    expect(display).toBe('0.3');
  });

  it('is ADDITIVE: relation branch still returns RELATION_CELL_ASYNC (unchanged)', () => {
    const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    expect(formatCellValue(uuid, 'relation')).toBe(RELATION_CELL_ASYNC);
    expect(formatCellValue('', 'relation')).toBe('—');
  });

  it('is ADDITIVE: collection branch still returns «N позиций» (unchanged)', () => {
    expect(formatCellValue([{}, {}], 'collection')).toBe('2 позиции');
    expect(formatCellValue([], 'collection')).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// T-0507: schemaToColumns — computed fields carry rollup props
// ---------------------------------------------------------------------------

describe('T-0507: schemaToColumns — computed columns carry rollup props', () => {
  const cols = schemaToColumns(SCHEMA_WITH_COMPUTED);

  it('computed column includes all four rollup props', () => {
    const totalCol = cols.find((c) => c.key === 'total');
    expect(totalCol).toBeDefined();
    expect(totalCol).toMatchObject({
      key: 'total',
      label: 'Итого',
      type: 'computed',
      rollupSource: 'lines',
      rollupOp: 'sum',
      rollupValueField: 'price',
      rollupFactorField: 'qty',
    });
  });

  it('computed column without factor_field has empty rollupFactorField', () => {
    const rowCountCol = cols.find((c) => c.key === 'row_count');
    expect(rowCountCol).toBeDefined();
    expect(rowCountCol.rollupFactorField).toBe('');
  });

  it('non-computed columns do NOT gain rollup props', () => {
    const nameCol = cols.find((c) => c.key === 'order_name');
    expect(nameCol).not.toHaveProperty('rollupSource');
    expect(nameCol).not.toHaveProperty('rollupOp');
    const linesCol = cols.find((c) => c.key === 'lines');
    expect(linesCol).not.toHaveProperty('rollupSource');
  });
});

// ---------------------------------------------------------------------------
// T-0507: list-cell rendering — computeRollup(column, rowData) via schemaToColumns
// ---------------------------------------------------------------------------

describe('T-0507: list cell — computeRollup via column object from schemaToColumns', () => {
  // Simulate the full path: schema → column objects, then use them in the list
  // cell renderer exactly as screen-app-records.jsx does after T-0507.
  const cols = schemaToColumns(SCHEMA_WITH_COMPUTED);
  const totalCol = cols.find((c) => c.key === 'total');
  const rowCountCol = cols.find((c) => c.key === 'row_count');

  // A record's stored data: computed key is absent (never stored, by design).
  const recordData = {
    order_name: 'Тестовый заказ',
    lines: [
      { product: 'Товар А', qty: 3, price: 100 },
      { product: 'Товар Б', qty: 2, price: 250 },
    ],
    // 'total' and 'row_count' deliberately absent (would be undefined in raw data)
  };

  it('computeRollup(col, data) yields correct sum×factor total (price×qty)', () => {
    // 3×100 + 2×250 = 300 + 500 = 800
    const result = computeRollup(totalCol, recordData);
    expect(result).toBe(800);
  });

  it('formatCellValue of the computed result is NOT "—"', () => {
    const cellVal = computeRollup(totalCol, recordData);
    const rendered = formatCellValue(cellVal, 'computed');
    expect(rendered).not.toBe('—');
    expect(rendered).toBe('800');
  });

  it('reading raw data[col.key] for a computed field gives undefined → "—" (old broken behaviour)', () => {
    // This documents the bug that T-0507 fixes.
    const rawVal = recordData[totalCol.key]; // undefined (never stored)
    expect(rawVal).toBeUndefined();
    expect(formatCellValue(rawVal, 'computed')).toBe('—');
  });

  it('computeRollup count column yields row count', () => {
    const result = computeRollup(rowCountCol, recordData);
    expect(result).toBe(2);
    expect(formatCellValue(result, 'computed')).toBe('2');
  });

  it('computeRollup with multiple line-items yields correct per-item sum', () => {
    const data = {
      lines: [
        { product: 'X', qty: 5, price: 10 },
        { product: 'Y', qty: 1, price: 200 },
        { product: 'Z', qty: 2, price: 50 },
      ],
    };
    // 5×10 + 1×200 + 2×50 = 50 + 200 + 100 = 350
    expect(computeRollup(totalCol, data)).toBe(350);
  });

  it('no line items → computeRollup returns null → formatCellValue returns "—"', () => {
    const emptyData = { order_name: 'Пусто', lines: [] };
    const result = computeRollup(totalCol, emptyData);
    expect(result).toBeNull();
    expect(formatCellValue(result, 'computed')).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// T-0509: money field type in records-form
// ---------------------------------------------------------------------------

// A schema with a money field as emitted by buildRecordSchema (apps-schema.js).
const SCHEMA_WITH_MONEY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', title: 'Название' },
    amount: {
      type: 'number',
      title: 'Сумма',
      'x-money': { currency: 'RUB' },
    },
  },
  required: ['amount'],
};

// AJV schema for the stored form: x-money is stripped (unknown keyword),
// leaving type:number. The server validator strips x-* before AJV compile.
const MONEY_STORED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    amount: { type: 'number' },
  },
  required: ['amount'],
};

describe('T-0509: money field type', () => {
  it('INPUT_KIND maps money to "money"', () => {
    expect(INPUT_KIND.money).toBe('money');
  });

  it('schemaToFormFields: detects money from x-money, emits type "money" and inputKind "money"', () => {
    const fields = schemaToFormFields(SCHEMA_WITH_MONEY);
    const moneyField = fields.find((f) => f.key === 'amount');
    expect(moneyField).toBeDefined();
    expect(moneyField).toMatchObject({
      key: 'amount',
      type: 'money',
      label: 'Сумма',
      required: true,
      inputKind: 'money',
    });
    // Non-money field must remain unaffected.
    const titleField = fields.find((f) => f.key === 'title');
    expect(titleField).toMatchObject({ type: 'string', inputKind: 'text' });
  });

  it('blankRecordValues: money field starts as ""', () => {
    const fields = schemaToFormFields(SCHEMA_WITH_MONEY);
    const vals = blankRecordValues(fields);
    expect(vals.amount).toBe('');
  });

  describe('validateRecordValues — money field', () => {
    const fields = schemaToFormFields(SCHEMA_WITH_MONEY);

    it('required money blank → error', () => {
      const { valid, errors } = validateRecordValues(fields, { title: 'X', amount: '' });
      expect(valid).toBe(false);
      expect(errors.amount).toBeTruthy();
    });

    it('non-numeric input → error', () => {
      const { valid, errors } = validateRecordValues(fields, { title: 'X', amount: 'abc' });
      expect(valid).toBe(false);
      expect(errors.amount).toMatch(/число/i);
    });

    it('valid numeric string → no error', () => {
      const { valid, errors } = validateRecordValues(fields, { title: 'X', amount: '1234567' });
      expect(valid).toBe(true);
      expect(errors).toEqual({});
    });

    it('fractional amount is valid (money is type:number, not integer)', () => {
      const { valid } = validateRecordValues(fields, { title: 'X', amount: '9999.99' });
      expect(valid).toBe(true);
    });
  });

  describe('serializeRecordData — money field round-trips as plain number', () => {
    const fields = schemaToFormFields(SCHEMA_WITH_MONEY);

    it('emits amount as a JS number (not string)', () => {
      const data = serializeRecordData(fields, { title: 'Контракт', amount: '1234567' });
      expect(data.amount).toBe(1234567);
      expect(typeof data.amount).toBe('number');
    });

    it('serialized money value passes AJV type:number validation (x-money stripped)', () => {
      const data = serializeRecordData(fields, { title: 'Оплата', amount: '99500' });
      // Prove the plain-number output passes the server validator shape
      // (x-money is stripped before AJV compile on the server side).
      expect(backendValidate(MONEY_STORED_SCHEMA, data).valid).toBe(true);
    });

    it('a string amount would be REJECTED by the server (proves typing matters)', () => {
      expect(backendValidate(MONEY_STORED_SCHEMA, { amount: '99500' }).valid).toBe(false);
    });

    it('optional blank money → omit (not NaN in payload)', () => {
      const optSchema = {
        type: 'object', additionalProperties: false,
        properties: { budget: { type: 'number', 'x-money': { currency: 'RUB' } } },
      };
      const optFields = schemaToFormFields(optSchema);
      const data = serializeRecordData(optFields, { budget: '' });
      expect('budget' in data).toBe(false);
    });
  });

  describe('formatCellValue — money field', () => {
    it('formats a large integer with currency formatting and ₽ symbol', () => {
      const result = formatCellValue(1234567, 'money');
      expect(typeof result).toBe('string');
      // Must contain the digits and the ₽ symbol (Intl formatting varies by environment
      // but the symbol and digits are stable).
      expect(result).toContain('₽');
      expect(result).toMatch(/1.?234.?567/); // digits with possible separator chars
    });

    it('null → "—"', () => {
      expect(formatCellValue(null, 'money')).toBe('—');
    });

    it('undefined → "—"', () => {
      expect(formatCellValue(undefined, 'money')).toBe('—');
    });

    it('zero → formatted string (not "—")', () => {
      const result = formatCellValue(0, 'money');
      expect(result).not.toBe('—');
      expect(result).toContain('₽');
    });

    it('NaN → "—"', () => {
      expect(formatCellValue(NaN, 'money')).toBe('—');
    });

    it('Infinity → "—"', () => {
      expect(formatCellValue(Infinity, 'money')).toBe('—');
    });

    it('is ADDITIVE: relation/collection/computed branches unchanged', () => {
      const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
      expect(formatCellValue(uuid, 'relation')).toBe(RELATION_CELL_ASYNC);
      expect(formatCellValue([], 'collection')).toBe('—');
      expect(formatCellValue(42, 'computed')).toBe('42');
    });
  });
});

// ---------------------------------------------------------------------------
// T-0510: x-field-order — field order preserved across jsonb roundtrip
// ---------------------------------------------------------------------------

describe('T-0510: schemaToFormFields — x-field-order ordering', () => {
  it('returns fields in x-field-order order even when properties keys are scrambled', () => {
    // Simulate jsonb scrambling: correct x-field-order, but properties keys reordered.
    const schema = {
      type: 'object',
      additionalProperties: false,
      'x-field-order': ['zeta', 'alpha', 'mid'],
      properties: {
        // Intentionally in alphabetical order (as jsonb might return them)
        alpha: { type: 'number' },
        mid: { type: 'boolean' },
        zeta: { type: 'string' },
      },
    };
    const fields = schemaToFormFields(schema);
    expect(fields.map((f) => f.key)).toEqual(['zeta', 'alpha', 'mid']);
  });

  it('appends properties keys not in x-field-order at the end', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      'x-field-order': ['a', 'b'],
      properties: {
        c: { type: 'string' }, // not in x-field-order
        b: { type: 'number' },
        a: { type: 'string' },
      },
    };
    const fields = schemaToFormFields(schema);
    expect(fields.map((f) => f.key)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to properties insertion order for legacy schemas without x-field-order', () => {
    // No x-field-order → legacy fallback behavior unchanged
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        zeta: { type: 'string' },
        alpha: { type: 'number' },
        mid: { type: 'boolean' },
      },
    };
    const fields = schemaToFormFields(schema);
    expect(fields.map((f) => f.key)).toEqual(['zeta', 'alpha', 'mid']);
  });

  it('skips x-field-order entries absent from properties', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      'x-field-order': ['a', 'ghost', 'b'],
      properties: {
        a: { type: 'string' },
        b: { type: 'number' },
      },
    };
    const fields = schemaToFormFields(schema);
    expect(fields.map((f) => f.key)).toEqual(['a', 'b']); // 'ghost' is skipped
  });
});

describe('T-0510: schemaToColumns — x-field-order ordering via schemaToFormFields', () => {
  it('schemaToColumns honours x-field-order (delegates through schemaToFormFields)', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      'x-field-order': ['zeta', 'alpha', 'mid'],
      properties: {
        alpha: { type: 'number', title: 'Alpha' },
        mid: { type: 'boolean', title: 'Mid' },
        zeta: { type: 'string', title: 'Zeta' },
      },
    };
    const cols = schemaToColumns(schema);
    expect(cols.map((c) => c.key)).toEqual(['zeta', 'alpha', 'mid']);
  });
});

// ---------------------------------------------------------------------------
// T-0512: multi-select field type
// ---------------------------------------------------------------------------

const MULTI_SELECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tags: {
      type: 'array',
      title: 'Метки',
      'x-multi-select': true,
      items: { type: 'string', enum: ['red', 'green', 'blue'] },
    },
  },
  required: ['tags'],
};

describe('T-0512: INPUT_KIND multi-select', () => {
  it('INPUT_KIND maps "multi-select" to "multi-select"', () => {
    expect(INPUT_KIND['multi-select']).toBe('multi-select');
  });
});

describe('T-0512: schemaToFormFields multi-select', () => {
  it('detects x-multi-select → type multi-select with options', () => {
    const fields = schemaToFormFields(MULTI_SELECT_SCHEMA);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      key: 'tags',
      type: 'multi-select',
      label: 'Метки',
      required: true,
      inputKind: 'multi-select',
      options: ['red', 'green', 'blue'],
    });
  });

  it('multi-select does NOT interfere with collection parsing (both type:array)', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        tags: { type: 'array', 'x-multi-select': true, items: { type: 'string', enum: ['a'] } },
        items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { v: { type: 'string' } } } },
      },
    };
    const fields = schemaToFormFields(schema);
    expect(fields.find((f) => f.key === 'tags').type).toBe('multi-select');
    expect(fields.find((f) => f.key === 'items').type).toBe('collection');
  });
});

describe('T-0512: blankRecordValues multi-select', () => {
  it('starts as an empty array', () => {
    const fields = schemaToFormFields(MULTI_SELECT_SCHEMA);
    const values = blankRecordValues(fields);
    expect(values.tags).toEqual([]);
  });
});

describe('T-0512: validateRecordValues multi-select', () => {
  const fields = schemaToFormFields(MULTI_SELECT_SCHEMA);

  it('required multi-select with empty array → error', () => {
    const { valid, errors } = validateRecordValues(fields, { tags: [] });
    expect(valid).toBe(false);
    expect(errors.tags).toBeTruthy();
  });

  it('required multi-select with valid values → no error', () => {
    const { valid, errors } = validateRecordValues(fields, { tags: ['red', 'green'] });
    expect(valid).toBe(true);
    expect(errors.tags).toBeUndefined();
  });

  it('rejects a value not in options', () => {
    const { valid, errors } = validateRecordValues(fields, { tags: ['red', 'purple'] });
    expect(valid).toBe(false);
    expect(errors.tags).toBeTruthy();
  });

  it('optional multi-select with empty array → no error', () => {
    const optionalSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        tags: { type: 'array', 'x-multi-select': true, items: { type: 'string', enum: ['a', 'b'] } },
      },
    };
    const optFields = schemaToFormFields(optionalSchema);
    const { valid } = validateRecordValues(optFields, { tags: [] });
    expect(valid).toBe(true);
  });
});

describe('T-0512: serializeRecordData multi-select', () => {
  const fields = schemaToFormFields(MULTI_SELECT_SCHEMA);

  it('emits an array of strings', () => {
    const data = serializeRecordData(fields, { tags: ['red', 'blue'] });
    expect(data.tags).toEqual(['red', 'blue']);
  });

  it('emits empty array for required field', () => {
    const data = serializeRecordData(fields, { tags: [] });
    expect(data.tags).toEqual([]);
  });

  it('omits optional empty multi-select', () => {
    const optionalSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        tags: { type: 'array', 'x-multi-select': true, items: { type: 'string', enum: ['a'] } },
      },
    };
    const optFields = schemaToFormFields(optionalSchema);
    const data = serializeRecordData(optFields, { tags: [] });
    expect('tags' in data).toBe(false);
  });
});

describe('T-0512: formatCellValue multi-select', () => {
  it('joins selected values with ", "', () => {
    expect(formatCellValue(['red', 'green'], 'multi-select')).toBe('red, green');
  });

  it('returns single selected value', () => {
    expect(formatCellValue(['blue'], 'multi-select')).toBe('blue');
  });

  it('returns "—" for empty array', () => {
    expect(formatCellValue([], 'multi-select')).toBe('—');
  });

  it('returns "—" for null', () => {
    expect(formatCellValue(null, 'multi-select')).toBe('—');
  });

  it('returns "—" for undefined', () => {
    expect(formatCellValue(undefined, 'multi-select')).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// T-0512: person field type
// ---------------------------------------------------------------------------

const PERSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    assignee: { type: 'string', 'x-person': true, title: 'Исполнитель' },
  },
  required: ['assignee'],
};

describe('T-0512: INPUT_KIND person', () => {
  it('INPUT_KIND maps "person" to "person"', () => {
    expect(INPUT_KIND['person']).toBe('person');
  });
});

describe('T-0512: schemaToFormFields person', () => {
  it('detects x-person → type person', () => {
    const fields = schemaToFormFields(PERSON_SCHEMA);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      key: 'assignee',
      type: 'person',
      label: 'Исполнитель',
      required: true,
      inputKind: 'person',
    });
  });

  it('person does NOT fall through to string', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        emp: { type: 'string', 'x-person': true },
        name: { type: 'string' },
      },
    };
    const fields = schemaToFormFields(schema);
    expect(fields.find((f) => f.key === 'emp').type).toBe('person');
    expect(fields.find((f) => f.key === 'name').type).toBe('string');
  });
});

describe('T-0512: blankRecordValues person', () => {
  it('starts as empty string', () => {
    const fields = schemaToFormFields(PERSON_SCHEMA);
    const values = blankRecordValues(fields);
    expect(values.assignee).toBe('');
  });
});

describe('T-0512: validateRecordValues person', () => {
  const fields = schemaToFormFields(PERSON_SCHEMA);

  it('required person with empty string → error', () => {
    const { valid, errors } = validateRecordValues(fields, { assignee: '' });
    expect(valid).toBe(false);
    expect(errors.assignee).toBeTruthy();
  });

  it('required person with non-empty id → no error', () => {
    const { valid, errors } = validateRecordValues(fields, { assignee: 'e-orlov' });
    expect(valid).toBe(true);
    expect(errors.assignee).toBeUndefined();
  });

  it('optional person with empty string → no error', () => {
    const optSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { emp: { type: 'string', 'x-person': true } },
    };
    const optFields = schemaToFormFields(optSchema);
    const { valid } = validateRecordValues(optFields, { emp: '' });
    expect(valid).toBe(true);
  });
});

describe('T-0512: serializeRecordData person', () => {
  const fields = schemaToFormFields(PERSON_SCHEMA);

  it('emits the employee id string', () => {
    const data = serializeRecordData(fields, { assignee: 'e-orlov' });
    expect(data.assignee).toBe('e-orlov');
    expect(typeof data.assignee).toBe('string');
  });

  it('omits optional blank person', () => {
    const optSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { emp: { type: 'string', 'x-person': true } },
    };
    const optFields = schemaToFormFields(optSchema);
    const data = serializeRecordData(optFields, { emp: '' });
    expect('emp' in data).toBe(false);
  });
});

describe('T-0512: formatCellValue person', () => {
  it('returns the employee name/id string when given a non-empty value', () => {
    expect(formatCellValue('e-orlov', 'person')).toBe('e-orlov');
    expect(formatCellValue('К. Орлов', 'person')).toBe('К. Орлов');
  });

  it('returns "—" for null', () => {
    expect(formatCellValue(null, 'person')).toBe('—');
  });

  it('returns "—" for undefined', () => {
    expect(formatCellValue(undefined, 'person')).toBe('—');
  });

  it('returns "—" for empty string', () => {
    expect(formatCellValue('', 'person')).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// T-0516: url and email field types
// ---------------------------------------------------------------------------

describe('T-0516: INPUT_KIND includes url and email', () => {
  it('url maps to "url"', () => {
    expect(INPUT_KIND.url).toBe('url');
  });

  it('email maps to "email"', () => {
    expect(INPUT_KIND.email).toBe('email');
  });
});

describe('T-0516: schemaToFormFields detects url/email by x-* annotation', () => {
  const urlSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      website: { type: 'string', 'x-url': true, title: 'Сайт' },
    },
    required: ['website'],
  };

  const emailSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      contact: { type: 'string', 'x-email': true, title: 'Email контакта' },
    },
  };

  it('detects url field (x-url) with correct inputKind', () => {
    const fields = schemaToFormFields(urlSchema);
    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe('url');
    expect(fields[0].inputKind).toBe('url');
    expect(fields[0].required).toBe(true);
    expect(fields[0].label).toBe('Сайт');
  });

  it('detects email field (x-email) with correct inputKind', () => {
    const fields = schemaToFormFields(emailSchema);
    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe('email');
    expect(fields[0].inputKind).toBe('email');
    expect(fields[0].required).toBe(false);
    expect(fields[0].label).toBe('Email контакта');
  });

  it('url/email do NOT fall through to plain string', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        link: { type: 'string', 'x-url': true },
        em: { type: 'string', 'x-email': true },
        name: { type: 'string' },
      },
    };
    const fields = schemaToFormFields(schema);
    expect(fields.find((f) => f.key === 'link').type).toBe('url');
    expect(fields.find((f) => f.key === 'em').type).toBe('email');
    expect(fields.find((f) => f.key === 'name').type).toBe('string');
  });
});

describe('T-0516: validateRecordValues url/email', () => {
  const urlField = { key: 'website', type: 'url', required: true, inputKind: 'url', label: 'Сайт' };
  const emailField = { key: 'contact', type: 'email', required: true, inputKind: 'email', label: 'Email' };

  // URL validation
  it('url: required + valid url passes', () => {
    const r = validateRecordValues([urlField], { website: 'https://example.com' });
    expect(r.valid).toBe(true);
  });

  it('url: required + missing → error', () => {
    const r = validateRecordValues([urlField], { website: '' });
    expect(r.valid).toBe(false);
    expect(r.errors.website).toBeTruthy();
  });

  it('url: required + malformed (no scheme) → error', () => {
    const r = validateRecordValues([urlField], { website: 'example.com' });
    expect(r.valid).toBe(false);
    expect(r.errors.website).toBeTruthy();
  });

  it('url: required + http:// also valid', () => {
    const r = validateRecordValues([urlField], { website: 'http://example.com' });
    expect(r.valid).toBe(true);
  });

  it('url: optional + blank → no error (omit)', () => {
    const optField = { ...urlField, required: false };
    const r = validateRecordValues([optField], { website: '' });
    expect(r.valid).toBe(true);
  });

  // Email validation
  it('email: required + valid email passes', () => {
    const r = validateRecordValues([emailField], { contact: 'user@example.com' });
    expect(r.valid).toBe(true);
  });

  it('email: required + missing → error', () => {
    const r = validateRecordValues([emailField], { contact: '' });
    expect(r.valid).toBe(false);
    expect(r.errors.contact).toBeTruthy();
  });

  it('email: required + malformed (no @) → error', () => {
    const r = validateRecordValues([emailField], { contact: 'notanemail' });
    expect(r.valid).toBe(false);
    expect(r.errors.contact).toBeTruthy();
  });

  it('email: required + malformed (no domain) → error', () => {
    const r = validateRecordValues([emailField], { contact: 'user@' });
    expect(r.valid).toBe(false);
    expect(r.errors.contact).toBeTruthy();
  });

  it('email: optional + blank → no error (omit)', () => {
    const optField = { ...emailField, required: false };
    const r = validateRecordValues([optField], { contact: '' });
    expect(r.valid).toBe(true);
  });
});

describe('T-0516: serializeRecordData url/email', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      website: { type: 'string', 'x-url': true },
      contact: { type: 'string', 'x-email': true },
      name: { type: 'string' },
    },
    required: ['website'],
  };
  const fields = schemaToFormFields(schema);

  it('url: serialized as plain string', () => {
    const data = serializeRecordData(fields, { website: 'https://example.com', contact: '', name: 'Test' });
    expect(data.website).toBe('https://example.com');
    expect(typeof data.website).toBe('string');
  });

  it('email: serialized as plain string', () => {
    const data = serializeRecordData(fields, { website: 'https://example.com', contact: 'a@b.com', name: '' });
    expect(data.contact).toBe('a@b.com');
  });

  it('url: optional blank → omitted', () => {
    const optSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { link: { type: 'string', 'x-url': true } },
    };
    const optFields = schemaToFormFields(optSchema);
    const data = serializeRecordData(optFields, { link: '' });
    expect('link' in data).toBe(false);
  });

  it('email: optional blank → omitted', () => {
    const optSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { em: { type: 'string', 'x-email': true } },
    };
    const optFields = schemaToFormFields(optSchema);
    const data = serializeRecordData(optFields, { em: '' });
    expect('em' in data).toBe(false);
  });
});

describe('T-0516: formatCellValue url/email', () => {
  it('url: returns the URL string for a non-empty value', () => {
    expect(formatCellValue('https://example.com', 'url')).toBe('https://example.com');
  });

  it('url: returns "—" for null', () => {
    expect(formatCellValue(null, 'url')).toBe('—');
  });

  it('url: returns "—" for empty string', () => {
    expect(formatCellValue('', 'url')).toBe('—');
  });

  it('email: returns the email string for a non-empty value', () => {
    expect(formatCellValue('user@example.com', 'email')).toBe('user@example.com');
  });

  it('email: returns "—" for null', () => {
    expect(formatCellValue(null, 'email')).toBe('—');
  });

  it('email: returns "—" for empty string', () => {
    expect(formatCellValue('', 'email')).toBe('—');
  });
});
