/**
 * web/src/components/node-ref.test.jsx — T-0733 [R-1 из ревью T-0712, столп 4
 * анти-UUID] unit tests for NodeRef (components.jsx).
 *
 * Approach: NodeRef is a plain function component with no hooks — safe to
 * call directly and tree-walk without a DOM (mirrors actor-chip.test.jsx's
 * established pattern for ActorChip).
 *
 * Covers:
 *   1. resolved department/position → the human name is in the visible text,
 *      the raw id is NOT.
 *   2. an unresolved node (server's honest fallback: name === id === a UUID —
 *      deleted department/position, or a resolver miss) → the raw id is NEVER
 *      in the visible text; a legible kind-specific fallback label
 *      ("Отдел удалён"/"Должность удалена") stands in instead — never
 *      "undefined", never a bare UUID.
 *   3. the raw id stays reachable in the tooltip (title=) even when demoted.
 *   4. no id at all → main text never contains "undefined"/"null".
 *   5. an unknown kind falls back to a generic "Узел" label (defensive).
 */

import { describe, it, expect } from 'vitest';
import { NodeRef } from './components.jsx';

function textOf(node, acc = []) {
  if (node === null || node === undefined || node === false) return acc.join(' ');
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node));
    return acc.join(' ');
  }
  if (Array.isArray(node)) {
    for (const c of node) textOf(c, acc);
    return acc.join(' ');
  }
  if (typeof node === 'object' && node.props && node.props.children !== undefined) {
    textOf(node.props.children, acc);
  }
  return acc.join(' ');
}

// ---------------------------------------------------------------------------
// 1. resolved nodes — human name primary, id never in the visible text.
// ---------------------------------------------------------------------------

describe('NodeRef — T-0733 resolved department/position shows the name, not the id', () => {
  it('department: shows display_name in the main text, id only in tooltip', () => {
    const id = 'b0000000-0000-0000-0000-000000000001';
    const tree = NodeRef({ kind: 'department', name: 'Финансы', id });
    expect(textOf(tree)).toContain('Финансы');
    expect(textOf(tree)).not.toContain(id);
    expect(tree.props.title).toContain(id);
  });

  it('position: shows title in the main text, id only in tooltip', () => {
    const id = 'c0000000-0000-0000-0000-000000000001';
    const tree = NodeRef({ kind: 'position', name: 'Контролёр расчётов', id });
    expect(textOf(tree)).toContain('Контролёр расчётов');
    expect(textOf(tree)).not.toContain(id);
    expect(tree.props.title).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// 2. unresolved (deleted) node — honest fallback, never a bare UUID.
// ---------------------------------------------------------------------------

describe('NodeRef — T-0733 an UNRESOLVED node (deleted, or resolver miss) never surfaces the raw id', () => {
  const RAW_UUID = 'a1b2c3d4-0000-4000-8000-00000000abcd';

  it('department: name === id === UUID (server honest fallback) → UUID NOT in visible text; "Отдел удалён" shown instead', () => {
    const tree = NodeRef({ kind: 'department', name: RAW_UUID, id: RAW_UUID });
    expect(textOf(tree)).not.toContain(RAW_UUID);
    expect(textOf(tree)).toContain('Отдел удалён');
  });

  it('position: name === id === UUID → UUID NOT in visible text; "Должность удалена" shown instead', () => {
    const tree = NodeRef({ kind: 'position', name: RAW_UUID, id: RAW_UUID });
    expect(textOf(tree)).not.toContain(RAW_UUID);
    expect(textOf(tree)).toContain('Должность удалена');
  });

  it('the demoted UUID stays reachable in the tooltip (hidden, not erased)', () => {
    const tree = NodeRef({ kind: 'department', name: RAW_UUID, id: RAW_UUID });
    expect(tree.props.title).toContain(RAW_UUID);
  });

  it('carries the chs-noderef--unresolved visual marker (never colour/text-only)', () => {
    const tree = NodeRef({ kind: 'department', name: RAW_UUID, id: RAW_UUID });
    expect(tree.props.className).toContain('chs-noderef--unresolved');
  });

  it('a resolved (human-legible) name does NOT carry the unresolved marker', () => {
    const tree = NodeRef({ kind: 'department', name: 'Финансы', id: 'b0000000-0000-0000-0000-000000000001' });
    expect(tree.props.className).not.toContain('chs-noderef--unresolved');
  });
});

// ---------------------------------------------------------------------------
// 3. no id / no name at all — never "undefined"/"null".
// ---------------------------------------------------------------------------

describe('NodeRef — T-0733 missing id/name never renders "undefined"/"null"', () => {
  it('no id, no name → falls back to the kind\'s deleted-label, never literal undefined/null', () => {
    const tree = NodeRef({ kind: 'department' });
    expect(textOf(tree)).not.toContain('undefined');
    expect(textOf(tree)).not.toContain('null');
    expect(textOf(tree)).toContain('Отдел удалён');
  });
});

// ---------------------------------------------------------------------------
// 4. unknown kind — defensive generic fallback.
// ---------------------------------------------------------------------------

describe('NodeRef — T-0733 an unknown kind falls back to a generic "Узел" label', () => {
  it('kind absent/unrecognised → generic label, still no raw UUID leak', () => {
    const RAW_UUID = 'a1b2c3d4-0000-4000-8000-00000000abcd';
    const tree = NodeRef({ kind: undefined, name: RAW_UUID, id: RAW_UUID });
    expect(textOf(tree)).not.toContain(RAW_UUID);
    expect(textOf(tree)).toContain('Узел удалён');
  });
});
