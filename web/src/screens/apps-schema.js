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
 *   string · number · integer · boolean · select · date
 *   (object/array/null compile too but need sub-schemas to mean anything for a
 *    flat record form, so they are intentionally NOT offered — no dead options.)
 *
 * T-0294 ADDITIONS:
 *   select — a constrained-values string: emitted as { type: "string", enum: [...] }
 *            in the record_schema. The `enum` array is AJV-strict-compilable (unlike
 *            `format`). At least one option is required; each option is a non-empty
 *            string, unique within the field.
 *   date   — an ISO 8601 date string. AJV strict REJECTS `format: "date"` (unknown
 *            format — throws on compile), so this emits as { type: "string" } in the
 *            record_schema; the UI renders <input type="date"> to constrain input.
 *            Round-trip note: parseRecordSchema cannot distinguish a plain "string"
 *            from a "date" in the persisted schema (no AJV-compliant annotation
 *            exists). A persisted date field loads back as "string" — acceptable per
 *            the constructor's read-back contract.
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
//
// T-0294: "select" and "date" are EDITOR-LEVEL types; they map to JSON Schema
// primitives in buildRecordSchema (select → string+enum, date → string). They
// are included in FIELD_TYPE_VALUES so validateField accepts them.
export const FIELD_TYPES = [
  { value: "string", label: "Текст" },
  { value: "number", label: "Число" },
  { value: "integer", label: "Целое" },
  { value: "boolean", label: "Да/Нет" },
  { value: "select", label: "Список (select)" },
  { value: "date", label: "Дата" },
];

export const FIELD_TYPE_VALUES = FIELD_TYPES.map((t) => t.value);

// Field key: identifier-ish (letter/underscore lead, then word chars), 1..64.
export const FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const FIELD_TITLE_MAX = 256;

/**
 * Validate a single field row for the editor.
 *
 * T-0294: for select fields, `options` must be a non-empty array of non-empty
 * unique strings (these become the JSON Schema `enum` array). The validation
 * sets `errors.options` when the constraint is violated.
 *
 * @param {{ key?: string, type?: string, title?: string, options?: string[] }} field
 * @returns {{ key?: string, type?: string, title?: string, options?: string }} per-field error map (empty = ok)
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

  // T-0294: validate select options
  if (type === "select") {
    const opts = Array.isArray(field?.options) ? field.options : [];
    const nonEmpty = opts.filter((o) => typeof o === "string" && o.trim().length > 0);
    if (nonEmpty.length === 0) {
      errors.options = "Укажите хотя бы один вариант";
    } else {
      const seen = new Set();
      for (const o of nonEmpty) {
        if (seen.has(o.trim())) {
          errors.options = "Варианты не должны повторяться";
          break;
        }
        seen.add(o.trim());
      }
    }
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
 * Only emits keys AJV strict accepts: type, title (when non-empty), enum (for
 * select fields). No `format` (AJV strict throws on unknown formats — see header).
 *
 * T-0294 type mapping:
 *   select → { type: "string", enum: [...options] }  (AJV strict compiles enum)
 *   date   → { type: "string" }                       (no format — AJV rejects it)
 *
 * @param {Array<{ key: string, type: string, title?: string, required?: boolean, options?: string[] }>} fields
 * @returns {object} record_schema (passes validateRecordSchemaDefinition)
 */
export function buildRecordSchema(fields) {
  const list = Array.isArray(fields) ? fields : [];
  const properties = {};
  const required = [];

  for (const f of list) {
    const key = typeof f?.key === "string" ? f.key : "";
    if (key.length === 0) continue;

    let prop;
    if (f.type === "select") {
      // select → type: string + enum array (AJV strict compiles this correctly).
      // Deduplicate and filter blank options.
      const rawOpts = Array.isArray(f.options) ? f.options : [];
      const opts = [...new Set(rawOpts.filter((o) => typeof o === "string" && o.trim().length > 0).map((o) => o.trim()))];
      prop = { type: "string", enum: opts.length > 0 ? opts : [""] };
    } else if (f.type === "date") {
      // date → type: string (no format; AJV strict rejects format:date).
      // The UI renders <input type="date"> which constrains values to ISO dates.
      prop = { type: "string" };
    } else {
      prop = { type: f.type };
    }

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
 * T-0294: a property with `enum` is detected as a "select" field; its options
 * array is extracted. A "date" field (stored as type:"string" in the schema)
 * cannot be distinguished from a plain string field — it parses back as "string"
 * (see header for rationale).
 *
 * @param {unknown} recordSchema
 * @returns {Array<{ key: string, type: string, title: string, required: boolean, options?: string[] }>}
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

    // T-0294: detect select fields by the presence of an enum array.
    const hasEnum = def && typeof def === "object" && Array.isArray(def.enum) && def.enum.length > 0;
    if (hasEnum) {
      const options = def.enum.filter((o) => typeof o === "string");
      const title =
        typeof def.title === "string" ? def.title : "";
      return { key, type: "select", title, required: requiredSet.has(key), options };
    }

    // If the persisted type isn't one we offer (excluding select which is handled
    // above), fall back to "string" so the dropdown stays valid; the user can re-pick.
    // (Honest: never show a type option the backend wouldn't accept.)
    const nonSelectTypes = FIELD_TYPE_VALUES.filter((v) => v !== "select");
    const type = nonSelectTypes.includes(rawType) ? rawType : "string";
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

/**
 * A blank field row (used by the editor's "add field" action).
 * T-0294: includes `options` (empty array — populated when type is "select").
 */
export function blankField() {
  return { key: "", type: "string", title: "", required: false, options: [] };
}
