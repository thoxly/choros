/**
 * T-0580 [D-064 §A8 / К4] — FF-10 / AC-8: dedicated limits test file (NF-5).
 *
 * The parser and evaluator both enforce the SAME three limits at their own
 * layer (defense-in-depth, ADR §2.5): source length ≤ 500, AST depth ≤ 32,
 * field-ref count ≤ 32. This file is the single place both layers' behavior
 * under the limits is asserted TOGETHER (parseFormula's authoring-time
 * rejection AND evalFormula's runtime degrade-to-null on a hand-built AST
 * that bypasses parsing entirely) — formula-parser.test.ts and
 * formula-eval.test.ts each also cover their own slice; this file is the
 * ADR-named FF-10 artifact tying both together explicitly.
 */

import { describe, it, expect } from "vitest";
import { parseFormula } from "../formula-parser.js";
import { evalFormula } from "../formula-eval.js";
import { validateFormulaFieldDef, FORMULA_MAX_LENGTH } from "../formula-contract.js";
import type { FormulaAst } from "../formula-parser.js";

describe("FF-10 — authoring-time length limit", () => {
  it("parseFormula rejects a source string over FORMULA_MAX_LENGTH", () => {
    const over = "1" + "+1".repeat(300);
    expect(over.length).toBeGreaterThan(FORMULA_MAX_LENGTH);
    const r = parseFormula(over);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("too_long");
  });

  it("validateFormulaFieldDef (shape gate) also rejects expr over FORMULA_MAX_LENGTH", () => {
    const over = "1" + "+1".repeat(300);
    const r = validateFormulaFieldDef({ expr: over, result_type: "number" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("expr_too_long");
  });
});

describe("FF-10 — authoring-time AST depth limit", () => {
  it("parseFormula rejects deeply nested parentheses beyond FORMULA_MAX_DEPTH", () => {
    const deep = "(".repeat(50) + "1" + ")".repeat(50);
    const r = parseFormula(deep);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("max_depth_exceeded");
  });
});

describe("FF-10 — authoring-time field-ref count limit", () => {
  it("parseFormula rejects a formula with more than 32 field references", () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => `f${i}`).join("+");
    const r = parseFormula(tooMany);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("max_refs_exceeded");
  });

  it("parseFormula accepts exactly 32 field references", () => {
    const exact = Array.from({ length: 32 }, (_, i) => `f${i}`).join("+");
    const r = parseFormula(exact);
    expect(r.ok).toBe(true);
  });
});

describe("FF-10 — compute-time defense-in-depth: a corrupted/oversized AST degrades to null, never crashes", () => {
  it("evalFormula on a hand-built AST 1000 levels deep does not throw and returns null", () => {
    let ast: FormulaAst = { kind: "num", value: 1 };
    for (let i = 0; i < 1000; i++) {
      ast = { kind: "binary", op: "+", left: ast, right: { kind: "num", value: 1 } };
    }
    let result: number | string | null = 0;
    expect(() => {
      result = evalFormula(ast, {});
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it("evalFormula on a MODERATE hand-built AST (within the depth limit) computes normally", () => {
    // 10 levels of nesting is well under FORMULA_MAX_DEPTH=32 — the guard
    // must not clip a legitimately shallow-enough tree.
    let ast: FormulaAst = { kind: "num", value: 1 };
    for (let i = 0; i < 10; i++) {
      ast = { kind: "binary", op: "+", left: ast, right: { kind: "num", value: 1 } };
    }
    expect(evalFormula(ast, {})).toBe(11); // 1 + (1 * 10)
  });
});
