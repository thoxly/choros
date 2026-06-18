/**
 * web/src/screens/apps-schema.js
 *
 * Pure, framework-free helpers for the application FIELD-CONSTRUCTOR
 * (T-0266 — the registry_def field-schema editor). Kept JSX-free so the
 * record_schema assembly + the field-list <-> record_schema round-trip are
 * unit-testable in isolation (mirrors apps-validate.js, T-0265).
 *
 * THE RECORD_SCHEMA CONTRACT (FROZEN — derived, not guessed):
 *   A registry_def.record_schema is a JSON-Schema-ish object that the backend
 *   validator (src/core/record-schema-validator.ts · validateRecordSchemaDefinition)
 *   compiles with AJV in STRICT mode. The shape, confirmed against the seeds
 *   (migrations/056_*, 073_*) and the validator unit tests, is:
 *
 *     {
 *       "type": "object",
 *       "additionalProperties": false,
 *       "properties": {
 *         "<fieldKey>": { "type": <primitive>, "title": <label>, "enum"?: [...] },
 *         ...
 *       },
 *       "required": ["<fieldKey>", ...]
 *     }
 *
 *   - properties = the field map; each field carries a JSON-Schema `type`.
 *   - required   = the list of required field keys.
 *   - additionalProperties:false mirrors the seeds (structural injection guard).
 *
 * SUPPORTED FIELD TYPES — derived from what AJV strict mode actually compiles
 * (probed against the installed ajv) AND from the leaf types the seeds use:
 *   string · number · integer · boolean
 *   (object/array/null compile too but need sub-schemas to mean anything for a
 *    flat record form, so they are intentionally NOT offered — no dead options.)
 *
 * IMPORTANT — `format` is NOT emitted. AJV strict THROWS on an unknown format
 * (e.g. "email"/"date"), so `validateRecordSchemaDefinition` would reject it.
 * The seeds carry `format` only because they are inserted via raw SQL, bypassing
 * the API validator. The editor never produces `format`. (Honest: every schema
 * the editor emits passes the real validator.)
 *
 * FIELD-KEY contract: a field key is the property name. JSON Schema itself does
 * not constrain it, but to keep keys safe as record-data property names and as
 * dep field_keys (report_page_dep.field_key / template_dep.field_key) we require
 * an identifier-ish shape: a letter or underscore, then letters/digits/underscore.
 */

// Supported JSON-Schema primitive types the editor offers. value = the `type`
// string emitted into record_schema; label = the human label in the dropdown.
// Derived from AJV-strict-compilable primitives + seed leaf types (see header).
export const FIELD_TYPES = [
  { value: "string", label: "Текст" },
  { value: "number", label: "Число" },
  { value: "integer", label: "Целое" },
  { value: "boolean", label: "Да/Нет" },
];

export const FIELD_TYPE_VALUES = FIELD_TYPES.map((t) => t.value);

// Field key: identifier-ish (letter/underscore lead, then word chars), 1..64.
export const FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const FIELD_TITLE_MAX = 256;

/**
 * Validate a single field row for the editor.
 *
 * @param {{ key?: string, type?: string, title?: string }} field
 * @returns {{ key?: string, type?: string, title?: string }} per-field error map (empty = ok)
 */
export function validateField(field) {
  const errors = {};
  const key = typeof field?.key === "string" ? field.key : "";
  const type = typeof field?.type === "string" ? field.type : "";
  const title = typeof field?.title === "string" ? field.title : "";

  if (key.length === 0) {
    errors.key = "Укажите ключ поля";
  } else if (!FIELD_KEY_RE.test(key)) {
    errors.key = "Ключ: латинская буква/подчёркивание, затем буквы/цифры/_ (1–64)";
  }

  if (!FIELD_TYPE_VALUES.includes(type)) {
    errors.type = "Выберите тип поля";
  }

  if (title.length > FIELD_TITLE_MAX) {
    errors.title = `Название не длиннее ${FIELD_TITLE_MAX} символов`;
  }

  return errors;
}

/**
 * Validate the whole field list. Catches per-field errors plus duplicate keys
 * (record_schema.properties is keyed by field key — duplicates collapse silently,
 * so we reject them up front) and the empty-list case.
 *
 * @param {Array<{ key?: string, type?: string, title?: string, required?: boolean }>} fields
 * @returns {{ valid: boolean, fieldErrors: Array<object>, formError: string|null }}
 */
export function validateFields(fields) {
  const list = Array.isArray(fields) ? fields : [];
  const fieldErrors = list.map((f) => validateField(f));

  let formError = null;
  if (list.length === 0) {
    formError = "Добавьте хотя бы одно поле";
  }

  // Duplicate-key detection (case-sensitive — JSON keys are case-sensitive).
  const seen = new Map();
  list.forEach((f, i) => {
    const key = typeof f?.key === "string" ? f.key : "";
    if (key.length === 0) return;
    if (seen.has(key)) {
      fieldErrors[i] = { ...fieldErrors[i], key: "Ключ уже используется" };
      const firstIdx = seen.get(key);
      if (!fieldErrors[firstIdx].key) {
        fieldErrors[firstIdx] = { ...fieldErrors[firstIdx], key: "Ключ уже используется" };
      }
    } else {
      seen.set(key, i);
    }
  });

  const valid =
    formError === null && fieldErrors.every((e) => Object.keys(e).length === 0);
  return { valid, fieldErrors, formError };
}

/**
 * Assemble a record_schema object from the ordered field list. Field ORDER is
 * preserved by JS object insertion order in `properties` (V8/JS preserves string
 * key order). `required` lists the keys whose `required` flag is set, in the same
 * order as the fields.
 *
 * Only emits keys AJV strict accepts: type, title (when non-empty). No `format`.
 *
 * @param {Array<{ key: string, type: string, title?: string, required?: boolean }>} fields
 * @returns {object} record_schema (passes validateRecordSchemaDefinition)
 */
export function buildRecordSchema(fields) {
  const list = Array.isArray(fields) ? fields : [];
  const properties = {};
  const required = [];

  for (const f of list) {
    const key = typeof f?.key === "string" ? f.key : "";
    if (key.length === 0) continue;
    const prop = { type: f.type };
    const title = typeof f?.title === "string" ? f.title.trim() : "";
    if (title.length > 0) prop.title = title;
    properties[key] = prop;
    if (f.required) required.push(key);
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties,
  };
  // Only include `required` when non-empty (AJV accepts an empty array too, but
  // omitting it keeps the persisted schema minimal — matches the 056 seed which
  // always lists required, and 073 which lists required; either is valid).
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * Parse a persisted record_schema back into the ordered field list the editor
 * renders. Inverse of buildRecordSchema (modulo unknown extra keywords, which
 * are surfaced read-only as-is in `extra`). Tolerates absent/empty properties.
 *
 * @param {unknown} recordSchema
 * @returns {Array<{ key: string, type: string, title: string, required: boolean }>}
 */
export function parseRecordSchema(recordSchema) {
  if (recordSchema === null || typeof recordSchema !== "object" || Array.isArray(recordSchema)) {
    return [];
  }
  const props = recordSchema.properties;
  if (props === null || typeof props !== "object" || Array.isArray(props)) {
    return [];
  }
  const requiredList = Array.isArray(recordSchema.required) ? recordSchema.required : [];
  const requiredSet = new Set(requiredList.filter((k) => typeof k === "string"));

  // Object.keys preserves insertion order → field order is preserved.
  return Object.keys(props).map((key) => {
    const def = props[key];
    const rawType = def && typeof def === "object" ? def.type : undefined;
    // If the persisted type isn't one we offer, fall back to "string" so the
    // dropdown stays valid; the user can re-pick. (Honest: never show a type
    // option the backend wouldn't accept.)
    const type = FIELD_TYPE_VALUES.includes(rawType) ? rawType : "string";
    const title =
      def && typeof def === "object" && typeof def.title === "string" ? def.title : "";
    return { key, type, title, required: requiredSet.has(key) };
  });
}

/**
 * Map a non-2xx registry_def create/update response to a user-facing message.
 * Honest surfacing of the registry-defs API contract:
 *   400 VALIDATION  → the server's message (the AJV reason for a bad schema),
 *   401             → re-login hint,
 *   404 NOT_FOUND   → application / def missing,
 *   409 CONFLICT    → slug taken (create) OR destructive_schema_change (PUT),
 *   else            → generic with server message if present.
 *
 * @param {number} status
 * @param {unknown} body parsed JSON (may be null/non-object)
 * @returns {{ field?: 'slug', message: string }}
 */
export function mapSchemaError(status, body) {
  const obj = body && typeof body === "object" ? body : null;
  const serverMsg = obj ? (obj.error?.message || obj.message) : undefined;
  const code = obj ? (obj.error?.code || obj.code) : undefined;

  if (status === 400) {
    return { message: serverMsg || "Схема полей не прошла проверку — проверьте типы и ключи" };
  }
  if (status === 401) {
    return { message: "Сессия не авторизована — войдите заново" };
  }
  if (status === 404) {
    return { message: serverMsg || "Приложение или реестр не найдены" };
  }
  if (status === 409) {
    if (code === "destructive_schema_change") {
      return {
        message:
          "Изменение разрушительно: активные отчёты/шаблоны зависят от удаляемых полей. " +
          "Требуется принудительное применение с правом mgmt_object:schema_destructive.",
      };
    }
    return { field: "slug", message: "Слаг реестра уже занят в этом приложении" };
  }
  return { message: serverMsg || `Не удалось сохранить (HTTP ${status})` };
}

/** A blank field row (used by the editor's "add field" action). */
export function blankField() {
  return { key: "", type: "string", title: "", required: false };
}
