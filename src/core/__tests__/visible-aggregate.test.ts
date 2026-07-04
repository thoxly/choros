/**
 * src/core/__tests__/visible-aggregate.test.ts — T-0587 (ADR-T0587 §1.4, FF-2/AC-4).
 *
 * ZERO IO — pure unit tests over the accumulation/derivation functions in
 * src/core/visible-aggregate.ts. No pg, no http, no fs.
 *
 * Coverage:
 *   FF-2/AC-4 (order-of-filtering invariant): a caller simulating the
 *     READ-PDP predicate (only SOME rows are fed to accumulateNumeric) must
 *     see those excluded rows have ZERO effect on count/sum/avg/min/max —
 *     this module has no way to "see" excluded rows at all, which is the
 *     point: the invariant is enforced by NEVER calling accumulateNumeric for
 *     a filtered-out row, not by any logic inside this module.
 *   Coercion / skip semantics: non-finite, missing, null, and object/array
 *     values are skipped without corrupting the running aggregate.
 *   finalizeNumeric: zero-count fields are dropped, not zero-rendered.
 *   pickNumericFieldKeys: generic derivation from record_schema via
 *     deriveFieldType, D-064 (no hardcoded field name), bounded by limit.
 */

import { describe, it, expect } from "vitest";
import {
  initNumericAccumulators,
  accumulateNumeric,
  finalizeNumeric,
  pickNumericFieldKeys,
} from "../visible-aggregate.js";

describe("accumulateNumeric / finalizeNumeric — basic aggregation", () => {
  it("computes count/sum/avg/min/max over a set of visible rows", () => {
    const accs = initNumericAccumulators(["amount"]);
    accumulateNumeric(accs, { amount: 100 }, ["amount"]);
    accumulateNumeric(accs, { amount: 250 }, ["amount"]);
    accumulateNumeric(accs, { amount: 50 }, ["amount"]);

    const result = finalizeNumeric(accs, new Map([["amount", "Сумма"]]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fieldKey: "amount",
      fieldLabel: "Сумма",
      count: 3,
      sum: 400,
      min: 50,
      max: 250,
    });
    expect(result[0]!.avg).toBeCloseTo(400 / 3, 6);
  });

  it("FF-2/AC-4: rows NOT passed to accumulateNumeric (simulating isRecordReadable===false) have ZERO effect", () => {
    const accs = initNumericAccumulators(["amount"]);
    const allRows = [{ amount: 100 }, { amount: 999 }, { amount: 50 }];
    // Simulate the caller's per-row READ-PDP filter: only rows[0] and rows[2]
    // "pass" — row[1] (amount: 999) is EXCLUDED, exactly as a DAO would skip
    // a row that failed isRecordReadable before ever reaching this function.
    const visibleOnly = [allRows[0]!, allRows[2]!];
    for (const row of visibleOnly) {
      accumulateNumeric(accs, row, ["amount"]);
    }

    const result = finalizeNumeric(accs, new Map());
    expect(result[0]!.count).toBe(2);
    expect(result[0]!.sum).toBe(150);
    expect(result[0]!.max).toBe(100); // NOT 999 — the excluded row never entered.
    expect(result[0]!.min).toBe(50);
  });

  it("skips missing/null/non-finite/object values without corrupting the aggregate", () => {
    const accs = initNumericAccumulators(["amount"]);
    accumulateNumeric(accs, { amount: 100 }, ["amount"]);
    accumulateNumeric(accs, { amount: null }, ["amount"]);
    accumulateNumeric(accs, {}, ["amount"]); // missing key
    accumulateNumeric(accs, { amount: "not a number" }, ["amount"]);
    accumulateNumeric(accs, { amount: NaN }, ["amount"]);
    accumulateNumeric(accs, { amount: Infinity }, ["amount"]);
    accumulateNumeric(accs, { amount: { nested: 1 } }, ["amount"]);
    accumulateNumeric(accs, { amount: [1, 2] }, ["amount"]);
    accumulateNumeric(accs, { amount: 200 }, ["amount"]);

    const result = finalizeNumeric(accs, new Map());
    expect(result[0]!.count).toBe(2);
    expect(result[0]!.sum).toBe(300);
  });

  it("coerces numeric strings (Number() coercion)", () => {
    const accs = initNumericAccumulators(["amount"]);
    accumulateNumeric(accs, { amount: "150" }, ["amount"]);
    const result = finalizeNumeric(accs, new Map());
    expect(result[0]!.count).toBe(1);
    expect(result[0]!.sum).toBe(150);
  });

  it("finalizeNumeric drops fields with zero contributing values (not zero-rendered)", () => {
    const accs = initNumericAccumulators(["amount", "quantity"]);
    accumulateNumeric(accs, { amount: 10 }, ["amount", "quantity"]); // quantity absent
    const result = finalizeNumeric(accs, new Map([["amount", "Сумма"], ["quantity", "Кол-во"]]));
    expect(result).toHaveLength(1);
    expect(result[0]!.fieldKey).toBe("amount");
  });

  it("data===null or non-object is a no-op (does not throw)", () => {
    const accs = initNumericAccumulators(["amount"]);
    expect(() => accumulateNumeric(accs, null, ["amount"])).not.toThrow();
    expect(() => accumulateNumeric(accs, "not an object", ["amount"])).not.toThrow();
    expect(() => accumulateNumeric(accs, 42, ["amount"])).not.toThrow();
    const result = finalizeNumeric(accs, new Map());
    expect(result).toHaveLength(0);
  });

  it("multiple fields accumulate independently", () => {
    const accs = initNumericAccumulators(["amount", "qty"]);
    accumulateNumeric(accs, { amount: 100, qty: 2 }, ["amount", "qty"]);
    accumulateNumeric(accs, { amount: 200, qty: 3 }, ["amount", "qty"]);
    const result = finalizeNumeric(accs, new Map());
    const byKey = new Map(result.map((r) => [r.fieldKey, r]));
    expect(byKey.get("amount")).toMatchObject({ count: 2, sum: 300 });
    expect(byKey.get("qty")).toMatchObject({ count: 2, sum: 5 });
  });
});

describe("pickNumericFieldKeys — generic derivation from record_schema (D-064)", () => {
  it("selects only properties whose deriveFieldType is 'number'", () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
        amount: { type: "number", title: "Сумма" },
        count: { type: "integer", title: "Количество" },
        active: { type: "boolean" },
        status: { type: "string", enum: ["open", "closed"] },
      },
    };
    const picked = pickNumericFieldKeys(schema, 5);
    expect(picked.map((p) => p.key).sort()).toEqual(["amount", "count"]);
  });

  it("uses the JSON Schema 'title' as label, falling back to the key", () => {
    const schema = {
      properties: {
        amount: { type: "number", title: "Сумма сделки" },
        weight: { type: "number" }, // no title
      },
    };
    const picked = pickNumericFieldKeys(schema, 5);
    const byKey = new Map(picked.map((p) => [p.key, p.label]));
    expect(byKey.get("amount")).toBe("Сумма сделки");
    expect(byKey.get("weight")).toBe("weight");
  });

  it("bounded by limit (NF-5) — caps the returned list even with more numeric fields", () => {
    const schema = {
      properties: {
        f1: { type: "number" },
        f2: { type: "number" },
        f3: { type: "number" },
        f4: { type: "number" },
      },
    };
    const picked = pickNumericFieldKeys(schema, 2);
    expect(picked).toHaveLength(2);
  });

  it("malformed/absent schema degrades to empty list, never throws", () => {
    expect(pickNumericFieldKeys(null, 5)).toEqual([]);
    expect(pickNumericFieldKeys(undefined, 5)).toEqual([]);
    expect(pickNumericFieldKeys("not an object", 5)).toEqual([]);
    expect(pickNumericFieldKeys({}, 5)).toEqual([]);
    expect(pickNumericFieldKeys({ properties: null }, 5)).toEqual([]);
    expect(pickNumericFieldKeys({ properties: "nope" }, 5)).toEqual([]);
  });

  it("no numeric fields in schema → empty list", () => {
    const schema = { properties: { title: { type: "string" }, active: { type: "boolean" } } };
    expect(pickNumericFieldKeys(schema, 5)).toEqual([]);
  });
});
