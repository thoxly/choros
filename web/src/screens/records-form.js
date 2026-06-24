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
//   text       → <input type="text">      (string)
//   number     → <input type="number">    (number / integer)
//   checkbox   → <input type="checkbox">  (boolean)
//   select     → <select> dropdown        (select — T-0294)
//   date       → <input type="date">      (date — T-0294)
//   relation   → searchable picker of target registry records (T-0446)
//   collection → repeatable-rows table (line-items — T-0448/T-0449)
//   computed   → read-only rollup readout (NEVER a writable control — T-0453)
export const INPUT_KIND = {
  string: "text",
  number: "number",
  integer: "number",
  boolean: "checkbox",
  select: "select",
  date: "date",
  relation: "relation",
  collection: "collection",
  computed: "computed",
};

/**
 * T-0453: Compute the rollup value for a computed/«Итог» field from a data object.
 *
 * PURE function — no side effects, no throws. Returns a JS number or null.
 *
 * @param {{ rollupSource: string, rollupOp: string, rollupValueField?: string,
 *           rollupFactorField?: string }} field  form-field descriptor for a computed field
 * @param {Record<string, unknown>} data  record.data or live form values
 * @returns {number | null}
 *
 * Semantics:
 *   source: data[field.rollupSource] must be an array of row objects (a collection).
 *     If absent or not an array → null (source missing; no error).
 *
 *   For each row, read value_field (and factor_field for op:"sum" when set) as numbers.
 *   Non-numeric or missing cells:
 *     - sum/avg/min/max : skip the cell entirely (treat as if the row doesn't exist
 *       for that aggregation). This is the honest choice: a blank optional price cell
 *       should not make the total zero, nor should it error.
 *     - count : all rows counted regardless of cell contents.
 *
 *   Empty source array (0 rows) or all cells non-numeric → returns null (not 0),
 *   because "no data" should display as «—», not as 0, which would be misleading.
 *   Exception: count on an empty array → null (zero rows → no meaningful count to show).
 *
 *   Operations:
 *     sum   : Σ value × factor (factor defaults to 1 when factor_field absent/non-numeric)
 *     count : total row count (ignores value_field)
 *     avg   : mean of numeric value cells
 *     min   : minimum numeric value cell
 *     max   : maximum numeric value cell
 */
export function computeRollup(field, data) {
  if (!field || typeof field !== "object") return null;
  const source = typeof field.rollupSource === "string" ? field.rollupSource : "";
  const op = typeof field.rollupOp === "string" ? field.rollupOp : "";
  const valueField = typeof field.rollupValueField === "string" ? field.rollupValueField : "";
  const factorField = typeof field.rollupFactorField === "string" ? field.rollupFactorField : "";

  if (source.length === 0 || op.length === 0) return null;

  const dataObj = data && typeof data === "object" ? data : {};
  const rows = dataObj[source];
  if (!Array.isArray(rows)) return null;

  // count: just the row count, value_field irrelevant
  if (op === "count") {
    return rows.length === 0 ? null : rows.length;
  }

  // For all other ops, collect numeric values (and optional factors for sum)
  const values = [];
  for (const row of rows) {
    const rowObj = row && typeof row === "object" ? row : {};
    const raw = rowObj[valueField];
    const rawStr = typeof raw === "number" ? raw : (typeof raw === "string" ? raw.trim() : null);
    if (rawStr === null || rawStr === "") continue;
    const v = Number(rawStr);
    if (!Number.isFinite(v)) continue;

    if (op === "sum" && factorField.length > 0) {
      const rawF = rowObj[factorField];
      const rawFStr = typeof rawF === "number" ? rawF : (typeof rawF === "string" ? rawF.trim() : null);
      let factor = 1;
      if (rawFStr !== null && rawFStr !== "") {
        const f = Number(rawFStr);
        if (Number.isFinite(f)) factor = f;
      }
      values.push(v * factor);
    } else {
      values.push(v);
    }
  }

  if (values.length === 0) return null;

  if (op === "sum") {
    return values.reduce((acc, x) => acc + x, 0);
  }
  if (op === "avg") {
    return values.reduce((acc, x) => acc + x, 0) / values.length;
  }
  if (op === "min") {
    return Math.min(...values);
  }
  if (op === "max") {
    return Math.max(...values);
  }

  return null; // unknown op: degrade silently
}

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

    // T-0449: detect collection fields (T-0448 wire shape):
    //   { type: "array", title?, items: { type: "object", additionalProperties: false,
    //     properties: { <sub-fields> }, required?: [...] } }
    // Sub-fields are scalars (select by enum, date/number/integer/boolean by type).
    if (
      def && typeof def === "object" && !Array.isArray(def) &&
      rawType === "array" &&
      def.items && typeof def.items === "object" && !Array.isArray(def.items) &&
      def.items.type === "object"
    ) {
      const itemProps =
        def.items.properties && typeof def.items.properties === "object" && !Array.isArray(def.items.properties)
          ? def.items.properties
          : {};
      const itemRequired = Array.isArray(def.items.required)
        ? new Set(def.items.required.filter((k) => typeof k === "string"))
        : new Set();

      const subFields = Object.keys(itemProps).map((sfKey) => {
        const sfDef = itemProps[sfKey];
        const sfTitle =
          sfDef && typeof sfDef === "object" && typeof sfDef.title === "string" && sfDef.title.trim().length > 0
            ? sfDef.title
            : "";
        const sfHasEnum =
          sfDef && typeof sfDef === "object" && Array.isArray(sfDef.enum) && sfDef.enum.length > 0;
        if (sfHasEnum) {
          const sfOptions = sfDef.enum.filter((o) => typeof o === "string");
          return {
            key: sfKey,
            type: "select",
            label: sfTitle || sfKey,
            required: itemRequired.has(sfKey),
            inputKind: "select",
            options: sfOptions,
          };
        }
        const sfRawType = sfDef && typeof sfDef === "object" ? sfDef.type : undefined;
        const sfType =
          sfRawType === "string" || sfRawType === "number" || sfRawType === "integer" || sfRawType === "boolean"
            ? sfRawType
            : "string";
        return {
          key: sfKey,
          type: sfType,
          label: sfTitle || sfKey,
          required: itemRequired.has(sfKey),
          inputKind: INPUT_KIND[sfType] || "text",
        };
      });

      return {
        key,
        type: "collection",
        title,
        label: title || key,
        required: requiredSet.has(key),
        inputKind: "collection",
        subFields,
      };
    }

    // T-0453: detect computed (rollup) fields by the presence of x-rollup extension.
    // Shape: { type: "number", "x-rollup": { source, op, value_field, factor_field? } }.
    // These fields are NEVER required and NEVER appear in the submitted data
    // (serializeRecordData omits them; the value is computed at display time).
    const xRollup = def && typeof def === "object" ? def["x-rollup"] : undefined;
    if (xRollup && typeof xRollup === "object" && !Array.isArray(xRollup) && typeof xRollup.source === "string") {
      return {
        key,
        type: "computed",
        title,
        label: title || key,
        required: false, // computed fields are NEVER required
        inputKind: "computed",
        rollupSource: typeof xRollup.source === "string" ? xRollup.source : "",
        rollupOp: typeof xRollup.op === "string" ? xRollup.op : "",
        rollupValueField: typeof xRollup.value_field === "string" ? xRollup.value_field : "",
        rollupFactorField: typeof xRollup.factor_field === "string" ? xRollup.factor_field : "",
      };
    }

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
    if (f.type === "computed") {
      // T-0453: computed fields have no user-editable state — they are derived
      // at display time via computeRollup. Do NOT add a key to the values map
      // so serializeRecordData never sees it and can never accidentally emit it.
      continue;
    }
    if (f.type === "boolean") {
      values[f.key] = false;
    } else if (f.type === "collection") {
      // T-0449: a collection starts as an empty row array; T-0450 renders the row table.
      values[f.key] = [];
    } else {
      values[f.key] = "";
    }
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

    // T-0453: computed fields are never user-input — skip validation entirely.
    // The value is derived at display time; no validation error is ever appropriate.
    if (f.type === "computed") {
      continue;
    }

    // T-0449: collection — validate each row cell by its sub-field rules.
    // Error shape: { [fieldKey]: { rows: [ { [subKey]: "error message" }, … ] } }
    // Each index in `rows` corresponds to a data row (undefined = no errors for that row).
    // This shape is consumed by the T-0450 row-table UI component.
    if (f.type === "collection") {
      const rows = Array.isArray(raw) ? raw : [];
      if (f.required && rows.length === 0) {
        errors[f.key] = { rows: [], _collection: "Добавьте хотя бы одну строку" };
        continue;
      }
      const subFields = Array.isArray(f.subFields) ? f.subFields : [];
      const rowErrors = [];
      let hasRowError = false;
      for (const row of rows) {
        const rowObj = row && typeof row === "object" ? row : {};
        const cellErrors = {};
        for (const sf of subFields) {
          const cellRaw = rowObj[sf.key];
          if (sf.type === "boolean") continue;
          if (sf.type === "number" || sf.type === "integer") {
            const str = typeof cellRaw === "string" ? cellRaw.trim() : cellRaw == null ? "" : String(cellRaw);
            if (str.length === 0) {
              if (sf.required) cellErrors[sf.key] = "Обязательное поле";
            } else {
              const n = Number(str);
              if (!Number.isFinite(n)) {
                cellErrors[sf.key] = "Введите число";
              } else if (sf.type === "integer" && !Number.isInteger(n)) {
                cellErrors[sf.key] = "Введите целое число";
              }
            }
            continue;
          }
          if (sf.type === "select") {
            const str = typeof cellRaw === "string" ? cellRaw : cellRaw == null ? "" : String(cellRaw);
            if (str.length === 0) {
              if (sf.required) cellErrors[sf.key] = "Обязательное поле";
            } else {
              const opts = Array.isArray(sf.options) ? sf.options : [];
              if (opts.length > 0 && !opts.includes(str)) cellErrors[sf.key] = "Выберите значение из списка";
            }
            continue;
          }
          if (sf.type === "date") {
            const str = typeof cellRaw === "string" ? cellRaw.trim() : cellRaw == null ? "" : String(cellRaw).trim();
            if (str.length === 0) {
              if (sf.required) cellErrors[sf.key] = "Обязательное поле";
            } else if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
              cellErrors[sf.key] = "Введите дату в формате ГГГГ-ММ-ДД";
            }
            continue;
          }
          // string
          const str = typeof cellRaw === "string" ? cellRaw : cellRaw == null ? "" : String(cellRaw);
          if (sf.required && str.trim().length === 0) cellErrors[sf.key] = "Обязательное поле";
        }
        const hasCellError = Object.keys(cellErrors).length > 0;
        rowErrors.push(hasCellError ? cellErrors : undefined);
        if (hasCellError) hasRowError = true;
      }
      if (hasRowError) errors[f.key] = { rows: rowErrors };
      continue;
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

    // T-0453: THE KEY TRAP — computed fields MUST NEVER appear in the output `data`.
    // The field IS declared in the schema `properties` (type:"number" with x-rollup),
    // but it is NEVER stored (value is derived at display time). If a computed key
    // ends up in `data`, every record POST 400s on AJV `additionalProperties:false`
    // because the schema strips x-rollup before AJV compile, leaving the key as an
    // extra property that the validator rejects. OMIT unconditionally.
    if (f.type === "computed") {
      continue; // never write computed fields to the record data payload
    }

    if (f.type === "boolean") {
      // A checkbox always has a definite state; emit a real boolean.
      data[f.key] = Boolean(raw);
      continue;
    }

    // T-0449: collection — emit an ARRAY of typed row objects.
    // Each cell is coerced by its sub-field type (mirrors the scalar per-type logic).
    // Fully-blank trailing rows are dropped (a row is "fully blank" when EVERY
    // non-boolean cell is an empty string or null/undefined).
    if (f.type === "collection") {
      const rows = Array.isArray(raw) ? raw : [];
      const subFields = Array.isArray(f.subFields) ? f.subFields : [];

      // Drop fully-blank trailing rows (from the end).
      let lastNonBlankIdx = -1;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i] && typeof rows[i] === "object" ? rows[i] : {};
        const hasContent = subFields.some((sf) => {
          if (sf.type === "boolean") return true; // checkbox always has state
          const v = row[sf.key];
          const str = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
          return str.length > 0;
        });
        if (hasContent) { lastNonBlankIdx = i; break; }
      }
      const trimmedRows = rows.slice(0, lastNonBlankIdx + 1);

      const serialized = trimmedRows.map((row) => {
        const rowObj = row && typeof row === "object" ? row : {};
        const out = {};
        for (const sf of subFields) {
          const cellRaw = rowObj[sf.key];
          if (sf.type === "boolean") {
            out[sf.key] = Boolean(cellRaw);
            continue;
          }
          if (sf.type === "number" || sf.type === "integer") {
            const str = typeof cellRaw === "string" ? cellRaw.trim() : cellRaw == null ? "" : String(cellRaw);
            if (str.length === 0) continue; // omit blank optional cell
            const n = Number(str);
            if (Number.isFinite(n)) out[sf.key] = n;
            continue;
          }
          // string, select, date
          const str = typeof cellRaw === "string" ? cellRaw : cellRaw == null ? "" : String(cellRaw);
          if (str.length === 0 && !sf.required) continue; // omit blank optional cell
          out[sf.key] = str;
        }
        return out;
      });

      // Optional empty collection → omit (consistent with optional-handling for scalars).
      if (serialized.length === 0 && !f.required) continue;
      data[f.key] = serialized;
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
 * Derive a human-readable display label from a target record's data object.
 * Returns the first non-empty string or finite-number value found in data
 * (schema-order), or a short id prefix as fallback. Never surfaces a raw UUID.
 *
 * This is the canonical label-derivation for relation fields — T-0447 exports
 * it so both the list (RelationCell) and the detail card can reuse the same
 * logic without duplication. Also used by RelationPicker (T-0446) in
 * screen-app-records.jsx — that copy should be removed in favour of this one.
 *
 * @param {object|null|undefined} record  a record row from GET /api/records
 * @returns {string}
 */
export function deriveRecordLabel(record) {
  if (!record) return "—";
  const data = record.data && typeof record.data === "object" ? record.data : {};
  for (const key of Object.keys(data)) {
    const v = data[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  // Fallback: first 8 chars of id — unambiguous short ref, not a raw placeholder.
  return typeof record.id === "string" ? record.id.slice(0, 8) + "…" : "—";
}

/**
 * Render a single record-data cell value for the list (display-only). Booleans
 * become «Да»/«Нет»; null/undefined become «—»; objects are JSON-stringified
 * (defensive — the flat schema never nests, but a hand-inserted seed might).
 *
 * T-0447: relation fields (type === "relation") store a UUID string as their
 * value. Because resolving the UUID to a label is async, formatCellValue cannot
 * do it directly. It returns the sentinel symbol RELATION_CELL_ASYNC so the
 * caller (screen-app-records.jsx / screen-record-detail.jsx) knows to render
 * an async <RelationCell> / resolve via fetch. The caller must check
 *   typeof result === 'symbol' && result === RELATION_CELL_ASYNC
 * before rendering. When the value is null/undefined the normal "—" path fires.
 *
 * @param {unknown} value
 * @param {string} type the field's JSON-Schema type
 * @returns {string|symbol}  string in all cases except relation with a value
 */
export const RELATION_CELL_ASYNC = Symbol("relation_cell_async");

export function formatCellValue(value, type) {
  if (value === null || value === undefined) return "—";
  if (type === "boolean" || typeof value === "boolean") {
    return value ? "Да" : "Нет";
  }
  // T-0447: relation value is a UUID — label resolution is async.
  // Return the sentinel so callers can render an async cell component.
  // Empty string means no target was picked (blank optional) → render "—".
  if (type === "relation") {
    if (typeof value === "string" && value.length > 0) return RELATION_CELL_ASYNC;
    return "—"; // blank or unexpected non-string → absent
  }
  // T-0453: computed field value is a number (pre-computed before call) or null.
  // Format as a string number (locale-neutral — consistent with number fields) or «—».
  // This branch is ADDITIVE — the relation and collection branches above are NOT modified.
  // Callers pass the already-computed number (from computeRollup) as `value`, not raw data.
  if (type === "computed") {
    if (typeof value === "number" && Number.isFinite(value)) {
      // Round to at most 10 decimal places to avoid float display noise (e.g. 0.1+0.2)
      // while still supporting legitimate fractional results (avg, factor multiplication).
      const rounded = Math.round(value * 1e10) / 1e10;
      return String(rounded);
    }
    return "—";
  }

  // T-0449: collection value is an array of row objects.
  // Summarize as «N позиций» (or «—» when empty/absent).
  // This branch is ADDITIVE — the relation branch above is NOT modified.
  if (type === "collection") {
    if (!Array.isArray(value) || value.length === 0) return "—";
    const n = value.length;
    // Russian grammatical agreement for «позиция»:
    //   1, 21, 31…  → позиция
    //   2-4, 22-24… → позиции
    //   5-20, 25-29… → позиций
    const mod10 = n % 10;
    const mod100 = n % 100;
    let word;
    if (mod100 >= 11 && mod100 <= 19) {
      word = "позиций";
    } else if (mod10 === 1) {
      word = "позиция";
    } else if (mod10 >= 2 && mod10 <= 4) {
      word = "позиции";
    } else {
      word = "позиций";
    }
    return `${n} ${word}`;
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
