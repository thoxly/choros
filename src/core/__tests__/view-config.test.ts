/**
 * T-0581 (view registry) — src/core/view-config.ts unit tests.
 *
 * Covers:
 *   AC-4  operator not valid for field type (gt on boolean, any filter on
 *         computed/collection) → rejected with explicit errors, config not valid.
 *   AC-5  sort on computed/collection/multi-select/relation/person rejected;
 *         sort on string/number/money/date/boolean/select/created_at accepted.
 *   AC-11 validateViewConfig is a DISPATCHER by type (FF-VR-4): unknown type
 *         rejected; 'list' branch present.
 *   R-4   NULL/absent-key semantics documented at the validator boundary
 *         (is_empty/is_not_empty are always legal regardless of stored value).
 */

import { describe, it, expect } from "vitest";
import {
  validateViewConfig,
  defaultViewConfig,
  operatorsForFieldType,
  isServerSortable,
  resolveFieldTypes,
  enumValuesForSelectField,
} from "../view-config.js";

const RECORD_SCHEMA = {
  type: "object",
  properties: {
    amount: { type: "number", "x-money": { currency: "RUB" } },
    status: { type: "string", enum: ["open", "won", "lost"] },
    is_active: { type: "boolean" },
    notes: { type: "string" },
    tags: { type: "array", items: { type: "string", enum: ["a", "b"] }, "x-multi-select": true },
    owner: { type: "string", "x-person": true },
    linked: { type: "string", "x-relation": { target_registry_id: "reg-1" } },
    total: { type: "number", title: "Итог", "x-rollup": { source: "child", op: "sum", value_field: "amount" } },
    steps: {
      type: "array",
      items: { type: "object", properties: { label: { type: "string" } } },
    },
  },
  required: [],
  "x-field-order": ["amount", "status", "is_active", "notes", "tags", "owner", "linked", "total", "steps"],
};

describe("view-config: resolveFieldTypes", () => {
  it("resolves every declared field to its ViewFieldType via x-* precedence", () => {
    const { typeByKey, orderedKeys } = resolveFieldTypes(RECORD_SCHEMA);
    expect(typeByKey.get("amount")).toBe("money");
    expect(typeByKey.get("status")).toBe("select");
    expect(typeByKey.get("is_active")).toBe("boolean");
    expect(typeByKey.get("notes")).toBe("string");
    expect(typeByKey.get("tags")).toBe("multi-select");
    expect(typeByKey.get("owner")).toBe("person");
    expect(typeByKey.get("linked")).toBe("relation");
    expect(typeByKey.get("total")).toBe("computed");
    expect(typeByKey.get("steps")).toBe("collection");
    expect(orderedKeys).toEqual([
      "amount", "status", "is_active", "notes", "tags", "owner", "linked", "total", "steps",
    ]);
  });

  it("malformed record_schema resolves to empty (never throws)", () => {
    expect(resolveFieldTypes(null).orderedKeys).toEqual([]);
    expect(resolveFieldTypes("garbage").orderedKeys).toEqual([]);
    expect(resolveFieldTypes({}).orderedKeys).toEqual([]);
  });
});

describe("view-config: operatorsForFieldType / isServerSortable tables (ADR §3.4)", () => {
  it("computed/collection have NO legal filter operators", () => {
    expect(operatorsForFieldType("computed")).toEqual([]);
    expect(operatorsForFieldType("collection")).toEqual([]);
  });

  it("boolean does not accept gt/lt/eq — only is_true/is_false/is_empty", () => {
    expect(operatorsForFieldType("boolean")).toEqual(["is_true", "is_false", "is_empty"]);
  });

  it("computed/collection/multi-select/relation/person are NOT server-sortable", () => {
    expect(isServerSortable("computed")).toBe(false);
    expect(isServerSortable("collection")).toBe(false);
    expect(isServerSortable("multi-select")).toBe(false);
    expect(isServerSortable("relation")).toBe(false);
    expect(isServerSortable("person")).toBe(false);
  });

  it("string/number/money/date/boolean/select/created_at ARE server-sortable", () => {
    for (const t of ["string", "number", "money", "date", "boolean", "select", "created_at"] as const) {
      expect(isServerSortable(t)).toBe(true);
    }
  });
});

describe("AC-4: validateViewConfig rejects operator invalid for field type", () => {
  it("rejects gt on a boolean field", () => {
    const result = validateViewConfig(
      "list",
      { filters: [{ field_key: "is_active", op: "gt", value: true }] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("is_active"))).toBe(true);
  });

  it("rejects ANY filter on a computed field", () => {
    const result = validateViewConfig(
      "list",
      { filters: [{ field_key: "total", op: "eq", value: 1 }] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("total"))).toBe(true);
  });

  it("rejects ANY filter on a collection field", () => {
    const result = validateViewConfig(
      "list",
      { filters: [{ field_key: "steps", op: "is_empty", value: null }] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(false);
  });

  it("accepts a valid operator for its field type (eq on select)", () => {
    const result = validateViewConfig(
      "list",
      { filters: [{ field_key: "status", op: "in", value: ["open", "won"] }] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a filter on an unknown field_key", () => {
    const result = validateViewConfig(
      "list",
      { filters: [{ field_key: "not_a_real_field", op: "eq", value: 1 }] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(false);
  });
});

describe("AC-5: validateViewConfig sort server-sortability", () => {
  it("rejects sort on computed/collection/multi-select/relation/person", () => {
    for (const key of ["total", "steps", "tags", "linked", "owner"]) {
      const result = validateViewConfig(
        "list",
        { sort: [{ field_key: key, dir: "asc" }] },
        RECORD_SCHEMA,
      );
      expect(result.valid, `expected sort on '${key}' to be rejected`).toBe(false);
    }
  });

  it("accepts sort on string/number/money/date/boolean/select/created_at", () => {
    for (const key of ["notes", "amount", "status", "is_active", "created_at"]) {
      const result = validateViewConfig(
        "list",
        { sort: [{ field_key: key, dir: "desc" }] },
        RECORD_SCHEMA,
      );
      expect(result.valid, `expected sort on '${key}' to be accepted: ${result.errors.join(",")}`).toBe(true);
    }
  });

  it("rejects a malformed dir value", () => {
    const result = validateViewConfig(
      "list",
      { sort: [{ field_key: "amount", dir: "ascending" }] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(false);
  });
});

describe("AC-11/FF-VR-4: validateViewConfig is a type-dispatcher", () => {
  it("rejects a truly unknown type (not silently treated as 'list')", () => {
    const result = validateViewConfig("gantt", { columns: [] }, RECORD_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/unknown view type/);
  });

  it("accepts the 'list' type with an empty config (all fields optional)", () => {
    const result = validateViewConfig("list", {}, RECORD_SCHEMA);
    expect(result.valid).toBe(true);
  });

  it("rejects a non-object config", () => {
    expect(validateViewConfig("list", null, RECORD_SCHEMA).valid).toBe(false);
    expect(validateViewConfig("list", "nope", RECORD_SCHEMA).valid).toBe(false);
    expect(validateViewConfig("list", [], RECORD_SCHEMA).valid).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// T-0582 (kanban view) — validateKanbanViewConfig ('kanban' branch, AC-2/AC-10).
// -----------------------------------------------------------------------------

describe("T-0582 AC-2/AC-11: validateViewConfig('kanban', …) — dispatcher branch added, not rewritten", () => {
  it("case 'kanban' now exists (no longer falls into the unknown-type default)", () => {
    const result = validateViewConfig(
      "kanban",
      { group_by_field: "status", card_fields: ["notes"] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("'list' branch is untouched by the kanban addition", () => {
    expect(validateViewConfig("list", {}, RECORD_SCHEMA).valid).toBe(true);
  });

  it("a genuinely unknown type is still rejected by the default: branch", () => {
    const result = validateViewConfig("gantt", {}, RECORD_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/unknown view type/);
  });
});

describe("T-0582 AC-2: validateKanbanViewConfig — group_by_field", () => {
  it("rejects a missing group_by_field", () => {
    const result = validateViewConfig("kanban", { card_fields: [] }, RECORD_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("group_by_field"))).toBe(true);
  });

  it("rejects an empty-string group_by_field", () => {
    const result = validateViewConfig("kanban", { group_by_field: "" }, RECORD_SCHEMA);
    expect(result.valid).toBe(false);
  });

  it("rejects a group_by_field that is not a known record_schema key", () => {
    const result = validateViewConfig("kanban", { group_by_field: "ghost" }, RECORD_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ghost"))).toBe(true);
  });

  it("rejects a group_by_field that is a known field but NOT select-typed (e.g. boolean/money/computed)", () => {
    for (const key of ["is_active", "amount", "total", "notes"]) {
      const result = validateViewConfig("kanban", { group_by_field: key }, RECORD_SCHEMA);
      expect(result.valid, `expected group_by_field='${key}' to be rejected`).toBe(false);
      expect(result.errors.some((e) => e.includes(key))).toBe(true);
    }
  });

  it("accepts a select-typed group_by_field", () => {
    const result = validateViewConfig("kanban", { group_by_field: "status" }, RECORD_SCHEMA);
    expect(result.valid).toBe(true);
  });

  it("rejects group_by_field of the wrong type (number instead of string)", () => {
    const result = validateViewConfig("kanban", { group_by_field: 42 }, RECORD_SCHEMA);
    expect(result.valid).toBe(false);
  });
});

describe("T-0582 AC-2: validateKanbanViewConfig — card_fields", () => {
  it("accepts card_fields that all exist in the schema (including created_at pseudo-column)", () => {
    const result = validateViewConfig(
      "kanban",
      { group_by_field: "status", card_fields: ["amount", "notes", "created_at"] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects card_fields with a non-existent key", () => {
    const result = validateViewConfig(
      "kanban",
      { group_by_field: "status", card_fields: ["amount", "not_a_real_field"] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("not_a_real_field"))).toBe(true);
  });

  it("rejects card_fields that is not an array", () => {
    const result = validateViewConfig(
      "kanban",
      { group_by_field: "status", card_fields: "amount" },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(false);
  });

  it("card_fields is optional (absent is fine)", () => {
    const result = validateViewConfig("kanban", { group_by_field: "status" }, RECORD_SCHEMA);
    expect(result.valid).toBe(true);
  });
});

describe("T-0582 AC-2: validateKanbanViewConfig — columns_order", () => {
  it("accepts an absent columns_order", () => {
    expect(validateViewConfig("kanban", { group_by_field: "status" }, RECORD_SCHEMA).valid).toBe(true);
  });

  it("accepts a string-array columns_order (values outside the current enum are a UI/build-time concern, not a validator rejection)", () => {
    const result = validateViewConfig(
      "kanban",
      { group_by_field: "status", columns_order: ["won", "open", "lost", "stale_value_not_in_enum"] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a non-array columns_order", () => {
    const result = validateViewConfig("kanban", { group_by_field: "status", columns_order: "won" }, RECORD_SCHEMA);
    expect(result.valid).toBe(false);
  });

  it("rejects a columns_order array with a non-string entry", () => {
    const result = validateViewConfig("kanban", { group_by_field: "status", columns_order: ["won", 5] }, RECORD_SCHEMA);
    expect(result.valid).toBe(false);
  });
});

describe("T-0582 AC-2/NF-2: validateKanbanViewConfig — filters/sort REUSE the 'list' table (no second copy)", () => {
  it("rejects an operator invalid for the field's type — same table as 'list'", () => {
    const result = validateViewConfig(
      "kanban",
      { group_by_field: "status", filters: [{ field_key: "is_active", op: "gt", value: true }] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("is_active"))).toBe(true);
  });

  it("rejects ANY filter on a computed/collection field — mirrors 'list'", () => {
    const result = validateViewConfig(
      "kanban",
      { group_by_field: "status", filters: [{ field_key: "total", op: "eq", value: 1 }] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(false);
  });

  it("accepts a valid filter", () => {
    const result = validateViewConfig(
      "kanban",
      { group_by_field: "status", filters: [{ field_key: "amount", op: "gte", value: 100 }] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects sort on a non-server-sortable field — mirrors 'list'", () => {
    const result = validateViewConfig(
      "kanban",
      { group_by_field: "status", sort: [{ field_key: "linked", dir: "asc" }] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(false);
  });

  it("accepts sort on a server-sortable field (orders cards within a column)", () => {
    const result = validateViewConfig(
      "kanban",
      { group_by_field: "status", sort: [{ field_key: "amount", dir: "desc" }] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a malformed sort dir — mirrors 'list'", () => {
    const result = validateViewConfig(
      "kanban",
      { group_by_field: "status", sort: [{ field_key: "amount", dir: "ascending" }] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(false);
  });
});

describe("T-0582: validateKanbanViewConfig — malformed top-level config", () => {
  it("rejects a non-object config", () => {
    expect(validateViewConfig("kanban", null, RECORD_SCHEMA).valid).toBe(false);
    expect(validateViewConfig("kanban", "nope", RECORD_SCHEMA).valid).toBe(false);
    expect(validateViewConfig("kanban", [], RECORD_SCHEMA).valid).toBe(false);
  });
});

describe("T-0582 AC-3: enumValuesForSelectField — reads record_schema.properties[key].enum", () => {
  it("returns the enum array for a select field", () => {
    expect(enumValuesForSelectField(RECORD_SCHEMA, "status")).toEqual(["open", "won", "lost"]);
  });

  it("returns [] for a non-select field", () => {
    expect(enumValuesForSelectField(RECORD_SCHEMA, "amount")).toEqual([]);
  });

  it("returns [] for an unknown field key", () => {
    expect(enumValuesForSelectField(RECORD_SCHEMA, "ghost")).toEqual([]);
  });

  it("never throws on a malformed schema", () => {
    expect(enumValuesForSelectField(null, "status")).toEqual([]);
    expect(enumValuesForSelectField("garbage", "status")).toEqual([]);
    expect(enumValuesForSelectField({}, "status")).toEqual([]);
  });
});

describe("columns validation", () => {
  it("rejects a column with an unknown field_key", () => {
    const result = validateViewConfig(
      "list",
      { columns: [{ field_key: "ghost_field", visible: true }] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(false);
  });

  it("accepts the created_at pseudo-column", () => {
    const result = validateViewConfig(
      "list",
      { columns: [{ field_key: "created_at", visible: true }] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a non-boolean visible", () => {
    const result = validateViewConfig(
      "list",
      { columns: [{ field_key: "amount", visible: "yes" }] },
      RECORD_SCHEMA,
    );
    expect(result.valid).toBe(false);
  });
});

describe("NF-2/AC-9: defaultViewConfig is byte-equivalent to today's autogen list", () => {
  it("includes every schema field (x-field-order) + created_at, all visible, no filters, sort=created_at desc", () => {
    const cfg = defaultViewConfig(RECORD_SCHEMA);
    expect(cfg.columns.map((c) => c.field_key)).toEqual([
      "amount", "status", "is_active", "notes", "tags", "owner", "linked", "total", "steps", "created_at",
    ]);
    expect(cfg.columns.every((c) => c.visible)).toBe(true);
    expect(cfg.filters).toEqual([]);
    expect(cfg.sort).toEqual([{ field_key: "created_at", dir: "desc" }]);
  });

  it("empty schema still yields the created_at pseudo-column default", () => {
    const cfg = defaultViewConfig({});
    expect(cfg.columns).toEqual([{ field_key: "created_at", visible: true }]);
  });
});
