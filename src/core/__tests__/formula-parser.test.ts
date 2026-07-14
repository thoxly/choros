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
import { evalFormula } from "../formula-eval.js";
import { FORMULA_MAX_LENGTH, FORMULA_MAX_DEPTH, FORMULA_MAX_REFS } from "../formula-contract.js";

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

  it("a long FLAT operand chain is governed by REAL AST depth, not source length (fix R-1)", () => {
    // CORRECTED (T-0580 REVIEW R-1 fix): a flat `1+1+1+...` chain is
    // LEFT-associative, so each `+` adds exactly ONE level of REAL AST depth
    // (binary.left nests one deeper each time) — depth grows 1:1 with operand
    // count, NOT "well under FORMULA_MAX_DEPTH" as this test previously
    // (incorrectly) asserted. A chain long enough to approach
    // FORMULA_MAX_LENGTH (500 chars, ~166 operands) has REAL AST depth ~166 —
    // far past FORMULA_MAX_DEPTH=32 — so it MUST be rejected at authoring,
    // exactly like any other over-depth formula. This is the authoring-time
    // half of the R-1 invariant: "accepted at authoring" ⟹ "computed at
    // runtime, never null-by-depth" — so a formula this deep must never be
    // accepted in the first place (previously it WAS wrongly accepted here,
    // and then silently evaluated to null at runtime — the exact bug REVIEW
    // caught).
    let expr = "1";
    while (expr.length + 2 <= FORMULA_MAX_LENGTH) expr += "+1";
    expect(expr.length).toBeLessThanOrEqual(FORMULA_MAX_LENGTH);
    const r = parseFormula(expr);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("max_depth_exceeded");
  });

  it("a flat operand chain right at the real AST-depth boundary is ACCEPTED and COMPUTES a number (fix R-1)", () => {
    // The authoring/runtime depth invariant, proven positively: build the
    // LONGEST flat `+` chain whose REAL astDepth is exactly FORMULA_MAX_DEPTH
    // (not a grammatical-frame count) — it must parse AND evaluate to a
    // correct number, never null-by-depth.
    const operandCount = FORMULA_MAX_DEPTH; // depth of a left-assoc chain of N operands is N
    let expr = "price";
    for (let i = 1; i < operandCount; i++) expr += ` + ${i}`;
    const r = parseFormula(expr);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(astDepth(r.ast)).toBe(FORMULA_MAX_DEPTH);
      const sumOfIncrements = ((operandCount - 1) * operandCount) / 2; // 1+2+...+(N-1)
      expect(evalFormula(r.ast, { price: 1000 })).toBe(1000 + sumOfIncrements);
    }
  });

  it("one operand past the real AST-depth boundary is REJECTED at authoring with a human error, never silently accepted (fix R-1)", () => {
    const operandCount = FORMULA_MAX_DEPTH + 1;
    let expr = "price";
    for (let i = 1; i < operandCount; i++) expr += ` + ${i}`;
    const r = parseFormula(expr);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("max_depth_exceeded");
      expect(r.message.length).toBeGreaterThan(0);
    }
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

  it("a modest wrap of redundant parens is NOT falsely rejected as over-depth (fix R-1)", () => {
    // CORRECTED (T-0580 REVIEW R-1 fix): a `(`-wrapped primary does not add
    // an AST node at all (parsePrimary's `(`-branch returns `inner` directly)
    // — so N levels of pure parenthesization around a single literal has REAL
    // AST depth 1, regardless of N. The OLD version of this test asserted
    // "(".repeat(40)+"a"+")".repeat(40) is rejected — that was measuring
    // grammatical recursion-descent FRAME count (~4 frames per paren level),
    // NOT real AST depth, and is exactly the false-positive REVIEW flagged:
    // `((((((((1))))))))` (8 parens) was being wrongly rejected as
    // "max_depth_exceeded" despite a real AST depth of 1. This is now backed
    // by the RECURSION_FRAME_GUARD anti-DoS backstop (a large multiple of
    // FORMULA_MAX_DEPTH) instead of the tight authoring limit, so a
    // reasonable number of redundant parens must be ACCEPTED.
    const wrapped = "(".repeat(8) + "1" + ")".repeat(8);
    const r = parseFormula(wrapped);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(astDepth(r.ast)).toBe(1);
      expect(evalFormula(r.ast, {})).toBe(1);
    }
  });

  it("a pathologically large paren count still hits the anti-DoS recursion backstop, not a stack overflow", () => {
    // The grammatical-frame anti-DoS guard (RECURSION_FRAME_GUARD, formula-parser.ts)
    // still exists to protect the JS call stack against an absurd input — this
    // is deliberately far beyond what FORMULA_MAX_LENGTH (500 chars) can even
    // encode, so in practice the length gate fires first; this test only
    // proves parseFormula never throws an uncaught error for a bad paren run.
    const pathological = "(".repeat(300) + "1" + ")".repeat(300);
    expect(() => parseFormula(pathological)).not.toThrow();
    const r = parseFormula(pathological);
    expect(r.ok).toBe(false); // rejected — either too_long or max_depth_exceeded, never a crash
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
