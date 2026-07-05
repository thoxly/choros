/**
 * src/core/visible-record-agg.ts — T-0632 (security, столп 4): pure Floor-1
 * aggregate accumulation over an ALREADY-READ-PDP-FILTERED row stream.
 *
 * THE DEFECT this closes (adversary finding T-0587, ADR-T0587 §1.1):
 * `src/http/report-page-render.ts::buildAggSql` used to compute
 * count/sum/avg/min/max/list as a RAW SQL aggregate over EVERY record in
 * a registry (`SELECT SUM(...) FROM choros.record WHERE tenant_id=$1 AND
 * registry_id=$2`), gated only by an APPLICATION-level read grant
 * (`checkReadGrant`) — never a RECORD-level READ-PDP check (`isRecordReadable`,
 * T-0570). An actor holding a narrow record-scope grant (sees only a subset
 * of a registry's rows) nonetheless received a SUM computed over rows they
 * have no READ grant on. ADR-T0587 §1.1 explicitly refused to reuse this path
 * for the analyst FOR THIS EXACT REASON, but did not fix report-page-render.ts
 * itself — this module (+ its wiring in report-page-render.ts) is that fix.
 *
 * THE INVARIANT THIS MODULE EXISTS TO PRESERVE (mirrors visible-aggregate.ts,
 * T-0587 §1.4): every function here is a PURE accumulator — it has NO
 * knowledge of, and NO opinion about, which rows are visible to the asker.
 * The CALLER (report-page-render.ts::renderFloor1) MUST invoke `accumulate`
 * only for rows that already passed `isRecordReadable(...) === true` — the
 * exact same discipline `registry-digest-dao.ts` already applies before
 * calling `accumulateNumeric` from `visible-aggregate.ts`. A row that fails
 * the READ-PDP predicate must never reach this module.
 *
 * WHY A NEW MODULE, NOT A DIRECT REUSE OF visible-aggregate.ts: that module
 * (T-0587 §1.4) was purpose-built for the analyst's per-registry numeric
 * digest — it has no notion of `group_by`, `filter`, or the `list` aggregate,
 * all of which are part of the Floor-1 metric vocabulary (ADR-T0121 §4) that
 * `buildAggSql` already supported via raw SQL. This module generalizes the
 * SAME safety discipline (pure accumulation over an already-filtered stream)
 * to the FULL Floor-1 vocab, so report-page-render.ts can drop its raw-SQL
 * aggregate entirely without losing any existing feature (group_by/filter/
 * list all keep working, just computed in application code post-filter).
 *
 * IO-FREE (D-064 / NF-1): no pg, no http, no fs, no env reads. Independently
 * unit-tested in complete isolation from Postgres.
 */

// ---------------------------------------------------------------------------
// Public vocab types — mirror report-page-render.ts's Floor1Metric shape
// (duplicated here, not imported, to keep this module IO-free / dependency-
// free of the HTTP layer; the two types are kept in lockstep by the
// report-page-render.ts call site, which constructs these from its own
// Floor1Metric before calling accumulate/finalize).
// ---------------------------------------------------------------------------

export type VisibleAggFunc = "count" | "sum" | "avg" | "min" | "max" | "list";

export interface VisibleFilterSpec {
  readonly fieldKey: string;
  readonly op: "=" | "!=" | "<" | ">" | "in";
  readonly value: unknown;
}

// ---------------------------------------------------------------------------
// matchesFilter — pure, in-memory equivalent of the SQL filter clause
// buildAggSql used to emit (`AND (data->>'field_key') op $N` / `... IN (...)`).
//
// Mirrors Postgres's `data->>'field_key'` semantics: the JSONB value is
// extracted AS TEXT, then compared. For numeric/comparison ops ("<", ">")
// this coerces both sides to Number (matching the SQL `::numeric`-free text
// comparison Postgres would NOT do — but buildAggSql's ORIGINAL filter clause
// compared `data->>'field_key' op $N` as TEXT, i.e. lexicographic for "<"/">"
// on the RAW extracted text, not numeric — this function reproduces that
// EXACT text-comparison semantics for byte-identical filtering behavior, not
// a "corrected" numeric comparison that would silently change which rows a
// pre-existing page_def matches).
// ---------------------------------------------------------------------------

export function matchesFilter(data: unknown, filter: VisibleFilterSpec): boolean {
  if (data === null || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  const raw = obj[filter.fieldKey];
  // data->>'key' in Postgres: NULL if the key is absent or the JSON value is
  // JSON null; otherwise the text representation of the value.
  const text = raw === undefined || raw === null ? null : jsonTextExtract(raw);

  switch (filter.op) {
    case "=":
      return text === toComparableText(filter.value);
    case "!=":
      // Postgres: NULL != anything is NULL (falsy) — a row with a missing/
      // null field never matches a "!=" filter either (three-valued logic).
      return text !== null && text !== toComparableText(filter.value);
    case "<":
      return text !== null && text < toComparableText(filter.value);
    case ">":
      return text !== null && text > toComparableText(filter.value);
    case "in": {
      if (text === null) return false;
      const arr = Array.isArray(filter.value) ? (filter.value as unknown[]) : [];
      return arr.some((v) => text === toComparableText(v));
    }
    default:
      return false;
  }
}

/** Postgres `->>'key'` text-extraction: strings pass through; everything else stringifies. */
function jsonTextExtract(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // objects/arrays: Postgres would emit their JSON text form; not a scenario
  // Floor-1 filters realistically hit (filters target scalar fields), but
  // stringify rather than throw so a malformed row never corrupts the whole
  // aggregate.
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function toComparableText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Per-group accumulator (numeric agg funcs)
// ---------------------------------------------------------------------------

interface NumericAcc {
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
}

function freshNumericAcc(): NumericAcc {
  return { count: 0, sum: 0, min: null, max: null };
}

function foldNumeric(acc: NumericAcc, n: number): void {
  acc.count += 1;
  acc.sum += n;
  acc.min = acc.min === null ? n : Math.min(acc.min, n);
  acc.max = acc.max === null ? n : Math.max(acc.max, n);
}

/** Extract a finite number from `data[fieldKey]`, mirroring `(data->>'k')::numeric`. */
function extractNumeric(data: unknown, fieldKey: string): number | null {
  if (data === null || typeof data !== "object") return null;
  const raw = (data as Record<string, unknown>)[fieldKey];
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "object") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Extract the text value used by `list`/`group_by` (mirrors `data->>'k'`). */
function extractText(data: unknown, fieldKey: string): string | null {
  if (data === null || typeof data !== "object") return null;
  const raw = (data as Record<string, unknown>)[fieldKey];
  if (raw === undefined || raw === null) return null;
  return jsonTextExtract(raw);
}

// ---------------------------------------------------------------------------
// VisibleAggregator — one instance per Floor-1 metric. Constructed ONCE,
// `fold` called once per ALREADY-VISIBLE row (post isRecordReadable + post
// filter), `finalize` called once at the end.
// ---------------------------------------------------------------------------

export interface FinalizedAggregate {
  /** Scalar result for a non-grouped metric (null when isGrouped). */
  result: unknown;
  /** Grouped results, ordered by first-seen group key (null when !isGrouped). */
  grouped: Array<{ group_key: string; result: unknown }> | null;
}

export class VisibleAggregator {
  private readonly agg: VisibleAggFunc;
  private readonly fieldKey: string;
  private readonly groupBy: string | undefined;
  private readonly isGrouped: boolean;

  // Non-grouped state.
  private scalarNumeric = freshNumericAcc();
  private scalarCount = 0;
  private scalarList: unknown[] = [];

  // Grouped state — Map preserves first-seen insertion order (matches SQL
  // GROUP BY's arbitrary-but-stable-per-scan order closely enough; Floor-1
  // consumers do not depend on a specific group ordering).
  private readonly groupNumeric = new Map<string, NumericAcc>();
  private readonly groupCount = new Map<string, number>();
  private readonly groupList = new Map<string, unknown[]>();

  constructor(agg: VisibleAggFunc, fieldKey: string, groupBy?: string) {
    this.agg = agg;
    this.fieldKey = fieldKey;
    this.groupBy = groupBy;
    this.isGrouped = groupBy !== undefined;
  }

  /**
   * Fold one ALREADY-VISIBLE (post isRecordReadable, post filter) record's
   * `data` into the accumulator. CALLER CONTRACT: never call this for a row
   * that has not already passed the READ-PDP predicate (mirrors
   * visible-aggregate.ts::accumulateNumeric's contract).
   */
  fold(data: unknown): void {
    const groupKey = this.isGrouped ? (extractText(data, this.groupBy!) ?? "") : undefined;

    switch (this.agg) {
      case "count": {
        if (this.isGrouped) {
          this.groupCount.set(groupKey!, (this.groupCount.get(groupKey!) ?? 0) + 1);
        } else {
          this.scalarCount += 1;
        }
        return;
      }
      case "list": {
        const raw =
          data !== null && typeof data === "object"
            ? (data as Record<string, unknown>)[this.fieldKey]
            : undefined;
        if (this.isGrouped) {
          const arr = this.groupList.get(groupKey!) ?? [];
          arr.push(raw ?? null);
          this.groupList.set(groupKey!, arr);
        } else {
          this.scalarList.push(raw ?? null);
        }
        return;
      }
      default: {
        // sum / avg / min / max — numeric.
        const n = extractNumeric(data, this.fieldKey);
        if (n === null) return; // non-numeric/missing values are silently skipped (mirrors ::numeric cast semantics under a not-strictly-enforced schema)
        if (this.isGrouped) {
          const acc = this.groupNumeric.get(groupKey!) ?? freshNumericAcc();
          foldNumeric(acc, n);
          this.groupNumeric.set(groupKey!, acc);
        } else {
          foldNumeric(this.scalarNumeric, n);
        }
      }
    }
  }

  private finalizeOne(acc: NumericAcc, count: number, list: unknown[]): unknown {
    switch (this.agg) {
      case "count":
        return count;
      case "list":
        return list;
      case "sum":
        return acc.count > 0 ? acc.sum : 0;
      case "avg":
        return acc.count > 0 ? acc.sum / acc.count : null;
      case "min":
        return acc.min;
      case "max":
        return acc.max;
      default:
        return null;
    }
  }

  finalize(): FinalizedAggregate {
    if (!this.isGrouped) {
      const result = this.finalizeOne(this.scalarNumeric, this.scalarCount, this.scalarList);
      return { result, grouped: null };
    }
    // Union of every group key that appeared in ANY of the three group maps
    // (count-only groups may never touch groupNumeric, etc.) — preserves the
    // first-seen order across whichever map recorded the key first.
    const order: string[] = [];
    const seen = new Set<string>();
    const noteKey = (k: string) => {
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    };
    for (const k of this.groupCount.keys()) noteKey(k);
    for (const k of this.groupNumeric.keys()) noteKey(k);
    for (const k of this.groupList.keys()) noteKey(k);

    const grouped = order.map((group_key) => {
      const acc = this.groupNumeric.get(group_key) ?? freshNumericAcc();
      const count = this.groupCount.get(group_key) ?? 0;
      const list = this.groupList.get(group_key) ?? [];
      return { group_key, result: this.finalizeOne(acc, count, list) };
    });
    return { result: null, grouped };
  }
}
