/**
 * src/core/formula-typecheck.ts — T-0580 [D-064 §A8 / К4]
 *
 * Static type-checker for a parsed FormulaAst (ADR §2.2 / §3). Every AST node
 * has a static type from `{ number, date }`, inferred bottom-up by the CLOSED
 * table below. Runs at AUTHORING time (schema save, FR-7) — the runtime
 * evaluator (formula-eval.ts) additionally re-checks value types defensively
 * (a type-checked schema can still see a runtime value that doesn't match, e.g.
 * corrupt data — see formula-eval.ts's null-on-mismatch semantics, FR-8).
 *
 * TYPE TABLE (ADR §2.2, closed — no other rule is ever added in v1):
 *   number ⊕ number   (⊕ ∈ {+,-,*,/})  → number
 *   date   + number(days)              → date
 *   date   − number(days)              → date
 *   date   − date                      → number (days)
 *   unary  − number                    → number   (unary − date → error)
 *   any other date combination         → type error (authoring rejection)
 *
 * FIELD_REF resolution: each reference must name an EXISTING sibling field of
 * an ALLOWED type — number/integer/money (→ "number") or date (→ "date"), OR
 * another derived (rollup/matrix-lookup — always "number"; a formula referring
 * to ANOTHER formula field resolves to that formula's cached `result_type`).
 * `fieldTypes` is the caller-supplied map fieldKey → declared type; an absent
 * or unsupported-typed key is a type/reference error (FR-2/FR-7b).
 *
 * Pure — no I/O. Mirrors the purity discipline of rollup-contract.ts.
 */

import type { FormulaAst } from "./formula-parser.js";
import type { FormulaResultType } from "./formula-contract.js";

/**
 * The declared type of a sibling field, as seen by the type-checker.
 *   "number" — number/integer/money/rollup/matrix-lookup/formula(number)
 *   "date"   — date field, or formula(date)
 *   "other"  — any type NOT a valid formula operand (string/boolean/relation/
 *              collection/multi-select/person/url/email) — referencing one is
 *              a type error (FR-2).
 */
export type FormulaOperandType = "number" | "date" | "other";

export type TypeCheckFormulaError =
  | "unknown_field"
  | "invalid_operand_type"
  | "date_combination_not_allowed"
  | "unary_minus_on_date";

export type TypeCheckFormulaResult =
  | { ok: true; result_type: FormulaResultType }
  | { ok: false; error: TypeCheckFormulaError; message: string; field?: string };

/**
 * Type-check a parsed FormulaAst against a map of sibling field types.
 *
 * @param ast         a FormulaAst produced by parseFormula.
 * @param fieldTypes  fieldKey → FormulaOperandType for every field in the
 *                    record_schema this formula's field lives in (built by the
 *                    caller from record_schema.properties — see
 *                    fieldTypesFromRecordSchema below).
 */
export function typeCheckFormula(
  ast: FormulaAst,
  fieldTypes: Record<string, FormulaOperandType>,
): TypeCheckFormulaResult {
  const result = inferType(ast, fieldTypes);
  if (!result.ok) return result;
  return { ok: true, result_type: result.type };
}

type InferResult =
  | { ok: true; type: "number" | "date" }
  | { ok: false; error: TypeCheckFormulaError; message: string; field?: string };

function inferType(ast: FormulaAst, fieldTypes: Record<string, FormulaOperandType>): InferResult {
  switch (ast.kind) {
    case "num":
      return { ok: true, type: "number" };

    case "ref": {
      const declared = fieldTypes[ast.field];
      if (declared === undefined) {
        return {
          ok: false,
          error: "unknown_field",
          message: `formula references unknown field "${ast.field}"`,
          field: ast.field,
        };
      }
      if (declared === "other") {
        return {
          ok: false,
          error: "invalid_operand_type",
          message: `field "${ast.field}" has a type not valid as a formula operand (only number/money/date/derived fields are allowed)`,
          field: ast.field,
        };
      }
      return { ok: true, type: declared };
    }

    case "unary": {
      const operand = inferType(ast.operand, fieldTypes);
      if (!operand.ok) return operand;
      if (operand.type === "date") {
        return {
          ok: false,
          error: "unary_minus_on_date",
          message: "unary minus cannot be applied to a date value",
        };
      }
      return { ok: true, type: "number" };
    }

    case "binary": {
      const left = inferType(ast.left, fieldTypes);
      if (!left.ok) return left;
      const right = inferType(ast.right, fieldTypes);
      if (!right.ok) return right;

      // number ⊕ number → number (all four operators).
      if (left.type === "number" && right.type === "number") {
        return { ok: true, type: "number" };
      }

      // date + number(days) → date ; date - number(days) → date
      if (left.type === "date" && right.type === "number" && (ast.op === "+" || ast.op === "-")) {
        return { ok: true, type: "date" };
      }

      // date - date → number (days). NOTE: date + date and any date * / date
      // combination is NOT in this closed table → falls through to the
      // rejection below (ADR §2.2 "любая иная с date → ошибка типизации").
      if (left.type === "date" && right.type === "date" && ast.op === "-") {
        return { ok: true, type: "number" };
      }

      return {
        ok: false,
        error: "date_combination_not_allowed",
        message: `operator "${ast.op}" is not defined for operand types ${left.type} and ${right.type}`,
      };
    }

    default: {
      const _exhaustive: never = ast;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// fieldTypesFromRecordSchema — build the fieldTypes map the type-checker needs
// from a registry_def.record_schema (the same shape extractDerivedFields reads).
// ---------------------------------------------------------------------------

/**
 * Derive `Record<fieldKey, FormulaOperandType>` from a record_schema, so the
 * schema-save gate (FR-7) can type-check every formula field against its
 * siblings without the caller having to hand-build the map.
 *
 * Classification (ADR §2.2 / FR-2):
 *   - {type:"number"|"integer"} with no x-* discriminator            → "number"
 *   - {type:"number", "x-money":{...}}                               → "number" (T-0509)
 *   - {type:"number", "x-rollup":{...}} or {"x-matrix-lookup":{...}} → "number" (derived)
 *   - {type:"number", "x-formula":{result_type:"number"}}            → "number" (derived)
 *   - {type:"string", "x-date":true} (no x-formula)                  → "date"
 *   - {type:"string", "x-formula":{result_type:"date"}}              → "date" (derived)
 *   - everything else (string/boolean/relation/collection/multi-select/
 *     person/url/email, or a malformed x-formula/x-rollup)           → "other"
 *
 * Pure — no I/O.
 */
export function fieldTypesFromRecordSchema(schema: unknown): Record<string, FormulaOperandType> {
  const result: Record<string, FormulaOperandType> = {};
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return result;
  }
  const props = (schema as Record<string, unknown>)["properties"];
  if (props === null || typeof props !== "object" || Array.isArray(props)) {
    return result;
  }

  for (const [fieldKey, rawDef] of Object.entries(props as Record<string, unknown>)) {
    result[fieldKey] = classifyPropertyType(rawDef);
  }
  return result;
}

function classifyPropertyType(rawDef: unknown): FormulaOperandType {
  if (rawDef === null || typeof rawDef !== "object" || Array.isArray(rawDef)) {
    return "other";
  }
  const def = rawDef as Record<string, unknown>;
  const type = def["type"];

  // x-formula (this task's own annotation) — result_type is the operand type.
  const xFormula = def["x-formula"];
  if (xFormula !== null && typeof xFormula === "object" && !Array.isArray(xFormula)) {
    const resultType = (xFormula as Record<string, unknown>)["result_type"];
    if (resultType === "number" || resultType === "date") return resultType;
    return "other"; // malformed x-formula — not a usable operand
  }

  // x-rollup / x-matrix-lookup — derived numeric fields (always number, both
  // rollup flavors: child-records and embedded).
  if (def["x-rollup"] !== undefined || def["x-matrix-lookup"] !== undefined) {
    return type === "number" ? "number" : "other";
  }

  // x-date — a date-typed scalar field (T-0553).
  if (def["x-date"] !== undefined) {
    return type === "string" ? "date" : "other";
  }

  // x-money — a money field is a numeric scalar for arithmetic (T-0509).
  if (def["x-money"] !== undefined) {
    return type === "number" ? "number" : "other";
  }

  // Plain number/integer scalar (no x-* discriminator) — a valid operand.
  if (type === "number" || type === "integer") {
    return "number";
  }

  // string (no x-date), boolean, relation, collection, multi-select, person,
  // url, email — none of these are valid formula operands (FR-2/O-2).
  return "other";
}
