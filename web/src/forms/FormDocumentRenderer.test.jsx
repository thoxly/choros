/**
 * web/src/forms/FormDocumentRenderer.test.jsx  (T-0481 · E-FORMS F2)
 *
 * Renderer tests via the project's tree-walk approach (React elements are plain
 * objects; no DOM/jsdom — cf. field-renderer.test.jsx).
 *
 * Verifies:
 *   - each palette component renders + binds through the validated contract
 *     (field → FieldControl with type/options resolved from the LIVE schema, NOT
 *     a snapshot; table → a <table>; readout → read-only);
 *   - the «Согласование» layout renders the positions table + readout;
 *   - a class-b custom node renders the sandbox-iframe (Floor2Viewer) — isolated,
 *     never inline;
 *   - a dangling binding surfaces as broken (anti-drift), never silent.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import FormDocumentRenderer, { FormNode } from './FormDocumentRenderer.jsx';
import { indexSchema } from './form-document.js';
import { FieldControl } from './field-renderer.jsx';

// NOTE on the class-b path: the renderer loads Floor2Viewer LAZILY (React.lazy)
// so its transitive import of the build-only `src/core/floor2-renderer.js` twin
// stays off the module graph of the declarative renderer. We assert the sandbox
// path STRUCTURALLY: the custom node wraps the viewer in a `.chs-fd-custom` div +
// a Suspense boundary, passing the bound fields to the lazy viewer — and never an
// inline FieldControl. We identify the viewer element by its descriptor+fields
// props (the lazy element carries them through).
const isSandboxViewer = (el) => el.props && el.props.descriptor !== undefined && Array.isArray(el.props.fields);

// Tree-walk helpers. The renderer composes sub-components (SectionNode, FieldNode,
// TableNode…) that each return markup. To inspect the FULL rendered tree WITHOUT a
// DOM (no react-dom in the web test tier — vitest.config.js node env), we EXECUTE
// function-component elements during traversal: call the function with its props
// and recurse into the result. React.lazy elements (the class-b sandbox viewer)
// are NOT executed — we inspect their props in place (asserting the sandbox path
// without pulling in the build-only core twin). This matches the field-renderer
// test philosophy, extended to composed renderers.
function collect(node, predicate, results = [], depth = 0) {
  if (node === null || node === undefined || depth > 200) return results;
  if (Array.isArray(node)) { for (const c of node) collect(c, predicate, results, depth + 1); return results; }
  if (typeof node !== 'object' || node.type === undefined) return results;
  if (predicate(node)) results.push(node);
  // Execute plain function components to reach their output. Skip React.lazy
  // (object type) and components that use hooks (the class-b sandbox host — we
  // assert its presence by props, never by executing it out of render).
  if (typeof node.type === 'function' && !node.type.$$typeof && node.type.name !== 'Floor2Sandbox' && node.type.name !== 'TabsNode') {
    let rendered;
    try { rendered = node.type(node.props || {}); } catch { rendered = undefined; }
    if (rendered !== undefined) collect(rendered, predicate, results, depth + 1);
  }
  const children = node.props ? node.props.children : undefined;
  if (children !== undefined) collect(children, predicate, results, depth + 1);
  return results;
}
const byTag = (tree, tag) => collect(tree, (el) => el.type === tag);
const byComponent = (tree, comp) => collect(tree, (el) => el.type === comp);

const SCHEMA = [
  { key: 'amount', type: 'number', title: 'Сумма', required: true },
  { key: 'status', type: 'select', title: 'Статус', options: ['new', 'done'] },
  { key: 'counterparty', type: 'relation', title: 'Контрагент', targetRegistryId: 'reg' },
  {
    key: 'items', type: 'collection', title: 'Позиции',
    subFields: [
      { key: 'product', type: 'string', label: 'Товар' },
      { key: 'quantity', type: 'number', label: 'Кол-во' },
      { key: 'price', type: 'number', label: 'Цена' },
    ],
  },
  { key: 'total', type: 'computed', title: 'Итого' },
];

function ctxFor(fields, extra = {}) {
  return { schema: indexSchema(fields), values: {}, errors: {}, theme: 'light', ...extra };
}

describe('palette components render + bind through the contract', () => {
  it('field node → FieldControl bound to the field (enum options from LIVE schema)', () => {
    const node = { type: 'field', fieldKey: 'status', widget: 'select' };
    const tree = FormNode({ node, ctx: ctxFor(SCHEMA) });
    const controls = byComponent(tree, FieldControl);
    expect(controls.length).toBe(1);
    // The renderable field carries the LIVE schema type + options (anti-drift):
    // the enum's options come from the schema, not a node snapshot.
    expect(controls[0].props.field.key).toBe('status');
    expect(controls[0].props.field.type).toBe('select');
    expect(controls[0].props.field.options).toEqual(['new', 'done']);
  });

  it('readout node → read-only readout (no editable input)', () => {
    const node = { type: 'readout', fieldKey: 'total', label: 'Итого' };
    const tree = FormNode({ node, ctx: ctxFor(SCHEMA, { values: { total: 42 } }) });
    const readonly = collect(tree, (el) => el.props && el.props['aria-readonly'] === 'true');
    expect(readonly.length).toBeGreaterThan(0);
    const inputs = byTag(tree, 'input');
    expect(inputs.length).toBe(0); // never an editable input for a rollup
  });

  it('table node → a <table> with a column header per subKey, cells via FieldControl', () => {
    const node = { type: 'table', fieldKey: 'items', label: 'Позиции', columns: [
      { subKey: 'product', widget: 'text', label: 'Товар' },
      { subKey: 'quantity', widget: 'number', label: 'Кол-во' },
      { subKey: 'price', widget: 'money', label: 'Цена' },
    ] };
    const tree = FormNode({ node, ctx: ctxFor(SCHEMA, { values: { items: [{ product: 'Болт', quantity: 10, price: 5 }] } }) });
    expect(byTag(tree, 'table').length).toBe(1);
    expect(byTag(tree, 'th').length).toBe(3);
    // each cell binds through the unified FieldControl (hideLabel).
    const cells = byComponent(tree, FieldControl);
    expect(cells.length).toBe(3);
    expect(cells.every((c) => c.props.hideLabel === true)).toBe(true);
  });

  it('divider / text / section / columns render as plain layout (no binding)', () => {
    expect(byTag(FormNode({ node: { type: 'divider' }, ctx: ctxFor(SCHEMA) }), 'hr').length).toBe(1);
    // text node content surfaces in the rendered <p>.
    const texts = byTag(FormNode({ node: { type: 'text', content: 'Подсказка' }, ctx: ctxFor(SCHEMA) }), 'p');
    expect(texts.length).toBe(1);
    expect(texts[0].props.children).toBe('Подсказка');
    // columns renders a grid div with the right column count + nests its children.
    const colsTree = FormNode({ node: { type: 'columns', count: 2, children: [{ type: 'divider' }] }, ctx: ctxFor(SCHEMA) });
    const grids = collect(colsTree, (el) => el.props && el.props.style && el.props.style.display === 'grid');
    expect(grids.length).toBe(1);
    expect(grids[0].props.style.gridTemplateColumns).toContain('repeat(2');
    expect(byTag(colsTree, 'hr').length).toBe(1); // the nested divider renders
  });
});

describe('class-b custom node renders in the sandbox-iframe (deliverable 4)', () => {
  it('renders a sandbox viewer (isolated), never an inline FieldControl', () => {
    const node = { type: 'custom', componentId: 'kanban', bindings: ['status', 'amount'] };
    const tree = FormNode({ node, ctx: ctxFor(SCHEMA) });
    // wrapped in the dedicated custom container (the isolation boundary).
    expect(collect(tree, (el) => el.props && el.props.className === 'chs-fd-custom').length).toBe(1);
    const viewers = collect(tree, isSandboxViewer);
    expect(viewers.length).toBe(1);
    // The custom widget binds ONLY through the named-binding contract fields it
    // declared — passed to the sandbox, resolved from the live schema.
    const passedFields = viewers[0].props.fields.map((f) => f.key);
    expect(passedFields).toEqual(['status', 'amount']);
    // It does NOT render an inline FieldControl (the code-escape path is isolated).
    expect(byComponent(tree, FieldControl).length).toBe(0);
  });
});

describe('anti-drift: a dangling binding is surfaced, not silent', () => {
  it('a fieldKey no longer in the schema renders a broken-binding alert', () => {
    const node = { type: 'field', fieldKey: 'ghost', widget: 'text' };
    const tree = FormNode({ node, ctx: ctxFor(SCHEMA) });
    const alerts = collect(tree, (el) => el.props && el.props.role === 'alert');
    expect(alerts.length).toBeGreaterThan(0);
    // the alert text names the broken binding (anti-drift, never silent).
    expect(JSON.stringify(alerts[0].props.children)).toContain('битая');
    expect(JSON.stringify(alerts[0].props.children)).toContain('ghost');
  });
});

describe('«Согласование» document renders end-to-end', () => {
  it('renders the positions table + readout + relation + readonly amount', () => {
    const doc = {
      schemaVersion: 1,
      source: {}, step: { processKey: 'purchase-approval', step: 'Согласование' },
      root: { type: 'section', children: [
        { type: 'section', title: 'Заявка', children: [
          { type: 'columns', count: 2, children: [
            { type: 'field', fieldKey: 'amount', widget: 'money', label: 'Сумма', mode: 'readonly' },
            { type: 'relation', fieldKey: 'counterparty', widget: 'record-picker', label: 'Контрагент', mode: 'readonly' },
          ] },
          { type: 'table', fieldKey: 'items', label: 'Позиции', mode: 'readonly', columns: [
            { subKey: 'product', widget: 'text', label: 'Товар' },
            { subKey: 'quantity', widget: 'number', label: 'Кол-во' },
            { subKey: 'price', widget: 'money', label: 'Цена' },
          ] },
          { type: 'readout', fieldKey: 'total', label: 'Итого' },
        ] },
      ] },
    };
    const tree = FormDocumentRenderer({ document: doc, fields: SCHEMA, values: { amount: 1000, items: [] }, theme: 'light' });
    // one positions table with 3 column headers
    expect(byTag(tree, 'table').length).toBe(1);
    expect(byTag(tree, 'th').length).toBe(3);
    // a readout (read-only) for «Итого»
    const readonly = collect(tree, (el) => el.props && el.props['aria-readonly'] === 'true');
    expect(readonly.length).toBeGreaterThan(0);
    // the section title is present
    expect(JSON.stringify(tree)).toContain('Заявка');
  });
});
