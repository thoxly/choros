/**
 * form-document-ops-t0544.test.js — the two builder-convenience ops (moveNode,
 * insertAt) added in T-0544. They are sugar over moveNodeAcross / insertNode, so
 * these tests confirm the path math (absolute paths) without re-testing the core.
 */
import { describe, it, expect } from 'vitest';
import { moveNode, insertAt, nodeAtPath } from './form-document-ops.js';
import { childrenOf } from './form-document.js';

function baseDoc() {
  return {
    schemaVersion: 1, source: {},
    root: { type: 'section', children: [
      { type: 'field', fieldKey: 'a' },
      { type: 'columns', count: 2, children: [
        { type: 'field', fieldKey: 'b' },
        { type: 'field', fieldKey: 'c' },
      ] },
      { type: 'tabs', tabs: [
        { title: 'T1', children: [{ type: 'field', fieldKey: 'd' }] },
        { title: 'T2', children: [] },
      ] },
    ] },
  };
}

describe('insertAt', () => {
  it('inserts at the required index', () => {
    const d = insertAt(baseDoc(), [], { type: 'divider' }, 1);
    expect(childrenOf(d.root).map((n) => n.type)).toEqual(['field', 'divider', 'columns', 'tabs']);
  });
  it('clamps an out-of-bounds index', () => {
    const d = insertAt(baseDoc(), [], { type: 'divider' }, 99);
    expect(childrenOf(d.root).at(-1).type).toBe('divider');
  });
  it('does not mutate the input', () => {
    const doc = baseDoc();
    const before = JSON.stringify(doc);
    insertAt(doc, [], { type: 'divider' }, 0);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('moveNode (absolute paths)', () => {
  it('moves a node from root into the columns container', () => {
    // move root[0] (field a) into columns (root[1]) at index 0. Removing root[0]
    // shifts columns to root[0]; moveNodeAcross adjusts the target path internally.
    const d = moveNode(baseDoc(), [0], [1, 0]);
    // 'a' is gone from root; columns is now first.
    expect(childrenOf(d.root).map((n) => n.type)).toEqual(['columns', 'tabs']);
    const cols = nodeAtPath(d, [0]);
    expect(cols.children.map((n) => n.fieldKey)).toEqual(['a', 'b', 'c']);
  });

  it('reorders within the same container via absolute paths', () => {
    const d = moveNode(baseDoc(), [1, 0], [1, 2]); // b → after c
    const cols = nodeAtPath(d, [1]);
    expect(cols.children.map((n) => n.fieldKey)).toEqual(['c', 'b']);
  });

  it('moves a node into a specific tab', () => {
    // move root[0] (field a) into tabs (root[2]) tab 1. After removal tabs → root[1].
    const d = moveNode(baseDoc(), [0], [2, { tab: 1, index: 0 }], undefined, 1);
    const tabs = nodeAtPath(d, [1]);
    expect(tabs.type).toBe('tabs');
    expect(tabs.tabs[1].children.map((n) => n.fieldKey)).toEqual(['a']);
  });

  it('preserves the binding verbatim on a cross-container move', () => {
    const d = moveNode(baseDoc(), [0], [1, 0]);
    const moved = nodeAtPath(d, [0]).children[0];
    expect(moved.fieldKey).toBe('a');
  });

  it('is a no-op on an empty path', () => {
    const doc = baseDoc();
    expect(moveNode(doc, [], [0])).toBe(doc);
  });
});
