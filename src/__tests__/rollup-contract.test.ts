/**
 * T-0407 [D7-8] — Pure unit tests for rollup-contract.ts
 *
 * No DB, no IO. Tests validate the contract parsing and extraction helpers.
 *
 * Coverage:
 *  RC-1  validateRollupFieldDef: rejects non-object input
 *  RC-2  validateRollupFieldDef: rejects missing/invalid source_registry_id
 *  RC-3  validateRollupFieldDef: rejects missing ref_field
 *  RC-4  validateRollupFieldDef: rejects invalid aggregate
 *  RC-5  validateRollupFieldDef: count — value_field must be absent
 *  RC-6  validateRollupFieldDef: count — valid (no value_field)
 *  RC-7  validateRollupFieldDef: sum/avg/min/max — value_field required
 *  RC-8  validateRollupFieldDef: sum — valid (with value_field)
 *  RC-9  validateRollupFieldDef: all aggregate kinds accepted
 *  RC-10 validateMatrixLookupFieldDef: rejects non-object input
 *  RC-11 validateMatrixLookupFieldDef: rejects missing/invalid table_id
 *  RC-12 validateMatrixLookupFieldDef: rejects missing axis_a_field
 *  RC-13 validateMatrixLookupFieldDef: rejects missing axis_b_field
 *  RC-14 validateMatrixLookupFieldDef: rejects identical axis fields
 *  RC-15 validateMatrixLookupFieldDef: valid input
 *  RC-16 extractDerivedFields: empty on non-object schema
 *  RC-17 extractDerivedFields: empty on schema without properties
 *  RC-18 extractDerivedFields: extracts x-rollup fields
 *  RC-19 extractDerivedFields: extracts x-matrix-lookup fields
 *  RC-20 extractDerivedFields: extracts mixed derived fields
 *  RC-21 extractDerivedFields: skips invalid annotations silently
 *  RC-22 extractDerivedFields: skips scalar properties (no x-* annotation)
 *  RC-23 isRollupAggregate: accepts all known aggregates, rejects unknown
 */

import { describe, it, expect } from "vitest";
import {
  validateRollupFieldDef,
  validateEmbeddedRollupFieldDef,
  computeEmbeddedRollup,
  validateMatrixLookupFieldDef,
  extractDerivedFields,
  isRollupAggregate,
  ROLLUP_AGGREGATES,
  type RollupAggregate,
  type EmbeddedRollupFieldDef,
} from "../core/rollup-contract.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_UUID = "a0000000-0000-0000-0000-000000000001";
const VALID_UUID_2 = "b0000000-0000-0000-0000-000000000002";

function makeRollup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_registry_id: VALID_UUID,
    ref_field: "purchase_ref",
    aggregate: "sum",
    value_field: "amount",
    ...overrides,
  };
}

function makeMatrixLookup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    table_id: VALID_UUID,
    axis_a_field: "project_type",
    axis_b_field: "task_type",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateRollupFieldDef
// ---------------------------------------------------------------------------

describe("validateRollupFieldDef", () => {
  it("RC-1: rejects null / non-object / array", () => {
    for (const bad of [null, "string", 42, ["array"]]) {
      const r = validateRollupFieldDef(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("source_registry_id_missing_or_invalid");
    }
  });

  it("RC-2: rejects missing / invalid source_registry_id", () => {
    const r1 = validateRollupFieldDef({ ...makeRollup(), source_registry_id: undefined });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toBe("source_registry_id_missing_or_invalid");

    const r2 = validateRollupFieldDef({ ...makeRollup(), source_registry_id: "not-a-uuid" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe("source_registry_id_missing_or_invalid");
  });

  it("RC-3: rejects missing / empty ref_field", () => {
    const r1 = validateRollupFieldDef({ ...makeRollup(), ref_field: undefined });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toBe("ref_field_missing_or_empty");

    const r2 = validateRollupFieldDef({ ...makeRollup(), ref_field: "" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe("ref_field_missing_or_empty");
  });

  it("RC-4: rejects invalid aggregate", () => {
    const r = validateRollupFieldDef({ ...makeRollup(), aggregate: "product" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("aggregate_missing_or_invalid");
  });

  it("RC-5: count — rejects when value_field is present", () => {
    const r = validateRollupFieldDef({
      source_registry_id: VALID_UUID,
      ref_field: "parent_ref",
      aggregate: "count",
      value_field: "amount",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("value_field_must_be_absent_for_count");
  });

  it("RC-6: count — valid without value_field", () => {
    const r = validateRollupFieldDef({
      source_registry_id: VALID_UUID,
      ref_field: "parent_ref",
      aggregate: "count",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.def.aggregate).toBe("count");
      expect(r.def.value_field).toBeUndefined();
    }
  });

  it("RC-7: sum/avg/min/max — rejects when value_field is absent", () => {
    for (const agg of ["sum", "avg", "min", "max"] as RollupAggregate[]) {
      const r = validateRollupFieldDef({
        source_registry_id: VALID_UUID,
        ref_field: "parent_ref",
        aggregate: agg,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe("value_field_required_for_aggregate");
      }
    }
  });

  it("RC-8: sum — valid with value_field", () => {
    const r = validateRollupFieldDef(makeRollup({ aggregate: "sum", value_field: "hours" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.def.source_registry_id).toBe(VALID_UUID);
      expect(r.def.ref_field).toBe("purchase_ref");
      expect(r.def.aggregate).toBe("sum");
      expect(r.def.value_field).toBe("hours");
    }
  });

  it("RC-9: all aggregate kinds are accepted with value_field", () => {
    for (const agg of ["sum", "avg", "min", "max"] as RollupAggregate[]) {
      const r = validateRollupFieldDef(makeRollup({ aggregate: agg, value_field: "amount" }));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.def.aggregate).toBe(agg);
    }
  });
});

// ---------------------------------------------------------------------------
// validateMatrixLookupFieldDef
// ---------------------------------------------------------------------------

describe("validateMatrixLookupFieldDef", () => {
  it("RC-10: rejects null / non-object / array", () => {
    for (const bad of [null, "string", 42, []]) {
      const r = validateMatrixLookupFieldDef(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("table_id_missing_or_invalid");
    }
  });

  it("RC-11: rejects missing / invalid table_id", () => {
    const r1 = validateMatrixLookupFieldDef({ ...makeMatrixLookup(), table_id: undefined });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toBe("table_id_missing_or_invalid");

    const r2 = validateMatrixLookupFieldDef({ ...makeMatrixLookup(), table_id: "not-uuid" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe("table_id_missing_or_invalid");
  });

  it("RC-12: rejects missing / empty axis_a_field", () => {
    const r1 = validateMatrixLookupFieldDef({ ...makeMatrixLookup(), axis_a_field: undefined });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toBe("axis_a_field_missing_or_empty");

    const r2 = validateMatrixLookupFieldDef({ ...makeMatrixLookup(), axis_a_field: "" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe("axis_a_field_missing_or_empty");
  });

  it("RC-13: rejects missing / empty axis_b_field", () => {
    const r = validateMatrixLookupFieldDef({ ...makeMatrixLookup(), axis_b_field: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("axis_b_field_missing_or_empty");
  });

  it("RC-14: rejects identical axis fields (degenerate A×A)", () => {
    const r = validateMatrixLookupFieldDef({
      table_id: VALID_UUID,
      axis_a_field: "project_type",
      axis_b_field: "project_type", // same as a
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("axis_fields_must_be_distinct");
  });

  it("RC-15: valid input — parses correctly", () => {
    const r = validateMatrixLookupFieldDef(makeMatrixLookup());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.def.table_id).toBe(VALID_UUID);
      expect(r.def.axis_a_field).toBe("project_type");
      expect(r.def.axis_b_field).toBe("task_type");
    }
  });
});

// ---------------------------------------------------------------------------
// extractDerivedFields
// ---------------------------------------------------------------------------

describe("extractDerivedFields", () => {
  it("RC-16: returns empty for null / non-object / array", () => {
    expect(extractDerivedFields(null)).toEqual([]);
    expect(extractDerivedFields("string")).toEqual([]);
    expect(extractDerivedFields(42)).toEqual([]);
    expect(extractDerivedFields([])).toEqual([]);
  });

  it("RC-17: returns empty for schema without properties", () => {
    expect(extractDerivedFields({ type: "object" })).toEqual([]);
    expect(extractDerivedFields({ properties: null })).toEqual([]);
    expect(extractDerivedFields({ properties: [] })).toEqual([]);
  });

  it("RC-18: extracts x-rollup fields", () => {
    const schema = {
      type: "object",
      properties: {
        total_hours: {
          type: "number",
          "x-rollup": {
            source_registry_id: VALID_UUID,
            ref_field: "parent_ref",
            aggregate: "sum",
            value_field: "hours",
          },
        },
        name: { type: "string" },
      },
    };
    const specs = extractDerivedFields(schema);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      kind: "rollup",
      fieldKey: "total_hours",
      def: {
        source_registry_id: VALID_UUID,
        ref_field: "parent_ref",
        aggregate: "sum",
        value_field: "hours",
      },
    });
  });

  it("RC-19: extracts x-matrix-lookup fields", () => {
    const schema = {
      type: "object",
      properties: {
        norm_hours: {
          type: "number",
          "x-matrix-lookup": {
            table_id: VALID_UUID_2,
            axis_a_field: "project_type",
            axis_b_field: "task_type",
          },
        },
      },
    };
    const specs = extractDerivedFields(schema);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      kind: "matrix-lookup",
      fieldKey: "norm_hours",
      def: {
        table_id: VALID_UUID_2,
        axis_a_field: "project_type",
        axis_b_field: "task_type",
      },
    });
  });

  it("RC-20: extracts mixed rollup and matrix-lookup fields", () => {
    const schema = {
      type: "object",
      properties: {
        total_hours: {
          type: "number",
          "x-rollup": {
            source_registry_id: VALID_UUID,
            ref_field: "parent_ref",
            aggregate: "sum",
            value_field: "hours",
          },
        },
        norm_hours: {
          type: "number",
          "x-matrix-lookup": {
            table_id: VALID_UUID_2,
            axis_a_field: "project_type",
            axis_b_field: "task_type",
          },
        },
        name: { type: "string" },
      },
    };
    const specs = extractDerivedFields(schema);
    expect(specs).toHaveLength(2);
    const kinds = specs.map((s) => s.kind).sort();
    expect(kinds).toEqual(["matrix-lookup", "rollup"]);
  });

  it("RC-21: silently skips invalid x-rollup and x-matrix-lookup annotations", () => {
    const schema = {
      type: "object",
      properties: {
        bad_rollup: {
          type: "number",
          // missing aggregate and source_registry_id
          "x-rollup": { ref_field: "parent_ref" },
        },
        bad_matrix: {
          type: "number",
          // table_id is not a UUID
          "x-matrix-lookup": {
            table_id: "not-a-uuid",
            axis_a_field: "a",
            axis_b_field: "b",
          },
        },
      },
    };
    // No valid derived fields → empty array (no crash)
    const specs = extractDerivedFields(schema);
    expect(specs).toEqual([]);
  });

  it("RC-22: ignores scalar properties without x-* annotations", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        amount: { type: "number" },
        active: { type: "boolean" },
      },
    };
    expect(extractDerivedFields(schema)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isRollupAggregate
// ---------------------------------------------------------------------------

describe("isRollupAggregate", () => {
  it("RC-23: accepts all known aggregates, rejects unknown", () => {
    for (const agg of ROLLUP_AGGREGATES) {
      expect(isRollupAggregate(agg)).toBe(true);
    }
    for (const bad of ["product", "MEDIAN", "SUM", "", 0, null, undefined]) {
      expect(isRollupAggregate(bad)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// T-0603 — EMBEDDED rollup flavor (aggregate over an in-record collection array)
// ---------------------------------------------------------------------------

function makeEmbedded(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "lines",
    op: "sum",
    value_field: "price",
    factor_field: "qty",
    ...overrides,
  };
}

describe("validateEmbeddedRollupFieldDef (T-0603 AC-1)", () => {
  it("T0603-1: rejects null / non-object / array", () => {
    for (const bad of [null, "string", 42, ["array"]]) {
      const r = validateEmbeddedRollupFieldDef(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("source_missing_or_empty");
    }
  });

  it("T0603-2: rejects missing / empty source", () => {
    for (const bad of [undefined, ""]) {
      const r = validateEmbeddedRollupFieldDef({ ...makeEmbedded(), source: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("source_missing_or_empty");
    }
  });

  it("T0603-3: rejects missing / invalid op", () => {
    const r = validateEmbeddedRollupFieldDef({ ...makeEmbedded(), op: "product" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("op_missing_or_invalid");
  });

  it("T0603-4: sum/avg/min/max require value_field", () => {
    for (const op of ["sum", "avg", "min", "max"] as const) {
      const r = validateEmbeddedRollupFieldDef({ source: "lines", op });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("value_field_required_for_op");
    }
  });

  it("T0603-5: count must NOT carry value_field; valid without it", () => {
    const bad = validateEmbeddedRollupFieldDef({ source: "lines", op: "count", value_field: "price" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe("value_field_must_be_absent_for_count");

    const good = validateEmbeddedRollupFieldDef({ source: "lines", op: "count" });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.def).toEqual({ source: "lines", op: "count" });
  });

  it("T0603-6: factor_field optional, but must be a non-empty string when present", () => {
    const bad = validateEmbeddedRollupFieldDef({ ...makeEmbedded(), factor_field: 5 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe("factor_field_must_be_non_empty_string");

    // absent factor_field → omitted from parsed def
    const noFactor = validateEmbeddedRollupFieldDef({ source: "lines", op: "sum", value_field: "price" });
    expect(noFactor.ok).toBe(true);
    if (noFactor.ok) expect(noFactor.def).toEqual({ source: "lines", op: "sum", value_field: "price" });
  });

  it("T0603-7: full valid def round-trips", () => {
    const r = validateEmbeddedRollupFieldDef(makeEmbedded());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.def).toEqual({ source: "lines", op: "sum", value_field: "price", factor_field: "qty" });
    }
  });
});

describe("computeEmbeddedRollup — sum with factor (T-0603 AC-2)", () => {
  const def: EmbeddedRollupFieldDef = { source: "lines", op: "sum", value_field: "price", factor_field: "qty" };

  it("T0603-8: sum = Σ(value × factor) over multiple rows", () => {
    const data = { lines: [
      { price: 100, qty: 3 },   // 300
      { price: 250, qty: 2 },   // 500
      { price: 40, qty: 5 },    // 200
    ] };
    expect(computeEmbeddedRollup(def, data)).toBe(1000);
  });

  it("T0603-9: factor defaults to 1 when factor_field absent from the def", () => {
    const noFactorDef: EmbeddedRollupFieldDef = { source: "lines", op: "sum", value_field: "price" };
    const data = { lines: [{ price: 100 }, { price: 250 }] };
    expect(computeEmbeddedRollup(noFactorDef, data)).toBe(350);
  });

  it("T0603-10: factor defaults to 1 when a row's factor cell is absent/non-numeric", () => {
    const data = { lines: [
      { price: 100, qty: 2 },        // 200
      { price: 250 },                // qty absent → factor 1 → 250
      { price: 40, qty: "oops" },    // qty non-numeric → factor 1 → 40
    ] };
    expect(computeEmbeddedRollup(def, data)).toBe(490);
  });

  it("T0603-11: string-numeric cells are coerced (mirrors client Number() coercion)", () => {
    const data = { lines: [{ price: "100", qty: "3" }, { price: " 50 ", qty: "2" }] };
    expect(computeEmbeddedRollup(def, data)).toBe(400);
  });
});

describe("computeEmbeddedRollup — null-honesty & mixed cells (T-0603 AC-3)", () => {
  const def: EmbeddedRollupFieldDef = { source: "lines", op: "sum", value_field: "price", factor_field: "qty" };

  it("T0603-12: source not an array (missing / wrong type) → null", () => {
    expect(computeEmbeddedRollup(def, { lines: undefined })).toBeNull();
    expect(computeEmbeddedRollup(def, { lines: "not-an-array" })).toBeNull();
    expect(computeEmbeddedRollup(def, {})).toBeNull();
    expect(computeEmbeddedRollup(def, null)).toBeNull();
  });

  it("T0603-13: empty collection array → null (never coerced to 0)", () => {
    expect(computeEmbeddedRollup(def, { lines: [] })).toBeNull();
  });

  it("T0603-14: all value cells non-numeric → null", () => {
    const data = { lines: [{ price: "x", qty: 2 }, { price: null, qty: 3 }, { price: {}, qty: 1 }] };
    expect(computeEmbeddedRollup(def, data)).toBeNull();
  });

  it("T0603-15: mixed cells → sum of numeric ones only", () => {
    const data = { lines: [
      { price: 100, qty: 2 },  // 200
      { price: "junk", qty: 9 }, // skipped
      { price: 50, qty: 3 },   // 150
    ] };
    expect(computeEmbeddedRollup(def, data)).toBe(350);
  });
});

describe("computeEmbeddedRollup — count / avg / min / max (T-0603 AC-4)", () => {
  it("T0603-16: count = row count; empty → null", () => {
    const def: EmbeddedRollupFieldDef = { source: "lines", op: "count" };
    expect(computeEmbeddedRollup(def, { lines: [{ price: 1 }, { price: 2 }, { price: 3 }] })).toBe(3);
    expect(computeEmbeddedRollup(def, { lines: [] })).toBeNull();
    // count ignores value cells entirely — non-numeric rows still counted
    expect(computeEmbeddedRollup(def, { lines: [{ x: "a" }, { y: "b" }] })).toBe(2);
  });

  it("T0603-17: avg = mean of numeric value cells (factor ignored for avg)", () => {
    const def: EmbeddedRollupFieldDef = { source: "lines", op: "avg", value_field: "price", factor_field: "qty" };
    const data = { lines: [{ price: 100, qty: 9 }, { price: 200, qty: 9 }, { price: 300, qty: 9 }] };
    expect(computeEmbeddedRollup(def, data)).toBe(200);
  });

  it("T0603-18: min / max over numeric value cells", () => {
    const data = { lines: [{ price: 40 }, { price: 10 }, { price: 90 }] };
    expect(computeEmbeddedRollup({ source: "lines", op: "min", value_field: "price" }, data)).toBe(10);
    expect(computeEmbeddedRollup({ source: "lines", op: "max", value_field: "price" }, data)).toBe(90);
  });
});

// AC-5: the server compute must match the CLIENT authoring reference
// web/src/screens/records-form.js::computeRollup on shared data. src/ cannot
// import web/ (separate packages), so these expected numbers are the ground
// truth the client function ALSO produces for the same fixtures — a mirror test
// on the web side (records-form.rollup.test.* ) asserts the same numbers from
// the client function, pinning the two implementations together.
describe("computeEmbeddedRollup — parity with client computeRollup (T-0603 AC-5)", () => {
  it("T0603-19: sum+factor fixture — 300000 + 250000 (>500000 case from live proof)", () => {
    const def: EmbeddedRollupFieldDef = { source: "items", op: "sum", value_field: "price", factor_field: "qty" };
    const data = { items: [{ price: 100000, qty: 3 }, { price: 250000, qty: 1 }] };
    // client computeRollup(this shape, data) === 550000
    expect(computeEmbeddedRollup(def, data)).toBe(550000);
  });

  it("T0603-20: empty items fixture → null (both impls agree)", () => {
    const def: EmbeddedRollupFieldDef = { source: "items", op: "sum", value_field: "price", factor_field: "qty" };
    expect(computeEmbeddedRollup(def, { items: [] })).toBeNull();
  });

  it("T0603-21: mixed fixture — blank price cell skipped", () => {
    const def: EmbeddedRollupFieldDef = { source: "items", op: "sum", value_field: "price", factor_field: "qty" };
    const data = { items: [{ price: 100, qty: 2 }, { price: "", qty: 5 }, { price: 30, qty: 1 }] };
    // client skips the blank price cell → 200 + 30 = 230
    expect(computeEmbeddedRollup(def, data)).toBe(230);
  });
});

describe("extractDerivedFields — flavor discrimination (T-0603 AC-6)", () => {
  const CHILD_UUID = "c0000000-0000-0000-0000-000000000003";

  it("T0603-22: embedded x-rollup → kind 'rollup-embedded'", () => {
    const schema = {
      type: "object",
      properties: {
        total: { type: "number", "x-rollup": { source: "lines", op: "sum", value_field: "price", factor_field: "qty" } },
      },
    };
    const specs = extractDerivedFields(schema);
    expect(specs).toHaveLength(1);
    expect(specs[0].kind).toBe("rollup-embedded");
    expect(specs[0].fieldKey).toBe("total");
    if (specs[0].kind === "rollup-embedded") {
      expect(specs[0].def).toEqual({ source: "lines", op: "sum", value_field: "price", factor_field: "qty" });
    }
  });

  it("T0603-23: child x-rollup (source_registry_id present) → kind 'rollup'", () => {
    const schema = {
      type: "object",
      properties: {
        total: { type: "number", "x-rollup": { source_registry_id: CHILD_UUID, ref_field: "parentRef", aggregate: "sum", value_field: "value" } },
      },
    };
    const specs = extractDerivedFields(schema);
    expect(specs).toHaveLength(1);
    expect(specs[0].kind).toBe("rollup");
  });

  it("T0603-24: mixed schema → both flavors extracted", () => {
    const schema = {
      type: "object",
      properties: {
        embeddedTotal: { type: "number", "x-rollup": { source: "lines", op: "sum", value_field: "price" } },
        childTotal: { type: "number", "x-rollup": { source_registry_id: CHILD_UUID, ref_field: "parentRef", aggregate: "count" } },
      },
    };
    const kinds = extractDerivedFields(schema).map((s) => s.kind).sort();
    expect(kinds).toEqual(["rollup", "rollup-embedded"]);
  });

  it("T0603-25: invalid embedded x-rollup (no source, no source_registry_id) → silently skipped", () => {
    const schema = {
      type: "object",
      properties: {
        broken: { type: "number", "x-rollup": { op: "sum", value_field: "price" } },
      },
    };
    expect(extractDerivedFields(schema)).toEqual([]);
  });
});
