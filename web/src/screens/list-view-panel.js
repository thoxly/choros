/* ============================================================================
   web/src/screens/list-view-panel.js — T-0581 (view registry) FR-4 UI contract.

   PURE, framework-free helpers for the «Настроить список» panel: the FR-4/
   AC-14/AC-15 client that lets a user assemble a saved list_view (columns +
   filters + sort) WITHOUT code. Kept JSX-free (mirrors report-builder.js /
   apps-schema.js) so the field-type→operator mapping, draft↔config
   translation, and validation are unit-testable in isolation from React.

   THE CONTRACT this module bridges (server side, frozen):
     - src/core/view-config.ts  operatorsForFieldType / isServerSortable /
       ListViewConfig shape ({ columns, filters, sort }).
     - src/http/list-views.ts   CRUD (GET/POST/PUT/DELETE /api/list-views).
     - src/http/records.ts      GET /api/records?view_id=|filter=|sort=.

   FIELD TYPES come from schemaToColumns(record_schema) (records-form.js) —
   the SAME type-detection algorithm the server's resolveFieldTypes uses
   (string/url/email/number/integer/money/date/boolean/select/multi-select/
   person/relation/computed/collection), plus the synthetic 'created_at'
   pseudo-column. One taxonomy, not two independently-maintained copies.

   HUMAN-LANGUAGE (G5 — no dev jargon in visible text): operators are Russian
   phrases ("равно"/"больше"/"пусто"), never raw op codes ("eq"/"gt"/
   "is_empty"); sort direction is "по возрастанию"/"по убыванию", never
   "asc"/"desc". The raw codes are ONLY used as the wire value sent to the
   server (never rendered).

   ANTI-CASE (D-064/NF-4): this module is entirely generic — no
   "сделка"/"стадия"/"deal"/"stage" business-domain vocabulary. Field labels
   and view names are TENANT DATA read from record_schema / user input, never
   platform constants.
   ============================================================================ */

// ---------------------------------------------------------------------------
// Operator vocabulary — code -> human (ru) label, PER FIELD TYPE (FR-5/ADR §3.4).
//
// Mirrors src/core/view-config.ts's operatorsForFieldType EXACTLY (same set,
// same order) so a user is never offered an operator the server will reject.
// ---------------------------------------------------------------------------

/** op code -> human ru label (used across ALL field types; a given type only
 *  offers a subset via operatorsForFieldType below). */
export const OP_LABELS = {
  eq: 'равно',
  neq: 'не равно',
  contains: 'содержит',
  starts_with: 'начинается с',
  is_empty: 'пусто',
  is_not_empty: 'не пусто',
  gt: 'больше',
  gte: 'больше или равно',
  lt: 'меньше',
  lte: 'меньше или равно',
  between: 'между',
  before: 'раньше',
  after: 'позже',
  is_true: 'да',
  is_false: 'нет',
  in: 'любое из',
  contains_any: 'содержит любое из',
  contains_all: 'содержит все из',
};

/**
 * operatorsForFieldType — (viewFieldType) -> ordered op-code list, PER FR-5 /
 * ADR §3.4 table. Byte-mirror of src/core/view-config.ts's server table (kept
 * in sync manually — both sides are pure lookup tables, no shared runtime
 * import across the client/server boundary is possible for a browser bundle).
 * `computed`/`collection` -> [] (never filterable — the panel must not offer
 * a filter row for such a field, AC-4).
 */
export function operatorsForFieldType(fieldType) {
  switch (fieldType) {
    case 'string':
    case 'url':
    case 'email':
      return ['eq', 'neq', 'contains', 'starts_with', 'is_empty', 'is_not_empty'];
    case 'number':
    case 'integer':
    case 'money':
      return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'];
    case 'date':
      return ['eq', 'before', 'after', 'between', 'is_empty', 'is_not_empty'];
    case 'boolean':
      return ['is_true', 'is_false', 'is_empty'];
    case 'select':
      return ['eq', 'neq', 'in', 'is_empty', 'is_not_empty'];
    case 'multi-select':
      return ['contains_any', 'contains_all', 'is_empty', 'is_not_empty'];
    case 'person':
    case 'relation':
      return ['eq', 'neq', 'is_empty', 'is_not_empty'];
    case 'created_at':
      return ['eq', 'gt', 'gte', 'lt', 'lte', 'between'];
    case 'computed':
    case 'collection':
      return [];
    default:
      return [];
  }
}

/** isServerSortable — mirrors src/core/view-config.ts exactly (FR-6). */
export function isServerSortable(fieldType) {
  switch (fieldType) {
    case 'string':
    case 'url':
    case 'email':
    case 'number':
    case 'integer':
    case 'money':
    case 'date':
    case 'boolean':
    case 'select':
    case 'created_at':
      return true;
    default:
      return false;
  }
}

/** Whether an operator needs a value input at all (is_empty/is_not_empty/is_true/is_false do not). */
export function operatorNeedsValue(op) {
  return op !== 'is_empty' && op !== 'is_not_empty' && op !== 'is_true' && op !== 'is_false';
}

/** Whether an operator needs TWO values (a range: between). */
export function operatorNeedsRange(op) {
  return op === 'between';
}

/** Whether an operator needs a LIST of values (in / contains_any / contains_all). */
export function operatorNeedsList(op) {
  return op === 'in' || op === 'contains_any' || op === 'contains_all';
}

const PSEUDO_COLUMN_CREATED_AT = 'created_at';
const CREATED_AT_COLUMN = { key: PSEUDO_COLUMN_CREATED_AT, label: 'Создано', type: 'created_at' };

// ---------------------------------------------------------------------------
// Panel field catalog — schemaToColumns() + the created_at pseudo-column,
// which the columns/filter/sort pickers all need (FR-2).
// ---------------------------------------------------------------------------

/**
 * Build the panel's field catalog from schemaToColumns() output (records-form.js),
 * appending the synthetic 'created_at' pseudo-column (ADR §3.4) so it can be
 * shown/hidden/filtered/sorted like any other column.
 *
 * @param {Array<{key,label,type}>} schemaColumns  from schemaToColumns(recordSchema)
 * @returns {Array<{key,label,type}>}
 */
export function buildFieldCatalog(schemaColumns) {
  const cols = Array.isArray(schemaColumns) ? schemaColumns : [];
  return [...cols, CREATED_AT_COLUMN];
}

// ---------------------------------------------------------------------------
// Draft state <-> ListViewConfig translation
//
// The panel edits a "draft" shape that is convenient for controlled inputs
// (columns as an ordered array of {field_key,visible,width}; filters/sort as
// arrays of editable rows with a stable client-side `id` for React keys). The
// draft translates 1:1 to/from the wire ListViewConfig (ADR §3.2) — no data is
// invented or dropped in either direction (besides the client-only `id` key).
// ---------------------------------------------------------------------------

let _draftIdSeq = 0;
function nextDraftId() {
  _draftIdSeq += 1;
  return `d${_draftIdSeq}`;
}

/**
 * Build a fresh draft from a ListViewConfig (either the synthetic default or
 * a saved view's config) + the full field catalog (so columns absent from a
 * stale saved config, e.g. a field added after the view was saved, still show
 * up as available-but-not-yet-placed).
 *
 * @param {{columns?:Array,filters?:Array,sort?:Array}} config
 * @param {Array<{key,label,type}>} fieldCatalog
 * @returns {{columns:Array<{id,field_key,visible,width}>, filters:Array<{id,field_key,op,value}>, sort:Array<{id,field_key,dir}>}}
 */
export function draftFromConfig(config, fieldCatalog) {
  const cfg = config && typeof config === 'object' ? config : {};
  const catalog = Array.isArray(fieldCatalog) ? fieldCatalog : [];
  const catalogKeys = new Set(catalog.map((f) => f.key));

  const configColumns = Array.isArray(cfg.columns) ? cfg.columns : [];
  const seenKeys = new Set();
  const columns = configColumns
    .filter((c) => c && typeof c.field_key === 'string' && catalogKeys.has(c.field_key))
    .map((c) => {
      seenKeys.add(c.field_key);
      return {
        id: nextDraftId(),
        field_key: c.field_key,
        visible: c.visible !== false,
        width: typeof c.width === 'number' ? c.width : null,
      };
    });
  // Any catalog field NOT mentioned in the saved config (e.g. added to the
  // schema after the view was saved) is appended, hidden by default — it
  // exists but does not silently change what a saved view already showed.
  for (const f of catalog) {
    if (!seenKeys.has(f.key)) {
      columns.push({ id: nextDraftId(), field_key: f.key, visible: false, width: null });
    }
  }

  const filters = (Array.isArray(cfg.filters) ? cfg.filters : [])
    .filter((f) => f && typeof f.field_key === 'string')
    .map((f) => ({ id: nextDraftId(), field_key: f.field_key, op: f.op, value: f.value }));

  const sort = (Array.isArray(cfg.sort) ? cfg.sort : [])
    .filter((s) => s && typeof s.field_key === 'string')
    .map((s) => ({ id: nextDraftId(), field_key: s.field_key, dir: s.dir === 'asc' ? 'asc' : 'desc' }));

  return { columns, filters, sort };
}

/**
 * Translate the draft back into the wire ListViewConfig (strips the
 * client-only `id`, drops incomplete filter/sort rows so a half-filled row
 * being edited never reaches the server).
 *
 * @param {{columns,filters,sort}} draft
 * @returns {{columns:Array,filters:Array,sort:Array}}
 */
export function configFromDraft(draft) {
  const d = draft && typeof draft === 'object' ? draft : {};
  const columns = (Array.isArray(d.columns) ? d.columns : []).map((c) => {
    const out = { field_key: c.field_key, visible: Boolean(c.visible) };
    if (typeof c.width === 'number' && Number.isFinite(c.width) && c.width > 0) out.width = c.width;
    return out;
  });
  const filters = (Array.isArray(d.filters) ? d.filters : [])
    .filter((f) => f.field_key && f.op)
    .map((f) => ({ field_key: f.field_key, op: f.op, value: f.value }));
  const sort = (Array.isArray(d.sort) ? d.sort : [])
    .filter((s) => s.field_key && (s.dir === 'asc' || s.dir === 'desc'))
    .map((s) => ({ field_key: s.field_key, dir: s.dir }));
  return { columns, filters, sort };
}

// ---------------------------------------------------------------------------
// Column ops — visibility / order / width (FR-2/FR-4 §1).
// ---------------------------------------------------------------------------

/** Toggle a column's visibility by its draft row id. */
export function toggleColumnVisible(columns, id) {
  return columns.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c));
}

/** Set a column's width (px) by its draft row id; null clears the override. */
export function setColumnWidth(columns, id, width) {
  return columns.map((c) => (c.id === id ? { ...c, width } : c));
}

/**
 * Move a column up/down in the ordered array — THE keyboard-operable
 * reordering primitive (no drag-and-drop required; mirrors the up/down
 * button pattern used by screen-app-schema.jsx's FieldRow / FormBuilder.jsx's
 * FieldConfigRow, both of which are the project's precedent for accessible
 * list reordering). `toIndex` out of range is a no-op (defensive — the UI
 * disables the button at the boundary, this guards a stale click too).
 *
 * @param {Array} columns
 * @param {number} fromIndex
 * @param {number} toIndex
 * @returns {Array} new array (does not mutate input)
 */
export function moveColumn(columns, fromIndex, toIndex) {
  if (toIndex < 0 || toIndex >= columns.length || fromIndex === toIndex) return columns;
  const copy = columns.slice();
  const [item] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, item);
  return copy;
}

// ---------------------------------------------------------------------------
// Filter ops — add/remove/update a filter row (FR-2/FR-4 §2).
// ---------------------------------------------------------------------------

/** A blank filter row for a given field (first legal operator preselected, or '' if none). */
export function blankFilterRow(fieldKey, fieldType) {
  const ops = operatorsForFieldType(fieldType);
  return { id: nextDraftId(), field_key: fieldKey, op: ops[0] || '', value: '' };
}

export function addFilterRow(filters, fieldKey, fieldType) {
  return [...filters, blankFilterRow(fieldKey, fieldType)];
}

export function removeFilterRow(filters, id) {
  return filters.filter((f) => f.id !== id);
}

export function updateFilterRow(filters, id, patch) {
  return filters.map((f) => (f.id === id ? { ...f, ...patch } : f));
}

/**
 * Validate a single filter row against its field's allowed operators + a
 * minimal value shape check — gives HONEST inline feedback before the row
 * ever reaches the server's validateViewConfig (AC-4). Never blocks on a
 * server round-trip for something checkable client-side.
 *
 * @param {{field_key,op,value}} row
 * @param {Map<string,string>} typeByKey  field_key -> ViewFieldType
 * @returns {string|null} human ru error message, or null if valid
 */
export function validateFilterRow(row, typeByKey) {
  if (!row.field_key) return 'Выберите поле';
  const fieldType = typeByKey.get(row.field_key);
  if (fieldType === undefined) return 'Поле не найдено в наборе';
  const allowedOps = operatorsForFieldType(fieldType);
  if (allowedOps.length === 0) return 'Это поле нельзя фильтровать';
  if (!row.op || !allowedOps.includes(row.op)) return 'Выберите оператор для этого поля';
  if (operatorNeedsRange(row.op)) {
    if (!Array.isArray(row.value) || row.value.length !== 2 || row.value.some((v) => v === '' || v == null)) {
      return 'Укажите начало и конец диапазона';
    }
  } else if (operatorNeedsList(row.op)) {
    if (!Array.isArray(row.value) || row.value.length === 0) {
      return 'Укажите хотя бы одно значение';
    }
  } else if (operatorNeedsValue(row.op)) {
    if (row.value === '' || row.value == null) return 'Укажите значение';
    if ((fieldType === 'number' || fieldType === 'integer' || fieldType === 'money') && Number.isNaN(Number(row.value))) {
      return 'Значение должно быть числом';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sort ops — add/remove/update a sort key (FR-2/FR-4 §3).
// ---------------------------------------------------------------------------

export function blankSortRow(fieldKey) {
  return { id: nextDraftId(), field_key: fieldKey, dir: 'desc' };
}

export function addSortRow(sort, fieldKey) {
  return [...sort, blankSortRow(fieldKey)];
}

export function removeSortRow(sort, id) {
  return sort.filter((s) => s.id !== id);
}

export function updateSortRow(sort, id, patch) {
  return sort.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

/** Fields eligible for the "add sort" picker: server-sortable AND not already sorted. */
export function availableSortFields(fieldCatalog, sort) {
  const used = new Set(sort.map((s) => s.field_key));
  return fieldCatalog.filter((f) => isServerSortable(f.type) && !used.has(f.key));
}

/** Fields eligible for the "add filter" picker: filterable (non-empty op list). */
export function availableFilterFields(fieldCatalog) {
  return fieldCatalog.filter((f) => operatorsForFieldType(f.type).length > 0);
}

// ---------------------------------------------------------------------------
// View name validation (mirrors server VIEW_NAME_MAX=128, src/http/list-views.ts).
// ---------------------------------------------------------------------------

export const VIEW_NAME_MAX = 128;

/** @returns {string|null} human error, or null if the name is acceptable to submit. */
export function validateViewName(name) {
  const trimmed = String(name || '').trim();
  if (trimmed.length === 0) return 'Укажите название представления';
  if (trimmed.length > VIEW_NAME_MAX) return `Название длиннее ${VIEW_NAME_MAX} символов`;
  return null;
}

// ---------------------------------------------------------------------------
// Inline (?filter=/&sort=) base64url query-param encoding — mirrors the
// server's expected base64url-json shape (ADR §4) for the "apply without
// saving" path (preview a filter/sort before naming+saving a view).
// ---------------------------------------------------------------------------

function base64UrlEncode(str) {
  const b64 = typeof btoa === 'function'
    ? btoa(unescape(encodeURIComponent(str)))
    : Buffer.from(str, 'utf-8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Encode a filters[] or sort[] array as the base64url-json query value. */
export function encodeInlineParam(arr) {
  return base64UrlEncode(JSON.stringify(arr));
}

/**
 * Build the query-string suffix applying a draft's filters/sort inline
 * (no view_id — used for "preview before save" / the default-view case with
 * ad-hoc adjustments). Empty filters/sort contribute nothing (keeps the
 * default request byte-identical when the panel hasn't changed anything —
 * NF-2).
 *
 * @param {{filters:Array, sort:Array}} config  (already configFromDraft'd — no client `id`)
 * @returns {string} e.g. "&filter=...&sort=..." or ""
 */
export function buildInlineQuerySuffix(config) {
  let suffix = '';
  if (Array.isArray(config.filters) && config.filters.length > 0) {
    suffix += `&filter=${encodeURIComponent(encodeInlineParam(config.filters))}`;
  }
  if (Array.isArray(config.sort) && config.sort.length > 0) {
    suffix += `&sort=${encodeURIComponent(encodeInlineParam(config.sort))}`;
  }
  return suffix;
}
