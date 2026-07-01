/**
 * web/src/screens/apps-publish-dialog.test.jsx  (T-0563)
 *
 * Tests the presentational pieces of the «Опубликовать решение» dialog by
 * tree-walking rendered React elements (project convention: vitest "node" env,
 * no DOM — see screen-reports.test.jsx). The hookless PreviewList / ResultList
 * are exported precisely so they can be exercised as pure functions here.
 *
 * Covers:
 *   - preview → dialog list: every item labelled, "будет опубликовано" vs
 *     "уже опубликовано" badges reflect will_publish.
 *   - confirm → publish → per-item result render: ✓ items and ✗ items with the
 *     failing reason text present.
 */

import { describe, it, expect } from 'vitest';
import { PreviewList, ResultList } from './apps-publish-dialog.jsx';

// Recursively collect all string/number text from a React element tree.
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const c of node) collectText(c, out);
    return out;
  }
  if (typeof node === 'object' && node.props) {
    collectText(node.props.children, out);
  }
  return out;
}

const text = (el) => collectText(el).join(' ');

describe('PreviewList — confirm list rendering', () => {
  const items = [
    { kind: 'application', id: 'app-1', name: 'Закупки', tier: 'draft', will_publish: true },
    { kind: 'application', id: 'reg-1', name: 'Поставщики', tier: 'published', will_publish: false },
    { kind: 'process', id: 'proc-1', name: 'Согласование', tier: 'draft', will_publish: true },
    { kind: 'form', id: 'form-1', name: 'Проверка', tier: 'draft', will_publish: true },
  ];

  it('labels every item with its kind and name', () => {
    const t = text(PreviewList({ items }));
    expect(t).toContain('приложение «Закупки»');
    expect(t).toContain('приложение «Поставщики»');
    expect(t).toContain('процесс «Согласование»');
    expect(t).toContain('форма шага «Проверка»');
  });

  it('marks to-publish items and de-emphasizes already-live ones', () => {
    const t = text(PreviewList({ items }));
    expect(t).toContain('будет опубликовано');
    expect(t).toContain('уже опубликовано');
  });
});

describe('ResultList — per-item results rendering', () => {
  it('all-ok: shows each item, no error text', () => {
    const results = [
      { kind: 'application', id: 'app-1', name: 'Закупки', ok: true, error: null },
      { kind: 'process', id: 'proc-1', name: 'Согласование', ok: true, error: null },
    ];
    const t = text(ResultList({ results }));
    // kind label + name present (rendered as adjacent nodes, hence collected separately).
    expect(t).toContain('приложение');
    expect(t).toContain('Закупки');
    expect(t).toContain('процесс');
    expect(t).toContain('Согласование');
    expect(t).not.toContain('BPMN'); // no error text on an all-ok render
  });

  it('partial-fail: surfaces the failing item AND its reason', () => {
    const results = [
      { kind: 'application', id: 'app-1', name: 'Закупки', ok: true, error: null },
      { kind: 'process', id: 'proc-1', name: 'Согласование', ok: false, error: 'BPMN невалиден' },
    ];
    const t = text(ResultList({ results }));
    expect(t).toContain('процесс');
    expect(t).toContain('Согласование');
    expect(t).toContain('BPMN невалиден'); // the honest reason is shown
  });
});
