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
