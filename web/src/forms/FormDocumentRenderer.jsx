/* ============================================================================
   CHOROS — FormDocumentRenderer.jsx  (T-0481 · E-FORMS F2)

   THE ONE RENDERER for a form-document.

   It walks the declarative tree (form-document.js) and renders each node
   deterministically. The SAME renderer draws a document produced by the human
   drag-n-drop editor (FormDesigner.jsx) OR emitted by a bot — there is one
   render path, not one per driver (deliverable 2).

   BINDING DISCIPLINE (deliverable 3): a data node carries ONLY a fieldKey (and
   table subKey / relation displayField). The renderer resolves the field's
   TYPE and OPTIONS from the LIVE schema view at render time (anti-snapshot-drift
   — the enum→text bug from D7 §2). A node NEVER carries the type/options snapshot,
   and NEVER reads or writes the process directly: scalar/enum/relation fields go
   through the unified FieldControl (field-renderer.jsx, the single contract
   renderer); the table draws child rows; the readout is read-only.

   CLASS-B (deliverable 4): a `custom` node renders in the sandbox-iframe via
   Floor2Viewer (T-0076/T-0101) — opaque origin, allow-scripts WITHOUT
   allow-same-origin. Its bindings are passed as the named-binding contract; the
   agent code draws bespoke markup but cannot reach the parent or the process.

   Theming: --chs-* tokens + .chs-* classes only (gate G2/G6). No hardcoded colors.
   ============================================================================ */

import React from 'react';
import { FieldControl } from './field-renderer.jsx';
import Floor2Sandbox from './Floor2Sandbox.jsx';
import {
  childrenOf, isDataNodeType, indexSchema, defaultWidgetForType,
} from './form-document.js';
import { getWidget, registerRender } from './widget-registry.js';

// The class-b (custom) node renders in Floor2Sandbox — the web-local
// sandbox-iframe host that reuses the T-0101 isolation contract (opaque origin,
// allow-scripts WITHOUT allow-same-origin, origin-validated height channel). It
// is intentionally NOT the src/core-coupled Floor2Viewer.jsx: web/** is not
// bundled with src/** (rollup cannot resolve the src/core/*.js twin), so coupling
// the declarative renderer to it would break the build (D-056). Floor2Sandbox is
// self-contained → the build stays integration-honest while the isolation
// mechanism is the same.

// ---------------------------------------------------------------------------
// Live-schema → renderable-field adapter
// ---------------------------------------------------------------------------

/**
 * Build the "renderable field" descriptor FieldControl expects from a document
 * node + the LIVE schema field. The TYPE and OPTIONS come from the schema (never
 * the node) — this is the anti-drift contract. The node contributes only the
 * presentation: label, widget→presentation, mode (subject to the per-step
 * override below).
 *
 * T-0665 (F6): `mode` prioritizes `schemaField.mode` — the SERVER-SIDE
 * per-step mode (T-0404, carried in form_binding.fields[].mode and already
 * enforced by the legacy FieldControl-per-row path's resolveFieldMode/
 * editableKeys submit-gate) — over the layout node's own authoring-time
 * `node.mode` (set by FormDesigner's Inspector "Режим" control). Without
 * this, a field the process author marked read-only/required/hidden AT THIS
 * STEP would render editable/optional/visible whenever the layout path was
 * used, even though the exact same binding renders it correctly via the
 * legacy per-row path — a real behavioral regression between the two render
 * paths for the SAME data, not merely a cosmetic gap. `node.mode` remains the
 * fallback for a field the schema does not otherwise constrain.
 *
 * T-0665 (F5 completeness): `recordId` passes through from schemaField (the
 * caller threads it onto file-contract entries in the `fields` array it
 * hands to FormDocumentRenderer, mirroring what the legacy per-row path
 * already does) — without it, FileField would silently lose its "which
 * record does this belong to" context under the layout render path only.
 */
function renderableField(node, schemaField) {
  // widget on the node maps to a presentation override; absent → schema default.
  const widget = node.widget || (schemaField ? defaultWidgetForType(schemaField.type) : undefined);
  const presentation = widgetToPresentation(widget);
  return {
    key: node.fieldKey,
    label: node.label || (schemaField && (schemaField.label || schemaField.title)) || node.fieldKey,
    required: Boolean(schemaField && schemaField.required),
    type: schemaField ? schemaField.type : 'string',
    options: schemaField && Array.isArray(schemaField.options) ? schemaField.options : undefined,
    presentation,
    // Per-step mode: schema (server-side, T-0404) wins; layout node is the fallback.
    mode: (schemaField && schemaField.mode) || nodeModeToFieldMode(node.mode),
    ...(schemaField && schemaField.recordId !== undefined ? { recordId: schemaField.recordId } : {}),
  };
}

/** Map a form-document widget to the field-renderer presentation vocabulary. */
function widgetToPresentation(widget) {
  switch (widget) {
    case 'textarea': return 'textarea';
    case 'number':
    case 'money': return 'number';
    case 'select': return 'select';
    case 'radio': return 'radio';
    case 'checkbox':
    case 'switch': return 'checkbox';
    case 'date':
    case 'date-range': return 'date';
    default: return undefined; // text / record-picker / table / readout resolved by contract
  }
}

/** Map a form-document node mode to the field-renderer mode vocabulary. */
function nodeModeToFieldMode(mode) {
  switch (mode) {
    case 'readonly': return 'read-only';
    case 'required': return 'required-to-advance';
    case 'hidden': return 'hidden';
    default: return undefined; // editable
  }
}

// ---------------------------------------------------------------------------
// Node renderers
// ---------------------------------------------------------------------------

function NodeList({ nodes, ctx }) {
  return (
    <>
      {nodes.map((child, i) => (
        <FormNode key={child.id || `${child.type}-${i}`} node={child} ctx={ctx} />
      ))}
    </>
  );
}

function SectionNode({ node, ctx }) {
  const kids = childrenOf(node);
  return (
    <section className="chs-fd-section" style={{ marginBottom: 'var(--chs-space-5)' }}>
      {node.title && (
        <h3 className="chs-fd-section__title" style={{ fontSize: 'var(--chs-text-md)', margin: '0 0 var(--chs-space-3)' }}>
          {node.title}
        </h3>
      )}
      <NodeList nodes={kids} ctx={ctx} />
    </section>
  );
}

function ColumnsNode({ node, ctx }) {
  const kids = childrenOf(node);
  const count = Math.max(2, Math.min(4, Number(node.count) || 2));
  return (
    <div
      className="chs-fd-columns"
      style={{ display: 'grid', gridTemplateColumns: `repeat(${count}, 1fr)`, gap: 'var(--chs-space-4)' }}
    >
      {kids.map((child, i) => (
        <div key={child.id || i} className="chs-fd-column">
          <FormNode node={child} ctx={ctx} />
        </div>
      ))}
    </div>
  );
}

function TabsNode({ node, ctx }) {
  const tabs = Array.isArray(node.tabs) ? node.tabs : [];
  const [active, setActive] = React.useState(0);
  return (
    <div className="chs-fd-tabs">
      <div className="chs-fd-tabs__bar" role="tablist" style={{ display: 'flex', gap: 'var(--chs-space-2)', marginBottom: 'var(--chs-space-3)' }}>
        {tabs.map((t, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={active === i}
            className={`chs-btn chs-btn--ghost${active === i ? ' chs-btn--active' : ''}`}
            onClick={() => setActive(i)}
          >
            {t.title || `Вкладка ${i + 1}`}
          </button>
        ))}
      </div>
      <div className="chs-fd-tabs__panel" role="tabpanel">
        <NodeList nodes={Array.isArray(tabs[active]?.children) ? tabs[active].children : []} ctx={ctx} />
      </div>
    </div>
  );
}

function DividerNode() {
  return <hr className="chs-fd-divider" style={{ border: 'none', borderTop: '1px solid var(--chs-color-border)', margin: 'var(--chs-space-4) 0' }} />;
}

function TextNode({ node }) {
  return (
    <p className="chs-fd-text" style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)', margin: '0 0 var(--chs-space-3)' }}>
      {node.content || ''}
    </p>
  );
}

function FieldNode({ node, ctx }) {
  const schemaField = ctx.schema.byKey.get(node.fieldKey);
  const field = renderableField(node, schemaField);
  if (!schemaField) {
    return <BrokenBinding fieldKey={node.fieldKey} />;
  }
  return (
    <FieldControl
      field={field}
      value={ctx.values ? ctx.values[node.fieldKey] : undefined}
      onChange={ctx.onChange || (() => {})}
      error={ctx.errors ? ctx.errors[node.fieldKey] : undefined}
    />
  );
}

function RelationNode({ node, ctx }) {
  const schemaField = ctx.schema.byKey.get(node.fieldKey);
  if (!schemaField) return <BrokenBinding fieldKey={node.fieldKey} />;
  // The relation field flows through the unified FieldControl as the `relation`
  // contract (record-picker). FieldControl degrades it honestly to a readout
  // until the record-picker editor lands (D7-6); the BINDING is intact regardless.
  const field = renderableField({ ...node, widget: 'record-picker' }, schemaField);
  field.type = 'relation';
  return (
    <FieldControl
      field={field}
      value={ctx.values ? ctx.values[node.fieldKey] : undefined}
      onChange={ctx.onChange || (() => {})}
      error={ctx.errors ? ctx.errors[node.fieldKey] : undefined}
    />
  );
}

function ReadoutNode({ node, ctx }) {
  const schemaField = ctx.schema.byKey.get(node.fieldKey);
  if (!schemaField) return <BrokenBinding fieldKey={node.fieldKey} />;
  const label = node.label || schemaField.label || schemaField.title || node.fieldKey;
  const raw = ctx.values ? ctx.values[node.fieldKey] : undefined;
  return (
    <div className="chs-fd-readout chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
      <label className="chs-label">{label}</label>
      <div className="chs-input" aria-readonly="true" style={{ display: 'block', width: '100%', boxSizing: 'border-box', fontWeight: 600 }}>
        {raw === undefined || raw === null || raw === '' ? '—' : String(raw)}
      </div>
    </div>
  );
}

/**
 * Table (line-items / collection) node. Renders a header from the columns and a
 * row per value, each cell through the unified FieldControl with hideLabel (the
 * <th> is the label). The collection field's child rows live in the live schema's
 * sub-schema; column subKeys are validated at authoring time (validateDocument).
 */
function TableNode({ node, ctx }) {
  const schemaField = ctx.schema.byKey.get(node.fieldKey);
  if (!schemaField) return <BrokenBinding fieldKey={node.fieldKey} />;
  const subMap = ctx.schema.subByKey.get(node.fieldKey) || new Map();
  const columns = Array.isArray(node.columns) ? node.columns : [];
  const label = node.label || schemaField.label || schemaField.title || node.fieldKey;
  const rows = Array.isArray(ctx.values && ctx.values[node.fieldKey]) ? ctx.values[node.fieldKey] : [];
  const readOnly = node.mode === 'readonly';

  return (
    <div className="chs-fd-table chs-field" style={{ marginBottom: 'var(--chs-space-5)' }}>
      <label className="chs-label">{label}</label>
      <table className="chs-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.subKey} className="chs-table__th" style={{ textAlign: 'left', padding: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)' }}>
                {col.label || (subMap.get(col.subKey) && (subMap.get(col.subKey).label || subMap.get(col.subKey).title)) || col.subKey}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="chs-table__td" colSpan={columns.length || 1} style={{ padding: 'var(--chs-space-3)', color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}>
                Нет позиций
              </td>
            </tr>
          ) : rows.map((row, ri) => (
            <tr key={ri}>
              {columns.map((col) => {
                const subField = subMap.get(col.subKey);
                const cellField = {
                  key: col.subKey,
                  label: col.label || col.subKey,
                  type: subField ? subField.type : 'string',
                  options: subField && Array.isArray(subField.options) ? subField.options : undefined,
                  presentation: widgetToPresentation(col.widget),
                  mode: readOnly ? 'read-only' : undefined,
                };
                return (
                  <td key={col.subKey} className="chs-table__td" style={{ padding: 'var(--chs-space-2)' }}>
                    <FieldControl
                      field={cellField}
                      value={row ? row[col.subKey] : undefined}
                      onChange={(k, v) => ctx.onTableCellChange && ctx.onTableCellChange(node.fieldKey, ri, k, v)}
                      hideLabel
                      idPrefix={`tbl-${node.fieldKey}-${ri}`}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CustomNode({ node, ctx }) {
  // Class-b escape — sandbox-iframe. Build the named-binding fields (WITH current
  // values) for the bindings the custom widget declares; the agent code in the
  // iframe presents over THAT contract only and cannot reach the parent / process
  // (ADR §4 invariant; T-0101 isolation). A binding the live schema lacks is
  // dropped (the widget cannot bind to a non-existent field).
  const bindings = Array.isArray(node.bindings) ? node.bindings : [];
  const fields = bindings
    .map((key) => {
      const sf = ctx.schema.byKey.get(key);
      if (!sf) return null;
      return {
        key, label: sf.label || sf.title || key, type: sf.type, options: sf.options,
        value: ctx.values ? ctx.values[key] : undefined,
      };
    })
    .filter(Boolean);
  const descriptor = {
    componentId: node.componentId,
    code: node.code,
    // governance opt-in (§9.10): the code mounts ONLY when explicitly flagged.
    flagged: node.flagged === true,
  };
  return (
    <div className="chs-fd-custom" data-component-id={node.componentId}>
      <Floor2Sandbox descriptor={descriptor} fields={fields} onError={ctx.onCustomError} />
    </div>
  );
}

function BrokenBinding({ fieldKey }) {
  // Anti-drift surfacing: a node bound to a key no longer in the live schema is
  // shown as broken (form-document-format §4) — never silently dropped.
  return (
    <div className="chs-fd-broken" role="alert" style={{ marginBottom: 'var(--chs-space-4)', padding: 'var(--chs-space-2)', border: '1px dashed var(--chs-color-danger)', color: 'var(--chs-color-danger)', fontSize: 'var(--chs-text-sm)' }}>
      Поле «{fieldKey}» больше нет в схеме — привязка битая.
    </div>
  );
}

// ---------------------------------------------------------------------------
// Registry-driven dispatch (T-0544)
//
// Each of the 10 node renderers above is ATTACHED to its widget descriptor as
// the descriptor's `render(node, ctx)`. FormNode no longer switches on
// node.type — it asks the ONE registry for the descriptor and calls its render.
// This is the behavioral no-op that turns the old `switch` into the registry:
// the SAME component bodies, dispatched via the registry instead of a switch.
// A new widget = one registry entry + its render attach, no edit here.
// ---------------------------------------------------------------------------

registerRender('section', (node, ctx) => <SectionNode node={node} ctx={ctx} />);
registerRender('columns', (node, ctx) => <ColumnsNode node={node} ctx={ctx} />);
registerRender('tabs', (node, ctx) => <TabsNode node={node} ctx={ctx} />);
registerRender('divider', () => <DividerNode />);
registerRender('text', (node) => <TextNode node={node} />);
registerRender('field', (node, ctx) => <FieldNode node={node} ctx={ctx} />);
registerRender('relation', (node, ctx) => <RelationNode node={node} ctx={ctx} />);
registerRender('readout', (node, ctx) => <ReadoutNode node={node} ctx={ctx} />);
registerRender('table', (node, ctx) => <TableNode node={node} ctx={ctx} />);
registerRender('custom', (node, ctx) => <CustomNode node={node} ctx={ctx} />);

export function FormNode({ node, ctx }) {
  if (!node || typeof node !== 'object') return null;
  const descriptor = getWidget(node.type);
  if (!descriptor || typeof descriptor.render !== 'function') {
    // R-CLOSED: an unregistered / un-attached node type is surfaced, never
    // rendered through an implicit default (anti-snapshot-drift parity with the
    // old switch `default:` case).
    return (
      <div className="chs-fd-unknown" role="alert" style={{ color: 'var(--chs-color-danger)', fontSize: 'var(--chs-text-sm)' }}>
        Неизвестный узел: {String(node.type)}
      </div>
    );
  }
  return descriptor.render(node, ctx);
}

/**
 * FormDocumentRenderer — render a whole form-document.
 *
 * @param {object} props
 * @param {object} props.document  the form-document (form-document.js shape)
 * @param {Array}  props.fields    parseRecordSchema(...) — LIVE schema view
 * @param {object} [props.values]  current values keyed by fieldKey
 * @param {(key:string,value:any)=>void} [props.onChange]
 * @param {(fieldKey:string,rowIndex:number,subKey:string,value:any)=>void} [props.onTableCellChange]
 * @param {object} [props.errors]  per-field error messages keyed by fieldKey
 * @param {'light'|'dark'} [props.theme]
 * @param {(e:any)=>void} [props.onCustomError]
 */
function FormDocumentRenderer({ document: doc, fields, values, onChange, onTableCellChange, errors, theme, onCustomError }) {
  if (!doc || !doc.root) {
    return <div className="chs-fd-empty" style={{ color: 'var(--chs-color-text-muted)' }}>Пустая форма.</div>;
  }
  const ctx = {
    schema: indexSchema(fields),
    values: values || {},
    onChange,
    onTableCellChange,
    errors: errors || {},
    theme: theme || 'light',
    onCustomError,
  };
  return (
    <div className="chs-form-document">
      <FormNode node={doc.root} ctx={ctx} />
    </div>
  );
}

export default FormDocumentRenderer;
