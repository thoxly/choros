/* ============================================================================
   CHOROS — FormDesigner.jsx  (T-0481 · E-FORMS F2)

   THE DRAG-N-DROP FORM-BUILDER ENVIRONMENT — "where layout is configured."

   This is the HUMAN driver of the form-document (deliverable 2). It is a thin
   visual shell over the tested pure layer:
     - the VETTED PALETTE (form-document.js PALETTE) — the only blocks you can add;
     - the pure ops (form-document-ops.js) — every edit is a tested transform;
     - the authoring validator (form-document.js validateDocument) — gates the
       result against the LIVE schema before it can persist;
     - the ONE renderer (FormDocumentRenderer.jsx) — the live preview, identical
       to runtime.

   ONE CONTRACT, TWO DRIVERS: the document this editor emits is byte-comparable
   to what the AI emitter (buildDefaultDocument / a richer bot emission) produces
   for the same layout. There is no editor-private document shape.

   BINDING DISCIPLINE: a data block is added by dragging a LIVE schema field onto
   the canvas — you cannot invent a fieldKey. The block binds through the
   contract; the type/options stay in the schema. Incompatible widget choices are
   rejected by the validator and surfaced inline.

   CLASS-B: the "Код-виджет" palette entry adds a `custom` node — flagged in the
   palette as code; it renders in the sandbox-iframe at preview/runtime.

   Theming: --chs-* tokens + kit components only (gate G2/G6).
   ============================================================================ */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Button, EmptyState, LoadingState, ErrorState, Select } from '../components/components.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import { parseRecordSchema } from '../screens/apps-schema.js';
import FormDocumentRenderer from './FormDocumentRenderer.jsx';
import {
  PALETTE, paletteByGroup, buildDefaultDocument, validateDocument,
  nodeForField, childrenOf, WIDGET_COMPAT,
} from './form-document.js';
import {
  insertNode, removeNode, reorderNode, updateNode,
} from './form-document-ops.js';

// ---------------------------------------------------------------------------
// Palette panel — the vetted set + the available live-schema fields
// ---------------------------------------------------------------------------

const GROUP_LABELS = { layout: 'Раскладка', data: 'Данные', code: 'Код (песочница)' };

function PaletteBlock({ entry, onAdd }) {
  return (
    <button
      type="button"
      className="chs-palette-block chs-btn chs-btn--ghost"
      style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 'var(--chs-space-2)' }}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/x-palette', entry.type)}
      onClick={() => onAdd(entry.type)}
      title={entry.summary}
    >
      <strong>{entry.label}</strong>
      {entry.floorClass === 'b' && (
        <span className="chs-chip" style={{ marginLeft: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-warning)' }}>код</span>
      )}
      <span style={{ display: 'block', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>{entry.summary}</span>
    </button>
  );
}

function FieldChip({ field, used, onAdd }) {
  return (
    <button
      type="button"
      className="chs-field-chip chs-btn chs-btn--ghost"
      style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 'var(--chs-space-1)', opacity: used ? 0.5 : 1 }}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/x-field', field.key)}
      onClick={() => onAdd(field.key)}
      title={`Поле «${field.key}» (${field.type})`}
    >
      {field.label || field.title || field.key}
      <span style={{ float: 'right', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>{field.type}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Canvas — the editable list of root nodes (reorder/remove/select)
// ---------------------------------------------------------------------------

function CanvasNode({ node, index, selected, onSelect, onRemove, onDragStart, onDrop }) {
  const label = node.label || node.title || PALETTE[node.type]?.label || node.type;
  return (
    <div
      className={`chs-canvas-node${selected ? ' chs-canvas-node--selected' : ''}`}
      style={{
        border: selected ? '2px solid var(--chs-color-accent)' : '1px solid var(--chs-color-border)',
        borderRadius: 'var(--chs-radius-md)', padding: 'var(--chs-space-3)', marginBottom: 'var(--chs-space-2)',
        background: 'var(--chs-color-surface)', cursor: 'pointer',
      }}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('application/x-reorder', String(index)); onDragStart(index); }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); onDrop(index, e); }}
      onClick={() => onSelect(index)}
    >
      <span className="chs-canvas-node__type" style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
        {PALETTE[node.type]?.label || node.type}
        {PALETTE[node.type]?.floorClass === 'b' && ' · код'}
      </span>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{label}</strong>
        <button
          type="button"
          className="chs-btn chs-btn--ghost chs-btn--sm"
          onClick={(e) => { e.stopPropagation(); onRemove(index); }}
          aria-label="Удалить блок"
        >×</button>
      </div>
      {node.fieldKey && (
        <span style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>↳ {node.fieldKey}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Properties inspector for the selected node
// ---------------------------------------------------------------------------

function Inspector({ node, schemaField, onPatch }) {
  if (!node) {
    return <p style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>Выберите блок, чтобы настроить его.</p>;
  }
  const widgetChoices = schemaField ? (WIDGET_COMPAT[schemaField.type] || []) : [];
  return (
    <div className="chs-inspector">
      <label className="chs-label">Метка</label>
      <input
        className="chs-input"
        type="text"
        value={node.label || ''}
        onChange={(e) => onPatch({ label: e.target.value })}
        style={{ width: '100%', marginBottom: 'var(--chs-space-3)' }}
      />
      {node.type === 'text' && (
        <>
          <label className="chs-label">Текст</label>
          <textarea className="chs-input" rows={2} value={node.content || ''} onChange={(e) => onPatch({ content: e.target.value })} style={{ width: '100%', marginBottom: 'var(--chs-space-3)' }} />
        </>
      )}
      {node.type === 'columns' && (
        <>
          <label className="chs-label">Колонок</label>
          <Select value={String(node.count || 2)} onChange={(e) => onPatch({ count: Number(e.target.value) })} options={[{ value: '2', label: '2' }, { value: '3', label: '3' }, { value: '4', label: '4' }]} />
        </>
      )}
      {node.type === 'field' && widgetChoices.length > 0 && (
        <>
          <label className="chs-label">Виджет</label>
          <Select
            value={node.widget || widgetChoices[0]}
            onChange={(e) => onPatch({ widget: e.target.value })}
            options={widgetChoices.map((w) => ({ value: w, label: w }))}
          />
        </>
      )}
      {(node.type === 'field' || node.type === 'table' || node.type === 'relation') && (
        <>
          <label className="chs-label" style={{ marginTop: 'var(--chs-space-3)' }}>Режим на шаге</label>
          <Select
            value={node.mode || 'editable'}
            onChange={(e) => onPatch({ mode: e.target.value === 'editable' ? undefined : e.target.value })}
            options={[
              { value: 'editable', label: 'Редактируемое' },
              { value: 'readonly', label: 'Только чтение' },
              { value: 'required', label: 'Обязательное' },
              { value: 'hidden', label: 'Скрытое' },
            ]}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The designer
// ---------------------------------------------------------------------------

/**
 * FormDesigner — drag-n-drop form-document authoring.
 *
 * Self-contained: fetches applications/registry-defs, derives the live schema,
 * starts from the default document (the same a bot would emit), lets the user
 * reshape it from the vetted palette, validates, previews, and persists the
 * layout via POST /api/forms/binding (the `layout` field, migration 105).
 *
 * @param {object} [props]
 * @param {object} [props.initialDocument] optional document to load (e.g. AI-emitted)
 * @param {Array}  [props.initialFields]   optional live schema (testing/embedding)
 */
function FormDesigner({ initialDocument, initialFields } = {}) {
  const [applications, setApplications] = useState(initialFields ? [] : null);
  const [selectedAppId, setSelectedAppId] = useState('');
  const [registryDefs, setRegistryDefs] = useState(null);
  const [selectedDefId, setSelectedDefId] = useState('');
  const [fields, setFields] = useState(initialFields || []);
  const [doc, setDoc] = useState(initialDocument || null);
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [dragFrom, setDragFrom] = useState(null);
  const [saveState, setSaveState] = useState({ status: 'idle' });
  const [loadError, setLoadError] = useState(null);

  // Load applications (skip when fields injected for embedding/testing).
  useEffect(() => {
    if (initialFields) return;
    fetch('/api/applications', { headers: authHeaders() })
      .then((r) => r.json())
      .then((data) => setApplications(data.applications || []))
      .catch(() => setLoadError('Не удалось загрузить приложения.'));
  }, [initialFields]);

  // Load registry defs for the chosen app.
  useEffect(() => {
    if (!selectedAppId) { setRegistryDefs(null); return; }
    fetch(`/api/registry-defs?application_id=${encodeURIComponent(selectedAppId)}`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((data) => setRegistryDefs(data.registry_defs || []))
      .catch(() => setLoadError('Не удалось загрузить наборы полей.'));
  }, [selectedAppId]);

  // Derive live schema + default document when the registry def changes.
  useEffect(() => {
    if (!selectedDefId || !registryDefs) return;
    const def = registryDefs.find((d) => d.id === selectedDefId);
    if (!def) return;
    const parsed = parseRecordSchema(def.record_schema);
    setFields(parsed);
    setDoc(buildDefaultDocument({ applicationId: selectedAppId, registryDefId: selectedDefId }, parsed, { withIds: true }));
    setSelectedIndex(null);
  }, [selectedDefId, registryDefs, selectedAppId]);

  // Root children (the editable list).
  const rootChildren = useMemo(() => (doc ? childrenOf(doc.root) : []), [doc]);

  // Validation against the live schema (runs on every edit — both drivers' gate).
  const validation = useMemo(() => (doc ? validateDocument(doc, fields) : { ok: true, errors: [], brokenKeys: [] }), [doc, fields]);

  // Which schema keys are already placed (to dim them in the palette).
  const usedKeys = useMemo(() => {
    const set = new Set();
    rootChildren.forEach((n) => { if (n.fieldKey) set.add(n.fieldKey); });
    return set;
  }, [rootChildren]);

  // --- editing ops (all via the pure layer) ---
  const addPaletteBlock = useCallback((type) => {
    if (!doc) return;
    const entry = PALETTE[type];
    if (!entry) return;
    if (entry.data) return; // data blocks are added by dragging a field, not a palette type
    let node;
    if (type === 'custom') {
      node = { type: 'custom', componentId: 'custom-widget', bindings: [], label: 'Код-виджет' };
    } else if (type === 'columns') {
      node = { type: 'columns', count: 2, children: [] };
    } else if (type === 'tabs') {
      node = { type: 'tabs', tabs: [{ title: 'Вкладка 1', children: [] }] };
    } else if (type === 'section') {
      node = { type: 'section', title: 'Секция', children: [] };
    } else if (type === 'text') {
      node = { type: 'text', content: 'Подсказка' };
    } else {
      node = { type };
    }
    setDoc((d) => insertNode(d, [], node));
  }, [doc]);

  const addFieldBlock = useCallback((fieldKey) => {
    if (!doc) return;
    const field = fields.find((f) => f.key === fieldKey);
    if (!field) return;
    setDoc((d) => insertNode(d, [], nodeForField(field, { withId: true })));
  }, [doc, fields]);

  const removeAt = useCallback((index) => {
    setDoc((d) => removeNode(d, [], index));
    setSelectedIndex(null);
  }, []);

  const patchAt = useCallback((index, patch) => {
    setDoc((d) => updateNode(d, [], index, patch));
  }, []);

  const handleDrop = useCallback((targetIndex, e) => {
    const reorderFrom = e.dataTransfer.getData('application/x-reorder');
    const paletteType = e.dataTransfer.getData('application/x-palette');
    const fieldKey = e.dataTransfer.getData('application/x-field');
    if (reorderFrom !== '') {
      setDoc((d) => reorderNode(d, [], Number(reorderFrom), targetIndex));
    } else if (fieldKey) {
      const field = fields.find((f) => f.key === fieldKey);
      if (field) setDoc((d) => insertNode(d, [], nodeForField(field, { withId: true }), targetIndex));
    } else if (paletteType && !PALETTE[paletteType]?.data) {
      addPaletteBlock(paletteType);
    }
    setDragFrom(null);
  }, [fields, addPaletteBlock]);

  // --- render ---
  if (loadError) return <ErrorState message={loadError} />;
  if (!initialFields && applications === null) return <LoadingState label="Загрузка приложений…" />;

  const groups = paletteByGroup();
  const selectedNode = selectedIndex !== null ? rootChildren[selectedIndex] : null;
  const selectedSchemaField = selectedNode && selectedNode.fieldKey ? fields.find((f) => f.key === selectedNode.fieldKey) : null;

  return (
    <div className="chs-form-designer" style={{ display: 'grid', gridTemplateColumns: '240px 1fr 280px', gap: 'var(--chs-space-4)' }}>
      {/* ---- Palette + source picker ---- */}
      <aside className="chs-designer-palette">
        {!initialFields && (
          <>
            <label className="chs-label">Приложение</label>
            <Select
              value={selectedAppId}
              onChange={(e) => { setSelectedAppId(e.target.value); setSelectedDefId(''); }}
              options={[{ value: '', label: '— выберите —' }, ...(applications || []).map((a) => ({ value: a.id, label: a.name || a.id }))]}
            />
            {registryDefs && (
              <>
                <label className="chs-label" style={{ marginTop: 'var(--chs-space-3)' }}>Набор полей</label>
                <Select
                  value={selectedDefId}
                  onChange={(e) => setSelectedDefId(e.target.value)}
                  options={[{ value: '', label: '— выберите —' }, ...registryDefs.map((d) => ({ value: d.id, label: d.title || d.id }))]}
                />
              </>
            )}
          </>
        )}

        {doc && (
          <>
            <h4 style={{ marginTop: 'var(--chs-space-4)' }}>Поля</h4>
            {fields.length === 0 ? (
              <p style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>Нет полей.</p>
            ) : fields.map((f) => (
              <FieldChip key={f.key} field={f} used={usedKeys.has(f.key)} onAdd={addFieldBlock} />
            ))}

            {Object.entries(groups).map(([group, entries]) => (
              <div key={group}>
                <h4 style={{ marginTop: 'var(--chs-space-4)' }}>{GROUP_LABELS[group]}</h4>
                {entries.filter((en) => !en.data).map((en) => (
                  <PaletteBlock key={en.type} entry={en} onAdd={addPaletteBlock} />
                ))}
              </div>
            ))}
          </>
        )}
      </aside>

      {/* ---- Canvas ---- */}
      <main
        className="chs-designer-canvas"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => handleDrop(rootChildren.length, e)}
        style={{ minHeight: 200, padding: 'var(--chs-space-3)', border: '1px dashed var(--chs-color-border)', borderRadius: 'var(--chs-radius-md)' }}
      >
        {!doc ? (
          <EmptyState title="Выберите набор полей" description="Слева выберите приложение и набор полей — форма соберётся из них." />
        ) : rootChildren.length === 0 ? (
          <EmptyState title="Пустая форма" description="Перетащите поля и блоки сюда." />
        ) : (
          rootChildren.map((node, i) => (
            <CanvasNode
              key={node.id || i}
              node={node}
              index={i}
              selected={selectedIndex === i}
              onSelect={setSelectedIndex}
              onRemove={removeAt}
              onDragStart={setDragFrom}
              onDrop={handleDrop}
            />
          ))
        )}

        {!validation.ok && (
          <div className="chs-designer-errors" role="alert" style={{ marginTop: 'var(--chs-space-3)', color: 'var(--chs-color-danger)', fontSize: 'var(--chs-text-sm)' }}>
            <strong>Ошибки авторинга:</strong>
            <ul>{validation.errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
          </div>
        )}

        {/* Live preview through the ONE renderer — identical to runtime. */}
        {doc && (
          <details className="chs-designer-preview" style={{ marginTop: 'var(--chs-space-4)' }}>
            <summary>Предпросмотр</summary>
            <div style={{ marginTop: 'var(--chs-space-3)' }}>
              <FormDocumentRenderer document={doc} fields={fields} theme="light" />
            </div>
          </details>
        )}
      </main>

      {/* ---- Inspector + save ---- */}
      <aside className="chs-designer-inspector">
        <h4>Свойства</h4>
        <Inspector
          node={selectedNode}
          schemaField={selectedSchemaField}
          onPatch={(patch) => selectedIndex !== null && patchAt(selectedIndex, patch)}
        />
        {doc && (
          <Button
            variant="primary"
            disabled={!validation.ok || saveState.status === 'saving'}
            loading={saveState.status === 'saving'}
            onClick={() => persistLayout(doc, setSaveState)}
            style={{ marginTop: 'var(--chs-space-4)', width: '100%' }}
          >
            Сохранить раскладку
          </Button>
        )}
        {saveState.status === 'saved' && <p style={{ color: 'var(--chs-color-success)', fontSize: 'var(--chs-text-sm)' }}>Сохранено.</p>}
        {saveState.status === 'error' && <p style={{ color: 'var(--chs-color-danger)', fontSize: 'var(--chs-text-sm)' }}>{saveState.message || 'Ошибка сохранения.'}</p>}
      </aside>
    </div>
  );
}

/**
 * Persist the form-document layout via POST /api/forms/binding. The server stores
 * it in form_binding.layout (migration 105) and re-validates server-side.
 */
function persistLayout(doc, setSaveState) {
  setSaveState({ status: 'saving' });
  const body = {
    process_key: doc.step?.processKey || 'record',
    form_key: doc.step?.step || 'record-form',
    layout: doc,
  };
  fetch('/api/forms/binding', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((r) => { if (!r.ok) throw new Error('save failed'); return r.json(); })
    .then(() => setSaveState({ status: 'saved' }))
    .catch(() => setSaveState({ status: 'error', message: 'Не удалось сохранить.' }));
}

export default FormDesigner;
