/**
 * T-0580 [D-064 §A8 / К4] — Pure unit tests for formula-typecheck.ts
 *
 * No DB, no IO. Coverage:
 *  FT-1  type inference table (ADR §2.2): number⊕number, date±number, date−date,
 *        unary minus, and every FORBIDDEN date combination
 *  FT-2  field reference validation: unknown field, invalid operand type
 *  FT-3  fieldTypesFromRecordSchema: classifies every property shape correctly
 */

import { describe, it, expect } from "vitest";
import { typeCheckFormula, fieldTypesFromRecordSchema, type FormulaOperandType } from "../formula-typecheck.js";
import { parseFormula } from "../formula-parser.js";

function typeCheck(expr: string, fieldTypes: Record<string, FormulaOperandType>) {
  const parsed = parseFormula(expr);
  if (!parsed.ok) throw new Error(`fixture failed to parse: ${expr}`);
  return typeCheckFormula(parsed.ast, fieldTypes);
}

describe("typeCheckFormula — number ⊕ number (FT-1)", () => {
  it("number + number → number", () => {
    const r = typeCheck("a + b", { a: "number", b: "number" });
    expect(r).toEqual({ ok: true, result_type: "number" });
  });

  it("number - number → number", () => {
    const r = typeCheck("a - b", { a: "number", b: "number" });
    expect(r).toEqual({ ok: true, result_type: "number" });
  });

  it("number * number → number", () => {
    const r = typeCheck("a * b", { a: "number", b: "number" });
    expect(r).toEqual({ ok: true, result_type: "number" });
  });

  it("number / number → number", () => {
    const r = typeCheck("a / b", { a: "number", b: "number" });
    expect(r).toEqual({ ok: true, result_type: "number" });
  });

  it("a bare numeric literal (no field refs) → number", () => {
    const r = typeCheck("2 + 3 * 4", {});
    expect(r).toEqual({ ok: true, result_type: "number" });
  });

  it("unary minus on a number → number", () => {
    const r = typeCheck("-a", { a: "number" });
    expect(r).toEqual({ ok: true, result_type: "number" });
  });
});

describe("typeCheckFormula — date semantics (FT-1, ADR §2.2 table)", () => {
  it("date + number(days) → date", () => {
    const r = typeCheck("d + n", { d: "date", n: "number" });
    expect(r).toEqual({ ok: true, result_type: "date" });
  });

  it("date - number(days) → date", () => {
    const r = typeCheck("d - n", { d: "date", n: "number" });
    expect(r).toEqual({ ok: true, result_type: "date" });
  });

  it("date - date → number (days)", () => {
    const r = typeCheck("a - b", { a: "date", b: "date" });
    expect(r).toEqual({ ok: true, result_type: "number" });
  });

  it("date + date → TYPE ERROR (not in the closed table)", () => {
    const r = typeCheck("a + b", { a: "date", b: "date" });
    expect(r.ok).toBe(false);
  });

  it("date * number → TYPE ERROR", () => {
    const r = typeCheck("d * n", { d: "date", n: "number" });
    expect(r.ok).toBe(false);
  });

  it("date / number → TYPE ERROR", () => {
    const r = typeCheck("d / n", { d: "date", n: "number" });
    expect(r.ok).toBe(false);
  });

  it("number + date → TYPE ERROR (date must be on the left for +/-, per ADR closed table)", () => {
    const r = typeCheck("n + d", { d: "date", n: "number" });
    expect(r.ok).toBe(false);
  });

  it("unary minus on a date → TYPE ERROR", () => {
    const r = typeCheck("-d", { d: "date" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unary_minus_on_date");
  });

  it("(date - date) + number → date (chained: days-diff plus more days is still just a number + number)", () => {
    const r = typeCheck("(a - b) + n", { a: "date", b: "date", n: "number" });
    expect(r).toEqual({ ok: true, result_type: "number" });
  });

  it("date + (date - date) → date (a base date plus a computed day-count)", () => {
    const r = typeCheck("base + (a - b)", { base: "date", a: "date", b: "date" });
    expect(r).toEqual({ ok: true, result_type: "date" });
  });
});

describe("typeCheckFormula — field reference errors (FT-2)", () => {
  it("references an unknown field → error", () => {
    const r = typeCheck("unknown_field + 1", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("unknown_field");
      expect(r.field).toBe("unknown_field");
    }
  });

  it("references a field of an invalid operand type (string) → error", () => {
    const r = typeCheck("name + 1", { name: "other" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("invalid_operand_type");
      expect(r.field).toBe("name");
    }
  });

  it("the FIRST invalid reference short-circuits the check (left-to-right)", () => {
    const r = typeCheck("bad_field + 1", { bad_field: "other" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("bad_field");
  });
});

describe("fieldTypesFromRecordSchema (FT-3)", () => {
  it("classifies a plain number field as 'number'", () => {
    const schema = { type: "object", properties: { amount: { type: "number" } } };
    expect(fieldTypesFromRecordSchema(schema)).toEqual({ amount: "number" });
  });

  it("classifies a plain integer field as 'number'", () => {
    const schema = { type: "object", properties: { count: { type: "integer" } } };
    expect(fieldTypesFromRecordSchema(schema)).toEqual({ count: "number" });
  });

  it("classifies an x-money field as 'number'", () => {
    const schema = {
      type: "object",
      properties: { price: { type: "number", "x-money": { currency: "RUB" } } },
    };
    expect(fieldTypesFromRecordSchema(schema)).toEqual({ price: "number" });
  });

  it("classifies an x-date field as 'date'", () => {
    const schema = {
      type: "object",
      properties: { deadline: { type: "string", "x-date": true } },
    };
    expect(fieldTypesFromRecordSchema(schema)).toEqual({ deadline: "date" });
  });

  it("classifies an x-rollup field (child-records flavor) as 'number' (derived)", () => {
    const schema = {
      type: "object",
      properties: {
        total: {
          type: "number",
          "x-rollup": { source_registry_id: "a0000000-0000-0000-0000-000000000001", ref_field: "p", aggregate: "sum", value_field: "v" },
        },
      },
    };
    expect(fieldTypesFromRecordSchema(schema)).toEqual({ total: "number" });
  });

  it("classifies an x-rollup field (embedded flavor) as 'number' (derived)", () => {
    const schema = {
      type: "object",
      properties: {
        total: { type: "number", "x-rollup": { source: "lines", op: "sum", value_field: "price" } },
      },
    };
    expect(fieldTypesFromRecordSchema(schema)).toEqual({ total: "number" });
  });

  it("classifies an x-matrix-lookup field as 'number' (derived)", () => {
    const schema = {
      type: "object",
      properties: {
        rate: {
          type: "number",
          "x-matrix-lookup": { table_id: "a0000000-0000-0000-0000-000000000001", axis_a_field: "a", axis_b_field: "b" },
        },
      },
    };
    expect(fieldTypesFromRecordSchema(schema)).toEqual({ rate: "number" });
  });

  it("classifies an x-formula field (result_type:number) as 'number'", () => {
    const schema = {
      type: "object",
      properties: { itogo: { type: "number", "x-formula": { expr: "a+b", result_type: "number" } } },
    };
    expect(fieldTypesFromRecordSchema(schema)).toEqual({ itogo: "number" });
  });

  it("classifies an x-formula field (result_type:date) as 'date'", () => {
    const schema = {
      type: "object",
      properties: {
        deadline: { type: "string", "x-formula": { expr: "start + 30", result_type: "date" }, "x-date": true },
      },
    };
    expect(fieldTypesFromRecordSchema(schema)).toEqual({ deadline: "date" });
  });

  it("classifies a plain string field (no x-date) as 'other'", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    expect(fieldTypesFromRecordSchema(schema)).toEqual({ name: "other" });
  });

  it("classifies a boolean field as 'other'", () => {
    const schema = { type: "object", properties: { flag: { type: "boolean" } } };
    expect(fieldTypesFromRecordSchema(schema)).toEqual({ flag: "other" });
  });

  it("classifies a relation field as 'other'", () => {
    const schema = {
      type: "object",
      properties: { ref: { type: "string", "x-relation": { target_registry_id: "x" } } },
    };
    expect(fieldTypesFromRecordSchema(schema)).toEqual({ ref: "other" });
  });

  it("classifies a multi-select (array) field as 'other'", () => {
    const schema = {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string", enum: ["a"] }, "x-multi-select": true } },
    };
    expect(fieldTypesFromRecordSchema(schema)).toEqual({ tags: "other" });
  });

  it("classifies a collection (array of objects) field as 'other'", () => {
    const schema = {
      type: "object",
      properties: { lines: { type: "array", items: { type: "object", properties: {} } } },
    };
    expect(fieldTypesFromRecordSchema(schema)).toEqual({ lines: "other" });
  });

  it("handles a schema with multiple mixed field types", () => {
    const schema = {
      type: "object",
      properties: {
        summa: { type: "number" },
        nds_rate: { type: "number" },
        data_podpisaniya: { type: "string", "x-date": true },
        vendor_name: { type: "string" },
        is_active: { type: "boolean" },
      },
    };
    expect(fieldTypesFromRecordSchema(schema)).toEqual({
      summa: "number",
      nds_rate: "number",
      data_podpisaniya: "date",
      vendor_name: "other",
      is_active: "other",
    });
  });

  it("returns an empty map for a non-object schema", () => {
    expect(fieldTypesFromRecordSchema(null)).toEqual({});
    expect(fieldTypesFromRecordSchema("not a schema")).toEqual({});
    expect(fieldTypesFromRecordSchema([])).toEqual({});
  });

  it("returns an empty map for a schema with no properties", () => {
    expect(fieldTypesFromRecordSchema({ type: "object" })).toEqual({});
  });
});
