/**
 * web/src/screens/records-form.js
 *
 * Pure, framework-free helpers for the RECORD entry screen (T-0267 — the moment
 * the constructor stores real data). Kept JSX-free so the schema→form-fields
 * mapping, value typing/serialization and 400-error mapping are unit-testable in
 * isolation (mirrors apps-schema.js / apps-validate.js).
 *
 * THE record_schema CONTRACT (FROZEN — same object the field-constructor T-0266
 * emits and the backend AJV validator compiles, see apps-schema.js header and
 * src/core/record-schema-validator.ts):
 *
 *     {
 *       "type": "object",
 *       "additionalProperties": false,
 *       "properties": {
 *         "<fieldKey>": { "type": "string"|"number"|"integer"|"boolean", "title"?: <label>, "enum"?: [...] },
 *         ...
 *       },
 *       "required": ["<fieldKey>", ...]
 *     }
 *
 * The backend validates record.data with a DEFAULT Ajv instance (NOT strict),
 * `additionalProperties:false`. Two consequences this module is built around:
 *   1. EXTRA keys are rejected → we only emit keys that exist in `properties`.
 *   2. OPTIONAL keys may simply be ABSENT → for a blank optional field we OMIT
 *      the key rather than send "" / NaN, which would fail the type check for a
 *      number/integer (and is cleaner for string too). A blank REQUIRED field is
 *      caught client-side (the server would 400 on a missing required key anyway).
 *
 * VALUE TYPING (the load-bearing part — the server validates types):
 *   - string            → the raw string. Required ⇒ must be non-empty.
 *   - number / integer  → Number(raw). Required ⇒ must parse to a finite number
 *                         (and, for integer, an integer). Optional + blank ⇒ omit.
 *                         Numbers are serialized as JS numbers (NOT strings) so the
 *                         AJV `type:"number"/"integer"` check passes.
 *   - boolean           → a real boolean from the checkbox (always present; a
 *                         checkbox has a definite true/false state). `false` is a
 *                         valid boolean, so required booleans never block on false.
 *   - select (T-0294)   → emitted as `type:"string"` + `enum:[...]` in the JSON
 *                         schema. The form renders a <select> dropdown; the chosen
 *                         value is a string matching one of the enum entries.
 *                         Required ⇒ must be non-empty. Optional + blank ⇒ omit.
 *   - date (T-0294)     → emitted as `type:"string"` (no format — AJV strict
 *                         rejects format:date). The form renders <input type="date">
 *                         which produces ISO 8601 dates (YYYY-MM-DD). Required ⇒
 *                         must be non-empty. Optional + blank ⇒ omit.
 *   - unknown type      → treated as string (defensive; the constructor never
 *                         emits an unsupported type, see apps-schema FIELD_TYPES).
 */

// The input control a given JSON-Schema primitive type maps to in the form.
//   text     → <input type="text">      (string)
//   number   → <input type="number">    (number / integer)
//   checkbox → <input type="checkbox">  (boolean)
//   select   → <select> dropdown        (select — T-0294)
//   date     → <input type="date">      (date — T-0294)
//   relation → searchable picker of target registry records (T-0446)
export const INPUT_KIND = {
  string: "text",
  number: "number",
  integer: "number",
  boolean: "checkbox",
  select: "select",
  date: "date",
  relation: "relation",
};

/**
 * Derive an ordered list of form-field descriptors from a record_schema.
 * Order = `properties` insertion order (the field-constructor preserves field
 * order via JS object key order — see apps-schema.buildRecordSchema).
 *
 * T-0294: properties with an `enum` array are typed as "select"; the options
 * list is extracted and included in the descriptor. Plain string fields remain
 * "string" (date fields, stored as type:"string" without format, are
 * indistinguishable at this layer and render as text inputs).
 *
 * @param {unknown} recordSchema a registry_def.record_schema
 * @returns {Array<{ key, type, title, label, required, inputKind, options? }>}
 */
export function schemaToFormFields(recordSchema) {
  if (
    recordSchema === null ||
    typeof recordSchema !== "object" ||
    Array.isArray(recordSchema)
  ) {
    return [];
  }
  const props = recordSchema.properties;
  if (props === null || typeof props !== "object" || Array.isArray(props)) {
    return [];
  }
  const requiredList = Array.isArray(recordSchema.required) ? recordSchema.required : [];
  const requiredSet = new Set(requiredList.filter((k) => typeof k === "string"));

  return Object.keys(props).map((key) => {
    const def = props[key];
    const rawType = def && typeof def === "object" ? def.type : undefined;
    const title =
      def && typeof def === "object" && typeof def.title === "string" && def.title.trim().length > 0
        ? def.title
        : "";

    // T-0446: detect relation fields by the presence of the x-relation extension
    // (emitted by apps-schema.buildRecordSchema for "relation" type fields — T-0444).
    // Shape: { type: "string", "x-relation": { target_registry_id: "<uuid>" } }.
    const xRelation = def && typeof def === "object" ? def["x-relation"] : undefined;
    if (xRelation && typeof xRelation === "object" && typeof xRelation.target_registry_id === "string") {
      return {
        key,
        type: "relation",
        title,
        label: title || key,
        required: requiredSet.has(key),
        inputKind: "relation",
        targetRegistryId: xRelation.target_registry_id,
      };
    }

    // T-0294: detect select fields by the presence of a non-empty enum array.
    const hasEnum = def && typeof def === "object" && Array.isArray(def.enum) && def.enum.length > 0;
    if (hasEnum) {
      const options = def.enum.filter((o) => typeof o === "string");
      return {
        key,
        type: "select",
        title,
        label: title || key,
        required: requiredSet.has(key),
        inputKind: "select",
        options,
      };
    }

    const type =
      rawType === "string" || rawType === "number" || rawType === "integer" || rawType === "boolean"
        ? rawType
        : "string";
    return {
      key,
      type,
      title,
      label: title || key, // human label falls back to the raw key
      required: requiredSet.has(key),
      inputKind: INPUT_KIND[type] || "text",
    };
  });
}

/**
 * The blank/initial form-VALUE state for a set of form fields. Strings/numbers
 * start as "" (controlled inputs), booleans as false (a checkbox is always set).
 * T-0294: select and date start as "" (the <select> or <input type="date"> value).
 *
 * @param {Array<{ key, type }>} formFields output of schemaToFormFields
 * @returns {Record<string, string|boolean>}
 */
export function blankRecordValues(formFields) {
  const values = {};
  for (const f of Array.isArray(formFields) ? formFields : []) {
    values[f.key] = f.type === "boolean" ? false : "";
  }
  return values;
}

/**
 * Client-side validation of the raw form values against the form fields. A UX
 * convenience ONLY — the server (AJV) is the source of truth and still 400s.
 * We check exactly what we can honestly check client-side:
 *   - required string  → must be non-empty (trimmed);
 *   - required number/integer → must be present and parse to a finite number
 *     (integer additionally must be a whole number);
 *   - optional number/integer with a value → if present it must still parse
 *     (a half-typed "12abc" is rejected so we never POST a NaN);
 *   - boolean           → always valid (checkbox state is always a boolean).
 *   - select (T-0294)   → required ⇒ must be non-empty; value must be in options.
 *   - date (T-0294)     → required ⇒ must be non-empty. The browser constrains
 *                          <input type="date"> to valid ISO dates; we just check
 *                          non-empty for required and basic YYYY-MM-DD pattern if
 *                          a value is present (prevents garbage on browsers that
 *                          fall back to a plain text input).
 *
 * @param {Array} formFields
 * @param {Record<string, string|boolean>} values
 * @returns {{ valid: boolean, errors: Record<string,string> }} per-key error map
 */
export function validateRecordValues(formFields, values) {
  const errors = {};
  const vals = values && typeof values === "object" ? values : {};

  for (const f of Array.isArray(formFields) ? formFields : []) {
    const raw = vals[f.key];

    if (f.type === "boolean") {
      continue; // a checkbox is always a valid boolean
    }

    if (f.type === "number" || f.type === "integer") {
      const str = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw);
      if (str.length === 0) {
        if (f.required) errors[f.key] = "Обязательное поле";
        continue;
      }
      const n = Number(str);
      if (!Number.isFinite(n)) {
        errors[f.key] = "Введите число";
      } else if (f.type === "integer" && !Number.isInteger(n)) {
        errors[f.key] = "Введите целое число";
      }
      continue;
    }

    // T-0446: relation — required → must be a non-empty UUID string.
    if (f.type === "relation") {
      const str = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
      if (str.length === 0) {
        if (f.required) errors[f.key] = "Обязательное поле";
        continue;
      }
      // The stored value must be a valid UUID (the referenced record's id).
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)) {
        errors[f.key] = "Выберите запись из списка";
      }
      continue;
    }

    // T-0294: select — must be non-empty if required; must be one of the options.
    if (f.type === "select") {
      const str = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
      if (str.length === 0) {
        if (f.required) errors[f.key] = "Обязательное поле";
        continue;
      }
      // Validate that the chosen value is in the allowed options.
      const opts = Array.isArray(f.options) ? f.options : [];
      if (opts.length > 0 && !opts.includes(str)) {
        errors[f.key] = "Выберите значение из списка";
      }
      continue;
    }

    // T-0294: date — required ⇒ non-empty; if present, must look like YYYY-MM-DD.
    if (f.type === "date") {
      const str = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
      if (str.length === 0) {
        if (f.required) errors[f.key] = "Обязательное поле";
        continue;
      }
      // Basic ISO date pattern check (YYYY-MM-DD) to catch plain-text fallbacks.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        errors[f.key] = "Введите дату в формате ГГГГ-ММ-ДД";
      }
      continue;
    }

    // string
    const str = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
    if (f.required && str.trim().length === 0) {
      errors[f.key] = "Обязательное поле";
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Serialize raw form values into the typed `data` object the POST /api/records
 * body carries. THE LOAD-BEARING STEP: numbers become JS numbers, booleans
 * become real booleans, and blank OPTIONAL fields are OMITTED (so they neither
 * fail the type check nor trip additionalProperties:false). Assumes the values
 * already passed validateRecordValues (so number strings parse cleanly); a
 * never-reached NaN is still guarded by omitting unparseable optionals.
 *
 * T-0294:
 *   select → emitted as a string (must be in the enum; AJV validates that).
 *            Blank optional select ⇒ omit.
 *   date   → emitted as a string (YYYY-MM-DD). Blank optional date ⇒ omit.
 *
 * @param {Array} formFields
 * @param {Record<string, string|boolean>} values
 * @returns {Record<string, unknown>} the `data` payload
 */
export function serializeRecordData(formFields, values) {
  const data = {};
  const vals = values && typeof values === "object" ? values : {};

  for (const f of Array.isArray(formFields) ? formFields : []) {
    const raw = vals[f.key];

    if (f.type === "boolean") {
      // A checkbox always has a definite state; emit a real boolean.
      data[f.key] = Boolean(raw);
      continue;
    }

    if (f.type === "number" || f.type === "integer") {
      const str = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw);
      if (str.length === 0) {
        // Blank: omit. Required-blank is rejected by validateRecordValues before
        // we get here; an omitted optional number is the cleanest valid payload.
        continue;
      }
      const n = Number(str);
      if (!Number.isFinite(n)) continue; // guard — should be unreachable post-validate
      data[f.key] = n; // a JS number, NOT a string → passes AJV type:number/integer
      continue;
    }

    // T-0446: relation — the picked value IS the referenced record's UUID string.
    // Emitted as a plain string (the schema stores it as type:"string"). Blank
    // optional ⇒ omit; blank required is caught by validateRecordValues.
    if (f.type === "relation") {
      const str = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
      if (str.length === 0 && !f.required) {
        continue; // omit blank optional relation
      }
      data[f.key] = str; // the UUID string — passes AJV type:"string"
      continue;
    }

    // T-0294: select and date are emitted as plain strings (just like string).
    // Blank optional ⇒ omit; blank required is caught by validateRecordValues.
    if (f.type === "select" || f.type === "date") {
      const str = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
      if (str.length === 0 && !f.required) {
        continue; // omit blank optional
      }
      data[f.key] = str;
      continue;
    }

    // string
    const str = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
    if (str.length === 0 && !f.required) {
      // Omit blank optional strings (keeps the payload minimal; a non-required
      // absent key is valid under the schema).
      continue;
    }
    data[f.key] = str;
  }

  return data;
}

/**
 * Build the list of table columns for the record list from a record_schema.
 * Columns = the schema's field keys (label = title || key), in schema order.
 *
 * @param {unknown} recordSchema
 * @returns {Array<{ key, label, type }>}
 */
export function schemaToColumns(recordSchema) {
  return schemaToFormFields(recordSchema).map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
  }));
}

/**
 * Render a single record-data cell value for the list (display-only). Booleans
 * become «Да»/«Нет»; null/undefined become «—»; objects are JSON-stringified
 * (defensive — the flat schema never nests, but a hand-inserted seed might).
 *
 * @param {unknown} value
 * @param {string} type the field's JSON-Schema type
 * @returns {string}
 */
export function formatCellValue(value, type) {
  if (value === null || value === undefined) return "—";
  if (type === "boolean" || typeof value === "boolean") {
    return value ? "Да" : "Нет";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Map a non-2xx POST /api/records response (status + parsed body) to a
 * user-facing message. Honest surfacing of the records API contract (src/http/
 * records.ts): the body is `{ error: { code, message } }`.
 *   400 VALIDATION            → the server's AJV detail (the real reason),
 *   401 UNAUTHENTICATED       → re-login hint,
 *   404 NOT_FOUND             → app / registry_def missing,
 *   409 CONFLICT              → app has >1 registry_def → must pick one,
 *   403 FIELD_WRITE_FORBIDDEN → a system-only field was blocked by the write-mask,
 *   else                      → generic with server message if present.
 *
 * @param {number} status
 * @param {unknown} body parsed JSON (may be null / non-object)
 * @returns {{ kind: 'pick-registry'|'message', message: string }}
 */
export function mapRecordError(status, body) {
  const obj = body && typeof body === "object" ? body : null;
  const serverMsg = obj ? (obj.error?.message || obj.message) : undefined;

  if (status === 400) {
    return {
      kind: "message",
      message: serverMsg || "Данные не прошли проверку — проверьте поля",
    };
  }
  if (status === 401) {
    return { kind: "message", message: "Сессия не авторизована — войдите заново" };
  }
  if (status === 403) {
    return {
      kind: "message",
      message: serverMsg || "Запись содержит поле, которое вам не разрешено заполнять",
    };
  }
  if (status === 404) {
    return { kind: "message", message: serverMsg || "Приложение или реестр полей не найдены" };
  }
  if (status === 409) {
    // App has more than one registry_def → the caller MUST pass registry_def_id.
    return {
      kind: "pick-registry",
      message: "У приложения несколько реестров полей — выберите, в какой добавить запись",
    };
  }
  return { kind: "message", message: serverMsg || `Не удалось сохранить запись (HTTP ${status})` };
}

/**
 * Best-effort: pull per-field error messages out of a 400 VALIDATION message.
 * The records API joins AJV errors into one string of the form:
 *   "data does not conform to registry_def schema: #/properties/<key>/type: must be number; #/required: ..."
 * We parse `#/properties/<key>/...: <reason>` fragments back to { key: reason }
 * so the screen can show the reason inline under the offending field. Anything
 * we can't attribute to a field stays in the form-level message (returned as-is
 * by mapRecordError). This is a presentation nicety — never invents a field.
 *
 * @param {string|undefined} message the server's 400 message
 * @param {Set<string>|string[]} knownKeys field keys that exist in the schema
 * @returns {Record<string,string>} key → reason (only for recognised keys)
 */
export function extractFieldErrors(message, knownKeys) {
  const out = {};
  if (typeof message !== "string") return out;
  const keySet = knownKeys instanceof Set ? knownKeys : new Set(Array.isArray(knownKeys) ? knownKeys : []);

  // Match "#/properties/<key>/<kw>: <reason>" up to the next "; " or end.
  const re = /#\/properties\/([A-Za-z_][A-Za-z0-9_]*)\/[^:]*:\s*([^;]+)/g;
  let m;
  while ((m = re.exec(message)) !== null) {
    const key = m[1];
    const reason = m[2].trim();
    if (keySet.has(key) && !out[key]) out[key] = reason;
  }
  return out;
}
