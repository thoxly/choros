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
 * T-0294: tests for select (enum) and date field types.
 *
 * The "accepted by the real validator" guarantee is verified two ways:
 *   1. structurally — the shape matches the seeds + validator unit tests;
 *   2. directly — we import ajv (the SAME dependency the backend validator uses)
 *      and assert ajv.compile() in strict mode accepts every emitted schema,
 *      exactly as src/core/record-schema-validator.ts::validateRecordSchemaDefinition.
 */

import { describe, it, expect } from 'vitest';
import { Ajv } from 'ajv';
import { validateRecordSchemaDefinition } from '../../../src/core/record-schema-validator.ts';
import {
  FIELD_TYPES,
  FIELD_TYPE_VALUES,
  COLLECTION_SUB_FIELD_TYPES,
  ROLLUP_OPS,
  ROLLUP_OP_VALUES,
  validateField,
  validateFields,
  buildRecordSchema,
  parseRecordSchema,
  mapSchemaError,
  blankField,
  blankSubField,
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

// T-0294: AJV-primitive types that map directly to JSON Schema type values.
// "select" and "date" are EDITOR-LEVEL types — they map to "string" + optional
// "enum" in the JSON schema (buildRecordSchema handles this), not to a `type`
// value directly.
const JSON_SCHEMA_PRIMITIVE_TYPES = ['string', 'number', 'integer', 'boolean'];

describe('apps-schema · supported types', () => {
  it('JSON-Schema primitive types compile with AJV strict (no format, no enum)', () => {
    for (const t of JSON_SCHEMA_PRIMITIVE_TYPES) {
      const schema = { type: 'object', properties: { f: { type: t } }, additionalProperties: false };
      expect(backendAccepts(schema), `type "${t}" must compile`).toBe(true);
    }
  });

  it('T-0294: select and date are editor-level types (not raw AJV type values)', () => {
    // These types are valid in FIELD_TYPE_VALUES but do NOT map 1:1 to JSON Schema
    // "type" — they are converted by buildRecordSchema. The raw {"type":"select"}
    // would be rejected by AJV; that is expected. Use buildRecordSchema to get a
    // schema that the backend accepts.
    expect(FIELD_TYPE_VALUES).toContain('select');
    expect(FIELD_TYPE_VALUES).toContain('date');
    // Verify buildRecordSchema produces AJV-valid output for these types:
    const selectSchema = buildRecordSchema([{ key: 'status', type: 'select', options: ['a', 'b'], required: false }]);
    expect(backendAccepts(selectSchema)).toBe(true);
    const dateSchema = buildRecordSchema([{ key: 'due', type: 'date', required: false }]);
    expect(backendAccepts(dateSchema)).toBe(true);
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

// ---------------------------------------------------------------------------
// T-0294: select and date field types
// ---------------------------------------------------------------------------

describe('apps-schema T-0294 · select field type', () => {
  it('buildRecordSchema: select emits { type: "string", enum: [...] } (AJV-compilable)', () => {
    const schema = buildRecordSchema([
      { key: 'status', type: 'select', options: ['open', 'closed', 'pending'], required: true },
    ]);
    expect(schema.properties.status).toEqual({ type: 'string', enum: ['open', 'closed', 'pending'] });
    expect(backendAccepts(schema)).toBe(true);
    expect(schema.required).toEqual(['status']);
  });

  it('buildRecordSchema: select never emits `format`', () => {
    const schema = buildRecordSchema([{ key: 's', type: 'select', options: ['a'], required: false }]);
    expect(JSON.stringify(schema)).not.toContain('format');
  });

  it('buildRecordSchema: select AJV enum validation rejects non-enum value', () => {
    const schema = buildRecordSchema([{ key: 's', type: 'select', options: ['a', 'b'], required: false }]);
    const ajv = new Ajv();
    const validate = ajv.compile(schema);
    expect(validate({ s: 'a' })).toBe(true);
    expect(validate({ s: 'c' })).toBe(false); // 'c' not in enum → rejected
  });

  it('buildRecordSchema: select with title emits title in property', () => {
    const schema = buildRecordSchema([
      { key: 'stage', type: 'select', title: 'Стадия', options: ['lead', 'deal'], required: false },
    ]);
    expect(schema.properties.stage.title).toBe('Стадия');
    expect(schema.properties.stage.enum).toEqual(['lead', 'deal']);
    expect(backendAccepts(schema)).toBe(true);
  });

  it('buildRecordSchema: select deduplicates and trims options', () => {
    const schema = buildRecordSchema([
      { key: 's', type: 'select', options: [' a ', 'b', ' a '], required: false },
    ]);
    expect(schema.properties.s.enum).toEqual(['a', 'b']); // deduplicated + trimmed
  });

  it('parseRecordSchema: recognises a string+enum property as select', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        deal_stage: { type: 'string', enum: ['lead', 'qualified', 'won', 'lost'], title: 'Стадия сделки' },
      },
      required: ['deal_stage'],
    };
    const fields = parseRecordSchema(schema);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      key: 'deal_stage',
      type: 'select',
      title: 'Стадия сделки',
      required: true,
      options: ['lead', 'qualified', 'won', 'lost'],
    });
  });

  it('parseRecordSchema: round-trips a select field', () => {
    const fields = [{ key: 'status', type: 'select', title: 'Статус', options: ['new', 'done'], required: true }];
    const schema = buildRecordSchema(fields);
    const parsed = parseRecordSchema(schema);
    expect(parsed[0]).toMatchObject({ key: 'status', type: 'select', title: 'Статус', options: ['new', 'done'], required: true });
  });

  it('validateField: select without options → error', () => {
    const err = validateField({ key: 'status', type: 'select', options: [] });
    expect(err.options).toBeTruthy();
  });

  it('validateField: select with blank-only options → error', () => {
    const err = validateField({ key: 'status', type: 'select', options: ['  ', ''] });
    expect(err.options).toBeTruthy();
  });

  it('validateField: select with duplicate options → error', () => {
    const err = validateField({ key: 'status', type: 'select', options: ['a', 'b', 'a'] });
    expect(err.options).toBeTruthy();
  });

  it('validateField: select with valid options → no error', () => {
    const err = validateField({ key: 'status', type: 'select', options: ['open', 'closed'] });
    expect(err.options).toBeUndefined();
  });

  it('validateFields: accepts a select field with valid options', () => {
    const r = validateFields([{ key: 'status', type: 'select', options: ['open', 'closed'], required: true }]);
    expect(r.valid).toBe(true);
  });

  it('validateFields: rejects a select field with no options', () => {
    const r = validateFields([{ key: 'status', type: 'select', options: [], required: false }]);
    expect(r.valid).toBe(false);
    expect(r.fieldErrors[0].options).toBeTruthy();
  });
});

describe('apps-schema T-0294 · date field type', () => {
  it('buildRecordSchema: date emits { type: "string" } (no format — AJV strict rejects format:date)', () => {
    const schema = buildRecordSchema([
      { key: 'close_date', type: 'date', title: 'Дата закрытия', required: true },
    ]);
    expect(schema.properties.close_date).toEqual({ type: 'string', title: 'Дата закрытия' });
    expect(backendAccepts(schema)).toBe(true);
  });

  it('buildRecordSchema: date never emits `format`', () => {
    const schema = buildRecordSchema([{ key: 'd', type: 'date', required: false }]);
    expect(JSON.stringify(schema)).not.toContain('format');
    expect(backendAccepts(schema)).toBe(true);
  });

  it('buildRecordSchema: date schema accepts ISO date strings (as plain string validation)', () => {
    const schema = buildRecordSchema([{ key: 'd', type: 'date', required: true }]);
    const ajv = new Ajv();
    const validate = ajv.compile(schema);
    // AJV validates it as a string (format is not enforced); any non-empty string passes.
    expect(validate({ d: '2024-01-15' })).toBe(true);
    expect(validate({ d: 'not-a-date' })).toBe(true); // string type — AJV accepts it
    // The UI constrains input via <input type="date">, not the schema.
  });

  it('validateField: date field → no options error', () => {
    const err = validateField({ key: 'due', type: 'date' });
    expect(err.options).toBeUndefined();
    expect(Object.keys(err)).toHaveLength(0); // no errors for a valid date field
  });
});

// ---------------------------------------------------------------------------
// T-0444: relation field type
// ---------------------------------------------------------------------------

const TEST_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('apps-schema T-0444 · relation field type', () => {
  it('buildRecordSchema: relation emits { type:"string","x-relation":{target_registry_id:<uuid>} }', () => {
    const schema = buildRecordSchema([
      { key: 'kontragent', type: 'relation', targetRegistryId: TEST_UUID, required: false },
    ]);
    expect(schema.properties.kontragent).toEqual({
      type: 'string',
      'x-relation': { target_registry_id: TEST_UUID },
    });
  });

  it('buildRecordSchema: relation with required → included in required array', () => {
    const schema = buildRecordSchema([
      { key: 'kontragent', type: 'relation', targetRegistryId: TEST_UUID, required: true },
    ]);
    expect(schema.required).toEqual(['kontragent']);
  });

  it('buildRecordSchema: relation with title emits title in property', () => {
    const schema = buildRecordSchema([
      { key: 'kontragent', type: 'relation', title: 'Контрагент', targetRegistryId: TEST_UUID, required: false },
    ]);
    expect(schema.properties.kontragent.title).toBe('Контрагент');
    expect(schema.properties.kontragent['x-relation']).toEqual({ target_registry_id: TEST_UUID });
  });

  it('buildRecordSchema: x-relation schema does NOT compile with raw AJV strict (strip needed)', () => {
    // Confirms the validator strip is required — AJV strict rejects x-* keywords.
    const schema = buildRecordSchema([
      { key: 'kontragent', type: 'relation', targetRegistryId: TEST_UUID, required: false },
    ]);
    expect(backendAccepts(schema)).toBe(false); // raw schema fails AJV strict
  });

  it('buildRecordSchema: x-relation schema compiles after x-* strip (mirrors validator)', () => {
    const schema = buildRecordSchema([
      { key: 'kontragent', type: 'relation', targetRegistryId: TEST_UUID, required: false },
    ]);
    // Simulate the strip done by validateRecordSchemaDefinition.
    const strippedProps = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      const stripped = {};
      for (const [pk, pv] of Object.entries(v)) {
        if (!pk.startsWith('x-')) stripped[pk] = pv;
      }
      strippedProps[k] = stripped;
    }
    const stripped = { ...schema, properties: strippedProps };
    expect(backendAccepts(stripped)).toBe(true);
  });

  it('parseRecordSchema: detects x-relation → type relation + targetRegistryId', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        kontragent: {
          type: 'string',
          'x-relation': { target_registry_id: TEST_UUID },
          title: 'Контрагент',
        },
      },
      required: ['kontragent'],
    };
    const fields = parseRecordSchema(schema);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      key: 'kontragent',
      type: 'relation',
      title: 'Контрагент',
      required: true,
      targetRegistryId: TEST_UUID,
    });
  });

  it('parseRecordSchema: round-trips a relation field', () => {
    const fields = [
      { key: 'kontragent', type: 'relation', title: 'Контрагент', targetRegistryId: TEST_UUID, required: true },
    ];
    const schema = buildRecordSchema(fields);
    const parsed = parseRecordSchema(schema);
    expect(parsed[0]).toMatchObject({
      key: 'kontragent',
      type: 'relation',
      title: 'Контрагент',
      targetRegistryId: TEST_UUID,
      required: true,
    });
  });

  it('validateField: relation without targetRegistryId → error', () => {
    const err = validateField({ key: 'kontragent', type: 'relation' });
    expect(err.targetRegistryId).toBeTruthy();
  });

  it('validateField: relation with empty targetRegistryId → error', () => {
    const err = validateField({ key: 'kontragent', type: 'relation', targetRegistryId: '   ' });
    expect(err.targetRegistryId).toBeTruthy();
  });

  it('validateField: relation with valid targetRegistryId → no targetRegistryId error', () => {
    const err = validateField({ key: 'kontragent', type: 'relation', targetRegistryId: TEST_UUID });
    expect(err.targetRegistryId).toBeUndefined();
  });

  it('validateFields: accepts a relation field with valid targetRegistryId', () => {
    const r = validateFields([
      { key: 'kontragent', type: 'relation', targetRegistryId: TEST_UUID, required: false },
    ]);
    expect(r.valid).toBe(true);
  });

  it('validateFields: rejects a relation field with no targetRegistryId', () => {
    const r = validateFields([
      { key: 'kontragent', type: 'relation', required: false },
    ]);
    expect(r.valid).toBe(false);
    expect(r.fieldErrors[0].targetRegistryId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// T-0448: collection field type
// ---------------------------------------------------------------------------

describe('apps-schema T-0448 · collection field type — FIELD_TYPES / constants', () => {
  it('FIELD_TYPES includes collection with label "Список строк"', () => {
    const entry = FIELD_TYPES.find((t) => t.value === 'collection');
    expect(entry).toBeDefined();
    expect(entry.label).toBe('Список строк');
  });

  it('FIELD_TYPE_VALUES includes "collection"', () => {
    expect(FIELD_TYPE_VALUES).toContain('collection');
  });

  it('COLLECTION_SUB_FIELD_TYPES contains scalars but NOT collection/relation (depth cap 1)', () => {
    expect(COLLECTION_SUB_FIELD_TYPES).toContain('string');
    expect(COLLECTION_SUB_FIELD_TYPES).toContain('number');
    expect(COLLECTION_SUB_FIELD_TYPES).toContain('integer');
    expect(COLLECTION_SUB_FIELD_TYPES).toContain('boolean');
    expect(COLLECTION_SUB_FIELD_TYPES).toContain('select');
    expect(COLLECTION_SUB_FIELD_TYPES).toContain('date');
    expect(COLLECTION_SUB_FIELD_TYPES).not.toContain('collection');
    expect(COLLECTION_SUB_FIELD_TYPES).not.toContain('relation');
  });
});

describe('apps-schema T-0448 · collection field type — buildRecordSchema', () => {
  // Shared fixture: a collection field for «позиции» with 3 sub-fields.
  const positionsField = {
    key: 'positions',
    type: 'collection',
    title: 'Позиции',
    required: true,
    subFields: [
      { key: 'tovar', type: 'string', label: 'Товар', required: true },
      { key: 'kolichestvo', type: 'integer', label: 'Количество', required: true },
      { key: 'tsena', type: 'number', label: 'Цена', required: false },
    ],
  };

  it('emits a native array sub-schema (no x-* extensions)', () => {
    const schema = buildRecordSchema([positionsField]);
    const prop = schema.properties.positions;
    expect(prop.type).toBe('array');
    expect(prop.items.type).toBe('object');
    expect(prop.items.additionalProperties).toBe(false);
    expect(prop.items.properties).toMatchObject({
      tovar: { type: 'string', title: 'Товар' },
      kolichestvo: { type: 'integer', title: 'Количество' },
      tsena: { type: 'number', title: 'Цена' },
    });
    expect(prop.items.required).toEqual(['tovar', 'kolichestvo']);
    // No x-* keys anywhere in the emitted prop
    expect(JSON.stringify(prop)).not.toContain('x-');
  });

  it('validateRecordSchemaDefinition(emitted) returns valid===true (AJV strict native compile)', () => {
    const schema = buildRecordSchema([positionsField]);
    const result = validateRecordSchemaDefinition(schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('collection field is included in required[] of the outer schema when required:true', () => {
    const schema = buildRecordSchema([positionsField]);
    expect(schema.required).toContain('positions');
  });

  it('collection field omits required key when required:false', () => {
    const schema = buildRecordSchema([{ ...positionsField, required: false }]);
    expect(schema.required).toBeUndefined();
  });

  it('collection title is emitted as prop.title', () => {
    const schema = buildRecordSchema([positionsField]);
    expect(schema.properties.positions.title).toBe('Позиции');
  });

  it('sub-field with no label → title is omitted from items.properties[key]', () => {
    const schema = buildRecordSchema([{
      key: 'items_col',
      type: 'collection',
      required: false,
      subFields: [{ key: 'val', type: 'string', label: '', required: false }],
    }]);
    const subProp = schema.properties.items_col.items.properties.val;
    expect('title' in subProp).toBe(false);
  });

  it('collection with 0 subFields emits empty items.properties and no items.required', () => {
    const schema = buildRecordSchema([{
      key: 'empty_col',
      type: 'collection',
      required: false,
      subFields: [],
    }]);
    const prop = schema.properties.empty_col;
    expect(prop.type).toBe('array');
    expect(prop.items.properties).toEqual({});
    expect('required' in prop.items).toBe(false);
  });

  it('sub-field type select → emits string+enum inside items.properties', () => {
    const schema = buildRecordSchema([{
      key: 'orders',
      type: 'collection',
      required: false,
      subFields: [
        { key: 'status', type: 'select', label: 'Статус', options: ['new', 'done'], required: false },
      ],
    }]);
    const sfProp = schema.properties.orders.items.properties.status;
    expect(sfProp.type).toBe('string');
    expect(sfProp.enum).toEqual(['new', 'done']);
    expect(sfProp.title).toBe('Статус');
  });

  it('sub-field type date → emits string (no format) inside items.properties', () => {
    const schema = buildRecordSchema([{
      key: 'schedule',
      type: 'collection',
      required: false,
      subFields: [
        { key: 'due_date', type: 'date', label: 'Дата', required: false },
      ],
    }]);
    const sfProp = schema.properties.schedule.items.properties.due_date;
    expect(sfProp.type).toBe('string');
    expect('enum' in sfProp).toBe(false);
    expect('format' in sfProp).toBe(false);
  });

  it('collection alongside scalar field — both compile and outer schema is AJV-valid', () => {
    const schema = buildRecordSchema([
      { key: 'title', type: 'string', required: true },
      positionsField,
    ]);
    const result = validateRecordSchemaDefinition(schema);
    expect(result.valid).toBe(true);
    expect(Object.keys(schema.properties)).toEqual(['title', 'positions']);
  });

  it('emitted collection schema validates a conforming data row', () => {
    const schema = buildRecordSchema([positionsField]);
    const ajv = new Ajv();
    const validate = ajv.compile(schema);
    // Valid: positions is an array of objects with required keys
    expect(validate({
      positions: [
        { tovar: 'Laptop', kolichestvo: 2, tsena: 999.99 },
        { tovar: 'Mouse', kolichestvo: 1 }, // tsena not required
      ],
    })).toBe(true);
  });

  it('emitted collection schema rejects a row with missing required sub-field', () => {
    const schema = buildRecordSchema([positionsField]);
    const ajv = new Ajv();
    const validate = ajv.compile(schema);
    // Missing required 'kolichestvo' in first item
    expect(validate({ positions: [{ tovar: 'Laptop' }] })).toBe(false);
  });

  it('emitted collection schema rejects extra properties in items (additionalProperties:false)', () => {
    const schema = buildRecordSchema([positionsField]);
    const ajv = new Ajv();
    const validate = ajv.compile(schema);
    expect(validate({ positions: [{ tovar: 'x', kolichestvo: 1, extra_key: 'bad' }] })).toBe(false);
  });
});

describe('apps-schema T-0448 · collection field type — parseRecordSchema (round-trip)', () => {
  const positionsField = {
    key: 'positions',
    type: 'collection',
    title: 'Позиции',
    required: true,
    subFields: [
      { key: 'tovar', type: 'string', label: 'Товар', required: true },
      { key: 'kolichestvo', type: 'integer', label: 'Количество', required: true },
      { key: 'tsena', type: 'number', label: 'Цена', required: false },
    ],
  };

  it('round-trips a collection field (buildRecordSchema → parseRecordSchema ≈ original)', () => {
    const schema = buildRecordSchema([positionsField]);
    const parsed = parseRecordSchema(schema);
    expect(parsed).toHaveLength(1);
    const f = parsed[0];
    expect(f.type).toBe('collection');
    expect(f.key).toBe('positions');
    expect(f.title).toBe('Позиции');
    expect(f.required).toBe(true);
    expect(f.subFields).toHaveLength(3);
    expect(f.subFields[0]).toMatchObject({ key: 'tovar', type: 'string', label: 'Товар', required: true });
    expect(f.subFields[1]).toMatchObject({ key: 'kolichestvo', type: 'integer', label: 'Количество', required: true });
    expect(f.subFields[2]).toMatchObject({ key: 'tsena', type: 'number', label: 'Цена', required: false });
  });

  it('parseRecordSchema detects persisted array+object schema as collection', () => {
    const raw = {
      type: 'object',
      additionalProperties: false,
      properties: {
        positions: {
          type: 'array',
          title: 'Позиции',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              tovar: { type: 'string', title: 'Товар' },
              tsena: { type: 'number', title: 'Цена' },
            },
            required: ['tovar'],
          },
        },
      },
      required: ['positions'],
    };
    const parsed = parseRecordSchema(raw);
    expect(parsed).toHaveLength(1);
    const f = parsed[0];
    expect(f.type).toBe('collection');
    expect(f.key).toBe('positions');
    expect(f.title).toBe('Позиции');
    expect(f.required).toBe(true);
    expect(f.subFields).toHaveLength(2);
    expect(f.subFields[0]).toMatchObject({ key: 'tovar', type: 'string', label: 'Товар', required: true });
    expect(f.subFields[1]).toMatchObject({ key: 'tsena', type: 'number', label: 'Цена', required: false });
  });

  it('round-trips a collection with a select sub-field', () => {
    const original = {
      key: 'orders',
      type: 'collection',
      title: '',
      required: false,
      subFields: [
        { key: 'status', type: 'select', label: 'Статус', options: ['new', 'done'], required: false },
      ],
    };
    const schema = buildRecordSchema([original]);
    const parsed = parseRecordSchema(schema);
    const sf = parsed[0].subFields[0];
    expect(sf.type).toBe('select');
    expect(sf.options).toEqual(['new', 'done']);
    expect(sf.label).toBe('Статус');
  });

  it('collection does NOT interfere with scalar field parsing', () => {
    const schema = buildRecordSchema([
      { key: 'name', type: 'string', title: 'Имя', required: true },
      {
        key: 'items',
        type: 'collection',
        title: 'Строки',
        required: false,
        subFields: [{ key: 'val', type: 'string', label: 'Значение', required: false }],
      },
    ]);
    const parsed = parseRecordSchema(schema);
    expect(parsed[0]).toMatchObject({ key: 'name', type: 'string', title: 'Имя', required: true });
    expect(parsed[1]).toMatchObject({ key: 'items', type: 'collection', required: false });
  });
});

describe('apps-schema T-0448 · collection field type — validateField', () => {
  it('rejects a collection with 0 sub-fields', () => {
    const err = validateField({ key: 'items', type: 'collection', subFields: [] });
    expect(err.subFields).toBeTruthy();
  });

  it('rejects a collection with undefined subFields (treated as 0)', () => {
    const err = validateField({ key: 'items', type: 'collection' });
    expect(err.subFields).toBeTruthy();
  });

  it('rejects a collection whose sub-field type is "collection" (depth cap 1)', () => {
    const err = validateField({
      key: 'items',
      type: 'collection',
      subFields: [{ key: 'nested', type: 'collection' }],
    });
    expect(err.subFields).toBeTruthy();
    expect(err.subFields).toMatch(/collection/);
  });

  it('rejects a collection whose sub-field type is "relation" (depth cap 1)', () => {
    const err = validateField({
      key: 'items',
      type: 'collection',
      subFields: [{ key: 'ref', type: 'relation' }],
    });
    expect(err.subFields).toBeTruthy();
    expect(err.subFields).toMatch(/relation/);
  });

  it('rejects a collection with an unknown sub-field type', () => {
    const err = validateField({
      key: 'items',
      type: 'collection',
      subFields: [{ key: 'x', type: 'object' }],
    });
    expect(err.subFields).toBeTruthy();
  });

  it('accepts a collection with valid scalar sub-fields (no error)', () => {
    const err = validateField({
      key: 'positions',
      type: 'collection',
      subFields: [
        { key: 'tovar', type: 'string' },
        { key: 'kolichestvo', type: 'integer' },
        { key: 'tsena', type: 'number' },
      ],
    });
    expect(err.subFields).toBeUndefined();
  });

  it('accepts a collection with a select sub-field (scalar)', () => {
    const err = validateField({
      key: 'items',
      type: 'collection',
      subFields: [{ key: 'status', type: 'select', options: ['a', 'b'] }],
    });
    expect(err.subFields).toBeUndefined();
  });

  it('accepts a collection with a date sub-field (scalar)', () => {
    const err = validateField({
      key: 'items',
      type: 'collection',
      subFields: [{ key: 'due', type: 'date' }],
    });
    expect(err.subFields).toBeUndefined();
  });

  it('validateFields: accepts a valid collection field in a list', () => {
    const r = validateFields([{
      key: 'positions',
      type: 'collection',
      subFields: [{ key: 'val', type: 'string' }],
      required: false,
    }]);
    expect(r.valid).toBe(true);
  });

  it('validateFields: rejects a collection with 0 sub-fields', () => {
    const r = validateFields([{
      key: 'positions',
      type: 'collection',
      subFields: [],
      required: false,
    }]);
    expect(r.valid).toBe(false);
    expect(r.fieldErrors[0].subFields).toBeTruthy();
  });
});

describe('apps-schema T-0448 · collection field type — blankField / blankSubField', () => {
  it('blankField includes subFields:[] (collection-ready)', () => {
    const b = blankField();
    expect(Array.isArray(b.subFields)).toBe(true);
    expect(b.subFields).toHaveLength(0);
  });

  it('blankSubField returns a valid sub-field stub', () => {
    const sf = blankSubField();
    expect(sf.key).toBe('');
    expect(sf.type).toBe('string');
    expect(sf.label).toBe('');
    expect(sf.required).toBe(false);
    expect(Array.isArray(sf.options)).toBe(true);
    // Sub-field type must be a valid scalar
    expect(COLLECTION_SUB_FIELD_TYPES).toContain(sf.type);
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

// ---------------------------------------------------------------------------
// T-0450: collection sub-field KEY validation (the new validateField fix)
// ---------------------------------------------------------------------------

describe('apps-schema T-0450 · collection sub-field key validation', () => {
  // Helper: build a collection field with the given sub-fields array
  const makeCol = (subFields) => ({
    key: 'items',
    type: 'collection',
    subFields,
  });

  it('rejects a sub-field with an empty key', () => {
    const err = validateField(makeCol([{ key: '', type: 'string' }]));
    expect(err.subFields).toBeTruthy();
    expect(err.subFields).toMatch(/ключ/i);
  });

  it('rejects a sub-field key that starts with a digit', () => {
    const err = validateField(makeCol([{ key: '1bad', type: 'string' }]));
    expect(err.subFields).toBeTruthy();
  });

  it('rejects a sub-field key with a hyphen (not an identifier char)', () => {
    const err = validateField(makeCol([{ key: 'bad-key', type: 'string' }]));
    expect(err.subFields).toBeTruthy();
  });

  it('rejects a sub-field key with a space', () => {
    const err = validateField(makeCol([{ key: 'bad key', type: 'string' }]));
    expect(err.subFields).toBeTruthy();
  });

  it('rejects duplicate sub-field keys within the same collection', () => {
    const err = validateField(makeCol([
      { key: 'price', type: 'number' },
      { key: 'price', type: 'string' },
    ]));
    expect(err.subFields).toBeTruthy();
    expect(err.subFields).toMatch(/уже используется/i);
  });

  it('rejects the second of three duplicate keys (first and third differ)', () => {
    const err = validateField(makeCol([
      { key: 'a', type: 'string' },
      { key: 'b', type: 'string' },
      { key: 'a', type: 'number' }, // duplicate of first
    ]));
    expect(err.subFields).toBeTruthy();
  });

  it('accepts a sub-field key that starts with an underscore', () => {
    const err = validateField(makeCol([{ key: '_col', type: 'string' }]));
    expect(err.subFields).toBeUndefined();
  });

  it('accepts a sub-field key with letters, digits, and underscore', () => {
    const err = validateField(makeCol([
      { key: 'col_1', type: 'string' },
      { key: 'col_2', type: 'number' },
    ]));
    expect(err.subFields).toBeUndefined();
  });

  it('accepts a collection with two distinct valid keys and valid types (no error)', () => {
    const err = validateField(makeCol([
      { key: 'name', type: 'string' },
      { key: 'qty', type: 'integer' },
    ]));
    expect(err.subFields).toBeUndefined();
    expect(Object.keys(err)).toHaveLength(0);
  });

  it('reports both a key error and a dup error when a bad+dup key appears', () => {
    // First sub-field has an invalid key AND is duplicated by the second
    const err = validateField(makeCol([
      { key: '1bad', type: 'string' },
      { key: '1bad', type: 'number' }, // invalid + duplicate
    ]));
    expect(err.subFields).toBeTruthy();
  });

  it('validateFields: propagates sub-field key error through validateFields', () => {
    const r = validateFields([makeCol([{ key: '1bad', type: 'string' }])]);
    expect(r.valid).toBe(false);
    expect(r.fieldErrors[0].subFields).toBeTruthy();
  });

  it('validateFields: accepts a collection with valid sub-field keys', () => {
    const r = validateFields([makeCol([
      { key: 'product', type: 'string' },
      { key: 'qty', type: 'integer' },
    ])]);
    expect(r.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-0450 Fix 1 (G3 BLOCKING): select sub-field in a collection requires ≥1 option.
// Without options the record-entry <select> cell has zero choices → unfillable.
// ---------------------------------------------------------------------------

describe('apps-schema T-0450 Fix 1 · select column options validation', () => {
  const makeSelectCol = (options) => ({
    key: 'items',
    type: 'collection',
    subFields: [{ key: 'status', type: 'select', options }],
  });

  it('validateField: select sub-field with no options → error (Укажите варианты)', () => {
    const err = validateField(makeSelectCol([]));
    expect(err.subFields).toBeTruthy();
    expect(err.subFields).toMatch(/варианты для колонки-списка/i);
  });

  it('validateField: select sub-field with blank-only options → error', () => {
    const err = validateField(makeSelectCol(['  ', '']));
    expect(err.subFields).toBeTruthy();
    expect(err.subFields).toMatch(/варианты для колонки-списка/i);
  });

  it('validateField: select sub-field with undefined options → error', () => {
    const err = validateField({
      key: 'items',
      type: 'collection',
      subFields: [{ key: 'status', type: 'select' }], // no options property
    });
    expect(err.subFields).toBeTruthy();
    expect(err.subFields).toMatch(/варианты для колонки-списка/i);
  });

  it('validateField: select sub-field with valid options → no error', () => {
    const err = validateField(makeSelectCol(['new', 'done', 'cancelled']));
    expect(err.subFields).toBeUndefined();
  });

  it('validateField: select sub-field with one valid option → no error', () => {
    const err = validateField(makeSelectCol(['only']));
    expect(err.subFields).toBeUndefined();
  });

  it('validateField: non-select sub-field with no options → no options error', () => {
    // string, number, integer, boolean sub-fields do not require options
    for (const type of ['string', 'number', 'integer', 'boolean', 'date']) {
      const err = validateField({
        key: 'items',
        type: 'collection',
        subFields: [{ key: 'col', type }],
      });
      // Might have other errors (e.g. date) but NOT options-related
      expect(err.subFields || '').not.toMatch(/варианты для колонки-списка/i);
    }
  });

  it('validateField: mixed sub-fields where only select is missing options → error for that sub-field', () => {
    const err = validateField({
      key: 'items',
      type: 'collection',
      subFields: [
        { key: 'name', type: 'string' },           // ok
        { key: 'status', type: 'select', options: [] }, // missing options → error
      ],
    });
    expect(err.subFields).toBeTruthy();
    expect(err.subFields).toMatch(/варианты для колонки-списка/i);
  });

  it('validateField: select sub-field with valid options round-trips to populated enum in schema', () => {
    // The schema emitted for a collection with a select sub-field should carry
    // the options as the enum array — confirming the cell <select> will show them.
    const field = {
      key: 'orders',
      type: 'collection',
      required: false,
      subFields: [{ key: 'status', type: 'select', label: 'Статус', options: ['new', 'done'], required: false }],
    };
    const err = validateField(field);
    expect(err.subFields).toBeUndefined(); // passes validation
    const schema = buildRecordSchema([field]);
    const sfProp = schema.properties.orders.items.properties.status;
    // Emitted enum from the options → the cell <select> will have these choices
    expect(sfProp.enum).toEqual(['new', 'done']);
  });

  it('select sub-field emits enum in schema → verifies <select> options round-trip', () => {
    // Structural integration: the schema emitted by buildRecordSchema for a select
    // sub-field carries an enum array. schemaToFormFields (records-form.js T-0449)
    // reads this enum and populates options[] on the form field descriptor.
    // FieldControl uses options[] to render <option> elements.
    // This chain guarantees the <select> cell in LineItemsField is NOT empty.
    const field = {
      key: 'orders',
      type: 'collection',
      required: false,
      subFields: [{ key: 'cat', type: 'select', label: 'Категория', options: ['A', 'B', 'C'], required: true }],
    };
    // Step 1: validation passes
    const err = validateField(field);
    expect(err.subFields).toBeUndefined();
    // Step 2: buildRecordSchema emits the enum on the sub-field prop
    const schema = buildRecordSchema([field]);
    const catProp = schema.properties.orders.items.properties.cat;
    expect(catProp.type).toBe('string');
    expect(catProp.enum).toEqual(['A', 'B', 'C']); // options → enum round-trip
    // Step 3: parseRecordSchema detects enum → type:'select' with options (T-0448)
    const parsed = parseRecordSchema(schema);
    const sf = parsed[0].subFields[0];
    expect(sf.type).toBe('select');
    expect(sf.options).toEqual(['A', 'B', 'C']); // options preserved end-to-end
  });
});

// ---------------------------------------------------------------------------
// T-0452: computed (Итог / rollup) field type
// ---------------------------------------------------------------------------

// Shared fixture: a collection field with numeric sub-fields (used as rollup source)
const positionsWithNumbers = {
  key: 'positions',
  type: 'collection',
  title: 'Позиции',
  required: false,
  subFields: [
    { key: 'name', type: 'string', label: 'Товар', required: false },
    { key: 'qty', type: 'integer', label: 'Кол-во', required: false },
    { key: 'price', type: 'number', label: 'Цена', required: false },
  ],
};

// A valid computed field referencing the positionsWithNumbers fixture
const validComputedSum = {
  key: 'total',
  type: 'computed',
  title: 'Итого',
  required: false,
  rollupSource: 'positions',
  rollupOp: 'sum',
  rollupValueField: 'price',
  rollupFactorField: '',
};

describe('apps-schema T-0452 · computed field type — constants', () => {
  it('FIELD_TYPES includes computed with label "Итог"', () => {
    const entry = FIELD_TYPES.find((t) => t.value === 'computed');
    expect(entry).toBeDefined();
    expect(entry.label).toBe('Итог');
  });

  it('FIELD_TYPE_VALUES includes "computed"', () => {
    expect(FIELD_TYPE_VALUES).toContain('computed');
  });

  it('ROLLUP_OPS has all expected operations', () => {
    expect(ROLLUP_OP_VALUES).toEqual(['sum', 'count', 'avg', 'min', 'max']);
    for (const op of ROLLUP_OPS) {
      expect(op.label).toBeTruthy();
    }
  });
});

describe('apps-schema T-0452 · computed field type — buildRecordSchema', () => {
  it('emits {type:"number","x-rollup":{source,op,value_field}} for a sum field', () => {
    const schema = buildRecordSchema([positionsWithNumbers, validComputedSum]);
    const prop = schema.properties.total;
    expect(prop.type).toBe('number');
    expect(prop['x-rollup']).toEqual({ source: 'positions', op: 'sum', value_field: 'price' });
    expect(prop.title).toBe('Итого');
    // factor_field absent when rollupFactorField is empty
    expect('factor_field' in prop['x-rollup']).toBe(false);
  });

  it('emits factor_field in x-rollup when rollupFactorField is non-empty', () => {
    const withFactor = { ...validComputedSum, rollupFactorField: 'qty' };
    const schema = buildRecordSchema([positionsWithNumbers, withFactor]);
    const xr = schema.properties.total['x-rollup'];
    expect(xr.factor_field).toBe('qty');
  });

  it('count op emits x-rollup with empty value_field', () => {
    const countField = { ...validComputedSum, rollupOp: 'count', rollupValueField: '' };
    const schema = buildRecordSchema([positionsWithNumbers, countField]);
    const xr = schema.properties.total['x-rollup'];
    expect(xr.op).toBe('count');
    expect(xr.value_field).toBe(''); // empty but present in the shape
  });

  it('computed field is NEVER added to schema.required even when required:true is passed (build-layer guard)', () => {
    // T-0452 MEDIUM fix: a computed field with required:true must NOT appear in
    // schema.required — the value is never written to record.data (T-0453), so AJV
    // would reject every record save with "required" error if the key were listed.
    // buildRecordSchema skips computed fields when populating schema.required.
    const requiredComputed = { ...validComputedSum, required: true };
    const schema = buildRecordSchema([positionsWithNumbers, requiredComputed]);
    // The computed key must NOT be in schema.required
    expect(schema.required).toBeUndefined(); // only 'positions' is a candidate; it's required:false
    // Verify with a scalar required field present: only the scalar ends up in required
    const withScalar = buildRecordSchema([
      { key: 'name', type: 'string', required: true },
      positionsWithNumbers,
      requiredComputed,
    ]);
    expect(withScalar.required).toEqual(['name']); // computed key 'total' is NOT present
    expect(withScalar.required).not.toContain('total');
    // The schema still compiles through validateRecordSchemaDefinition (x-* stripped)
    const result = validateRecordSchemaDefinition(withScalar);
    expect(result.valid).toBe(true);
  });

  it('x-rollup schema does NOT compile with raw AJV strict (strip required)', () => {
    const schema = buildRecordSchema([positionsWithNumbers, validComputedSum]);
    // Proves the validator must strip x-* before AJV compile (same as x-relation)
    expect(backendAccepts(schema)).toBe(false);
  });

  it('validateRecordSchemaDefinition accepts the emitted schema (x-* strip works)', () => {
    const schema = buildRecordSchema([positionsWithNumbers, validComputedSum]);
    const result = validateRecordSchemaDefinition(schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('computed alongside collection + scalar — all AJV-valid after strip', () => {
    const fields = [
      { key: 'name', type: 'string', required: true },
      positionsWithNumbers,
      validComputedSum,
    ];
    const schema = buildRecordSchema(fields);
    const result = validateRecordSchemaDefinition(schema);
    expect(result.valid).toBe(true);
    expect(Object.keys(schema.properties)).toEqual(['name', 'positions', 'total']);
  });
});

describe('apps-schema T-0452 · computed field type — parseRecordSchema (round-trip)', () => {
  it('round-trips a computed field (buildRecordSchema → parseRecordSchema ≈ original)', () => {
    const schema = buildRecordSchema([positionsWithNumbers, validComputedSum]);
    const parsed = parseRecordSchema(schema);
    const f = parsed.find((x) => x.key === 'total');
    expect(f).toBeDefined();
    expect(f.type).toBe('computed');
    expect(f.title).toBe('Итого');
    expect(f.required).toBe(false);
    expect(f.rollupSource).toBe('positions');
    expect(f.rollupOp).toBe('sum');
    expect(f.rollupValueField).toBe('price');
    expect(f.rollupFactorField).toBe('');
  });

  it('round-trips a computed field with factor_field', () => {
    const withFactor = { ...validComputedSum, rollupFactorField: 'qty' };
    const schema = buildRecordSchema([positionsWithNumbers, withFactor]);
    const parsed = parseRecordSchema(schema);
    const f = parsed.find((x) => x.key === 'total');
    expect(f.rollupFactorField).toBe('qty');
  });

  it('round-trips a count op computed field (no value_field)', () => {
    const countField = { ...validComputedSum, rollupOp: 'count', rollupValueField: '' };
    const schema = buildRecordSchema([positionsWithNumbers, countField]);
    const parsed = parseRecordSchema(schema);
    const f = parsed.find((x) => x.key === 'total');
    expect(f.rollupOp).toBe('count');
    expect(f.rollupValueField).toBe('');
    expect(f.rollupFactorField).toBe('');
  });

  it('computed does not interfere with adjacent scalar/collection field parsing', () => {
    const schema = buildRecordSchema([
      { key: 'name', type: 'string', title: 'Имя', required: true },
      positionsWithNumbers,
      validComputedSum,
    ]);
    const parsed = parseRecordSchema(schema);
    expect(parsed[0]).toMatchObject({ key: 'name', type: 'string', required: true });
    expect(parsed[1]).toMatchObject({ key: 'positions', type: 'collection' });
    expect(parsed[2]).toMatchObject({ key: 'total', type: 'computed' });
  });

  it('detects persisted x-rollup directly from a raw schema object', () => {
    const raw = {
      type: 'object',
      additionalProperties: false,
      properties: {
        total: {
          type: 'number',
          title: 'Итого',
          'x-rollup': { source: 'items', op: 'avg', value_field: 'score' },
        },
      },
    };
    const parsed = parseRecordSchema(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      key: 'total',
      type: 'computed',
      title: 'Итого',
      required: false,
      rollupSource: 'items',
      rollupOp: 'avg',
      rollupValueField: 'score',
      rollupFactorField: '',
    });
  });
});

describe('apps-schema T-0452 · computed field type — validateField', () => {
  // Helper — builds field list [positionsWithNumbers, computed_field]
  const withContext = (computedPatch) => ({
    field: { key: 'total', type: 'computed', ...computedPatch },
    allFields: [positionsWithNumbers, { key: 'total', type: 'computed', ...computedPatch }],
  });

  it('accepts a valid computed field (sum with numeric value_field)', () => {
    const { field, allFields } = withContext({
      rollupSource: 'positions', rollupOp: 'sum', rollupValueField: 'price', rollupFactorField: '',
    });
    const err = validateField(field, allFields);
    expect(err.rollupSource).toBeUndefined();
    expect(err.rollupOp).toBeUndefined();
    expect(err.rollupValueField).toBeUndefined();
    expect(err.rollupFactorField).toBeUndefined();
  });

  it('accepts count op without value_field', () => {
    const { field, allFields } = withContext({
      rollupSource: 'positions', rollupOp: 'count', rollupValueField: '', rollupFactorField: '',
    });
    const err = validateField(field, allFields);
    expect(err.rollupSource).toBeUndefined();
    expect(err.rollupOp).toBeUndefined();
    expect(err.rollupValueField).toBeUndefined();
  });

  it('accepts valid factor_field (numeric sub-field of source)', () => {
    const { field, allFields } = withContext({
      rollupSource: 'positions', rollupOp: 'sum', rollupValueField: 'price', rollupFactorField: 'qty',
    });
    const err = validateField(field, allFields);
    expect(err.rollupFactorField).toBeUndefined();
  });

  it('rejects missing rollupSource', () => {
    const { field, allFields } = withContext({
      rollupSource: '', rollupOp: 'sum', rollupValueField: 'price', rollupFactorField: '',
    });
    const err = validateField(field, allFields);
    expect(err.rollupSource).toBeTruthy();
  });

  it('rejects rollupSource that does not reference a collection field', () => {
    const { field, allFields } = withContext({
      rollupSource: 'nonexistent', rollupOp: 'sum', rollupValueField: 'price', rollupFactorField: '',
    });
    const err = validateField(field, allFields);
    expect(err.rollupSource).toBeTruthy();
  });

  it('rejects rollupSource that matches a non-collection sibling key', () => {
    // Add a sibling 'name' field of type 'string' — should NOT be a valid source
    const f = { key: 'total', type: 'computed', rollupSource: 'name', rollupOp: 'sum', rollupValueField: 'price', rollupFactorField: '' };
    const siblings = [
      { key: 'name', type: 'string' },
      f,
    ];
    const err = validateField(f, siblings);
    expect(err.rollupSource).toBeTruthy();
  });

  it('rejects missing op (empty string)', () => {
    const { field, allFields } = withContext({
      rollupSource: 'positions', rollupOp: '', rollupValueField: 'price', rollupFactorField: '',
    });
    const err = validateField(field, allFields);
    expect(err.rollupOp).toBeTruthy();
  });

  it('rejects unknown op value', () => {
    const { field, allFields } = withContext({
      rollupSource: 'positions', rollupOp: 'median', rollupValueField: 'price', rollupFactorField: '',
    });
    const err = validateField(field, allFields);
    expect(err.rollupOp).toBeTruthy();
  });

  it('rejects missing value_field for sum op', () => {
    const { field, allFields } = withContext({
      rollupSource: 'positions', rollupOp: 'sum', rollupValueField: '', rollupFactorField: '',
    });
    const err = validateField(field, allFields);
    expect(err.rollupValueField).toBeTruthy();
  });

  it('rejects missing value_field for avg op', () => {
    const { field, allFields } = withContext({
      rollupSource: 'positions', rollupOp: 'avg', rollupValueField: '', rollupFactorField: '',
    });
    const err = validateField(field, allFields);
    expect(err.rollupValueField).toBeTruthy();
  });

  it('rejects value_field that references a non-numeric sub-field (string type)', () => {
    const { field, allFields } = withContext({
      rollupSource: 'positions', rollupOp: 'sum', rollupValueField: 'name', rollupFactorField: '',
    });
    const err = validateField(field, allFields);
    expect(err.rollupValueField).toBeTruthy(); // 'name' is type:string, not numeric
  });

  it('rejects value_field that does not exist in source sub-fields', () => {
    const { field, allFields } = withContext({
      rollupSource: 'positions', rollupOp: 'sum', rollupValueField: 'nonexistent', rollupFactorField: '',
    });
    const err = validateField(field, allFields);
    expect(err.rollupValueField).toBeTruthy();
  });

  it('rejects factor_field that references a non-numeric sub-field', () => {
    const { field, allFields } = withContext({
      rollupSource: 'positions', rollupOp: 'sum', rollupValueField: 'price', rollupFactorField: 'name',
    });
    const err = validateField(field, allFields);
    expect(err.rollupFactorField).toBeTruthy(); // 'name' is type:string
  });

  it('rejects factor_field that does not exist in source sub-fields', () => {
    const { field, allFields } = withContext({
      rollupSource: 'positions', rollupOp: 'sum', rollupValueField: 'price', rollupFactorField: 'ghost',
    });
    const err = validateField(field, allFields);
    expect(err.rollupFactorField).toBeTruthy();
  });

  it('accepts integer sub-field as a valid value_field (numeric)', () => {
    // qty is type:integer — should be accepted as value_field
    const { field, allFields } = withContext({
      rollupSource: 'positions', rollupOp: 'sum', rollupValueField: 'qty', rollupFactorField: '',
    });
    const err = validateField(field, allFields);
    expect(err.rollupValueField).toBeUndefined();
  });

  it('accepts integer sub-field as a valid factor_field', () => {
    const { field, allFields } = withContext({
      rollupSource: 'positions', rollupOp: 'sum', rollupValueField: 'price', rollupFactorField: 'qty',
    });
    const err = validateField(field, allFields);
    expect(err.rollupFactorField).toBeUndefined();
  });
});

describe('apps-schema T-0452 · computed field type — validateFields integration', () => {
  it('validateFields accepts a valid [collection, computed] pair', () => {
    const r = validateFields([positionsWithNumbers, validComputedSum]);
    expect(r.valid).toBe(true);
    expect(r.formError).toBeNull();
  });

  it('validateFields rejects computed with no source (no collection in list)', () => {
    // Only the computed field, no collection sibling
    const r = validateFields([validComputedSum]);
    expect(r.valid).toBe(false);
    expect(r.fieldErrors[0].rollupSource).toBeTruthy();
  });

  it('validateFields rejects computed with invalid op', () => {
    const bad = { ...validComputedSum, rollupOp: 'bad-op' };
    const r = validateFields([positionsWithNumbers, bad]);
    expect(r.valid).toBe(false);
    expect(r.fieldErrors[1].rollupOp).toBeTruthy();
  });
});

describe('apps-schema T-0452 · computed field type — blankField defaults', () => {
  it('blankField includes rollup defaults', () => {
    const b = blankField();
    expect(b.rollupSource).toBe('');
    expect(b.rollupOp).toBe('sum');
    expect(b.rollupValueField).toBe('');
    expect(b.rollupFactorField).toBe('');
  });
});

// ---------------------------------------------------------------------------
// T-0509: money field type
// ---------------------------------------------------------------------------

describe('apps-schema T-0509 · money field type — FIELD_TYPES', () => {
  it('FIELD_TYPES includes a money entry with label "Сумма (₽)"', () => {
    const money = FIELD_TYPES.find((t) => t.value === 'money');
    expect(money).toBeDefined();
    expect(money.label).toBe('Сумма (₽)');
  });

  it('FIELD_TYPE_VALUES includes "money"', () => {
    expect(FIELD_TYPE_VALUES).toContain('money');
  });
});

describe('apps-schema T-0509 · buildRecordSchema — money field', () => {
  const schema = buildRecordSchema([
    { key: 'price', type: 'money', title: 'Стоимость', required: true },
  ]);

  it('emits type:"number" with x-money annotation', () => {
    expect(schema.properties.price).toMatchObject({
      type: 'number',
      'x-money': { currency: 'RUB' },
      title: 'Стоимость',
    });
  });

  it('x-money annotation does NOT block AJV compile (stripped by real validator)', () => {
    // The real validator (validateRecordSchemaDefinition) strips x-* before AJV
    // strict compile. A plain {type:"number"} is always AJV-valid.
    const stripped = {
      type: 'object',
      additionalProperties: false,
      properties: { price: { type: 'number', title: 'Стоимость' } },
      required: ['price'],
    };
    expect(backendAccepts(stripped)).toBe(true);
  });

  it('buildRecordSchema output passes validateRecordSchemaDefinition (x-* stripped internally)', () => {
    // The real validator in the server codebase strips x-* before compile.
    const result = validateRecordSchemaDefinition(schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('money is required when f.required=true', () => {
    expect(schema.required).toContain('price');
  });

  it('optional money is NOT in required array', () => {
    const s = buildRecordSchema([{ key: 'budget', type: 'money', required: false }]);
    expect(s.required == null || !s.required.includes('budget')).toBe(true);
  });
});

describe('apps-schema T-0509 · parseRecordSchema — money field round-trip', () => {
  const moneySchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', title: 'Название' },
      price: { type: 'number', title: 'Стоимость', 'x-money': { currency: 'RUB' } },
    },
    required: ['price'],
  };

  it('detects money from x-money, returns type "money"', () => {
    const fields = parseRecordSchema(moneySchema);
    const priceField = fields.find((f) => f.key === 'price');
    expect(priceField).toBeDefined();
    expect(priceField).toMatchObject({
      key: 'price',
      type: 'money',
      title: 'Стоимость',
      required: true,
    });
  });

  it('non-money number field remains type "number" (no x-money → no misdetection)', () => {
    const plainNumberSchema = {
      type: 'object',
      properties: { score: { type: 'number', title: 'Рейтинг' } },
    };
    const fields = parseRecordSchema(plainNumberSchema);
    expect(fields[0]).toMatchObject({ key: 'score', type: 'number' });
  });

  it('buildRecordSchema → parseRecordSchema round-trip preserves type "money"', () => {
    const built = buildRecordSchema([
      { key: 'amount', type: 'money', title: 'Сумма', required: true },
    ]);
    const parsed = parseRecordSchema(built);
    const f = parsed.find((p) => p.key === 'amount');
    expect(f).toMatchObject({ key: 'amount', type: 'money', title: 'Сумма', required: true });
  });
});
