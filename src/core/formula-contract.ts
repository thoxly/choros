/**
 * src/core/formula-contract.ts — T-0580 [D-064 §A8 / К4]
 *
 * PURE TYPE CONTRACT for the `formula` flavor of a `computed` field (PD-18 /
 * PD-20 / ADR-T0580 §3). This is the `x-formula` extension annotation stored
 * inside `registry_def.record_schema` property definitions — the AUTHORING-TIME
 * contract that drives the in-memory scalar-formula evaluator.
 *
 * ──────────────────────────────────────────────────────────────────────
 * FORMULA — read-only scalar expression over THIS record's own fields
 * ──────────────────────────────────────────────────────────────────────
 * A `formula` field is a READ-ONLY value derived from an arithmetic/date
 * expression over sibling scalar fields of the SAME record (number/integer/
 * money/date fields, and other derived fields of the same record). It is NOT
 * stored in `record.data` (PD-20: derived values are computed, never
 * persisted); it is computed by the pure evaluator (formula-eval.ts) at read
 * time and overlaid onto the `derived` map (mirrors x-rollup / computed-
 * embedded — see rollup-contract.ts header).
 *
 *   x-formula: {
 *     expr:        "<source string>",   // e.g. "summa * (1 + nds_rate)"
 *     result_type: "number" | "date",    // cached type-checker output (§ADR 2.2)
 *   }
 *
 * MUTUAL EXCLUSION (ADR §2.3 / AC-12): a property carrying BOTH `x-formula`
 * and `x-rollup` is INVALID — the two flavors of `computed` never coexist on
 * the same field. `extractDerivedFields` (rollup-contract.ts) rejects such a
 * property rather than guessing a flavor.
 *
 * ──────────────────────────────────────────────────────────────────────
 * SCHEMA SLOT
 * ──────────────────────────────────────────────────────────────────────
 * Like rollup/matrix-lookup, a formula field uses schemaSlot = "derived":
 *   - is NOT present in `record.data` (never written)
 *   - is NEVER accepted in submit validation (form-submit-validator strips it)
 *   - is APPENDED to GET /api/records/:id responses as part of the `derived` map
 *   - is NOT part of AJV schema compilation (x-formula is stripped by
 *     stripXExtensions before compile — the same generic x-* convention as
 *     x-rollup/x-relation/x-money, T-0444/T-0510).
 *
 * PURITY: no pg, no node:*, no process.env, no network, no child_process, no
 * eval/Function/vm (NF-1/NF-3). Mirrors rollup-contract.ts / cross-app-ref.ts.
 */

// ---------------------------------------------------------------------------
// FormulaFieldDef — the x-formula annotation on a record_schema property
// ---------------------------------------------------------------------------

/** The two result types a v1 scalar formula can produce (ADR §2.2). */
export type FormulaResultType = "number" | "date";

/**
 * The `x-formula` extension stored in a record_schema property definition.
 * Parsed from `record_schema.properties.<fieldKey>["x-formula"]`.
 *
 * Invariants (enforced by validateFormulaFieldDef):
 *   - expr is a non-empty string, at most FORMULA_MAX_LENGTH characters (NF-5).
 *   - result_type is "number" or "date".
 */
export interface FormulaFieldDef {
  /** The source expression string (source of truth; re-parsed on each compute). */
  readonly expr: string;
  /** The type-checker's cached output type (ADR §2.2 table) — number or date. */
  readonly result_type: FormulaResultType;
}

// ---------------------------------------------------------------------------
// Limits (NF-5 — DoS defense-in-depth; enforced at authoring AND at compute)
// ---------------------------------------------------------------------------

/** Maximum source-string length for a formula expression (NF-5). */
export const FORMULA_MAX_LENGTH = 500;

/** Maximum AST depth (parser recursion / tree-walk) for a formula (NF-5). */
export const FORMULA_MAX_DEPTH = 32;

/** Maximum number of distinct field references (FIELD_REF) in one formula (NF-5). */
export const FORMULA_MAX_REFS = 32;

// ---------------------------------------------------------------------------
// Validation helpers — pure, no I/O
// ---------------------------------------------------------------------------

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isFormulaResultType(v: unknown): v is FormulaResultType {
  return v === "number" || v === "date";
}

export type FormulaFieldDefError =
  | "expr_missing_or_empty"
  | "expr_too_long"
  | "result_type_missing_or_invalid";

export type FormulaFieldDefResult =
  | { ok: true; def: FormulaFieldDef }
  | { ok: false; error: FormulaFieldDefError; message: string };

/**
 * Validate and parse an `x-formula` annotation from a raw property definition.
 * Returns the parsed FormulaFieldDef or a typed error. Mirrors
 * validateRollupFieldDef (rollup-contract.ts).
 *
 * This is a SHAPE check only (expr non-empty string ≤ FORMULA_MAX_LENGTH,
 * result_type ∈ {number,date}) — it does NOT parse or type-check `expr` itself;
 * that is parseFormula/typeCheckFormula's job (formula-parser.ts /
 * formula-typecheck.ts), invoked separately by the schema-save gate (FR-7).
 *
 * Pure — no I/O.
 *
 * @param raw   the raw `x-formula` value from a JSON Schema property definition.
 */
export function validateFormulaFieldDef(raw: unknown): FormulaFieldDefResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: "expr_missing_or_empty",
      message: "x-formula must be a plain object",
    };
  }
  const obj = raw as Record<string, unknown>;

  if (!isNonEmptyString(obj["expr"])) {
    return {
      ok: false,
      error: "expr_missing_or_empty",
      message: "x-formula.expr must be a non-empty string",
    };
  }
  const expr = obj["expr"] as string;

  if (expr.length > FORMULA_MAX_LENGTH) {
    return {
      ok: false,
      error: "expr_too_long",
      message: `x-formula.expr must be at most ${FORMULA_MAX_LENGTH} characters`,
    };
  }

  if (!isFormulaResultType(obj["result_type"])) {
    return {
      ok: false,
      error: "result_type_missing_or_invalid",
      message: 'x-formula.result_type must be "number" or "date"',
    };
  }
  const result_type = obj["result_type"] as FormulaResultType;

  return { ok: true, def: { expr, result_type } };
}
