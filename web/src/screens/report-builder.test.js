/**
 * web/src/screens/report-builder.test.js  (T-0492)
 *
 * Tests the PURE builder module: the page_def it emits MUST match exactly what
 * the server renderer parses (src/http/report-page-render.ts → parseMetrics).
 *
 * Contract being pinned (parseMetrics, cited in module header):
 *   page_def = Array<{ source_registry_def_id, field_key, agg, group_by?, title? }>
 *   - array of plain objects
 *   - source_registry_def_id: string (uuid)
 *   - field_key: string matching /^[a-zA-Z0-9_-]+$/ (server charset guard)
 *   - agg ∈ count|sum|avg|min|max|list
 *   - group_by (optional): string in the same charset
 *
 * If buildPageDef ever drifts from this shape, the live /render call would 400 —
 * these tests are the canary.
 */

import { describe, it, expect } from 'vitest';
import {
  AGG_LABELS,
  BUILDER_AGGS,
  FIELD_KEY_SAFE_RE,
  extractSchemaFields,
  slugFromTitle,
  validateBuilder,
  buildPageDef,
  defaultMetricTitle,
  buildCreateBody,
  buildPatchBody,
  blankMetric,
} from './report-builder.js';

// A representative record_schema (mirrors apps-schema.buildRecordSchema output).
const SCHEMA = {
  type: 'object',
  properties: {
    amount: { type: 'number', title: 'Сумма' },
    qty: { type: 'integer', title: 'Количество' },
    status: { type: 'string', enum: ['new', 'done'], title: 'Статус' },
    note: { type: 'string' }, // no title → label falls back to key
    items: { type: 'array', items: { type: 'object' } }, // collection → skipped
    total: { type: 'number', 'x-rollup': { source: 'items', op: 'sum' } }, // computed → skipped
  },
};

const REG_ID = 'b7c2a1d3-e4f5-6789-abcd-ef0123456789';

// ---------------------------------------------------------------------------
// extractSchemaFields
// ---------------------------------------------------------------------------

describe('extractSchemaFields', () => {
  it('returns scalar fields with human labels', () => {
    const fields = extractSchemaFields(SCHEMA);
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
    expect(byKey.amount).toEqual({ key: 'amount', label: 'Сумма', type: 'number', numeric: true });
    expect(byKey.qty).toEqual({ key: 'qty', label: 'Количество', type: 'integer', numeric: true });
    expect(byKey.status).toEqual({ key: 'status', label: 'Статус', type: 'string', numeric: false });
  });

  it('falls back to key as label when title missing', () => {
    const fields = extractSchemaFields(SCHEMA);
    const note = fields.find((f) => f.key === 'note');
    expect(note.label).toBe('note');
  });

  it('skips collection (array) fields — no scalar to aggregate', () => {
    const fields = extractSchemaFields(SCHEMA);
    expect(fields.find((f) => f.key === 'items')).toBeUndefined();
  });

  it('skips x-rollup computed fields — never stored in record.data', () => {
    const fields = extractSchemaFields(SCHEMA);
    expect(fields.find((f) => f.key === 'total')).toBeUndefined();
  });

  it('drops keys that violate the server charset guard', () => {
    const bad = { type: 'object', properties: { 'has space': { type: 'string' }, ok_key: { type: 'string' } } };
    const fields = extractSchemaFields(bad);
    expect(fields.map((f) => f.key)).toEqual(['ok_key']);
  });

  it('honest empty: null / no-properties schema → []', () => {
    expect(extractSchemaFields(null)).toEqual([]);
    expect(extractSchemaFields({})).toEqual([]);
    expect(extractSchemaFields({ properties: null })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildPageDef — THE contract emitter
// ---------------------------------------------------------------------------

describe('buildPageDef — emits the exact parseMetrics contract', () => {
  it('numeric metric → { source_registry_def_id, field_key, agg, title }', () => {
    const pageDef = buildPageDef({
      registryDefId: REG_ID,
      metrics: [{ agg: 'sum', fieldKey: 'amount', title: 'Итого' }],
    });
    expect(pageDef).toEqual([
      { source_registry_def_id: REG_ID, field_key: 'amount', agg: 'sum', title: 'Итого' },
    ]);
  });

  it('every emitted metric is a plain object (parseMetrics rejects non-objects)', () => {
    const pageDef = buildPageDef({ registryDefId: REG_ID, metrics: [blankMetric()], countFallbackKey: 'amount' });
    for (const m of pageDef) {
      expect(m).not.toBeNull();
      expect(typeof m).toBe('object');
      expect(Array.isArray(m)).toBe(false);
    }
  });

  it('source_registry_def_id is the chosen registry_def for all metrics', () => {
    const pageDef = buildPageDef({
      registryDefId: REG_ID,
      metrics: [
        { agg: 'sum', fieldKey: 'amount' },
        { agg: 'avg', fieldKey: 'qty' },
      ],
    });
    for (const m of pageDef) expect(m.source_registry_def_id).toBe(REG_ID);
  });

  it('agg is one of the Floor-1 verbs parseMetrics accepts', () => {
    const valid = ['count', 'sum', 'avg', 'min', 'max', 'list'];
    const pageDef = buildPageDef({
      registryDefId: REG_ID,
      countFallbackKey: 'amount',
      metrics: BUILDER_AGGS.map((agg) => ({ agg, fieldKey: 'amount' })),
    });
    for (const m of pageDef) expect(valid).toContain(m.agg);
  });

  it('every field_key passes the server charset guard /^[a-zA-Z0-9_-]+$/', () => {
    const pageDef = buildPageDef({
      registryDefId: REG_ID,
      countFallbackKey: 'amount',
      metrics: [{ agg: 'count' }, { agg: 'sum', fieldKey: 'amount' }],
    });
    for (const m of pageDef) {
      expect(typeof m.field_key).toBe('string');
      expect(FIELD_KEY_SAFE_RE.test(m.field_key)).toBe(true);
    }
  });

  it('count metric with no field uses the countFallbackKey (a real schema key)', () => {
    const pageDef = buildPageDef({
      registryDefId: REG_ID,
      countFallbackKey: 'status',
      metrics: [{ agg: 'count', fieldKey: '' }],
    });
    expect(pageDef).toHaveLength(1);
    expect(pageDef[0].agg).toBe('count');
    expect(pageDef[0].field_key).toBe('status');
  });

  it('count metric prefers an explicitly chosen field over the fallback', () => {
    const pageDef = buildPageDef({
      registryDefId: REG_ID,
      countFallbackKey: 'status',
      metrics: [{ agg: 'count', fieldKey: 'amount' }],
    });
    expect(pageDef[0].field_key).toBe('amount');
  });

  it('group_by is attached to EVERY metric when grouping is chosen', () => {
    const pageDef = buildPageDef({
      registryDefId: REG_ID,
      groupBy: 'status',
      countFallbackKey: 'status',
      metrics: [
        { agg: 'count' },
        { agg: 'sum', fieldKey: 'amount' },
      ],
    });
    expect(pageDef).toHaveLength(2);
    for (const m of pageDef) expect(m.group_by).toBe('status');
  });

  it('no group_by key emitted when grouping is empty (parseMetrics treats absent as scalar)', () => {
    const pageDef = buildPageDef({
      registryDefId: REG_ID,
      groupBy: '',
      metrics: [{ agg: 'sum', fieldKey: 'amount' }],
    });
    expect('group_by' in pageDef[0]).toBe(false);
  });

  it('drops metrics with an unknown agg (defends the contract)', () => {
    const pageDef = buildPageDef({
      registryDefId: REG_ID,
      metrics: [{ agg: 'median', fieldKey: 'amount' }, { agg: 'sum', fieldKey: 'amount' }],
    });
    expect(pageDef).toHaveLength(1);
    expect(pageDef[0].agg).toBe('sum');
  });

  it('drops a numeric metric with no field_key and no fallback (can never render)', () => {
    const pageDef = buildPageDef({
      registryDefId: REG_ID,
      metrics: [{ agg: 'sum', fieldKey: '' }],
    });
    expect(pageDef).toEqual([]);
  });

  it('auto-titles metrics when no title supplied (no raw jargon to the user)', () => {
    const pageDef = buildPageDef({
      registryDefId: REG_ID,
      metrics: [{ agg: 'sum', fieldKey: 'amount' }],
    });
    expect(pageDef[0].title).toBe('Сумма: amount');
  });
});

// ---------------------------------------------------------------------------
// defaultMetricTitle
// ---------------------------------------------------------------------------

describe('defaultMetricTitle', () => {
  it('count without grouping → just the agg label', () => {
    expect(defaultMetricTitle('count', 'x', '')).toBe('Количество');
  });
  it('count with grouping → «… по «group»»', () => {
    expect(defaultMetricTitle('count', 'x', 'status')).toBe('Количество по «status»');
  });
  it('numeric agg → «Label: field»', () => {
    expect(defaultMetricTitle('sum', 'amount', '')).toBe('Сумма: amount');
  });
  it('numeric agg with grouping appends the group', () => {
    expect(defaultMetricTitle('avg', 'qty', 'status')).toBe('Среднее: qty по «status»');
  });
});

// ---------------------------------------------------------------------------
// validateBuilder
// ---------------------------------------------------------------------------

describe('validateBuilder', () => {
  const ok = {
    title: 'Закупки по статусу',
    registryDefId: REG_ID,
    groupBy: 'status',
    metrics: [{ agg: 'count', fieldKey: '' }, { agg: 'sum', fieldKey: 'amount' }],
  };

  it('valid state passes', () => {
    const r = validateBuilder(ok);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual({});
    expect(r.metricErrors).toEqual({});
  });

  it('missing title is an error', () => {
    const r = validateBuilder({ ...ok, title: '   ' });
    expect(r.valid).toBe(false);
    expect(r.errors.title).toBeTruthy();
  });

  it('missing registry_def is an error', () => {
    const r = validateBuilder({ ...ok, registryDefId: '' });
    expect(r.valid).toBe(false);
    expect(r.errors.registryDefId).toBeTruthy();
  });

  it('zero metrics is an error', () => {
    const r = validateBuilder({ ...ok, metrics: [] });
    expect(r.valid).toBe(false);
    expect(r.errors.metrics).toBeTruthy();
  });

  it('numeric agg without a field is a per-metric error', () => {
    const r = validateBuilder({ ...ok, metrics: [{ agg: 'sum', fieldKey: '' }] });
    expect(r.valid).toBe(false);
    expect(r.metricErrors[0]).toBeTruthy();
  });

  it('count without a field is allowed when countFallbackKey provides a schema key', () => {
    const r = validateBuilder({ ...ok, metrics: [{ agg: 'count', fieldKey: '' }], countFallbackKey: 'amount' });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual({});
    expect(r.metricErrors).toEqual({});
  });

  it('unknown agg is a per-metric error', () => {
    const r = validateBuilder({ ...ok, metrics: [{ agg: 'median', fieldKey: 'amount' }] });
    expect(r.valid).toBe(false);
    expect(r.metricErrors[0]).toBeTruthy();
  });

  // B2: empty page_def = validation error, buttons stay disabled.
  it('B2: count-only metrics with no countFallbackKey → empty page_def → validation error', () => {
    // Dataset has no scalar fields: countFallbackKey is empty string.
    const r = validateBuilder({
      title: 'Тест',
      registryDefId: REG_ID,
      metrics: [{ agg: 'count', fieldKey: '' }],
      countFallbackKey: '',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.metrics).toMatch(/нет полей|Добавьте/i);
  });

  it('B2: all metrics result in empty page_def → validation error with field hint', () => {
    // count with no fallback and no explicit field → buildPageDef returns []
    const r = validateBuilder({
      title: 'Тест',
      registryDefId: REG_ID,
      groupBy: '',
      metrics: [{ agg: 'count', fieldKey: '' }],
      countFallbackKey: '',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.metrics).toBeTruthy();
  });

  it('B2: count metrics WITH countFallbackKey → non-empty page_def → valid', () => {
    const r = validateBuilder({
      title: 'Тест',
      registryDefId: REG_ID,
      metrics: [{ agg: 'count', fieldKey: '' }],
      countFallbackKey: 'status',
    });
    expect(r.valid).toBe(true);
  });

  it('B2: empty page_def message differs when no fields in dataset vs missing field choice', () => {
    const noFields = validateBuilder({
      title: 'Тест',
      registryDefId: REG_ID,
      metrics: [{ agg: 'count', fieldKey: '' }],
      countFallbackKey: '',
    });
    expect(noFields.errors.metrics).toContain('нет полей');
  });
});

// ---------------------------------------------------------------------------
// slugFromTitle
// ---------------------------------------------------------------------------

describe('slugFromTitle', () => {
  it('transliterates Cyrillic', () => {
    expect(slugFromTitle('Закупки по статусу')).toBe('zakupki-po-statusu');
  });
  it('collapses non-alnum to single hyphens', () => {
    expect(slugFromTitle('My  Report!! 2026')).toBe('my-report-2026');
  });
  it('empty title falls back to «report»', () => {
    expect(slugFromTitle('')).toBe('report');
    expect(slugFromTitle('!!!')).toBe('report');
  });
  it('result always matches a slug charset', () => {
    expect(/^[a-z0-9-]+$/.test(slugFromTitle('Отчёт №7 — итоги'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildCreateBody / buildPatchBody — full request bodies
// ---------------------------------------------------------------------------

describe('buildCreateBody', () => {
  const state = {
    appId: 'a0000000-0000-0000-0000-000000000001',
    title: 'Закупки',
    registryDefId: REG_ID,
    groupBy: 'status',
    metrics: [{ agg: 'sum', fieldKey: 'amount' }],
    countFallbackKey: 'amount',
  };

  it('emits floor=1 with the page_def array', () => {
    const body = buildCreateBody(state);
    expect(body.floor).toBe('1');
    expect(body.app_id).toBe(state.appId);
    expect(body.title).toBe('Закупки');
    expect(Array.isArray(body.page_def)).toBe(true);
    expect(body.page_def[0]).toMatchObject({
      source_registry_def_id: REG_ID,
      field_key: 'amount',
      agg: 'sum',
      group_by: 'status',
    });
  });

  it('derives a non-empty slug from the title when none provided', () => {
    const body = buildCreateBody(state);
    expect(body.slug.startsWith('zakupki-')).toBe(true);
    expect(body.slug.length).toBeGreaterThan('zakupki-'.length);
  });

  it('uses an explicit slug when given', () => {
    const body = buildCreateBody({ ...state, slug: 'custom-slug' });
    expect(body.slug).toBe('custom-slug');
  });
});

describe('buildPatchBody', () => {
  it('emits only title + page_def (the editable parts of a draft)', () => {
    const body = buildPatchBody({
      title: 'Обновлённый',
      registryDefId: REG_ID,
      metrics: [{ agg: 'avg', fieldKey: 'qty' }],
    });
    expect(Object.keys(body).sort()).toEqual(['page_def', 'title']);
    expect(body.title).toBe('Обновлённый');
    expect(body.page_def[0]).toMatchObject({ field_key: 'qty', agg: 'avg' });
  });
});

// ---------------------------------------------------------------------------
// AGG_LABELS — human labels for all six Floor-1 aggregators
// ---------------------------------------------------------------------------

describe('AGG_LABELS', () => {
  it('covers all six Floor-1 aggregators', () => {
    for (const agg of ['count', 'sum', 'avg', 'min', 'max', 'list']) {
      expect(AGG_LABELS[agg]).toBeTruthy();
    }
  });
  it('builder offers count/sum/avg/min/max (not raw list)', () => {
    expect(BUILDER_AGGS).toEqual(['count', 'sum', 'avg', 'min', 'max']);
  });
});
