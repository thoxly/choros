/* ============================================================================
   CHOROS — screen-app-records.jsx
   ЭКРАН: КОНСТРУКТОР · Записи приложения (E13, T-0267).

   ТО, РАДИ ЧЕГО СТРОИЛСЯ ВЕСЬ КОНСТРУКТОР: момент, когда приложение начинает
   ХРАНИТЬ РЕАЛЬНЫЕ ДАННЫЕ из UI. Замыкает вертикаль:
     создать приложение (T-0265) → определить поля (T-0266) → ВНЕСТИ ЗАПИСИ (здесь).

   Поток:
     • грузим реестры приложения — GET /api/registry-defs?application_id= (T-0263);
         0 реестров → пустое состояние «сначала определите поля» (ссылка в
           конструктор полей /app-schema/:appId);
         1 реестр   → он и есть governing;
         >1 реестров → даём выбрать, и ПЕРЕДАЁМ registry_def_id в POST (иначе 409);
     • грузим записи — GET /api/records?application_id=&registry_def_id= (T-0264),
         таблица: колонки из record_schema (key/title) + «Создано»;
     • «Создать запись» → ДИНАМИЧЕСКАЯ форма, СГЕНЕРИРОВАННАЯ из record_schema
         выбранного реестра: по одному полю на properties, тип ввода по типу поля
         (text/number/checkbox), маркер «обяз.» из required[];
     • submit → POST /api/records { application_id, registry_def_id, data } с ПРАВИЛЬНО
         типизированными значениями (числа — числами, булевы — булевыми: сервер
         валидирует AJV). 201 → обновляем список + подсвечиваем новую строку.
       Ошибки честно: 400 → деталь валидации (по возможности inline под полем),
         409 → «выберите реестр полей», 404/401 → честные сообщения.

   Fetch-контракт (FROZEN):
     GET  /api/registry-defs?application_id=  → { registry_defs: [...] }       (T-0263)
     GET  /api/records?application_id=&registry_def_id=  → { records: [...] }  (T-0264)
     POST /api/records  body { application_id, registry_def_id?, data }
            → 201 { id, application_id, registry_def_id, record_schema_version, data, created_at, updated_at }
            → 400 VALIDATION · 401 · 404 · 409 CONFLICT (>1 реестр) · 403 FIELD_WRITE_FORBIDDEN

   Вся нетривиальная логика (схема→поля формы, типизация/сериализация значений,
   маппинг ошибок) вынесена в чистый модуль records-form.js и покрыта unit-тестами.
   Авторизация — devHeaders() (X-Dev-User), как у остальных экранов.

   OBLIK (T-0302): динамические поля через .chs-input (видимый ввод в ОБЕИХ темах
   через реальные --chs-color-* токены, без несуществующих --chs-bg-primary/
   --chs-border). Ноль хардкода цвета (G6).

   OBLIK (T-0319): «Создать запись» — через правый kit <Drawer> (не <Modal>).
   Форма генерирует НЕОГРАНИЧЕННОЕ число полей из record_schema; модал плохо
   скроллится на 20+ полях и прячет таблицу записей. Боковая панель держит таблицу
   на виду (прецедент — TaskDetail-drawer инбокса) и скроллится естественно;
   Отмена/«Создать запись» — в footer-слот Drawer. Де-жаргон: «реестр» в видимом
   тексте → «набор полей»/«Данные»/«Запись» (словарь конструктора).
   ============================================================================ */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Button, Mono, Drawer, EmptyState, ErrorState, LoadingState, KitIcon, Select, ConfirmDialog,
} from '../components/components.jsx';
import { useToastContext } from '../app-shell/toast-context.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';
import {
  schemaToFormFields,
  schemaToColumns,
  blankRecordValues,
  recordDataToValues,
  validateRecordValues,
  serializeRecordData,
  formatCellValue,
  RELATION_CELL_ASYNC,
  deriveRecordLabel,
  mapRecordError,
  extractFieldErrors,
  computeRollup,
} from './records-form.js';
// T-0581 (view registry) FR-4: the "Настроить список" panel + view-switcher.
// The autogen table below IS the synthetic default view (ADR §3.3) — the
// panel/switcher are an ADDITIVE layer on top of the same fetch, never a
// second parallel read-path (FF-VR-1).
import { ListViewPanel, ViewSwitcher, useListViews } from './list-view-panel.jsx';
import { buildFieldCatalog } from './list-view-panel.js';
// T-0399/T-0480 [D7-K]: record-entry fields render through the ONE unified
// renderer (catalog-driven). FieldControl draws the scalar/enum controls;
// structural contracts (relation/collection/rollup) dispatch to their dedicated
// editors below — keyed off the SAME binding-contract catalog via
// resolveFieldContract, NOT a parallel `inputKind` string chain (spec §2).
import { FieldControl } from '../forms/field-renderer.jsx';
import { resolveFieldContract } from '../forms/field-contract.js';

// ---------------------------------------------------------------------------
// T-0446: RelationPicker — searchable picker for a relation field.
//
// Fetches GET /api/records?registry_def_id=<targetRegistryId> and renders a
// filterable <select> whose options are the target registry's records. The
// stored value is the target record's UUID. Label derivation: the first
// non-empty string value found in record.data (schema-order); if none, falls
// back to the first 8 chars of the id. Honest states: Loading / Error / Empty
// ("В целевом наборе пока нет записей") per OBLIK principles.
//
// Only the create-form picker is implemented here. Display of an existing
// relation value as a label in list/detail views is T-0447.
// ---------------------------------------------------------------------------

/**
 * RelationPicker renders a field wrapper (label + control + error) for a
 * relation field. It owns the async fetch of the target registry's records and
 * renders honest Loading / Error / Empty states. The control itself is a
 * text-filtered select so the user can search by typing.
 *
 * @param {{ key, label, required }} field
 * @param {string} value  current value (record UUID or "")
 * @param {(key, value) => void} onChange
 * @param {string|undefined} error  per-field validation error
 * @param {string} idPrefix
 */
function RelationPicker({ field, value, onChange, error, idPrefix = 'field' }) {
  const id = `${idPrefix}-${field.key}`;
  const label = field.label || field.title || field.key;
  const isRequired = Boolean(field.required);
  const invalid = Boolean(error);

  const [candidates, setCandidates] = useState(null); // null=loading, []=empty, [...]
  const [fetchError, setFetchError] = useState(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!field.targetRegistryId) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    setCandidates(null);
    setFetchError(null);
    fetch(
      `/api/records?registry_def_id=${encodeURIComponent(field.targetRegistryId)}`,
      { headers: devHeaders() },
    )
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setCandidates(Array.isArray(data.records) ? data.records : []);
      })
      .catch((err) => {
        if (!cancelled) setFetchError(String(err?.message || err));
      });
    return () => { cancelled = true; };
  }, [field.targetRegistryId]);

  const inputStyle = { display: 'block', width: '100%', boxSizing: 'border-box' };
  const inputClass = `chs-input${invalid ? ' chs-input--invalid' : ''}`;

  const labelNode = (
    <label className="chs-label" htmlFor={id}>
      {label}
      {isRequired && (
        <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
      )}
    </label>
  );
  const errorNode = error ? (
    <span style={{ display: 'block', marginTop: 'var(--chs-space-1)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}>
      {error}
    </span>
  ) : null;

  if (fetchError) {
    return (
      <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
        {labelNode}
        <div
          className="chs-input"
          style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}
          aria-live="polite"
        >
          Не удалось загрузить связанные записи
        </div>
        {errorNode}
      </div>
    );
  }

  if (candidates === null) {
    return (
      <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
        {labelNode}
        <div
          className="chs-input"
          style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontStyle: 'italic', fontSize: 'var(--chs-text-sm)' }}
          aria-live="polite"
        >
          Загрузка…
        </div>
        {errorNode}
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
        {labelNode}
        <div
          className="chs-input"
          style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}
        >
          В целевом наборе пока нет записей
        </div>
        {errorNode}
      </div>
    );
  }

  // Build display labels for all candidates.
  const labeled = candidates.map((rec) => ({
    id: rec.id,
    display: deriveRecordLabel(rec),
  }));

  // Filter candidates by the user's search text (case-insensitive, matches label or id prefix).
  const filterLower = filter.toLowerCase();
  const filtered = filterLower
    ? labeled.filter((c) => c.display.toLowerCase().includes(filterLower) || c.id.toLowerCase().startsWith(filterLower))
    : labeled;

  return (
    <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
      {labelNode}
      {/* Filter input for searching candidates — no raw id/UUID shown to users */}
      <input
        type="text"
        className="chs-input"
        placeholder="Поиск…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        aria-label={`Поиск: ${label}`}
        style={{ ...inputStyle, marginBottom: 'var(--chs-space-2)' }}
      />
      <select
        id={id}
        className={inputClass}
        value={value ?? ''}
        onChange={(e) => onChange(field.key, e.target.value)}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        style={inputStyle}
        size={Math.min(filtered.length + 1, 6)}
      >
        <option value="">— выберите запись —</option>
        {filtered.map((c) => (
          <option key={c.id} value={c.id}>{c.display}</option>
        ))}
      </select>
      {errorNode}
    </div>
  );
}

// ---------------------------------------------------------------------------
// T-0447: RelationCell — async table cell that resolves a UUID to a label+link.
//
// formatCellValue returns RELATION_CELL_ASYNC for a non-empty relation value
// (UUID string). The list renders this component instead of a plain <td> string.
// Resolution: GET /api/records/:targetId — fetches the target record directly
// and derives the label via deriveRecordLabel (first non-empty string/number).
//
// Honest states:
//   loading  → subtle italic placeholder (no spinner — avoids visual noise in lists)
//   resolved → label + navigable link to /apps/:targetAppId/records/:targetId
//   dangling/denied (404/403/error) → «— / Нет доступа» redacted sentinel (G5)
// ---------------------------------------------------------------------------

/**
 * Async table cell for a relation field value.
 *
 * @param {string} targetId   The UUID stored as the relation value.
 * @param {string} appId      The current app's id (used to build the link).
 */
function RelationCell({ targetId, appId }) {
  const [state, setState] = React.useState('loading'); // 'loading'|'resolved'|'denied'
  const [label, setLabel] = React.useState(null);

  React.useEffect(() => {
    if (!targetId) { setState('denied'); return; }
    let cancelled = false;
    setState('loading');
    fetch(`/api/records/${encodeURIComponent(targetId)}`, {
      headers: devHeaders(),
    })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404 || res.status === 403) {
          setState('denied');
          return;
        }
        if (!res.ok) { setState('denied'); return; }
        const data = await res.json();
        if (cancelled) return;
        // The target record may belong to a different app; use its application_id
        // (present on the enriched GET /api/records/:id response) to build the link.
        const targetAppId = data.application_id || appId;
        setLabel({ text: deriveRecordLabel(data), targetAppId });
        setState('resolved');
      })
      .catch(() => { if (!cancelled) setState('denied'); });
    return () => { cancelled = true; };
  }, [targetId, appId]);

  if (state === 'loading') {
    return (
      <span style={{ color: 'var(--chs-color-text-muted)', fontStyle: 'italic', fontSize: 'var(--chs-text-xs)' }}>
        …
      </span>
    );
  }

  if (state === 'denied' || !label) {
    // Redacted sentinel — mirrors CrossAppLinksPanel's denied-hop sentinel (T-0352).
    return (
      <span style={{ color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}>
        — / Нет доступа
      </span>
    );
  }

  // Resolved: label + link to the target record's detail page.
  return (
    <Link
      to={`/apps/${label.targetAppId}/records/${targetId}`}
      style={{ color: 'var(--chs-color-accent)', textDecoration: 'none' }}
      title={`Открыть запись ${targetId}`}
    >
      {label.text}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// T-0450: LineItemsField — row-table editor for a «Список строк» (collection)
// field in the record-entry form.
//
// Renders the current value (an array of row objects) as a table with:
//   • one column header per sub-field (its label);
//   • one editable cell per sub-field per row, rendered via FieldControl;
//   • an «Добавить строку» button (appends a blank row);
//   • a per-row «✕» remove button (drops the row by index);
//   • an honest Empty state when no rows exist yet (G4 no-dead-affordance).
//
// Consumes the T-0449 per-row error shape produced by validateRecordValues:
//   errors[fieldKey] = { rows: [ { [subKey]: "message" }, undefined, … ], _collection? }
// Each element of `rows` aligns to the same row index; `undefined` = no error.
// _collection carries a field-level message (e.g. «required but empty»).
//
// Product language: «Добавить строку», «Строк пока нет — добавьте первую».
// No «collection»/«sub-field»/«registry» jargon (G5).
// Token-only styling: all colors from --chs-color-* (G2, G6).
//
// Dispatch (T-0480): the `collection` catalog contract (resolveFieldContract)
// routes to this component; relation/rollup and scalar/enum route elsewhere.
// ---------------------------------------------------------------------------

/**
 * LineItemsField — repeatable-rows table for a collection field in record entry.
 *
 * @param {{ key, label, required, subFields: Array }} field  form-field descriptor (T-0449)
 * @param {Array<Record<string,unknown>>} value  current rows (may be empty)
 * @param {(key, value) => void} onChange  called with (field.key, nextRows)
 * @param {{ rows?: Array<Record<string,string>|undefined>, _collection?: string } | undefined} error
 * @param {string} [idPrefix]
 */
function LineItemsField({ field, value, onChange, error, idPrefix = 'field' }) {
  const rows = Array.isArray(value) ? value : [];
  const subFields = Array.isArray(field.subFields) ? field.subFields : [];
  const label = field.label || field.title || field.key;
  const isRequired = Boolean(field.required);

  // error shape: { rows?: Array<{[subKey]:string}|undefined>, _collection?: string }
  const rowErrors = (error && Array.isArray(error.rows)) ? error.rows : [];
  const collectionError = error && typeof error._collection === 'string' ? error._collection : null;

  const addRow = () => {
    // Append a blank row: boolean sub-fields start as false, others as ''.
    const blank = {};
    for (const sf of subFields) {
      blank[sf.key] = sf.type === 'boolean' ? false : '';
    }
    onChange(field.key, [...rows, blank]);
  };

  const removeRow = (rowIdx) => {
    onChange(field.key, rows.filter((_, i) => i !== rowIdx));
  };

  const setCellValue = (rowIdx, subKey, cellVal) => {
    const nextRows = rows.map((row, i) => {
      if (i !== rowIdx) return row;
      return { ...row, [subKey]: cellVal };
    });
    onChange(field.key, nextRows);
  };

  const labelStyle = {
    display: 'block',
    marginBottom: 'var(--chs-space-2)',
    fontSize: 'var(--chs-text-sm)',
    fontWeight: 'var(--chs-weight-semibold)',
    color: 'var(--chs-color-text)',
  };
  const errorStyle = {
    display: 'block',
    marginTop: 'var(--chs-space-1)',
    fontSize: 'var(--chs-text-xs)',
    color: 'var(--chs-color-danger)',
  };

  return (
    <div style={{ marginBottom: 'var(--chs-space-4)' }} aria-label={label}>
      {/* Field label */}
      <span style={labelStyle}>
        {label}
        {isRequired && (
          <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
        )}
      </span>

      {/* Field-level collection error (e.g. required but no rows) */}
      {collectionError && <span style={errorStyle}>{collectionError}</span>}

      {/* Row table — only rendered when there are rows OR sub-fields defined */}
      {rows.length > 0 && subFields.length > 0 && (
        <div style={{ overflowX: 'auto', marginBottom: 'var(--chs-space-3)' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 'var(--chs-text-sm)',
            }}
            aria-label={`Строки: ${label}`}
          >
            <thead>
              <tr>
                {subFields.map((sf) => (
                  <th
                    key={sf.key}
                    style={{
                      textAlign: 'left',
                      padding: 'var(--chs-space-2) var(--chs-space-3)',
                      fontSize: 'var(--chs-text-xs)',
                      fontWeight: 'var(--chs-weight-semibold)',
                      color: 'var(--chs-color-text-muted)',
                      borderBottom: '1px solid var(--chs-color-border)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {sf.label || sf.key}
                    {sf.required && (
                      <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
                    )}
                  </th>
                ))}
                {/* remove-row button column */}
                <th style={{ width: '36px', borderBottom: '1px solid var(--chs-color-border)' }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => {
                const rowErr = rowErrors[rowIdx];
                return (
                  <tr key={rowIdx}>
                    {subFields.map((sf) => {
                      const cellError = rowErr && rowErr[sf.key];
                      // Build a minimal field descriptor for FieldControl:
                      // it only needs key / label / type / required / options.
                      const cellField = {
                        key: sf.key,
                        label: sf.label || sf.key,
                        type: sf.type,
                        required: sf.required,
                        inputKind: sf.inputKind,
                        options: sf.options,
                      };
                      return (
                        <td
                          key={sf.key}
                          style={{
                            padding: 'var(--chs-space-2) var(--chs-space-3)',
                            verticalAlign: 'top',
                            borderBottom: '1px solid var(--chs-color-border)',
                          }}
                        >
                          {/* T-0450 Fix 2 (G7): hideLabel=true — the <th> column
                              header already provides the label; repeating it per-cell
                              stacks a "form in a form" and adds unwanted bottom margin
                              that breaks table rhythm. */}
                          <FieldControl
                            field={cellField}
                            value={row[sf.key] !== undefined ? row[sf.key] : (sf.type === 'boolean' ? false : '')}
                            onChange={(subKey, cellVal) => setCellValue(rowIdx, subKey, cellVal)}
                            error={cellError}
                            idPrefix={`${idPrefix}-${field.key}-row${rowIdx}`}
                            hideLabel
                          />
                        </td>
                      );
                    })}
                    <td
                      style={{
                        padding: 'var(--chs-space-2)',
                        verticalAlign: 'top',
                        borderBottom: '1px solid var(--chs-color-border)',
                        textAlign: 'right',
                      }}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeRow(rowIdx)}
                        title="Удалить строку"
                        aria-label={`Удалить строку ${rowIdx + 1}`}
                      >
                        <KitIcon name="close" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Honest empty state — G4: if there are no rows, tell the user + keep add button live */}
      {rows.length === 0 && (
        <p style={{
          margin: '0 0 var(--chs-space-3) 0',
          fontSize: 'var(--chs-text-xs)',
          color: 'var(--chs-color-text-muted)',
          fontStyle: 'italic',
        }}>
          Строк пока нет — добавьте первую
        </p>
      )}

      {/* Add-row button — always live (G3: no dead affordances) */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        glyph={<KitIcon name="plus" />}
        onClick={addRow}
      >
        Добавить строку
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// T-0453: ComputedReadout — read-only live readout for a computed/«Итог» field.
//
// Computes the rollup from the live form values (the source collection's current
// rows) and displays the result. Updates in real-time as the user edits the
// source line-items rows — no submit needed to see the aggregate.
//
// Contract:
//   - NEVER renders an editable input (G3: no dead affordances / misleading controls).
//   - Recomputes from `currentValues[field.rollupSource]` on every render.
//   - Displays «—» when no rows exist or all cells are non-numeric (null from computeRollup).
//   - Token-only colors (G2, G6); no hardcoded hex.
//
// Dispatch (T-0480): the `rollup` catalog contract (computed field, via
// resolveFieldContract) routes here; relation/collection and scalar/enum elsewhere.
// ---------------------------------------------------------------------------

/**
 * Read-only aggregate readout for a computed field in the record-entry drawer.
 *
 * @param {{ key, label, rollupSource, rollupOp, rollupValueField, rollupFactorField }} field
 * @param {Record<string, unknown>} currentValues  live form values (includes collection rows)
 */
function ComputedReadout({ field, currentValues }) {
  const label = field.label || field.title || field.key;
  const computed = computeRollup(field, currentValues);
  const display = formatCellValue(computed, 'computed');

  return (
    <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
      <span
        className="chs-label"
        style={{ display: 'block', marginBottom: 'var(--chs-space-2)' }}
      >
        {label}
        {/* Distinguish computed from editable fields visually */}
        <span
          aria-hidden="true"
          style={{
            marginLeft: 'var(--chs-space-2)',
            fontSize: 'var(--chs-text-xs)',
            color: 'var(--chs-color-text-muted)',
            fontWeight: 'normal',
          }}
        >
          (вычисляется)
        </span>
      </span>
      <div
        aria-live="polite"
        aria-readonly="true"
        style={{
          display: 'block',
          width: '100%',
          boxSizing: 'border-box',
          padding: 'var(--chs-space-2) var(--chs-space-3)',
          border: '1px solid var(--chs-color-border)',
          borderRadius: 'var(--chs-radius-2)',
          background: 'var(--chs-color-surface)',
          color: display === '—' ? 'var(--chs-color-text-muted)' : 'var(--chs-color-text)',
          fontSize: 'var(--chs-text-sm)',
          fontStyle: display === '—' ? 'italic' : 'normal',
          cursor: 'default',
          userSelect: 'text',
        }}
      >
        {display}
      </div>
    </div>
  );
}

// Anything at/below this is a seed/unset created_at, not a real date — render a
// dash instead of fabricating "1970-01-01" (principles.md §3, audit #7).
const EPOCH_FLOOR_MS = 24 * 60 * 60 * 1000; // ~1970-01-02

function fmtTs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < EPOCH_FLOOR_MS) return '—';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * CreateRecordDrawer — dynamic form generated from the chosen registry_def's
 * record_schema. One control per `properties` field; input type by field type
 * (text/number/checkbox); required markers from required[]. Values are typed +
 * serialized by records-form.js so the server's AJV validation passes.
 *
 * Rendered in a right-side kit <Drawer> (T-0319): the form can produce an
 * unbounded number of fields, which a modal scrolls badly; the drawer keeps the
 * records table visible and scrolls naturally. The kit Drawer owns the overlay,
 * focus-trap, Esc and scroll-lock — no hand-rolled overlay (gate G6).
 *
 * T-0568: the SAME drawer serves EDIT when `existingRecord` is passed — the form
 * is prefilled from the record's data (recordDataToValues) and submit does
 * PUT /api/records/:id (200) instead of POST (201). This reuses the entire
 * field renderer/validation/serialization stack rather than duplicating it.
 */
export function CreateRecordDrawer({ open, onClose, onCreated, applicationId, registryDef, existingRecord = null }) {
  const isEdit = Boolean(existingRecord && existingRecord.id);
  const formFields = useMemo(
    () => (registryDef ? schemaToFormFields(registryDef.record_schema) : []),
    [registryDef],
  );
  const [values, setValues] = useState(() => blankRecordValues(formFields));
  const [fieldErrors, setFieldErrors] = useState({}); // key → message
  const [submitErr, setSubmitErr] = useState(null);    // form-level message
  const [submitting, setSubmitting] = useState(false);

  // Reset the value state whenever the modal (re)opens or the schema changes.
  // T-0568: in edit mode, seed from the existing record's data instead of blank.
  useEffect(() => {
    if (open) {
      setValues(isEdit ? recordDataToValues(formFields, existingRecord.data) : blankRecordValues(formFields));
      setFieldErrors({});
      setSubmitErr(null);
      setSubmitting(false);
    }
  }, [open, formFields, isEdit, existingRecord]);

  const setVal = useCallback((key, v) => {
    setValues((prev) => ({ ...prev, [key]: v }));
  }, []);

  const handleSubmit = useCallback(async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setSubmitErr(null);

    const { valid, errors } = validateRecordValues(formFields, values);
    setFieldErrors(errors);
    if (!valid) return;

    const data = serializeRecordData(formFields, values);
    setSubmitting(true);
    try {
      // T-0568: EDIT → PUT /api/records/:id (200, body { data }); CREATE → POST (201).
      const res = isEdit
        ? await fetch(`/api/records/${encodeURIComponent(existingRecord.id)}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', ...devHeaders() },
            body: JSON.stringify({ data }),
          })
        : await fetch('/api/records', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...devHeaders() },
            body: JSON.stringify({ application_id: applicationId, registry_def_id: registryDef.id, data }),
          });
      const okStatus = isEdit ? 200 : 201;
      if (res.status === okStatus) {
        const saved = await res.json();
        onCreated(saved);
        return;
      }
      let parsed = null;
      try { parsed = await res.json(); } catch { /* ignore parse error */ }
      const mapped = mapRecordError(res.status, parsed);
      // Best-effort: attribute AJV detail to specific fields inline.
      if (res.status === 400) {
        const known = new Set(formFields.map((f) => f.key));
        const perField = extractFieldErrors(mapped.message, known);
        if (Object.keys(perField).length > 0) setFieldErrors((prev) => ({ ...prev, ...perField }));
      }
      setSubmitErr(mapped.message);
    } catch (err) {
      setSubmitErr(String(err?.message || err));
    } finally {
      setSubmitting(false);
    }
  }, [formFields, values, applicationId, registryDef, onCreated, isEdit, existingRecord]);

  const canSubmit = open && registryDef && formFields.length > 0;

  return (
    <Drawer
      open={Boolean(open && registryDef)}
      onClose={onClose}
      title={isEdit ? 'Изменить запись' : 'Новая запись'}
      side="right"
      footer={
        <>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Отмена</Button>
          <Button type="submit" form="create-record-form" variant="primary" size="sm" loading={submitting} disabled={!canSubmit}>
            {submitting ? 'Сохранение…' : (isEdit ? 'Сохранить' : 'Создать запись')}
          </Button>
        </>
      }
    >
      <form id="create-record-form" onSubmit={handleSubmit}>
        <p style={{ margin: '0 0 var(--chs-space-6) 0', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
          Набор полей «{registryDef ? registryDef.display_name : ''}». Поля сгенерированы из его схемы.
        </p>

        {formFields.length === 0 && (
          <p style={{ marginBottom: 'var(--chs-space-6)', color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
            В наборе полей нет полей. Определите их в конструкторе полей, затем добавляйте записи.
          </p>
        )}

        {/* T-0399/T-0480 [D7-K]: one catalog-driven dispatch per field. The
            binding-contract kind is resolved ONCE via resolveFieldContract (the
            single catalog authority), then routed:
              relation   → RelationPicker (async fetch of target records)
              collection → LineItemsField (repeatable row table)
              rollup     → ComputedReadout (read-only live aggregate)
              scalar/enum → FieldControl (the unified inline control: text /
                            number / checkbox / date / <select> with options)
            The structural editors need fetch/local state FieldControl must not
            own, so they stay as dedicated components — but they are selected by
            the SAME catalog the inbox renderer uses, closing the parallel
            `inputKind`-dictionary path (spec §2). */}
        {formFields.map((f) => {
          const { contractKind } = resolveFieldContract(f);
          if (contractKind === 'rollup') {
            return (
              <ComputedReadout key={f.key} field={f} currentValues={values} />
            );
          }
          if (contractKind === 'collection') {
            return (
              <LineItemsField
                key={f.key}
                field={f}
                value={values[f.key]}
                onChange={setVal}
                error={fieldErrors[f.key]}
                idPrefix="record-field"
              />
            );
          }
          if (contractKind === 'relation') {
            return (
              <RelationPicker
                key={f.key}
                field={f}
                value={values[f.key]}
                onChange={setVal}
                error={fieldErrors[f.key]}
                idPrefix="record-field"
              />
            );
          }
          return (
            <FieldControl
              key={f.key}
              field={f}
              value={values[f.key]}
              onChange={setVal}
              error={fieldErrors[f.key]}
              idPrefix="record-field"
            />
          );
        })}

        {submitErr && (
          <div role="alert" style={{
            marginTop: 'var(--chs-space-5)', padding: 'var(--chs-space-4) var(--chs-space-5)',
            background: 'var(--chs-color-danger-soft)',
            border: '1px solid var(--chs-color-danger)',
            borderRadius: 'var(--chs-radius-3)', fontSize: 'var(--chs-text-sm)',
            color: 'var(--chs-color-text)',
          }}>
            {submitErr}
          </div>
        )}
      </form>
    </Drawer>
  );
}

function AppRecordsScreen() {
  const { appId } = useParams();
  const navigate = useNavigate();
  const { push } = useToastContext();

  const [defs, setDefs] = useState(null);      // null = loading, [] = none, [...] = list
  const [defsError, setDefsError] = useState(null);
  const [app, setApp] = useState(null);        // resolved application meta (cosmetic header)
  const [selectedDefId, setSelectedDefId] = useState(null); // chosen registry_def id

  const [records, setRecords] = useState(null); // null = loading, [] = empty, [...] = list
  const [recordsError, setRecordsError] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [highlightId, setHighlightId] = useState(null);
  // T-0568: record pending confirm-delete (whole record row), + in-flight flag.
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  // T-0401: cursor-based pagination state for load-more.
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingMoreRecords, setLoadingMoreRecords] = useState(false);

  // T-0581 (view registry) FR-4: active saved view (null = synthetic default,
  // ADR §3.3 — byte-identical to pre-T-0581 behaviour, NF-2/AC-9) + panel open state.
  const [activeViewId, setActiveViewId] = useState(null);
  const [viewPanelOpen, setViewPanelOpen] = useState(false);

  // ---- load registry_defs for the application -----------------------------
  const loadDefs = useCallback(async () => {
    if (!appId) { setDefsError('Не указано приложение'); return; }
    setDefsError(null);
    try {
      const res = await fetch(
        `/api/registry-defs?application_id=${encodeURIComponent(appId)}`,
        { headers: devHeaders() },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data.registry_defs) ? data.registry_defs : [];
      setDefs(list);
      // Auto-select when exactly one; otherwise leave the picker to the user.
      setSelectedDefId((prev) => {
        if (list.length === 1) return list[0].id;
        if (prev && list.some((d) => d.id === prev)) return prev;
        return null;
      });
    } catch (e) {
      setDefsError(e.message);
    }
  }, [appId]);

  // Best-effort: resolve the application's display_name for the header.
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

  useEffect(() => { loadDefs(); loadApp(); }, [loadDefs, loadApp]);

  const selectedDef = useMemo(
    () => (defs || []).find((d) => d.id === selectedDefId) || null,
    [defs, selectedDefId],
  );

  // T-0581 (view registry): a saved view belongs to ONE набор полей — reset
  // to the default whenever the chosen набор полей changes.
  useEffect(() => { setActiveViewId(null); }, [selectedDefId]);

  // T-0581: fetch this набор полей' saved views + synthetic default (ADR §3.3).
  const {
    views: savedViews, defaultView: defaultViewConfig, error: viewsError,
    loading: viewsLoading, reload: reloadViews, saveView, deleteView,
  } = useListViews(selectedDefId, appId);

  const activeView = useMemo(
    () => (savedViews || []).find((v) => v.id === activeViewId) || null,
    [savedViews, activeViewId],
  );

  // T-0581 (view registry): a saved view is applied via ?view_id= — mutually
  // exclusive with inline ?filter=/?sort= on the server (ADR §4), so switching
  // to a saved view never sends inline params. The default (activeViewId=null)
  // keeps the request IDENTICAL to pre-T-0581 (NF-2/AC-9).
  const viewQuerySuffix = activeViewId ? `&view_id=${encodeURIComponent(activeViewId)}` : '';

  // ---- load records for the chosen registry_def ---------------------------
  // T-0401: consumes paginated response { records, nextCursor }. Initial load
  // resets the list; loadMoreRecords appends via ?after=<cursor>.
  const loadRecords = useCallback(async () => {
    if (!appId || !selectedDefId) { setRecords(null); setNextCursor(null); return; }
    setRecordsError(null);
    setRecords(null);
    setNextCursor(null);
    try {
      const res = await fetch(
        `/api/records?application_id=${encodeURIComponent(appId)}&registry_def_id=${encodeURIComponent(selectedDefId)}${viewQuerySuffix}`,
        { headers: devHeaders() },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRecords(Array.isArray(data.records) ? data.records : []);
      setNextCursor(data.nextCursor ?? null);
    } catch (e) {
      setRecordsError(e.message);
    }
  }, [appId, selectedDefId, viewQuerySuffix]);

  // T-0401: fetch the next cursor page and append to the existing list.
  // T-0581: re-sends the SAME view_id on every page — the server does not
  // embed it in the opaque cursor (records.ts resolves the view fresh per
  // request), so pagination would silently fall back to the default order
  // without this.
  const loadMoreRecords = useCallback(async () => {
    if (!appId || !selectedDefId || !nextCursor || loadingMoreRecords) return;
    setLoadingMoreRecords(true);
    try {
      const res = await fetch(
        `/api/records?application_id=${encodeURIComponent(appId)}&registry_def_id=${encodeURIComponent(selectedDefId)}&after=${encodeURIComponent(nextCursor)}${viewQuerySuffix}`,
        { headers: devHeaders() },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRecords((prev) => [...(prev || []), ...(Array.isArray(data.records) ? data.records : [])]);
      setNextCursor(data.nextCursor ?? null);
    } catch (e) {
      setRecordsError(e.message);
    } finally {
      setLoadingMoreRecords(false);
    }
  }, [appId, selectedDefId, nextCursor, loadingMoreRecords, viewQuerySuffix]);

  useEffect(() => { loadRecords(); }, [loadRecords]);

  const handleCreated = useCallback((created) => {
    setCreateOpen(false);
    if (created && created.id) setHighlightId(created.id);
    loadRecords();
  }, [loadRecords]);

  // T-0568: confirm-gated record delete. DELETE /api/records/:id (T-0566 frozen
  // contract → 204 deleted / 404 already-gone — both settle to "drop the row").
  // Removes the row locally on success + a toast; failures surface an error toast
  // and leave the row in place.
  const confirmDelete = useCallback(async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/records/${encodeURIComponent(toDelete.id)}`, {
        method: 'DELETE',
        headers: devHeaders(),
      });
      if (res.status === 204 || res.status === 404) {
        setRecords((prev) => (prev || []).filter((r) => r.id !== toDelete.id));
        setToDelete(null);
        push({ tone: 'success', message: 'Запись удалена' });
      } else {
        push({ tone: 'error', title: 'Не удалось удалить запись', message: `HTTP ${res.status}` });
      }
    } catch (e) {
      push({ tone: 'error', title: 'Не удалось удалить запись', message: String(e?.message || e) });
    } finally {
      setDeleting(false);
    }
  }, [toDelete, push]);

  const schemaColumns = useMemo(
    () => (selectedDef ? schemaToColumns(selectedDef.record_schema) : []),
    [selectedDef],
  );

  // T-0581 (view registry) FR-2 §1: apply the active view's (or synthetic
  // default's) column visibility + order + width on top of the schema-derived
  // column catalog. No saved/default config yet (still loading) → fall back to
  // schemaColumns unfiltered — byte-identical to pre-T-0581 (NF-2/AC-9).
  const columns = useMemo(() => {
    const viewConfig = (activeView && activeView.config) || defaultViewConfig;
    if (!viewConfig || !Array.isArray(viewConfig.columns) || viewConfig.columns.length === 0) {
      return schemaColumns;
    }
    const fieldCatalog = buildFieldCatalog(schemaColumns);
    const byKey = new Map(fieldCatalog.map((c) => [c.key, c]));
    return viewConfig.columns
      .filter((c) => c && c.visible !== false && byKey.has(c.field_key))
      .map((c) => {
        const base = byKey.get(c.field_key);
        return typeof c.width === 'number' ? { ...base, width: c.width } : base;
      });
  }, [schemaColumns, activeView, defaultViewConfig]);
  const recordList = records || [];

  // ---- header --------------------------------------------------------------
  const defList = defs || [];

  return (
    <>
      <CreateRecordDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
        applicationId={appId}
        registryDef={selectedDef}
      />
      {/* T-0581 (view registry) FR-4: columns/filters/sort panel — the
          обязательный UI contract over the already-approved backend. */}
      <ListViewPanel
        open={viewPanelOpen}
        onClose={() => setViewPanelOpen(false)}
        schemaColumns={schemaColumns}
        activeView={activeView}
        defaultViewConfig={defaultViewConfig}
        onApply={setActiveViewId}
        views={savedViews}
        viewsError={viewsError}
        viewsLoading={viewsLoading}
        reloadViews={reloadViews}
        saveView={saveView}
        deleteView={deleteView}
      />
      {/* T-0568: destructive record delete — confirm-gated (kit ConfirmDialog). */}
      <ConfirmDialog
        open={Boolean(toDelete)}
        title="Удалить запись?"
        message="Запись будет удалена без возможности восстановления."
        confirmLabel="Удалить"
        tone="danger"
        loading={deleting}
        onConfirm={confirmDelete}
        onClose={() => setToDelete(null)}
      />
      <div className="chs-inbox">
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--chs-space-5)',
          padding: 'var(--chs-space-5) var(--chs-space-6)',
          borderBottom: '1px solid var(--chs-color-border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-5)' }}>
            {/* Non-sidebar up-nav back to the application list (T-0319). */}
            <Button variant="ghost" size="sm" onClick={() => navigate('/apps')} title="К списку приложений" glyph={<KitIcon name="arrow-left" className="chs-btn__glyph" />}>
              к приложению
            </Button>
            <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
              Записи приложения {app ? `«${app.display_name}»` : ''}
              {records !== null ? ` · ${recordList.length}` : ''}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 'var(--chs-space-5)', alignItems: 'center' }}>
            {/* >1 registry_def → user MUST pick which one (POST 409s otherwise). */}
            {defList.length > 1 && (
              <Select
                style={{ width: 'auto' }}
                value={selectedDefId || ''}
                onChange={(e) => setSelectedDefId(e.target.value || null)}
                aria-label="Набор полей"
              >
                <option value="">— выберите набор полей —</option>
                {defList.map((d) => (
                  <option key={d.id} value={d.id}>{d.display_name}</option>
                ))}
              </Select>
            )}
            {/* T-0581 (view registry) FR-4: switch among saved представления
                (the набор полей' schema-derived default is always option 0). */}
            {selectedDef && <ViewSwitcher views={savedViews} activeViewId={activeViewId} onChange={setActiveViewId} />}
            <Button
              variant="secondary"
              size="sm"
              disabled={!selectedDef}
              onClick={() => setViewPanelOpen(true)}
              title={selectedDef ? 'Настроить список: колонки, фильтры, сортировка' : 'Сначала выберите набор полей'}
            >
              Настроить список
            </Button>
            <Button
              variant="primary"
              size="sm"
              glyph={<KitIcon name="plus" />}
              disabled={!selectedDef}
              onClick={() => setCreateOpen(true)}
              title={selectedDef ? 'Создать запись' : 'Сначала выберите набор полей'}
            >
              Создать запись
            </Button>
          </div>
        </div>

        <div className="chs-inbox__scroll">
          {/* registry_def load states first — records depend on a chosen def. */}
          {defsError ? (
            <ErrorState message={`Не удалось загрузить наборы полей: ${defsError}`} onRetry={loadDefs} />
          ) : defs === null ? (
            <LoadingState label="Загрузка наборов полей…" />
          ) : defList.length === 0 ? (
            <EmptyState
              icon={<KitIcon name="inbox" size={28} />}
              title="У приложения пока нет полей"
              description="Сначала определите поля — потом сюда можно вносить записи."
              action={
                <Button variant="primary" onClick={() => navigate(`/app-schema/${appId}`)}>
                  Настроить поля
                </Button>
              }
            />
          ) : !selectedDef ? (
            <EmptyState
              title="Выберите набор полей"
              description="У приложения несколько наборов полей. Выберите набор выше, чтобы увидеть и создавать его записи."
            />
          ) : recordsError ? (
            <ErrorState message={`Не удалось загрузить записи: ${recordsError}`} onRetry={loadRecords} />
          ) : records === null ? (
            <LoadingState label="Загрузка записей…" />
          ) : recordList.length === 0 ? (
            <EmptyState
              icon={<KitIcon name="inbox" size={28} />}
              title={`В наборе полей «${selectedDef.display_name}» пока нет записей`}
              description="Создайте первую."
              action={
                <Button variant="primary" glyph={<KitIcon name="plus" />} onClick={() => setCreateOpen(true)}>Создать запись</Button>
              }
            />
          ) : (
            <table className="chs-itable">
              <thead>
                <tr>
                  {columns.map((c) => <th key={c.key}>{c.label}</th>)}
                  <th>Создано</th>
                  {/* T-0295: detail view link column + T-0568: delete control */}
                  <th style={{ width: '140px' }} />
                </tr>
              </thead>
              <tbody>
                {recordList.map((rec) => {
                  const data = rec.data && typeof rec.data === 'object' ? rec.data : {};
                  return (
                    <tr
                      key={rec.id}
                      style={{ cursor: 'pointer', ...(rec.id === highlightId ? { background: 'var(--chs-color-success-soft)' } : {}) }}
                      onClick={() => navigate(`/apps/${appId}/records/${rec.id}`)}
                    >
                      {columns.map((c) => {
                        // T-0507: computed fields are never stored in data, so compute on-read.
                        const cellVal = c.type === 'computed' ? computeRollup(c, data) : data[c.key];
                        const rendered = formatCellValue(cellVal, c.type);
                        // T-0447: relation cells resolve async — use RelationCell.
                        if (rendered === RELATION_CELL_ASYNC) {
                          return (
                            <td key={c.key}>
                              <RelationCell targetId={String(data[c.key])} appId={appId} />
                            </td>
                          );
                        }
                        return <td key={c.key}>{rendered}</td>;
                      })}
                      <td>
                        <Mono style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                          {fmtTs(rec.created_at)}
                        </Mono>
                      </td>
                      {/* T-0295: open detail view + T-0568: delete this record.
                          Both stopPropagation so they never trigger the row's
                          navigate-on-click (open the detail view). */}
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <Link
                          to={`/apps/${appId}/records/${rec.id}`}
                          style={{
                            fontSize: 'var(--chs-text-xs)',
                            color: 'var(--chs-color-accent)',
                            textDecoration: 'none',
                          }}
                          title="Открыть запись"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Открыть
                        </Link>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Удалить запись"
                          aria-label="Удалить запись"
                          style={{ marginLeft: 'var(--chs-space-3)' }}
                          onClick={(e) => { e.stopPropagation(); setToDelete(rec); }}
                        >
                          Удалить
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {/* T-0401: load-more control — shown only when server provided a nextCursor. */}
          {records !== null && nextCursor && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--chs-space-5)' }}>
              <Button
                variant="secondary"
                size="sm"
                disabled={loadingMoreRecords}
                onClick={loadMoreRecords}
              >
                {loadingMoreRecords ? 'Загрузка…' : 'Показать ещё'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default AppRecordsScreen;
