/**
 * T-0580 [D-064 §A8 / К4] — Pure unit tests for computeAllDerivedFields's
 * FORMULA branch (ADR §2.4): topological ordering, scope overlay, and cycle
 * defense-in-depth. No DB — only formula-kind specs are exercised, so the
 * `client` parameter is never touched by the code path under test (mirrors
 * how computeEmbeddedRollup is tested without a client in rollup-contract
 * .test.ts). A minimal typed stub satisfies the pg.PoolClient parameter shape
 * without connecting anywhere.
 *
 * Coverage:
 *  DF-1  a formula referencing a plain scalar field computes correctly
 *  DF-2  a formula referencing a rollup-embedded field sees the ALREADY-
 *        COMPUTED rollup value (proves step-1-before-step-2 ordering, ADR §2.4)
 *  DF-3  chained formulas (b references a) resolve in topological order —
 *        NOT relying on array iteration order (the array is deliberately
 *        given in the WRONG order to prove the topo-sort, not luck)
 *  DF-4  a cycle among formula fields (defense-in-depth: should never reach
 *        here past the authoring gate, but must degrade every involved field
 *        to null rather than crash or infinite-loop)
 *  DF-5  DerivedFieldMap value type: a date-result formula yields a STRING
 *        (ISO date) alongside number-result rollup/formula fields in the SAME map
 */

import { describe, it, expect } from "vitest";
import type pg from "pg";
import { computeAllDerivedFields } from "../db/derived-fields-dao.js";
import { extractDerivedFields, type DerivedFieldSpec } from "../core/rollup-contract.js";

// A stub client that would throw if any code path actually tried to query it —
// proving the formula-only branch never touches the DB (mirrors
// computeEmbeddedRollup's "no client use" contract).
const UNUSED_CLIENT = {
  query: () => {
    throw new Error("computeAllDerivedFields must not query the DB for formula-only specs");
  },
} as unknown as pg.PoolClient;

const TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const RECORD_ID = "b0000000-0000-0000-0000-000000000002";

describe("computeAllDerivedFields — formula fields (T-0580 DF-1)", () => {
  it("computes a single formula field over plain record.data scalars", async () => {
    const schema = {
      type: "object",
      properties: {
        summa: { type: "number" },
        nds_rate: { type: "number" },
        itogo: { type: "number", "x-formula": { expr: "summa * (1 + nds_rate)", result_type: "number" } },
      },
    };
    const specs = extractDerivedFields(schema);
    const result = await computeAllDerivedFields(
      UNUSED_CLIENT,
      TENANT_ID,
      RECORD_ID,
      { summa: 100000, nds_rate: 0.2 },
      specs,
    );
    expect(result["itogo"]).toBe(120000);
  });

  it("a null-input field yields null for the formula (not 0)", async () => {
    const schema = {
      type: "object",
      properties: {
        summa: { type: "number" },
        nds_rate: { type: "number" },
        itogo: { type: "number", "x-formula": { expr: "summa * (1 + nds_rate)", result_type: "number" } },
      },
    };
    const specs = extractDerivedFields(schema);
    const result = await computeAllDerivedFields(UNUSED_CLIENT, TENANT_ID, RECORD_ID, { summa: null, nds_rate: 0.2 }, specs);
    expect(result["itogo"]).toBeNull();
  });
});

describe("computeAllDerivedFields — formula referencing a rollup-embedded field (T-0580 DF-2, ADR §2.4 step order)", () => {
  it("a formula sees the rollup-embedded value that was computed in step 1, not undefined", async () => {
    const schema = {
      type: "object",
      properties: {
        lines: { type: "array" },
        total: { type: "number", "x-rollup": { source: "lines", op: "sum", value_field: "price", factor_field: "qty" } },
        nds_rate: { type: "number" },
        itogo: { type: "number", "x-formula": { expr: "total * (1 + nds_rate)", result_type: "number" } },
      },
    };
    const specs = extractDerivedFields(schema);
    const recordData = {
      lines: [{ price: 100000, qty: 3 }, { price: 250000, qty: 1 }], // Σ = 550000
      nds_rate: 0.2,
    };
    const result = await computeAllDerivedFields(UNUSED_CLIENT, TENANT_ID, RECORD_ID, recordData, specs);
    expect(result["total"]).toBe(550000);
    expect(result["itogo"]).toBe(660000); // 550000 * 1.2 — proves formula saw the REAL rollup value
  });

  it("an empty rollup source (total=null) propagates null through the dependent formula (honest, not 0)", async () => {
    const schema = {
      type: "object",
      properties: {
        lines: { type: "array" },
        total: { type: "number", "x-rollup": { source: "lines", op: "sum", value_field: "price" } },
        nds_rate: { type: "number" },
        itogo: { type: "number", "x-formula": { expr: "total * (1 + nds_rate)", result_type: "number" } },
      },
    };
    const specs = extractDerivedFields(schema);
    const result = await computeAllDerivedFields(UNUSED_CLIENT, TENANT_ID, RECORD_ID, { lines: [], nds_rate: 0.2 }, specs);
    expect(result["total"]).toBeNull();
    expect(result["itogo"]).toBeNull();
  });
});

describe("computeAllDerivedFields — chained formulas resolve in TOPOLOGICAL order (T-0580 DF-3)", () => {
  it("b (declared BEFORE a in the schema/array) still sees a's computed value", async () => {
    // Deliberately declare "b" (which depends on "a") FIRST in properties —
    // proving the evaluation order comes from detectFormulaCycles' topo-sort,
    // NOT from object/array iteration order (which would put b before a here
    // if the code naively used Object.entries order without sorting).
    const schema = {
      type: "object",
      properties: {
        b: { type: "number", "x-formula": { expr: "a + 1", result_type: "number" } },
        base: { type: "number" },
        a: { type: "number", "x-formula": { expr: "base + 10", result_type: "number" } },
      },
    };
    const specs = extractDerivedFields(schema);
    // Sanity: confirm the spec array really does list "b" before "a" (proving
    // the topo-sort, not array order, is what makes this test meaningful).
    const formulaOrderInArray = specs.filter((s) => s.kind === "formula").map((s) => s.fieldKey);
    expect(formulaOrderInArray).toEqual(["b", "a"]);

    const result = await computeAllDerivedFields(UNUSED_CLIENT, TENANT_ID, RECORD_ID, { base: 5 }, specs);
    expect(result["a"]).toBe(15); // base(5) + 10
    expect(result["b"]).toBe(16); // a(15) + 1 — only correct if a was computed FIRST
  });

  it("a 3-level chain (c depends on b depends on a) resolves correctly regardless of declaration order", async () => {
    const schema = {
      type: "object",
      properties: {
        c: { type: "number", "x-formula": { expr: "b + 1", result_type: "number" } },
        a: { type: "number", "x-formula": { expr: "10", result_type: "number" } },
        b: { type: "number", "x-formula": { expr: "a + 1", result_type: "number" } },
      },
    };
    const specs = extractDerivedFields(schema);
    const result = await computeAllDerivedFields(UNUSED_CLIENT, TENANT_ID, RECORD_ID, {}, specs);
    expect(result["a"]).toBe(10);
    expect(result["b"]).toBe(11);
    expect(result["c"]).toBe(12);
  });
});

describe("computeAllDerivedFields — cycle defense-in-depth (T-0580 DF-4)", () => {
  it("a cyclic pair of formula fields (which should never pass the authoring gate) degrades BOTH to null, never crashes", async () => {
    // Hand-construct a DerivedFieldSpec[] with a cycle directly (bypassing
    // extractDerivedFields/the authoring gate entirely) — simulating a
    // corrupted/legacy schema reaching compute time.
    const { parseFormula } = await import("../core/formula-parser.js");
    const parsedA = parseFormula("b + 1");
    const parsedB = parseFormula("a + 1");
    if (!parsedA.ok || !parsedB.ok) throw new Error("fixture formulas failed to parse");
    const specs: DerivedFieldSpec[] = [
      { kind: "formula", fieldKey: "a", def: { expr: "b + 1", result_type: "number" }, ast: parsedA.ast },
      { kind: "formula", fieldKey: "b", def: { expr: "a + 1", result_type: "number" }, ast: parsedB.ast },
    ];
    const result = await computeAllDerivedFields(UNUSED_CLIENT, TENANT_ID, RECORD_ID, {}, specs);
    expect(result["a"]).toBeNull();
    expect(result["b"]).toBeNull();
  });
});

describe("computeAllDerivedFields — DerivedFieldMap carries string (date) alongside number values (T-0580 DF-5)", () => {
  it("a date-result formula and a number-result formula coexist in the SAME map", async () => {
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
        summa: { type: "number" },
        nds_rate: { type: "number" },
        itogo: { type: "number", "x-formula": { expr: "summa * (1 + nds_rate)", result_type: "number" } },
      },
    };
    const specs = extractDerivedFields(schema);
    const result = await computeAllDerivedFields(
      UNUSED_CLIENT,
      TENANT_ID,
      RECORD_ID,
      { start_date: "2026-07-01", term_days: 30, summa: 100000, nds_rate: 0.2 },
      specs,
    );
    expect(result["deadline"]).toBe("2026-07-31");
    expect(typeof result["deadline"]).toBe("string");
    expect(result["itogo"]).toBe(120000);
    expect(typeof result["itogo"]).toBe("number");
  });
});
