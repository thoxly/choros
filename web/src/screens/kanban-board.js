/* ============================================================================
   web/src/screens/kanban-board.js — T-0582 (kanban view) PURE, JSX-free helpers.

   Second display MODE for the view registry (T-0581): a kanban board that
   groups the SAME record set already fetched via GET /api/records?view_id=
   into columns by one SELECT-typed field's enum value. Mirrors the project's
   established split (list-view-panel.js is the pure logic, .jsx is presentation
   — see also apps-schema.js / records-form.js) so column-building, the move
   payload, and kanban-draft<->config translation are unit-testable without React.

   THE CONTRACT this module implements (ADR T-0582 object_model/contracts):
     - buildKanbanColumns(records, groupByField, enumValues, columnsOrder)
         -> KanbanColumn[] — one column per enum value (in columnsOrder or enum
            order) + ALWAYS a trailing "без значения" pseudo-column (value:null)
            for records whose group_by value is empty/absent/outside the enum
            (FR-3/AC-3 — no record is ever silently dropped from the board).
     - buildMovePayload(record, groupByField, newValue) -> { data } | { error }
         — FULL current record.data with ONLY groupByField changed (FR-7: PUT
           /api/records/:id re-validates + full-replaces `data`, so a partial
           patch would silently erase every other field). newValue=null clears
           the field (move to "без значения") UNLESS groupByField is required —
           then it is a honest, non-silent error (AC-8), never sent to the server.
     - kanbanConfigFromDraft / draftFromKanbanConfig — draft<->wire translation
       for the "Настроить список" panel's kanban mode (mirrors
       list-view-panel.js's draftFromConfig/configFromDraft for 'list').

   ANTI-CASE (D-064/NF-5): entirely generic — no "сделка"/"стадия"/"воронка"/
   "deal"/"stage"/"pipeline"/"CRM" vocabulary. Column values/labels and field
   keys are TENANT DATA (the enum the tenant defined on their own select field),
   never platform constants.
   ============================================================================ */

// ---------------------------------------------------------------------------
// KanbanColumn construction (FR-3/AC-3/AC-9).
// ---------------------------------------------------------------------------

/** Sentinel column value for the mandatory "без значения" pseudo-column. */
export const NO_VALUE_COLUMN = null;

/**
 * buildKanbanColumns — group `records` into columns by `data[groupByField]`.
 *
 * @param {Array<{id,data}>} records          rows from GET /api/records (full record objects)
 * @param {string} groupByField                the select field key driving grouping
 * @param {string[]} enumValues                record_schema.properties[groupByField].enum (tenant data)
 * @param {string[]|undefined} columnsOrder     optional explicit column order (KanbanViewConfig.columns_order)
 * @returns {Array<{value:string|null, label:string, cards:Array}>}
 *   one entry per enumValues entry (in columnsOrder if given, else enum order),
 *   PLUS a trailing { value:null, label:'Без значения', cards:[...] } entry —
 *   ALWAYS present, even when empty (FR-3/AC-9: an empty column must still render).
 */
export function buildKanbanColumns(records, groupByField, enumValues, columnsOrder) {
  const recs = Array.isArray(records) ? records : [];
  const values = Array.isArray(enumValues) ? enumValues : [];
  const valueSet = new Set(values);

  // Resolve column order: columnsOrder entries that are in the CURRENT enum,
  // in the order given, followed by any enum values NOT mentioned (appended in
  // enum order) — mirrors ADR FR-2 "columns_order… отсутствующие enum-значения
  // добавляются в хвост в порядке enum".
  let orderedValues;
  if (Array.isArray(columnsOrder) && columnsOrder.length > 0) {
    const seen = new Set();
    orderedValues = [];
    for (const v of columnsOrder) {
      if (typeof v === "string" && valueSet.has(v) && !seen.has(v)) {
        orderedValues.push(v);
        seen.add(v);
      }
    }
    for (const v of values) {
      if (!seen.has(v)) orderedValues.push(v);
    }
  } else {
    orderedValues = values.slice();
  }

  const buckets = new Map(orderedValues.map((v) => [v, []]));
  const noValueBucket = [];

  for (const rec of recs) {
    const data = rec && typeof rec.data === "object" && rec.data !== null ? rec.data : {};
    const raw = data[groupByField];
    if (typeof raw === "string" && valueSet.has(raw)) {
      buckets.get(raw).push(rec);
    } else {
      // empty/null/undefined/non-string/outside-current-enum -> "без значения"
      // (FR-3: never lose a record; a stale value that fell out of the enum
      // still surfaces here rather than vanishing from the board).
      noValueBucket.push(rec);
    }
  }

  const columns = orderedValues.map((value) => ({
    value,
    label: value, // v1: the enum string IS its own label (ADR object_model KanbanColumn.label)
    cards: buckets.get(value),
  }));
  columns.push({ value: NO_VALUE_COLUMN, label: "Без значения", cards: noValueBucket });
  return columns;
}

// ---------------------------------------------------------------------------
// Move payload (FR-5/FR-6/FR-7/AC-5/AC-6/AC-8) — full-data PUT body.
// ---------------------------------------------------------------------------

/**
 * buildMovePayload — the request body for PUT /api/records/:id when a card
 * moves to column `newValue`. Sends the FULL current `data` (assertDataValid
 * on the server re-validates+full-replaces `data` — FR-7) with ONLY
 * groupByField changed.
 *
 * @param {{data:object}} record        the record being moved (full row, with .data)
 * @param {string} groupByField
 * @param {string|null} newValue        the target column's value (null = "без значения")
 * @param {boolean} groupByRequired     whether groupByField is in record_schema.required
 * @returns {{ok:true, data:object} | {ok:false, error:string}}
 */
export function buildMovePayload(record, groupByField, newValue, groupByRequired) {
  const currentData = record && typeof record.data === "object" && record.data !== null ? record.data : {};
  if (newValue === null && groupByRequired) {
    // AC-8: required field cannot be cleared — honest rejection, no PUT sent.
    return { ok: false, error: "Это поле обязательно — нельзя переместить запись в «Без значения»" };
  }
  const nextData = { ...currentData };
  if (newValue === null) {
    delete nextData[groupByField];
  } else {
    nextData[groupByField] = newValue;
  }
  return { ok: true, data: nextData };
}

/** Whether `fieldKey` is present in record_schema.required (drives AC-8). */
export function isFieldRequired(recordSchema, fieldKey) {
  const req = recordSchema && typeof recordSchema === "object" ? recordSchema.required : null;
  return Array.isArray(req) && req.includes(fieldKey);
}

// ---------------------------------------------------------------------------
// readSelectEnum — mirror of src/core/view-config.ts's enumValuesForSelectField
// (client-side; the SAME read as the server helper of the same intent, kept as
// a small local mirror since this module stays framework/build-target-neutral
// — kanban-board.jsx additionally has the option to import the server's pure
// TS helper directly at vite build-time, precedent: records-form.js/
// apps-schema.js/Floor2Viewer.jsx all import ../../../src/core/*.ts already).
// ---------------------------------------------------------------------------

/**
 * readSelectEnum — read record_schema.properties[fieldKey].enum (tenant data).
 * Pure, never throws; [] for a malformed schema/field/absent enum.
 *
 * @param {object} recordSchema
 * @param {string} fieldKey
 * @returns {string[]}
 */
export function readSelectEnum(recordSchema, fieldKey) {
  if (!recordSchema || typeof recordSchema !== "object") return [];
  const props = recordSchema.properties;
  if (!props || typeof props !== "object") return [];
  const def = props[fieldKey];
  if (!def || typeof def !== "object") return [];
  const enumRaw = def.enum;
  if (!Array.isArray(enumRaw)) return [];
  return enumRaw.filter((v) => typeof v === "string");
}

// ---------------------------------------------------------------------------
// Kanban draft <-> KanbanViewConfig translation (panel integration, FR-2/FR-9).
//
// The draft shape is what the "Настроить список" panel edits with controlled
// inputs (a card_fields array WITHOUT a client-only `id`, since order IS the
// only state — unlike list-view-panel.js's columns draft, no per-item flags).
// ---------------------------------------------------------------------------

/**
 * Build a fresh kanban draft from a KanbanViewConfig (or null/undefined for a
 * brand-new kanban view being created) + the field catalog available for
 * group_by/card_fields pickers.
 *
 * @param {{group_by_field?,card_fields?,columns_order?,filters?,sort?}|null} config
 * @param {Array<{key,label,type}>} fieldCatalog
 * @returns {{group_by_field:string, card_fields:string[], columns_order:string[], filters:Array, sort:Array}}
 */
export function draftFromKanbanConfig(config, fieldCatalog) {
  const cfg = config && typeof config === "object" ? config : {};
  const catalog = Array.isArray(fieldCatalog) ? fieldCatalog : [];
  const catalogKeys = new Set(catalog.map((f) => f.key));

  const groupByField = typeof cfg.group_by_field === "string" && catalogKeys.has(cfg.group_by_field)
    ? cfg.group_by_field
    : "";

  const cardFields = (Array.isArray(cfg.card_fields) ? cfg.card_fields : [])
    .filter((k) => typeof k === "string" && catalogKeys.has(k));

  const columnsOrder = (Array.isArray(cfg.columns_order) ? cfg.columns_order : [])
    .filter((v) => typeof v === "string");

  const filters = (Array.isArray(cfg.filters) ? cfg.filters : [])
    .filter((f) => f && typeof f.field_key === "string")
    .map((f, i) => ({ id: `kf${i}`, field_key: f.field_key, op: f.op, value: f.value }));

  const sort = (Array.isArray(cfg.sort) ? cfg.sort : [])
    .filter((s) => s && typeof s.field_key === "string")
    .map((s, i) => ({ id: `ks${i}`, field_key: s.field_key, dir: s.dir === "asc" ? "asc" : "desc" }));

  return { group_by_field: groupByField, card_fields: cardFields, columns_order: columnsOrder, filters, sort };
}

/**
 * Translate a kanban draft back into the wire KanbanViewConfig — strips
 * client-only `id` from filter/sort rows, drops incomplete filter/sort rows
 * (mirrors list-view-panel.js's configFromDraft).
 *
 * @param {{group_by_field,card_fields,columns_order,filters,sort}} draft
 * @returns {{group_by_field:string, card_fields:string[], columns_order?:string[], filters:Array, sort:Array}}
 */
export function kanbanConfigFromDraft(draft) {
  const d = draft && typeof draft === "object" ? draft : {};
  const config = {
    group_by_field: typeof d.group_by_field === "string" ? d.group_by_field : "",
    card_fields: Array.isArray(d.card_fields) ? d.card_fields.filter((k) => typeof k === "string") : [],
    filters: (Array.isArray(d.filters) ? d.filters : [])
      .filter((f) => f.field_key && f.op)
      .map((f) => ({ field_key: f.field_key, op: f.op, value: f.value })),
    sort: (Array.isArray(d.sort) ? d.sort : [])
      .filter((s) => s.field_key && (s.dir === "asc" || s.dir === "desc"))
      .map((s) => ({ field_key: s.field_key, dir: s.dir })),
  };
  if (Array.isArray(d.columns_order) && d.columns_order.length > 0) {
    config.columns_order = d.columns_order.filter((v) => typeof v === "string");
  }
  return config;
}

/** Fields eligible as group_by_field: select-typed only (ADR/FR-2). */
export function availableGroupByFields(fieldCatalog) {
  return (Array.isArray(fieldCatalog) ? fieldCatalog : []).filter((f) => f.type === "select");
}
