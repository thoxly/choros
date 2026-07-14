/**
 * web/src/forms/field-renderer-d77.test.jsx  (T-0406 · D7-7)
 *
 * Tests for CollectionField (collection contract / line-items table) added in D7-7.
 * Verifies:
 *
 *   (a) FieldControl with contract='collection' / type='collection' → CollectionField
 *       element (NOT the old "not yet" italic readout).
 *   (b) CollectionField: empty rows → "Нет строк" empty-state + "Добавить строку" button.
 *   (c) handleAdd: calling the "Добавить строку" button's onClick → rows array grows,
 *       new blank row is emitted via onChange.
 *   (d) handleRemove: calling row's remove button → row spliced, onChange called with
 *       shorter array.
 *   (e) Cell FieldControl: each cell gets hideLabel=true + its sub-field descriptor.
 *   (f) Sub-field cell renders its correct control type (text → input, select → select).
 *   (g) Validation errors: per-cell errors passed as rowErrors, top-level _collection error.
 *   (h) readOnly: add/remove buttons are disabled.
 *
 * Approach: call components as plain functions and walk the returned React element tree —
 * no DOM or jsdom. Consistent with field-renderer.test.jsx / field-renderer-d76.test.jsx.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { FieldControl, CollectionField, RelationPickerField, DateRangeField, MoneyInput } from './field-renderer.jsx';

// ---------------------------------------------------------------------------
// Tree-walk helpers (same pattern as field-renderer-d76.test.jsx)
// ---------------------------------------------------------------------------

function collectElements(node, predicate, results = []) {
  if (node === null || node === undefined) return results;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, results);
    return results;
  }
  if (typeof node !== 'object' || !node.type) return results;
  if (predicate(node)) results.push(node);
  const { children } = node.props || {};
  if (children !== undefined) collectElements(children, predicate, results);
  return results;
}

function findByType(tree, type) {
  return collectElements(tree, (el) => el.type === type);
}

// Collect elements by React component function (for named exports like CollectionField).
function findByComponent(tree, component) {
  return collectElements(tree, (el) => el.type === component);
}

const noop = () => {};

// Minimal collection field descriptor with two sub-fields (text + select).
const COLLECTION_FIELD = {
  key: 'line_items',
  label: 'Позиции',
  type: 'collection',
  required: false,
  subFields: [
    { key: 'name', type: 'string', label: 'Наименование', required: true, inputKind: 'text' },
    { key: 'qty', type: 'number', label: 'Кол-во', required: false, inputKind: 'number' },
    { key: 'unit', type: 'select', label: 'Ед.изм.', required: false, inputKind: 'select', options: ['шт', 'кг', 'л'] },
  ],
};

// ---------------------------------------------------------------------------
// (a) FieldControl dispatch: collection contract / type → CollectionField
// ---------------------------------------------------------------------------

describe('FieldControl D7-7 · collection contract → CollectionField', () => {
  it('returns CollectionField for contract=collection', () => {
    const tree = FieldControl({
      field: { ...COLLECTION_FIELD, contract: 'collection' },
      value: [],
      onChange: noop,
    });

    expect(tree).not.toBeNull();
    expect(tree.type).toBe(CollectionField);
  });

  it('returns CollectionField for type=collection (legacy path, no contract)', () => {
    const tree = FieldControl({
      field: COLLECTION_FIELD,
      value: [],
      onChange: noop,
    });

    expect(tree).not.toBeNull();
    expect(tree.type).toBe(CollectionField);
    expect(tree.props.field.key).toBe('line_items');
  });

  it('FieldControl with collection does NOT contain "пока заполняется" italic text (no "not yet")', () => {
    const tree = FieldControl({
      field: COLLECTION_FIELD,
      value: [],
      onChange: noop,
    });

    // The old fallback rendered a div with fontStyle:italic and "пока заполняется".
    const notYetDivs = collectElements(tree, (el) => {
      const text = JSON.stringify(el.props?.children || '');
      return text.includes('пока заполняется');
    });
    expect(notYetDivs).toHaveLength(0);
  });

  it('props are threaded through to CollectionField correctly', () => {
    const changes = [];
    const tree = FieldControl({
      field: { ...COLLECTION_FIELD, required: true },
      value: [{ name: 'Widget', qty: '5', unit: 'шт' }],
      onChange: (k, v) => changes.push({ k, v }),
    });

    expect(tree.type).toBe(CollectionField);
    expect(tree.props.isRequired).toBe(true);
    expect(Array.isArray(tree.props.value)).toBe(true);
    expect(tree.props.value).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (b) Empty collection → honest empty state + "Добавить строку" button
// ---------------------------------------------------------------------------

describe('CollectionField D7-7 · empty state', () => {
  it('renders .chs-field wrapper with field label', () => {
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: [],
      onChange: noop,
    });

    expect(tree.type).toBe('div');
    expect(tree.props.className).toContain('chs-field');
    // Label should appear somewhere in the tree.
    const labelDivs = collectElements(tree, (el) => {
      const text = JSON.stringify(el.props?.children || '');
      return text.includes('Позиции');
    });
    expect(labelDivs.length).toBeGreaterThan(0);
  });

  it('empty rows → renders a row indicating "no rows" (empty-state)', () => {
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: [],
      onChange: noop,
    });

    // A <td> with the "Нет строк" message.
    const tds = findByType(tree, 'td');
    const emptyTd = tds.find((td) => {
      const text = JSON.stringify(td.props?.children || '');
      return text.includes('Нет строк') || text.includes('нет строк');
    });
    expect(emptyTd).toBeDefined();
  });

  it('empty rows → "Добавить строку" button is present and enabled', () => {
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: [],
      onChange: noop,
    });

    const buttons = findByType(tree, 'button');
    const addBtn = buttons.find((b) => {
      const text = JSON.stringify(b.props?.children || '');
      return text.includes('Добавить строку');
    });
    expect(addBtn).toBeDefined();
    expect(addBtn.props.disabled).toBeFalsy();
  });

  it('renders column headers from subFields labels', () => {
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: [],
      onChange: noop,
    });

    const ths = findByType(tree, 'th');
    const headerTexts = ths.map((th) => JSON.stringify(th.props?.children || ''));
    const hasName = headerTexts.some((t) => t.includes('Наименование'));
    const hasQty = headerTexts.some((t) => t.includes('Кол-во'));
    const hasUnit = headerTexts.some((t) => t.includes('Ед.изм.'));
    expect(hasName).toBe(true);
    expect(hasQty).toBe(true);
    expect(hasUnit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (c) Add row → rows array grows, onChange called with blank new row
// ---------------------------------------------------------------------------

describe('CollectionField D7-7 · add row', () => {
  it('clicking add button calls onChange with rows.length + 1', () => {
    const calls = [];
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: [{ name: 'Widget', qty: '2', unit: 'шт' }],
      onChange: (key, rows) => calls.push({ key, rows }),
    });

    const buttons = findByType(tree, 'button');
    const addBtn = buttons.find((b) => {
      const text = JSON.stringify(b.props?.children || '');
      return text.includes('Добавить строку');
    });
    expect(addBtn).toBeDefined();

    // Simulate click.
    addBtn.props.onClick();
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe('line_items');
    expect(calls[0].rows).toHaveLength(2);
  });

  it('new row has blank values for all subFields (text → "", boolean → false)', () => {
    const calls = [];
    const fieldWithBool = {
      ...COLLECTION_FIELD,
      subFields: [
        { key: 'name', type: 'string', label: 'Имя', required: false, inputKind: 'text' },
        { key: 'active', type: 'boolean', label: 'Активен', required: false, inputKind: 'checkbox' },
      ],
    };
    const tree = CollectionField({
      field: fieldWithBool,
      value: [],
      onChange: (key, rows) => calls.push({ key, rows }),
    });

    const buttons = findByType(tree, 'button');
    const addBtn = buttons.find((b) => JSON.stringify(b.props?.children || '').includes('Добавить'));
    addBtn.props.onClick();
    expect(calls[0].rows).toHaveLength(1);
    expect(calls[0].rows[0].name).toBe('');
    expect(calls[0].rows[0].active).toBe(false);
  });

  it('add to empty array: onChange called with exactly one blank row', () => {
    const calls = [];
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: [],
      onChange: (key, rows) => calls.push({ key, rows }),
    });

    const addBtn = findByType(tree, 'button').find((b) => JSON.stringify(b.props?.children || '').includes('Добавить'));
    addBtn.props.onClick();
    expect(calls[0].rows).toHaveLength(1);
    // All sub-field values should be blank strings.
    expect(calls[0].rows[0].name).toBe('');
    expect(calls[0].rows[0].qty).toBe('');
    expect(calls[0].rows[0].unit).toBe('');
  });
});

// ---------------------------------------------------------------------------
// (d) Remove row → row spliced, onChange called with shorter array
// ---------------------------------------------------------------------------

describe('CollectionField D7-7 · remove row', () => {
  it('clicking remove on row 0 of 2 → onChange called with 1 row remaining', () => {
    const calls = [];
    const rows = [
      { name: 'Widget A', qty: '2', unit: 'шт' },
      { name: 'Widget B', qty: '5', unit: 'кг' },
    ];
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: rows,
      onChange: (key, r) => calls.push({ key, r }),
    });

    // The remove buttons are the ✕ buttons with aria-label "Удалить строку N".
    const removeBtns = collectElements(tree, (el) =>
      el.type === 'button' && typeof el.props['aria-label'] === 'string' && el.props['aria-label'].startsWith('Удалить строку')
    );
    expect(removeBtns.length).toBeGreaterThanOrEqual(1);

    // Remove row 0.
    removeBtns[0].props.onClick();
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe('line_items');
    expect(calls[0].r).toHaveLength(1);
    // The remaining row should be Widget B.
    expect(calls[0].r[0].name).toBe('Widget B');
  });

  it('clicking remove on last row → onChange called with empty array', () => {
    const calls = [];
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: [{ name: 'Solo', qty: '1', unit: 'шт' }],
      onChange: (key, r) => calls.push({ key, r }),
    });

    const removeBtns = collectElements(tree, (el) =>
      el.type === 'button' && typeof el.props['aria-label'] === 'string' && el.props['aria-label'].startsWith('Удалить')
    );
    removeBtns[0].props.onClick();
    expect(calls[0].r).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (e) Cell FieldControl: hideLabel=true + correct field descriptor
// ---------------------------------------------------------------------------

describe('CollectionField D7-7 · cell rendering', () => {
  it('each cell renders a FieldControl with hideLabel=true', () => {
    const rows = [{ name: 'Widget', qty: '3', unit: 'шт' }];
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: rows,
      onChange: noop,
    });

    // FieldControl is a named export; find elements whose type is FieldControl.
    const cellControls = findByComponent(tree, FieldControl);
    // 3 subFields × 1 row = 3 FieldControl elements.
    expect(cellControls.length).toBe(3);
    // All must have hideLabel=true.
    for (const fc of cellControls) {
      expect(fc.props.hideLabel).toBe(true);
    }
  });

  it('each cell FieldControl carries its sub-field descriptor (key, type)', () => {
    const rows = [{ name: 'Widget', qty: '3', unit: 'шт' }];
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: rows,
      onChange: noop,
    });

    const cellControls = findByComponent(tree, FieldControl);
    const keys = cellControls.map((fc) => fc.props.field.key).sort();
    expect(keys).toEqual(['name', 'qty', 'unit'].sort());
  });

  it('cell value is the current row value for that sub-field', () => {
    const rows = [{ name: 'Тест', qty: '42', unit: 'кг' }];
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: rows,
      onChange: noop,
    });

    const cellControls = findByComponent(tree, FieldControl);
    const nameControl = cellControls.find((fc) => fc.props.field.key === 'name');
    const qtyControl = cellControls.find((fc) => fc.props.field.key === 'qty');
    const unitControl = cellControls.find((fc) => fc.props.field.key === 'unit');

    expect(nameControl).toBeDefined();
    expect(nameControl.props.value).toBe('Тест');
    expect(qtyControl.props.value).toBe('42');
    expect(unitControl.props.value).toBe('кг');
  });
});

// ---------------------------------------------------------------------------
// (f) Sub-field type renders correct control (via FieldControl → scalarish path)
// ---------------------------------------------------------------------------

describe('CollectionField D7-7 · sub-field control types (structural, via FieldControl)', () => {
  it('text sub-field → FieldControl dispatches to <input type=text>', () => {
    // Call FieldControl directly for a text sub-field (hideLabel=true) and confirm
    // it renders a text input (not a "not yet" div).
    const textField = { key: 'name', type: 'string', label: 'Имя', required: false };
    const tree = FieldControl({ field: textField, value: 'hello', onChange: noop, hideLabel: true });

    const inputs = collectElements(tree, (el) => el.type === 'input' && el.props?.type === 'text');
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs[0].props.value).toBe('hello');
  });

  it('number sub-field → FieldControl dispatches to <input type=number>', () => {
    const numberField = { key: 'qty', type: 'number', label: 'Кол-во', required: false };
    const tree = FieldControl({ field: numberField, value: '5', onChange: noop, hideLabel: true });

    const inputs = collectElements(tree, (el) => el.type === 'input' && el.props?.type === 'number');
    expect(inputs.length).toBeGreaterThan(0);
  });

  it('select sub-field → FieldControl dispatches to <select>', () => {
    const selectField = { key: 'unit', type: 'select', label: 'Ед.', required: false, options: ['шт', 'кг'] };
    const tree = FieldControl({ field: selectField, value: 'шт', onChange: noop, hideLabel: true });

    const selects = findByType(tree, 'select');
    expect(selects.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (g) Validation errors: per-cell + top-level _collection
// ---------------------------------------------------------------------------

describe('CollectionField D7-7 · validation error display', () => {
  it('_collection top-level error → rendered as role=alert span', () => {
    const tree = CollectionField({
      field: { ...COLLECTION_FIELD, required: true },
      value: [],
      onChange: noop,
      error: { rows: [], _collection: 'Добавьте хотя бы одну строку' },
    });

    const alertSpans = collectElements(tree, (el) => el.type === 'span' && el.props?.role === 'alert');
    expect(alertSpans.length).toBeGreaterThan(0);
    const text = alertSpans[0].props?.children;
    expect(text).toContain('Добавьте хотя бы одну строку');
  });

  it('string error (scalar) → rendered as role=alert span', () => {
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: [],
      onChange: noop,
      error: 'Обязательное поле',
    });

    const alertSpans = collectElements(tree, (el) => el.type === 'span' && el.props?.role === 'alert');
    expect(alertSpans.length).toBeGreaterThan(0);
    expect(alertSpans[0].props.children).toContain('Обязательное поле');
  });

  it('per-cell errors passed to the corresponding FieldControl', () => {
    const rowErrors = [{ name: 'Обязательное поле' }]; // error on first row, 'name' sub-field
    const rows = [{ name: '', qty: '1', unit: 'шт' }];

    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: rows,
      onChange: noop,
      error: { rows: rowErrors },
    });

    // The FieldControl for 'name' in row 0 should receive error='Обязательное поле'.
    const cellControls = findByComponent(tree, FieldControl);
    const nameControl = cellControls.find((fc) => fc.props.field.key === 'name');
    expect(nameControl).toBeDefined();
    expect(nameControl.props.error).toBe('Обязательное поле');
  });

  it('undefined per-row error → cell FieldControl receives no error', () => {
    const rows = [{ name: 'OK', qty: '1', unit: 'шт' }];
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: rows,
      onChange: noop,
      error: { rows: [undefined] }, // no errors for this row
    });

    const cellControls = findByComponent(tree, FieldControl);
    for (const fc of cellControls) {
      expect(fc.props.error).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// (h) readOnly: add/remove buttons disabled
// ---------------------------------------------------------------------------

describe('CollectionField D7-7 · readOnly', () => {
  it('readOnly=true → add button is disabled', () => {
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: [],
      onChange: noop,
      readOnly: true,
    });

    const buttons = findByType(tree, 'button');
    const addBtn = buttons.find((b) => JSON.stringify(b.props?.children || '').includes('Добавить'));
    expect(addBtn).toBeDefined();
    expect(addBtn.props.disabled).toBe(true);
  });

  it('readOnly=true → remove buttons are disabled', () => {
    const rows = [{ name: 'Widget', qty: '1', unit: 'шт' }];
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: rows,
      onChange: noop,
      readOnly: true,
    });

    const removeBtns = collectElements(tree, (el) =>
      el.type === 'button' && typeof el.props['aria-label'] === 'string' && el.props['aria-label'].startsWith('Удалить')
    );
    expect(removeBtns.length).toBeGreaterThan(0);
    for (const btn of removeBtns) {
      expect(btn.props.disabled).toBe(true);
    }
  });

  it('readOnly=true → onClick for add/remove does NOT call onChange', () => {
    const calls = [];
    const rows = [{ name: 'Widget', qty: '1', unit: 'шт' }];
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: rows,
      onChange: (k, v) => calls.push(v),
      readOnly: true,
    });

    // Even if onClick fires (e.g. via JS), the handler respects readOnly.
    const buttons = findByType(tree, 'button');
    for (const btn of buttons) {
      btn.props.onClick?.();
    }
    // readOnly guard returns early — no onChange calls.
    expect(calls).toHaveLength(0);
  });

  // B-1 (review): readOnly must reach the CELL inputs, not just the buttons.
  // Each cell FieldControl gets field.mode='read-only' so the rendered control
  // is really disabled (resolveFieldMode → readOnly).
  it('readOnly=true → each cell FieldControl carries field.mode="read-only"', () => {
    const rows = [{ name: 'Widget', qty: '3', unit: 'шт' }];
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: rows,
      onChange: noop,
      readOnly: true,
    });

    const cellControls = findByComponent(tree, FieldControl);
    expect(cellControls.length).toBe(3);
    for (const fc of cellControls) {
      expect(fc.props.field.mode).toBe('read-only');
    }
  });

  it('readOnly=true → rendered cell inputs are actually disabled/readOnly (not just buttons)', () => {
    const rows = [{ name: 'Widget', qty: '3', unit: 'шт' }];
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: rows,
      onChange: noop,
      readOnly: true,
    });

    // Render each cell FieldControl one level deeper (call it as a function with
    // its props) and assert the underlying control is disabled (select) or
    // readOnly (text/number input).
    const cellControls = findByComponent(tree, FieldControl);
    for (const fc of cellControls) {
      const rendered = FieldControl(fc.props);
      const inputs = collectElements(rendered, (el) => el.type === 'input' || el.type === 'select' || el.type === 'textarea');
      expect(inputs.length).toBeGreaterThan(0);
      for (const ctrl of inputs) {
        // select → disabled; text/number/textarea → readOnly. Either way the
        // user cannot edit it. Assert at least one of the two is truthy.
        const locked = ctrl.props.disabled === true || ctrl.props.readOnly === true;
        expect(locked).toBe(true);
      }
    }
  });

  it('NOT readOnly → cell FieldControl has no forced read-only mode', () => {
    const rows = [{ name: 'Widget', qty: '3', unit: 'шт' }];
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: rows,
      onChange: noop,
      readOnly: false,
    });
    const cellControls = findByComponent(tree, FieldControl);
    for (const fc of cellControls) {
      // The sub-field descriptor carries no mode → editable.
      expect(fc.props.field.mode).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// B-2 (review): the field label is a real <label htmlFor> (WCAG 1.3.1 / G6),
// not a bare <div className="chs-label">.
// ---------------------------------------------------------------------------

describe('CollectionField D7-7 · a11y label (B-2)', () => {
  it('field label is a <label> element (not a div) with the field text', () => {
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: [],
      onChange: noop,
    });

    const labels = findByType(tree, 'label');
    const mainLabel = labels.find((l) => {
      const c = l.props?.children;
      if (typeof c === 'string') return c.includes('Позиции');
      if (Array.isArray(c)) return c.some((x) => typeof x === 'string' && x.includes('Позиции'));
      return false;
    });
    expect(mainLabel).toBeDefined();
    expect(mainLabel.type).toBe('label');
  });

  it('field <label> has htmlFor bound to the table id', () => {
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: [{ name: 'X', qty: '1', unit: 'шт' }],
      idPrefix: 'rec',
      onChange: noop,
    });

    const labels = findByType(tree, 'label');
    const mainLabel = labels.find((l) => l.props?.htmlFor === 'rec-line_items');
    expect(mainLabel).toBeDefined();

    // The table it points to carries the same id.
    const tables = findByType(tree, 'table');
    expect(tables.length).toBe(1);
    expect(tables[0].props.id).toBe('rec-line_items');
  });

  it('the field label is NOT a div.chs-label (regression of B-2)', () => {
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: [],
      onChange: noop,
    });
    // No top-level div with chs-label class carrying the field title.
    const labelDivs = collectElements(tree, (el) => {
      if (el.type !== 'div') return false;
      const cn = el.props?.className || '';
      if (!cn.split(' ').includes('chs-label')) return false;
      const c = JSON.stringify(el.props?.children || '');
      return c.includes('Позиции');
    });
    expect(labelDivs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// NON-BLOCKING (review): stable <tr> key from __rowKey (avoids index-reuse flicker).
// ---------------------------------------------------------------------------

describe('CollectionField D7-7 · stable row key (__rowKey)', () => {
  it('handleAdd stamps a non-enumerable __rowKey on the new row', () => {
    const calls = [];
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: [],
      onChange: (key, rows) => calls.push(rows),
    });
    const addBtn = findByType(tree, 'button').find((b) => JSON.stringify(b.props?.children || '').includes('Добавить'));
    addBtn.props.onClick();

    const newRow = calls[0][0];
    // __rowKey is present...
    expect(typeof newRow.__rowKey).toBe('string');
    expect(newRow.__rowKey.length).toBeGreaterThan(0);
    // ...but NON-enumerable, so serializeRecordData (Object.keys / for…of) never sees it.
    expect(Object.keys(newRow)).not.toContain('__rowKey');
    expect(Object.prototype.propertyIsEnumerable.call(newRow, '__rowKey')).toBe(false);
  });

  it('handleCellChange preserves the __rowKey on the edited row', () => {
    // Seed a row that already has a __rowKey (as handleAdd would produce).
    const seeded = { name: 'A', qty: '1', unit: 'шт' };
    Object.defineProperty(seeded, '__rowKey', { value: 'r-stable-1', enumerable: false, configurable: true });

    const calls = [];
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: [seeded],
      onChange: (key, rows) => calls.push(rows),
    });

    // Find the 'name' cell control and fire its onChange.
    const cellControls = findByComponent(tree, FieldControl);
    const nameControl = cellControls.find((fc) => fc.props.field.key === 'name');
    nameControl.props.onChange('name', 'B');

    const updatedRow = calls[0][0];
    expect(updatedRow.name).toBe('B');
    expect(updatedRow.__rowKey).toBe('r-stable-1'); // preserved across edit
    expect(Object.keys(updatedRow)).not.toContain('__rowKey'); // still non-enumerable-clean
  });

  it('rows from data without __rowKey fall back to index key (no crash)', () => {
    const rows = [{ name: 'A', qty: '1', unit: 'шт' }, { name: 'B', qty: '2', unit: 'кг' }];
    const tree = CollectionField({
      field: COLLECTION_FIELD,
      value: rows,
      onChange: noop,
    });
    // Two <tr> rendered (plus possibly the header tr). At least the body rows render.
    const trs = findByType(tree, 'tr');
    expect(trs.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Non-regression: relation/date-range/money not broken by D7-7 addition
// ---------------------------------------------------------------------------

describe('FieldControl D7-7 · non-regression: relation/date-range/money unaffected', () => {
  it('relation → still dispatches to RelationPickerField (not CollectionField)', () => {
    const tree = FieldControl({
      field: { key: 'ref', label: 'Ссылка', type: 'relation', targetRegistryId: 'reg-001' },
      value: '',
      onChange: noop,
    });
    expect(tree.type).not.toBe(CollectionField);
    // The dispatched type is the RelationPickerField function (imported above).
    expect(tree.type).toBe(RelationPickerField);
  });

  it('money → still renders ₽ suffix (not CollectionField)', () => {
    const tree = FieldControl({
      field: { key: 'amount', label: 'Сумма', type: 'money' },
      value: '1000',
      onChange: noop,
    });
    expect(tree.type).not.toBe(CollectionField);
    // T-0649: money renders via <MoneyInput> — invoke it to inspect its tree
    // (same pattern already used for RelationPickerField/DateRangeField).
    const moneyEl = collectElements(tree, (el) => el.type === MoneyInput)[0];
    expect(moneyEl).toBeDefined();
    const moneyTree = MoneyInput(moneyEl.props);
    const ruble = collectElements(moneyTree, (el) => el.type === 'span' && el.props?.children === '₽');
    expect(ruble.length).toBeGreaterThan(0);
  });
});
