/**
 * src/core/view-config.ts — T-0581 (view registry): config validator + default-view.
 *
 * PURE, IO-FREE. No import from pg, http, https, net, fetch, fs, child_process.
 * Mirrors the purity discipline of read-visibility.ts / field-visibility.ts /
 * data-classification.ts.
 *
 * THE CONTRACT (ADR §3.2/§3.4): `list_view.config` is a JSONB blob whose SEMANTIC
 * shape depends on `list_view.type` — v1 only 'list'. `validateViewConfig` is the
 * DISPATCHER by `type` (FF-VR-4/AC-11): today it has exactly one branch ('list');
 * T-0582 adds a 'kanban' branch WITHOUT touching this dispatch shape, the DDL, or
 * the CRUD contract. An unknown `type` is rejected (no silent fallback).
 *
 * FIELD-TYPE → OPERATORS/SORTABILITY (ADR §3.4, FR-5/FR-6): the type of a field
 * is read from `record_schema` (JSON-Schema `type` + `x-*` annotations — the SAME
 * detection algorithm web/src/screens/apps-schema.js's parseRecordSchema uses,
 * reimplemented here in pure TS so the server can validate/translate without a
 * browser bundle dependency). `operatorsForFieldType` / `isServerSortable` are the
 * single source of truth both the validator (this file) and the translator
 * (view-query.ts) consult — one table, not two independently-maintained copies.
 *
 * ANTI-CASE (D-064 / NF-4): no case-specific role/persona/business-domain string
 * appears anywhere in this module. `type` values and field keys are TENANT DATA,
 * never platform constants.
 */

// ---------------------------------------------------------------------------
// Field-type taxonomy (ADR §3.4) — the single source of truth for filter
// operators + server-sortability, shared by the validator and the translator.
// ---------------------------------------------------------------------------

/**
 * The field "kinds" this module understands, INCLUDING the two that are never
 * filterable/sortable on the server v1 (`computed`, `collection`) and the
 * pseudo-column `created_at` (not a record_schema field at all — a native
 * `record` table column).
 */
export type ViewFieldType =
  | "string"
  | "url"
  | "email"
  | "number"
  | "integer"
  | "money"
  | "date"
  | "boolean"
  | "select"
  | "multi-select"
  | "person"
  | "relation"
  | "computed"
  | "collection"
  | "created_at";

/** Filter operators recognized in v1 (ADR §3.4 / spec FR-5). */
export type ViewFilterOp =
  | "eq"
  | "neq"
  | "contains"
  | "starts_with"
  | "is_empty"
  | "is_not_empty"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "before"
  | "after"
  | "is_true"
  | "is_false"
  | "in"
  | "contains_any"
  | "contains_all";

/**
 * operatorsForFieldType — (type) -> allowed operators (FR-5, ADR §3.4 table).
 * `computed`/`collection` map to an EMPTY array: no operator is legal, so any
 * filter on such a field is always rejected (AC-4).
 */
export function operatorsForFieldType(fieldType: ViewFieldType): ViewFilterOp[] {
  switch (fieldType) {
    case "string":
    case "url":
    case "email":
      return ["eq", "neq", "contains", "starts_with", "is_empty", "is_not_empty"];
    case "number":
    case "integer":
    case "money":
      return ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_empty", "is_not_empty"];
    case "date":
      return ["eq", "before", "after", "between", "is_empty", "is_not_empty"];
    case "boolean":
      return ["is_true", "is_false", "is_empty"];
    case "select":
      return ["eq", "neq", "in", "is_empty", "is_not_empty"];
    case "multi-select":
      return ["contains_any", "contains_all", "is_empty", "is_not_empty"];
    case "person":
    case "relation":
      return ["eq", "neq", "is_empty", "is_not_empty"];
    case "created_at":
      return ["eq", "gt", "gte", "lt", "lte", "between"];
    case "computed":
    case "collection":
      return [];
    default:
      return [];
  }
}

/**
 * isServerSortable — (type) -> whether the field can appear in `sort` (FR-6,
 * ADR §3.4 table). string/number/integer/money/date/boolean/select/created_at
 * are server-sortable; computed/collection/multi-select/relation/person are not.
 */
export function isServerSortable(fieldType: ViewFieldType): boolean {
  switch (fieldType) {
    case "string":
    case "url":
    case "email":
    case "number":
    case "integer":
    case "money":
    case "date":
    case "boolean":
    case "select":
    case "created_at":
      return true;
    case "multi-select":
    case "person":
    case "relation":
    case "computed":
    case "collection":
      return false;
    default:
      return false;
  }
}

/** Whether a field type's stored JSON value should be cast to numeric for ORDER BY (R-3). */
export function isNumericFieldType(fieldType: ViewFieldType): boolean {
  return fieldType === "number" || fieldType === "integer" || fieldType === "money";
}

// ---------------------------------------------------------------------------
// record_schema field-type resolution (mirrors apps-schema.js parseRecordSchema,
// pure-TS reimplementation — no browser dependency).
// ---------------------------------------------------------------------------

export interface FieldOrderInfo {
  /** Field keys in x-field-order (or properties-insertion-order fallback), record_schema fields only. */
  readonly orderedKeys: string[];
  /** key -> resolved ViewFieldType (record_schema fields only; excludes 'created_at'). */
  readonly typeByKey: ReadonlyMap<string, ViewFieldType>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Resolve field key order + field type for every property in `recordSchema`,
 * mirroring apps-schema.js's parseRecordSchema type-detection precedence:
 * multi-select > collection > computed(rollup) > relation > money > person >
 * url > email > date > select(enum) > (integer|number|boolean|string fallback).
 *
 * Pure; no IO. Never throws — a malformed schema resolves to an empty map.
 */
export function resolveFieldTypes(recordSchema: unknown): FieldOrderInfo {
  if (!isPlainObject(recordSchema)) {
    return { orderedKeys: [], typeByKey: new Map() };
  }
  const props = recordSchema["properties"];
  if (!isPlainObject(props)) {
    return { orderedKeys: [], typeByKey: new Map() };
  }

  const propKeys = Object.keys(props);
  const propKeySet = new Set(propKeys);
  const xFieldOrderRaw = recordSchema["x-field-order"];
  let orderedKeys: string[];
  if (Array.isArray(xFieldOrderRaw) && xFieldOrderRaw.length > 0) {
    const ordered = xFieldOrderRaw.filter(
      (k): k is string => typeof k === "string" && propKeySet.has(k),
    );
    const orderedSet = new Set(ordered);
    for (const k of propKeys) {
      if (!orderedSet.has(k)) ordered.push(k);
    }
    orderedKeys = ordered;
  } else {
    orderedKeys = propKeys;
  }

  const typeByKey = new Map<string, ViewFieldType>();
  for (const key of orderedKeys) {
    const def = props[key];
    typeByKey.set(key, resolveOneFieldType(def));
  }

  return { orderedKeys, typeByKey };
}

/** Resolve a single JSON-Schema property definition to a ViewFieldType. */
function resolveOneFieldType(def: unknown): ViewFieldType {
  if (!isPlainObject(def)) return "string";
  const rawType = def["type"];

  // multi-select: type:"array" + x-multi-select.
  if (def["x-multi-select"] && rawType === "array") return "multi-select";

  // collection: type:"array" + items.type==="object".
  if (
    rawType === "array" &&
    isPlainObject(def["items"]) &&
    (def["items"] as Record<string, unknown>)["type"] === "object"
  ) {
    return "collection";
  }

  // computed: presence of x-rollup.
  if (isPlainObject(def["x-rollup"])) return "computed";

  // relation: presence of x-relation.
  if (isPlainObject(def["x-relation"])) return "relation";

  // money: presence of x-money.
  if (isPlainObject(def["x-money"])) return "money";

  // person: presence of x-person (truthy).
  if (def["x-person"]) return "person";

  // url / email / date: truthy annotation.
  if (def["x-url"]) return "url";
  if (def["x-email"]) return "email";
  if (def["x-date"]) return "date";

  // select: enum array present.
  if (Array.isArray(def["enum"]) && (def["enum"] as unknown[]).length > 0) return "select";

  // Fallback: JSON-Schema primitive type.
  if (rawType === "integer") return "integer";
  if (rawType === "number") return "number";
  if (rawType === "boolean") return "boolean";
  return "string";
}

// ---------------------------------------------------------------------------
// ViewConfig contract (type='list') — ADR §3.2
// ---------------------------------------------------------------------------

export interface ViewColumn {
  readonly field_key: string;
  readonly visible: boolean;
  readonly width?: number;
}

export interface ViewFilter {
  readonly field_key: string;
  readonly op: string;
  readonly value: unknown;
}

export interface ViewSort {
  readonly field_key: string;
  readonly dir: "asc" | "desc";
}

export interface ListViewConfig {
  readonly columns: ViewColumn[];
  readonly filters: ViewFilter[];
  readonly sort: ViewSort[];
}

export interface ValidateViewConfigResult {
  readonly valid: boolean;
  readonly errors: string[];
}

const PSEUDO_COLUMN_CREATED_AT = "created_at";

/** Resolve a field_key's ViewFieldType, honoring the created_at pseudo-column. */
function fieldTypeFor(fieldKey: string, fieldTypes: FieldOrderInfo): ViewFieldType | null {
  if (fieldKey === PSEUDO_COLUMN_CREATED_AT) return "created_at";
  return fieldTypes.typeByKey.get(fieldKey) ?? null;
}

/**
 * validateViewConfig — the DISPATCHER by `type` (ADR §3.2/FF-VR-4/AC-11).
 *
 * v1 has exactly ONE branch ('list'); an unrecognized `type` is rejected
 * (AC-4-adjacent: unknown type is not silently accepted as if it were 'list').
 * T-0582 adds a 'kanban' branch here — this function's SHAPE (switch/map by
 * `type`) is the fitness-checked contract (FF-VR-4 ci_check), not its current
 * single branch.
 */
export function validateViewConfig(
  type: string,
  config: unknown,
  recordSchema: unknown,
): ValidateViewConfigResult {
  switch (type) {
    case "list":
      return validateListViewConfig(config, recordSchema);
    default:
      return { valid: false, errors: [`unknown view type '${type}'`] };
  }
}

function validateListViewConfig(config: unknown, recordSchema: unknown): ValidateViewConfigResult {
  const errors: string[] = [];
  if (!isPlainObject(config)) {
    return { valid: false, errors: ["config must be a JSON object"] };
  }

  const fieldTypes = resolveFieldTypes(recordSchema);
  const knownFieldKeys = new Set<string>([...fieldTypes.typeByKey.keys(), PSEUDO_COLUMN_CREATED_AT]);

  // --- columns ---
  const columnsRaw = config["columns"];
  if (columnsRaw !== undefined) {
    if (!Array.isArray(columnsRaw)) {
      errors.push("columns must be an array");
    } else {
      columnsRaw.forEach((col, i) => {
        if (!isPlainObject(col)) {
          errors.push(`columns[${i}] must be an object`);
          return;
        }
        const fieldKey = col["field_key"];
        if (typeof fieldKey !== "string" || fieldKey.length === 0) {
          errors.push(`columns[${i}].field_key must be a non-empty string`);
        } else if (!knownFieldKeys.has(fieldKey)) {
          errors.push(`columns[${i}].field_key '${fieldKey}' is not a known field of this record_schema`);
        }
        if (typeof col["visible"] !== "boolean") {
          errors.push(`columns[${i}].visible must be a boolean`);
        }
        if (col["width"] !== undefined && typeof col["width"] !== "number") {
          errors.push(`columns[${i}].width must be a number when present`);
        }
      });
    }
  }

  // --- filters (AND, v1) ---
  const filtersRaw = config["filters"];
  if (filtersRaw !== undefined) {
    if (!Array.isArray(filtersRaw)) {
      errors.push("filters must be an array");
    } else {
      filtersRaw.forEach((f, i) => {
        if (!isPlainObject(f)) {
          errors.push(`filters[${i}] must be an object`);
          return;
        }
        const fieldKey = f["field_key"];
        const op = f["op"];
        if (typeof fieldKey !== "string" || fieldKey.length === 0) {
          errors.push(`filters[${i}].field_key must be a non-empty string`);
          return;
        }
        const fieldType = fieldTypeFor(fieldKey, fieldTypes);
        if (fieldType === null) {
          errors.push(`filters[${i}].field_key '${fieldKey}' is not a known field of this record_schema`);
          return;
        }
        const allowedOps = operatorsForFieldType(fieldType);
        if (typeof op !== "string" || !allowedOps.includes(op as ViewFilterOp)) {
          errors.push(
            `filters[${i}].op '${String(op)}' is not valid for field '${fieldKey}' of type '${fieldType}'` +
              (allowedOps.length === 0 ? " (field type is never filterable on the server)" : ""),
          );
        }
      });
    }
  }

  // --- sort ---
  const sortRaw = config["sort"];
  if (sortRaw !== undefined) {
    if (!Array.isArray(sortRaw)) {
      errors.push("sort must be an array");
    } else {
      sortRaw.forEach((s, i) => {
        if (!isPlainObject(s)) {
          errors.push(`sort[${i}] must be an object`);
          return;
        }
        const fieldKey = s["field_key"];
        const dir = s["dir"];
        if (typeof fieldKey !== "string" || fieldKey.length === 0) {
          errors.push(`sort[${i}].field_key must be a non-empty string`);
          return;
        }
        const fieldType = fieldTypeFor(fieldKey, fieldTypes);
        if (fieldType === null) {
          errors.push(`sort[${i}].field_key '${fieldKey}' is not a known field of this record_schema`);
        } else if (!isServerSortable(fieldType)) {
          errors.push(`sort[${i}].field_key '${fieldKey}' (type '${fieldType}') is not server-sortable in v1`);
        }
        if (dir !== "asc" && dir !== "desc") {
          errors.push(`sort[${i}].dir must be 'asc' or 'desc'`);
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// defaultViewConfig — synthetic default (ADR §3.3 / NF-2 / AC-9)
// ---------------------------------------------------------------------------

/**
 * defaultViewConfig — the synthetic default a набор полей without any saved
 * list_view rows uses: all fields visible in x-field-order + created_at,
 * filters=[], sort=[{created_at, desc}]. Byte-equivalent to today's autogen
 * list (NF-2). Never persisted as a row (ADR §3.3).
 */
export function defaultViewConfig(recordSchema: unknown): ListViewConfig {
  const { orderedKeys } = resolveFieldTypes(recordSchema);
  const columns: ViewColumn[] = orderedKeys.map((field_key) => ({ field_key, visible: true }));
  columns.push({ field_key: PSEUDO_COLUMN_CREATED_AT, visible: true });
  return {
    columns,
    filters: [],
    sort: [{ field_key: PSEUDO_COLUMN_CREATED_AT, dir: "desc" }],
  };
}
