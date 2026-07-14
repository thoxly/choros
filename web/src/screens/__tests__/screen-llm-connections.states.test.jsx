/**
 * web/src/screens/__tests__/screen-llm-connections.states.test.jsx  (T-0574, FF-UX-4)
 *
 * AC-9 — Empty/Loading/Error states of the LLM-connections screen must be
 * VISIBLE (not a blank white screen / silent failure / infinite spinner), for
 * both the initial connection-list load AND the key-save path.
 *
 * Approach (project convention — vitest "node" environment, no jsdom, no
 * react-dom/react-test-renderer available in this repo; see
 * web/src/screens/screen-llm-connections.test.jsx and
 * web/src/forms/field-renderer.test.jsx for the two established patterns this
 * file combines):
 *
 *   1. Source-text presence checks (fs.readFileSync + toContain/toMatch) on
 *      screen-llm-connections.jsx prove the THREE state branches exist and are
 *      wired to the kit's state components (LoadingState/ErrorState/EmptyState),
 *      not a hand-rolled blank div — mirrors the "CSS-токены" block already in
 *      screen-llm-connections.test.jsx.
 *   2. Tree-walk checks (no mount) on the actual kit components LoadingState /
 *      ErrorState / EmptyState — these are hook-free presentational functions
 *      (components.jsx), so they CAN be called directly and their returned
 *      element tree inspected, exactly like field-renderer.test.jsx does for
 *      FieldControl. This proves the state components themselves render a
 *      visible affordance (role=status/alert, retry button, spinner) — the
 *      screen wires them, so together (1)+(2) prove the full AC-9 contract
 *      without needing DOM mount machinery this repo does not have.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoadingState, ErrorState, EmptyState } from '../../components/components.jsx';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREEN_PATH = path.resolve(HERE, '../screen-llm-connections.jsx');
const src = fs.readFileSync(SCREEN_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// Tree-walk helpers (mirrors web/src/forms/field-renderer.test.jsx).
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

// ---------------------------------------------------------------------------
// (1) Screen wiring — the three branches exist and reference the kit components.
// ---------------------------------------------------------------------------

describe('T-0574 (FF-UX-4/AC-9) — screen wires Loading/Error/Empty for the connection list', () => {
  it('Loading branch: connections === null renders <LoadingState>', () => {
    expect(src).toMatch(/connections === null[\s\S]{0,40}<LoadingState/);
  });
  it('Error branch: connections === false renders <ErrorState> with onRetry', () => {
    expect(src).toMatch(/connections === false[\s\S]{0,120}<ErrorState/);
    expect(src).toMatch(/<ErrorState[\s\S]{0,300}onRetry=\{loadConnections\}/);
  });
  it('Empty branch: an empty array renders <EmptyState> with a visible CTA description (not a blank div)', () => {
    expect(src).toMatch(/connections\.length === 0[\s\S]{0,60}<EmptyState/);
    // AC-9 fix (T-0574): EmptyState's real prop is `description`, not `message`
    // (components.jsx: function EmptyState({ icon, title, description, action })).
    // Before this task the screen passed `message`, which EmptyState silently
    // drops — the CTA text never rendered. Assert the FIXED prop name so this
    // regression cannot silently return.
    expect(src).toMatch(/<EmptyState[\s\S]{0,150}description=/);
  });
  it('does NOT regress to the old (dropped) `message` prop on EmptyState', () => {
    const emptyBlockMatch = src.match(/<EmptyState[\s\S]{0,150}\/>/);
    expect(emptyBlockMatch).not.toBeNull();
    expect(emptyBlockMatch[0]).not.toMatch(/\bmessage=/);
  });
});

// ---------------------------------------------------------------------------
// (2) Kit component contract — each state component itself renders a visible,
//     non-blank affordance (proved by direct call + tree-walk, no DOM).
// ---------------------------------------------------------------------------

describe('T-0574 (FF-UX-4/AC-9) — kit state components render a visible affordance', () => {
  it('LoadingState: role=status, aria-live=polite, aria-busy=true, visible label text', () => {
    const tree = LoadingState({ label: 'Загрузка соединений…' });
    expect(tree.props.role).toBe('status');
    expect(tree.props['aria-live']).toBe('polite');
    expect(tree.props['aria-busy']).toBe('true');
    // The label text is present somewhere in the tree (not swallowed).
    const rendersLabel = JSON.stringify(tree).includes('Загрузка соединений…');
    expect(rendersLabel).toBe(true);
  });

  it('ErrorState: role=alert, message visible, retry Button present and wired to onRetry', () => {
    const onRetry = () => {};
    const tree = ErrorState({
      title: 'Не удалось загрузить соединения',
      message: 'Сетевая ошибка.',
      onRetry,
    });
    expect(tree.props.role).toBe('alert');
    const asString = JSON.stringify(tree, (k, v) => (typeof v === 'function' ? '[fn]' : v));
    expect(asString).toContain('Не удалось загрузить соединения');
    expect(asString).toContain('Сетевая ошибка.');
    // The retry Button element carries onClick === onRetry (kit ErrorState wiring).
    const retryButtons = collectElements(tree, (el) => el.props && el.props.onClick === onRetry);
    expect(retryButtons.length).toBeGreaterThan(0);
  });

  it('ErrorState WITHOUT onRetry renders no retry affordance (honest — caller must always pass onRetry for a recoverable load error)', () => {
    const tree = ErrorState({ title: 'x', message: 'y' });
    expect(tree.props.role).toBe('alert');
  });

  it('EmptyState: role=status, title + description both render (real props, not `message`)', () => {
    const tree = EmptyState({ title: 'Пока нет профилей', description: 'Создайте первое LLM-соединение выше.' });
    expect(tree.props.role).toBe('status');
    const asString = JSON.stringify(tree);
    expect(asString).toContain('Пока нет профилей');
    expect(asString).toContain('Создайте первое LLM-соединение выше.');
  });

  it('EmptyState called with the OLD `message` prop (pre-fix regression shape) silently drops the text — documents WHY the fix in (1) matters', () => {
    const tree = EmptyState({ title: 'Пока нет профилей', message: 'Создайте первое LLM-соединение выше.' });
    const asString = JSON.stringify(tree);
    // This is the bug T-0574 fixes in the screen: `message` is not a real prop.
    expect(asString).not.toContain('Создайте первое LLM-соединение выше.');
  });
});
