/**
 * T-0102 · E9: Server-side form validation — "форма не доверяет клиенту".
 *
 * Pure validator. Given a form id and a raw submitted payload, it independently
 * checks EVERY field against the canonical schema (src/core/form-schema.ts). The
 * server is the source of truth: a tampered client that bypassed the form-js UI
 * (missing required, wrong type, over-length, out-of-range, disallowed enum, or
 * an unknown/extra field it forged) is rejected here, regardless of what the
 * client UI would have allowed.
 *
 * No I/O, no DB, no network, no filesystem, no env reads. The HTTP layer
 * (src/http/forms.ts) maps the FieldError[] onto the repo's 400 VALIDATION
 * envelope; this module stays transport-agnostic and side-effect free.
 *
 * Threat model enforced (each → a FieldError, never a silent accept):
 *   MISSING_REQUIRED  — required field absent / null / empty string.
 *   WRONG_TYPE        — value's runtime type ≠ the field's declared type.
 *   TOO_LONG          — text/textarea exceeds maxLength.
 *   OUT_OF_RANGE      — number below min or above max (incl. NaN/∞).
 *   DISALLOWED_VALUE  — enum value not in the allowed option set.
 *   UNKNOWN_FIELD     — a key the schema does not declare (extra/forged field).
 *   NOT_AN_OBJECT     — payload is not a JSON object at all.
 *   UNKNOWN_FORM      — form id is not a registered form.
 */
import { getFormDef, type FieldDef, type FormDef } from "./form-schema.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type FormErrorCode =
  | "MISSING_REQUIRED"
  | "WRONG_TYPE"
  | "TOO_LONG"
  | "OUT_OF_RANGE"
  | "DISALLOWED_VALUE"
  | "UNKNOWN_FIELD"
  | "NOT_AN_OBJECT"
  | "UNKNOWN_FORM";

/** One field-level validation failure. `field` is "" for whole-payload errors. */
export interface FieldError {
  readonly field: string;
  readonly code: FormErrorCode;
  readonly message: string;
}

export interface FormValidationResult {
  readonly ok: boolean;
  readonly errors: FieldError[];
  /**
   * The sanitized payload (only known fields, with types as declared). Present
   * only when ok === true. The caller persists THIS, never the raw client body,
   * so forged extra keys can never reach storage even if validation is relaxed.
   */
  readonly value?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Low-level helpers (pure)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A value is "absent" for required-checks if undefined, null, or empty string. */
function isAbsent(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim().length === 0);
}

function err(field: string, code: FormErrorCode, message: string): FieldError {
  return { field, code, message };
}

/**
 * Validate one present value against its field definition. Returns a FieldError
 * or null. Does NOT handle requiredness (caller does that first).
 */
function validateValue(def: FieldDef, value: unknown): FieldError | null {
  switch (def.type) {
    case "text":
    case "textarea":
    case "date": {
      if (typeof value !== "string") {
        return err(def.key, "WRONG_TYPE", `${def.key} must be a string`);
      }
      if (def.maxLength !== undefined && value.length > def.maxLength) {
        return err(def.key, "TOO_LONG", `${def.key} exceeds maxLength ${def.maxLength}`);
      }
      return null;
    }
    case "number": {
      // Reject anything that is not a finite JS number. A forged client could
      // send "4" (string), NaN, Infinity, or an object — all rejected.
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return err(def.key, "WRONG_TYPE", `${def.key} must be a finite number`);
      }
      if (def.min !== undefined && value < def.min) {
        return err(def.key, "OUT_OF_RANGE", `${def.key} is below min ${def.min}`);
      }
      if (def.max !== undefined && value > def.max) {
        return err(def.key, "OUT_OF_RANGE", `${def.key} is above max ${def.max}`);
      }
      return null;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        return err(def.key, "WRONG_TYPE", `${def.key} must be a boolean`);
      }
      return null;
    }
    case "enum": {
      if (typeof value !== "string") {
        return err(def.key, "WRONG_TYPE", `${def.key} must be a string`);
      }
      const allowed = def.options ?? [];
      if (!allowed.includes(value)) {
        return err(def.key, "DISALLOWED_VALUE", `${def.key} has a value not in the allowed set`);
      }
      return null;
    }
    default: {
      // Exhaustiveness guard — unreachable while FieldType is fully handled.
      return err(def.key, "WRONG_TYPE", `${def.key} has an unsupported field type`);
    }
  }
}

/** Resolve effective requiredness, applying requiredWhen against the payload. */
function isRequired(def: FieldDef, payload: Record<string, unknown>): boolean {
  if (def.required === true) return true;
  if (def.requiredWhen) {
    const other = payload[def.requiredWhen.field];
    if (typeof other === "string" && def.requiredWhen.equals.includes(other)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a submitted payload against a form's schema. The server distrusts the
 * client: every field is checked independently; unknown/extra fields are
 * rejected; the returned `value` (when ok) contains ONLY schema-declared fields.
 */
export function validateFormSubmission(formId: string, payload: unknown): FormValidationResult {
  const form = getFormDef(formId);
  if (!form) {
    return {
      ok: false,
      errors: [err("", "UNKNOWN_FORM", `unknown form '${formId}'`)],
    };
  }

  if (!isPlainObject(payload)) {
    return {
      ok: false,
      errors: [err("", "NOT_AN_OBJECT", "form payload must be a JSON object")],
    };
  }

  return validateAgainst(form, payload);
}

/**
 * Validate a submitted payload against a pre-resolved FormDef (no registry lookup).
 *
 * T-0345 [E15-S4 followup]: used by the live submit path when the FormDef has been
 * derived from the registry's `record_schema` (via deriveFormDefFromSchema) rather
 * than looked up from the hardcoded form-schema.ts registry. Allows the caller to
 * supply a dynamically-derived schema while reusing all the same validation rules
 * (missing required, wrong type, over-length, out-of-range, disallowed enum,
 * unknown/extra field) — single implementation, two call sites.
 *
 * @param formDef  - the FormDef to validate against (derived or static)
 * @param payload  - the raw submitted payload
 * @returns FormValidationResult — same shape as validateFormSubmission
 */
export function validateFormSubmissionAgainst(
  formDef: FormDef,
  payload: unknown,
): FormValidationResult {
  if (!isPlainObject(payload)) {
    return {
      ok: false,
      errors: [err("", "NOT_AN_OBJECT", "form payload must be a JSON object")],
    };
  }
  return validateAgainst(formDef, payload);
}

function validateAgainst(form: FormDef, payload: Record<string, unknown>): FormValidationResult {
  const errors: FieldError[] = [];
  const known = new Set(form.fields.map((f) => f.key));

  // 1) Reject unknown/extra fields a forged client could append. The schema is
  //    the closed set of accepted keys — anything else is a tamper signal.
  for (const key of Object.keys(payload)) {
    if (!known.has(key)) {
      errors.push(err(key, "UNKNOWN_FIELD", `field '${key}' is not defined for this form`));
    }
  }

  // 2) Per-field: requiredness then value validation. A field absent in the
  //    payload is fine unless required; a present value is type/range/enum checked.
  const value: Record<string, unknown> = {};
  for (const def of form.fields) {
    const raw = payload[def.key];
    const present = Object.prototype.hasOwnProperty.call(payload, def.key) && !isAbsent(raw);

    if (!present) {
      if (isRequired(def, payload)) {
        errors.push(err(def.key, "MISSING_REQUIRED", `${def.key} is required`));
      }
      continue;
    }

    const fieldErr = validateValue(def, raw);
    if (fieldErr) {
      errors.push(fieldErr);
    } else {
      // Only schema-declared, validated values flow into the sanitized output.
      value[def.key] = raw;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, errors: [], value };
}
