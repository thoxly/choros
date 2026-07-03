/**
 * src/core/rollup-contract.ts — T-0407 [D7-8]
 *
 * PURE TYPE CONTRACTS for `rollup` and `matrix-lookup` binding contracts (PD-18 /
 * PD-20 / ADR §6). These are the x-extension annotations stored inside
 * `registry_def.record_schema` property definitions — the AUTHORING-TIME contract
 * that drives the DB-side compute (GROUP BY aggregation / matrix join).
 *
 * ──────────────────────────────────────────────────────────────────────
 * ROLLUP  (aggregate over related/child records)
 * ──────────────────────────────────────────────────────────────────────
 * A `rollup` field is a READ-ONLY aggregate derived from related records.
 * It is NOT stored in `record.data`; it is computed by the DB at read time
 * using GROUP BY (PD-20: "агрегаты считает БД"). The authoring contract:
 *
 *   x-rollup: {
 *     source_registry_id: "<uuid>",  // which registry holds the child rows
 *     ref_field:          "<key>",   // the FK field on the child record that
 *                                    // points back to the parent record
 *     aggregate:          "sum" | "count" | "avg" | "min" | "max",
 *     value_field?:       "<key>",   // child field to aggregate (absent for count)
 *   }
 *
 * HOP-CAP / NO-ROLLUP-OF-ROLLUP (ADR §6):
 *   The aggregated source registry MUST NOT itself contain a rollup field —
 *   i.e. rollup-of-rollup is FORBIDDEN. The validator (validateRollupFieldDef)
 *   enforces a 1-level cap: the aggregate is over raw record.data fields only.
 *   This mirrors HOP_CAP (cross-app-ref.ts §6: traversal bounded to prevent cycles
 *   and resource exhaustion). The DB query is a single GROUP BY — no recursive CTE.
 *
 * ──────────────────────────────────────────────────────────────────────
 * MATRIX-LOOKUP  (2-axis normative table → value)
 * ──────────────────────────────────────────────────────────────────────
 * A `matrix-lookup` field resolves a value from a 2-axis parameters table:
 *   axis-A (e.g. project type) × axis-B (e.g. task type) → numeric value
 * The table is stored in `choros.matrix_lookup_table` (migration 109).
 * The lookup is a single indexed PK scan — zero GROUP BY, O(1) per record.
 *
 *   x-matrix-lookup: {
 *     table_id:     "<uuid>",  // references matrix_lookup_table(tenant_id, id)
 *     axis_a_field: "<key>",   // field on THIS record providing axis-A value
 *     axis_b_field: "<key>",   // field on THIS record providing axis-B value
 *   }
 *
 * ──────────────────────────────────────────────────────────────────────
 * SCHEMA SLOT
 * ──────────────────────────────────────────────────────────────────────
 * Both rollup and matrix-lookup use schemaSlot = "derived" in the
 * binding-contract-catalog. A derived field:
 *   - is NOT present in `record.data` (never written)
 *   - is NEVER accepted in submit validation (form-submit-validator strips it)
 *   - is APPENDED to GET /api/records/:id responses as a `derived` map
 *   - is NOT part of AJV schema compilation (x-rollup / x-matrix-lookup are
 *     stripped by stripXExtensions before compile, T-0444)
 *
 * PURITY: no pg, no node:http, no node:fs, no process.env, no child_process.
 * Mirrors binding-contract-catalog.ts / cross-app-ref.ts / form-submit-validator.ts.
 */

// ---------------------------------------------------------------------------
// Aggregate function vocabulary (rollup)
// ---------------------------------------------------------------------------

/**
 * The CLOSED set of aggregate functions for a rollup field (PD-20).
 * Only these functions are emitted in the DB GROUP BY expression — no arbitrary
 * SQL injection. The DB layer maps this to the SQL function name directly.
 */
export type RollupAggregate = "sum" | "count" | "avg" | "min" | "max";

/** All aggregate kinds, in catalog order. */
export const ROLLUP_AGGREGATES: readonly RollupAggregate[] = [
  "sum",
  "count",
  "avg",
  "min",
  "max",
];

/** True iff `value` is a known aggregate function. */
export function isRollupAggregate(value: unknown): value is RollupAggregate {
  return (
    typeof value === "string" &&
    (ROLLUP_AGGREGATES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// RollupFieldDef — the x-rollup annotation on a record_schema property
// ---------------------------------------------------------------------------

/**
 * The `x-rollup` extension stored in a record_schema property definition.
 * Parsed from `record_schema.properties.<fieldKey>["x-rollup"]`.
 *
 * Invariants (enforced by validateRollupFieldDef):
 *   - source_registry_id is a UUID string
 *   - ref_field is a non-empty string (JUEL variable name)
 *   - aggregate is in ROLLUP_AGGREGATES
 *   - value_field must be present (non-empty) when aggregate != "count"
 *   - value_field must be absent / undefined when aggregate === "count"
 *     (counting rows needs no value field)
 */
export interface RollupFieldDef {
  /** UUID of the registry_def whose records are the aggregation source. */
  readonly source_registry_id: string;
  /**
   * The JSONB key on the CHILD record whose value holds the PARENT record's UUID
   * (the foreign-key back-link). The DB query: WHERE child.data->>'ref_field' = parent_id.
   */
  readonly ref_field: string;
  /** The aggregate function to apply. */
  readonly aggregate: RollupAggregate;
  /**
   * The JSONB key on the child record whose value is aggregated.
   * Required when aggregate ∈ {sum, avg, min, max}; absent for count.
   * The DB casts it to NUMERIC: (child.data->>'value_field')::numeric.
   */
  readonly value_field?: string;
}

// ---------------------------------------------------------------------------
// EmbeddedRollupFieldDef — the x-rollup annotation over an in-record collection
// ---------------------------------------------------------------------------

/**
 * The SECOND flavor of `x-rollup` — an aggregate over a collection ARRAY that
 * lives INSIDE this record's own `data` (an embedded line-items sub-field),
 * NOT over child records in another registry.
 *
 * This is the shape the interface constructor authors (a `computed` field over a
 * `collection` sub-field): `x-rollup: { source, op, value_field?, factor_field? }`.
 * `source` names a collection property key on THIS record whose value is an array
 * of row objects; each row carries the `value_field` (and optional `factor_field`)
 * scalars. The aggregate is computed PURELY IN MEMORY from `record.data[source]`
 * — no DB query (the rows are already in `data`, unlike child-record rollup).
 *
 * The two flavors are distinguished by an EXPLICIT discriminator (never guessed):
 * an `x-rollup` object carrying `source_registry_id` is the child-records flavor
 * (RollupFieldDef); one carrying `source` (and no `source_registry_id`) is this
 * embedded flavor. See extractDerivedFields / dispatchRollupFlavor.
 *
 * Invariants (enforced by validateEmbeddedRollupFieldDef):
 *   - source is a non-empty string (a JUEL-name key of an array sub-field)
 *   - op is in ROLLUP_AGGREGATES
 *   - value_field must be present (non-empty) when op != "count"
 *   - value_field must be absent / undefined when op === "count"
 *   - factor_field, when present, is a non-empty string; it is only meaningful for
 *     op === "sum" (mirrors records-form.js::computeRollup, which reads the factor
 *     only in the sum branch); the compute silently ignores it for other ops.
 *
 * SEMANTICS (compute): see computeEmbeddedRollup — a DELIBERATE mirror of the
 * client-side authoring reference web/src/screens/records-form.js::computeRollup,
 * so the server-projected value (at create=start and on READ) equals what the UI
 * displays for the same data. This closes the UI↔engine divergence that let a
 * rollup sum render in the browser yet reach Flowable as NULL.
 */
export interface EmbeddedRollupFieldDef {
  /** The JSONB key on THIS record whose value is the collection array to aggregate. */
  readonly source: string;
  /** The aggregate function to apply. */
  readonly op: RollupAggregate;
  /**
   * The row-object key whose value is aggregated.
   * Required when op ∈ {sum, avg, min, max}; absent for count.
   * Row cells are coerced via Number(); non-numeric/blank cells are skipped.
   */
  readonly value_field?: string;
  /**
   * The row-object key whose value multiplies value_field, ONLY for op === "sum"
   * (e.g. quantity × price). Defaults to 1 when absent or non-numeric. Optional.
   */
  readonly factor_field?: string;
}

// ---------------------------------------------------------------------------
// MatrixLookupFieldDef — the x-matrix-lookup annotation on a property
// ---------------------------------------------------------------------------

/**
 * The `x-matrix-lookup` extension stored in a record_schema property definition.
 * Parsed from `record_schema.properties.<fieldKey>["x-matrix-lookup"]`.
 *
 * Invariants (enforced by validateMatrixLookupFieldDef):
 *   - table_id is a UUID string
 *   - axis_a_field is a non-empty string (key on THIS record)
 *   - axis_b_field is a non-empty string (key on THIS record)
 *   - axis_a_field !== axis_b_field (distinct axes)
 */
export interface MatrixLookupFieldDef {
  /** UUID of the matrix_lookup_table (choros.matrix_lookup_table.id). */
  readonly table_id: string;
  /**
   * The JSONB key on THIS record that provides the axis-A value
   * (e.g. project_type_field). The DB query uses this as the axis_a_value.
   */
  readonly axis_a_field: string;
  /**
   * The JSONB key on THIS record that provides the axis-B value
   * (e.g. task_type_field). The DB query uses this as the axis_b_value.
   */
  readonly axis_b_field: string;
}

// ---------------------------------------------------------------------------
// Parsed derived-field descriptor (used by the DAO and HTTP handler)
// ---------------------------------------------------------------------------

/**
 * A parsed derived field found in a registry_def's record_schema.
 * The schema can have multiple derived fields (different properties with
 * different x-* annotations); this union type represents one of them.
 */
export type DerivedFieldSpec =
  | { readonly kind: "rollup"; readonly fieldKey: string; readonly def: RollupFieldDef }
  | { readonly kind: "rollup-embedded"; readonly fieldKey: string; readonly def: EmbeddedRollupFieldDef }
  | { readonly kind: "matrix-lookup"; readonly fieldKey: string; readonly def: MatrixLookupFieldDef };

// ---------------------------------------------------------------------------
// Validation helpers — pure, no I/O
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** Non-empty string guard. */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export type RollupFieldDefError =
  | "source_registry_id_missing_or_invalid"
  | "ref_field_missing_or_empty"
  | "aggregate_missing_or_invalid"
  | "value_field_required_for_aggregate"
  | "value_field_must_be_absent_for_count";

export type RollupFieldDefResult =
  | { ok: true; def: RollupFieldDef }
  | { ok: false; error: RollupFieldDefError; message: string };

/**
 * Validate and parse an `x-rollup` annotation from a raw property definition.
 * Returns the parsed RollupFieldDef or a typed error.
 *
 * Pure — no I/O.
 *
 * @param raw   the raw `x-rollup` value from a JSON Schema property definition.
 */
export function validateRollupFieldDef(raw: unknown): RollupFieldDefResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: "source_registry_id_missing_or_invalid",
      message: "x-rollup must be a plain object",
    };
  }
  const obj = raw as Record<string, unknown>;

  // source_registry_id
  if (!isUuid(obj["source_registry_id"])) {
    return {
      ok: false,
      error: "source_registry_id_missing_or_invalid",
      message: "x-rollup.source_registry_id must be a valid UUID",
    };
  }
  const source_registry_id = obj["source_registry_id"] as string;

  // ref_field
  if (!isNonEmptyString(obj["ref_field"])) {
    return {
      ok: false,
      error: "ref_field_missing_or_empty",
      message: "x-rollup.ref_field must be a non-empty string",
    };
  }
  const ref_field = obj["ref_field"] as string;

  // aggregate
  if (!isRollupAggregate(obj["aggregate"])) {
    return {
      ok: false,
      error: "aggregate_missing_or_invalid",
      message: `x-rollup.aggregate must be one of: ${ROLLUP_AGGREGATES.join(", ")}`,
    };
  }
  const aggregate = obj["aggregate"] as RollupAggregate;

  // value_field — required for sum/avg/min/max, must be absent for count
  if (aggregate === "count") {
    if (obj["value_field"] !== undefined && obj["value_field"] !== null) {
      return {
        ok: false,
        error: "value_field_must_be_absent_for_count",
        message: "x-rollup.value_field must not be set when aggregate is 'count'",
      };
    }
    return { ok: true, def: { source_registry_id, ref_field, aggregate } };
  }

  // For sum/avg/min/max: value_field must be present and non-empty.
  if (!isNonEmptyString(obj["value_field"])) {
    return {
      ok: false,
      error: "value_field_required_for_aggregate",
      message: `x-rollup.value_field is required when aggregate is '${aggregate}'`,
    };
  }
  const value_field = obj["value_field"] as string;

  return { ok: true, def: { source_registry_id, ref_field, aggregate, value_field } };
}

export type EmbeddedRollupFieldDefError =
  | "source_missing_or_empty"
  | "op_missing_or_invalid"
  | "value_field_required_for_op"
  | "value_field_must_be_absent_for_count"
  | "factor_field_must_be_non_empty_string";

export type EmbeddedRollupFieldDefResult =
  | { ok: true; def: EmbeddedRollupFieldDef }
  | { ok: false; error: EmbeddedRollupFieldDefError; message: string };

/**
 * Validate and parse an EMBEDDED `x-rollup` annotation (aggregate over an
 * in-record collection array) from a raw property definition. Returns the parsed
 * EmbeddedRollupFieldDef or a typed error.
 *
 * Pure — no I/O.
 *
 * @param raw   the raw `x-rollup` value from a JSON Schema property definition.
 */
export function validateEmbeddedRollupFieldDef(raw: unknown): EmbeddedRollupFieldDefResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: "source_missing_or_empty",
      message: "x-rollup must be a plain object",
    };
  }
  const obj = raw as Record<string, unknown>;

  // source — the collection sub-field key on THIS record
  if (!isNonEmptyString(obj["source"])) {
    return {
      ok: false,
      error: "source_missing_or_empty",
      message: "x-rollup.source must be a non-empty string",
    };
  }
  const source = obj["source"] as string;

  // op — the same closed aggregate set as the child flavor
  if (!isRollupAggregate(obj["op"])) {
    return {
      ok: false,
      error: "op_missing_or_invalid",
      message: `x-rollup.op must be one of: ${ROLLUP_AGGREGATES.join(", ")}`,
    };
  }
  const op = obj["op"] as RollupAggregate;

  // factor_field — optional, but when present must be a non-empty string.
  // (Only meaningful for op === "sum"; the compute ignores it for other ops,
  //  mirroring records-form.js::computeRollup — but the shape is still validated
  //  so a corrupt non-string factor_field is rejected rather than silently used.)
  const rawFactor = obj["factor_field"];
  if (rawFactor !== undefined && rawFactor !== null && !isNonEmptyString(rawFactor)) {
    return {
      ok: false,
      error: "factor_field_must_be_non_empty_string",
      message: "x-rollup.factor_field, when present, must be a non-empty string",
    };
  }
  const factor_field = isNonEmptyString(rawFactor) ? rawFactor : undefined;

  // value_field — required for sum/avg/min/max, must be absent for count.
  if (op === "count") {
    if (obj["value_field"] !== undefined && obj["value_field"] !== null) {
      return {
        ok: false,
        error: "value_field_must_be_absent_for_count",
        message: "x-rollup.value_field must not be set when op is 'count'",
      };
    }
    return factor_field !== undefined
      ? { ok: true, def: { source, op, factor_field } }
      : { ok: true, def: { source, op } };
  }

  if (!isNonEmptyString(obj["value_field"])) {
    return {
      ok: false,
      error: "value_field_required_for_op",
      message: `x-rollup.value_field is required when op is '${op}'`,
    };
  }
  const value_field = obj["value_field"] as string;

  return factor_field !== undefined
    ? { ok: true, def: { source, op, value_field, factor_field } }
    : { ok: true, def: { source, op, value_field } };
}

// ---------------------------------------------------------------------------
// computeEmbeddedRollup — PURE in-memory aggregate over a record's own collection
// ---------------------------------------------------------------------------

/**
 * Compute an embedded-rollup value from a record's `data` — PURELY in memory,
 * no DB access (the collection array is already in record.data).
 *
 * This is a DELIBERATE mirror of the client-side authoring reference
 * `web/src/screens/records-form.js::computeRollup`, so the server-projected value
 * (at create=start and on GET) equals what the UI computes and displays for the
 * same data. Keep the two in lockstep: any change to the client semantics must be
 * reflected here (and vice-versa) — the tests assert identical results on shared
 * fixtures (AC-5).
 *
 * Semantics:
 *   - recordData[def.source] must be an array of row objects; else → null.
 *   - count: null when 0 rows, otherwise the row count (value_field irrelevant).
 *   - sum/avg/min/max: collect numeric value_field cells (Number()-coerced;
 *     non-numeric/blank/NaN cells skipped). For sum with a factor_field, each
 *     value is multiplied by the row's factor (default 1 when absent/non-numeric).
 *     Empty collected list → null (never coerced to 0).
 *   - sum = Σ; avg = mean; min/max = extrema of the collected values.
 *
 * @param def         parsed EmbeddedRollupFieldDef.
 * @param recordData  the record's `data` object (already in memory).
 * @returns number | null
 */
export function computeEmbeddedRollup(
  def: EmbeddedRollupFieldDef,
  recordData: unknown,
): number | null {
  if (recordData === null || typeof recordData !== "object" || Array.isArray(recordData)) {
    return null;
  }
  const rows = (recordData as Record<string, unknown>)[def.source];
  if (!Array.isArray(rows)) return null;

  // count: just the row count; value_field/factor_field irrelevant.
  if (def.op === "count") {
    return rows.length === 0 ? null : rows.length;
  }

  const valueField = def.value_field ?? "";
  const factorField = def.factor_field ?? "";
  const values: number[] = [];

  for (const row of rows) {
    const rowObj = row !== null && typeof row === "object" ? (row as Record<string, unknown>) : {};
    const num = toFiniteNumber(rowObj[valueField]);
    if (num === null) continue;

    if (def.op === "sum" && factorField.length > 0) {
      const f = toFiniteNumber(rowObj[factorField]);
      const factor = f === null ? 1 : f;
      values.push(num * factor);
    } else {
      values.push(num);
    }
  }

  if (values.length === 0) return null;

  switch (def.op) {
    case "sum":
      return values.reduce((acc, x) => acc + x, 0);
    case "avg":
      return values.reduce((acc, x) => acc + x, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    default:
      return null; // unreachable (op validated), defensive
  }
}

/**
 * Coerce a raw cell value to a finite JS number, or null when it is not a usable
 * numeric (blank string, non-numeric string, boolean, object, NaN, ±Infinity).
 * Mirrors the numeric-cell handling in records-form.js::computeRollup.
 */
function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const v = Number(trimmed);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

export type MatrixLookupFieldDefError =
  | "table_id_missing_or_invalid"
  | "axis_a_field_missing_or_empty"
  | "axis_b_field_missing_or_empty"
  | "axis_fields_must_be_distinct";

export type MatrixLookupFieldDefResult =
  | { ok: true; def: MatrixLookupFieldDef }
  | { ok: false; error: MatrixLookupFieldDefError; message: string };

/**
 * Validate and parse an `x-matrix-lookup` annotation from a raw property definition.
 * Returns the parsed MatrixLookupFieldDef or a typed error.
 *
 * Pure — no I/O.
 *
 * @param raw   the raw `x-matrix-lookup` value from a JSON Schema property definition.
 */
export function validateMatrixLookupFieldDef(
  raw: unknown,
): MatrixLookupFieldDefResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: "table_id_missing_or_invalid",
      message: "x-matrix-lookup must be a plain object",
    };
  }
  const obj = raw as Record<string, unknown>;

  // table_id
  if (!isUuid(obj["table_id"])) {
    return {
      ok: false,
      error: "table_id_missing_or_invalid",
      message: "x-matrix-lookup.table_id must be a valid UUID",
    };
  }
  const table_id = obj["table_id"] as string;

  // axis_a_field
  if (!isNonEmptyString(obj["axis_a_field"])) {
    return {
      ok: false,
      error: "axis_a_field_missing_or_empty",
      message: "x-matrix-lookup.axis_a_field must be a non-empty string",
    };
  }
  const axis_a_field = obj["axis_a_field"] as string;

  // axis_b_field
  if (!isNonEmptyString(obj["axis_b_field"])) {
    return {
      ok: false,
      error: "axis_b_field_missing_or_empty",
      message: "x-matrix-lookup.axis_b_field must be a non-empty string",
    };
  }
  const axis_b_field = obj["axis_b_field"] as string;

  // Axes must be distinct (otherwise the lookup is degenerate: A×A)
  if (axis_a_field === axis_b_field) {
    return {
      ok: false,
      error: "axis_fields_must_be_distinct",
      message: "x-matrix-lookup.axis_a_field and axis_b_field must be distinct field keys",
    };
  }

  return { ok: true, def: { table_id, axis_a_field, axis_b_field } };
}

// ---------------------------------------------------------------------------
// Schema scanner — extract DerivedFieldSpec[] from a registry_def.record_schema
// ---------------------------------------------------------------------------

/**
 * Scan a registry_def's `record_schema` and extract all derived-field annotations
 * (`x-rollup` and `x-matrix-lookup`). Returns a (possibly empty) array of
 * DerivedFieldSpec, one per valid annotated property.
 *
 * Invalid annotations are SILENTLY SKIPPED (defensive — the schema was already
 * validated on write; a corrupt annotation should not crash read). The caller
 * may log parse errors if needed; this function focuses on extraction.
 *
 * Pure — no I/O.
 *
 * @param schema  the registry_def.record_schema value (from DB; typed as unknown).
 */
export function extractDerivedFields(schema: unknown): DerivedFieldSpec[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return [];
  }
  const s = schema as Record<string, unknown>;
  const props = s["properties"];
  if (props === null || typeof props !== "object" || Array.isArray(props)) {
    return [];
  }
  const properties = props as Record<string, unknown>;
  const result: DerivedFieldSpec[] = [];

  for (const [fieldKey, propDef] of Object.entries(properties)) {
    if (propDef === null || typeof propDef !== "object" || Array.isArray(propDef)) {
      continue;
    }
    const pd = propDef as Record<string, unknown>;

    // x-rollup annotation — TWO flavors share this key, distinguished by an
    // EXPLICIT discriminator (never a try-one-then-the-other fallback):
    //   - carries `source_registry_id` → child-records flavor (RollupFieldDef,
    //     aggregated by the DB over another registry's rows).
    //   - otherwise → embedded flavor (EmbeddedRollupFieldDef, aggregated purely
    //     in memory over a collection array inside THIS record's data).
    const xRollup = pd["x-rollup"];
    if (xRollup !== undefined) {
      if (
        xRollup !== null &&
        typeof xRollup === "object" &&
        !Array.isArray(xRollup) &&
        (xRollup as Record<string, unknown>)["source_registry_id"] !== undefined
      ) {
        const parsed = validateRollupFieldDef(xRollup);
        if (parsed.ok) {
          result.push({ kind: "rollup", fieldKey, def: parsed.def });
        }
        // silently skip invalid (corrupt stored schema — defensive)
      } else {
        const parsed = validateEmbeddedRollupFieldDef(xRollup);
        if (parsed.ok) {
          result.push({ kind: "rollup-embedded", fieldKey, def: parsed.def });
        }
        // silently skip invalid (corrupt stored schema — defensive)
      }
    }

    // x-matrix-lookup annotation
    if (pd["x-matrix-lookup"] !== undefined) {
      const parsed = validateMatrixLookupFieldDef(pd["x-matrix-lookup"]);
      if (parsed.ok) {
        result.push({ kind: "matrix-lookup", fieldKey, def: parsed.def });
      }
      // silently skip invalid
    }
  }

  return result;
}
