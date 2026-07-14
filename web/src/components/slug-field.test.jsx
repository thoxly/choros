/**
 * web/src/components/slug-field.test.jsx — T-0650 [W4-UX §7]
 *
 * Covers:
 *   1. previewSlugFromName / transliterate (pure logic) — Cyrillic→latin,
 *      grammar-compliant, empty → "" (SlugField shows the generic hint instead).
 *   2. SlugField (component, hook-free — plain-function invocation, mirrors
 *      field-renderer.test.jsx / actor-chip.test.jsx's established pattern):
 *      - untouched: renders the live preview text + "изменить" button, no input.
 *      - touched: renders a normal <Field> (Slug), value is what the parent passed.
 *      - locked: renders <MonoId> with the final slug, no input, no button.
 *      - manual edit does NOT re-derive from `name` (dirty semantics owned by parent
 *        via the `touched` prop — this test proves the RENDER contract: touched=true
 *        always shows the controlled `value`, ignoring `name`).
 */

import { describe, it, expect } from 'vitest';
import { SlugField } from './slug-field.jsx';
import { Field, MonoId, Button } from './components.jsx';
import { previewSlugFromName, transliterate, SLUG_FIELD_RE } from './slug-field-logic.js';

// ---------------------------------------------------------------------------
// Tree-walk helpers (mirrors actor-chip.test.jsx / field-renderer.test.jsx)
// ---------------------------------------------------------------------------

// Field uses useId() internally (real hook) — it cannot be invoked as a plain
// function outside a React tree (mirrors the RecordRef exclusion in
// actor-chip.test.jsx). Stop descending AT the Field/MonoId/Button boundary:
// we assert on their PROPS (what SlugField passed them), not their own
// rendered internals.
const HOOK_USING_OR_LEAF_TYPES = new Set([Field]);

function collectElements(node, predicate, results = []) {
  if (node === null || node === undefined) return results;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, results);
    return results;
  }
  if (typeof node !== 'object' || !node.type) return results;
  if (predicate(node)) results.push(node);
  if (typeof node.type === 'function' && !HOOK_USING_OR_LEAF_TYPES.has(node.type)) {
    collectElements(node.type(node.props || {}), predicate, results);
    return results;
  }
  const { children } = node.props || {};
  if (children !== undefined) collectElements(children, predicate, results);
  return results;
}

function findByType(tree, type) {
  return collectElements(tree, (el) => el.type === type);
}

function flattenText(node, acc = []) {
  if (node === null || node === undefined || node === false) return acc;
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    for (const child of node) flattenText(child, acc);
    return acc;
  }
  if (typeof node === 'object' && node.type) {
    if (typeof node.type === 'function' && !HOOK_USING_OR_LEAF_TYPES.has(node.type)) {
      flattenText(node.type(node.props || {}), acc);
      return acc;
    }
    if (HOOK_USING_OR_LEAF_TYPES.has(node.type)) return acc; // do not descend (see above)
    flattenText(node.props && node.props.children, acc);
  }
  return acc;
}

const noop = () => {};

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe('previewSlugFromName / transliterate (T-0650)', () => {
  it('transliterates a Cyrillic name to a compliant slug', () => {
    expect(previewSlugFromName('Тестовое приложение')).toBe('testovoe-prilozhenie');
  });

  it('handles a latin name', () => {
    expect(previewSlugFromName('Sales Team')).toBe('sales-team');
  });

  it('returns empty string (not a fallback word) for empty input', () => {
    // SlugField renders a distinct "will auto-generate" hint when preview is empty —
    // it does NOT show a fabricated word (that would look like a real preview).
    expect(previewSlugFromName('')).toBe('');
    expect(previewSlugFromName('   ')).toBe('');
  });

  it('every non-empty preview satisfies the canonical SLUG grammar', () => {
    const names = ['Тестовое приложение', 'Sales Team', 'Отдел №1', 'A'.repeat(200)];
    for (const n of names) {
      const preview = previewSlugFromName(n);
      expect(SLUG_FIELD_RE.test(preview)).toBe(true);
    }
  });

  it('transliterate maps individual Cyrillic letters', () => {
    expect(transliterate('щ')).toBe('sch');
    expect(transliterate('тест')).toBe('test');
  });
});

// ---------------------------------------------------------------------------
// SlugField component (hook-free — plain function invocation)
// ---------------------------------------------------------------------------

describe('SlugField (T-0650)', () => {
  it('untouched: shows a live preview mirrored from `name`, no text input', () => {
    const tree = SlugField({ name: 'Закупки оборудования', value: '', touched: false, onChange: noop, onTouch: noop });
    const text = flattenText(tree).join(' ');
    expect(text).toContain('zakupki-oborudovaniya');
    expect(text.toLowerCase()).toContain('изменить');
    expect(findByType(tree, Field).length).toBe(0);
    expect(findByType(tree, Button).length).toBe(1);
  });

  it('untouched + empty name: shows the generic auto-generate hint, not a fabricated slug', () => {
    const tree = SlugField({ name: '', value: '', touched: false, onChange: noop, onTouch: noop });
    const text = flattenText(tree).join(' ').toLowerCase();
    expect(text).toContain('автоматически');
    expect(findByType(tree, Field).length).toBe(0);
  });

  it('clicking "изменить" calls onTouch with the current preview (parent then seeds value + sets touched)', () => {
    let calledWith;
    const tree = SlugField({
      name: 'Отдел продаж', value: '', touched: false, onChange: noop,
      onTouch: (preview) => { calledWith = preview; },
    });
    const btn = findByType(tree, Button)[0];
    btn.props.onClick();
    expect(calledWith).toBe('otdel-prodazh');
  });

  it('touched: renders a normal mono <Field> bound to the controlled `value`', () => {
    const tree = SlugField({ name: 'Отдел продаж', value: 'custom-slug', touched: true, onChange: noop, onTouch: noop });
    const fields = findByType(tree, Field);
    expect(fields.length).toBe(1);
    expect(fields[0].props.value).toBe('custom-slug');
    expect(fields[0].props.mono).toBe(true);
  });

  it('touched: further edits to `name` do NOT affect the rendered value (dirty semantics)', () => {
    // Render contract check: with touched=true, the component reflects `value`
    // regardless of what `name` currently is — the parent is responsible for no
    // longer re-deriving from name once touched (this is exactly what "dirty" means).
    const tree = SlugField({ name: 'A totally different name now', value: 'otdel-prodazh', touched: true, onChange: noop, onTouch: noop });
    const fields = findByType(tree, Field);
    expect(fields[0].props.value).toBe('otdel-prodazh');
  });

  it('touched: onChange is wired to the Field onChange handler', () => {
    let receivedValue;
    const tree = SlugField({
      name: 'X', value: 'x', touched: true, onTouch: noop,
      onChange: (v) => { receivedValue = v; },
    });
    const field = findByType(tree, Field)[0];
    field.props.onChange({ target: { value: 'edited-slug' } });
    expect(receivedValue).toBe('edited-slug');
  });

  it('touched: shows a server-side error as the field hint', () => {
    const tree = SlugField({
      name: 'X', value: 'taken', touched: true, onChange: noop, onTouch: noop,
      error: 'Слаг уже занят в этом тенанте',
    });
    const field = findByType(tree, Field)[0];
    expect(field.props.invalid).toBe(true);
    expect(field.props.hint).toBe('Слаг уже занят в этом тенанте');
  });

  it('locked: renders MonoId with the final slug, no input, no button', () => {
    const tree = SlugField({ name: 'Отдел продаж', value: 'otdel-prodazh', locked: true, onChange: noop, onTouch: noop });
    expect(findByType(tree, MonoId).length).toBe(1);
    expect(findByType(tree, MonoId)[0].props.children).toBe('otdel-prodazh');
    expect(findByType(tree, Field).length).toBe(0);
    expect(findByType(tree, Button).length).toBe(0);
  });
});
