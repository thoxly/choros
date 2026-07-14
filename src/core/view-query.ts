/**
 * src/core/view-query.ts — T-0581 (view registry): filter/sort -> parameterized SQL.
 *
 * PURE, IO-FREE. No import from pg, http, https, net, fetch, fs, child_process.
 * Mirrors data-access-port.ts's purity discipline: this module returns SQL
 * FRAGMENTS + bind params; the edge layer (records.ts) is the only place a
 * client.query() call happens.
 *
 * INJECTION SAFETY (NF-6/AC-13/FF-VR-3): a `field_key` NEVER reaches the returned
 * SQL string as raw text. Every field_key is first checked against the caller-
 * supplied whitelist (the keys of `record_schema` + the 'created_at' pseudo-
 * column); only if it is a member does this module emit a JSONB-path fragment —
 * and even then, the emitted fragment interpolates a FIXED, code-controlled
 * template (`data->>'<key>'`) rather than the raw external string, so a field_key
 * containing SQL metacharacters can never widen the query (it is looked up in a
 * Map, not concatenated into a WHERE/ORDER BY clause unchecked). ALL filter
 * VALUES are bind parameters ($n) — never string-interpolated.
 *
 * READ-PDP / FIELD-VISIBILITY (FR-7/FR-8/AC-6/AC-7): this module has NO
 * knowledge of grants, PDP, or field-visibility — it is a pure SQL-fragment
 * builder. The CALLER (records.ts) is responsible for (1) applying isRecordReadable
 * AFTER the SQL runs (unchanged — this module does not touch that path, FF-VR-1),
 * and (2) passing only the VISIBLE field-key set into `translateFilters`'s
 * `visibleFieldKeys` parameter so a predicate over a redacted field is silently
 * DROPPED before it ever becomes SQL (FR-8: the condition does not transmute into
 * an oracle for the hidden value — it simply never participates in the query,
 * matching "field absent" semantics, not "field always false" or "always true").
 */

import {
  operatorsForFieldType,
  isServerSortable,
  isNumericFieldType,
  resolveFieldTypes,
  type ViewFilter,
  type ViewSort,
  type ViewFieldType,
} from "./view-config.js";

// ---------------------------------------------------------------------------
// Whitelist resolution — the ONLY source of field_key -> JSONB-path mapping.
// ---------------------------------------------------------------------------

const PSEUDO_COLUMN_CREATED_AT = "created_at";

/** Whitelisted field-key -> ViewFieldType map, built from record_schema (+ created_at). */
export interface FieldKeyWhitelist {
  readonly typeByKey: ReadonlyMap<string, ViewFieldType>;
}

/** Build the whitelist from a registry_def's record_schema (pure; NF-6 anchor). */
export function buildFieldKeyWhitelist(recordSchema: unknown): FieldKeyWhitelist {
  const { typeByKey } = resolveFieldTypes(recordSchema);
  const withPseudo = new Map<string, ViewFieldType>(typeByKey);
  withPseudo.set(PSEUDO_COLUMN_CREATED_AT, "created_at");
  return { typeByKey: withPseudo };
}

/**
 * Quote a JSONB-path SQL identifier for a whitelisted field_key. The key has
 * ALREADY been verified to be a Map member by the caller (translateFilters/
 * translateSort) before this is invoked — this function only shapes the SQL
 * text for a key we control. The quote-escaping below (`replace(/'/g, "''")`)
 * is the PRIMARY injection gate for this function, not a defensive backstop:
 * record-schema-validator.ts compiles `record_schema` with a bare `new
 * Ajv().compile(...)` and never applies FIELD_KEY_RE to property names, so the
 * server does NOT enforce the `/^[A-Za-z_][A-Za-z0-9_]{0,63}$/` charset —
 * FIELD_KEY_RE (apps-schema.js) is a BROWSER-ONLY authoring-time constraint in
 * the field-constructor UI, bypassable by any direct API caller. A field_key
 * containing a literal `'` therefore reaches this function in practice, not
 * only in theory, and the escaping here (plus every field_key first passing
 * through the whitelist Map lookup, never being concatenated unchecked) is
 * what actually prevents it from widening the emitted SQL.
 */
function jsonbTextPath(fieldKey: string): string {
  const escaped = fieldKey.replace(/'/g, "''");
  return `r.data->>'${escaped}'`;
}

/**
 * Quote a JSONB-ARRAY-path SQL identifier (the `->` variant, keeping the value
 * as jsonb rather than casting to text) for a whitelisted field_key — used by
 * the multi-select `contains_any`/`contains_all` operators (`?|`/`?&` operate
 * on a jsonb array, not text). Same sanctioned-interpolation-site contract as
 * {@link jsonbTextPath}: callers pass a field_key ALREADY verified against the
 * whitelist Map before this is invoked.
 */
function jsonbArrayPath(fieldKey: string): string {
  const escaped = fieldKey.replace(/'/g, "''");
  return `r.data->'${escaped}'`;
}

// ---------------------------------------------------------------------------
// translateFilters — ViewFilter[] -> parameterized WHERE fragments (AND, v1)
// ---------------------------------------------------------------------------

export interface SqlFragment {
  /** WHERE-clause boolean conditions to AND together (empty = no additional filter). */
  readonly conds: string[];
  /** Bind values for the `$n` placeholders inside `conds`, in emission order. */
  readonly params: unknown[];
}

/**
 * translateFilters — AND-combine `filters` into parameterized SQL predicates.
 *
 * `paramOffset` is the number of `$n` placeholders ALREADY consumed by the
 * caller's base query (so this function's own placeholders continue the
 * caller's numbering — mirrors the `params.length` pattern in records.ts).
 *
 * `visibleFieldKeys` (FR-8/AC-7): when supplied, a filter over a field_key
 * ABSENT from this set is SILENTLY DROPPED (not translated to SQL at all) —
 * field-visibility redaction happens on the SAME record_schema keys this
 * whitelist is built from, so a filter on a role-hidden field cannot become an
 * oracle for its value: the predicate simply never runs. When omitted (no
 * field-visibility resolver wired — honest-degrade, mirrors records.ts's own
 * resolveFieldVisibility? optionality), no field is excluded on this basis.
 *
 * Invalid field_key (not in whitelist) or invalid op-for-type also drops the
 * filter silently at THIS layer — the HTTP-facing caller is expected to have
 * ALREADY rejected such a config via validateViewConfig (AC-4) at write time;
 * this defensive drop only matters for the inline `?filter=` query-param path
 * (ADR §4) where validation happens per-request, not per-saved-view.
 */
export function translateFilters(
  filters: readonly ViewFilter[],
  whitelist: FieldKeyWhitelist,
  paramOffset: number,
  visibleFieldKeys?: ReadonlySet<string>,
): SqlFragment {
  const conds: string[] = [];
  const params: unknown[] = [];
  let nextParamIndex = paramOffset;

  for (const filter of filters) {
    const fieldType = whitelist.typeByKey.get(filter.field_key);
    if (fieldType === undefined) continue; // not a whitelisted key — drop (NF-6)
    if (visibleFieldKeys !== undefined && !visibleFieldKeys.has(filter.field_key)) continue; // FR-8

    const allowedOps = operatorsForFieldType(fieldType);
    if (!allowedOps.includes(filter.op as (typeof allowedOps)[number])) continue; // invalid op-for-type — drop

    const path = jsonbTextPath(filter.field_key);
    const numeric = isNumericFieldType(fieldType);
    const castPath = numeric ? `(${path})::numeric` : path;

    switch (filter.op) {
      case "eq":
        params.push(numeric ? filter.value : String(filter.value));
        nextParamIndex += 1;
        conds.push(`${castPath} = $${nextParamIndex}`);
        break;
      case "neq":
        params.push(numeric ? filter.value : String(filter.value));
        nextParamIndex += 1;
        conds.push(`${castPath} <> $${nextParamIndex}`);
        break;
      case "contains":
        params.push(`%${String(filter.value)}%`);
        nextParamIndex += 1;
        conds.push(`${path} ILIKE $${nextParamIndex}`);
        break;
      case "starts_with":
        params.push(`${String(filter.value)}%`);
        nextParamIndex += 1;
        conds.push(`${path} ILIKE $${nextParamIndex}`);
        break;
      case "is_empty":
        conds.push(`(${path} IS NULL OR ${path} = '')`);
        break;
      case "is_not_empty":
        conds.push(`(${path} IS NOT NULL AND ${path} <> '')`);
        break;
      case "gt":
        params.push(filter.value);
        nextParamIndex += 1;
        conds.push(`${castPath} > $${nextParamIndex}`);
        break;
      case "gte":
        params.push(filter.value);
        nextParamIndex += 1;
        conds.push(`${castPath} >= $${nextParamIndex}`);
        break;
      case "lt":
        params.push(filter.value);
        nextParamIndex += 1;
        conds.push(`${castPath} < $${nextParamIndex}`);
        break;
      case "lte":
        params.push(filter.value);
        nextParamIndex += 1;
        conds.push(`${castPath} <= $${nextParamIndex}`);
        break;
      case "between": {
        if (!Array.isArray(filter.value) || filter.value.length !== 2) break;
        const [lo, hi] = filter.value as [unknown, unknown];
        params.push(lo);
        nextParamIndex += 1;
        const loParam = nextParamIndex;
        params.push(hi);
        nextParamIndex += 1;
        const hiParam = nextParamIndex;
        conds.push(`${castPath} BETWEEN $${loParam} AND $${hiParam}`);
        break;
      }
      case "before":
        params.push(String(filter.value));
        nextParamIndex += 1;
        conds.push(`${path} < $${nextParamIndex}`);
        break;
      case "after":
        params.push(String(filter.value));
        nextParamIndex += 1;
        conds.push(`${path} > $${nextParamIndex}`);
        break;
      case "is_true":
        conds.push(`${path} = 'true'`);
        break;
      case "is_false":
        conds.push(`${path} = 'false'`);
        break;
      case "in": {
        if (!Array.isArray(filter.value) || filter.value.length === 0) break;
        params.push(filter.value.map((v) => String(v)));
        nextParamIndex += 1;
        conds.push(`${path} = ANY($${nextParamIndex}::text[])`);
        break;
      }
      case "contains_any": {
        // multi-select stores a JSONB array; ?| tests overlap against a text[] operand.
        if (!Array.isArray(filter.value) || filter.value.length === 0) break;
        params.push(filter.value.map((v) => String(v)));
        nextParamIndex += 1;
        conds.push(`${jsonbArrayPath(filter.field_key)} ?| $${nextParamIndex}::text[]`);
        break;
      }
      case "contains_all": {
        if (!Array.isArray(filter.value) || filter.value.length === 0) break;
        params.push(filter.value.map((v) => String(v)));
        nextParamIndex += 1;
        conds.push(`${jsonbArrayPath(filter.field_key)} ?& $${nextParamIndex}::text[]`);
        break;
      }
      default:
        // Unknown op — already excluded by the allowedOps check above.
        break;
    }
  }

  return { conds, params };
}

// ---------------------------------------------------------------------------
// translateSort — ViewSort[] -> parameterized ORDER BY (+ vertical secondary id)
// ---------------------------------------------------------------------------

export interface SortTranslation {
  /** `ORDER BY <fragment>` body (WITHOUT the `ORDER BY` keyword), always ending in `r.id ASC`. */
  readonly orderBy: string;
}

/**
 * translateSort — build an `ORDER BY` fragment from `sort` (FR-6/AC-5/R-3).
 *
 * Only server-sortable, whitelisted field_keys participate; anything else is
 * silently dropped from the ORDER BY (defensive — validateViewConfig should
 * already have rejected it at config-save time, AC-5). Numeric field types are
 * cast to `::numeric` so "10" sorts after "9" (R-3). A secondary `r.id ASC`
 * is ALWAYS appended for determinism (stable pagination boundary), even when
 * `sort` is empty (in which case the caller's default `created_at DESC` applies
 * BEFORE this function is consulted — see records.ts wiring).
 */
export function translateSort(sort: readonly ViewSort[], whitelist: FieldKeyWhitelist): SortTranslation {
  const parts: string[] = [];
  for (const s of sort) {
    const fieldType = whitelist.typeByKey.get(s.field_key);
    if (fieldType === undefined) continue;
    if (!isServerSortable(fieldType)) continue;
    const dirSql = s.dir === "asc" ? "ASC" : "DESC";

    if (s.field_key === PSEUDO_COLUMN_CREATED_AT) {
      parts.push(`r.created_at ${dirSql}`);
      continue;
    }
    const path = jsonbTextPath(s.field_key);
    const orderExpr = isNumericFieldType(fieldType) ? `(${path})::numeric` : path;
    parts.push(`${orderExpr} ${dirSql}`);
  }
  parts.push("r.id ASC");
  return { orderBy: parts.join(", ") };
}
