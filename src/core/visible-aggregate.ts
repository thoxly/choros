/**
 * src/core/visible-aggregate.ts — T-0587 (§1.4 ADR-T0587): pure numeric
 * aggregation over an ALREADY-READ-PDP-FILTERED row stream.
 *
 * THE INVARIANT THIS MODULE EXISTS TO PRESERVE (FR-2 / FF-2): every function
 * here is a pure accumulator — it has NO knowledge of, and NO opinion about,
 * which rows are visible to the asker. The CALLER (registry-digest-dao.ts)
 * MUST invoke `accumulateNumeric` only AFTER `isRecordReadable(...) === true`
 * for a given row — exactly the same branch that increments `visibleCount`.
 * A row that fails the READ-PDP predicate must never reach this module.
 *
 * IO-FREE (D-064 / NF-1): no pg, no http, no fs, no env reads. Testable in
 * complete isolation from Postgres — see src/core/__tests__/visible-aggregate.test.ts.
 *
 * GENERIC FIELD SELECTION (D-064): `pickNumericFieldKeys` derives which
 * fields are numeric from the registry's OWN record_schema (via the existing
 * `deriveFieldType` dictionary, field-type-dictionary.ts) — no field name is
 * hardcoded, no case-specific literal is introduced here or by any caller of
 * this module.
 *
 * BOUNDED (NF-5): `pickNumericFieldKeys` caps the returned field list at
 * `limit` — the caller (registry-digest-dao.ts) passes `numericFieldLimit`
 * (default 5). This module never iterates unboundedly over the schema; the
 * schema itself is a small, tenant-authored object, and the cap guards
 * against a pathological schema with hundreds of numeric properties from
 * ballooning the LLM context.
 */

import {
  deriveFieldType,
  type JsonSchemaProperty,
} from "./field-type-dictionary.js";

// ---------------------------------------------------------------------------
// Result / accumulator shapes
// ---------------------------------------------------------------------------

/**
 * Final per-field aggregate over the visible (READ-PDP-filtered) subset of
 * records in one registry. Fields with zero contributing values are dropped
 * by `finalizeNumeric` — they carry no information and would otherwise render
 * as a misleading `sum: 0` for a field nobody's visible records populated.
 */
export interface NumericFieldAggregate {
  readonly fieldKey: string;
  readonly fieldLabel: string;
  readonly count: number;
  readonly sum: number;
  readonly avg: number;
  readonly min: number;
  readonly max: number;
}

/**
 * Internal mutable accumulator for one numeric field. `min`/`max` start at
 * `null` (no contributing value seen yet) so the first finite value seeds
 * both without a sentinel-number hack (e.g. `Infinity`, which would leak into
 * `finalizeNumeric` if a field truly never receives a contribution).
 */
export interface NumericAccumulator {
  readonly fieldKey: string;
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
}

// ---------------------------------------------------------------------------
// initNumericAccumulators
// ---------------------------------------------------------------------------

/**
 * Create one zeroed accumulator per field key. Called ONCE per registry,
 * before the per-row scan begins.
 */
export function initNumericAccumulators(
  fieldKeys: readonly string[],
): Map<string, NumericAccumulator> {
  const accs = new Map<string, NumericAccumulator>();
  for (const fieldKey of fieldKeys) {
    accs.set(fieldKey, { fieldKey, count: 0, sum: 0, min: null, max: null });
  }
  return accs;
}

// ---------------------------------------------------------------------------
// accumulateNumeric
// ---------------------------------------------------------------------------

/**
 * Fold one ALREADY-VISIBLE record's `data` into the accumulators.
 *
 * CALLER CONTRACT (FR-2/FF-2): the caller MUST call this only for rows that
 * already passed `isRecordReadable(...) === true`. This function itself has
 * no way to enforce that — it trusts the caller's per-row loop ordering,
 * which is exactly why the ordering is covered by its own DAO-level test
 * (registry-digest-dao's per-row loop) in addition to this module's
 * pure-accumulation unit tests.
 *
 * Coercion: `Number(data[fieldKey])`. Values that are missing, `null`,
 * objects/arrays, or coerce to a non-finite number (`NaN`, `Infinity`) are
 * silently skipped — they neither increment `count` nor perturb `sum`/`min`/
 * `max`. A malformed/missing value in one record must not corrupt the
 * aggregate of all the others.
 */
export function accumulateNumeric(
  accs: Map<string, NumericAccumulator>,
  data: unknown,
  fieldKeys: readonly string[],
): void {
  if (data === null || typeof data !== "object") return;
  const obj = data as Record<string, unknown>;

  for (const fieldKey of fieldKeys) {
    const acc = accs.get(fieldKey);
    if (!acc) continue; // unknown key — defensive, should not happen.

    const raw = obj[fieldKey];
    if (raw === undefined || raw === null) continue;
    // Reject objects/arrays outright — Number({}) is NaN anyway, but this
    // guard makes the intent explicit and avoids Number([1,2]) surprises
    // (Number([5]) === 5 in JS — a single-element array must NOT silently
    // count as a numeric contribution).
    if (typeof raw === "object") continue;

    const n = Number(raw);
    if (!Number.isFinite(n)) continue;

    acc.count += 1;
    acc.sum += n;
    acc.min = acc.min === null ? n : Math.min(acc.min, n);
    acc.max = acc.max === null ? n : Math.max(acc.max, n);
  }
}

// ---------------------------------------------------------------------------
// finalizeNumeric
// ---------------------------------------------------------------------------

/**
 * Convert accumulators to the final result list. Fields with `count === 0`
 * (no visible record contributed a finite value) are DROPPED — not rendered
 * as a zero/blank aggregate, which would misleadingly imply "the sum across
 * visible records is definitely zero" rather than "no visible record had a
 * usable value for this field".
 *
 * `labels` maps fieldKey → human-readable label (JSON Schema `title`, falling
 * back to the raw key if absent) — supplied by the caller from the same
 * record_schema pass that produced `fieldKeys`.
 */
export function finalizeNumeric(
  accs: Map<string, NumericAccumulator>,
  labels: Map<string, string>,
): NumericFieldAggregate[] {
  const out: NumericFieldAggregate[] = [];
  for (const acc of accs.values()) {
    if (acc.count === 0) continue;
    out.push({
      fieldKey: acc.fieldKey,
      fieldLabel: labels.get(acc.fieldKey) ?? acc.fieldKey,
      count: acc.count,
      sum: acc.sum,
      avg: acc.sum / acc.count,
      min: acc.min as number,
      max: acc.max as number,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// pickNumericFieldKeys — generic numeric-field discovery from record_schema.
// ---------------------------------------------------------------------------

/**
 * Shape of a registry's `record_schema` column, as far as this module cares:
 * a JSON Schema object with a `properties` map. Anything else (missing,
 * malformed, non-object) yields an empty field list — never throws.
 */
interface RecordSchemaLike {
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
}

/**
 * Derive up to `limit` numeric field keys (+ their display labels) from a
 * registry's `record_schema`, using the SAME canonical `deriveFieldType`
 * dictionary the rest of the platform uses (form derivation, validation) —
 * NF-1: one resolver, not a second ad-hoc numeric-detection rule.
 *
 * D-064: no field name is hardcoded here — the field key comes from
 * `Object.keys(schema.properties)`, filtered generically by
 * `deriveFieldType(prop) === "number"`.
 *
 * Order: schema property insertion order (`Object.keys`), capped at `limit`.
 * Malformed/absent schema → `[]` (never throws — the caller degrades to "no
 * aggregates for this registry", not a hard failure).
 */
export function pickNumericFieldKeys(
  recordSchema: unknown,
  limit: number,
): Array<{ key: string; label: string }> {
  if (recordSchema === null || typeof recordSchema !== "object") return [];
  const schema = recordSchema as RecordSchemaLike;
  const properties = schema.properties;
  if (properties === null || typeof properties !== "object") return [];

  const out: Array<{ key: string; label: string }> = [];
  for (const key of Object.keys(properties)) {
    if (out.length >= Math.max(0, limit)) break;
    const prop = properties[key];
    if (prop === null || typeof prop !== "object") continue;
    if (deriveFieldType(prop) !== "number") continue;
    const label =
      typeof prop.title === "string" && prop.title.trim().length > 0
        ? prop.title.trim()
        : key;
    out.push({ key, label });
  }
  return out;
}
