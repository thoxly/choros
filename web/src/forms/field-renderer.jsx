/* ============================================================================
   CHOROS — field-renderer.jsx  (T-0399 · D7-K)

   THE ONE UNIFIED FIELD RENDERER.

   Before this module the codebase had four independent type→control maps
   (spec §2): FormBuilder.jsx (config), screen-inbox.jsx (InboxTaskForm/FormField),
   screen-app-records.jsx (CreateRecordDrawer, via records-form.js) and the
   FormViewer.jsx/form-defs.js iframe path. Each invented its own dictionary; the
   inbox one silently dropped enum options and rendered a text input (the snapshot
   bug). This module is the single React renderer the schema-driven form screens
   call. It keys EVERY control off the binding-contract catalog
   (src/core/binding-contract-catalog.ts, PD-18) so there is one place that
   decides "this field → this control", and one place to extend when D7-6/7/8 add
   structural contracts (relation/collection/…).

   Inputs it understands — a "renderable field" (the shape both InboxTaskForm's
   BindingField and records-form's form-field descriptor reduce to):
     { key, label, required, type?, contract?, presentation?, options? }
   `type` is the legacy scalar FieldType ("string"/"text"/"number"/… or "select").
   `contract` is the explicit PD-18 contract kind (wins when present).

   What it renders:
     scalar  → text / textarea / number / checkbox / date  (per presentation)
     enum    → <select> (or radio)                          (options[] required)
     relation / collection / date-range / money / file      → honest "not yet
       authorable here" readout (D7-6/7/8 deliver their editable UI; the renderer
       degrades visibly rather than pretending a text box captures them)
     rollup / matrix-lookup (editable:false)                → read-only readout

   Per-step field MODE (T-0404 [D7-9]): each renderable field may carry a `mode`
   (read-only / required-to-advance / hidden) bound to the BPMN node via
   form_binding.fields. The renderer ENFORCES it: hidden → not rendered; read-only →
   rendered disabled; required-to-advance → marked required. This is DISTINCT from
   per-role visibility (server-side field-visibility.ts) — both apply. The mode is
   ALSO enforced server-side on submit (form-submit-validator.ts); the render here is
   the cosmetic-consistent half, not the authoritative boundary.

   Theming: --chs-* tokens + .chs-input/.chs-label only (gate G2/G6). No hardcoded
   colors. The control is theme-agnostic (works light/dark via tokens).
   ============================================================================ */

import React, { useState, useEffect } from 'react';
// Pure contract-resolution lives in a React-free sibling (field-contract.js) so
// the load-bearing logic is unit-testable without a React runtime (codebase
// convention — cf. records-form.js). Re-export it for callers/tests.
import { resolveFieldContract, resolveFieldMode } from './field-contract.js';
// Auth headers — same helper every screen uses (mode-aware: dev X-Dev-User /
// keycloak Bearer). RelationPickerField needs it to attach auth to the
// tenant-scoped GET /api/records?registry_def_id= candidate fetch.
import { devHeaders } from '../app-shell/dev-auth.js';
// deriveRecordLabel — first non-empty string value in record.data (T-0447).
// Already in records-form.js (canonical); re-used here to avoid duplicating the
// label-derivation logic. Cross-boundary import is intentional: field-renderer is
// a web/src/forms module that depends on the records-form label helper.
import { deriveRecordLabel } from '../screens/records-form.js';

export { resolveFieldContract, resolveFieldMode };

// ---------------------------------------------------------------------------
// T-0512: PersonPicker — employee picker sourced from GET /api/org.
//
// Mirrors RelationPicker in screen-app-records.jsx: fetches the employee list
// once (on mount), renders a <select> of human employees (display name, value =
// employee id). Stores the employee id as a plain string (same as relation).
//
// Employee endpoint: GET /api/org returns { departments: [ { positions: [
//   { people: [{ id, name, type }] } ] } ] }. We flatten and filter type:"human".
// The endpoint is already used by bpmn-properties-panel.jsx, screen-agents.jsx,
// and the hire-employee form in screen-org.jsx.
//
// Honest states: loading / error (surface the failure, not an empty dropdown) /
// empty (no human employees in org) / populated (select).
// ---------------------------------------------------------------------------

/**
 * Fetch human employees from GET /api/org and flatten to [{id, name}].
 * Returns a promise that resolves to the employee list or throws on error.
 */
async function fetchEmployees() {
  // Use the same auth headers pattern as the rest of the SPA: check for
  // the authHeaders helper; fall back to empty headers (dev-no-db path).
  // We can't import devHeaders/authHeaders from screen-app-records without
  // a cross-boundary import, but for the same-origin /api/org call the browser
  // sends cookies automatically (the auth middleware checks the session cookie
  // in keycloak mode). In dev mode the x-dev-user header is injected by the
  // dev-proxy layer. We pass no extra headers here to keep this component
  // self-contained; if auth fails the component shows an honest error.
  const res = await fetch('/api/org');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const employees = [];
  const departments = Array.isArray(data.departments) ? data.departments : [];
  for (const dept of departments) {
    const positions = Array.isArray(dept.positions) ? dept.positions : [];
    for (const pos of positions) {
      const people = Array.isArray(pos.people) ? pos.people : [];
      for (const p of people) {
        if (p && p.type === 'human' && p.id) {
          employees.push({ id: p.id, name: p.name || p.id });
        }
      }
    }
  }
  return employees;
}

/**
 * PersonPicker — inline employee selector for a record form.
 * Renders a <select> of human employees from the org; stores the employee id.
 *
 * @param {{ field, value, onChange, error, idPrefix, isRequired, readOnly, invalid }} props
 */
export function PersonPicker({ field, value, onChange, error, idPrefix = 'field', isRequired = false, readOnly = false }) {
  const id = `${idPrefix}-${field.key}`;
  const label = field.label || field.title || field.key;
  const invalid = Boolean(error);

  const [employees, setEmployees] = useState(null); // null=loading
  const [fetchError, setFetchError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setFetchError(null);
    fetchEmployees()
      .then((list) => { if (!cancelled) setEmployees(list); })
      .catch((err) => { if (!cancelled) { setFetchError(String(err?.message || err)); setEmployees([]); } });
    return () => { cancelled = true; };
  }, []);

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

  let control;
  if (fetchError) {
    control = (
      <div className="chs-input" style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }} aria-live="polite">
        Не удалось загрузить список сотрудников
      </div>
    );
  } else if (employees === null) {
    control = (
      <div className="chs-input" style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontStyle: 'italic', fontSize: 'var(--chs-text-sm)' }} aria-live="polite">
        Загрузка…
      </div>
    );
  } else if (employees.length === 0) {
    control = (
      <div className="chs-input" style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
        В организации нет сотрудников
      </div>
    );
  } else {
    control = (
      <select
        id={id}
        className={inputClass}
        value={value ?? ''}
        onChange={(e) => onChange(field.key, e.target.value)}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        disabled={readOnly || undefined}
        aria-disabled={readOnly || undefined}
        style={inputStyle}
      >
        <option value="">— выберите сотрудника —</option>
        {employees.map((emp) => (
          <option key={emp.id} value={emp.id}>{emp.name}</option>
        ))}
      </select>
    );
  }

  return (
    <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
      {labelNode}
      {control}
      {errorNode}
    </div>
  );
}

// ---------------------------------------------------------------------------
// T-0403 (D7-6): RelationPickerField — record-picker for a `relation` contract.
//
// Fetches GET /api/records?registry_def_id=<targetRegistryId> (the same
// tenant-scoped endpoint used by RelationPicker in screen-app-records.jsx) and
// renders a text-filtered <select> of the target registry's records.
// Stored value: target record UUID. Displayed value: deriveRecordLabel (first
// non-empty string/number field in record.data — T-0447 resolution reuse).
//
// TENANT-SAFETY: the /api/records endpoint is RLS-enforced at the server: every
// query is scoped to the authenticated actor's tenant (session + server-side WHERE
// tenant_id = actor.tenantId). We pass devHeaders() to carry the auth credential
// (X-Dev-User in dev mode, Bearer in keycloak mode). No additional tenant filter
// is needed client-side — the server rejects cross-tenant access.
//
// field.targetRegistryId — the registry_def UUID to fetch records from
//   (set from the cross_app_ref definition at form-binding time).
//
// Honest states: loading / error / empty / populated — consistent with PersonPicker
// and the RelationPicker in screen-app-records.jsx (OBLIK principle).
// ---------------------------------------------------------------------------

/**
 * Record-picker for a `relation` contract field. Fetches the target registry's
 * records tenant-scoped via GET /api/records?registry_def_id=<id>, shows a
 * text-filtered <select>. Stores the selected record's UUID; displays its label
 * (deriveRecordLabel — first non-empty data value). Owns label + wrapper.
 *
 * @param {{ key, label?, title?, required?, targetRegistryId? }} field
 * @param {string} value  current value (record UUID or "")
 * @param {(key, value) => void} onChange
 * @param {string|undefined} error
 * @param {string} idPrefix
 * @param {boolean} isRequired
 * @param {boolean} readOnly
 */
export function RelationPickerField({ field, value, onChange, error, idPrefix = 'field', isRequired = false, readOnly = false }) {
  const id = `${idPrefix}-${field.key}`;
  const label = field.label || field.title || field.key;
  const invalid = Boolean(error);

  const [candidates, setCandidates] = useState(null); // null=loading
  const [fetchError, setFetchError] = useState(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!field.targetRegistryId) {
      // No target configured — render an empty picker rather than crashing.
      setCandidates([]);
      return;
    }
    let cancelled = false;
    setCandidates(null);
    setFetchError(null);
    // Tenant-scoped endpoint: the server enforces RLS so only records belonging
    // to the authenticated actor's tenant are returned. devHeaders() carries the
    // auth credential (X-Dev-User dev / Bearer keycloak).
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
        if (!cancelled) { setFetchError(String(err?.message || err)); setCandidates([]); }
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

  let control;
  if (fetchError) {
    control = (
      <div className="chs-input" style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }} aria-live="polite">
        Не удалось загрузить связанные записи
      </div>
    );
  } else if (candidates === null) {
    control = (
      <div className="chs-input" style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontStyle: 'italic', fontSize: 'var(--chs-text-sm)' }} aria-live="polite">
        Загрузка…
      </div>
    );
  } else if (candidates.length === 0) {
    control = (
      <div className="chs-input" style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
        В связанном приложении пока нет записей
      </div>
    );
  } else {
    // Build display labels; filter by user search text.
    const labeled = candidates.map((rec) => ({
      id: rec.id,
      display: deriveRecordLabel(rec),
    }));
    const filterLower = filter.toLowerCase();
    const filtered = filterLower
      ? labeled.filter((c) => c.display.toLowerCase().includes(filterLower) || c.id.toLowerCase().startsWith(filterLower))
      : labeled;

    control = (
      <>
        <input
          type="text"
          className="chs-input"
          placeholder="Поиск…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label={`Поиск: ${label}`}
          style={{ ...inputStyle, marginBottom: 'var(--chs-space-2)' }}
          disabled={readOnly || undefined}
          aria-disabled={readOnly || undefined}
        />
        <select
          id={id}
          className={inputClass}
          value={value ?? ''}
          onChange={(e) => onChange(field.key, e.target.value)}
          aria-required={isRequired || undefined}
          aria-invalid={invalid || undefined}
          disabled={readOnly || undefined}
          aria-disabled={readOnly || undefined}
          style={inputStyle}
          size={Math.min(filtered.length + 1, 6)}
        >
          <option value="">— выберите запись —</option>
          {filtered.map((c) => (
            <option key={c.id} value={c.id}>{c.display}</option>
          ))}
        </select>
      </>
    );
  }

  return (
    <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
      {labelNode}
      {control}
      {errorNode}
    </div>
  );
}

// ---------------------------------------------------------------------------
// T-0403 (D7-6): DateRangeField — two-date picker for a `date-range` contract.
//
// Renders two <input type="date"> controls (Начало / Конец) as one logical field.
// Serialization: value is an object { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }.
// Both are nullable (empty string = not set). Validation: start > end → inline
// error (client-side hint; the server re-validates on submit).
//
// onChange contract: called as onChange(field.key, { start, end }). The caller
// stores the object as the field value.
// ---------------------------------------------------------------------------

/**
 * Two-date range picker for a `date-range` contract field.
 * Value shape: `{ start: string, end: string }` (ISO date strings or "").
 * Validation: inline error when start > end (non-empty both set, start after end).
 *
 * @param {{ key, label?, title?, required? }} field
 * @param {{ start?: string, end?: string }|undefined} value
 * @param {(key, { start, end }) => void} onChange
 * @param {string|undefined} error  external validation error from the form
 * @param {string} idPrefix
 * @param {boolean} isRequired
 * @param {boolean} readOnly
 */
export function DateRangeField({ field, value, onChange, error, idPrefix = 'field', isRequired = false, readOnly = false }) {
  const idStart = `${idPrefix}-${field.key}-start`;
  const idEnd = `${idPrefix}-${field.key}-end`;
  const label = field.label || field.title || field.key;
  const invalid = Boolean(error);

  const startVal = (value && typeof value.start === 'string') ? value.start : '';
  const endVal = (value && typeof value.end === 'string') ? value.end : '';

  // Inline validation: both dates present and start is after end.
  const rangeError = (startVal && endVal && startVal > endVal)
    ? 'Дата начала не может быть позже даты окончания'
    : null;

  const inputStyle = { display: 'block', width: '100%', boxSizing: 'border-box' };
  const inputClass = `chs-input${(invalid || rangeError) ? ' chs-input--invalid' : ''}`;

  const handleStart = (e) => {
    onChange(field.key, { start: e.target.value, end: endVal });
  };
  const handleEnd = (e) => {
    onChange(field.key, { start: startVal, end: e.target.value });
  };

  return (
    <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
      <label className="chs-label" htmlFor={idStart}>
        {label}
        {isRequired && (
          <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
        )}
      </label>
      <div style={{ display: 'flex', gap: 'var(--chs-space-2)', alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <label className="chs-label" htmlFor={idStart} style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', marginBottom: 'var(--chs-space-1)' }}>
            Начало
          </label>
          <input
            id={idStart}
            className={inputClass}
            type="date"
            value={startVal}
            onChange={handleStart}
            aria-required={isRequired || undefined}
            aria-invalid={(invalid || Boolean(rangeError)) || undefined}
            readOnly={readOnly || undefined}
            aria-disabled={readOnly || undefined}
            style={inputStyle}
          />
        </div>
        <span aria-hidden="true" style={{ paddingTop: 'calc(var(--chs-space-4) + var(--chs-text-xs))', color: 'var(--chs-color-text-muted)' }}>—</span>
        <div style={{ flex: 1 }}>
          <label className="chs-label" htmlFor={idEnd} style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', marginBottom: 'var(--chs-space-1)' }}>
            Конец
          </label>
          <input
            id={idEnd}
            className={inputClass}
            type="date"
            value={endVal}
            onChange={handleEnd}
            aria-required={isRequired || undefined}
            aria-invalid={(invalid || Boolean(rangeError)) || undefined}
            readOnly={readOnly || undefined}
            aria-disabled={readOnly || undefined}
            style={inputStyle}
          />
        </div>
      </div>
      {rangeError && (
        <span
          role="alert"
          style={{ display: 'block', marginTop: 'var(--chs-space-1)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}
        >
          {rangeError}
        </span>
      )}
      {error && (
        <span style={{ display: 'block', marginTop: 'var(--chs-space-1)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}>
          {error}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// T-0406 (D7-7): CollectionField — editable line-items table for a `collection`
// contract (schemaSlot: child-rows).
//
// Renders a repeatable rows table where each row is an object with sub-fields.
// Sub-field types come from field.subFields (built by schemaToFormFields in
// records-form.js from the array items.properties — T-0448/T-0449). Each cell
// is rendered via FieldControl recursively (hideLabel=true) so every scalar/enum
// sub-field type is supported without duplication.
//
// onChange contract: onChange(field.key, rows[]) — the caller receives the
// updated array of row objects and stores it as the field value.
//
// Value shape: Array<Record<string, string|boolean|number>> — same as
// serializeRecordData's output for a collection field (records-form.js L732-778).
//
// UX-честность:
//   - Empty collection → one empty row pre-added so the table is never blank;
//     alternatively, a clear "Добавить строку" button when rows[] is empty.
//     The component starts with an empty array (blankRecordValues gives [])
//     and the "добавить" button is always visible (not hidden).
//   - Validation errors per cell: passed via `error` shape
//     { rows: [ { [subKey]: "message" } | undefined, … ], _collection?: string }
//     (matches validateRecordValues output for collection — records-form.js L504-562).
//     _collection error is shown as a top-level error (field-level); per-row/cell
//     errors are shown inline under the cell.
//   - add/remove buttons: always functional (add → new blank row; remove → splices row).
//   - tokens: --chs-* only; .chs-input/.chs-label classes.
// ---------------------------------------------------------------------------

/**
 * Editable line-items table for a `collection` contract field.
 * Each row is an object with sub-fields; each cell renders via FieldControl.
 *
 * @param {{ key, label?, title?, required?, subFields?: Array }} field
 * @param {Array<Record<string,unknown>>} value  current rows array ([] = empty)
 * @param {(key, rows) => void} onChange
 * @param {{ rows?: Array<object|undefined>, _collection?: string }|string|undefined} error
 * @param {string} idPrefix
 * @param {boolean} isRequired
 * @param {boolean} readOnly
 */
export function CollectionField({ field, value, onChange, error, idPrefix = 'field', isRequired = false, readOnly = false }) {
  const label = field.label || field.title || field.key;
  const subFields = Array.isArray(field.subFields) ? field.subFields : [];
  const rows = Array.isArray(value) ? value : [];

  // Normalise the error prop:
  //   string → top-level field error (e.g. "Добавьте хотя бы одну строку")
  //   object → { rows: […], _collection?: string } shape from validateRecordValues
  const collectionError = error && typeof error === 'object' && !Array.isArray(error)
    ? (error._collection || null)
    : (typeof error === 'string' ? error : null);
  const rowErrors = error && typeof error === 'object' && Array.isArray(error.rows)
    ? error.rows
    : [];

  // Add a blank row to the rows array.
  const handleAdd = () => {
    if (readOnly) return;
    const blankRow = {};
    for (const sf of subFields) {
      blankRow[sf.key] = sf.type === 'boolean' ? false : '';
    }
    onChange(field.key, [...rows, blankRow]);
  };

  // Remove a row at index i.
  const handleRemove = (i) => {
    if (readOnly) return;
    const next = rows.filter((_, idx) => idx !== i);
    onChange(field.key, next);
  };

  // Update a single cell in a row.
  const handleCellChange = (rowIdx, cellKey, cellValue) => {
    if (readOnly) return;
    const next = rows.map((row, idx) =>
      idx === rowIdx ? { ...row, [cellKey]: cellValue } : row
    );
    onChange(field.key, next);
  };

  const tableStyle = {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 'var(--chs-text-sm)',
  };
  const thStyle = {
    textAlign: 'left',
    padding: 'var(--chs-space-2) var(--chs-space-2)',
    borderBottom: '1px solid var(--chs-color-border)',
    color: 'var(--chs-color-text-muted)',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  };
  const tdStyle = {
    padding: 'var(--chs-space-1) var(--chs-space-2)',
    verticalAlign: 'top',
    borderBottom: '1px solid var(--chs-color-border)',
  };
  const removeBtnStyle = {
    background: 'none',
    border: 'none',
    cursor: readOnly ? 'default' : 'pointer',
    color: readOnly ? 'var(--chs-color-text-muted)' : 'var(--chs-color-danger)',
    fontSize: 'var(--chs-text-sm)',
    padding: '0 var(--chs-space-1)',
    opacity: readOnly ? 0.4 : 1,
  };
  const addBtnStyle = {
    marginTop: 'var(--chs-space-2)',
    padding: 'var(--chs-space-2) var(--chs-space-3)',
    background: 'none',
    border: '1px dashed var(--chs-color-border)',
    borderRadius: 'var(--chs-radius)',
    cursor: readOnly ? 'default' : 'pointer',
    color: readOnly ? 'var(--chs-color-text-muted)' : 'var(--chs-color-primary)',
    fontSize: 'var(--chs-text-sm)',
    opacity: readOnly ? 0.5 : 1,
  };

  // Helper: make a cell onChange handler for a given row index.
  // Returns (cellKey, cellValue) => void — matches FieldControl's onChange contract.
  const makeCellOnChange = (rowIdx) => (cellKey, cellValue) => {
    handleCellChange(rowIdx, cellKey, cellValue);
  };

  return (
    <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
      {/* Field label */}
      <div className="chs-label" style={{ marginBottom: 'var(--chs-space-2)' }}>
        {label}
        {isRequired && (
          <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
        )}
      </div>

      {/* Top-level collection error (e.g. "Добавьте хотя бы одну строку") */}
      {collectionError && (
        <span
          role="alert"
          style={{ display: 'block', marginBottom: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}
        >
          {collectionError}
        </span>
      )}

      {/* Table */}
      {subFields.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle} aria-label={label}>
            <thead>
              <tr>
                {subFields.map((sf) => (
                  <th key={sf.key} scope="col" style={thStyle}>
                    {sf.label || sf.key}
                    {sf.required && (
                      <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
                    )}
                  </th>
                ))}
                {/* Remove-button column header */}
                <th scope="col" style={{ ...thStyle, width: '2.5rem' }} aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={subFields.length + 1}
                    style={{ ...tdStyle, color: 'var(--chs-color-text-muted)', fontStyle: 'italic', textAlign: 'center', paddingTop: 'var(--chs-space-4)', paddingBottom: 'var(--chs-space-4)' }}
                  >
                    Нет строк — нажмите «Добавить строку»
                  </td>
                </tr>
              ) : (
                rows.map((row, rowIdx) => {
                  const rowErr = rowErrors[rowIdx];
                  return (
                    <tr key={rowIdx}>
                      {subFields.map((sf) => {
                        const cellErr = rowErr && typeof rowErr === 'object' ? rowErr[sf.key] : undefined;
                        const cellValue = row && typeof row === 'object' ? row[sf.key] : undefined;
                        return (
                          <td key={sf.key} style={tdStyle}>
                            {/* Reuse FieldControl for each cell — hideLabel=true since <th> carries the label */}
                            <FieldControl
                              field={sf}
                              value={cellValue}
                              onChange={makeCellOnChange(rowIdx)}
                              error={cellErr}
                              idPrefix={`${idPrefix}-${field.key}-row${rowIdx}`}
                              hideLabel={true}
                            />
                          </td>
                        );
                      })}
                      <td style={{ ...tdStyle, textAlign: 'center' }}>
                        <button
                          type="button"
                          aria-label={`Удалить строку ${rowIdx + 1}`}
                          onClick={() => handleRemove(rowIdx)}
                          style={removeBtnStyle}
                          disabled={readOnly || undefined}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : (
        /* No sub-fields configured — honest empty state */
        <div
          className="chs-input"
          aria-readonly="true"
          style={{ color: 'var(--chs-color-text-muted)', fontStyle: 'italic', fontSize: 'var(--chs-text-sm)' }}
        >
          Структура строк не настроена
        </div>
      )}

      {/* Add row button */}
      {subFields.length > 0 && (
        <button
          type="button"
          onClick={handleAdd}
          style={addBtnStyle}
          disabled={readOnly || undefined}
          aria-disabled={readOnly || undefined}
        >
          + Добавить строку
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FieldControl — the single field component the schema-driven forms render.
// ---------------------------------------------------------------------------

/**
 * Render one form field as a labelled control, chosen from the binding-contract
 * catalog. The caller owns the value/onChange (controlled input). `onChange` is
 * called with (key, nextValue): a string for text/number/select/date, a boolean
 * for checkbox.
 *
 * T-0450 Fix 2 (G7): `hideLabel` — when true, omits the `<label>` element and the
 * bottom-margin wrapper div (renders the bare control only). Designed for table-cell
 * contexts (LineItemsField `<td>`) where the column `<th>` header already provides
 * the label; repeating it per-cell stacks a "form-in-a-form" anti-pattern and adds
 * unwanted margin that breaks table rhythm.
 * Default: false → backward-compatible; all existing callers keep their labels.
 *
 * @param {object} props
 * @param {{ key: string, label?: string, title?: string, required?: boolean,
 *           type?: string, contract?: string, presentation?: string,
 *           options?: string[] }} props.field
 * @param {string|boolean|undefined} props.value
 * @param {(key: string, value: string|boolean) => void} props.onChange
 * @param {string} [props.error]   per-field error message
 * @param {string} [props.idPrefix] id namespace (default "field")
 * @param {boolean} [props.hideLabel] when true, omit label + wrapper margin (default false)
 */
export function FieldControl({ field, value, onChange, error, idPrefix = 'field', hideLabel = false }) {
  const id = `${idPrefix}-${field.key}`;
  const label = field.label || field.title || field.key;
  // T-0404 [D7-9]: per-step field mode (read-only / required-to-advance / hidden),
  // bound to the BPMN node via form_binding.fields. Distinct from per-role
  // visibility (server-side field-visibility.ts) — both apply. hidden → not rendered;
  // read-only → rendered disabled; required-to-advance → marked required.
  const { hidden, readOnly, required: modeRequired } = resolveFieldMode(field);
  // hidden: the field is not rendered AT ALL at this step. Server-side submit
  // validation rejects any write to it (form-submit-validator.ts), so dropping the
  // control here is cosmetic-consistent, not the security boundary.
  if (hidden) return null;
  // required marker is the union of the legacy per-field `required` flag and the
  // step-bound `required-to-advance` mode.
  const isRequired = Boolean(field.required) || modeRequired;
  const invalid = Boolean(error);
  const { presentation, descriptor, editable } = resolveFieldContract(field);

  const inputStyle = { display: 'block', width: '100%', boxSizing: 'border-box' };
  const inputClass = `chs-input${invalid ? ' chs-input--invalid' : ''}`;

  const errorNode = error ? (
    <span style={{ display: 'block', marginTop: 'var(--chs-space-1)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}>
      {error}
    </span>
  ) : null;

  // ----- read-only / not-yet-authorable contracts (honest degradation) -------
  // Editable structural contracts (relation/collection/date-range/money/file)
  // do not have an authoring control here yet (delivered by D7-6/7/8). Rather
  // than silently render a text box that captures nothing useful, surface what
  // the field IS so the gap is visible, not hidden.
  // T-0403 (D7-6): relation (presentation='reference') → RelationPickerField.
  if (presentation === 'reference') {
    return (
      <RelationPickerField
        field={field}
        value={value}
        onChange={onChange}
        error={error}
        idPrefix={idPrefix}
        isRequired={isRequired}
        readOnly={readOnly}
      />
    );
  }

  // T-0403 (D7-6): date-range (presentation='range') → DateRangeField.
  if (presentation === 'range') {
    return (
      <DateRangeField
        field={field}
        value={value}
        onChange={onChange}
        error={error}
        idPrefix={idPrefix}
        isRequired={isRequired}
        readOnly={readOnly}
      />
    );
  }

  // T-0406 (D7-7): collection (presentation='table') → CollectionField.
  // Renders an editable line-items table; delegates cell rendering back to
  // FieldControl (hideLabel=true). Replaces the old "not yet" italic readout.
  if (presentation === 'table') {
    return (
      <CollectionField
        field={field}
        value={value}
        onChange={onChange}
        error={error}
        idPrefix={idPrefix}
        isRequired={isRequired}
        readOnly={readOnly}
      />
    );
  }

  // T-0512: multi-select and person are scalarish (rendered inline by FieldControl).
  // T-0516: url and email are also scalarish (rendered as typed text inputs).
  const isScalarish = presentation === 'text' || presentation === 'textarea'
    || presentation === 'number' || presentation === 'checkbox'
    || presentation === 'date' || presentation === 'select' || presentation === 'radio'
    || presentation === 'money' || presentation === 'multi-select' || presentation === 'person'
    || presentation === 'url' || presentation === 'email';

  if (!isScalarish) {
    const note = editable
      ? `Поле типа «${descriptor.label}» пока заполняется в другом месте`
      : `«${descriptor.label}» — только для чтения (вычисляется автоматически)`;
    // hideLabel: omit label + margin wrapper when caller manages the label externally.
    if (hideLabel) {
      return (
        <>
          <div
            id={id}
            className="chs-input"
            aria-readonly="true"
            style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}
          >
            {note}
          </div>
          {errorNode}
        </>
      );
    }
    return (
      <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
        <label className="chs-label" htmlFor={id}>
          {label}
          {isRequired && (
            <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
          )}
        </label>
        <div
          id={id}
          className="chs-input"
          aria-readonly="true"
          style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}
        >
          {note}
        </div>
        {errorNode}
      </div>
    );
  }

  // ----- enum (select) -------------------------------------------------------
  if (presentation === 'select' || presentation === 'radio') {
    const options = Array.isArray(field.options) ? field.options : [];
    const control = (
      <select
        id={id}
        className={inputClass}
        value={value ?? ''}
        onChange={(e) => onChange(field.key, e.target.value)}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        disabled={readOnly || undefined}
        aria-disabled={readOnly || undefined}
        style={inputStyle}
      >
        <option value="">— выберите —</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
    // T-0450 Fix 2: hideLabel → bare control, no .chs-field wrapper or label.
    if (hideLabel) {
      return <>{control}{errorNode}</>;
    }
    return (
      <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
        <label className="chs-label" htmlFor={id}>
          {label}
          {isRequired && (
            <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
          )}
        </label>
        {control}
        {errorNode}
      </div>
    );
  }

  // ----- multi-select (T-0512) ------------------------------------------------
  // Renders a set of checkboxes, one per option. Value is a string[].
  // On change: toggle the option in/out of the array.
  if (presentation === 'multi-select') {
    const options = Array.isArray(field.options) ? field.options : [];
    const selected = Array.isArray(value) ? value : [];
    const handleToggle = (opt) => {
      const next = selected.includes(opt)
        ? selected.filter((s) => s !== opt)
        : [...selected, opt];
      onChange(field.key, next);
    };
    const control = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-2)' }}>
        {options.length === 0 && (
          <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}>
            Нет вариантов
          </span>
        )}
        {options.map((opt) => (
          <label key={opt} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--chs-space-2)', fontSize: 'var(--chs-text-sm)' }}>
            <input
              type="checkbox"
              checked={selected.includes(opt)}
              onChange={() => handleToggle(opt)}
              disabled={readOnly || undefined}
              aria-disabled={readOnly || undefined}
            />
            {opt}
          </label>
        ))}
      </div>
    );
    if (hideLabel) {
      return <>{control}{errorNode}</>;
    }
    return (
      <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
        <label className="chs-label" htmlFor={id}>
          {label}
          {isRequired && (
            <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
          )}
        </label>
        {control}
        {errorNode}
      </div>
    );
  }

  // ----- person (T-0512) -------------------------------------------------------
  // Renders a PersonPicker component (async employee select from GET /api/org).
  // PersonPicker owns its own label+wrapper so we return it directly.
  if (presentation === 'person') {
    return (
      <PersonPicker
        field={field}
        value={value}
        onChange={onChange}
        error={error}
        idPrefix={idPrefix}
        isRequired={isRequired}
        readOnly={readOnly}
      />
    );
  }

  // ----- boolean (checkbox) — label is part of the control -------------------
  if (presentation === 'checkbox') {
    // T-0450 Fix 2: hideLabel → bare checkbox (label text removed; th header is the label).
    if (hideLabel) {
      return (
        <>
          <input
            id={id}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(field.key, e.target.checked)}
            aria-required={isRequired || undefined}
            aria-invalid={invalid || undefined}
            disabled={readOnly || undefined}
            aria-disabled={readOnly || undefined}
          />
          {errorNode}
        </>
      );
    }
    return (
      <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--chs-space-2)', fontSize: 'var(--chs-text-sm)' }}>
          <input
            id={id}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(field.key, e.target.checked)}
            aria-required={isRequired || undefined}
            aria-invalid={invalid || undefined}
            disabled={readOnly || undefined}
            aria-disabled={readOnly || undefined}
          />
          {label}
          {isRequired && (
            <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
          )}
        </label>
        {errorNode}
      </div>
    );
  }

  // ----- scalar inputs: text / textarea / number / date ----------------------
  let control;
  if (presentation === 'textarea') {
    control = (
      <textarea
        id={id}
        className={inputClass}
        value={value ?? ''}
        onChange={(e) => onChange(field.key, e.target.value)}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        readOnly={readOnly || undefined}
        aria-disabled={readOnly || undefined}
        rows={3}
        style={inputStyle}
      />
    );
  } else if (presentation === 'number') {
    control = (
      <input
        id={id}
        className={inputClass}
        type="number"
        step={field.type === 'integer' ? '1' : 'any'}
        value={value ?? ''}
        onChange={(e) => onChange(field.key, e.target.value)}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        readOnly={readOnly || undefined}
        aria-disabled={readOnly || undefined}
        style={inputStyle}
      />
    );
  } else if (presentation === 'money') {
    // T-0509: money — numeric input with a ₽ suffix label. The user types a plain
    // number (stored as type:number); the ₽ label makes the currency visible in input.
    control = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-2)' }}>
        <input
          id={id}
          className={inputClass}
          type="number"
          step="any"
          value={value ?? ''}
          onChange={(e) => onChange(field.key, e.target.value)}
          aria-required={isRequired || undefined}
          aria-invalid={invalid || undefined}
          readOnly={readOnly || undefined}
          aria-disabled={readOnly || undefined}
          style={{ ...inputStyle, flex: 1 }}
        />
        <span aria-hidden="true" style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', whiteSpace: 'nowrap' }}>₽</span>
      </div>
    );
  } else if (presentation === 'date') {
    control = (
      <input
        id={id}
        className={inputClass}
        type="date"
        value={value ?? ''}
        onChange={(e) => onChange(field.key, e.target.value)}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        readOnly={readOnly || undefined}
        aria-disabled={readOnly || undefined}
        style={inputStyle}
      />
    );
  } else if (presentation === 'url') {
    // T-0516: url — <input type="url"> for browser-native URL validation hint.
    control = (
      <input
        id={id}
        className={inputClass}
        type="url"
        value={value ?? ''}
        onChange={(e) => onChange(field.key, e.target.value)}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        readOnly={readOnly || undefined}
        aria-disabled={readOnly || undefined}
        style={inputStyle}
      />
    );
  } else if (presentation === 'email') {
    // T-0516: email — <input type="email"> for browser-native email validation hint.
    control = (
      <input
        id={id}
        className={inputClass}
        type="email"
        value={value ?? ''}
        onChange={(e) => onChange(field.key, e.target.value)}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        readOnly={readOnly || undefined}
        aria-disabled={readOnly || undefined}
        style={inputStyle}
      />
    );
  } else {
    // text (default)
    control = (
      <input
        id={id}
        className={inputClass}
        type="text"
        value={value ?? ''}
        onChange={(e) => onChange(field.key, e.target.value)}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        readOnly={readOnly || undefined}
        aria-disabled={readOnly || undefined}
        style={inputStyle}
      />
    );
  }

  // T-0450 Fix 2: hideLabel → bare control without .chs-field wrapper or label.
  if (hideLabel) {
    return <>{control}{errorNode}</>;
  }
  return (
    <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
      <label className="chs-label" htmlFor={id}>
        {label}
        {isRequired && (
          <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
        )}
      </label>
      {control}
      {errorNode}
    </div>
  );
}

export default FieldControl;
