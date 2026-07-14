/**
 * T-0580 [D-064 §A8 / К4] — Pure unit tests for formula-cycles.ts
 *
 * No DB, no IO. Coverage:
 *  FC-1  acyclic graphs: linear chain, diamond, independent fields → valid order
 *  FC-2  cycles: 2-field cycle (a=f(b),b=f(a)), self-reference (a=f(a)), longer cycle
 *  FC-3  ordering correctness: every dependency appears before its dependent
 */

import { describe, it, expect } from "vitest";
import { detectFormulaCycles, type FormulaGraphNode } from "../formula-cycles.js";
import { parseFormula } from "../formula-parser.js";

function node(fieldKey: string, expr: string): FormulaGraphNode {
  const parsed = parseFormula(expr);
  if (!parsed.ok) throw new Error(`fixture failed to parse: ${expr}`);
  return { fieldKey, ast: parsed.ast };
}

/** Assert that `before` appears earlier in `order` than `after`. */
function assertBefore(order: string[], before: string, after: string): void {
  const iBefore = order.indexOf(before);
  const iAfter = order.indexOf(after);
  expect(iBefore).toBeGreaterThanOrEqual(0);
  expect(iAfter).toBeGreaterThanOrEqual(0);
  expect(iBefore).toBeLessThan(iAfter);
}

describe("detectFormulaCycles — acyclic graphs (FC-1)", () => {
  it("a single formula field with no cross-formula references", () => {
    const r = detectFormulaCycles([node("a", "1 + 2")]);
    expect(r).toEqual({ ok: true, order: ["a"] });
  });

  it("independent formula fields (no edges between them) — any order is valid, all present", () => {
    const r = detectFormulaCycles([node("a", "x + 1"), node("b", "y + 2")]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order.sort()).toEqual(["a", "b"]);
  });

  it("a linear chain a → b → c (a references b, b references c)", () => {
    const r = detectFormulaCycles([node("a", "b + 1"), node("b", "c + 1"), node("c", "1")]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      assertBefore(r.order, "c", "b");
      assertBefore(r.order, "b", "a");
    }
  });

  it("a diamond: a references b and c; b and c both reference d", () => {
    const r = detectFormulaCycles([
      node("a", "b + c"),
      node("b", "d + 1"),
      node("c", "d + 2"),
      node("d", "1"),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      assertBefore(r.order, "d", "b");
      assertBefore(r.order, "d", "c");
      assertBefore(r.order, "b", "a");
      assertBefore(r.order, "c", "a");
    }
  });

  it("a reference to a NON-formula field (plain scalar, not in the node set) is not an edge", () => {
    // "plain_field" is not one of the formula nodes — the graph must treat
    // this as having NO edge for it (it's a scalar/rollup value resolved
    // BEFORE formulas run, per ADR §2.4 — not part of this graph at all).
    const r = detectFormulaCycles([node("a", "plain_field + 1")]);
    expect(r).toEqual({ ok: true, order: ["a"] });
  });
});

describe("detectFormulaCycles — cycles (FC-2)", () => {
  it("a 2-field cycle: a=f(b), b=f(a)", () => {
    const r = detectFormulaCycles([node("a", "b + 1"), node("b", "a + 1")]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.cycle).toContain("a");
      expect(r.cycle).toContain("b");
    }
  });

  it("a self-reference: a=f(a)", () => {
    const r = detectFormulaCycles([node("a", "a + 1")]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cycle).toEqual(["a"]);
  });

  it("a longer 3-field cycle: a→b→c→a", () => {
    const r = detectFormulaCycles([node("a", "b + 1"), node("b", "c + 1"), node("c", "a + 1")]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.cycle).toContain("a");
      expect(r.cycle).toContain("b");
      expect(r.cycle).toContain("c");
    }
  });

  it("a cycle among a subset, with an unrelated acyclic field also present", () => {
    const r = detectFormulaCycles([
      node("a", "b + 1"),
      node("b", "a + 1"),
      node("independent", "1 + 1"),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.cycle).toContain("a");
      expect(r.cycle).toContain("b");
      expect(r.cycle).not.toContain("independent");
    }
  });

  it("a diamond WITH a cycle introduced at the bottom (d references back to a)", () => {
    const r = detectFormulaCycles([
      node("a", "b + c"),
      node("b", "d + 1"),
      node("c", "d + 2"),
      node("d", "a + 1"), // closes the cycle a→b→d→a (and a→c→d→a)
    ]);
    expect(r.ok).toBe(false);
  });
});

describe("detectFormulaCycles — ordering correctness (FC-3)", () => {
  it("every entry of the returned order is a distinct fieldKey, all nodes present exactly once", () => {
    const nodes = [node("a", "b + 1"), node("b", "c + 1"), node("c", "1")];
    const r = detectFormulaCycles(nodes);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.order).toHaveLength(3);
      expect(new Set(r.order).size).toBe(3);
    }
  });

  it("a fan-in graph (many fields reference one shared base field) orders the base first", () => {
    const nodes = [
      node("base", "1"),
      node("a", "base + 1"),
      node("b", "base + 2"),
      node("c", "base + 3"),
    ];
    const r = detectFormulaCycles(nodes);
    expect(r.ok).toBe(true);
    if (r.ok) {
      assertBefore(r.order, "base", "a");
      assertBefore(r.order, "base", "b");
      assertBefore(r.order, "base", "c");
    }
  });
});
