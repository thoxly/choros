/**
 * T-0580 [D-064 §A8 / К4] — Pure unit tests for formula-contract.ts
 *
 * No DB, no IO. Coverage: validateFormulaFieldDef shape checks (mirrors
 * validateRollupFieldDef's own test coverage in rollup-contract.test.ts).
 */

import { describe, it, expect } from "vitest";
import { validateFormulaFieldDef, FORMULA_MAX_LENGTH } from "../formula-contract.js";

describe("validateFormulaFieldDef", () => {
  it("rejects non-object input", () => {
    expect(validateFormulaFieldDef(null).ok).toBe(false);
    expect(validateFormulaFieldDef("a string").ok).toBe(false);
    expect(validateFormulaFieldDef(42).ok).toBe(false);
    expect(validateFormulaFieldDef([]).ok).toBe(false);
  });

  it("rejects a missing expr", () => {
    const r = validateFormulaFieldDef({ result_type: "number" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("expr_missing_or_empty");
  });

  it("rejects an empty-string expr", () => {
    const r = validateFormulaFieldDef({ expr: "", result_type: "number" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("expr_missing_or_empty");
  });

  it("rejects a non-string expr", () => {
    const r = validateFormulaFieldDef({ expr: 42, result_type: "number" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("expr_missing_or_empty");
  });

  it("rejects an expr longer than FORMULA_MAX_LENGTH", () => {
    const r = validateFormulaFieldDef({ expr: "a".repeat(FORMULA_MAX_LENGTH + 1), result_type: "number" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("expr_too_long");
  });

  it("accepts an expr exactly at FORMULA_MAX_LENGTH", () => {
    const r = validateFormulaFieldDef({ expr: "a".repeat(FORMULA_MAX_LENGTH), result_type: "number" });
    expect(r.ok).toBe(true);
  });

  it("rejects a missing result_type", () => {
    const r = validateFormulaFieldDef({ expr: "a + b" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("result_type_missing_or_invalid");
  });

  it("rejects an invalid result_type", () => {
    const r = validateFormulaFieldDef({ expr: "a + b", result_type: "string" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("result_type_missing_or_invalid");
  });

  it("accepts result_type 'number'", () => {
    const r = validateFormulaFieldDef({ expr: "a + b", result_type: "number" });
    expect(r).toEqual({ ok: true, def: { expr: "a + b", result_type: "number" } });
  });

  it("accepts result_type 'date'", () => {
    const r = validateFormulaFieldDef({ expr: "d + 30", result_type: "date" });
    expect(r).toEqual({ ok: true, def: { expr: "d + 30", result_type: "date" } });
  });

  it("ignores extraneous keys on the raw object (only expr/result_type are read)", () => {
    const r = validateFormulaFieldDef({ expr: "a + b", result_type: "number", bogus: "ignored" });
    expect(r.ok).toBe(true);
  });
});
