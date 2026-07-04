/**
 * T-0580 [D-064 §A8 / К4] — Pure unit tests for formula-parser.ts
 *
 * No DB, no IO. Coverage:
 *  FP-1  arithmetic: happy-path parses (numbers, refs, +-*÷, parens, unary minus)
 *  FP-2  priority/associativity shape of the returned AST (2+3*4 groups the *3*4 first)
 *  FP-3  limits: length > 500, AST depth > 32, > 32 refs → rejected
 *  FP-4  injection (AC-6): closed-alphabet lexer rejects every listed attack string
 *  FP-5  malformed syntax: unbalanced parens, trailing tokens, empty expression
 *  FP-6  astDepth / collectFieldRefs helpers
 */

import { describe, it, expect } from "vitest";
import { parseFormula, astDepth, collectFieldRefs, type FormulaAst } from "../formula-parser.js";
import { FORMULA_MAX_LENGTH, FORMULA_MAX_REFS } from "../formula-contract.js";

describe("parseFormula — arithmetic happy path (FP-1)", () => {
  it("parses a bare number literal", () => {
    const r = parseFormula("42");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ast).toEqual({ kind: "num", value: 42 });
  });

  it("parses a decimal number literal", () => {
    const r = parseFormula("0.2");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ast).toEqual({ kind: "num", value: 0.2 });
  });

  it("parses a bare field reference", () => {
    const r = parseFormula("summa");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ast).toEqual({ kind: "ref", field: "summa" });
  });

  it("parses field refs with underscores and digits", () => {
    const r = parseFormula("field_1_x");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ast).toEqual({ kind: "ref", field: "field_1_x" });
  });

  it("parses a simple binary sum", () => {
    const r = parseFormula("revenue - cost");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast).toEqual({
        kind: "binary",
        op: "-",
        left: { kind: "ref", field: "revenue" },
        right: { kind: "ref", field: "cost" },
      });
    }
  });

  it("parses unary minus", () => {
    const r = parseFormula("-a + b");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast).toEqual({
        kind: "binary",
        op: "+",
        left: { kind: "unary", op: "-", operand: { kind: "ref", field: "a" } },
        right: { kind: "ref", field: "b" },
      });
    }
  });

  it("parses parenthesized expressions", () => {
    const r = parseFormula("(2 + 3) * 4");
    expect(r.ok).toBe(true);
  });

  it("parses the ADR NDS example verbatim", () => {
    const r = parseFormula("summa * (1 + nds_rate)");
    expect(r.ok).toBe(true);
  });

  it("tolerates surrounding/interior whitespace", () => {
    const r = parseFormula("  a   +   b  ");
    expect(r.ok).toBe(true);
  });
});

describe("parseFormula — priority/associativity shape (FP-2)", () => {
  it("2 + 3 * 4 groups as 2 + (3 * 4) — * binds tighter than +", () => {
    const r = parseFormula("2 + 3 * 4");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ast = r.ast as Extract<FormulaAst, { kind: "binary" }>;
      expect(ast.kind).toBe("binary");
      expect(ast.op).toBe("+");
      expect(ast.left).toEqual({ kind: "num", value: 2 });
      expect(ast.right).toEqual({
        kind: "binary",
        op: "*",
        left: { kind: "num", value: 3 },
        right: { kind: "num", value: 4 },
      });
    }
  });

  it("(2 + 3) * 4 groups as (2 + 3) * 4 — parens override priority", () => {
    const r = parseFormula("(2 + 3) * 4");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ast = r.ast as Extract<FormulaAst, { kind: "binary" }>;
      expect(ast.op).toBe("*");
      expect(ast.left).toEqual({
        kind: "binary",
        op: "+",
        left: { kind: "num", value: 2 },
        right: { kind: "num", value: 3 },
      });
      expect(ast.right).toEqual({ kind: "num", value: 4 });
    }
  });

  it("a - b - c is left-associative: (a - b) - c", () => {
    const r = parseFormula("a - b - c");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ast = r.ast as Extract<FormulaAst, { kind: "binary" }>;
      expect(ast.op).toBe("-");
      expect(ast.left).toEqual({
        kind: "binary",
        op: "-",
        left: { kind: "ref", field: "a" },
        right: { kind: "ref", field: "b" },
      });
      expect(ast.right).toEqual({ kind: "ref", field: "c" });
    }
  });

  it("a / b / c is left-associative: (a / b) / c", () => {
    const r = parseFormula("a / b / c");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ast = r.ast as Extract<FormulaAst, { kind: "binary" }>;
      expect(ast.op).toBe("/");
      expect((ast.left as Extract<FormulaAst, { kind: "binary" }>).op).toBe("/");
    }
  });
});

describe("parseFormula — limits (FP-3, NF-5 / AC-8)", () => {
  it("rejects an expression longer than FORMULA_MAX_LENGTH", () => {
    const longExpr = "a" + " + 1".repeat(200); // well over 500 chars
    expect(longExpr.length).toBeGreaterThan(FORMULA_MAX_LENGTH);
    const r = parseFormula(longExpr);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("too_long");
  });

  it("accepts a long expression right up to (but not exceeding) FORMULA_MAX_LENGTH", () => {
    // A FLAT chain of numeric-literal additions (no field refs, no nested
    // parens) isolates the LENGTH limit from the separate max-refs and
    // max-depth limits (each covered by its own test above/below): the parser
    // is left-associative, so `1+1+1+...` builds a left-leaning tree whose
    // depth grows with term count, not exponentially — well under
    // FORMULA_MAX_DEPTH for a string capped at FORMULA_MAX_LENGTH chars.
    let expr = "1";
    while (expr.length + 2 <= FORMULA_MAX_LENGTH) expr += "+1";
    expect(expr.length).toBeLessThanOrEqual(FORMULA_MAX_LENGTH);
    expect(expr.length).toBeGreaterThan(FORMULA_MAX_LENGTH - 10); // close to the boundary
    const r = parseFormula(expr);
    expect(r.ok).toBe(true);
  });

  it("rejects a formula with more than FORMULA_MAX_REFS distinct field references", () => {
    const refs = Array.from({ length: FORMULA_MAX_REFS + 1 }, (_, i) => `f${i}`);
    const expr = refs.join("+");
    const r = parseFormula(expr);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("max_refs_exceeded");
  });

  it("accepts a formula with exactly FORMULA_MAX_REFS field references", () => {
    const refs = Array.from({ length: FORMULA_MAX_REFS }, (_, i) => `f${i}`);
    const expr = refs.join("+");
    const r = parseFormula(expr);
    expect(r.ok).toBe(true);
  });

  it("rejects a deeply nested parenthesized expression beyond FORMULA_MAX_DEPTH", () => {
    // Each level of nesting adds several recursive-descent frames (expr→term→
    // factor→primary), so a modest nesting count already exceeds depth 32.
    const deep = "(".repeat(40) + "a" + ")".repeat(40);
    const r = parseFormula(deep);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("max_depth_exceeded");
  });

  it("rejects the empty expression", () => {
    const r = parseFormula("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("empty_expression");
  });

  it("rejects a whitespace-only expression", () => {
    const r = parseFormula("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("empty_expression");
  });
});

describe("parseFormula — injection rejected (FP-4, AC-6, P0)", () => {
  // NOTE on "__proto__": AC-6 lists it among the strings a formula author must
  // never be able to weaponize. It is DELIBERATELY excluded from this
  // syntax-rejection list — as a BARE identifier it is lexically an ordinary
  // FIELD_REF (the grammar has no reserved-word table; see ADR §2.1 "process/
  // __proto__/constructor как идентификатор просто резолвятся в «нет такого
  // поля»"). The actual neutralization happens one layer down, in
  // formula-eval.ts's hasOwnProperty-guarded scope lookup (covered by its own
  // dedicated test below AND in formula-eval.test.ts) — this file's job is
  // only to prove the STRUCTURAL injection vectors (`.`, `;`, `$`, backticks,
  // quotes, brackets, braces) are unparseable.
  const attackStrings = [
    "process.exit(1)",
    "require('fs')",
    "constructor.constructor('return 1')()",
    "a; b",
    "${x}",
    "a.b",
    "eval('1')",
    "new Function('return 1')()",
    "`template${literal}`",
    "globalThis.process",
    "child_process.exec('ls')",
    "a[0]",
    "{a: 1}",
    "'single quoted'",
    '"double quoted"',
    "a,b",
    "a!b",
    "a:b",
  ];

  for (const attack of attackStrings) {
    it(`rejects "${attack}" as syntactically invalid (not executed)`, () => {
      const r = parseFormula(attack);
      expect(r.ok).toBe(false);
    });
  }

  it("__proto__ alone parses as an ORDINARY field ref (not a prototype access) — the reject above is for a.b's dot, not the bare identifier", () => {
    // __proto__ as a STANDALONE identifier is lexically a valid FIELD_REF (the
    // grammar has no reserved-word list) — it is formula-eval.ts's
    // hasOwnProperty-guarded lookup, not the parser, that neutralizes it at
    // runtime (see formula-eval.test.ts). This test documents that split of
    // responsibility precisely so a future reader does not "fix" the parser
    // to reject it and break the intentional two-layer defense.
    const r = parseFormula("__proto__");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ast).toEqual({ kind: "ref", field: "__proto__" });
  });
});

describe("parseFormula — malformed syntax (FP-5)", () => {
  it("rejects unbalanced (missing close) parens", () => {
    const r = parseFormula("(a + b");
    expect(r.ok).toBe(false);
  });

  it("rejects unbalanced (extra close) parens", () => {
    const r = parseFormula("a + b)");
    expect(r.ok).toBe(false);
  });

  it("rejects a trailing operator with nothing after it", () => {
    const r = parseFormula("a +");
    expect(r.ok).toBe(false);
  });

  it("rejects two operators in a row without a unary-minus explanation", () => {
    const r = parseFormula("a + * b");
    expect(r.ok).toBe(false);
  });

  it("rejects a malformed number with a trailing dot and no fractional digits", () => {
    const r = parseFormula("12. + a");
    expect(r.ok).toBe(false);
  });

  it("rejects two expressions with no operator between them", () => {
    const r = parseFormula("a b");
    expect(r.ok).toBe(false);
  });
});

describe("astDepth (FP-6)", () => {
  it("a bare literal/ref has depth 1", () => {
    const r = parseFormula("a");
    expect(r.ok).toBe(true);
    if (r.ok) expect(astDepth(r.ast)).toBe(1);
  });

  it("a binary expression has depth 2", () => {
    const r = parseFormula("a + b");
    expect(r.ok).toBe(true);
    if (r.ok) expect(astDepth(r.ast)).toBe(2);
  });

  it("nested parens increase depth", () => {
    const shallow = parseFormula("a + b");
    const deeper = parseFormula("(a + b) * c");
    expect(shallow.ok && deeper.ok).toBe(true);
    if (shallow.ok && deeper.ok) {
      expect(astDepth(deeper.ast)).toBeGreaterThan(astDepth(shallow.ast));
    }
  });
});

describe("collectFieldRefs (FP-6)", () => {
  it("collects every distinct field name referenced", () => {
    const r = parseFormula("a + b * a - c");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const refs = collectFieldRefs(r.ast).sort();
      expect(refs).toEqual(["a", "b", "c"]);
    }
  });

  it("returns an empty array for a formula with no field references", () => {
    const r = parseFormula("1 + 2 * 3");
    expect(r.ok).toBe(true);
    if (r.ok) expect(collectFieldRefs(r.ast)).toEqual([]);
  });
});
