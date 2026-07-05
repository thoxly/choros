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
  useToasts, ToastViewport,
} from '../components/components.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';
import { validateAppForm } from './apps-validate.js';
import { resolveRelationTarget, slugFromName } from '../forms/relation-cascade.js';
import { SlugField } from '../components/slug-field.jsx';
import {
  FIELD_TYPES,
  COLLECTION_SUB_FIELD_TYPES,
  ROLLUP_OPS,
  COMPUTED_MODES,
  formulaEligibleSiblings,
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
 * T-0450 Fix 1 (G3 BLOCKING): when a column's type is «select», a
 * «Варианты (по одному на строку)» textarea is rendered in a full-width
 * sub-row below the column controls — mirrors the top-level select-options
 * pattern (FieldRow / T-0294). Without options the cell `<select>` would have
 * zero choices → a required cell that can never be filled (dead path).
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
          {subFields.map((sf, i) => {
            // T-0450 Fix 1: options text ↔ array conversion (mirrors top-level pattern).
            const sfOptionsText = Array.isArray(sf.options) ? sf.options.join('\n') : '';
            const setSfOptionsFromText = (text) => {
              updateCol(i, { options: text.split('\n') });
            };
            return (
              <React.Fragment key={i}>
                <div role="group" aria-label={`Колонка ${i + 1}`} style={subFieldRowGrid}>
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
                {/* T-0450 Fix 1 (G3 BLOCKING): select-type column requires a variants
                    textarea so the author can supply options. Without options the cell
                    <select> in record-entry would be unfillable (only «— выберите —»).
                    Mirrors the top-level T-0294 select-options sub-row in FieldRow. */}
                {sf.type === 'select' && (
                  <div style={{ paddingLeft: 'var(--chs-space-3)', paddingBottom: 'var(--chs-space-3)', borderBottom: '1px solid var(--chs-color-border)', maxWidth: '380px' }}>
                    <span style={{ display: 'block', marginBottom: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                      Варианты (по одному на строку):
                    </span>
                    <textarea
                      className={inputCls(false)}
                      style={textareaStyle}
                      value={sfOptionsText}
                      onChange={(e) => setSfOptionsFromText(e.target.value)}
                      placeholder={'вариант_1\nвариант_2\nвариант_3'}
                      aria-label={`Варианты колонки ${sf.label || sf.key || i + 1}`}
                      rows={3}
                    />
                  </div>
                )}
              </React.Fragment>
            );
          })}
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
 * RollupConfigEditor — sub-row config for an «Итог» (computed/rollup) field.
 *
 * T-0452: allows the author to choose:
 *   - Считать по (source): a sibling collection field from the in-memory field list.
 *   - Операция (op): sum / count / avg / min / max.
 *   - Поле значения (value_field): numeric sub-field of the source (hidden for count).
 *   - Множитель (factor_field): optional numeric sub-field of the source.
 *
 * Honest empty: if no collection field exists in the list yet, a guide message
 * replaces the broken dropdowns (no collection = no rollup source = nothing to pick).
 *
 * All state is pushed up through onChange(patch) — same controlled pattern as
 * FieldRow / CollectionSubFieldEditor. No fetch — purely in-memory field list.
 *
 * Product language: no «rollup»/«computed» jargon — «Считать по»/«Операция»/«Множитель».
 * Kit: .chs-input, token vars only (G2, G6).
 *
 * @param {{ field, errors, allFields, onChange }} props
 */
function RollupConfigEditor({ field, errors, allFields, onChange }) {
  const set = (patch) => onChange({ ...field, ...patch });

  // Sibling collection fields available as sources (exclude self by key).
  const collectionFields = (Array.isArray(allFields) ? allFields : []).filter(
    (f) => f && f.type === 'collection' && f.key && f.key !== field.key,
  );

  // If no collection field exists yet — honest empty state.
  if (collectionFields.length === 0) {
    return (
      <div style={{
        marginTop: 'var(--chs-space-4)',
        padding: 'var(--chs-space-4)',
        border: '1px solid var(--chs-color-border)',
        borderRadius: 'var(--chs-radius-3)',
        background: 'var(--chs-color-surface-raised)',
      }}>
        <span style={{
          fontSize: 'var(--chs-text-xs)',
          color: 'var(--chs-color-text-muted)',
        }}>
          Сначала добавьте поле «Список строк», по которому считать
        </span>
      </div>
    );
  }

  // The selected source field (to derive numeric sub-field options).
  const sourceField = collectionFields.find((f) => f.key === field.rollupSource);
  const numericSubFields = sourceField && Array.isArray(sourceField.subFields)
    ? sourceField.subFields.filter((sf) => sf && (sf.type === 'number' || sf.type === 'integer'))
    : [];

  // When source changes, reset value_field and factor_field (stale keys would fail validation).
  const handleSourceChange = (newSource) => {
    set({ rollupSource: newSource, rollupValueField: '', rollupFactorField: '' });
  };

  // When op changes to 'count', clear value_field (not required for count).
  const handleOpChange = (newOp) => {
    const patch = { rollupOp: newOp };
    if (newOp === 'count') patch.rollupValueField = '';
    set(patch);
  };

  const needsValueField = field.rollupOp && field.rollupOp !== 'count';

  return (
    <div style={{
      marginTop: 'var(--chs-space-4)',
      paddingLeft: 'var(--chs-space-5)',
      borderLeft: '3px solid var(--chs-color-border)',
    }}
      aria-label="Настройка поля «Итог»"
    >
      <span style={{
        display: 'block', marginBottom: 'var(--chs-space-3)',
        fontSize: 'var(--chs-text-xs)', fontWeight: 'var(--chs-weight-semibold)',
        color: 'var(--chs-color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em',
      }}>
        Настройка итога
      </span>

      {/* Считать по — source collection field */}
      <div style={{ marginBottom: 'var(--chs-space-4)', maxWidth: '380px' }}>
        <Select
          label="Считать по"
          value={field.rollupSource || ''}
          onChange={(e) => handleSourceChange(e.target.value)}
          invalid={Boolean(errors.rollupSource)}
          placeholder="Выберите поле «Список строк»…"
          options={collectionFields.map((f) => ({
            value: f.key,
            label: f.title ? `${f.title} (${f.key})` : f.key,
          }))}
        />
        {errors.rollupSource && (
          <span style={errStyle}>{errors.rollupSource}</span>
        )}
      </div>

      {/* Операция — sum/count/avg/min/max */}
      <div style={{ marginBottom: 'var(--chs-space-4)', maxWidth: '380px' }}>
        <Select
          label="Операция"
          value={field.rollupOp || ''}
          onChange={(e) => handleOpChange(e.target.value)}
          invalid={Boolean(errors.rollupOp)}
          placeholder="Выберите операцию…"
          options={ROLLUP_OPS.map((o) => ({ value: o.value, label: o.label }))}
        />
        {errors.rollupOp && (
          <span style={errStyle}>{errors.rollupOp}</span>
        )}
      </div>

      {/* Поле значения — numeric sub-field of source (hidden for count) */}
      {needsValueField && (
        <div style={{ marginBottom: 'var(--chs-space-4)', maxWidth: '380px' }}>
          <Select
            label="Поле значения"
            value={field.rollupValueField || ''}
            onChange={(e) => set({ rollupValueField: e.target.value })}
            invalid={Boolean(errors.rollupValueField)}
            placeholder={
              !field.rollupSource
                ? 'Сначала выберите поле-источник'
                : numericSubFields.length === 0
                  ? 'Нет числовых колонок в источнике'
                  : 'Выберите числовую колонку…'
            }
            disabled={!field.rollupSource || numericSubFields.length === 0}
            options={numericSubFields.map((sf) => ({
              value: sf.key,
              label: sf.label ? `${sf.label} (${sf.key})` : sf.key,
            }))}
          />
          {errors.rollupValueField && (
            <span style={errStyle}>{errors.rollupValueField}</span>
          )}
        </div>
      )}

      {/* Множитель (опц.) — optional numeric sub-field; only shown when source is chosen */}
      {field.rollupSource && (
        <div style={{ marginBottom: 'var(--chs-space-2)', maxWidth: '380px' }}>
          {/* Fix 2 (LOW): no placeholder prop here — placeholder renders a DISABLED
              <option value=""> which would conflict with the explicit
              {value:'', label:'— не использовать —'} option below (two value=""
              options; the default binds to the disabled one). The explicit empty
              option is selectable and is the correct «not set» affordance. */}
          <Select
            label="Множитель (необязательно)"
            value={field.rollupFactorField || ''}
            onChange={(e) => set({ rollupFactorField: e.target.value })}
            invalid={Boolean(errors.rollupFactorField)}
            disabled={numericSubFields.length === 0}
            options={numericSubFields.length === 0
              ? [{ value: '', label: 'Нет числовых колонок в источнике' }]
              : [
                { value: '', label: '— не использовать —' },
                ...numericSubFields.map((sf) => ({
                  value: sf.key,
                  label: sf.label ? `${sf.label} (${sf.key})` : sf.key,
                })),
              ]
            }
          />
          {errors.rollupFactorField && (
            <span style={errStyle}>{errors.rollupFactorField}</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * FormulaConfigEditor — sub-row config for an «Итог» field in FORMULA mode
 * (T-0580, alongside RollupConfigEditor's «Агрегат» mode).
 *
 * A single textarea for the expression, a reference list of eligible sibling
 * fields (O-5 autocomplete-lite: click inserts the key), and inline validation
 * via the SAME core parser/type-checker the server uses (apps-schema.js's
 * validateFormulaField — one grammar, ADR §2.6/§4 D2).
 *
 * Honest empty: if the application has NO scalar field eligible as an operand
 * yet (no number/integer/money/date/computed sibling), a guide message
 * replaces the textarea (mirrors RollupConfigEditor's empty state).
 *
 * Product language only (NF-7/G5): «формула», «поле» — never «AST», «eval»,
 * «parse error». Kit: .chs-input, token vars only (G2, G6).
 *
 * @param {{ field, errors, allFields, onChange }} props
 */
function FormulaConfigEditor({ field, errors, allFields, onChange }) {
  const set = (patch) => onChange({ ...field, ...patch });

  const siblings = formulaEligibleSiblings(allFields, field.key);

  if (siblings.length === 0) {
    return (
      <div style={{
        marginTop: 'var(--chs-space-4)',
        padding: 'var(--chs-space-4)',
        border: '1px solid var(--chs-color-border)',
        borderRadius: 'var(--chs-radius-3)',
        background: 'var(--chs-color-surface-raised)',
      }}>
        <span style={{
          fontSize: 'var(--chs-text-xs)',
          color: 'var(--chs-color-text-muted)',
        }}>
          Сначала добавьте числовое поле, поле «Сумма» или «Дата», по которому можно посчитать формулу
        </span>
      </div>
    );
  }

  const insertSiblingKey = (key) => {
    const current = field.formulaExpr || '';
    const needsSpace = current.length > 0 && !current.endsWith(' ') && !current.endsWith('(');
    set({ formulaExpr: `${current}${needsSpace ? ' ' : ''}${key}` });
  };

  return (
    <div style={{
      marginTop: 'var(--chs-space-4)',
      paddingLeft: 'var(--chs-space-5)',
      borderLeft: '3px solid var(--chs-color-border)',
    }}
      aria-label="Настройка формулы"
    >
      <span style={{
        display: 'block', marginBottom: 'var(--chs-space-3)',
        fontSize: 'var(--chs-text-xs)', fontWeight: 'var(--chs-weight-semibold)',
        color: 'var(--chs-color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em',
      }}>
        Настройка формулы
      </span>

      <div style={{ marginBottom: 'var(--chs-space-3)', maxWidth: '480px' }}>
        <span
          className="chs-label"
          style={{ display: 'block', marginBottom: 'var(--chs-space-2)' }}
        >
          Формула
        </span>
        <textarea
          className={inputCls(Boolean(errors.formulaExpr))}
          style={textareaStyle}
          value={field.formulaExpr || ''}
          onChange={(e) => set({ formulaExpr: e.target.value })}
          placeholder="Например: summa * (1 + nds_rate)"
          aria-label="Формула"
          aria-invalid={Boolean(errors.formulaExpr) || undefined}
          rows={3}
        />
        <span style={{
          display: 'block', marginTop: 'var(--chs-space-2)',
          fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)',
        }}>
          Поля записи по имени, операции + − * / ( ). Для дат: дата + число дней = дата; дата − дата = число дней.
        </span>
        {errors.formulaExpr && (
          <span style={errStyle}>{errors.formulaExpr}</span>
        )}
      </div>

      {/* O-5: clickable reference list of sibling fields — inserts the key at
          the end of the expression. Nice-to-have, not blocking (the formula
          validates regardless of whether this list was used). */}
      <div style={{ marginBottom: 'var(--chs-space-2)' }}>
        <span style={{
          display: 'block', marginBottom: 'var(--chs-space-2)',
          fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)',
        }}>
          Поля записи:
        </span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--chs-space-2)' }}>
          {siblings.map((s) => (
            <Button
              key={s.key}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => insertSiblingKey(s.key)}
              title={`Вставить «${s.key}»`}
            >
              {s.label}
            </Button>
          ))}
        </div>
      </div>
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
function FieldRow({ field, errors, index, count, onChange, onMove, onRemove, registryDefs, registryDefsLoading, registryDefsError, allFields, onCreateRelatedApp }) {
  const set = (patch) => onChange({ ...field, ...patch });

  // T-0463 [D8-G2]: inline "create related app" state for the relation picker.
  // When the desired relation target doesn't exist, the user names it here and
  // we cascade-create it (or link to an existing match) via onCreateRelatedApp.
  const [showCreateRelated, setShowCreateRelated] = useState(false);
  const [relatedName, setRelatedName] = useState('');
  const [creatingRelated, setCreatingRelated] = useState(false);
  const [relatedError, setRelatedError] = useState(null);
  const [relatedAsk, setRelatedAsk] = useState(null); // { candidates, question } when ambiguous

  const submitCreateRelated = async () => {
    setRelatedError(null);
    setRelatedAsk(null);
    if (!onCreateRelatedApp) return;
    setCreatingRelated(true);
    try {
      const r = await onCreateRelatedApp(relatedName);
      if (r && r.ok) {
        set({ targetRegistryId: r.targetRegistryId });
        setShowCreateRelated(false);
        setRelatedName('');
      } else if (r && r.ask) {
        // Ambiguous — surface candidates so the user disambiguates (PD-5, no guess).
        setRelatedAsk({ candidates: r.candidates || [], question: r.question || '' });
      } else {
        setRelatedError((r && r.error) || 'Не удалось создать связанное приложение');
      }
    } finally {
      setCreatingRelated(false);
    }
  };

  // T-0294: convert options array ↔ newline-separated string for the textarea.
  const optionsText = Array.isArray(field.options)
    ? field.options.join('\n')
    : (typeof field.options === 'string' ? field.options : '');
  const setOptionsFromText = (text) => {
    // Split on newlines; keep empty lines during editing (they're filtered on save).
    set({ options: text.split('\n') });
  };

  // T-0512: multi-select also shows the options textarea (same as select).
  const hasSubRow = field.type === 'select' || field.type === 'multi-select' || field.type === 'relation'
    || field.type === 'collection' || field.type === 'computed'
    || Boolean(errors.key) || Boolean(errors.type) || Boolean(errors.title)
    || Boolean(errors.options) || Boolean(errors.targetRegistryId)
    || Boolean(errors.rollupSource) || Boolean(errors.rollupOp)
    || Boolean(errors.rollupValueField) || Boolean(errors.rollupFactorField)
    || Boolean(errors.formulaExpr);

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
      {/* required — hidden for computed fields (a computed value is never stored
          in record.data so it can never satisfy a required constraint; T-0452). */}
      {field.type !== 'computed' ? (
        <label style={{ display: 'inline-flex', justifyContent: 'center', width: '100%' }}>
          <input
            type="checkbox"
            checked={Boolean(field.required)}
            onChange={(e) => set({ required: e.target.checked })}
            aria-label="Обязательное поле"
          />
        </label>
      ) : (
        <span style={{ display: 'inline-flex', justifyContent: 'center', width: '100%' }} />
      )}
      {/* reorder / remove */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', whiteSpace: 'nowrap' }}>
        <Button type="button" variant="ghost" size="sm" disabled={index === 0}
          onClick={() => onMove(index, index - 1)} title="Вверх" aria-label="Переместить вверх"><KitIcon name="arrow-up" /></Button>
        <Button type="button" variant="ghost" size="sm" disabled={index === count - 1}
          onClick={() => onMove(index, index + 1)} title="Вниз" aria-label="Переместить вниз"><KitIcon name="arrow-down" /></Button>
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
          {/* T-0512: multi-select reuses the same options textarea as select */}
          {(field.type === 'select' || field.type === 'multi-select') && (
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
                aria-label={field.type === 'multi-select' ? 'Варианты мультивыбора' : 'Варианты select'}
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
                  Пока не создано ни одного набора полей, на который можно сослаться — создайте связанное приложение ниже
                </span>
              )}
              {errors.targetRegistryId && (
                <span style={errStyle}>{errors.targetRegistryId}</span>
              )}

              {/* T-0463 [D8-G2]: "create related app" — when the target doesn't
                  exist, the user names it and we cascade-create (or link to a
                  dedup match). Same primitive the bot uses (Развилка-5). */}
              {!showCreateRelated && onCreateRelatedApp && (
                <div style={{ marginTop: 'var(--chs-space-3)' }}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    glyph={<KitIcon name="plus" />}
                    onClick={() => { setShowCreateRelated(true); setRelatedError(null); setRelatedAsk(null); }}
                  >
                    Нужного приложения нет — создать связанное
                  </Button>
                </div>
              )}
              {showCreateRelated && (
                <div style={{ marginTop: 'var(--chs-space-3)', padding: 'var(--chs-space-4)', border: '1px dashed var(--chs-color-border)', borderRadius: 'var(--chs-radius-3)' }}>
                  <span style={{ display: 'block', marginBottom: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                    Название связанного приложения (создастся в том же черновике; если уже есть похожее — свяжем с ним):
                  </span>
                  <input
                    className={inputCls(false)}
                    value={relatedName}
                    onChange={(e) => setRelatedName(e.target.value)}
                    placeholder="Например: Контрагенты"
                    aria-label="Название связанного приложения"
                  />
                  {relatedAsk && (
                    <div style={{ marginTop: 'var(--chs-space-2)' }}>
                      <span style={{ ...errStyle, color: 'var(--chs-color-text-muted)' }}>{relatedAsk.question}</span>
                      {(relatedAsk.candidates || []).map((c) => (
                        <div key={c.id} style={{ marginTop: 'var(--chs-space-2)' }}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => { set({ targetRegistryId: c.id }); setShowCreateRelated(false); setRelatedName(''); setRelatedAsk(null); }}
                          >
                            Связать с «{c.displayName}»
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  {relatedError && <span style={errStyle}>{relatedError}</span>}
                  <div style={{ display: 'flex', gap: 'var(--chs-space-3)', marginTop: 'var(--chs-space-3)' }}>
                    <Button type="button" variant="primary" size="sm" disabled={creatingRelated || !relatedName.trim()} onClick={submitCreateRelated}>
                      {creatingRelated ? 'Создание…' : 'Создать и связать'}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" disabled={creatingRelated} onClick={() => { setShowCreateRelated(false); setRelatedError(null); setRelatedAsk(null); }}>
                      Отмена
                    </Button>
                  </div>
                </div>
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
          {/* T-0452/T-0580: config for «Итог» (computed) type — TWO modes.
              «Агрегат» → RollupConfigEditor (source collection + op, T-0452).
              «Формула» → FormulaConfigEditor (scalar expression, T-0580).
              The switch itself lives HERE (not inside either editor) so
              switching modes is a single, obvious control shared by both. */}
          {field.type === 'computed' && (
            <div style={{ marginTop: 'var(--chs-space-4)' }}>
              <div style={{ maxWidth: '380px' }}>
                <Select
                  label="Режим"
                  value={field.computedMode === 'formula' ? 'formula' : 'rollup'}
                  onChange={(e) => set({ computedMode: e.target.value })}
                  options={COMPUTED_MODES.map((m) => ({ value: m.value, label: m.label }))}
                />
              </div>
              {field.computedMode === 'formula' ? (
                <FormulaConfigEditor
                  field={field}
                  errors={errors}
                  allFields={Array.isArray(allFields) ? allFields : []}
                  onChange={set}
                />
              ) : (
                <RollupConfigEditor
                  field={field}
                  errors={errors}
                  allFields={Array.isArray(allFields) ? allFields : []}
                  onChange={set}
                />
              )}
            </div>
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
  // T-0650 [UX-study §7]: SlugField dirty flag — true once the user clicked
  // «изменить»; while false the slug is NOT sent (server auto-generates from
  // displayName). Existing defs are always "touched" (their slug is immutable
  // post-creation — SlugField renders it locked, see below).
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [displayName, setDisplayName] = useState(editingDef?.display_name || '');
  const [fields, setFields] = useState(() =>
    isEdit ? parseRecordSchema(editingDef.record_schema) : [blankField()]
  );
  const [fieldErrs, setFieldErrs] = useState([]);
  const [formErr, setFormErr] = useState(null);     // field-list-level message
  const [metaErrs, setMetaErrs] = useState({});      // { slug?, display_name? }
  const [submitErr, setSubmitErr] = useState(null);  // general API error
  // T-0526: undo-тосты для удаления полей (сайт 15, черновик)
  const { toasts: schemaToasts, push: pushSchemaToast, dismiss: dismissSchemaToast } = useToasts();
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
    // Сайт 15: удаление поля из черновика схемы — undo-тост (5 с).
    setFields((prev) => {
      const removed = prev[i];
      const next = prev.filter((_, idx) => idx !== i);
      if (removed) {
        const toastId = pushSchemaToast({
          tone: 'success',
          title: 'Поле удалено',
          message: removed.title || removed.key || 'Поле',
          duration: 5000,
          action: (
            <button
              type="button"
              className="chs-toast__undo"
              onClick={() => {
                setFields((cur) => {
                  const copy = [...cur];
                  copy.splice(Math.min(i, copy.length), 0, removed);
                  return copy;
                });
                dismissSchemaToast(toastId);
              }}
            >
              Отменить
            </button>
          ),
        });
      }
      return next;
    });
  }, [pushSchemaToast, dismissSchemaToast]);
  const addField = useCallback(() => {
    setFields((prev) => [...prev, blankField()]);
  }, []);

  // T-0463 [D8-G2]: create a RELATED application + section as the relation target
  // when the desired target doesn't exist yet — the SECOND driver of the cascade
  // primitive. Dedups against the existing list (resolveRelationTarget):
  //   - existing match → returns its id (no duplicate app, LINK).
  //   - ambiguous      → returns { ask } so the caller can disambiguate.
  //   - none           → POST /api/applications + /api/registry-defs, returns new id.
  // Returns { ok, targetRegistryId } | { ask, candidates } | { error }.
  const createRelatedApp = useCallback(async (desiredName) => {
    const name = String(desiredName || '').trim();
    if (!name) return { error: 'Укажите название связанного приложения' };

    // Build dedup candidates from the already-fetched tenant registry_defs.
    const candidates = (allRegistryDefs || []).map((d) => ({
      id: d.id, slug: d.slug, displayName: d.display_name || d.slug,
    }));
    // depth=1: a top-level relation creating one related app is at depth 1 (≤ HOP_CAP).
    const decision = resolveRelationTarget({ targetDisplayName: name }, candidates, 1);

    if (decision.decision === 'link') {
      return { ok: true, targetRegistryId: decision.targetRegistryId };
    }
    if (decision.decision === 'ask') {
      return { ask: true, candidates: decision.candidates, question: decision.question };
    }
    if (decision.decision === 'hop_cap_exceeded') {
      return { error: `Слишком глубокий каскад связей (макс. ${decision.cap})` };
    }

    // decision === 'create' → POST the related app, then its primary section.
    try {
      const appSlug = decision.appSlug || slugFromName(name);
      const appRes = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...devHeaders() },
        body: JSON.stringify({ slug: appSlug, display_name: name }),
      });
      if (appRes.status !== 201) {
        const parsed = await appRes.json().catch(() => null);
        return { error: parsed?.message || `Не удалось создать приложение (HTTP ${appRes.status})` };
      }
      const createdApp = await appRes.json();
      const regRes = await fetch('/api/registry-defs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...devHeaders() },
        body: JSON.stringify({
          application_id: createdApp.id,
          slug: appSlug,
          display_name: name,
          record_schema: { type: 'object', properties: {} },
        }),
      });
      if (regRes.status !== 201 && regRes.status !== 200) {
        const parsed = await regRes.json().catch(() => null);
        return { error: parsed?.message || `Не удалось создать набор полей (HTTP ${regRes.status})` };
      }
      const createdReg = await regRes.json();
      // Refresh the dropdown list so the new app appears as a selectable target.
      setAllRegistryDefs((prev) => [...prev, createdReg]);
      return { ok: true, targetRegistryId: createdReg.id };
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  }, [allRegistryDefs]);

  const handleSubmit = useCallback(async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setSubmitErr(null); setWarnings(null);

    // Validate field list (pure module — same shape the server's AJV checks).
    const fv = validateFields(fields);
    setFieldErrs(fv.fieldErrors);
    setFormErr(fv.formError);

    // For CREATE also validate slug/display_name (mirror of apps-validate).
    // T-0650: slug is only sent (and only grammar-validated) when touched —
    // untouched means "let the server auto-generate from displayName".
    let metaOk = true;
    if (!isEdit) {
      const mv = validateAppForm({ slug: slugTouched ? slug : '', display_name: displayName });
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
        const createBody = {
          application_id: applicationId,
          display_name: displayName,
          record_schema: recordSchema,
        };
        if (slugTouched && slug.trim().length > 0) createBody.slug = slug;
        res = await fetch('/api/registry-defs', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...devHeaders() },
          body: JSON.stringify(createBody),
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
  }, [fields, isEdit, slug, slugTouched, displayName, applicationId, editingDef, onSaved]);

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
              label="Название набора полей"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Мой набор полей"
              invalid={Boolean(metaErrs.display_name)}
            />
            {metaErrs.display_name && <span style={errStyle}>{metaErrs.display_name}</span>}
          </div>
          <div style={{ flex: 1 }}>
            <SlugField
              label="Слаг набора полей"
              name={displayName}
              value={slug}
              onChange={setSlug}
              touched={slugTouched}
              onTouch={(preview) => { setSlugTouched(true); setSlug(preview); }}
              error={metaErrs.slug}
            />
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
              allFields={fields}
              onCreateRelatedApp={createRelatedApp}
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
      <ToastViewport toasts={schemaToasts} dismiss={dismissSchemaToast} />
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
          <Button variant="ghost" size="sm" onClick={() => navigate('/apps')} glyph={<KitIcon name="arrow-left" className="chs-btn__glyph" />}>
            к приложениям
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
