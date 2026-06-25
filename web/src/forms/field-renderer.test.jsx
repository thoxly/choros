/**
 * web/src/forms/field-renderer.test.jsx  (T-0450 Fix 2)
 *
 * Tests for the FieldControl component's `hideLabel` prop (T-0450 Fix 2, G7).
 *
 * Approach: React elements are plain objects — we can call FieldControl as a
 * function and walk the returned element tree to verify label presence/absence
 * WITHOUT a DOM or jsdom. This is consistent with the project's "node"
 * environment test philosophy (cf. vitest.config.js header: "fast, no jsdom
 * overhead, honest").
 *
 * What we verify:
 *   1. hideLabel=false (default) → the returned element tree contains a <label>
 *      element and a .chs-field wrapper div with bottom-margin (backward-compat).
 *   2. hideLabel=true → no <label> in the tree; the control (input/select) is
 *      present; no .chs-field wrapper.
 *   3. Spot-check EACH presentation (text, select/enum, checkbox, number, date)
 *      with hideLabel=true → bare control, no label.
 *   4. Existing callers (no hideLabel prop) still get labels → default false.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { FieldControl } from './field-renderer.jsx';

// ---------------------------------------------------------------------------
// Tree-walk helpers — inspect the returned React element tree.
// ---------------------------------------------------------------------------

/**
 * Recursively collect all React elements matching a predicate from a tree.
 * Handles: null / undefined / string / number / array / React element.
 */
function collectElements(node, predicate, results = []) {
  if (node === null || node === undefined) return results;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, results);
    return results;
  }
  if (typeof node !== 'object' || !node.type) return results;
  // React element
  if (predicate(node)) results.push(node);
  const { children } = node.props || {};
  if (children !== undefined) collectElements(children, predicate, results);
  return results;
}

/**
 * Find elements by React type string (e.g. 'label', 'input', 'select', 'div').
 */
function findByType(tree, type) {
  return collectElements(tree, (el) => el.type === type);
}

/**
 * Check if a className prop contains a given substring.
 */
function hasClass(el, cls) {
  const cn = el.props?.className || '';
  return cn.split(' ').includes(cls);
}

// Minimal noop onChange (FieldControl requires it)
const noop = () => {};

// ---------------------------------------------------------------------------
// Fix 2 tests: hideLabel prop
// ---------------------------------------------------------------------------

describe('FieldControl T-0450 Fix 2 · hideLabel default=false (backward-compat)', () => {
  it('text field: default (no hideLabel) → has <label> and .chs-field wrapper', () => {
    const tree = FieldControl({
      field: { key: 'name', label: 'Имя', type: 'string', required: false },
      value: '',
      onChange: noop,
    });
    const labels = findByType(tree, 'label');
    expect(labels.length).toBeGreaterThan(0); // label present
    // Root element is a wrapper div
    expect(tree.type).toBe('div');
    // Has .chs-field class
    expect(hasClass(tree, 'chs-field')).toBe(true);
  });

  it('select field: default → has <label>', () => {
    const tree = FieldControl({
      field: { key: 'status', label: 'Статус', type: 'select', required: false, options: ['a', 'b'] },
      value: '',
      onChange: noop,
    });
    const labels = findByType(tree, 'label');
    expect(labels.length).toBeGreaterThan(0);
  });

  it('checkbox field: default → has <label> wrapping the checkbox', () => {
    const tree = FieldControl({
      field: { key: 'active', label: 'Активен', type: 'boolean', required: false },
      value: false,
      onChange: noop,
    });
    const labels = findByType(tree, 'label');
    expect(labels.length).toBeGreaterThan(0);
  });

  it('number field: default → has <label>', () => {
    const tree = FieldControl({
      field: { key: 'qty', label: 'Количество', type: 'integer', required: false },
      value: '',
      onChange: noop,
    });
    const labels = findByType(tree, 'label');
    expect(labels.length).toBeGreaterThan(0);
  });

  it('date field: default → has <label>', () => {
    const tree = FieldControl({
      field: { key: 'due', label: 'Дата', type: 'date', required: false },
      value: '',
      onChange: noop,
    });
    const labels = findByType(tree, 'label');
    expect(labels.length).toBeGreaterThan(0);
  });
});

describe('FieldControl T-0450 Fix 2 · hideLabel=true → bare control, no label', () => {
  it('text field: hideLabel=true → NO <label>, input control present', () => {
    const tree = FieldControl({
      field: { key: 'name', label: 'Имя', type: 'string', required: false },
      value: '',
      onChange: noop,
      hideLabel: true,
    });
    const labels = findByType(tree, 'label');
    expect(labels).toHaveLength(0); // no label
    // Control is present: input element
    const inputs = findByType(tree, 'input');
    expect(inputs.length).toBeGreaterThan(0);
    // No .chs-field wrapper div at top level (no margin wrapping)
    expect(tree.type).not.toBe('div'); // bare fragment / React.Fragment or direct control
  });

  it('select/enum field: hideLabel=true → NO <label>, <select> present with options', () => {
    const tree = FieldControl({
      field: { key: 'status', label: 'Статус', type: 'select', required: true, options: ['new', 'done'] },
      value: '',
      onChange: noop,
      hideLabel: true,
    });
    const labels = findByType(tree, 'label');
    expect(labels).toHaveLength(0); // no label
    const selects = findByType(tree, 'select');
    expect(selects.length).toBeGreaterThan(0); // select control present
    // The select should have option children from the options array
    const allOptions = findByType(tree, 'option');
    // At minimum: the «— выберите —» placeholder + 2 options
    expect(allOptions.length).toBeGreaterThanOrEqual(3);
    // Verify 'new' and 'done' appear as option values
    const optionValues = allOptions.map((o) => o.props?.value);
    expect(optionValues).toContain('new');
    expect(optionValues).toContain('done');
  });

  it('checkbox field: hideLabel=true → NO <label>, bare <input type=checkbox>', () => {
    const tree = FieldControl({
      field: { key: 'active', label: 'Активен', type: 'boolean', required: false },
      value: false,
      onChange: noop,
      hideLabel: true,
    });
    const labels = findByType(tree, 'label');
    expect(labels).toHaveLength(0); // no label
    const inputs = findByType(tree, 'input');
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs[0].props.type).toBe('checkbox');
  });

  it('number field: hideLabel=true → NO <label>, <input type=number> present', () => {
    const tree = FieldControl({
      field: { key: 'qty', label: 'Количество', type: 'integer', required: false },
      value: '',
      onChange: noop,
      hideLabel: true,
    });
    const labels = findByType(tree, 'label');
    expect(labels).toHaveLength(0);
    const inputs = findByType(tree, 'input');
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs[0].props.type).toBe('number');
  });

  it('date field: hideLabel=true → NO <label>, <input type=date> present', () => {
    const tree = FieldControl({
      field: { key: 'due', label: 'Дата', type: 'date', required: false },
      value: '',
      onChange: noop,
      hideLabel: true,
    });
    const labels = findByType(tree, 'label');
    expect(labels).toHaveLength(0);
    const inputs = findByType(tree, 'input');
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs[0].props.type).toBe('date');
  });

  it('error is still rendered even with hideLabel=true', () => {
    const tree = FieldControl({
      field: { key: 'name', label: 'Имя', type: 'string', required: true },
      value: '',
      onChange: noop,
      error: 'Обязательное поле',
      hideLabel: true,
    });
    // Error node is a <span> — find it by checking text content
    const spans = findByType(tree, 'span');
    const errorSpan = spans.find((s) => s.props?.children === 'Обязательное поле');
    expect(errorSpan).toBeDefined();
  });
});

describe('FieldControl T-0450 Fix 2 · backward-compatibility (existing callers unaffected)', () => {
  it('caller passes no hideLabel prop → default false → label present (no regression)', () => {
    // This simulates all existing callers of FieldControl that do NOT pass hideLabel.
    const treeText = FieldControl({
      field: { key: 'company', label: 'Компания', type: 'string', required: true },
      value: 'Acme',
      onChange: noop,
      // NO hideLabel prop → default false
    });
    const labels = findByType(treeText, 'label');
    expect(labels.length).toBeGreaterThan(0);

    const treeSelect = FieldControl({
      field: { key: 'stage', label: 'Стадия', type: 'select', options: ['lead', 'won'], required: false },
      value: 'lead',
      onChange: noop,
    });
    const selectLabels = findByType(treeSelect, 'label');
    expect(selectLabels.length).toBeGreaterThan(0);

    const treeBool = FieldControl({
      field: { key: 'done', label: 'Готово', type: 'boolean', required: false },
      value: false,
      onChange: noop,
    });
    const boolLabels = findByType(treeBool, 'label');
    expect(boolLabels.length).toBeGreaterThan(0);
  });

  it('hideLabel=false explicitly → same as default, label rendered', () => {
    const tree = FieldControl({
      field: { key: 'note', label: 'Заметка', type: 'string', required: false },
      value: '',
      onChange: noop,
      hideLabel: false,
    });
    const labels = findByType(tree, 'label');
    expect(labels.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// T-0404 [D7-9] — per-step field MODE enforcement in the renderer
//   hidden → not rendered; read-only → disabled; required-to-advance → required
// ---------------------------------------------------------------------------

import { resolveFieldMode } from './field-contract.js';

/** Collect all input/select/textarea controls from a returned tree. */
function findControls(tree) {
  return [
    ...findByType(tree, 'input'),
    ...findByType(tree, 'select'),
    ...findByType(tree, 'textarea'),
  ];
}

/** True iff the tree contains the required-asterisk marker span. */
function hasRequiredStar(tree) {
  const spans = findByType(tree, 'span');
  return spans.some((s) => {
    const c = s.props?.children;
    return c === '*' || (Array.isArray(c) && c.includes('*'));
  });
}

describe('resolveFieldMode (pure)', () => {
  it('absent mode → all flags false', () => {
    expect(resolveFieldMode({ key: 'x' })).toEqual({
      mode: undefined, hidden: false, readOnly: false, required: false,
    });
  });
  it('hidden mode → hidden flag', () => {
    expect(resolveFieldMode({ key: 'x', mode: 'hidden' }).hidden).toBe(true);
  });
  it('read-only mode → readOnly flag', () => {
    expect(resolveFieldMode({ key: 'x', mode: 'read-only' }).readOnly).toBe(true);
  });
  it('required-to-advance mode → required flag', () => {
    expect(resolveFieldMode({ key: 'x', mode: 'required-to-advance' }).required).toBe(true);
  });
  it('unknown mode → ignored (all flags false)', () => {
    const r = resolveFieldMode({ key: 'x', mode: 'bogus' });
    expect(r.hidden || r.readOnly || r.required).toBe(false);
  });
});

describe('FieldControl T-0404 · hidden mode → renders nothing', () => {
  for (const type of ['string', 'select', 'boolean', 'number', 'date']) {
    it(`${type} hidden → returns null`, () => {
      const tree = FieldControl({
        field: { key: 'k', label: 'L', type, mode: 'hidden', options: ['a', 'b'] },
        value: '',
        onChange: noop,
      });
      expect(tree).toBeNull();
    });
  }
});

describe('FieldControl T-0404 · read-only mode → control rendered disabled', () => {
  it('text read-only → input readOnly', () => {
    const tree = FieldControl({
      field: { key: 'k', label: 'L', type: 'string', mode: 'read-only' },
      value: 'v', onChange: noop,
    });
    const controls = findControls(tree);
    expect(controls.length).toBeGreaterThan(0);
    expect(controls[0].props.readOnly).toBe(true);
  });

  it('select read-only → select disabled', () => {
    const tree = FieldControl({
      field: { key: 'k', label: 'L', type: 'select', mode: 'read-only', options: ['a', 'b'] },
      value: 'a', onChange: noop,
    });
    const selects = findByType(tree, 'select');
    expect(selects[0].props.disabled).toBe(true);
  });

  it('checkbox read-only → checkbox disabled', () => {
    const tree = FieldControl({
      field: { key: 'k', label: 'L', type: 'boolean', mode: 'read-only' },
      value: true, onChange: noop,
    });
    const inputs = findByType(tree, 'input');
    expect(inputs[0].props.disabled).toBe(true);
  });

  it('number read-only → input readOnly', () => {
    const tree = FieldControl({
      field: { key: 'k', label: 'L', type: 'integer', mode: 'read-only' },
      value: '3', onChange: noop,
    });
    expect(findControls(tree)[0].props.readOnly).toBe(true);
  });

  it('date read-only → input readOnly', () => {
    const tree = FieldControl({
      field: { key: 'k', label: 'L', type: 'date', mode: 'read-only' },
      value: '2026-01-01', onChange: noop,
    });
    expect(findControls(tree)[0].props.readOnly).toBe(true);
  });
});

describe('FieldControl T-0404 · required-to-advance mode → marked required', () => {
  it('text required-to-advance → aria-required + asterisk', () => {
    const tree = FieldControl({
      field: { key: 'k', label: 'L', type: 'string', required: false, mode: 'required-to-advance' },
      value: '', onChange: noop,
    });
    const controls = findControls(tree);
    expect(controls[0].props['aria-required']).toBe(true);
    expect(hasRequiredStar(tree)).toBe(true);
  });

  it('select required-to-advance → aria-required', () => {
    const tree = FieldControl({
      field: { key: 'k', label: 'L', type: 'select', required: false, mode: 'required-to-advance', options: ['a'] },
      value: '', onChange: noop,
    });
    expect(findByType(tree, 'select')[0].props['aria-required']).toBe(true);
  });

  it('a plain field (no mode, required:false) is NOT marked required', () => {
    const tree = FieldControl({
      field: { key: 'k', label: 'L', type: 'string', required: false },
      value: '', onChange: noop,
    });
    expect(findControls(tree)[0].props['aria-required']).toBeUndefined();
    expect(hasRequiredStar(tree)).toBe(false);
  });
});
