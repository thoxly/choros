/**
 * web/src/forms/form-document.test.js  (T-0481 · E-FORMS F2)
 *
 * Tests the load-bearing pure layer of the form-builder:
 *   - the VETTED PALETTE is a closed, validated set (not arbitrary code);
 *   - the authoring validator enforces the named-binding contract (R-4);
 *   - KEY_SET collects all three binding channels;
 *   - type→widget compatibility is enforced;
 *   - a class-b custom node is recognised + its bindings validated.
 */

import { describe, it, expect } from 'vitest';
import {
  PALETTE, paletteByGroup, isPaletteType, isClassBType,
  DECLARATIVE_NODE_TYPES, DATA_NODE_TYPES, isWidgetCompatible, defaultWidgetForType,
  nodeTypeForFieldType, buildDefaultDocument, nodeForField,
  keySet, hasCustomNode, validateDocument, brokenBindings, indexSchema,
} from './form-document.js';

// A representative live schema (parseRecordSchema shape) for the «Заявка» app:
// scalar amount, relation counterparty, collection items (positions), computed total.
const SCHEMA = [
  { key: 'amount', type: 'number', title: 'Сумма', required: true },
  { key: 'counterparty', type: 'relation', title: 'Контрагент', targetRegistryId: 'reg-x' },
  {
    key: 'items', type: 'collection', title: 'Позиции', required: false,
    subFields: [
      { key: 'product', type: 'string', label: 'Товар' },
      { key: 'quantity', type: 'number', label: 'Кол-во' },
      { key: 'price', type: 'number', label: 'Цена' },
    ],
  },
  { key: 'total', type: 'computed', title: 'Итого', rollupSource: 'items', rollupOp: 'sum' },
  { key: 'note', type: 'string', title: 'Комментарий' },
  { key: 'status', type: 'select', title: 'Статус', options: ['new', 'done'] },
];

describe('vetted palette (deliverable 1 — class-a, not arbitrary code)', () => {
  it('is a CLOSED enumerated set, each entry a validated descriptor', () => {
    // Every palette entry is a known building block with a declared type + class.
    for (const [key, entry] of Object.entries(PALETTE)) {
      expect(entry.type).toBe(key);
      expect(['a', 'b']).toContain(entry.floorClass);
      expect(typeof entry.label).toBe('string');
      expect(typeof entry.summary).toBe('string');
      expect(['layout', 'data', 'code']).toContain(entry.paletteGroup);
    }
  });

  it('contains the required blocks: field, table, readout, divider, relation, custom', () => {
    for (const t of ['field', 'table', 'readout', 'divider', 'relation', 'custom']) {
      expect(isPaletteType(t)).toBe(true);
    }
  });

  it('only `custom` is class-b (the code-escape); everything else is class-a vetted', () => {
    expect(isClassBType('custom')).toBe(true);
    for (const t of DECLARATIVE_NODE_TYPES) {
      expect(isClassBType(t)).toBe(false);
      expect(PALETTE[t].floorClass).toBe('a');
    }
  });

  it('an unknown/arbitrary node type is NOT in the palette (closed set)', () => {
    expect(isPaletteType('script')).toBe(false);
    expect(isPaletteType('iframe')).toBe(false);
    expect(isPaletteType('eval')).toBe(false);
  });

  it('groups the palette into layout / data / code', () => {
    const groups = paletteByGroup();
    expect(groups.layout.map((e) => e.type)).toEqual(expect.arrayContaining(['section', 'columns', 'tabs', 'divider', 'text']));
    expect(groups.data.map((e) => e.type)).toEqual(expect.arrayContaining(['field', 'table', 'readout', 'relation']));
    expect(groups.code.map((e) => e.type)).toEqual(['custom']);
  });
});

describe('type → widget compatibility (form-document-format §6)', () => {
  it('accepts compatible pairs and rejects incompatible ones', () => {
    expect(isWidgetCompatible('string', 'text')).toBe(true);
    expect(isWidgetCompatible('string', 'select')).toBe(true);
    expect(isWidgetCompatible('number', 'money')).toBe(true);
    expect(isWidgetCompatible('string', 'money')).toBe(false); // money on string → invalid (§6)
    expect(isWidgetCompatible('boolean', 'switch')).toBe(true);
    expect(isWidgetCompatible('relation', 'record-picker')).toBe(true);
    expect(isWidgetCompatible('relation', 'text')).toBe(false);
  });

  it('picks the right node type per field type', () => {
    expect(nodeTypeForFieldType('collection')).toBe('table');
    expect(nodeTypeForFieldType('computed')).toBe('readout');
    expect(nodeTypeForFieldType('relation')).toBe('relation');
    expect(nodeTypeForFieldType('string')).toBe('field');
    expect(defaultWidgetForType('number')).toBe('number');
  });
});

describe('named-binding KEY_SET (R-4 — three channels)', () => {
  it('collects primary fieldKeys, table subKeys, relation displayFields, custom bindings', () => {
    const doc = {
      schemaVersion: 1, source: {},
      root: { type: 'section', children: [
        { type: 'field', fieldKey: 'amount', widget: 'number' },
        { type: 'relation', fieldKey: 'counterparty', widget: 'record-picker', displayField: 'name' },
        { type: 'table', fieldKey: 'items', columns: [{ subKey: 'product', widget: 'text' }, { subKey: 'price', widget: 'money' }] },
        { type: 'readout', fieldKey: 'total' },
        { type: 'custom', componentId: 'gantt', bindings: ['items'] },
      ] },
    };
    const ks = keySet(doc);
    expect([...ks.primary].sort()).toEqual(['amount', 'counterparty', 'items', 'total']);
    expect([...ks.subKeys].sort()).toEqual(['price', 'product']);
    expect([...ks.displayFields]).toEqual(['name']);
    expect([...ks.customBindings]).toEqual(['items']);
  });
});

describe('authoring validator (deliverable 3 — binding discipline)', () => {
  it('accepts a document whose bindings all exist in the live schema', () => {
    const doc = buildDefaultDocument({}, SCHEMA);
    const res = validateDocument(doc, SCHEMA);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('rejects a dangling fieldKey (R-4: not in live schema) → broken', () => {
    const doc = { schemaVersion: 1, source: {}, root: { type: 'section', children: [
      { type: 'field', fieldKey: 'ghost', widget: 'text' },
    ] } };
    const res = validateDocument(doc, SCHEMA);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'V-KEY')).toBe(true);
    expect(res.brokenKeys).toContain('ghost');
    expect(brokenBindings(doc, SCHEMA)).toContain('ghost');
  });

  it('rejects an incompatible widget (money on a string field)', () => {
    const doc = { schemaVersion: 1, source: {}, root: { type: 'section', children: [
      { type: 'field', fieldKey: 'note', widget: 'money' },
    ] } };
    const res = validateDocument(doc, SCHEMA);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'V-WIDGET')).toBe(true);
  });

  it('rejects a contract mismatch (table node bound to a scalar field)', () => {
    const doc = { schemaVersion: 1, source: {}, root: { type: 'section', children: [
      { type: 'table', fieldKey: 'amount', columns: [] },
    ] } };
    const res = validateDocument(doc, SCHEMA);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'V-CONTRACT')).toBe(true);
  });

  it('rejects a table column subKey not in the collection sub-schema', () => {
    const doc = { schemaVersion: 1, source: {}, root: { type: 'section', children: [
      { type: 'table', fieldKey: 'items', columns: [{ subKey: 'nonexistent', widget: 'text' }] },
    ] } };
    const res = validateDocument(doc, SCHEMA);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'V-SUBKEY')).toBe(true);
  });

  it('rejects an unknown node type (outside the palette)', () => {
    const doc = { schemaVersion: 1, source: {}, root: { type: 'section', children: [
      { type: 'script', src: 'evil()' },
    ] } };
    const res = validateDocument(doc, SCHEMA);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'V-NODE')).toBe(true);
  });
});

describe('class-b custom node (deliverable 4 — sandbox escape)', () => {
  it('recognises a custom node as a code signal', () => {
    const doc = { schemaVersion: 1, source: {}, root: { type: 'section', children: [
      { type: 'custom', componentId: 'kanban', bindings: ['status'] },
    ] } };
    expect(hasCustomNode(doc)).toBe(true);
  });

  it('a declarative-only document has no custom node', () => {
    expect(hasCustomNode(buildDefaultDocument({}, SCHEMA))).toBe(false);
  });

  it('validates a custom node: requires componentId and live bindings', () => {
    const ok = { schemaVersion: 1, source: {}, root: { type: 'section', children: [
      { type: 'custom', componentId: 'kanban', bindings: ['status'] },
    ] } };
    expect(validateDocument(ok, SCHEMA).ok).toBe(true);

    const noId = { schemaVersion: 1, source: {}, root: { type: 'section', children: [
      { type: 'custom', bindings: ['status'] },
    ] } };
    expect(validateDocument(noId, SCHEMA).errors.some((e) => e.code === 'V-CUSTOM')).toBe(true);

    const danglingBinding = { schemaVersion: 1, source: {}, root: { type: 'section', children: [
      { type: 'custom', componentId: 'kanban', bindings: ['ghost'] },
    ] } };
    const r = validateDocument(danglingBinding, SCHEMA);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'V-CUSTOM-KEY')).toBe(true);
  });
});

describe('indexSchema', () => {
  it('indexes top-level keys and collection sub-fields', () => {
    const { byKey, subByKey } = indexSchema(SCHEMA);
    expect(byKey.get('amount').type).toBe('number');
    expect(subByKey.get('items').get('price').type).toBe('number');
  });
});
