/**
 * web/src/forms/form-document-soglasovanie.test.js  (T-0481 · E-FORMS F2)
 *
 * ACCEPTANCE CASE (deliverable 4): the «Согласование» step form =
 *   - a positions TABLE (line-items / collection),
 *   - fields in a CHOSEN ORDER,
 *   - an EXTRA element (a readout «Итого» + a divider),
 * all assembled FROM THE PALETTE, validated against the live schema, persisting
 * as a stable document.
 *
 * Plus the DRIVER-AGNOSTIC invariant (deliverable 2): the SAME layout assembled
 * by the human (palette ops) equals what the BOT emits from an intent.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDefaultDocument, nodeForField, validateDocument, keySet, childrenOf,
} from './form-document.js';
import { insertNode, reorderNode } from './form-document-ops.js';
import { emitFormDocument, validateEmitted } from './form-document-emit.js';

// The «Заявка» (purchase) live schema, as parseRecordSchema would yield it.
const SCHEMA = [
  { key: 'amount', type: 'number', title: 'Сумма', required: true },
  { key: 'counterparty', type: 'relation', title: 'Контрагент', targetRegistryId: 'reg-cp' },
  {
    key: 'items', type: 'collection', title: 'Позиции',
    subFields: [
      { key: 'product', type: 'string', label: 'Товар' },
      { key: 'quantity', type: 'number', label: 'Кол-во' },
      { key: 'price', type: 'number', label: 'Цена' },
    ],
  },
  { key: 'total', type: 'computed', title: 'Итого', rollupSource: 'items', rollupOp: 'sum' },
];

const SOURCE = { applicationId: '588fa343-0000-0000-0000-000000000001', registryDefId: '52bd9fdc-0000-0000-0000-000000000001' };
const STEP = { processKey: 'purchase-approval', step: 'Согласование' };

describe('«Согласование» — assemble from the palette (human driver)', () => {
  it('assembles a positions TABLE + fields in a chosen ORDER + an extra readout', () => {
    // Start from an empty step document, then add blocks from the palette in the
    // chosen order — exactly what the drag-n-drop editor does.
    let doc = { schemaVersion: 1, source: SOURCE, step: STEP, root: { type: 'section', children: [] } };

    const byKey = Object.fromEntries(SCHEMA.map((f) => [f.key, f]));
    // chosen order: Контрагент (relation), Сумма (field, money, readonly), divider,
    // Позиции (table), Итого (readout).
    doc = insertNode(doc, [], { ...nodeForField(byKey.counterparty, { mode: 'readonly' }) });
    doc = insertNode(doc, [], { ...nodeForField(byKey.amount, { mode: 'readonly' }), widget: 'money', label: 'Сумма' });
    doc = insertNode(doc, [], { type: 'divider' });                       // the EXTRA element
    doc = insertNode(doc, [], { ...nodeForField(byKey.items, { mode: 'readonly' }), label: 'Позиции' });
    doc = insertNode(doc, [], { ...nodeForField(byKey.total), label: 'Итого' }); // readout

    const kids = childrenOf(doc.root);
    expect(kids.map((n) => n.type)).toEqual(['relation', 'field', 'divider', 'table', 'readout']);

    // The table is a real line-items table with the three position columns.
    const table = kids.find((n) => n.type === 'table');
    expect(table.fieldKey).toBe('items');
    expect(table.columns.map((c) => c.subKey)).toEqual(['product', 'quantity', 'price']);

    // The readout is the rollup total, read-only.
    const readout = kids.find((n) => n.type === 'readout');
    expect(readout.fieldKey).toBe('total');

    // It VALIDATES against the live schema (binding discipline holds).
    const res = validateDocument(doc, SCHEMA);
    expect(res.ok).toBe(true);

    // KEY_SET only references live keys (no dangling binding).
    const ks = keySet(doc);
    const live = new Set(SCHEMA.map((f) => f.key));
    for (const k of ks.primary) expect(live.has(k)).toBe(true);
  });

  it('reordering fields keeps the binding intact (order changes, keys do not)', () => {
    let doc = { schemaVersion: 1, source: SOURCE, step: STEP, root: { type: 'section', children: [
      nodeForField(SCHEMA[0]), // amount
      nodeForField(SCHEMA[3]), // total
    ] } };
    const before = keySet(doc);
    doc = reorderNode(doc, [], 0, 1); // move amount after total
    expect(childrenOf(doc.root).map((n) => n.fieldKey)).toEqual(['total', 'amount']);
    const after = keySet(doc);
    expect([...after.primary].sort()).toEqual([...before.primary].sort()); // same keys
  });

  it('persists round-trip-safe (JSON serialisable + stable)', () => {
    let doc = { schemaVersion: 1, source: SOURCE, step: STEP, root: { type: 'section', children: [
      nodeForField(SCHEMA[2], { mode: 'readonly' }), // items table
      nodeForField(SCHEMA[3]),                       // total readout
    ] } };
    const json = JSON.stringify(doc);
    const restored = JSON.parse(json);
    expect(restored).toEqual(doc);
    expect(validateDocument(restored, SCHEMA).ok).toBe(true);
  });
});

describe('one contract, two drivers (deliverable 2 — driver-agnostic)', () => {
  it('the bot emits the SAME layout the human assembles for «Согласование»', () => {
    // Human: assemble via palette ops.
    const byKey = Object.fromEntries(SCHEMA.map((f) => [f.key, f]));
    let human = { schemaVersion: 1, source: SOURCE, step: STEP, root: { type: 'section', children: [] } };
    human = insertNode(human, [], { ...nodeForField(byKey.items, { mode: 'readonly' }), label: 'Позиции' });
    human = insertNode(human, [], { ...nodeForField(byKey.total), label: 'Итого' });

    // Bot: emit from a structured intent describing the SAME layout.
    const bot = emitFormDocument({
      source: SOURCE,
      step: STEP,
      layout: [
        { kind: 'table', fieldKey: 'items', mode: 'readonly', label: 'Позиции' },
        { kind: 'readout', fieldKey: 'total', label: 'Итого' },
      ],
    }, SCHEMA);

    // The two documents are byte-comparable (same shape, same bindings, same order).
    expect(bot).toEqual(human);
    expect(validateEmitted(bot, SCHEMA).ok).toBe(true);
  });

  it('the default document equals what the bot emits with no layout intent', () => {
    const human = buildDefaultDocument(SOURCE, SCHEMA);
    const bot = emitFormDocument({ source: SOURCE }, SCHEMA);
    expect(bot).toEqual(human);
  });

  it('the bot is held to the SAME validator: a dangling key is flagged, not dropped', () => {
    const bot = emitFormDocument({
      source: SOURCE,
      layout: [{ kind: 'field', fieldKey: 'ghost' }],
    }, SCHEMA);
    // The node is emitted (honest) but flagged broken by the shared validator.
    expect(childrenOf(bot.root).some((n) => n.fieldKey === 'ghost')).toBe(true);
    const res = validateEmitted(bot, SCHEMA);
    expect(res.ok).toBe(false);
    expect(res.brokenKeys).toContain('ghost');
  });
});
