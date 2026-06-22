/**
 * T-0072 E11.1: Named-Binding Compat Validator
 *
 * Pure function — no I/O, no DB, no network, no filesystem.
 * Zеркалит purity-дисциплину bpmn-linter.ts (T-0027).
 *
 * Exports:
 *   - BindingField          — одна запись поля формы (field-key == variable-name)
 *   - BindingViolationType  — тип рассинхрона
 *   - BindingViolation      — один экземпляр нарушения
 *   - BindingCompatResult   — результат проверки
 *   - checkBindingCompat    — основная чистая функция
 *
 * Инвариант compat-проверки (ADR §3):
 *   ok: true  iff  Set(fields[].key) === bpmnVarNames  (взаимное включение)
 *   ok: false при любом отклонении (оба направления блокирующие, ADR §3 / AC-4)
 *
 * Валидация key-поля (ADR §2.2):
 *   KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/  — консервативное JUEL/MVEL-имя
 *   MAX_KEY_LEN = 255
 *
 * НЕ является публичной точкой расширения: перечень источников varNames
 * закреплён в bpmn-linter.ts (ADR §2.4); эта функция — только compat-логика.
 *
 * T-0399 [D7-K]: BindingField extended to carry the binding CONTRACT
 * (PD-18) — contract kind + presentation + enum options. These are additive,
 * OPTIONAL fields: existing rows (key/type/required/label only) remain valid;
 * the contract is the single source of truth the unified renderer keys off.
 * `options` carries the enum value list end-to-end so an enum no longer
 * silently renders as a text input in the inbox (the snapshot bug, spec §2).
 * The catalog (binding-contract-catalog.ts) is a pure sibling module, so
 * importing it keeps binding-compat.ts pure (no I/O — fitness NB-3 intact).
 */

import {
  isBindingContractKind,
  type BindingContractKind,
  type PresentationMode,
} from "./binding-contract-catalog.js";

// ---------------------------------------------------------------------------
// Exported types (frozen public surface — ADR §6)
// ---------------------------------------------------------------------------

export interface BindingField {
  key: string;
  type: string;
  required: boolean;
  label?: string;
  /**
   * T-0399 [D7-K]: the binding contract kind (PD-18). When absent, consumers
   * derive it from `type` via the catalog (scalar/enum). Carried so structural
   * contracts (relation/collection/…) and Floor-2 widgets bind through the
   * single catalog vocabulary, not a local type map.
   */
  contract?: BindingContractKind;
  /**
   * T-0399 [D7-K]: presentation-mode override. Must be a mode the contract
   * supports (resolvePresentation enforces this on read); when absent, the
   * contract's defaultPresentation is used.
   */
  presentation?: PresentationMode;
  /**
   * T-0399 [D7-K]: enum option values. Previously dropped when FormBuilder
   * snapshotted record_schema into form_binding.fields → an enum rendered as a
   * text input in the inbox (spec §2 silent bug). Carrying it fixes the
   * authoring side: the renderer now sees the options and draws a <select>.
   */
  options?: string[];
}

export type BindingViolationType = "missing_in_schema" | "missing_in_bpmn";

export interface BindingViolation {
  type: BindingViolationType;
  fieldKey: string;
  message: string;
}

export type BindingCompatResult =
  | { ok: true }
  | { ok: false; violations: BindingViolation[] };

// ---------------------------------------------------------------------------
// Validation constants (ADR §2.2)
// ---------------------------------------------------------------------------

/**
 * Conservative Flowable/JUEL variable-name regex.
 * Matches Java-identifier-like names only:
 *   first char: letter or underscore
 *   rest:       letter, digit, or underscore
 * Dot-walking, dashes, spaces, etc. are rejected.
 */
export const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Maximum key length — Flowable stores variable names as varchar. */
export const MAX_KEY_LEN = 255;

// ---------------------------------------------------------------------------
// checkBindingCompat — core pure function
// ---------------------------------------------------------------------------

/**
 * Validates structural compatibility between a registered form binding schema
 * and the set of variable names extracted from a BPMN process.
 *
 * @param fields      - Array of BindingField from form_binding.fields.
 * @param bpmnVarNames - ReadonlySet of variable names extracted from the BPMN XML.
 * @returns { ok: true } iff Set(fields[].key) === bpmnVarNames (mutual inclusion).
 *          { ok: false; violations: BindingViolation[] } otherwise.
 *          Both directions are blocking (ADR §3 / AC-4 / AC-6).
 *
 * Pre-conditions (callers must enforce before calling this function):
 *   - fields[].key values are unique within the array
 *   - fields[].key values pass KEY_RE and MAX_KEY_LEN
 * These are validated by the HTTP POST handler (src/http/binding.ts) on write.
 * checkBindingCompat itself does NOT re-validate key syntax — it operates on
 * already-persisted, already-validated data.
 */
export function checkBindingCompat(
  fields: BindingField[],
  bpmnVarNames: ReadonlySet<string>,
): BindingCompatResult {
  const violations: BindingViolation[] = [];

  const schemaKeys = new Set(fields.map((f) => f.key));

  // Direction 1: bpmnVarNames \ schemaKeys → missing_in_schema
  // «BPMN ссылается на переменную, которую форма не объявила»
  for (const v of bpmnVarNames) {
    if (!schemaKeys.has(v)) {
      violations.push({
        type: "missing_in_schema",
        fieldKey: v,
        message: `BPMN variable "${v}" is not declared in the form binding schema`,
      });
    }
  }

  // Direction 2: schemaKeys \ bpmnVarNames → missing_in_bpmn
  // «форма объявляет поле, которое процесс нигде не упоминает»
  for (const f of fields) {
    if (!bpmnVarNames.has(f.key)) {
      violations.push({
        type: "missing_in_bpmn",
        fieldKey: f.key,
        message: `Form field key "${f.key}" is not referenced in any BPMN variable source`,
      });
    }
  }

  if (violations.length === 0) {
    return { ok: true };
  }
  return { ok: false, violations };
}

// ---------------------------------------------------------------------------
// validateBindingFields — input validation for POST /binding
// (exported for use by src/http/binding.ts; NOT part of the compat contract)
// ---------------------------------------------------------------------------

export interface BindingFieldValidationError {
  index: number;
  field: unknown;
  reason: string;
}

export type BindingFieldValidationResult =
  | { ok: true; fields: BindingField[] }
  | { ok: false; errors: BindingFieldValidationError[] };

/**
 * Validates an array of raw BindingField objects from a POST body.
 * Enforces:
 *   - Each element is a plain object with key (string), type (string), required (boolean).
 *   - key passes KEY_RE and MAX_KEY_LEN (ADR §2.2).
 *   - key values are unique within the array (ADR §2.2).
 *
 * Returns { ok: true, fields } on success, { ok: false, errors } on failure.
 * Pure function — no I/O.
 */
export function validateBindingFields(raw: unknown): { ok: true; fields: BindingField[] } | { ok: false; errors: BindingFieldValidationError[] } {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{ index: -1, field: raw, reason: "fields must be an array" }],
    };
  }

  const errors: BindingFieldValidationError[] = [];
  const seenKeys = new Set<string>();
  const fields: BindingField[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      errors.push({ index: i, field: item, reason: "each field must be a plain object" });
      continue;
    }

    const obj = item as Record<string, unknown>;

    // key
    const key = obj["key"];
    if (typeof key !== "string") {
      errors.push({ index: i, field: item, reason: "field.key must be a string" });
      continue;
    }
    if (key.length === 0) {
      errors.push({ index: i, field: item, reason: "field.key must not be empty" });
      continue;
    }
    if (key.length > MAX_KEY_LEN) {
      errors.push({ index: i, field: item, reason: `field.key exceeds ${MAX_KEY_LEN} characters` });
      continue;
    }
    if (!KEY_RE.test(key)) {
      errors.push({ index: i, field: item, reason: `field.key "${key}" is not a valid Flowable variable name (KEY_RE: /^[A-Za-z_][A-Za-z0-9_]*$/)` });
      continue;
    }
    if (seenKeys.has(key)) {
      errors.push({ index: i, field: item, reason: `duplicate key "${key}" in fields array` });
      continue;
    }
    seenKeys.add(key);

    // type
    const type = obj["type"];
    if (typeof type !== "string") {
      errors.push({ index: i, field: item, reason: "field.type must be a string" });
      continue;
    }

    // required
    const required = obj["required"];
    if (typeof required !== "boolean") {
      errors.push({ index: i, field: item, reason: "field.required must be a boolean" });
      continue;
    }

    // label (optional)
    const label = obj["label"];
    if (label !== undefined && typeof label !== "string") {
      errors.push({ index: i, field: item, reason: "field.label must be a string if present" });
      continue;
    }

    // T-0399 [D7-K]: contract (optional) — must be a known catalog kind if present.
    const contract = obj["contract"];
    if (contract !== undefined && !isBindingContractKind(contract)) {
      errors.push({ index: i, field: item, reason: `field.contract "${String(contract)}" is not a known binding-contract kind` });
      continue;
    }

    // T-0399 [D7-K]: presentation (optional) — a string if present. The exact
    // mode is reconciled against the contract on read (resolvePresentation), so
    // a presentation that doesn't fit silently falls back rather than 400-ing.
    const presentation = obj["presentation"];
    if (presentation !== undefined && typeof presentation !== "string") {
      errors.push({ index: i, field: item, reason: "field.presentation must be a string if present" });
      continue;
    }

    // T-0399 [D7-K]: options (optional) — array of strings if present (enum values).
    const options = obj["options"];
    if (options !== undefined) {
      if (!Array.isArray(options) || !options.every((o) => typeof o === "string")) {
        errors.push({ index: i, field: item, reason: "field.options must be an array of strings if present" });
        continue;
      }
    }

    fields.push({
      key,
      type,
      required,
      ...(typeof label === "string" ? { label } : {}),
      ...(isBindingContractKind(contract) ? { contract } : {}),
      ...(typeof presentation === "string" ? { presentation: presentation as PresentationMode } : {}),
      ...(Array.isArray(options) ? { options: options as string[] } : {}),
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, fields };
}
