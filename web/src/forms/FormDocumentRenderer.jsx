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
import Floor2Viewer from './Floor2Viewer.jsx';
import {
  childrenOf, isDataNodeType, indexSchema, defaultWidgetForType,
} from './form-document.js';

// ---------------------------------------------------------------------------
// Live-schema → renderable-field adapter
// ---------------------------------------------------------------------------

/**
 * Build the "renderable field" descriptor FieldControl expects from a document
 * node + the LIVE schema field. The TYPE and OPTIONS come from the schema (never
 * the node) — this is the anti-drift contract. The node contributes only the
 * presentation: label, widget→presentation, mode.
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
    // per-step mode → FieldControl's resolveFieldMode vocabulary.
    mode: nodeModeToFieldMode(node.mode),
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
  // Class-b escape — sandbox-iframe. Build the BindingField[] contract for the
  // bindings the custom widget declares; the agent code in the iframe presents
  // over THAT contract only and cannot reach the parent / process (T-0076/T-0101).
  const bindings = Array.isArray(node.bindings) ? node.bindings : [];
  const fields = bindings
    .map((key) => {
      const sf = ctx.schema.byKey.get(key);
      if (!sf) return null;
      return { key, label: sf.label || sf.title || key, type: sf.type, options: sf.options };
    })
    .filter(Boolean);
  const descriptor = {
    mode: node.descriptorMode || 'custom',
    bindingKey: bindings[0] || node.componentId,
    componentId: node.componentId,
    reactSource: node.reactSource,
    // governance flag passes through; Floor2Viewer/validateFloor2Descriptor enforces it.
    meta: node.meta,
  };
  return (
    <div className="chs-fd-custom" data-component-id={node.componentId}>
      <Floor2Viewer descriptor={descriptor} fields={fields} theme={ctx.theme || 'light'} onError={ctx.onCustomError} />
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
// Dispatch
// ---------------------------------------------------------------------------

export function FormNode({ node, ctx }) {
  if (!node || typeof node !== 'object') return null;
  switch (node.type) {
    case 'section': return <SectionNode node={node} ctx={ctx} />;
    case 'columns': return <ColumnsNode node={node} ctx={ctx} />;
    case 'tabs': return <TabsNode node={node} ctx={ctx} />;
    case 'divider': return <DividerNode />;
    case 'text': return <TextNode node={node} />;
    case 'field': return <FieldNode node={node} ctx={ctx} />;
    case 'relation': return <RelationNode node={node} ctx={ctx} />;
    case 'readout': return <ReadoutNode node={node} ctx={ctx} />;
    case 'table': return <TableNode node={node} ctx={ctx} />;
    case 'custom': return <CustomNode node={node} ctx={ctx} />;
    default:
      return (
        <div className="chs-fd-unknown" role="alert" style={{ color: 'var(--chs-color-danger)', fontSize: 'var(--chs-text-sm)' }}>
          Неизвестный узел: {String(node.type)}
        </div>
      );
  }
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
