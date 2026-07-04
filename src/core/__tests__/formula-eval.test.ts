/**
 * T-0580 [D-064 §A8 / К4] — Pure unit tests for formula-eval.ts
 *
 * No DB, no IO. Coverage:
 *  FE-1  arithmetic (AC-3): NDS example, revenue-cost, priority, parens, unary minus
 *  FE-2  date semantics (AC-4): date+N, date-date; date+date/date*2/date/2 → null at runtime
 *  FE-3  errors (AC-5): null-operand propagation, div-by-zero, non-numeric operand
 *  FE-4  security: __proto__/constructor field refs resolve to null (hasOwnProperty guard),
 *        never walk the prototype chain
 *  FE-5  limits (AC-8): a corrupt/overly-deep AST degrades to null, not a stack overflow
 */

import { describe, it, expect } from "vitest";
import { evalFormula } from "../formula-eval.js";
import { parseFormula, type FormulaAst } from "../formula-parser.js";

/** Convenience: parse (must succeed) and evaluate against scope. */
function evalExpr(expr: string, scope: Record<string, unknown>): number | string | null {
  const parsed = parseFormula(expr);
  if (!parsed.ok) throw new Error(`test fixture formula failed to parse: ${expr} (${parsed.message})`);
  return evalFormula(parsed.ast, scope);
}

describe("evalFormula — arithmetic (FE-1, AC-3)", () => {
  it("100000 * (1 + 0.2) → 120000 (the ADR NDS example)", () => {
    expect(evalExpr("summa * (1 + nds_rate)", { summa: 100000, nds_rate: 0.2 })).toBe(120000);
  });

  it("revenue - cost at {revenue:500, cost:200} → 300", () => {
    expect(evalExpr("revenue - cost", { revenue: 500, cost: 200 })).toBe(300);
  });

  it("2 + 3 * 4 → 14 (priority)", () => {
    expect(evalExpr("2 + 3 * 4", {})).toBe(14);
  });

  it("(2 + 3) * 4 → 20 (parens override priority)", () => {
    expect(evalExpr("(2 + 3) * 4", {})).toBe(20);
  });

  it("-a + b at {a:5, b:12} → 7 (unary minus)", () => {
    expect(evalExpr("-a + b", { a: 5, b: 12 })).toBe(7);
  });

  it("money-typed operand (plain JS number) participates as a number", () => {
    expect(evalExpr("price * qty", { price: 199.99, qty: 3 })).toBeCloseTo(599.97, 5);
  });

  it("a numeric-looking STRING operand (e.g. from a coerced JSONB read) still coerces to number", () => {
    expect(evalExpr("a + b", { a: "10", b: "5" })).toBe(15);
  });
});

describe("evalFormula — date semantics (FE-2, AC-4)", () => {
  it('date("2026-07-01") + 30 → "2026-07-31"', () => {
    expect(evalExpr("start_date + 30", { start_date: "2026-07-01" })).toBe("2026-07-31");
  });

  it('date("2026-07-31") - date("2026-07-01") → 30', () => {
    expect(
      evalExpr("end_date - start_date", { end_date: "2026-07-31", start_date: "2026-07-01" }),
    ).toBe(30);
  });

  it("date - N(days) → an earlier date", () => {
    expect(evalExpr("deadline - 10", { deadline: "2026-07-31" })).toBe("2026-07-21");
  });

  it("date + N crosses a month boundary correctly", () => {
    expect(evalExpr("d + 5", { d: "2026-06-28" })).toBe("2026-07-03");
  });

  it("date + N crosses a year boundary correctly", () => {
    expect(evalExpr("d + 10", { d: "2026-12-28" })).toBe("2027-01-07");
  });

  it("date + N truncates a fractional day count toward zero (floor)", () => {
    // 5.9 days truncates to 5 — FR-4: "N усекается к целому (floor к нулю)".
    expect(evalExpr("d + 5.9", { d: "2026-07-01" })).toBe("2026-07-06");
  });

  it("date + N truncates a NEGATIVE fractional day count toward zero", () => {
    expect(evalExpr("d + n", { d: "2026-07-10", n: -5.9 })).toBe("2026-07-05");
  });

  it("date − date → 0 for the same date", () => {
    expect(evalExpr("a - b", { a: "2026-07-01", b: "2026-07-01" })).toBe(0);
  });

  it("date − date → a NEGATIVE day count when the left date is earlier", () => {
    expect(evalExpr("a - b", { a: "2026-07-01", b: "2026-07-31" })).toBe(-30);
  });

  // date+date / date*number / date/number are TYPE ERRORS at authoring time
  // (formula-typecheck.ts rejects the schema before it is ever saved). If one
  // somehow reaches the runtime evaluator anyway (a corrupted/legacy schema
  // that bypassed the gate), evalFormula must degrade to null — never throw,
  // never produce a nonsensical numeric/string value.
  it("a date AST node built directly (bypassing the type-checker) for date+date degrades to null at runtime", () => {
    const dateRef = (field: string): FormulaAst => ({ kind: "ref", field });
    const forcedAst: FormulaAst = { kind: "binary", op: "+", left: dateRef("a"), right: dateRef("b") };
    expect(evalFormula(forcedAst, { a: "2026-07-01", b: "2026-07-02" })).toBeNull();
  });

  it("a date*number AST forced past the type-checker degrades to null at runtime", () => {
    const forcedAst: FormulaAst = {
      kind: "binary",
      op: "*",
      left: { kind: "ref", field: "a" },
      right: { kind: "num", value: 2 },
    };
    expect(evalFormula(forcedAst, { a: "2026-07-01" })).toBeNull();
  });

  it("an invalid calendar date (e.g. Feb 30) is treated as unparseable → null", () => {
    expect(evalExpr("d + 1", { d: "2026-02-30" })).toBeNull();
  });
});

describe("evalFormula — errors (FE-3, AC-5)", () => {
  it("a null field operand makes the WHOLE expression null (never 0)", () => {
    expect(evalExpr("a + b", { a: 5, b: null })).toBeNull();
  });

  it("an undefined (absent) field operand makes the WHOLE expression null", () => {
    expect(evalExpr("a + b", { a: 5 })).toBeNull(); // b is absent entirely
  });

  it("null propagates through a deeper subexpression", () => {
    expect(evalExpr("(a + b) * c", { a: 1, b: null, c: 10 })).toBeNull();
  });

  it("division by zero → null (never Infinity)", () => {
    expect(evalExpr("a / b", { a: 10, b: 0 })).toBeNull();
  });

  it("division by zero is null even when the divisor is a computed zero", () => {
    expect(evalExpr("a / (b - b)", { a: 10, b: 5 })).toBeNull();
  });

  it("a non-numeric string operand in a numeric position → null", () => {
    expect(evalExpr("a + b", { a: "not-a-number", b: 5 })).toBeNull();
  });

  it("a boolean operand → null (not coerced to 0/1)", () => {
    expect(evalExpr("a + b", { a: true, b: 5 })).toBeNull();
  });

  it("an object operand → null", () => {
    expect(evalExpr("a + b", { a: { nested: 1 }, b: 5 })).toBeNull();
  });

  it("an array operand → null", () => {
    expect(evalExpr("a + b", { a: [1, 2], b: 5 })).toBeNull();
  });

  it("an empty-string operand → null (blank field, not zero)", () => {
    expect(evalExpr("a + b", { a: "", b: 5 })).toBeNull();
  });

  it("NaN/Infinity literals baked into a hand-built AST degrade to null, never leak out", () => {
    const forcedAst: FormulaAst = { kind: "num", value: Number.POSITIVE_INFINITY };
    expect(evalFormula(forcedAst, {})).toBeNull();
  });
});

describe("evalFormula — security: __proto__/constructor never walk the prototype chain (FE-4)", () => {
  it('a field named "__proto__" resolves to null when absent as an own property (never Object.prototype)', () => {
    expect(evalExpr("__proto__", {})).toBeNull();
  });

  it('a field named "constructor" resolves to null when absent as an own property', () => {
    expect(evalExpr("constructor", {})).toBeNull();
  });

  it('a field named "toString" resolves to null (inherited-but-not-own) even though {}.toString exists', () => {
    // {}.toString is a REAL function reachable via `scope.toString` — proving
    // the evaluator does NOT use bare property access is the point of this test.
    expect(evalExpr("toString", {})).toBeNull();
  });

  it('an explicit OWN property named "__proto__" (a plain data key, not the exotic accessor) IS resolved honestly', () => {
    // Object.defineProperty forces a genuine own data-property named
    // "__proto__" (a plain assignment via {"__proto__": ...} would instead set
    // the object's actual prototype — this is why defineProperty is used to
    // build the fixture). hasOwnProperty must find this precisely because it
    // check OWN properties — this proves the guard isn't "always reject
    // __proto__" but "resolve exactly like any other own key".
    const scope: Record<string, unknown> = {};
    Object.defineProperty(scope, "__proto__", { value: 7, enumerable: true, configurable: true });
    expect(evalExpr("__proto__", scope)).toBe(7);
  });

  it("hasOwnProperty itself as a field name does not get confused with the guard mechanism", () => {
    expect(evalExpr("hasOwnProperty", {})).toBeNull();
  });
});

describe("evalFormula — limits / defense-in-depth (FE-5, AC-8)", () => {
  it("a maliciously deep hand-built AST (bypassing the parser's own depth guard) degrades to null, not a stack overflow", () => {
    // Build a right-leaning chain of 500 nested unary-minus nodes directly —
    // parseFormula would reject this at parse time (FORMULA_MAX_DEPTH), but
    // this test targets the EVALUATOR's own independent depth guard, in case
    // a corrupted/legacy AST (never re-parsed) reached evalFormula directly.
    let ast: FormulaAst = { kind: "num", value: 1 };
    for (let i = 0; i < 500; i++) {
      ast = { kind: "unary", op: "-", operand: ast };
    }
    expect(() => evalFormula(ast, {})).not.toThrow();
    expect(evalFormula(ast, {})).toBeNull();
  });

  it("a shallow, well-formed AST is unaffected by the depth guard", () => {
    const ast: FormulaAst = {
      kind: "binary",
      op: "+",
      left: { kind: "num", value: 1 },
      right: { kind: "num", value: 2 },
    };
    expect(evalFormula(ast, {})).toBe(3);
  });
});
