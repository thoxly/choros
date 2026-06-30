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
  validateMatrixLookupFieldDef,
  extractDerivedFields,
  isRollupAggregate,
  ROLLUP_AGGREGATES,
  type RollupAggregate,
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
