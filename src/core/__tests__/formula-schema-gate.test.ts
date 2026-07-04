/**
 * T-0580 [D-064 §A8 / К4] — Pure unit tests for formula-schema-gate.ts (FR-7, AC-7)
 *
 * No DB, no IO. Coverage:
 *  FG-1  valid schemas pass (single formula, chained formulas, formula+rollup coexisting
 *        on DIFFERENT fields, formula referencing a rollup field)
 *  FG-2  reference/type errors: unknown field, invalid operand type
 *  FG-3  cycle rejection: 2-field cycle, self-reference
 *  FG-4  mutual exclusion: x-formula + x-rollup on the SAME field
 *  FG-5  empty formula rejected
 *  FG-6  result_type mismatch rejected
 */

import { describe, it, expect } from "vitest";
import { validateFormulaSchemaGate } from "../formula-schema-gate.js";

describe("validateFormulaSchemaGate — valid schemas (FG-1)", () => {
  it("a schema with no x-formula fields at all passes trivially", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    expect(validateFormulaSchemaGate(schema)).toEqual({ ok: true });
  });

  it("a single valid formula field passes", () => {
    const schema = {
      type: "object",
      properties: {
        summa: { type: "number" },
        nds_rate: { type: "number" },
        itogo: { type: "number", "x-formula": { expr: "summa * (1 + nds_rate)", result_type: "number" } },
      },
    };
    expect(validateFormulaSchemaGate(schema)).toEqual({ ok: true });
  });

  it("a valid date-formula field passes", () => {
    const schema = {
      type: "object",
      properties: {
        start_date: { type: "string", "x-date": true },
        term_days: { type: "number" },
        deadline: {
          type: "string",
          "x-formula": { expr: "start_date + term_days", result_type: "date" },
          "x-date": true,
        },
      },
    };
    expect(validateFormulaSchemaGate(schema)).toEqual({ ok: true });
  });

  it("chained formulas (b references a) with no cycle pass", () => {
    const schema = {
      type: "object",
      properties: {
        base: { type: "number" },
        a: { type: "number", "x-formula": { expr: "base + 1", result_type: "number" } },
        b: { type: "number", "x-formula": { expr: "a + 1", result_type: "number" } },
      },
    };
    expect(validateFormulaSchemaGate(schema)).toEqual({ ok: true });
  });

  it("formula and rollup can coexist on DIFFERENT fields of the same schema", () => {
    const schema = {
      type: "object",
      properties: {
        lines: { type: "array", items: { type: "object", properties: { price: { type: "number" } } } },
        total: { type: "number", "x-rollup": { source: "lines", op: "sum", value_field: "price" } },
        nds_rate: { type: "number" },
        itogo: { type: "number", "x-formula": { expr: "total * (1 + nds_rate)", result_type: "number" } },
      },
    };
    expect(validateFormulaSchemaGate(schema)).toEqual({ ok: true });
  });

  it("a formula may reference a rollup-derived field (both are 'number' operands)", () => {
    const schema = {
      type: "object",
      properties: {
        lines: { type: "array", items: { type: "object", properties: { price: { type: "number" } } } },
        total: { type: "number", "x-rollup": { source: "lines", op: "sum", value_field: "price" } },
        margin_pct: { type: "number" },
        margin: { type: "number", "x-formula": { expr: "total * margin_pct", result_type: "number" } },
      },
    };
    expect(validateFormulaSchemaGate(schema)).toEqual({ ok: true });
  });
});

describe("validateFormulaSchemaGate — reference/type errors (FG-2)", () => {
  it("rejects a formula referencing a non-existent sibling field", () => {
    const schema = {
      type: "object",
      properties: {
        itogo: { type: "number", "x-formula": { expr: "does_not_exist + 1", result_type: "number" } },
      },
    };
    const r = validateFormulaSchemaGate(schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]?.field).toBe("itogo");
      expect(r.errors[0]?.message).toMatch(/unknown field/i);
    }
  });

  it("rejects a formula referencing a field of an invalid type (string)", () => {
    const schema = {
      type: "object",
      properties: {
        vendor_name: { type: "string" },
        itogo: { type: "number", "x-formula": { expr: "vendor_name + 1", result_type: "number" } },
      },
    };
    const r = validateFormulaSchemaGate(schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.field).toBe("itogo");
  });

  it("rejects a formula referencing a relation field", () => {
    const schema = {
      type: "object",
      properties: {
        vendor_ref: { type: "string", "x-relation": { target_registry_id: "x" } },
        itogo: { type: "number", "x-formula": { expr: "vendor_ref + 1", result_type: "number" } },
      },
    };
    expect(validateFormulaSchemaGate(schema).ok).toBe(false);
  });

  it("reports MULTIPLE independent formula-field errors together", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "number", "x-formula": { expr: "missing_1 + 1", result_type: "number" } },
        b: { type: "number", "x-formula": { expr: "missing_2 + 1", result_type: "number" } },
      },
    };
    const r = validateFormulaSchemaGate(schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(2);
      const fields = r.errors.map((e) => e.field).sort();
      expect(fields).toEqual(["a", "b"]);
    }
  });
});

describe("validateFormulaSchemaGate — cycle rejection (FG-3, AC-7)", () => {
  it("rejects a 2-field cycle: a=b+1, b=a+1", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "number", "x-formula": { expr: "b + 1", result_type: "number" } },
        b: { type: "number", "x-formula": { expr: "a + 1", result_type: "number" } },
      },
    };
    const r = validateFormulaSchemaGate(schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.message.toLowerCase().includes("cycle"))).toBe(true);
    }
  });

  it("rejects a self-referencing formula: a=a+1", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "number", "x-formula": { expr: "a + 1", result_type: "number" } },
      },
    };
    const r = validateFormulaSchemaGate(schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.message.toLowerCase().includes("cycle"))).toBe(true);
  });

  it("rejects a longer 3-field cycle", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "number", "x-formula": { expr: "b + 1", result_type: "number" } },
        b: { type: "number", "x-formula": { expr: "c + 1", result_type: "number" } },
        c: { type: "number", "x-formula": { expr: "a + 1", result_type: "number" } },
      },
    };
    expect(validateFormulaSchemaGate(schema).ok).toBe(false);
  });
});

describe("validateFormulaSchemaGate — mutual exclusion (FG-4, AC-12)", () => {
  it("rejects a field carrying BOTH x-formula and x-rollup", () => {
    const schema = {
      type: "object",
      properties: {
        lines: { type: "array", items: { type: "object", properties: { price: { type: "number" } } } },
        both: {
          type: "number",
          "x-formula": { expr: "1 + 1", result_type: "number" },
          "x-rollup": { source: "lines", op: "sum", value_field: "price" },
        },
      },
    };
    const r = validateFormulaSchemaGate(schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.field).toBe("both");
      expect(r.errors[0]?.message).toMatch(/x-formula.*x-rollup|x-rollup.*x-formula/i);
    }
  });
});

describe("validateFormulaSchemaGate — empty formula (FG-5)", () => {
  it("rejects an empty expr string", () => {
    const schema = {
      type: "object",
      properties: { itogo: { type: "number", "x-formula": { expr: "", result_type: "number" } } },
    };
    expect(validateFormulaSchemaGate(schema).ok).toBe(false);
  });

  it("rejects a whitespace-only expr string", () => {
    const schema = {
      type: "object",
      properties: { itogo: { type: "number", "x-formula": { expr: "   ", result_type: "number" } } },
    };
    expect(validateFormulaSchemaGate(schema).ok).toBe(false);
  });
});

describe("validateFormulaSchemaGate — result_type mismatch (FG-6)", () => {
  it("rejects a formula declared result_type:number whose expression actually type-checks as date", () => {
    const schema = {
      type: "object",
      properties: {
        d: { type: "string", "x-date": true },
        n: { type: "number" },
        bad: { type: "number", "x-formula": { expr: "d + n", result_type: "number" } },
      },
    };
    const r = validateFormulaSchemaGate(schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.message).toMatch(/result_type mismatch/i);
  });

  it("rejects a formula declared result_type:date whose expression actually type-checks as number", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
        bad: { type: "string", "x-formula": { expr: "a + b", result_type: "date" } },
      },
    };
    const r = validateFormulaSchemaGate(schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.message).toMatch(/result_type mismatch/i);
  });
});

describe("validateFormulaSchemaGate — defensive input handling", () => {
  it("returns ok:true for a non-object schema (not this gate's concern)", () => {
    expect(validateFormulaSchemaGate(null)).toEqual({ ok: true });
    expect(validateFormulaSchemaGate("not a schema")).toEqual({ ok: true });
  });

  it("returns ok:true for a schema with no properties key", () => {
    expect(validateFormulaSchemaGate({ type: "object" })).toEqual({ ok: true });
  });
});
