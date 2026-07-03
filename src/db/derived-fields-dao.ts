/**
 * src/db/derived-fields-dao.ts — T-0407 [D7-8]
 *
 * DB-side compute for `rollup` and `matrix-lookup` derived fields (PD-20).
 *
 * PD-20: "агрегаты считает БД (GROUP BY), браузер получает маленький результат."
 * This module runs the DB queries that compute derived field values at READ time.
 * Derived values are NEVER stored in `record.data`; they are appended to the
 * GET /api/records/:id response as a `derived` map by the HTTP handler.
 *
 * ──────────────────────────────────────────────────────────────────────
 * computeRollupValue(client, tenantId, parentRecordId, def)
 * ──────────────────────────────────────────────────────────────────────
 *   Computes an aggregate over child records (ADR §6: "hop-cap / no-rollup-of-rollup").
 *
 *   SQL pattern (single GROUP BY, no recursive CTE, O(N_children) per record):
 *     SELECT <aggregate>(data->>'value_field'::numeric)
 *       FROM choros.record
 *      WHERE tenant_id = $tenant
 *        AND registry_id = $source_registry_id
 *        AND data->>'ref_field' = $parent_record_id
 *
 *   No-rollup-of-rollup: the aggregated fields are raw `data` JSONB paths —
 *   never another derived field. The contract enforces this: only
 *   `record.data` fields are aggregatable; derived annotations are not in `data`.
 *
 * ──────────────────────────────────────────────────────────────────────
 * computeMatrixLookupValue(client, tenantId, recordData, def)
 * ──────────────────────────────────────────────────────────────────────
 *   Looks up a value from matrix_lookup_cell using the record's axis field values.
 *
 *   SQL pattern (single indexed PK scan, O(1)):
 *     SELECT numeric_value
 *       FROM choros.matrix_lookup_cell
 *      WHERE tenant_id = $tenant
 *        AND table_id = $table_id
 *        AND axis_a_value = $record_data[axis_a_field]
 *        AND axis_b_value = $record_data[axis_b_field]
 *
 * ──────────────────────────────────────────────────────────────────────
 * computeAllDerivedFields(client, tenantId, record, derivedSpecs)
 * ──────────────────────────────────────────────────────────────────────
 *   Runs all derived-field computations for a single record and returns a map
 *   fieldKey → number | null. Called by the GET /api/records/:id handler after
 *   the main record fetch.
 *
 * TENANT ISOLATION (mandatory):
 *   Every query carries an explicit `WHERE tenant_id = $1` AND runs inside an
 *   ALREADY-OPEN tenant-scoped tx (SET LOCAL choros.tenant_id + FORCE RLS).
 *   The explicit predicate is the T-0184 double-predicate guard (RLS + WHERE).
 *
 * NOT a second authority path: these queries read choros.record rows that are
 * already scope-narrowed by RLS. No grant algebra here — the caller already
 * resolved the actor's tenant before opening the tx.
 *
 * Pure DB access layer — no HTTP, no core business logic (those live in
 * src/core/rollup-contract.ts and src/http/records.ts respectively).
 */

import pg from "pg";
import type {
  RollupFieldDef,
  MatrixLookupFieldDef,
  DerivedFieldSpec,
} from "../core/rollup-contract.js";
import { computeEmbeddedRollup } from "../core/rollup-contract.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result of computing a single derived field. */
export type DerivedFieldResult =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/** Map of fieldKey → computed value (null if no matching rows/cell). */
export type DerivedFieldMap = Record<string, number | null>;

// ---------------------------------------------------------------------------
// computeRollupValue — single GROUP BY aggregate over child records
// ---------------------------------------------------------------------------

/**
 * Compute a rollup aggregate for `parentRecordId` in tenant `tenantId`.
 *
 * Queries `choros.record` for child rows whose:
 *   - registry_id = def.source_registry_id
 *   - data->>'ref_field' = parentRecordId
 *
 * Applies the aggregate function to `data->>'value_field'`::numeric
 * (or COUNT(*) for aggregate = "count").
 *
 * Returns `{ ok: true, value: number | null }`:
 *   - number if rows exist and the aggregate is defined.
 *   - null if no matching child rows exist.
 *
 * ADR §6 / no-rollup-of-rollup: the aggregated data path is a raw JSONB
 * field in `record.data` — not a derived annotation. This function never
 * traverses another derived field; the SQL is a single GROUP BY on raw data.
 *
 * HOP_CAP: rollup is depth 1 (parent → children). The DB query is not
 * recursive; no further hops are performed. This is structurally equivalent
 * to depth = 1 which is always < HOP_CAP (3). No rollup-of-rollup guard
 * is needed at the query level because derived fields are never in record.data.
 *
 * @param client        pg client inside an ALREADY-OPEN tenant-scoped tx.
 * @param tenantId      tenant UUID (must match the GUC already set).
 * @param parentRecordId the UUID of the parent record being read.
 * @param def           parsed RollupFieldDef from the parent registry's schema.
 */
export async function computeRollupValue(
  client: pg.PoolClient | pg.Client,
  tenantId: string,
  parentRecordId: string,
  def: RollupFieldDef,
): Promise<DerivedFieldResult> {
  try {
    let sql: string;
    let params: string[];

    if (def.aggregate === "count") {
      // COUNT(*) — no value_field cast needed.
      sql = `
        SELECT COUNT(*)::numeric AS result
          FROM choros.record
         WHERE tenant_id  = $1
           AND registry_id = $2
           AND data->>'${escapeJsonKey(def.ref_field)}' = $3
      `;
      params = [tenantId, def.source_registry_id, parentRecordId];
    } else {
      // sum / avg / min / max — cast value_field to numeric.
      // value_field is required (validated by validateRollupFieldDef).
      const valueField = def.value_field!;
      const aggFn = SAFE_AGG_FN[def.aggregate];
      sql = `
        SELECT ${aggFn}((data->>'${escapeJsonKey(valueField)}')::numeric) AS result
          FROM choros.record
         WHERE tenant_id   = $1
           AND registry_id  = $2
           AND data->>'${escapeJsonKey(def.ref_field)}' = $3
      `;
      params = [tenantId, def.source_registry_id, parentRecordId];
    }

    const res = await client.query<{ result: string | null }>(sql, params);
    const raw = res.rows[0]?.result ?? null;
    const value = raw === null ? null : Number(raw);
    return { ok: true, value: isNaN(value!) ? null : value };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `rollup query failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// computeMatrixLookupValue — single indexed PK scan on matrix_lookup_cell
// ---------------------------------------------------------------------------

/**
 * Compute a matrix-lookup value for the given record's axis field values.
 *
 * Reads `record.data[def.axis_a_field]` and `record.data[def.axis_b_field]`
 * as TEXT, then performs a single PK scan on choros.matrix_lookup_cell.
 *
 * Returns `{ ok: true, value: number | null }`:
 *   - number if a matching cell exists.
 *   - null if either axis field is absent on the record, or no cell matches.
 *
 * The lookup is O(1): the PK (tenant_id, table_id, axis_a_value, axis_b_value)
 * is directly indexed. No GROUP BY, no subqueries, no recursion.
 *
 * @param client     pg client inside an ALREADY-OPEN tenant-scoped tx.
 * @param tenantId   tenant UUID (must match the GUC already set).
 * @param recordData the record's data JSONB (already fetched by the caller).
 * @param def        parsed MatrixLookupFieldDef from the registry's schema.
 */
export async function computeMatrixLookupValue(
  client: pg.PoolClient | pg.Client,
  tenantId: string,
  recordData: Record<string, unknown>,
  def: MatrixLookupFieldDef,
): Promise<DerivedFieldResult> {
  // Extract axis values from the record's data.
  const axisA = recordData[def.axis_a_field];
  const axisB = recordData[def.axis_b_field];

  // If either axis value is missing/null, no lookup is possible → null.
  if (axisA === null || axisA === undefined || axisB === null || axisB === undefined) {
    return { ok: true, value: null };
  }

  // Cast to string for the lookup (enum values are text; numbers become text).
  const axisAStr = String(axisA);
  const axisBStr = String(axisB);

  try {
    const res = await client.query<{ numeric_value: string | null }>(
      `SELECT numeric_value
         FROM choros.matrix_lookup_cell
        WHERE tenant_id    = $1
          AND table_id     = $2
          AND axis_a_value = $3
          AND axis_b_value = $4
        LIMIT 1`,
      [tenantId, def.table_id, axisAStr, axisBStr],
    );
    const raw = res.rows[0]?.numeric_value ?? null;
    const value = raw === null ? null : Number(raw);
    return { ok: true, value: isNaN(value!) ? null : value };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `matrix-lookup query failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// computeAllDerivedFields — batch compute for all derived specs on a record
// ---------------------------------------------------------------------------

/**
 * Compute all derived fields for a single record.
 *
 * Iterates the `derivedSpecs` array (extracted by extractDerivedFields from
 * the registry_def's record_schema) and computes each field's value using
 * the appropriate compute function. Results are collected into a DerivedFieldMap.
 *
 * Errors per field are swallowed into null (a corrupt annotation or a DB cast
 * failure should not crash the whole record read). The caller should log
 * errors if monitoring is needed.
 *
 * @param client      pg client inside an ALREADY-OPEN tenant-scoped tx.
 * @param tenantId    tenant UUID.
 * @param parentRecordId  the UUID of the record being read.
 * @param recordData  the record's `data` JSONB (for matrix-lookup axis reads).
 * @param derivedSpecs  parsed DerivedFieldSpec[] from the registry schema.
 */
export async function computeAllDerivedFields(
  client: pg.PoolClient | pg.Client,
  tenantId: string,
  parentRecordId: string,
  recordData: Record<string, unknown>,
  derivedSpecs: DerivedFieldSpec[],
): Promise<DerivedFieldMap> {
  const result: DerivedFieldMap = {};

  await Promise.all(
    derivedSpecs.map(async (spec) => {
      let fieldResult: DerivedFieldResult;

      if (spec.kind === "rollup") {
        // child-records flavor — SQL GROUP BY over another registry's rows.
        fieldResult = await computeRollupValue(
          client,
          tenantId,
          parentRecordId,
          spec.def,
        );
      } else if (spec.kind === "rollup-embedded") {
        // embedded flavor — PURE in-memory aggregate over a collection array that
        // is already in this record's `data`. No DB access (no `client` use).
        fieldResult = { ok: true, value: computeEmbeddedRollup(spec.def, recordData) };
      } else {
        fieldResult = await computeMatrixLookupValue(
          client,
          tenantId,
          recordData,
          spec.def,
        );
      }

      result[spec.fieldKey] = fieldResult.ok ? fieldResult.value : null;
    }),
  );

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map RollupAggregate to the SQL aggregate function name.
 * These are SAFE compile-time constants — never interpolated from user input.
 */
const SAFE_AGG_FN: Readonly<Record<Exclude<import("../core/rollup-contract.js").RollupAggregate, "count">, string>> = {
  sum: "SUM",
  avg: "AVG",
  min: "MIN",
  max: "MAX",
};

/**
 * Escape a JSON key for safe interpolation into a `data->>'key'` expression.
 * JSON keys in Choros follow the JUEL variable name regex /^[A-Za-z_][A-Za-z0-9_]*$/
 * (enforced by validateBindingFields in binding-compat.ts). This sanitizer
 * enforces the same constraint, rejecting any key that doesn't match.
 *
 * RATIONALE: `data->>'key'` in PostgreSQL requires the key to be a string
 * literal in the SQL. Since the key comes from a trusted schema (not user
 * input at query time), we can safely interpolate it after this character-class
 * guard. The alternative (parameterised JSON path) is `data->$N` but that
 * syntax is not supported by all PG versions; ->> only accepts a literal.
 *
 * This function throws if the key contains unsafe characters — the caller
 * treats that as a corrupt schema annotation and returns null.
 *
 * @throws Error if the key contains characters outside [A-Za-z0-9_].
 */
function escapeJsonKey(key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(
      `rollup/matrix-lookup key "${key}" contains unsafe characters — ` +
        `must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
    );
  }
  return key; // safe: only [A-Za-z0-9_]
}
