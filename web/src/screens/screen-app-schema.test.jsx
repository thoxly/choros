/**
 * web/src/screens/screen-app-schema.test.jsx — T-0687 (capstone T-0647-B)
 *
 * Zone2/§2.6 finding (LIVE_PROOF): the first «Настроить поля» for an application
 * forced «+ Новый набор полей» — the operator had to name+create an empty
 * registry_def «набор полей» BEFORE they could add a single field, surfacing an
 * internal abstraction the spec said to hide. Fix: auto-open the create-editor
 * seeded with a default set («Основные поля») when the app has zero sets, so the
 * operator lands directly on the field list.
 *
 * BEHAVIORAL (mutational) tests for the pure idempotency decision
 * (shouldAutoOpenDefaultSet) — the guard that makes the auto path fire AT MOST
 * ONCE and NEVER plow a second default set — plus source-presence pins for the
 * screen wiring (the .jsx render/effect uses hooks, so it is pinned structurally,
 * same convention as screen-inbox.test.jsx).
 */

import { describe, it, expect } from 'vitest';
import {
  shouldAutoOpenDefaultSet,
  DEFAULT_FIELD_SET_NAME,
} from './screen-app-schema.jsx';

const fs = await import('fs');
const path = await import('path');
const src = fs.default.readFileSync(
  path.default.resolve(new URL(import.meta.url).pathname, '../screen-app-schema.jsx'),
  'utf-8',
);

describe('T-0687-B shouldAutoOpenDefaultSet — fires once, only when zero sets', () => {
  it('zero sets, editor closed, not yet auto-opened → TRUE (auto-open the default set)', () => {
    expect(shouldAutoOpenDefaultSet([], undefined, false)).toBe(true);
  });

  it('MUTATION (idempotency #1): already auto-opened → FALSE (never a second default set)', () => {
    expect(shouldAutoOpenDefaultSet([], undefined, true)).toBe(false);
  });

  it('MUTATION (idempotency #2): a set already exists → FALSE (never plows a duplicate «main»)', () => {
    const oneSet = [{ id: 'r1', slug: 'osnovnye-polya', display_name: 'Основные поля' }];
    expect(shouldAutoOpenDefaultSet(oneSet, undefined, false)).toBe(false);
  });

  it('still loading (defs === null) → FALSE (never act before the list is known)', () => {
    expect(shouldAutoOpenDefaultSet(null, undefined, false)).toBe(false);
  });

  it('editor already open (create) → FALSE (does not stomp an open editor)', () => {
    expect(shouldAutoOpenDefaultSet([], null, false)).toBe(false);
  });

  it('editor already open (edit an existing def) → FALSE', () => {
    expect(shouldAutoOpenDefaultSet([], { id: 'r1' }, false)).toBe(false);
  });

  it('a non-array defs value is treated as "not zero sets" → FALSE (defensive)', () => {
    expect(shouldAutoOpenDefaultSet({}, undefined, false)).toBe(false);
  });
});

describe('T-0687-B DEFAULT_FIELD_SET_NAME — human default, no machine slug forced', () => {
  it('is a human-readable Russian name (not "main" jargon shown to the user)', () => {
    expect(DEFAULT_FIELD_SET_NAME).toBe('Основные поля');
    // Not a bare latin slug/machine token in the operator's face.
    expect(DEFAULT_FIELD_SET_NAME).toMatch(/[А-Яа-яЁё]/);
  });
});

describe('T-0687-B screen wiring — auto-open seeds the editor, latched idempotently', () => {
  it('AppSchemaScreen guards the auto-open with shouldAutoOpenDefaultSet + an autoOpenedRef latch', () => {
    expect(src).toContain('shouldAutoOpenDefaultSet(defs, editing, autoOpenedRef.current)');
    // The latch is SET before opening — the guard that stops re-firing.
    expect(src).toMatch(/autoOpenedRef\.current = true;\s*\n\s*setAutoSeeding\(true\);\s*\n\s*setEditing\(null\)/);
  });

  it('the auto-seeded editor is passed defaultName={DEFAULT_FIELD_SET_NAME}; a manual open is not', () => {
    expect(src).toMatch(/defaultName=\{autoSeeding \? DEFAULT_FIELD_SET_NAME : undefined\}/);
  });

  it('MUTATION: the latch is reset only on appId change (fresh budget per app, not per render)', () => {
    // A useEffect keyed on [appId] resets autoOpenedRef — so navigating between
    // two empty apps auto-opens each, but a re-render of the same app does NOT.
    const idx = src.indexOf('autoOpenedRef.current = false;');
    expect(idx).toBeGreaterThan(-1);
    const after = src.slice(idx, idx + 160);
    expect(after).toMatch(/\}, \[appId\]\)/);
  });

  it('FieldEditor applies defaultName ONLY on create (editing a def keeps its stored name)', () => {
    // The create branch seeds display_name from defaultName; the edit branch does not.
    expect(src).toMatch(/editingDef\?\.display_name \|\| \(isEdit \? '' : \(defaultName \|\| ''\)\)/);
  });
});
