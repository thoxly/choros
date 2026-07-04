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
 *   string · number · integer · boolean · select · date · relation
 *   (object/array/null compile too but need sub-schemas to mean anything for a
 *    flat record form, so they are intentionally NOT offered — no dead options.)
 *
 * T-0294 ADDITIONS:
 *   select — a constrained-values string: emitted as { type: "string", enum: [...] }
 *            in the record_schema. The `enum` array is AJV-strict-compilable (unlike
 *            `format`). At least one option is required; each option is a non-empty
 *            string, unique within the field.
 *   date     — an ISO 8601 date string. AJV strict REJECTS `format: "date"` (unknown
 *              format — throws on compile), so this emits as { type: "string", "x-date": true }
 *              in the record_schema; the UI renders <input type="date"> to constrain input.
 *              T-0553: x-date is the round-trip discriminator (same x-* convention as
 *              x-person/x-url/x-email; stripped before AJV compile). parseRecordSchema and
 *              schemaToFormFields restore type "date" from x-date, so a date field survives
 *              save→reload. Legacy date fields persisted before T-0553 (plain { type:"string" },
 *              no x-date) load back as "string" — backward-compatible, no regression.
 *              NOTE: collection date SUB-fields stay plain { type:"string" } — stripXExtensions
 *              does not recurse into items.properties, so a nested x-date would break AJV.
 *
 * T-0444 ADDITION:
 *   relation — a pointer to a record in another набор полей (registry_def). Emitted
 *              as { type: "string", "x-relation": { target_registry_id: <uuid> } }.
 *              The `x-` prefix is a JSON Schema extension convention; AJV strict
 *              REJECTS unknown keywords (including x-prefixed ones), so
 *              validateRecordSchemaDefinition strips x-* keys before compiling and
 *              re-attaches them after (additive, non-destructive). The x-relation
 *              contract is PINNED (T-0445 depends on it).
 *
 * T-0448 ADDITION:
 *   collection — a «Список строк» (line-items) field: an array of sub-records, each
 *               row having one or more SCALAR sub-fields (string/number/integer/boolean/
 *               select/date — NOT collection or relation; depth cap = 1). Emitted as a
 *               NATIVE JSON-Schema array:
 *                 { type: "array", title, items: { type: "object",
 *                   additionalProperties: false,
 *                   properties: { <sub-fields via scalar emit logic> },
 *                   required: [ <required sub-fields> ] } }
 *               No x-* extensions → AJV strict compiles this natively without stripping.
 *
 * T-0452 ADDITION:
 *   computed — an «Итог» (rollup/aggregate) field: a READ-ONLY computed value derived
 *              from a sibling collection field at display time (NEVER stored in record.data;
 *              T-0453 handles the omit-on-write side). Emitted as:
 *                { type: "number", title, "x-rollup": {
 *                    source: <collection field key>,
 *                    op: sum|count|avg|min|max,
 *                    value_field: <numeric sub-field key of source>,  // optional for count
 *                    factor_field: <numeric sub-field key of source>  // optional; only for op:sum
 *                  } }
 *              The `x-rollup` key is a JSON Schema extension (same convention as `x-relation`).
 *              AJV strict rejects x-* keys — validateRecordSchemaDefinition strips them before
 *              compile (existing stripXExtensions covers ALL x-* prefixes). The `type:"number"`
 *              is the shape-hint for the display widget; the field is NEVER required and NEVER
 *              written to record.data. Compute-on-read: the actual aggregation is produced at
 *              display time (T-0453). This task = authoring + schema round-trip only.
 *
 * T-0579 ADDITION:
 *   file — an uploaded file/attachment (structural primitive, like relation/person).
 *          Emitted as { type: "string", "x-file": {…}, title }. The value stored in
 *          record.data is the fileVersionId (a string — same pattern as person=id,
 *          relation=uuid). Day-1 x-file config is an empty object; extensible
 *          additive (e.g. { mime_allow?, max_bytes? }) without a retrofit. The
 *          x-file annotation is the round-trip discriminator (same convention as
 *          x-person/x-url/x-relation); stripped by the server's generic
 *          stripXExtensions before AJV-strict compile — the validator is NOT touched.
 *          The backend (upload/list/download routes, PDP-derived authorization,
 *          storage) is pre-existing (T-0518/T-0201) — this task only wires the
 *          taxonomy + form/list/card display through to it (see docs/design/
 *          T-0579-file-field.adr.md).
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
  { value: "multi-select", label: "Мультивыбор" },
  { value: "date", label: "Дата" },
  { value: "url", label: "Ссылка (URL)" },
  { value: "email", label: "Email" },
  { value: "money", label: "Сумма (₽)" },
  { value: "relation", label: "Ссылка на запись" },
  { value: "person", label: "Сотрудник" },
  { value: "collection", label: "Список строк" },
  { value: "computed", label: "Итог" },
  { value: "file", label: "Файл" },
];

// T-0452: valid rollup operations for a computed field.
export const ROLLUP_OPS = [
  { value: "sum", label: "Сумма" },
  { value: "count", label: "Количество строк" },
  { value: "avg", label: "Среднее" },
  { value: "min", label: "Минимум" },
  { value: "max", label: "Максимум" },
];
export const ROLLUP_OP_VALUES = ROLLUP_OPS.map((o) => o.value);

export const FIELD_TYPE_VALUES = FIELD_TYPES.map((t) => t.value);

// Field key: identifier-ish (letter/underscore lead, then word chars), 1..64.
export const FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const FIELD_TITLE_MAX = 256;

// T-0448: Scalar types permitted as collection sub-fields (depth cap 1: no collection/relation).
// Declared before validateField (which references it) — `const` is not hoisted.
export const COLLECTION_SUB_FIELD_TYPES = ["string", "number", "integer", "boolean", "select", "date"];

/**
 * Validate a single field row for the editor.
 *
 * T-0294: for select fields, `options` must be a non-empty array of non-empty
 * unique strings (these become the JSON Schema `enum` array). The validation
 * sets `errors.options` when the constraint is violated.
 *
 * T-0452: for computed fields, `rollupSource` must reference an existing sibling
 * collection field key in `allFields` (the full field list context).  `rollupOp`
 * must be a known op. For non-count ops, `rollupValueField` must reference a
 * numeric (number/integer) sub-field of the source collection. `rollupFactorField`
 * if set must also be a numeric sub-field of the source.
 *
 * @param {{ key?: string, type?: string, title?: string, options?: string[] }} field
 * @param {Array=} allFields  Full in-memory field list (required for computed validation)
 * @returns {{ key?: string, type?: string, title?: string, options?: string }} per-field error map (empty = ok)
 */
export function validateField(field, allFields) {
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
  // T-0512: multi-select reuses the same options validation as select.
  if (type === "select" || type === "multi-select") {
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

  // T-0444: validate relation target
  if (type === "relation") {
    const target = typeof field?.targetRegistryId === "string" ? field.targetRegistryId.trim() : "";
    if (target.length === 0) {
      errors.targetRegistryId = "Выберите целевой набор полей";
    }
  }

  // T-0452: validate computed (rollup) fields.
  if (type === "computed") {
    const source = typeof field?.rollupSource === "string" ? field.rollupSource.trim() : "";
    const op = typeof field?.rollupOp === "string" ? field.rollupOp.trim() : "";
    const valueField = typeof field?.rollupValueField === "string" ? field.rollupValueField.trim() : "";
    const factorField = typeof field?.rollupFactorField === "string" ? field.rollupFactorField.trim() : "";

    // source must reference an existing sibling collection field.
    if (source.length === 0) {
      errors.rollupSource = "Выберите поле «Список строк», по которому считать";
    } else {
      const siblings = Array.isArray(allFields) ? allFields : [];
      const sourceField = siblings.find((f) => f && f.key === source && f.type === "collection");
      if (!sourceField) {
        errors.rollupSource = "Поле «Список строк» с таким ключом не найдено";
      } else {
        // op must be a known value.
        if (!ROLLUP_OP_VALUES.includes(op)) {
          errors.rollupOp = "Выберите операцию";
        } else {
          // For non-count ops, value_field must name a numeric sub-field of the source.
          const numericSubTypes = ["number", "integer"];
          const subFields = Array.isArray(sourceField.subFields) ? sourceField.subFields : [];
          if (op !== "count") {
            if (valueField.length === 0) {
              errors.rollupValueField = "Укажите поле значения для этой операции";
            } else {
              const sfMatch = subFields.find((sf) => sf && sf.key === valueField);
              if (!sfMatch) {
                errors.rollupValueField = "Поле значения не найдено в колонках источника";
              } else if (!numericSubTypes.includes(sfMatch.type)) {
                errors.rollupValueField = "Поле значения должно быть числовым (Число или Целое)";
              }
            }
          }
          // factor_field (optional): if provided, must be a numeric sub-field.
          if (factorField.length > 0) {
            const sfFactor = subFields.find((sf) => sf && sf.key === factorField);
            if (!sfFactor) {
              errors.rollupFactorField = "Поле множителя не найдено в колонках источника";
            } else if (!numericSubTypes.includes(sfFactor.type)) {
              errors.rollupFactorField = "Поле множителя должно быть числовым (Число или Целое)";
            }
          }
        }
      }
    }
  }

  // T-0448 + T-0450: validate collection sub-fields.
  // T-0450 LOW fix: validate each sub-field KEY with FIELD_KEY_RE (same guard as
  // top-level keys) AND reject duplicate sub-field keys. Previously only sub-field
  // TYPES were validated — malformed or duplicate sub-keys leaked into the schema.
  if (type === "collection") {
    const subList = Array.isArray(field?.subFields) ? field.subFields : [];
    if (subList.length === 0) {
      errors.subFields = "Добавьте хотя бы одно подполе";
    } else {
      const subErrors = [];
      let hasSubError = false;
      const seenSubKeys = new Set();
      for (const sf of subList) {
        const sfType = typeof sf?.type === "string" ? sf.type : "";
        const sfKey = typeof sf?.key === "string" ? sf.key : "";
        const sfErrs = [];

        // Key validation (mirrors top-level FIELD_KEY_RE guard).
        if (sfKey.length === 0) {
          sfErrs.push("Укажите ключ колонки");
        } else if (!FIELD_KEY_RE.test(sfKey)) {
          sfErrs.push("Ключ: латинская буква/подчёркивание, затем буквы/цифры/_ (1–64)");
        } else if (seenSubKeys.has(sfKey)) {
          sfErrs.push("Ключ уже используется в этом списке");
        } else {
          seenSubKeys.add(sfKey);
        }

        // Type validation (depth cap 1: no nested collection or relation).
        if (sfType === "collection" || sfType === "relation") {
          sfErrs.push(`Тип «${sfType}» недопустим в колонках (глубина = 1)`);
        } else if (!COLLECTION_SUB_FIELD_TYPES.includes(sfType)) {
          sfErrs.push("Недопустимый тип колонки");
        }

        // T-0450 Fix 1 (G3 BLOCKING): select sub-fields require ≥1 non-blank
        // option — mirrors top-level select validation (T-0294). Without options
        // the record-entry <select> cell would have zero choices → unfillable.
        if (sfType === "select") {
          const sfOpts = Array.isArray(sf?.options) ? sf.options : [];
          const sfNonEmpty = sfOpts.filter((o) => typeof o === "string" && o.trim().length > 0);
          if (sfNonEmpty.length === 0) {
            sfErrs.push("Укажите варианты для колонки-списка");
          }
        }

        if (sfErrs.length > 0) {
          subErrors.push(sfErrs.join("; "));
          hasSubError = true;
        } else {
          subErrors.push(null);
        }
      }
      if (hasSubError) {
        errors.subFields = subErrors.filter(Boolean).join("; ");
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
  // T-0452: pass the full field list so computed fields can validate their rollupSource.
  const fieldErrors = list.map((f) => validateField(f, list));

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

// ---------------------------------------------------------------------------
// T-0448: Scalar-emit sub-helper (shared by top-level fields and collection sub-fields)
// ---------------------------------------------------------------------------

/**
 * Emit a single scalar field prop object (the value for properties[key] in a JSON
 * Schema). Does NOT mutate the field. title is set as a separate step by the caller.
 *
 * Handles: string/number/integer/boolean → { type }, select → { type:"string", enum },
 * date → { type:"string" }. Does NOT handle relation or collection (depth cap 1).
 *
 * @param {{ type: string, options?: string[] }} f - scalar field descriptor
 * @returns {object} JSON Schema property definition (without title)
 */
function emitScalarProp(f) {
  if (f.type === "select") {
    const rawOpts = Array.isArray(f.options) ? f.options : [];
    const opts = [...new Set(
      rawOpts.filter((o) => typeof o === "string" && o.trim().length > 0).map((o) => o.trim())
    )];
    return { type: "string", enum: opts.length > 0 ? opts : [""] };
  }
  if (f.type === "date") {
    // date → type: string (no format; AJV strict rejects format:date).
    return { type: "string" };
  }
  // string/number/integer/boolean → pass through
  return { type: f.type };
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
 * T-0448 collection type mapping:
 *   collection → { type: "array", items: { type: "object", additionalProperties: false,
 *                  properties: {…sub-fields…}, required: [… required sub-fields …] } }
 *   Sub-fields use emitScalarProp (scalars only; depth cap 1).
 *   NATIVE JSON Schema — no x-* extensions → AJV strict compiles without stripping.
 *
 * @param {Array<{ key: string, type: string, title?: string, required?: boolean, options?: string[], subFields?: Array<{key,label,type,required,options?}> }>} fields
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
    if (f.type === "collection") {
      // T-0448: collection → native JSON Schema array with typed sub-record items.
      // Sub-fields are scalars only (depth cap 1; no collection/relation sub-fields).
      const subList = Array.isArray(f.subFields) ? f.subFields : [];
      const subProperties = {};
      const subRequired = [];

      for (const sf of subList) {
        const sfKey = typeof sf?.key === "string" ? sf.key : "";
        if (sfKey.length === 0) continue;
        const sfProp = emitScalarProp(sf);
        const sfLabel = typeof sf?.label === "string" ? sf.label.trim() : "";
        if (sfLabel.length > 0) sfProp.title = sfLabel;
        subProperties[sfKey] = sfProp;
        if (sf.required) subRequired.push(sfKey);
      }

      const itemsSchema = {
        type: "object",
        additionalProperties: false,
        properties: subProperties,
      };
      if (subRequired.length > 0) itemsSchema.required = subRequired;

      prop = { type: "array", items: itemsSchema };
    } else if (f.type === "relation") {
      // T-0444: relation → type: string + x-relation extension (PINNED contract; T-0445 depends on this shape).
      // AJV strict rejects x-* keywords — validateRecordSchemaDefinition strips them before compile.
      // The value stored in the record is the referenced record's UUID (string).
      const targetId = typeof f.targetRegistryId === "string" ? f.targetRegistryId.trim() : "";
      prop = { type: "string", "x-relation": { target_registry_id: targetId } };
    } else if (f.type === "computed") {
      // T-0452: computed (Итог/rollup) → type:number + x-rollup extension.
      // Same x-* strip convention as x-relation — AJV strips x-rollup before compile.
      // The field is NEVER stored in record.data (T-0453); type:number is a display hint.
      // factor_field is optional: omit from x-rollup when absent/empty.
      const rollupSource = typeof f.rollupSource === "string" ? f.rollupSource.trim() : "";
      const rollupOp = typeof f.rollupOp === "string" ? f.rollupOp.trim() : "";
      const rollupValueField = typeof f.rollupValueField === "string" ? f.rollupValueField.trim() : "";
      const rollupFactorField = typeof f.rollupFactorField === "string" ? f.rollupFactorField.trim() : "";
      const xRollup = { source: rollupSource, op: rollupOp, value_field: rollupValueField };
      if (rollupFactorField.length > 0) xRollup.factor_field = rollupFactorField;
      prop = { type: "number", "x-rollup": xRollup };
    } else if (f.type === "money") {
      // T-0509: money → type:number + x-money extension (currency annotation).
      // Same x-* strip convention as x-relation / x-rollup — AJV strips x-money before
      // compile (validateRecordSchemaDefinition). Stored value is a plain JSON number;
      // the x-money annotation is a display hint only (currency formatting on render).
      prop = { type: "number", "x-money": { currency: "RUB" } };
    } else if (f.type === "multi-select") {
      // T-0512: multi-select → type:array + items:{type:"string",enum:[...]} + x-multi-select extension.
      // AJV validates element membership via items.enum automatically. The x-multi-select
      // annotation is the round-trip discriminator (distinguishes from a plain array/collection).
      // Same x-* strip convention — validateRecordSchemaDefinition strips it before AJV compile.
      // The stored value is a JSON array of strings.
      const rawOpts = Array.isArray(f.options) ? f.options : [];
      const opts = [...new Set(
        rawOpts.filter((o) => typeof o === "string" && o.trim().length > 0).map((o) => o.trim())
      )];
      prop = {
        type: "array",
        items: { type: "string", enum: opts.length > 0 ? opts : [""] },
        "x-multi-select": true,
      };
    } else if (f.type === "person") {
      // T-0512: person → type:string + x-person extension (employee selector).
      // Stores the employee's id as a plain string. The x-person annotation is the
      // round-trip discriminator; AJV strips it before compile (standard x-* convention).
      // Display resolves the id to a name via GET /api/org.
      prop = { type: "string", "x-person": true };
    } else if (f.type === "url") {
      // T-0516: url → type:string + x-url extension (URL input).
      // AJV strict rejects format:"uri" (unknown format) — use x-url as the round-trip
      // discriminator (same x-* convention as x-person/x-relation). Stored value is
      // a plain string (the URL). The input renders as <input type="url">.
      prop = { type: "string", "x-url": true };
    } else if (f.type === "email") {
      // T-0516: email → type:string + x-email extension (email input).
      // AJV strict rejects format:"email" (unknown format) — use x-email as the
      // round-trip discriminator (same x-* convention). Stored value is a plain string.
      prop = { type: "string", "x-email": true };
    } else if (f.type === "date") {
      // T-0553: date → type:string + x-date extension (round-trip discriminator).
      // AJV strict rejects format:"date" (unknown format), so x-date is the discriminator
      // (same x-* convention as x-person/x-url/x-email). Stored value is an ISO date
      // string; parse restores type "date" so the record form renders <input type="date">.
      // NOTE: only TOP-LEVEL date fields carry x-date — stripXExtensions does NOT recurse
      // into collection items.properties, so a date sub-field must stay plain string
      // (emitScalarProp) or AJV strict would throw on the nested x-date keyword.
      prop = { type: "string", "x-date": true };
    } else if (f.type === "file") {
      // T-0579: file → type:string + x-file extension (round-trip discriminator).
      // Same x-* strip convention as x-person/x-relation — AJV strips x-file before
      // compile (validateRecordSchemaDefinition, unchanged). Stored value is a plain
      // string: the fileVersionId returned by POST /api/records/:recordId/files
      // (docs/design/T-0579-file-field.adr.md §2.1/§2.4). Day-1 config is empty —
      // extensible additive (mime_allow/max_bytes) without breaking existing schemas.
      prop = { type: "string", "x-file": {} };
    } else {
      prop = emitScalarProp(f);
    }

    const title = typeof f?.title === "string" ? f.title.trim() : "";
    if (title.length > 0) prop.title = title;
    properties[key] = prop;
    // T-0452 guard: computed fields are NEVER required (value is never written to
    // record.data — T-0453). Even if the in-memory field carries required:true
    // (e.g. loaded from a stale persisted schema), we must never push the key into
    // the required array, or every subsequent record save will fail AJV validation.
    // T-0512: multi-select and person CAN be required (they store real values).
    if (f.required && f.type !== "computed") required.push(key);
  }

  // T-0510: emit x-field-order — an array of field keys in the user-defined order.
  // jsonb preserves ARRAY element order but NOT object key order, so properties keys
  // may come back scrambled after a Postgres roundtrip. x-field-order is the
  // authoritative ordering annotation; parseRecordSchema and schemaToFormFields
  // both read it to restore the intended order. The array holds all keys that appear
  // in properties (same loop order). The x-* convention is the same as x-relation /
  // x-rollup / x-money; the server strips root-level x-* before AJV compile (T-0510
  // extended stripXExtensions to cover root level in addition to property level).
  const xFieldOrder = Object.keys(properties);

  const schema = {
    type: "object",
    additionalProperties: false,
    properties,
  };
  // Only include `required` when non-empty (AJV accepts an empty array too, but
  // omitting it keeps the persisted schema minimal — matches the 056 seed which
  // always lists required, and 073 which lists required; either is valid).
  if (required.length > 0) schema.required = required;
  // Only emit x-field-order when there are fields (empty schema has nothing to order).
  if (xFieldOrder.length > 0) schema["x-field-order"] = xFieldOrder;
  return schema;
}

/**
 * Parse a persisted record_schema back into the ordered field list the editor
 * renders. Inverse of buildRecordSchema (modulo unknown extra keywords, which
 * are surfaced read-only as-is in `extra`). Tolerates absent/empty properties.
 *
 * T-0294: a property with `enum` is detected as a "select" field; its options
 * array is extracted. T-0553: a "date" field is detected by its x-date annotation
 * ({ type:"string", "x-date":true }) and parses back as "date". Legacy date fields
 * without x-date (persisted before T-0553) still parse back as "string".
 *
 * T-0448: a property with type:"array" + items.type:"object" is detected as a
 * "collection" field; its sub-fields are parsed from items.properties.
 *
 * @param {unknown} recordSchema
 * @returns {Array<{ key: string, type: string, title: string, required: boolean, options?: string[], subFields?: Array }>}
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

  // T-0510: resolve the field key order.
  // x-field-order (a root-level array) is the authoritative order — it survives
  // the jsonb roundtrip intact (arrays preserve element order; object keys don't).
  // Algorithm: start with x-field-order keys (skip those absent from properties),
  // then append any remaining properties keys not listed in x-field-order (for
  // fields added out-of-band after the annotation was emitted). Legacy schemas
  // without x-field-order fall back to Object.keys(props) insertion order.
  const xFieldOrder = Array.isArray(recordSchema["x-field-order"]) ? recordSchema["x-field-order"] : null;
  let orderedKeys;
  if (xFieldOrder && xFieldOrder.length > 0) {
    const propKeySet = new Set(Object.keys(props));
    const ordered = xFieldOrder.filter((k) => typeof k === "string" && propKeySet.has(k));
    const orderedSet = new Set(ordered);
    // Append any keys in props that are not listed in x-field-order.
    for (const k of Object.keys(props)) {
      if (!orderedSet.has(k)) ordered.push(k);
    }
    orderedKeys = ordered;
  } else {
    // Legacy: no x-field-order annotation — fall back to properties insertion order.
    orderedKeys = Object.keys(props);
  }

  return orderedKeys.map((key) => {
    const def = props[key];
    const rawType = def && typeof def === "object" ? def.type : undefined;

    // T-0512: detect multi-select fields by type:"array" + x-multi-select annotation.
    // Must come BEFORE the generic collection detection (which also matches type:"array").
    const xMultiSelect = def && typeof def === "object" ? def["x-multi-select"] : undefined;
    if (xMultiSelect && rawType === "array") {
      const title = typeof def.title === "string" ? def.title : "";
      const options = (def.items && Array.isArray(def.items.enum))
        ? def.items.enum.filter((o) => typeof o === "string")
        : [];
      return { key, type: "multi-select", title, required: requiredSet.has(key), options };
    }

    // T-0448: detect collection fields by type:"array" + items being a typed object schema.
    if (
      def && typeof def === "object" && !Array.isArray(def) &&
      rawType === "array" &&
      def.items && typeof def.items === "object" && !Array.isArray(def.items) &&
      def.items.type === "object"
    ) {
      const title = typeof def.title === "string" ? def.title : "";
      const itemProps = (def.items.properties && typeof def.items.properties === "object" && !Array.isArray(def.items.properties))
        ? def.items.properties
        : {};
      const itemRequired = Array.isArray(def.items.required) ? new Set(def.items.required.filter((k) => typeof k === "string")) : new Set();

      const subFields = Object.keys(itemProps).map((sfKey) => {
        const sfDef = itemProps[sfKey];
        const sfLabel = sfDef && typeof sfDef === "object" && typeof sfDef.title === "string" ? sfDef.title : "";
        // Detect sub-field type (select by enum, else primitive)
        const sfHasEnum = sfDef && Array.isArray(sfDef.enum) && sfDef.enum.length > 0;
        let sfType;
        if (sfHasEnum) {
          sfType = "select";
        } else {
          const sfRawType = sfDef && typeof sfDef.type === "string" ? sfDef.type : "string";
          sfType = COLLECTION_SUB_FIELD_TYPES.includes(sfRawType) ? sfRawType : "string";
        }
        const sfField = { key: sfKey, type: sfType, label: sfLabel, required: itemRequired.has(sfKey) };
        if (sfHasEnum) sfField.options = sfDef.enum.filter((o) => typeof o === "string");
        return sfField;
      });

      return { key, type: "collection", title, required: requiredSet.has(key), subFields };
    }

    // T-0452: detect computed (rollup) fields by the presence of x-rollup extension.
    const xRollup = def && typeof def === "object" ? def["x-rollup"] : undefined;
    if (xRollup && typeof xRollup === "object" && !Array.isArray(xRollup)) {
      const title = typeof def.title === "string" ? def.title : "";
      return {
        key,
        type: "computed",
        title,
        required: false, // computed fields are NEVER required (never written to data)
        rollupSource: typeof xRollup.source === "string" ? xRollup.source : "",
        rollupOp: typeof xRollup.op === "string" ? xRollup.op : "",
        rollupValueField: typeof xRollup.value_field === "string" ? xRollup.value_field : "",
        rollupFactorField: typeof xRollup.factor_field === "string" ? xRollup.factor_field : "",
      };
    }

    // T-0444: detect relation fields by the presence of x-relation extension.
    const xRelation = def && typeof def === "object" ? def["x-relation"] : undefined;
    if (xRelation && typeof xRelation === "object" && !Array.isArray(xRelation)) {
      const targetRegistryId = typeof xRelation.target_registry_id === "string" ? xRelation.target_registry_id : "";
      const title = typeof def.title === "string" ? def.title : "";
      return { key, type: "relation", title, required: requiredSet.has(key), targetRegistryId };
    }

    // T-0509: detect money fields by the presence of x-money extension.
    // Shape: { type: "number", "x-money": { currency: "RUB" } }.
    // Must be detected before the generic number/string fallthrough.
    const xMoney = def && typeof def === "object" ? def["x-money"] : undefined;
    if (xMoney && typeof xMoney === "object" && !Array.isArray(xMoney)) {
      const title = typeof def.title === "string" ? def.title : "";
      return { key, type: "money", title, required: requiredSet.has(key) };
    }

    // T-0512: detect person fields by the presence of x-person annotation.
    // Shape: { type: "string", "x-person": true }.
    // Must be detected before the generic string fallthrough.
    const xPerson = def && typeof def === "object" ? def["x-person"] : undefined;
    if (xPerson) {
      const title = typeof def.title === "string" ? def.title : "";
      return { key, type: "person", title, required: requiredSet.has(key) };
    }

    // T-0516: detect url fields by the presence of x-url annotation.
    // Shape: { type: "string", "x-url": true }.
    // Must be detected before the generic string fallthrough.
    const xUrl = def && typeof def === "object" ? def["x-url"] : undefined;
    if (xUrl) {
      const title = typeof def.title === "string" ? def.title : "";
      return { key, type: "url", title, required: requiredSet.has(key) };
    }

    // T-0516: detect email fields by the presence of x-email annotation.
    // Shape: { type: "string", "x-email": true }.
    // Must be detected before the generic string fallthrough.
    const xEmail = def && typeof def === "object" ? def["x-email"] : undefined;
    if (xEmail) {
      const title = typeof def.title === "string" ? def.title : "";
      return { key, type: "email", title, required: requiredSet.has(key) };
    }

    // T-0553: detect date fields by the presence of x-date annotation.
    // Shape: { type: "string", "x-date": true }. Must be detected before the string
    // fallthrough. Legacy date fields persisted before T-0553 (plain { type: "string" },
    // no x-date) still parse back as "string" — no regression, backward-compatible.
    const xDate = def && typeof def === "object" ? def["x-date"] : undefined;
    if (xDate) {
      const title = typeof def.title === "string" ? def.title : "";
      return { key, type: "date", title, required: requiredSet.has(key) };
    }

    // T-0579: detect file fields by the presence of x-file annotation.
    // Shape: { type: "string", "x-file": {…} }. Must be detected before the generic
    // string fallthrough. A property WITHOUT x-file never detects as "file" —
    // backward-compatible (NF-3): schemas persisted before T-0579 are unaffected.
    const xFile = def && typeof def === "object" ? def["x-file"] : undefined;
    if (xFile && typeof xFile === "object" && !Array.isArray(xFile)) {
      const title = typeof def.title === "string" ? def.title : "";
      return { key, type: "file", title, required: requiredSet.has(key) };
    }

    // T-0294: detect select fields by the presence of an enum array.
    const hasEnum = def && typeof def === "object" && Array.isArray(def.enum) && def.enum.length > 0;
    if (hasEnum) {
      const options = def.enum.filter((o) => typeof o === "string");
      const title =
        typeof def.title === "string" ? def.title : "";
      return { key, type: "select", title, required: requiredSet.has(key), options };
    }

    // If the persisted type isn't one we offer (excluding select/relation/collection/money/
    // multi-select/person/url/email/computed/file which are handled above), fall back to
    // "string" so the dropdown stays valid; the user can re-pick.
    // (Honest: never show a type option the backend wouldn't accept.)
    const nonSpecialTypes = FIELD_TYPE_VALUES.filter((v) =>
      v !== "select" && v !== "relation" && v !== "collection" && v !== "money" &&
      v !== "multi-select" && v !== "person" && v !== "url" && v !== "email" && v !== "computed" &&
      v !== "file"
    );
    const type = nonSpecialTypes.includes(rawType) ? rawType : "string";
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
 * T-0448: includes `subFields` (empty array — populated when type is "collection").
 * T-0452: includes rollup config defaults (populated when type is "computed").
 */
export function blankField() {
  return {
    key: "", type: "string", title: "", required: false,
    options: [], subFields: [],
    rollupSource: "", rollupOp: "sum", rollupValueField: "", rollupFactorField: "",
  };
}

/**
 * A blank sub-field descriptor for a collection field's sub-field list.
 * Sub-fields use `label` (displayed in rows) instead of `title` (top-level field
 * convention) to avoid confusion. `key` must be set by the user; `type` defaults
 * to "string" (simplest scalar). T-0448.
 */
export function blankSubField() {
  return { key: "", type: "string", label: "", required: false, options: [] };
}
