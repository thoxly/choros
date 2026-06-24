/* ============================================================================
   CHOROS — screen-app-schema.jsx
   ЭКРАН: КОНСТРУКТОР · Поля приложения (registry_def field-editor, E13 T-0266).

   СЕРДЦЕ КОНСТРУКТОРА. Здесь пользователь ОПРЕДЕЛЯЕТ поля записи приложения:
     • выбирает приложение (route /apps/:appId/schema; ссылка «Настроить поля» из
       списка приложений) или создаёт новый реестр (registry_def) под ним;
     • редактор полей: добавить / удалить / переставить (вверх/вниз) / тип / обяз.;
     • сохранить → POST (новый реестр) или PUT (изменить существующий) с собранным
       record_schema; 400/404/409 — честно на экран.

   Fetch-контракт (FROZEN, src/http/registry-defs.ts T-0263):
     GET  /api/registry-defs?application_id=  → 200 { registry_defs: [...] }
     GET  /api/registry-defs/:id              → 200 { ...def } | 404
     POST /api/registry-defs  body { application_id, slug, display_name, description?,
            record_schema }                   → 201 { id, ..., record_schema_version }
            → 400 VALIDATION · 401 · 404 (app) · 409 CONFLICT (slug)
     PUT  /api/registry-defs/:id  body { record_schema, force? }
            → 200 { updated, registry_def_id, warnings? } | 409 destructive | 400

   record_schema собирается чистым модулем apps-schema.js (buildRecordSchema) —
   единственный источник истины формы соответствует серверному AJV-валидатору.
   Авторизация — devHeaders() (X-Dev-User), как у остальных экранов.

   OBLIK (T-0302): конструктор полей потребляет KIT — поля через <Field>/.chs-input
   (видимый ввод в ОБЕИХ темах через реальные --chs-color-* токены, без
   несуществующих --chs-bg-primary/--chs-border). Ноль хардкода цвета (G6).
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Button, MonoId, StatusChip, Field, Select, EmptyState, ErrorState, LoadingState, KitIcon,
} from '../components/components.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';
import { validateAppForm } from './apps-validate.js';
import {
  FIELD_TYPES,
  COLLECTION_SUB_FIELD_TYPES,
  validateFields,
  buildRecordSchema,
  parseRecordSchema,
  mapSchemaError,
  blankField,
  blankSubField,
} from './apps-schema.js';

// Scalar types permitted inside a «Список строк» column — label map for the
// column-type dropdown. Mirrors COLLECTION_SUB_FIELD_TYPES (depth cap 1: no
// collection / relation nesting). Labels are product-language (no dev jargon).
const COLUMN_TYPE_LABELS = {
  string: 'Текст',
  number: 'Число',
  integer: 'Целое',
  boolean: 'Да/Нет',
  select: 'Список (select)',
  date: 'Дата',
};

// .chs-input carries a FIXED control height; textareas/selects need it relaxed.
const textareaStyle = {
  height: 'auto', minHeight: '60px',
  paddingTop: 'var(--chs-space-2)', paddingBottom: 'var(--chs-space-2)',
  resize: 'vertical',
};
const errStyle = {
  display: 'block', marginTop: 'var(--chs-space-2)',
  fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)',
};
const inputCls = (invalid) => `chs-input ${invalid ? 'chs-input--invalid' : ''}`;

// Field-editor row layout. The earlier version put <input>/<select> inside
// .chs-itable <td> cells, which fights the dense 34px row contract (controls are
// 30px tall but the option-textarea blows the cell height out). The editor is a
// FORM, not a data table — render it as a CSS grid instead: one aligned grid row
// per field (key · type · title · required · reorder), with the select-options
// textarea and inline errors flowing into a full-width sub-row below.
const editorGridCols = 'minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1.6fr) auto auto';
const fieldRowGrid = {
  display: 'grid',
  gridTemplateColumns: editorGridCols,
  gap: 'var(--chs-space-4)',
  alignItems: 'center',
  padding: 'var(--chs-space-3) 0',
  borderBottom: '1px solid var(--chs-color-border)',
};
const colHeadStyle = {
  fontSize: 'var(--chs-text-xs)',
  fontWeight: 'var(--chs-weight-semibold)',
  color: 'var(--chs-color-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

// Sub-field (column) grid — narrower than the top-level field grid because the
// sub-editor is inset (no separate reorder column; add/remove only).
const subFieldGridCols = 'minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.4fr) auto auto';
const subFieldRowGrid = {
  display: 'grid',
  gridTemplateColumns: subFieldGridCols,
  gap: 'var(--chs-space-3)',
  alignItems: 'center',
  padding: 'var(--chs-space-2) 0',
  borderBottom: '1px solid var(--chs-color-border)',
};

/**
 * CollectionSubFieldEditor — nested editor for the sub-fields (columns) of a
 * «Список строк» (collection) field. Rendered inside FieldRow when type is
 * «collection». Uses the same .chs-input / token conventions as the top-level
 * editor so inputs are visible in both themes (G2, G6).
 *
 * Product-language labels:  «Колонки» / «Колонка» — no «sub-field»/«collection».
 *
 * @param {{ key, type, label, required, options? }[]} subFields current list
 * @param {string|undefined} subFieldsError top-level error from validateField
 * @param {(next: typeof subFields) => void} onChange
 */
function CollectionSubFieldEditor({ subFields, subFieldsError, onChange }) {
  const addCol = () => onChange([...subFields, blankSubField()]);
  const removeCol = (i) => onChange(subFields.filter((_, idx) => idx !== i));
  const updateCol = (i, patch) =>
    onChange(subFields.map((sf, idx) => (idx === i ? { ...sf, ...patch } : sf)));

  return (
    <div
      style={{
        marginTop: 'var(--chs-space-4)',
        paddingLeft: 'var(--chs-space-5)',
        borderLeft: '3px solid var(--chs-color-border)',
      }}
      aria-label="Колонки списка строк"
    >
      <span style={{ display: 'block', marginBottom: 'var(--chs-space-3)', fontSize: 'var(--chs-text-xs)', fontWeight: 'var(--chs-weight-semibold)', color: 'var(--chs-color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Колонки списка строк
      </span>

      {subFields.length > 0 && (
        <>
          {/* Column header */}
          <div style={{ display: 'grid', gridTemplateColumns: subFieldGridCols, gap: 'var(--chs-space-3)', padding: '0 0 var(--chs-space-2) 0', borderBottom: '1px solid var(--chs-color-border)' }}>
            <span style={colHeadStyle}>Ключ</span>
            <span style={colHeadStyle}>Тип</span>
            <span style={colHeadStyle}>Название</span>
            <span style={{ ...colHeadStyle, textAlign: 'center' }}>Обяз.</span>
            <span />
          </div>
          {subFields.map((sf, i) => (
            <div key={i} role="group" aria-label={`Колонка ${i + 1}`} style={subFieldRowGrid}>
              {/* sub-field key */}
              <input
                className={`${inputCls(false)} chs-input--mono`}
                value={sf.key}
                onChange={(e) => updateCol(i, { key: e.target.value })}
                placeholder="col_key"
                aria-label="Ключ колонки"
              />
              {/* sub-field type (scalars only — depth cap 1) */}
              <select
                className={inputCls(false)}
                value={sf.type}
                onChange={(e) => updateCol(i, { type: e.target.value })}
                aria-label="Тип колонки"
              >
                {COLLECTION_SUB_FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>{COLUMN_TYPE_LABELS[t] || t}</option>
                ))}
              </select>
              {/* sub-field label */}
              <input
                className={inputCls(false)}
                value={sf.label}
                onChange={(e) => updateCol(i, { label: e.target.value })}
                placeholder="Название (опц.)"
                aria-label="Название колонки"
              />
              {/* required */}
              <label style={{ display: 'inline-flex', justifyContent: 'center', width: '100%' }}>
                <input
                  type="checkbox"
                  checked={Boolean(sf.required)}
                  onChange={(e) => updateCol(i, { required: e.target.checked })}
                  aria-label="Обязательная колонка"
                />
              </label>
              {/* remove */}
              <Button
                type="button" variant="ghost" size="sm"
                onClick={() => removeCol(i)} title="Удалить колонку" aria-label="Удалить колонку"
              >
                <KitIcon name="close" />
              </Button>
            </div>
          ))}
        </>
      )}

      {subFields.length === 0 && (
        <p style={{ margin: 'var(--chs-space-2) 0', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
          Пока нет колонок. Добавьте первую.
        </p>
      )}

      <div style={{ marginTop: 'var(--chs-space-3)' }}>
        <Button type="button" variant="ghost" size="sm" glyph={<KitIcon name="plus" />} onClick={addCol}>
          Добавить колонку
        </Button>
      </div>

      {/* Surface validateField sub-field errors (key/type/dup errors from T-0450 fix) */}
      {subFieldsError && (
        <span style={{ ...errStyle, marginTop: 'var(--chs-space-2)' }}>
          {subFieldsError}
        </span>
      )}
    </div>
  );
}

/**
 * FieldRow — one editable field: key · type · title · required · reorder/remove.
 * Controlled entirely by the parent (FieldEditor) via onChange/onMove/onRemove.
 *
 * T-0294: when type="select", a textarea for entering option values (one per line)
 * is rendered below the type dropdown. When type changes away from "select", the
 * options state is preserved but hidden (non-destructive — lets user switch back).
 *
 * T-0444: when type="relation", a «Целевой набор полей» dropdown is rendered
 * below the type dropdown. registryDefs = tenant's набор полей list (fetched by
 * FieldEditor and passed down) for the target selector. targetRegistryId stored
 * on the field object.
 */
function FieldRow({ field, errors, index, count, onChange, onMove, onRemove, registryDefs, registryDefsLoading, registryDefsError }) {
  const set = (patch) => onChange({ ...field, ...patch });

  // T-0294: convert options array ↔ newline-separated string for the textarea.
  const optionsText = Array.isArray(field.options)
    ? field.options.join('\n')
    : (typeof field.options === 'string' ? field.options : '');
  const setOptionsFromText = (text) => {
    // Split on newlines; keep empty lines during editing (they're filtered on save).
    set({ options: text.split('\n') });
  };

  const hasSubRow = field.type === 'select' || field.type === 'relation'
    || field.type === 'collection'
    || Boolean(errors.key) || Boolean(errors.type) || Boolean(errors.title)
    || Boolean(errors.options) || Boolean(errors.targetRegistryId);

  return (
    <div role="group" aria-label={`Поле ${index + 1}`} style={fieldRowGrid}>
      {/* key */}
      <input
        className={`${inputCls(Boolean(errors.key))} chs-input--mono`}
        value={field.key}
        onChange={(e) => set({ key: e.target.value })}
        placeholder="field_key"
        aria-label="Ключ поля"
        aria-invalid={Boolean(errors.key) || undefined}
      />
      {/* type */}
      <select
        className={inputCls(Boolean(errors.type))}
        value={field.type}
        onChange={(e) => set({ type: e.target.value })}
        aria-label="Тип поля"
      >
        {FIELD_TYPES.map((t) => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
      </select>
      {/* title */}
      <input
        className={inputCls(Boolean(errors.title))}
        value={field.title}
        onChange={(e) => set({ title: e.target.value })}
        placeholder="Название (опц.)"
        aria-label="Название поля"
        aria-invalid={Boolean(errors.title) || undefined}
      />
      {/* required */}
      <label style={{ display: 'inline-flex', justifyContent: 'center', width: '100%' }}>
        <input
          type="checkbox"
          checked={Boolean(field.required)}
          onChange={(e) => set({ required: e.target.checked })}
          aria-label="Обязательное поле"
        />
      </label>
      {/* reorder / remove */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', whiteSpace: 'nowrap' }}>
        <Button type="button" variant="ghost" size="sm" disabled={index === 0}
          onClick={() => onMove(index, index - 1)} title="Вверх" aria-label="Переместить вверх">↑</Button>
        <Button type="button" variant="ghost" size="sm" disabled={index === count - 1}
          onClick={() => onMove(index, index + 1)} title="Вниз" aria-label="Переместить вниз">↓</Button>
        <Button type="button" variant="ghost" size="sm"
          onClick={() => onRemove(index)} title="Удалить" aria-label="Удалить поле">
          <KitIcon name="close" />
        </Button>
      </div>

      {/* Full-width sub-row: per-field errors + the select-options editor or
          relation target picker. Spans all grid columns so controls above keep
          the dense single-line row. */}
      {hasSubRow && (
        <div style={{ gridColumn: '1 / -1', marginTop: 'var(--chs-space-2)' }}>
          {errors.key && <span style={errStyle}>Ключ: {errors.key}</span>}
          {errors.type && <span style={errStyle}>Тип: {errors.type}</span>}
          {errors.title && <span style={errStyle}>Название: {errors.title}</span>}
          {/* T-0294: options input for select type */}
          {field.type === 'select' && (
            <div style={{ marginTop: 'var(--chs-space-3)', maxWidth: '420px' }}>
              <span style={{ display: 'block', marginBottom: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                Варианты (по одному на строку):
              </span>
              <textarea
                className={inputCls(Boolean(errors.options))}
                style={textareaStyle}
                value={optionsText}
                onChange={(e) => setOptionsFromText(e.target.value)}
                placeholder={'вариант_1\nвариант_2\nвариант_3'}
                aria-label="Варианты select"
                aria-invalid={Boolean(errors.options) || undefined}
                rows={3}
              />
              {errors.options && <span style={errStyle}>{errors.options}</span>}
            </div>
          )}
          {/* T-0444: target набор полей picker for relation type */}
          {field.type === 'relation' && (
            <div style={{ marginTop: 'var(--chs-space-3)', maxWidth: '420px' }}>
              <Select
                label="На какой набор ссылается"
                value={field.targetRegistryId || ''}
                onChange={(e) => set({ targetRegistryId: e.target.value })}
                invalid={Boolean(errors.targetRegistryId)}
                placeholder={
                  registryDefsLoading
                    ? 'Загрузка наборов полей…'
                    : (registryDefs || []).length === 0
                      ? 'Нет доступных наборов полей'
                      : 'Выберите набор полей…'
                }
                disabled={registryDefsLoading || registryDefsError || (registryDefs || []).length === 0}
                options={(registryDefs || []).map((d) => ({
                  value: d.id,
                  label: d.display_name || d.slug,
                }))}
              />
              {/* G4 honest empty/error states — shown inline below the disabled control */}
              {!registryDefsLoading && registryDefsError && (
                <span style={{ ...errStyle, color: 'var(--chs-color-text-muted)' }}>
                  Не удалось загрузить наборы полей
                </span>
              )}
              {!registryDefsLoading && !registryDefsError && (registryDefs || []).length === 0 && (
                <span style={{ display: 'block', marginTop: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                  Пока не создано ни одного набора полей, на который можно сослаться — создайте его первым
                </span>
              )}
              {errors.targetRegistryId && (
                <span style={errStyle}>{errors.targetRegistryId}</span>
              )}
            </div>
          )}
          {/* T-0450: sub-field (column) editor for «Список строк» (collection) type.
              Each column has key / label / type (scalar only) / required.
              Reuses the same field-row grid conventions as the top-level editor.
              Product language: «Колонки», «Колонка» — no «sub-field»/«collection» jargon.
              Errors from validateField.subFields are surfaced inline. */}
          {field.type === 'collection' && (
            <CollectionSubFieldEditor
              subFields={Array.isArray(field.subFields) ? field.subFields : []}
              subFieldsError={errors.subFields}
              onChange={(nextSubFields) => set({ subFields: nextSubFields })}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * FieldEditor — the field list + add/save. Editing target:
 *   - editingDef === null  → CREATE a new registry_def (needs slug + display_name) → POST.
 *   - editingDef object    → EDIT its record_schema → PUT (slug/name read-only here).
 *
 * T-0444: fetches all tenant registry_defs (tenant-wide, no application_id filter) to
 * populate the «На какой набор ссылается» dropdown in relation FieldRows.
 */
function FieldEditor({ applicationId, editingDef, onSaved, onCancel }) {
  const isEdit = Boolean(editingDef);
  const [slug, setSlug] = useState(editingDef?.slug || '');
  const [displayName, setDisplayName] = useState(editingDef?.display_name || '');
  const [fields, setFields] = useState(() =>
    isEdit ? parseRecordSchema(editingDef.record_schema) : [blankField()]
  );
  const [fieldErrs, setFieldErrs] = useState([]);
  const [formErr, setFormErr] = useState(null);     // field-list-level message
  const [metaErrs, setMetaErrs] = useState({});      // { slug?, display_name? }
  const [submitErr, setSubmitErr] = useState(null);  // general API error
  const [warnings, setWarnings] = useState(null);    // PUT soft warnings
  const [submitting, setSubmitting] = useState(false);
  // T-0444: tenant-wide набор полей list for the relation target dropdown.
  const [allRegistryDefs, setAllRegistryDefs] = useState([]);

  // T-0444: fetch all tenant registry_defs once (no application_id → tenant-wide).
  // G4 honest-state: track loading/error so the dropdown gives an honest explanation
  // instead of a silently empty enabled control.
  const [allRegistryDefsLoading, setAllRegistryDefsLoading] = useState(true);
  const [allRegistryDefsError, setAllRegistryDefsError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAllRegistryDefsLoading(true);
    setAllRegistryDefsError(false);
    fetch('/api/registry-defs', { headers: devHeaders() })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data) => {
        if (!cancelled) {
          setAllRegistryDefs(Array.isArray(data?.registry_defs) ? data.registry_defs : []);
          setAllRegistryDefsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAllRegistryDefsError(true);
          setAllRegistryDefsLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  const updateField = useCallback((i, next) => {
    setFields((prev) => prev.map((f, idx) => (idx === i ? next : f)));
  }, []);
  const moveField = useCallback((from, to) => {
    setFields((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const copy = prev.slice();
      const [item] = copy.splice(from, 1);
      copy.splice(to, 0, item);
      return copy;
    });
  }, []);
  const removeField = useCallback((i) => {
    setFields((prev) => prev.filter((_, idx) => idx !== i));
  }, []);
  const addField = useCallback(() => {
    setFields((prev) => [...prev, blankField()]);
  }, []);

  const handleSubmit = useCallback(async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setSubmitErr(null); setWarnings(null);

    // Validate field list (pure module — same shape the server's AJV checks).
    const fv = validateFields(fields);
    setFieldErrs(fv.fieldErrors);
    setFormErr(fv.formError);

    // For CREATE also validate slug/display_name (mirror of apps-validate).
    let metaOk = true;
    if (!isEdit) {
      const mv = validateAppForm({ slug, display_name: displayName });
      setMetaErrs(mv.errors);
      metaOk = mv.valid;
    }
    if (!fv.valid || !metaOk) return;

    const recordSchema = buildRecordSchema(fields);
    setSubmitting(true);
    try {
      let res;
      if (isEdit) {
        res = await fetch(`/api/registry-defs/${encodeURIComponent(editingDef.id)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', ...devHeaders() },
          body: JSON.stringify({ record_schema: recordSchema }),
        });
      } else {
        res = await fetch('/api/registry-defs', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...devHeaders() },
          body: JSON.stringify({
            application_id: applicationId,
            slug,
            display_name: displayName,
            record_schema: recordSchema,
          }),
        });
      }

      if (res.status === 201 || res.status === 200) {
        const payload = await res.json().catch(() => null);
        // PUT soft path may carry warnings (deps relabeled) — surface, then close.
        if (isEdit && payload && Array.isArray(payload.warnings) && payload.warnings.length > 0) {
          setWarnings(payload.warnings);
        }
        onSaved(payload);
        return;
      }

      const parsed = await res.json().catch(() => null);
      const mapped = mapSchemaError(res.status, parsed);
      if (mapped.field === 'slug' && !isEdit) {
        setMetaErrs((prev) => ({ ...prev, slug: mapped.message }));
      } else {
        setSubmitErr(mapped.message);
      }
    } catch (err) {
      setSubmitErr(String(err?.message || err));
    } finally {
      setSubmitting(false);
    }
  }, [fields, isEdit, slug, displayName, applicationId, editingDef, onSaved]);

  return (
    <form onSubmit={handleSubmit} style={{
      border: '1px solid var(--chs-color-border)', borderRadius: 'var(--chs-radius-4)',
      padding: 'var(--chs-space-7) var(--chs-space-8)', marginBottom: 'var(--chs-space-7)',
      background: 'var(--chs-color-surface)',
    }}>
      <h3 style={{ margin: '0 0 var(--chs-space-6) 0', fontSize: 'var(--chs-text-md)', fontWeight: 'var(--chs-weight-semibold)', color: 'var(--chs-color-text)' }}>
        {isEdit ? `Набор полей «${editingDef.display_name}»` : 'Новый набор полей'}
      </h3>

      {!isEdit && (
        <div style={{ display: 'flex', gap: 'var(--chs-space-6)', marginBottom: 'var(--chs-space-6)' }}>
          <div style={{ flex: 1 }}>
            <Field
              label="Слаг набора полей"
              mono
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="my-registry"
              invalid={Boolean(metaErrs.slug)}
            />
            {metaErrs.slug && <span style={errStyle}>{metaErrs.slug}</span>}
          </div>
          <div style={{ flex: 1 }}>
            <Field
              label="Название набора полей"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Мой набор полей"
              invalid={Boolean(metaErrs.display_name)}
            />
            {metaErrs.display_name && <span style={errStyle}>{metaErrs.display_name}</span>}
          </div>
        </div>
      )}

      {fields.length > 0 && (
        <div role="table" aria-label="Поля набора">
          {/* Column header (grid, aligned with each FieldRow's columns). */}
          <div style={{
            display: 'grid', gridTemplateColumns: editorGridCols, gap: 'var(--chs-space-4)',
            padding: '0 0 var(--chs-space-3) 0', borderBottom: '1px solid var(--chs-color-border)',
          }}>
            <span style={colHeadStyle}>Ключ</span>
            <span style={colHeadStyle}>Тип</span>
            <span style={colHeadStyle}>Название</span>
            <span style={{ ...colHeadStyle, textAlign: 'center' }}>Обяз.</span>
            <span style={{ ...colHeadStyle, textAlign: 'right' }}>Порядок</span>
          </div>
          {fields.map((f, i) => (
            <FieldRow
              key={i}
              field={f}
              errors={fieldErrs[i] || {}}
              index={i}
              count={fields.length}
              onChange={(next) => updateField(i, next)}
              onMove={moveField}
              onRemove={removeField}
              registryDefs={allRegistryDefs}
              registryDefsLoading={allRegistryDefsLoading}
              registryDefsError={allRegistryDefsError}
            />
          ))}
        </div>
      )}

      {fields.length === 0 && (
        <p style={{ margin: 'var(--chs-space-5) 0', color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
          Пока нет полей. Добавьте первое.
        </p>
      )}

      <div style={{ marginTop: 'var(--chs-space-5)' }}>
        <Button type="button" variant="ghost" size="sm" glyph={<KitIcon name="plus" />} onClick={addField}>Добавить поле</Button>
      </div>

      {formErr && <div style={{ ...errStyle, marginTop: 'var(--chs-space-5)', fontSize: 'var(--chs-text-sm)' }}>{formErr}</div>}

      {submitErr && (
        <div role="alert" style={{
          marginTop: 'var(--chs-space-6)', padding: 'var(--chs-space-4) var(--chs-space-5)',
          background: 'var(--chs-color-danger-soft)',
          border: '1px solid var(--chs-color-danger)',
          borderRadius: 'var(--chs-radius-3)', fontSize: 'var(--chs-text-sm)',
          color: 'var(--chs-color-text)',
        }}>
          {submitErr}
        </div>
      )}

      {warnings && (
        <div style={{
          marginTop: 'var(--chs-space-6)', padding: 'var(--chs-space-4) var(--chs-space-5)',
          background: 'var(--chs-color-warning-soft)',
          border: '1px solid var(--chs-color-warning)',
          borderRadius: 'var(--chs-radius-3)', fontSize: 'var(--chs-text-sm)',
          color: 'var(--chs-color-text)',
        }}>
          Сохранено. Затронуты зависимые отчёты ({warnings.length}) — проверьте их.
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--chs-space-5)', justifyContent: 'flex-end', marginTop: 'var(--chs-space-7)' }}>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Отмена</Button>
        <Button type="submit" variant="primary" size="sm" loading={submitting}>
          {submitting ? 'Сохранение…' : isEdit ? 'Сохранить поля' : 'Создать набор'}
        </Button>
      </div>
    </form>
  );
}

function AppSchemaScreen() {
  const { appId } = useParams();
  const navigate = useNavigate();
  const [defs, setDefs] = useState(null);   // null = loading, [] = none, [...] = list
  const [error, setError] = useState(null);
  const [app, setApp] = useState(null);     // resolved application meta (for crumb/title)
  const [editing, setEditing] = useState(undefined); // undefined = closed; null = create; def = edit

  const load = useCallback(async () => {
    if (!appId) { setError('Не указано приложение'); return; }
    setError(null);
    try {
      const res = await fetch(
        `/api/registry-defs?application_id=${encodeURIComponent(appId)}`,
        { headers: devHeaders() },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDefs(Array.isArray(data.registry_defs) ? data.registry_defs : []);
    } catch (e) {
      setError(e.message);
    }
  }, [appId]);

  // Best-effort: resolve the application's display_name for the header (the
  // applications list is small; a 404/error just leaves the id shown).
  const loadApp = useCallback(async () => {
    if (!appId) return;
    try {
      const res = await fetch('/api/applications', { headers: devHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      const found = (data.applications || []).find((a) => a.id === appId);
      if (found) setApp(found);
    } catch { /* header is cosmetic — ignore */ }
  }, [appId]);

  useEffect(() => { load(); loadApp(); }, [load, loadApp]);

  const handleSaved = useCallback(() => {
    setEditing(undefined);
    load();
  }, [load]);

  const list = defs || [];

  return (
    <div className="chs-inbox">
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--chs-space-5)',
        padding: 'var(--chs-space-5) var(--chs-space-6)',
        borderBottom: '1px solid var(--chs-color-border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-5)', minWidth: 0 }}>
          {/* Up-navigation: a non-sidebar exit back to the applications list. */}
          <Button variant="ghost" size="sm" onClick={() => navigate('/apps')}>
            ← к приложениям
          </Button>
          <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Поля приложения {app ? `«${app.display_name}»` : ''}
            {defs !== null ? ` · наборов полей: ${list.length}` : ''}
          </span>
        </div>
        {editing === undefined && (
          <Button variant="primary" size="sm" glyph={<KitIcon name="plus" />} onClick={() => setEditing(null)}>
            Новый набор полей
          </Button>
        )}
      </div>

      <div className="chs-inbox__scroll" style={{ padding: 'var(--chs-space-6)' }}>
        {editing !== undefined ? (
          <FieldEditor
            applicationId={appId}
            editingDef={editing}
            onSaved={handleSaved}
            onCancel={() => setEditing(undefined)}
          />
        ) : null}

        {/* While the inline editor is open, hide the list / empty-state below so
            the editor doesn't compete with a stale list (task #3). */}
        {editing !== undefined ? null : error ? (
          <ErrorState message={`Не удалось загрузить наборы полей: ${error}`} onRetry={load} />
        ) : defs === null ? (
          <LoadingState label="Загрузка наборов полей…" />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<KitIcon name="inbox" size={28} />}
            title="У приложения пока нет наборов полей"
            description="Создайте первый и определите его поля."
            action={
              <Button variant="primary" glyph={<KitIcon name="plus" />} onClick={() => setEditing(null)}>Новый набор полей</Button>
            }
          />
        ) : list.length > 0 ? (
          <table className="chs-itable">
            <colgroup>
              <col style={{ width: 'auto' }} />
              <col style={{ width: '180px' }} />
              <col style={{ width: '90px' }} />
              <col style={{ width: '80px' }} />
              <col style={{ width: '120px' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Набор полей</th>
                <th>Слаг</th>
                <th>Полей</th>
                <th>Версия</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((def) => {
                const props = def.record_schema && typeof def.record_schema === 'object'
                  ? def.record_schema.properties : null;
                const fieldCount = props && typeof props === 'object' ? Object.keys(props).length : 0;
                return (
                  <tr key={def.id}>
                    <td>
                      <div className="chs-task">
                        <span className="chs-task__txt">
                          <span className="chs-task__name">{def.display_name}</span>
                          {def.description && <span className="chs-task__step">{def.description}</span>}
                        </span>
                      </div>
                    </td>
                    <td><MonoId>{def.slug}</MonoId></td>
                    <td>{fieldCount}</td>
                    <td><StatusChip status="waiting" label={`v${def.record_schema_version}`} /></td>
                    <td>
                      <Button variant="secondary" size="sm" onClick={() => setEditing(def)}>
                        Изменить
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  );
}

export default AppSchemaScreen;
