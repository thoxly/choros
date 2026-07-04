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
 *
 * DEPTH-GATE FIX (T-0580 REVIEW R-1, fix-forward): the "AST depth ≤ 32" limit
 * above is now measured ONCE as the REAL AST depth (astDepth(ast), the same
 * quantity formula-eval.ts's runtime guard walks — recursion only through
 * unary.operand / binary.left / binary.right), enforced as a single post-parse
 * check in parseFormula (formula-parser.ts). It is deliberately NOT the
 * grammatical recursive-descent FRAME count (expr→term→factor→primary, ~4
 * frames per value-nesting level) — that used to be the enforced quantity and
 * diverged from the runtime guard in both directions: a long flat operand
 * chain (many frames from the parseExpr/parseTerm loops, but real depth
 * growing 1:1 with operand count) could be ACCEPTED at authoring past real
 * depth 32 and then silently EVALUATE TO NULL at runtime (AC-8 violation);
 * conversely a handful of redundant parens (real depth 1, since a `(`-wrapped
 * primary adds no AST node) could be FALSELY REJECTED as over-depth. See the
 * "authoring/runtime depth agreement" describe block below for the positive
 * and boundary proofs.
 */

import { describe, it, expect } from "vitest";
import { parseFormula, astDepth } from "../formula-parser.js";
import { evalFormula } from "../formula-eval.js";
import { validateFormulaFieldDef, FORMULA_MAX_LENGTH, FORMULA_MAX_DEPTH } from "../formula-contract.js";
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

describe("FF-10 — authoring-time AST depth limit (behavioral, real AST depth — fix R-1)", () => {
  it("50 levels of redundant parens is NOT over-depth (real AST depth 1) — must be ACCEPTED and computed", () => {
    // A `(`-wrapped primary adds no AST node (formula-parser.ts parsePrimary's
    // `(` branch returns `inner` unchanged) — so no amount of pure
    // parenthesization around one literal deepens the real AST. The OLD
    // version of this test asserted the opposite ("rejects ... beyond
    // FORMULA_MAX_DEPTH" for 50 parens) by conflating grammatical
    // recursive-descent frame count with real AST depth — exactly the R-1
    // over-strictness REVIEW caught (`((((((((1))))))))`, 8 parens, was being
    // falsely rejected as max_depth_exceeded).
    const deep = "(".repeat(50) + "1" + ")".repeat(50);
    const r = parseFormula(deep);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(astDepth(r.ast)).toBe(1);
      expect(evalFormula(r.ast, {})).toBe(1);
    }
  });

  it("REVIEW's exact false-positive case: ((((((((1)))))))) (8 parens) is accepted and evaluates to 1", () => {
    const r = parseFormula("((((((((1))))))))");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(astDepth(r.ast)).toBe(1);
      expect(evalFormula(r.ast, {})).toBe(1);
    }
  });

  it("a formula whose REAL AST depth exceeds FORMULA_MAX_DEPTH is rejected at authoring with a human error", () => {
    // A left-associative flat `+` chain deepens by exactly 1 AST level per
    // operand — build one that is 1 operand PAST the limit.
    let expr = "1";
    for (let i = 0; i < FORMULA_MAX_DEPTH; i++) expr += "+1"; // FORMULA_MAX_DEPTH+1 operands total
    const r = parseFormula(expr);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("max_depth_exceeded");
      expect(typeof r.message).toBe("string");
      expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

describe("FF-10 — authoring/runtime depth AGREEMENT (fix R-1, the core invariant)", () => {
  // THE INVARIANT this task's fix restores: a formula ACCEPTED by
  // parseFormula (authoring time) must NEVER be silently nulled by
  // formula-eval.ts's depth guard at runtime (AC-8/NF-5) — there must be no
  // formula that is "accepted, then computes to null purely because of
  // depth". This block proves it end-to-end through the REAL call path
  // (parseFormula → evalFormula), not a hand-built AST.

  it("a flat sum of exactly FORMULA_MAX_DEPTH operands: accepted at authoring AND computes the correct number (not null)", () => {
    const operandCount = FORMULA_MAX_DEPTH;
    let expr = "price";
    for (let i = 1; i < operandCount; i++) expr += ` + ${i}`;
    const parsed = parseFormula(expr);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(astDepth(parsed.ast)).toBe(FORMULA_MAX_DEPTH);
    const result = evalFormula(parsed.ast, { price: 1000 });
    expect(result).not.toBeNull();
    const sumOfIncrements = ((operandCount - 1) * operandCount) / 2;
    expect(result).toBe(1000 + sumOfIncrements);
  });

  it("REVIEW's exact repro: price + 1 + ... + 33 (33 operands, 1 ref, 161 chars, well under 500/32-refs) is now REJECTED at authoring — never accepted-then-nulled", () => {
    let expr = "price";
    for (let i = 1; i <= 33; i++) expr += ` + ${i}`;
    expect(expr.length).toBeLessThan(FORMULA_MAX_LENGTH);
    const parsed = parseFormula(expr);
    // Before the fix: parsed.ok was TRUE here (grammatical depth ~4*34 was
    // measured against the wrong 32 threshold in a way that let this specific
    // shape slip through in the buggy build) and evalFormula(parsed.ast, ...)
    // returned null instead of 1561. After the fix: parseFormula rejects it
    // up front — the "accepted ⟹ computes" invariant holds by construction,
    // because there is no longer any accepted-but-too-deep AST to feed
    // evalFormula.
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toBe("max_depth_exceeded");
  });

  it("no formula exists that is accepted at authoring and returns null purely from the depth guard (property check over a range of operand counts)", () => {
    for (let operandCount = 1; operandCount <= 40; operandCount++) {
      let expr = "price";
      for (let i = 1; i < operandCount; i++) expr += ` + ${i}`;
      const parsed = parseFormula(expr);
      if (!parsed.ok) continue; // rejected at authoring — fine, nothing to check at runtime
      const result = evalFormula(parsed.ast, { price: 1000 });
      // If parseFormula accepted it, evalFormula must NEVER return null for
      // this well-typed, fully-resolved scope (price is present and numeric,
      // every other operand is a literal) — a null here could ONLY be the
      // depth guard firing on an accepted-but-too-deep AST, which is exactly
      // the bug this fix closes.
      expect(result).not.toBeNull();
    }
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
