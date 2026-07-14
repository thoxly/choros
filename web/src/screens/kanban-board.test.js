/**
 * web/src/screens/kanban-board.test.js — T-0582 (kanban view) pure-logic tests.
 *
 * Covers (spec ACs):
 *   AC-3 — buildKanbanColumns: one column per enum value (columns_order or
 *          enum order) + a MANDATORY trailing "без значения" pseudo-column,
 *          empty/null/out-of-enum values never dropped.
 *   AC-5/AC-7 — buildMovePayload: FULL current data with ONLY groupByField
 *          changed (never a partial patch).
 *   AC-8 — buildMovePayload to "без значения" (newValue=null): clears the
 *          field when not required; honest rejection (no PUT sent) when required.
 *   AC-9 — an enum value with zero matching records still produces a column
 *          (buildKanbanColumns never omits a column for lack of cards).
 *   FR-2/FR-9 — kanbanConfigFromDraft/draftFromKanbanConfig round-trip.
 */

import { describe, it, expect } from 'vitest';
import {
  buildKanbanColumns, buildMovePayload, isFieldRequired, readSelectEnum,
  draftFromKanbanConfig, kanbanConfigFromDraft, availableGroupByFields,
  NO_VALUE_COLUMN,
} from './kanban-board.js';

const ENUM_VALUES = ['open', 'won', 'lost'];

function rec(id, groupVal, extra = {}) {
  return { id, data: { status: groupVal, ...extra } };
}

describe('AC-3/AC-9: buildKanbanColumns', () => {
  it('groups records into one column per enum value (enum order by default) + trailing "без значения"', () => {
    const records = [rec('r1', 'open'), rec('r2', 'won'), rec('r3', 'open')];
    const columns = buildKanbanColumns(records, 'status', ENUM_VALUES, undefined);
    expect(columns.map((c) => c.value)).toEqual(['open', 'won', 'lost', NO_VALUE_COLUMN]);
    expect(columns[0].cards.map((r) => r.id)).toEqual(['r1', 'r3']);
    expect(columns[1].cards.map((r) => r.id)).toEqual(['r2']);
  });

  it('an enum value with ZERO matching records still produces its own column (AC-9)', () => {
    const records = [rec('r1', 'open')];
    const columns = buildKanbanColumns(records, 'status', ENUM_VALUES, undefined);
    const lost = columns.find((c) => c.value === 'lost');
    expect(lost).toBeDefined();
    expect(lost.cards).toEqual([]);
  });

  it('records with null/undefined/empty group_by value land in "без значения" (never dropped, FR-3)', () => {
    const records = [
      rec('r1', null),
      { id: 'r2', data: {} }, // absent key entirely
      rec('r3', ''),
    ];
    const columns = buildKanbanColumns(records, 'status', ENUM_VALUES, undefined);
    const noValue = columns.find((c) => c.value === NO_VALUE_COLUMN);
    expect(noValue.cards.map((r) => r.id).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('a record whose value fell OUTSIDE the current enum lands in "без значения" (stale value, never vanishes)', () => {
    const records = [rec('r1', 'archived_stage_no_longer_in_enum')];
    const columns = buildKanbanColumns(records, 'status', ENUM_VALUES, undefined);
    const noValue = columns.find((c) => c.value === NO_VALUE_COLUMN);
    expect(noValue.cards.map((r) => r.id)).toEqual(['r1']);
  });

  it('"без значения" pseudo-column is ALWAYS present even with zero unmatched records', () => {
    const records = [rec('r1', 'open')];
    const columns = buildKanbanColumns(records, 'status', ENUM_VALUES, undefined);
    const noValue = columns.find((c) => c.value === NO_VALUE_COLUMN);
    expect(noValue).toBeDefined();
    expect(noValue.label).toBe('Без значения');
    expect(noValue.cards).toEqual([]);
  });

  it('respects columns_order — reorders matching enum values, appends unmentioned enum values in enum order', () => {
    const records = [rec('r1', 'open'), rec('r2', 'won'), rec('r3', 'lost')];
    const columns = buildKanbanColumns(records, 'status', ENUM_VALUES, ['won', 'lost']);
    // 'won','lost' given explicitly; 'open' (not mentioned) appended in enum order; "без значения" always last.
    expect(columns.map((c) => c.value)).toEqual(['won', 'lost', 'open', NO_VALUE_COLUMN]);
  });

  it('columns_order entries NOT in the current enum are ignored (stale saved order, schema changed since)', () => {
    const records = [rec('r1', 'open')];
    const columns = buildKanbanColumns(records, 'status', ENUM_VALUES, ['ghost_value', 'open', 'won']);
    expect(columns.map((c) => c.value)).toEqual(['open', 'won', 'lost', NO_VALUE_COLUMN]);
  });

  it('handles an empty records array (0 records, not an error) — every column still renders', () => {
    const columns = buildKanbanColumns([], 'status', ENUM_VALUES, undefined);
    expect(columns.map((c) => c.value)).toEqual(['open', 'won', 'lost', NO_VALUE_COLUMN]);
    expect(columns.every((c) => c.cards.length === 0)).toBe(true);
  });

  it('handles a malformed record.data (non-object) defensively — treated as no value', () => {
    const records = [{ id: 'r1', data: null }, { id: 'r2' }];
    const columns = buildKanbanColumns(records, 'status', ENUM_VALUES, undefined);
    const noValue = columns.find((c) => c.value === NO_VALUE_COLUMN);
    expect(noValue.cards.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
  });
});

describe('AC-5/AC-7: buildMovePayload — FULL data, one field changed (never a partial patch)', () => {
  it('sends the full current data with only groupByField updated', () => {
    const record = rec('r1', 'open', { amount: 500, notes: 'hello' });
    const result = buildMovePayload(record, 'status', 'won', false);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ status: 'won', amount: 500, notes: 'hello' });
  });

  it('does not mutate the original record.data object', () => {
    const record = rec('r1', 'open', { amount: 500 });
    const originalData = record.data;
    buildMovePayload(record, 'status', 'won', false);
    expect(record.data).toBe(originalData);
    expect(record.data.status).toBe('open');
  });

  it('preserves sibling fields the board never touches', () => {
    const record = rec('r1', 'open', { amount: 500, tags: ['a', 'b'], nested: { x: 1 } });
    const result = buildMovePayload(record, 'status', 'lost', false);
    expect(result.data.amount).toBe(500);
    expect(result.data.tags).toEqual(['a', 'b']);
    expect(result.data.nested).toEqual({ x: 1 });
  });
});

describe('AC-8: buildMovePayload — "без значения" (newValue=null)', () => {
  it('clears the field when groupByField is NOT required', () => {
    const record = rec('r1', 'open', { amount: 500 });
    const result = buildMovePayload(record, 'status', null, false);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ amount: 500 });
    expect('status' in result.data).toBe(false);
  });

  it('rejects (honest error, no data returned) when groupByField IS required', () => {
    const record = rec('r1', 'open', { amount: 500 });
    const result = buildMovePayload(record, 'status', null, true);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.data).toBeUndefined();
  });
});

describe('isFieldRequired', () => {
  it('true when the field is in record_schema.required', () => {
    expect(isFieldRequired({ required: ['status', 'amount'] }, 'status')).toBe(true);
  });
  it('false when absent from required', () => {
    expect(isFieldRequired({ required: ['amount'] }, 'status')).toBe(false);
  });
  it('false for a malformed/absent required array', () => {
    expect(isFieldRequired({}, 'status')).toBe(false);
    expect(isFieldRequired(null, 'status')).toBe(false);
    expect(isFieldRequired({ required: 'status' }, 'status')).toBe(false);
  });
});

describe('readSelectEnum — reads record_schema.properties[key].enum (tenant data)', () => {
  const SCHEMA = { properties: { status: { type: 'string', enum: ['open', 'won'] }, amount: { type: 'number' } } };
  it('returns the enum array for a select field', () => {
    expect(readSelectEnum(SCHEMA, 'status')).toEqual(['open', 'won']);
  });
  it('returns [] for a non-select field', () => {
    expect(readSelectEnum(SCHEMA, 'amount')).toEqual([]);
  });
  it('never throws on malformed input', () => {
    expect(readSelectEnum(null, 'status')).toEqual([]);
    expect(readSelectEnum({}, 'status')).toEqual([]);
    expect(readSelectEnum(SCHEMA, 'ghost')).toEqual([]);
  });
});

describe('availableGroupByFields — only select-typed fields are eligible (FR-2)', () => {
  it('filters the catalog to type === "select"', () => {
    const catalog = [
      { key: 'status', label: 'Статус', type: 'select' },
      { key: 'amount', label: 'Сумма', type: 'money' },
      { key: 'stage2', label: 'Стадия 2', type: 'select' },
    ];
    expect(availableGroupByFields(catalog).map((f) => f.key)).toEqual(['status', 'stage2']);
  });
  it('handles a non-array input defensively', () => {
    expect(availableGroupByFields(null)).toEqual([]);
  });
});

describe('FR-2/FR-9: kanban draft <-> config round-trip', () => {
  const CATALOG = [
    { key: 'status', label: 'Статус', type: 'select' },
    { key: 'amount', label: 'Сумма', type: 'money' },
    { key: 'created_at', label: 'Создано', type: 'created_at' },
  ];

  it('draftFromKanbanConfig seeds from a saved KanbanViewConfig', () => {
    const config = {
      group_by_field: 'status',
      card_fields: ['amount', 'created_at'],
      columns_order: ['won', 'open'],
      filters: [{ field_key: 'amount', op: 'gte', value: 100 }],
      sort: [{ field_key: 'amount', dir: 'desc' }],
    };
    const draft = draftFromKanbanConfig(config, CATALOG);
    expect(draft.group_by_field).toBe('status');
    expect(draft.card_fields).toEqual(['amount', 'created_at']);
    expect(draft.columns_order).toEqual(['won', 'open']);
    expect(draft.filters).toHaveLength(1);
    expect(draft.filters[0].field_key).toBe('amount');
    expect(draft.sort).toHaveLength(1);
  });

  it('draftFromKanbanConfig(null, catalog) yields a blank/new-view draft', () => {
    const draft = draftFromKanbanConfig(null, CATALOG);
    expect(draft.group_by_field).toBe('');
    expect(draft.card_fields).toEqual([]);
    expect(draft.filters).toEqual([]);
    expect(draft.sort).toEqual([]);
  });

  it('drops a group_by_field/card_fields entry not in the catalog (stale schema reference)', () => {
    const draft = draftFromKanbanConfig({ group_by_field: 'ghost', card_fields: ['ghost2', 'amount'] }, CATALOG);
    expect(draft.group_by_field).toBe('');
    expect(draft.card_fields).toEqual(['amount']);
  });

  it('kanbanConfigFromDraft strips client-only ids and drops incomplete filter/sort rows', () => {
    const draft = {
      group_by_field: 'status',
      card_fields: ['amount'],
      columns_order: ['open'],
      filters: [{ id: 'kf0', field_key: 'amount', op: 'gte', value: 100 }, { id: 'kf1', field_key: '', op: '' }],
      sort: [{ id: 'ks0', field_key: 'amount', dir: 'desc' }],
    };
    const config = kanbanConfigFromDraft(draft);
    expect(config).toEqual({
      group_by_field: 'status',
      card_fields: ['amount'],
      columns_order: ['open'],
      filters: [{ field_key: 'amount', op: 'gte', value: 100 }],
      sort: [{ field_key: 'amount', dir: 'desc' }],
    });
  });

  it('kanbanConfigFromDraft omits columns_order when empty (default enum order, no need to persist)', () => {
    const config = kanbanConfigFromDraft({ group_by_field: 'status', card_fields: [], columns_order: [], filters: [], sort: [] });
    expect('columns_order' in config).toBe(false);
  });

  it('round-trip: config -> draft -> config is stable', () => {
    const original = {
      group_by_field: 'status',
      card_fields: ['amount'],
      filters: [{ field_key: 'amount', op: 'gte', value: 100 }],
      sort: [{ field_key: 'amount', dir: 'desc' }],
    };
    const draft = draftFromKanbanConfig(original, CATALOG);
    const roundTripped = kanbanConfigFromDraft(draft);
    expect(roundTripped).toEqual(original);
  });
});
