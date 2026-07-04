/**
 * src/core/formula-schema-gate.ts — T-0580 [D-064 §A8 / К4]
 *
 * The AUTHORING-TIME validation gate for `x-formula` fields in a
 * registry_def.record_schema (FR-7). Called from the schema create/update
 * HTTP handlers (src/http/registry-defs.ts) BEFORE the schema is persisted —
 * this is what makes "save a cyclic/malformed/out-of-limits formula" fail
 * with a human-readable, field-attributed error instead of silently
 * persisting a formula that will only ever degrade to null at read time.
 *
 * CHECKS (FR-7, in order — each one that fails short-circuits with an error
 * naming the offending field):
 *   (a) syntax        — parseFormula (closed token alphabet, Pratt parser)
 *   (b) reference/type — typeCheckFormula (sibling field exists + allowed type;
 *                         number±number/date±days/date−date type table)
 *   (c) result_type match — the x-formula.result_type annotation the author
 *                         (or the web round-trip) declared must equal what the
 *                         type-checker actually infers (catches a stale/
 *                         tampered cache — "the annotation lied about its type")
 *   (d) acyclicity     — detectFormulaCycles over the WHOLE set of formula
 *                         fields in this schema (a cycle spanning several
 *                         fields, not just a self-reference, is caught here —
 *                         a single field's type-check has no visibility into
 *                         the graph shape)
 *   (e) limits         — length/depth/refs (NF-5) — parseFormula already
 *                         enforces these; surfaced here with the same
 *                         field-attributed error shape as the other checks.
 *
 * An EMPTY x-formula.expr, or a property carrying BOTH x-formula and
 * x-rollup, is likewise rejected (FR-7/AC-12) — mirrors extractDerivedFields'
 * mutual-exclusion skip, but as a HARD REJECTION here (extraction silently
 * skips a corrupt/ambiguous field at read time; authoring must not let one be
 * saved in the first place).
 *
 * Pure — no I/O. Only imports from src/core/ siblings (formula-contract,
 * formula-parser, formula-typecheck, formula-cycles).
 */

import { validateFormulaFieldDef } from "./formula-contract.js";
import { parseFormula } from "./formula-parser.js";
import { typeCheckFormula, fieldTypesFromRecordSchema } from "./formula-typecheck.js";
import { detectFormulaCycles, type FormulaGraphNode } from "./formula-cycles.js";

export interface FormulaSchemaGateError {
  readonly field: string;
  readonly message: string;
}

export type FormulaSchemaGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: FormulaSchemaGateError[] };

/**
 * Validate every `x-formula` field in `schema` (FR-7). Returns `{ok:true}` iff
 * the schema has zero formula fields OR every formula field passes ALL checks
 * (syntax, sibling-reference/type, result_type match, acyclicity, limits).
 *
 * @param schema  a candidate record_schema (already confirmed to be a plain
 *                object by the caller — this function is defensive about that
 *                too, returning `{ok:true}` for a non-object schema, since a
 *                malformed schema-as-a-whole is validateRecordSchemaDefinition's
 *                job to reject, not this gate's).
 */
export function validateFormulaSchemaGate(schema: unknown): FormulaSchemaGateResult {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return { ok: true }; // not this gate's concern — record-schema-validator handles shape
  }
  const props = (schema as Record<string, unknown>)["properties"];
  if (props === null || typeof props !== "object" || Array.isArray(props)) {
    return { ok: true };
  }
  const properties = props as Record<string, unknown>;
  const fieldTypes = fieldTypesFromRecordSchema(schema);

  const errors: FormulaSchemaGateError[] = [];
  const graphNodes: FormulaGraphNode[] = [];

  for (const [fieldKey, rawDef] of Object.entries(properties)) {
    if (rawDef === null || typeof rawDef !== "object" || Array.isArray(rawDef)) continue;
    const pd = rawDef as Record<string, unknown>;
    const xFormula = pd["x-formula"];
    if (xFormula === undefined) continue;

    // FR-7 / AC-12: x-formula + x-rollup on the SAME property is invalid —
    // reject outright (extraction silently skips this at read time; authoring
    // must not let it be persisted).
    if (pd["x-rollup"] !== undefined) {
      errors.push({
        field: fieldKey,
        message: "a field cannot carry both x-formula and x-rollup (choose one mode: Формула или Агрегат)",
      });
      continue;
    }

    // (shape) expr non-empty ≤ FORMULA_MAX_LENGTH, result_type ∈ {number,date}.
    const shapeResult = validateFormulaFieldDef(xFormula);
    if (!shapeResult.ok) {
      errors.push({ field: fieldKey, message: shapeResult.message });
      continue;
    }
    const def = shapeResult.def;

    // (a) syntax — closed-alphabet lexer + Pratt parser; also re-enforces
    // NF-5 limits (length/depth/refs) at authoring time.
    const parsed = parseFormula(def.expr);
    if (!parsed.ok) {
      errors.push({ field: fieldKey, message: `formula syntax error: ${parsed.message}` });
      continue;
    }

    // (b) reference/type — every FIELD_REF exists + is an allowed operand
    // type; the ADR §2.2 number/date type table governs the operators.
    // fieldTypes intentionally includes THIS field's own declared type (a
    // formula field cannot use itself in a binary/unary position without
    // ALSO being a self-reference, which the cycle check below catches
    // separately — the type-checker's job here is purely type inference).
    const typeCheck = typeCheckFormula(parsed.ast, fieldTypes);
    if (!typeCheck.ok) {
      errors.push({ field: fieldKey, message: `formula type error: ${typeCheck.message}` });
      continue;
    }

    // (c) result_type match — the persisted annotation must equal what the
    // type-checker actually infers (catches a stale/tampered cache).
    if (typeCheck.result_type !== def.result_type) {
      errors.push({
        field: fieldKey,
        message:
          `formula result_type mismatch: declared "${def.result_type}" but the expression ` +
          `evaluates to type "${typeCheck.result_type}"`,
      });
      continue;
    }

    graphNodes.push({ fieldKey, ast: parsed.ast });
  }

  // (d) acyclicity — over the WHOLE set of formula fields that individually
  // passed (a-c) above. A field that already failed (a-c) is excluded from
  // the graph (its error is already reported; no point also reporting a
  // spurious cycle through a field that isn't even syntactically valid).
  if (graphNodes.length > 0) {
    const cycleCheck = detectFormulaCycles(graphNodes);
    if (!cycleCheck.ok) {
      errors.push({
        field: cycleCheck.cycle[0] ?? "",
        message: `formula fields form a cycle: ${cycleCheck.cycle.join(" → ")}`,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}
