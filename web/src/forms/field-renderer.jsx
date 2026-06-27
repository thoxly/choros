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

import React from 'react';
// Pure contract-resolution lives in a React-free sibling (field-contract.js) so
// the load-bearing logic is unit-testable without a React runtime (codebase
// convention — cf. records-form.js). Re-export it for callers/tests.
import { resolveFieldContract, resolveFieldMode } from './field-contract.js';

export { resolveFieldContract, resolveFieldMode };

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
  const isScalarish = presentation === 'text' || presentation === 'textarea'
    || presentation === 'number' || presentation === 'checkbox'
    || presentation === 'date' || presentation === 'select' || presentation === 'radio'
    || presentation === 'money';

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
