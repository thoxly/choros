/**
 * web/src/forms/form-document-ops.test.js  (T-0481 · E-FORMS F2)
 *
 * Tests the pure mutation ops the drag-n-drop editor drives the document with.
 * Verifies: ops are immutable (input untouched), preserve bindings, and handle
 * nested containers (columns/tabs).
 */

import { describe, it, expect } from 'vitest';
import {
  insertNode, removeNode, reorderNode, updateNode, moveNodeAcross, nodeAtPath,
} from './form-document-ops.js';
import { childrenOf } from './form-document.js';

function baseDoc() {
  return {
    schemaVersion: 1, source: {},
    root: { type: 'section', children: [
      { type: 'field', fieldKey: 'a', widget: 'text' },
      { type: 'columns', count: 2, children: [
        { type: 'field', fieldKey: 'b', widget: 'text' },
        { type: 'field', fieldKey: 'c', widget: 'text' },
      ] },
      { type: 'tabs', tabs: [
        { title: 'T1', children: [{ type: 'field', fieldKey: 'd', widget: 'text' }] },
        { title: 'T2', children: [] },
      ] },
    ] },
  };
}

describe('insertNode', () => {
  it('appends at the end of the root by default and does not mutate input', () => {
    const doc = baseDoc();
    const frozen = JSON.stringify(doc);
    const next = insertNode(doc, [], { type: 'divider' });
    expect(JSON.stringify(doc)).toBe(frozen); // input untouched
    const kids = childrenOf(next.root);
    expect(kids[kids.length - 1].type).toBe('divider');
  });

  it('inserts at a given index', () => {
    const next = insertNode(baseDoc(), [], { type: 'divider' }, 1);
    expect(childrenOf(next.root)[1].type).toBe('divider');
  });

  it('inserts into a nested columns container', () => {
    const next = insertNode(baseDoc(), [1], { type: 'field', fieldKey: 'x', widget: 'text' });
    const cols = nodeAtPath(next, [1]);
    expect(childrenOf(cols).map((n) => n.fieldKey)).toEqual(['b', 'c', 'x']);
  });

  it('inserts into a specific tab of a tabs node', () => {
    const next = insertNode(baseDoc(), [2], { type: 'field', fieldKey: 'y', widget: 'text' }, undefined, 1);
    const tabs = nodeAtPath(next, [2]);
    expect(tabs.tabs[1].children.map((n) => n.fieldKey)).toEqual(['y']);
    expect(tabs.tabs[0].children.map((n) => n.fieldKey)).toEqual(['d']); // other tab untouched
  });
});

describe('removeNode', () => {
  it('removes the child at index without mutating input', () => {
    const doc = baseDoc();
    const frozen = JSON.stringify(doc);
    const next = removeNode(doc, [], 0);
    expect(JSON.stringify(doc)).toBe(frozen);
    expect(childrenOf(next.root)[0].type).toBe('columns');
  });
});

describe('reorderNode', () => {
  it('moves a child within the same container', () => {
    const next = reorderNode(baseDoc(), [], 0, 2);
    expect(childrenOf(next.root).map((n) => n.type)).toEqual(['columns', 'tabs', 'field']);
  });

  it('preserves the binding (key) of the moved node', () => {
    const next = reorderNode(baseDoc(), [1], 0, 1); // swap b/c inside columns
    const cols = nodeAtPath(next, [1]);
    expect(childrenOf(cols).map((n) => n.fieldKey)).toEqual(['c', 'b']);
  });
});

describe('updateNode', () => {
  it('merges a patch (label/widget) without changing fieldKey', () => {
    const next = updateNode(baseDoc(), [], 0, { label: 'Имя', widget: 'textarea' });
    const node = childrenOf(next.root)[0];
    expect(node.label).toBe('Имя');
    expect(node.widget).toBe('textarea');
    expect(node.fieldKey).toBe('a'); // binding intact
  });
});

describe('moveNodeAcross', () => {
  it('moves a node from one container to another (binding carried verbatim)', () => {
    // move field 'a' (root[0]) into the columns container (root[1])
    const next = moveNodeAcross(baseDoc(), [], 0, [1], 0);
    expect(childrenOf(next.root).map((n) => n.type)).toEqual(['columns', 'tabs']);
    const cols = nodeAtPath(next, [0]); // columns is now root[0]
    expect(childrenOf(cols).map((n) => n.fieldKey)).toEqual(['a', 'b', 'c']);
  });
});

describe('nodeAtPath', () => {
  it('resolves nested + tab-qualified paths', () => {
    const doc = baseDoc();
    expect(nodeAtPath(doc, []).type).toBe('section');
    expect(nodeAtPath(doc, [0]).fieldKey).toBe('a');
    expect(nodeAtPath(doc, [1, 0]).fieldKey).toBe('b');
    expect(nodeAtPath(doc, [2, { tab: 0, index: 0 }]).fieldKey).toBe('d');
  });
});
