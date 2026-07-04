/**
 * web/src/screens/list-view-panel.test.js — T-0581 (view registry) FR-4/AC-14.
 *
 * Unit tests for the pure logic in list-view-panel.js:
 *   - operatorsForFieldType / isServerSortable byte-mirror the server table
 *     (src/core/view-config.ts) so the panel never offers an operator the
 *     server will reject (AC-4/AC-5 client-side honesty);
 *   - OP_LABELS are human Russian words, never raw op codes, for every
 *     operator the panel can offer (G5 — no dev jargon in visible text);
 *   - draftFromConfig / configFromDraft round-trip a ListViewConfig without
 *     inventing or dropping data (besides the client-only draft `id`);
 *   - column reorder (moveColumn) is the keyboard-operable primitive — a pure
 *     array splice, no drag-and-drop dependency;
 *   - filter/sort row builders + validateFilterRow give honest client-side
 *     feedback before a config ever reaches the server;
 *   - buildInlineQuerySuffix encodes filters/sort as the EXACT base64url-JSON
 *     shape src/http/records.ts's decodeBase64UrlJsonArray expects (bare
 *     array, not {filters:[...]}), and contributes nothing when both are
 *     empty (NF-2: default request stays byte-identical).
 */

import { describe, it, expect } from 'vitest';
import {
  OP_LABELS,
  operatorsForFieldType,
  isServerSortable,
  operatorNeedsValue,
  operatorNeedsRange,
  operatorNeedsList,
  buildFieldCatalog,
  draftFromConfig,
  configFromDraft,
  moveColumn,
  toggleColumnVisible,
  setColumnWidth,
  addFilterRow,
  removeFilterRow,
  updateFilterRow,
  validateFilterRow,
  addSortRow,
  removeSortRow,
  availableSortFields,
  availableFilterFields,
  validateViewName,
  encodeInlineParam,
  buildInlineQuerySuffix,
  allColumnsHidden,
} from './list-view-panel.js';

// ---------------------------------------------------------------------------
// operatorsForFieldType — byte-mirror of src/core/view-config.ts's table.
// ---------------------------------------------------------------------------

describe('operatorsForFieldType — mirrors the server table (ADR §3.4)', () => {
  it('string/url/email: eq,neq,contains,starts_with,is_empty,is_not_empty', () => {
    const expected = ['eq', 'neq', 'contains', 'starts_with', 'is_empty', 'is_not_empty'];
    expect(operatorsForFieldType('string')).toEqual(expected);
    expect(operatorsForFieldType('url')).toEqual(expected);
    expect(operatorsForFieldType('email')).toEqual(expected);
  });

  it('number/integer/money: eq,neq,gt,gte,lt,lte,between,is_empty,is_not_empty', () => {
    const expected = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'];
    expect(operatorsForFieldType('number')).toEqual(expected);
    expect(operatorsForFieldType('integer')).toEqual(expected);
    expect(operatorsForFieldType('money')).toEqual(expected);
  });

  it('date: eq,before,after,between,is_empty,is_not_empty (NOT contains/gt)', () => {
    expect(operatorsForFieldType('date')).toEqual(['eq', 'before', 'after', 'between', 'is_empty', 'is_not_empty']);
    expect(operatorsForFieldType('date')).not.toContain('contains');
    expect(operatorsForFieldType('date')).not.toContain('gt');
  });

  it('boolean: is_true,is_false,is_empty (never gt/contains — AC-4 anchor)', () => {
    expect(operatorsForFieldType('boolean')).toEqual(['is_true', 'is_false', 'is_empty']);
  });

  it('select: eq,neq,in,is_empty,is_not_empty', () => {
    expect(operatorsForFieldType('select')).toEqual(['eq', 'neq', 'in', 'is_empty', 'is_not_empty']);
  });

  it('multi-select: contains_any,contains_all,is_empty,is_not_empty', () => {
    expect(operatorsForFieldType('multi-select')).toEqual(['contains_any', 'contains_all', 'is_empty', 'is_not_empty']);
  });

  it('person/relation: eq,neq,is_empty,is_not_empty', () => {
    expect(operatorsForFieldType('person')).toEqual(['eq', 'neq', 'is_empty', 'is_not_empty']);
    expect(operatorsForFieldType('relation')).toEqual(['eq', 'neq', 'is_empty', 'is_not_empty']);
  });

  it('created_at pseudo-column: eq,gt,gte,lt,lte,between', () => {
    expect(operatorsForFieldType('created_at')).toEqual(['eq', 'gt', 'gte', 'lt', 'lte', 'between']);
  });

  it('computed/collection: [] — never filterable (AC-4)', () => {
    expect(operatorsForFieldType('computed')).toEqual([]);
    expect(operatorsForFieldType('collection')).toEqual([]);
  });
});

describe('isServerSortable — mirrors the server table (FR-6)', () => {
  it('sortable: string/number/integer/money/date/boolean/select/created_at', () => {
    for (const t of ['string', 'url', 'email', 'number', 'integer', 'money', 'date', 'boolean', 'select', 'created_at']) {
      expect(isServerSortable(t)).toBe(true);
    }
  });
  it('NOT sortable: multi-select/person/relation/computed/collection (AC-5)', () => {
    for (const t of ['multi-select', 'person', 'relation', 'computed', 'collection']) {
      expect(isServerSortable(t)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Every offered operator has a human Russian label (G5 — no "eq"/"gt" leak).
// ---------------------------------------------------------------------------

describe('OP_LABELS — human Russian words, never raw op codes (G5)', () => {
  const ALL_TYPES = [
    'string', 'number', 'date', 'boolean', 'select', 'multi-select', 'person', 'relation', 'created_at',
  ];
  it('every operator offered for every field type has a non-empty Russian label distinct from its code', () => {
    for (const type of ALL_TYPES) {
      for (const op of operatorsForFieldType(type)) {
        const label = OP_LABELS[op];
        expect(label, `missing label for op '${op}'`).toBeTruthy();
        expect(label).not.toBe(op);
        // Dev-jargon guard: the label must not be the bare snake_case op code
        // rendered as-is (e.g. "is_empty" leaking verbatim into the UI).
        expect(label).not.toMatch(/_/);
      }
    }
  });

  it('op-needs-value helpers agree with which ops carry a value', () => {
    expect(operatorNeedsValue('is_empty')).toBe(false);
    expect(operatorNeedsValue('is_not_empty')).toBe(false);
    expect(operatorNeedsValue('is_true')).toBe(false);
    expect(operatorNeedsValue('is_false')).toBe(false);
    expect(operatorNeedsValue('eq')).toBe(true);
    expect(operatorNeedsRange('between')).toBe(true);
    expect(operatorNeedsRange('eq')).toBe(false);
    expect(operatorNeedsList('in')).toBe(true);
    expect(operatorNeedsList('contains_any')).toBe(true);
    expect(operatorNeedsList('contains_all')).toBe(true);
    expect(operatorNeedsList('eq')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildFieldCatalog — schemaToColumns() output + created_at pseudo-column.
// ---------------------------------------------------------------------------

describe('buildFieldCatalog', () => {
  it('appends the created_at pseudo-column after the schema columns', () => {
    const schemaColumns = [
      { key: 'amount', label: 'Сумма', type: 'money' },
      { key: 'status', label: 'Статус', type: 'select' },
    ];
    const catalog = buildFieldCatalog(schemaColumns);
    expect(catalog).toHaveLength(3);
    expect(catalog[2]).toEqual({ key: 'created_at', label: 'Создано', type: 'created_at' });
  });

  it('handles an empty/missing schemaColumns without throwing', () => {
    expect(buildFieldCatalog(undefined)).toHaveLength(1);
    expect(buildFieldCatalog([])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// draftFromConfig / configFromDraft — round-trip fidelity.
// ---------------------------------------------------------------------------

describe('draftFromConfig / configFromDraft round-trip', () => {
  const catalog = buildFieldCatalog([
    { key: 'amount', label: 'Сумма', type: 'money' },
    { key: 'status', label: 'Статус', type: 'select' },
    { key: 'notes', label: 'Заметка', type: 'string' },
  ]);

  it('round-trips columns/filters/sort without loss', () => {
    const config = {
      columns: [
        { field_key: 'status', visible: true },
        { field_key: 'amount', visible: true, width: 160 },
        { field_key: 'notes', visible: false },
        { field_key: 'created_at', visible: true },
      ],
      filters: [{ field_key: 'status', op: 'eq', value: 'open' }],
      sort: [{ field_key: 'amount', dir: 'desc' }],
    };
    const draft = draftFromConfig(config, catalog);
    expect(draft.columns.map((c) => c.field_key)).toEqual(['status', 'amount', 'notes', 'created_at']);
    expect(draft.columns[1].width).toBe(160);
    expect(draft.columns[2].visible).toBe(false);
    expect(draft.filters).toHaveLength(1);
    expect(draft.sort).toHaveLength(1);

    const rebuilt = configFromDraft(draft);
    expect(rebuilt.columns).toEqual([
      { field_key: 'status', visible: true },
      { field_key: 'amount', visible: true, width: 160 },
      { field_key: 'notes', visible: false },
      { field_key: 'created_at', visible: true },
    ]);
    expect(rebuilt.filters).toEqual([{ field_key: 'status', op: 'eq', value: 'open' }]);
    expect(rebuilt.sort).toEqual([{ field_key: 'amount', dir: 'desc' }]);
  });

  it('appends catalog fields missing from a stale saved config as hidden (schema grew after the view was saved)', () => {
    const config = { columns: [{ field_key: 'amount', visible: true }], filters: [], sort: [] };
    const draft = draftFromConfig(config, catalog);
    const statusCol = draft.columns.find((c) => c.field_key === 'status');
    const notesCol = draft.columns.find((c) => c.field_key === 'notes');
    expect(statusCol.visible).toBe(false);
    expect(notesCol.visible).toBe(false);
  });

  it('drops columns referencing a field no longer in the catalog (field removed from schema)', () => {
    const config = { columns: [{ field_key: 'deleted_field', visible: true }, { field_key: 'amount', visible: true }], filters: [], sort: [] };
    const draft = draftFromConfig(config, catalog);
    expect(draft.columns.find((c) => c.field_key === 'deleted_field')).toBeUndefined();
  });

  it('configFromDraft drops incomplete filter/sort rows (mid-edit, not yet valid)', () => {
    const draft = { columns: [], filters: [{ id: 'x', field_key: '', op: '', value: '' }], sort: [{ id: 'y', field_key: 'amount', dir: '' }] };
    const config = configFromDraft(draft);
    expect(config.filters).toEqual([]);
    expect(config.sort).toEqual([]);
  });

  it('handles an empty config (fresh/default) without throwing', () => {
    const draft = draftFromConfig(null, catalog);
    expect(draft.columns.length).toBe(catalog.length);
    expect(draft.filters).toEqual([]);
    expect(draft.sort).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Column ops — visibility / reorder / width (the keyboard-operable primitive).
// ---------------------------------------------------------------------------

describe('column ops', () => {
  const cols = [
    { id: 'a', field_key: 'amount', visible: true, width: null },
    { id: 'b', field_key: 'status', visible: true, width: null },
    { id: 'c', field_key: 'notes', visible: false, width: null },
  ];

  it('toggleColumnVisible flips only the targeted row', () => {
    const next = toggleColumnVisible(cols, 'c');
    expect(next.find((c) => c.id === 'c').visible).toBe(true);
    expect(next.find((c) => c.id === 'a').visible).toBe(true); // unaffected
  });

  it('setColumnWidth sets/clears width on the targeted row only', () => {
    const withWidth = setColumnWidth(cols, 'a', 220);
    expect(withWidth.find((c) => c.id === 'a').width).toBe(220);
    expect(withWidth.find((c) => c.id === 'b').width).toBeNull();
    const cleared = setColumnWidth(withWidth, 'a', null);
    expect(cleared.find((c) => c.id === 'a').width).toBeNull();
  });

  it('moveColumn — the up/down keyboard-operable reorder primitive: moves an item to a new index', () => {
    // Move 'notes' (index 2) up to index 0 — mirrors clicking "up" twice.
    const moved = moveColumn(cols, 2, 0);
    expect(moved.map((c) => c.id)).toEqual(['c', 'a', 'b']);
  });

  it('moveColumn is a no-op past either boundary (mirrors disabled button at the edge)', () => {
    expect(moveColumn(cols, 0, -1)).toBe(cols);
    expect(moveColumn(cols, 2, 3)).toBe(cols);
  });

  it('moveColumn does not mutate the input array', () => {
    const copy = cols.slice();
    moveColumn(cols, 0, 1);
    expect(cols).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// Filter row ops + validation — honest client-side feedback (AC-4 anchor).
// ---------------------------------------------------------------------------

describe('filter row ops + validateFilterRow', () => {
  const typeByKey = new Map([['amount', 'money'], ['status', 'select'], ['flag', 'boolean'], ['created_at', 'created_at']]);

  it('addFilterRow preselects the first legal operator for the field type', () => {
    const rows = addFilterRow([], 'flag', 'boolean');
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe('is_true'); // first of boolean's operator list
  });

  it('removeFilterRow / updateFilterRow target only the given id', () => {
    const rows = [{ id: 'x', field_key: 'amount', op: 'eq', value: 1 }, { id: 'y', field_key: 'status', op: 'eq', value: 'open' }];
    expect(removeFilterRow(rows, 'x')).toEqual([rows[1]]);
    const updated = updateFilterRow(rows, 'y', { value: 'won' });
    expect(updated[1].value).toBe('won');
    expect(updated[0]).toEqual(rows[0]);
  });

  it('validateFilterRow: requires a field, then an operator legal for that field type', () => {
    expect(validateFilterRow({ field_key: '', op: '', value: '' }, typeByKey)).toMatch(/Выберите поле/);
    expect(validateFilterRow({ field_key: 'amount', op: '', value: '' }, typeByKey)).toMatch(/оператор/);
    expect(validateFilterRow({ field_key: 'amount', op: 'contains', value: 'x' }, typeByKey)).toMatch(/оператор/);
  });

  it('validateFilterRow: is_empty/is_true need no value', () => {
    expect(validateFilterRow({ field_key: 'flag', op: 'is_true', value: '' }, typeByKey)).toBeNull();
    expect(validateFilterRow({ field_key: 'amount', op: 'is_empty', value: '' }, typeByKey)).toBeNull();
  });

  it('validateFilterRow: eq on a numeric field rejects a non-numeric value', () => {
    expect(validateFilterRow({ field_key: 'amount', op: 'eq', value: 'not-a-number' }, typeByKey)).toMatch(/числом/);
    expect(validateFilterRow({ field_key: 'amount', op: 'eq', value: '100' }, typeByKey)).toBeNull();
  });

  it('validateFilterRow: between requires both bounds present', () => {
    expect(validateFilterRow({ field_key: 'amount', op: 'between', value: ['1', ''] }, typeByKey)).toMatch(/диапазона/);
    expect(validateFilterRow({ field_key: 'amount', op: 'between', value: ['1', '2'] }, typeByKey)).toBeNull();
  });

  it('validateFilterRow: in/contains_any require at least one value', () => {
    expect(validateFilterRow({ field_key: 'status', op: 'in', value: [] }, typeByKey)).toMatch(/значение/);
    expect(validateFilterRow({ field_key: 'status', op: 'in', value: ['open'] }, typeByKey)).toBeNull();
  });

  it('validateFilterRow: a field never known to filtering (computed) is rejected up front', () => {
    const typeByKeyWithComputed = new Map([...typeByKey, ['total', 'computed']]);
    expect(validateFilterRow({ field_key: 'total', op: 'eq', value: '1' }, typeByKeyWithComputed)).toMatch(/нельзя фильтровать/);
  });
});

describe('availableFilterFields / availableSortFields', () => {
  const catalog = buildFieldCatalog([
    { key: 'amount', label: 'Сумма', type: 'money' },
    { key: 'notes', label: 'Заметка', type: 'collection' },
    { key: 'total', label: 'Итог', type: 'computed' },
    { key: 'tags', label: 'Метки', type: 'multi-select' },
  ]);

  it('availableFilterFields excludes computed/collection (never filterable)', () => {
    const keys = availableFilterFields(catalog).map((f) => f.key);
    expect(keys).toContain('amount');
    expect(keys).toContain('tags'); // multi-select IS filterable (contains_any/all)
    expect(keys).not.toContain('notes');
    expect(keys).not.toContain('total');
  });

  it('availableSortFields excludes non-sortable types AND fields already used in sort', () => {
    const keys = availableSortFields(catalog, []).map((f) => f.key);
    expect(keys).toContain('amount');
    expect(keys).toContain('created_at');
    expect(keys).not.toContain('tags'); // multi-select not server-sortable
    expect(keys).not.toContain('total');

    const alreadyUsed = availableSortFields(catalog, [{ id: 'x', field_key: 'amount', dir: 'desc' }]).map((f) => f.key);
    expect(alreadyUsed).not.toContain('amount');
  });
});

// ---------------------------------------------------------------------------
// Sort row ops.
// ---------------------------------------------------------------------------

describe('sort row ops', () => {
  it('addSortRow defaults to descending', () => {
    const rows = addSortRow([], 'amount');
    expect(rows[0]).toMatchObject({ field_key: 'amount', dir: 'desc' });
  });

  it('removeSortRow removes only the targeted id', () => {
    const rows = [{ id: 'a', field_key: 'amount', dir: 'desc' }, { id: 'b', field_key: 'status', dir: 'asc' }];
    expect(removeSortRow(rows, 'a')).toEqual([rows[1]]);
  });
});

// ---------------------------------------------------------------------------
// View name validation (mirrors server VIEW_NAME_MAX=128).
// ---------------------------------------------------------------------------

describe('validateViewName', () => {
  it('rejects blank/whitespace-only names', () => {
    expect(validateViewName('')).toMatch(/Укажите название/);
    expect(validateViewName('   ')).toMatch(/Укажите название/);
  });
  it('rejects names over 128 chars', () => {
    expect(validateViewName('a'.repeat(129))).toMatch(/128/);
  });
  it('accepts a normal name', () => {
    expect(validateViewName('Мой список')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inline query-param encoding — must match src/http/records.ts's
// decodeBase64UrlJsonArray EXACTLY (Buffer.from(raw, 'base64url') on a bare
// JSON array, not {filters:[...]}).
// ---------------------------------------------------------------------------

describe('encodeInlineParam / buildInlineQuerySuffix — wire-format fidelity', () => {
  it('encodes a bare array as base64url (matches Node Buffer.from(str,"base64url") decode)', () => {
    const arr = [{ field_key: 'status', op: 'eq', value: 'open' }];
    const encoded = encodeInlineParam(arr);
    // Round-trip via the SAME decode the server uses: base64url -> JSON.parse.
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
    expect(decoded).toEqual(arr);
    // base64url alphabet: no '+', '/', or '=' padding characters.
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('buildInlineQuerySuffix contributes NOTHING when filters/sort are both empty (NF-2 default byte-identity)', () => {
    expect(buildInlineQuerySuffix({ filters: [], sort: [] })).toBe('');
  });

  it('buildInlineQuerySuffix emits &filter=/&sort= only for non-empty arrays', () => {
    const suffix = buildInlineQuerySuffix({
      filters: [{ field_key: 'status', op: 'eq', value: 'open' }],
      sort: [],
    });
    expect(suffix).toMatch(/^&filter=/);
    expect(suffix).not.toMatch(/&sort=/);
  });

  it('buildInlineQuerySuffix round-trips filter+sort together', () => {
    const config = {
      filters: [{ field_key: 'amount', op: 'gte', value: 100 }],
      sort: [{ field_key: 'amount', dir: 'desc' }],
    };
    const suffix = buildInlineQuerySuffix(config);
    const filterMatch = suffix.match(/&filter=([^&]+)/);
    const sortMatch = suffix.match(/&sort=([^&]+)/);
    expect(filterMatch).toBeTruthy();
    expect(sortMatch).toBeTruthy();
    const decodedFilter = JSON.parse(Buffer.from(decodeURIComponent(filterMatch[1]), 'base64url').toString('utf-8'));
    const decodedSort = JSON.parse(Buffer.from(decodeURIComponent(sortMatch[1]), 'base64url').toString('utf-8'));
    expect(decodedFilter).toEqual(config.filters);
    expect(decodedSort).toEqual(config.sort);
  });
});

// ---------------------------------------------------------------------------
// T-0581 UX-1 (blocking) — draftFromConfig(null, catalog) is a PROVISIONAL
// "everything hidden" shape, never the real default. This documents the exact
// dishonest shape the panel used to render before the real default arrived,
// so a future change cannot silently reintroduce it without this test noticing.
// ---------------------------------------------------------------------------
describe('draftFromConfig(null, catalog) — the pre-default provisional shape (UX-1 regression guard)', () => {
  const catalog = [
    { key: 'amount', label: 'Сумма', type: 'money' },
    { key: 'status', label: 'Статус', type: 'select' },
    { key: 'created_at', label: 'Создано', type: 'created_at' },
  ];

  it('marks every column visible:false when config is null (the "still loading" shape)', () => {
    const draft = draftFromConfig(null, catalog);
    expect(draft.columns).toHaveLength(catalog.length);
    expect(draft.columns.every((c) => c.visible === false)).toBe(true);
  });

  it('is NOT the server default (all-visible) — proving the panel must not treat null config as ready-to-edit', () => {
    const draft = draftFromConfig(null, catalog);
    // A real synthetic default has every catalog column visible (ADR §3.3);
    // the null/loading shape is the OPPOSITE of that — asserting the two
    // shapes differ documents why the panel needs an explicit loading gate
    // rather than trusting draftFromConfig(null, ...) as if it were honest.
    expect(draft.columns.some((c) => c.visible)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-0581 UX-2 (minor) — allColumnsHidden: warn (not silently allow) saving a
// view whose columns are ALL hidden (screen-app-records.jsx would then render
// only "Создано" + row actions).
// ---------------------------------------------------------------------------
describe('allColumnsHidden — UX-2 empty-columns-set detector', () => {
  it('true when every column in a NON-EMPTY set is hidden', () => {
    expect(allColumnsHidden([
      { field_key: 'a', visible: false },
      { field_key: 'b', visible: false },
    ])).toBe(true);
  });

  it('false when at least one column is visible', () => {
    expect(allColumnsHidden([
      { field_key: 'a', visible: false },
      { field_key: 'b', visible: true },
    ])).toBe(false);
  });

  it('false for an EMPTY column array (that is the separate, already-honest EmptyState case, not this warning)', () => {
    expect(allColumnsHidden([])).toBe(false);
  });

  it('false for a non-array input (defensive)', () => {
    expect(allColumnsHidden(null)).toBe(false);
    expect(allColumnsHidden(undefined)).toBe(false);
  });
});
