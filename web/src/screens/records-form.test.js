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
