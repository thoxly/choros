/**
 * src/core/__tests__/visible-record-agg.test.ts — T-0632 (security, столп 4).
 *
 * ZERO IO — pure unit tests over VisibleAggregator / matchesFilter in
 * src/core/visible-record-agg.ts. No pg, no http, no fs.
 *
 * Coverage:
 *   - count/sum/avg/min/max/list, non-grouped.
 *   - group_by variants of each agg func.
 *   - order-of-filtering invariant: rows never `.fold()`-ed (simulating
 *     isRecordReadable===false) have ZERO effect on any aggregate — mirrors
 *     visible-aggregate.test.ts's FF-2/AC-4 invariant, generalized to the
 *     full Floor-1 vocab.
 *   - matchesFilter: =, !=, <, >, in — mirrors the SQL filter clause
 *     buildRawRecordSql/buildAggSql emit, applied defensively in JS.
 *   - non-numeric / missing values silently skipped (do not corrupt the
 *     aggregate of the remaining rows).
 */

import { describe, it, expect } from "vitest";
import { VisibleAggregator, matchesFilter } from "../visible-record-agg.js";

describe("VisibleAggregator — non-grouped", () => {
  it("count: counts folded rows only", () => {
    const agg = new VisibleAggregator("count", "amount");
    agg.fold({ amount: 1 });
    agg.fold({ amount: 2 });
    agg.fold({ amount: 3 });
    const { result, grouped } = agg.finalize();
    expect(result).toBe(3);
    expect(grouped).toBeNull();
  });

  it("sum/avg/min/max over numeric field", () => {
    const mk = (a: string) => {
      const agg = new VisibleAggregator(a as "sum", "amount");
      agg.fold({ amount: 100 });
      agg.fold({ amount: 250 });
      agg.fold({ amount: 50 });
      return agg.finalize().result;
    };
    expect(mk("sum")).toBe(400);
    expect(mk("avg")).toBeCloseTo(400 / 3, 6);
    expect(mk("min")).toBe(50);
    expect(mk("max")).toBe(250);
  });

  it("list: collects raw field values in fold order", () => {
    const agg = new VisibleAggregator("list", "name");
    agg.fold({ name: "alpha" });
    agg.fold({ name: "beta" });
    const { result } = agg.finalize();
    expect(result).toEqual(["alpha", "beta"]);
  });

  it("sum with zero folded rows → 0 (not null) — matches SQL SUM() over zero rows behavior for the non-grouped path's convention", () => {
    const agg = new VisibleAggregator("sum", "amount");
    const { result } = agg.finalize();
    expect(result).toBe(0);
  });

  it("avg with zero folded rows → null (no rows to average)", () => {
    const agg = new VisibleAggregator("avg", "amount");
    const { result } = agg.finalize();
    expect(result).toBeNull();
  });

  it("min/max with zero folded rows → null", () => {
    expect(new VisibleAggregator("min", "amount").finalize().result).toBeNull();
    expect(new VisibleAggregator("max", "amount").finalize().result).toBeNull();
  });

  it("count with zero folded rows → 0", () => {
    expect(new VisibleAggregator("count", "amount").finalize().result).toBe(0);
  });

  it("non-numeric / missing / object values are silently skipped, do not corrupt the aggregate", () => {
    const agg = new VisibleAggregator("sum", "amount");
    agg.fold({ amount: 100 });
    agg.fold({ amount: "not-a-number" });
    agg.fold({ amount: null });
    agg.fold({}); // missing key entirely
    agg.fold({ amount: { nested: true } }); // object — must not coerce
    agg.fold({ amount: 50 });
    const { result } = agg.finalize();
    expect(result).toBe(150);
  });

  it("empty/whitespace string is skipped, NOT coerced to 0 (Number('') === 0 trap)", () => {
    const agg = new VisibleAggregator("sum", "amount");
    agg.fold({ amount: "" });
    agg.fold({ amount: "   " });
    agg.fold({ amount: 42 });
    const { result } = agg.finalize();
    expect(result).toBe(42);
  });
});

describe("VisibleAggregator — grouped (group_by)", () => {
  it("sum grouped by a text field", () => {
    const agg = new VisibleAggregator("sum", "amount", "status");
    agg.fold({ status: "open", amount: 100 });
    agg.fold({ status: "closed", amount: 50 });
    agg.fold({ status: "open", amount: 25 });
    const { result, grouped } = agg.finalize();
    expect(result).toBeNull();
    expect(grouped).toEqual([
      { group_key: "open", result: 125 },
      { group_key: "closed", result: 50 },
    ]);
  });

  it("count grouped — group with zero rows never appears (no phantom groups)", () => {
    const agg = new VisibleAggregator("count", "amount", "status");
    agg.fold({ status: "open", amount: 1 });
    agg.fold({ status: "open", amount: 2 });
    const { grouped } = agg.finalize();
    expect(grouped).toEqual([{ group_key: "open", result: 2 }]);
  });

  it("list grouped — collects per-group arrays", () => {
    const agg = new VisibleAggregator("list", "name", "team");
    agg.fold({ team: "a", name: "x" });
    agg.fold({ team: "b", name: "y" });
    agg.fold({ team: "a", name: "z" });
    const { grouped } = agg.finalize();
    expect(grouped).toEqual([
      { group_key: "a", result: ["x", "z"] },
      { group_key: "b", result: ["y"] },
    ]);
  });

  it("missing group_by field folds under the empty-string group key (mirrors data->>'k' → NULL → text '')", () => {
    const agg = new VisibleAggregator("count", "amount", "status");
    agg.fold({ amount: 1 }); // no `status` key at all
    const { grouped } = agg.finalize();
    expect(grouped).toEqual([{ group_key: "", result: 1 }]);
  });
});

describe("FF-2/AC-4 (mirrors visible-aggregate.test.ts): rows never folded have ZERO effect", () => {
  it("a row simulating isRecordReadable===false (never passed to .fold()) does not affect sum/count/list", () => {
    const allRows = [{ amount: 100 }, { amount: 999999 }, { amount: 50 }];
    // Simulate the caller's per-row READ-PDP filter: only rows[0]/rows[2] "pass".
    const visibleOnly = [allRows[0]!, allRows[2]!];

    const sumAgg = new VisibleAggregator("sum", "amount");
    const countAgg = new VisibleAggregator("count", "amount");
    for (const row of visibleOnly) {
      sumAgg.fold(row);
      countAgg.fold(row);
    }
    expect(sumAgg.finalize().result).toBe(150);
    expect(countAgg.finalize().result).toBe(2);
    // The huge 999999 value from the excluded row NEVER reaches the sum —
    // this is the exact invariant the report-page-render.ts P0 fix depends on.
    expect(sumAgg.finalize().result).not.toBe(100 + 999999 + 50);
  });
});

describe("matchesFilter — mirrors SQL filter clause semantics", () => {
  it("'=' matches text-extracted equality", () => {
    expect(matchesFilter({ status: "open" }, { fieldKey: "status", op: "=", value: "open" })).toBe(true);
    expect(matchesFilter({ status: "closed" }, { fieldKey: "status", op: "=", value: "open" })).toBe(false);
  });

  it("'!=' — missing/null field never matches (three-valued NULL semantics)", () => {
    expect(matchesFilter({ status: "closed" }, { fieldKey: "status", op: "!=", value: "open" })).toBe(true);
    expect(matchesFilter({}, { fieldKey: "status", op: "!=", value: "open" })).toBe(false);
  });

  it("'<'/'>' compare as TEXT (byte-identical to the original SQL data->>'k' op $N semantics, not a numeric upgrade)", () => {
    expect(matchesFilter({ n: "5" }, { fieldKey: "n", op: "<", value: "9" })).toBe(true);
    // Text comparison: "10" < "9" lexicographically (starts with '1' < '9') —
    // this is what the ORIGINAL SQL clause did too (no ::numeric cast on the
    // filter side), so this test locks in byte-identical (not "improved")
    // filtering behavior for existing page_defs.
    expect(matchesFilter({ n: "10" }, { fieldKey: "n", op: "<", value: "9" })).toBe(true);
  });

  it("'in' matches any array element by text equality", () => {
    const filter = { fieldKey: "status", op: "in" as const, value: ["open", "pending"] };
    expect(matchesFilter({ status: "pending" }, filter)).toBe(true);
    expect(matchesFilter({ status: "closed" }, filter)).toBe(false);
  });

  it("missing data / non-object data never matches any op", () => {
    expect(matchesFilter(null, { fieldKey: "status", op: "=", value: "open" })).toBe(false);
    expect(matchesFilter("not-an-object", { fieldKey: "status", op: "=", value: "open" })).toBe(false);
  });
});
