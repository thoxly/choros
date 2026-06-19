/**
 * T-0102 · E9: Form schema — machine-readable validation contract for the two
 * MVP User-Task forms ("заявка на закупку" / "согласование").
 *
 * T-0337 · E15-S4: Forms-from-schema.
 *   FieldType is now defined in src/core/field-type-dictionary.ts (the unified
 *   type dictionary shared across schema↔binding↔form). This module re-exports
 *   it so all existing callers (form-validator.ts, forms.ts, tests) continue to
 *   import from "form-schema.js" without change — backward-compatible.
 *
 *   The two hardcoded FormDef objects (PURCHASE, APPROVAL) remain here as the
 *   pinned bootstrap definitions for the ТЭЛ demo forms, which predated the
 *   registry_def API. Their FieldDef[] is the single server-side source of truth
 *   for the forms-schema-binding CI check (FF-FORMS1-2 / forms-schema-binding.sh).
 *
 *   NEW forms whose schema is authored via the registry_def API use
 *   deriveFormDefFromSchema() (src/core/form-schema-derive.ts) to derive an
 *   equivalent FormDef from registry_def.record_schema at runtime — no
 *   separately-maintained hardcoded entry is needed.
 *
 * SINGLE SOURCE OF TRUTH for SERVER-SIDE field validation. The visual layer
 * (web/src/forms/form-defs.js — form-js HTML rendered inside the sandbox-iframe)
 * is NOT machine-readable (it is HTML strings), so the rules cannot be imported
 * from it without re-parsing markup. Instead this module is the canonical schema
 * and a fitness check (ci/checks/forms-schema-binding.sh) asserts that every
 * `data-field` / `select(...)` key the form-defs visual layer exposes has a
 * matching field here — so the two cannot silently drift. Validation RULES live
 * ONLY here; form-defs contributes field identity + the required (*) markers.
 *
 * Pure data + pure functions — no I/O, no DB, no network, no filesystem, no env
 * reads. Mirrors the purity discipline of floor1-editor.ts / binding-compat.ts.
 *
 * The forms are addressed to a User Task; the SERVER independently validates
 * every submitted value against this schema (T-0102: "форма не доверяет
 * клиенту"). A tampered client that bypasses the form-js UI constraints — sends
 * a missing required field, a wrong type, an over-length string, an out-of-range
 * number, a disallowed enum value, or an unknown/extra field — is rejected by
 * deriving the rules from this schema, never from what the client claims.
 */

// ---------------------------------------------------------------------------
// Field-type vocabulary — UNIFIED (T-0337 E15-S4)
//
// FieldType is defined ONCE in field-type-dictionary.ts and re-exported here
// for backward compatibility. All callers import from "form-schema.js" and
// continue to work unchanged.
// ---------------------------------------------------------------------------

import type { FieldType as _FieldType } from "./field-type-dictionary.js";
export type { FieldType } from "./field-type-dictionary.js";
// Re-alias for use in this file's interface definitions (TS requires the name to
// be in scope when referenced, even if it's also re-exported from this module).
type FieldType = _FieldType;

/**
 * One field's validation contract. `required` here is the BASE requiredness;
 * conditional requiredness (e.g. approval comment required on reject/return) is
 * expressed by `requiredWhen`, evaluated against the rest of the payload.
 */
export interface FieldDef {
  /** Field key — matches `data-field=` / `select("<key>"…)` in form-defs.js. */
  readonly key: string;
  readonly type: FieldType;
  /** Unconditionally required (server rejects missing/empty when true). */
  readonly required?: boolean;
  /** Allowed values for `enum` fields (the ONLY accepted values). */
  readonly options?: readonly string[];
  /** Inclusive max length for text/textarea. */
  readonly maxLength?: number;
  /** Inclusive numeric bounds for `number`. */
  readonly min?: number;
  readonly max?: number;
  /**
   * Conditional requiredness: this field is required when the field named
   * `field` currently equals one of `equals`. Used for approval.comment which
   * the design marks required on "reject"/"return" (data-req-when-reject).
   */
  readonly requiredWhen?: { readonly field: string; readonly equals: readonly string[] };
}

export interface FormDef {
  readonly id: string;
  readonly fields: readonly FieldDef[];
}

// ---------------------------------------------------------------------------
// FORM 1 — Заявка на закупку (purchase)
// Field keys mirror web/src/forms/form-defs.js (PURCHASE markup):
//   supplier(select,req) category(select) subject(text,req) qty(number)
//   price(number) due(date) budget(select,req) method(radio) reason(textarea)
//   urgent(checkbox)
// ---------------------------------------------------------------------------

const PURCHASE: FormDef = {
  id: "purchase",
  fields: [
    {
      key: "supplier",
      type: "enum",
      required: true,
      options: ["ООО «Вектор»", "АО «Линия»", "ООО «Стек-Трейд»", "Новый контрагент…"],
    },
    {
      key: "category",
      type: "enum",
      options: ["IT-оборудование", "Программное обеспечение", "Услуги", "Канцелярия и АХО"],
    },
    { key: "subject", type: "text", required: true, maxLength: 500 },
    { key: "qty", type: "number", min: 1, max: 100000 },
    { key: "price", type: "number", min: 0, max: 1000000000 },
    { key: "due", type: "date" },
    {
      key: "budget",
      type: "enum",
      required: true,
      options: [
        "ИТ-инфраструктура · CAPEX",
        "Операционные ИТ · OPEX",
        "Развитие продукта · CAPEX",
      ],
    },
    { key: "method", type: "enum", options: ["Прямая", "Тендер", "Рамочный"] },
    { key: "reason", type: "textarea", maxLength: 2000 },
    { key: "urgent", type: "boolean" },
  ],
};

// ---------------------------------------------------------------------------
// FORM 2 — Согласование (approval)
// Field keys mirror web/src/forms/form-defs.js (APPROVAL markup):
//   decision(radio,req: ok|reject|return) comment(textarea, req-when reject/return)
//   next(select) checks(checklist → boolean[])
// ---------------------------------------------------------------------------

const APPROVAL: FormDef = {
  id: "approval",
  fields: [
    { key: "decision", type: "enum", required: true, options: ["ok", "reject", "return"] },
    {
      key: "comment",
      type: "textarea",
      maxLength: 2000,
      requiredWhen: { field: "decision", equals: ["reject", "return"] },
    },
    {
      key: "next",
      type: "enum",
      options: ["Е. Ларина · Финдиректор", "Авто по маршруту процесса", "Без эскалации"],
    },
    // checklist is a set of independent booleans; modeled as boolean here. The
    // wire value is a boolean (each box) — validated for type, never required.
    { key: "checks", type: "boolean" },
  ],
};

// ---------------------------------------------------------------------------
// Form registry (the only forms the submit endpoint accepts).
// ---------------------------------------------------------------------------

const FORMS: Readonly<Record<string, FormDef>> = Object.freeze({
  purchase: PURCHASE,
  approval: APPROVAL,
});

/** Look up a form definition by id, or null if no such form exists. */
export function getFormDef(formId: string): FormDef | null {
  return Object.prototype.hasOwnProperty.call(FORMS, formId) ? (FORMS[formId] as FormDef) : null;
}

/** All registered form ids (used by tests + the schema-binding fitness check). */
export function formIds(): string[] {
  return Object.keys(FORMS);
}
