/**
 * T-0075 · E11.4 — Unit tests for src/core/dmn-middle.ts
 *
 * Tests cover:
 *   - Operator evaluation (all 10 operators)
 *   - FIRST hit-policy (stops at first match)
 *   - COLLECT hit-policy (accumulates all matches)
 *   - All effect kinds (set_visibility, set_required, add_validation_error, set_routing_outcome)
 *   - Empty conditions (unconditional row)
 *   - Empty tables (zero rules)
 *   - Multiple tables evaluated independently
 *   - mergeVisibility / mergeRequiredness helpers
 *   - Determinism: same input → same output
 *   - Edge cases: empty bindings, unknown fields
 */

import { describe, it, expect } from "vitest";
import {
  evaluate,
  mergeVisibility,
  mergeRequiredness,
  type DmnRuleTable,
  type NamedBindings,
} from "../dmn-middle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function table(overrides: Partial<DmnRuleTable> & Pick<DmnRuleTable, "rules">): DmnRuleTable {
  return {
    id: "test-table",
    name: "Test Table",
    hitPolicy: "FIRST",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Operator tests
// ---------------------------------------------------------------------------

describe("evalCondition operators", () => {
  it("eq: matches equal value", () => {
    const t = table({
      rules: [
        {
          conditions: [{ field: "status", operator: "eq", value: "approved" }],
          effects: [{ kind: "set_routing_outcome", name: "route", value: "approved-path" }],
        },
      ],
    });
    const r = evaluate([t], { status: "approved" });
    expect(r.routingOutcomes["route"]).toBe("approved-path");
  });

  it("eq: does not match different value", () => {
    const t = table({
      rules: [
        {
          conditions: [{ field: "status", operator: "eq", value: "approved" }],
          effects: [{ kind: "set_routing_outcome", name: "route", value: "approved-path" }],
        },
      ],
    });
    const r = evaluate([t], { status: "rejected" });
    expect(r.routingOutcomes["route"]).toBeUndefined();
  });

  it("neq: matches when value differs", () => {
    const t = table({
      rules: [
        {
          conditions: [{ field: "status", operator: "neq", value: "pending" }],
          effects: [{ kind: "set_visibility", field: "reason", visible: true }],
        },
      ],
    });
    const r = evaluate([t], { status: "approved" });
    expect(r.visibilityOverrides["reason"]).toBe(true);
  });

  it("gt: fires when number exceeds threshold", () => {
    const t = table({
      rules: [
        {
          conditions: [{ field: "amount", operator: "gt", value: 10000 }],
          effects: [{ kind: "set_required", field: "approval_comment", required: true }],
        },
      ],
    });
    expect(evaluate([t], { amount: 15000 }).requirednessOverrides["approval_comment"]).toBe(true);
    expect(evaluate([t], { amount: 9999 }).requirednessOverrides["approval_comment"]).toBeUndefined();
    expect(evaluate([t], { amount: 10000 }).requirednessOverrides["approval_comment"]).toBeUndefined();
  });

  it("gte: fires when equal or exceeds", () => {
    const t = table({
      rules: [
        {
          conditions: [{ field: "amount", operator: "gte", value: 10000 }],
          effects: [{ kind: "set_required", field: "budget_ref", required: true }],
        },
      ],
    });
    expect(evaluate([t], { amount: 10000 }).requirednessOverrides["budget_ref"]).toBe(true);
    expect(evaluate([t], { amount: 10001 }).requirednessOverrides["budget_ref"]).toBe(true);
    expect(evaluate([t], { amount: 9999 }).requirednessOverrides["budget_ref"]).toBeUndefined();
  });

  it("lt: fires when below threshold", () => {
    const t = table({
      rules: [
        {
          conditions: [{ field: "qty", operator: "lt", value: 5 }],
          effects: [{ kind: "set_visibility", field: "bulk_discount", visible: false }],
        },
      ],
    });
    expect(evaluate([t], { qty: 4 }).visibilityOverrides["bulk_discount"]).toBe(false);
    expect(evaluate([t], { qty: 5 }).visibilityOverrides["bulk_discount"]).toBeUndefined();
  });

  it("lte: fires when at or below threshold", () => {
    const t = table({
      rules: [
        {
          conditions: [{ field: "qty", operator: "lte", value: 5 }],
          effects: [{ kind: "set_visibility", field: "bulk_discount", visible: false }],
        },
      ],
    });
    expect(evaluate([t], { qty: 5 }).visibilityOverrides["bulk_discount"]).toBe(false);
    expect(evaluate([t], { qty: 6 }).visibilityOverrides["bulk_discount"]).toBeUndefined();
  });

  it("in: fires when value is in the set", () => {
    const t = table({
      rules: [
        {
          conditions: [{ field: "category", operator: "in", value: ["IT", "software"] }],
          effects: [{ kind: "set_required", field: "asset_tag", required: true }],
        },
      ],
    });
    expect(evaluate([t], { category: "IT" }).requirednessOverrides["asset_tag"]).toBe(true);
    expect(evaluate([t], { category: "software" }).requirednessOverrides["asset_tag"]).toBe(true);
    expect(evaluate([t], { category: "furniture" }).requirednessOverrides["asset_tag"]).toBeUndefined();
  });

  it("nin: fires when value is NOT in the set", () => {
    const t = table({
      rules: [
        {
          conditions: [{ field: "method", operator: "nin", value: ["direct", "framework"] }],
          effects: [{ kind: "set_routing_outcome", name: "method_check", value: "other" }],
        },
      ],
    });
    expect(evaluate([t], { method: "tender" }).routingOutcomes["method_check"]).toBe("other");
    expect(evaluate([t], { method: "direct" }).routingOutcomes["method_check"]).toBeUndefined();
  });

  it("present: fires when field has a value", () => {
    const t = table({
      rules: [
        {
          conditions: [{ field: "supplier", operator: "present" }],
          effects: [{ kind: "set_visibility", field: "supplier_rating", visible: true }],
        },
      ],
    });
    expect(evaluate([t], { supplier: "ACME" }).visibilityOverrides["supplier_rating"]).toBe(true);
    expect(evaluate([t], { supplier: "" }).visibilityOverrides["supplier_rating"]).toBeUndefined();
    expect(evaluate([t], {}).visibilityOverrides["supplier_rating"]).toBeUndefined();
  });

  it("absent: fires when field is missing / null / empty", () => {
    const t = table({
      rules: [
        {
          conditions: [{ field: "supplier", operator: "absent" }],
          effects: [{ kind: "add_validation_error", field: "supplier", message: "Supplier is required" }],
        },
      ],
    });
    expect(evaluate([t], {}).validationErrors).toHaveLength(1);
    expect(evaluate([t], { supplier: null }).validationErrors).toHaveLength(1);
    expect(evaluate([t], { supplier: "" }).validationErrors).toHaveLength(1);
    expect(evaluate([t], { supplier: "ACME" }).validationErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Hit-policy tests
// ---------------------------------------------------------------------------

describe("hit-policy FIRST", () => {
  it("stops after first matching row", () => {
    const t = table({
      hitPolicy: "FIRST",
      rules: [
        {
          conditions: [{ field: "amount", operator: "gt", value: 5000 }],
          effects: [{ kind: "set_routing_outcome", name: "approver", value: "manager" }],
        },
        {
          conditions: [{ field: "amount", operator: "gt", value: 1000 }],
          effects: [{ kind: "set_routing_outcome", name: "approver", value: "supervisor" }],
        },
      ],
    });
    // Both conditions match amount=10000, but FIRST stops at row 0
    const r = evaluate([t], { amount: 10000 });
    expect(r.routingOutcomes["approver"]).toBe("manager");
    expect(r.rulesMatched).toBe(1);
  });

  it("falls through to second row when first does not match", () => {
    const t = table({
      hitPolicy: "FIRST",
      rules: [
        {
          conditions: [{ field: "amount", operator: "gt", value: 5000 }],
          effects: [{ kind: "set_routing_outcome", name: "approver", value: "manager" }],
        },
        {
          conditions: [{ field: "amount", operator: "gt", value: 1000 }],
          effects: [{ kind: "set_routing_outcome", name: "approver", value: "supervisor" }],
        },
      ],
    });
    // Only second condition matches amount=3000
    const r = evaluate([t], { amount: 3000 });
    expect(r.routingOutcomes["approver"]).toBe("supervisor");
    expect(r.rulesMatched).toBe(1);
  });
});

describe("hit-policy COLLECT", () => {
  it("applies all matching rows (last-write-wins for same key)", () => {
    const t = table({
      hitPolicy: "COLLECT",
      rules: [
        {
          conditions: [{ field: "urgent", operator: "eq", value: true }],
          effects: [{ kind: "set_routing_outcome", name: "priority", value: "high" }],
        },
        {
          conditions: [{ field: "amount", operator: "gt", value: 50000 }],
          effects: [{ kind: "set_routing_outcome", name: "priority", value: "critical" }],
        },
      ],
    });
    // Both fire → last write wins → critical
    const r = evaluate([t], { urgent: true, amount: 100000 });
    expect(r.routingOutcomes["priority"]).toBe("critical");
    expect(r.rulesMatched).toBe(2);
  });

  it("collects validation errors from all matching rows", () => {
    const t = table({
      hitPolicy: "COLLECT",
      rules: [
        {
          conditions: [{ field: "supplier", operator: "absent" }],
          effects: [{ kind: "add_validation_error", field: "supplier", message: "Required" }],
        },
        {
          conditions: [{ field: "subject", operator: "absent" }],
          effects: [{ kind: "add_validation_error", field: "subject", message: "Required" }],
        },
      ],
    });
    const r = evaluate([t], {});
    expect(r.validationErrors).toHaveLength(2);
    expect(r.validationErrors.map((e) => e.field)).toContain("supplier");
    expect(r.validationErrors.map((e) => e.field)).toContain("subject");
  });
});

// ---------------------------------------------------------------------------
// Unconditional row (empty conditions)
// ---------------------------------------------------------------------------

describe("unconditional row", () => {
  it("fires when conditions array is empty", () => {
    const t = table({
      rules: [
        {
          conditions: [],
          effects: [{ kind: "set_routing_outcome", name: "default", value: "yes" }],
        },
      ],
    });
    const r = evaluate([t], {});
    expect(r.routingOutcomes["default"]).toBe("yes");
  });
});

// ---------------------------------------------------------------------------
// Empty table / empty binding
// ---------------------------------------------------------------------------

describe("empty table / empty bindings", () => {
  it("zero rules → zero matches", () => {
    const t = table({ rules: [] });
    const r = evaluate([t], { foo: "bar" });
    expect(r.rulesMatched).toBe(0);
    expect(r.tablesEvaluated).toBe(1);
    expect(Object.keys(r.visibilityOverrides)).toHaveLength(0);
  });

  it("empty bindings → conditions requiring field are not satisfied", () => {
    const t = table({
      rules: [
        {
          conditions: [{ field: "amount", operator: "gt", value: 0 }],
          effects: [{ kind: "set_visibility", field: "details", visible: true }],
        },
      ],
    });
    const r = evaluate([t], {});
    expect(r.visibilityOverrides["details"]).toBeUndefined();
    expect(r.rulesMatched).toBe(0);
  });

  it("zero tables → all empty results", () => {
    const r = evaluate([], { amount: 999 });
    expect(r.tablesEvaluated).toBe(0);
    expect(r.rulesMatched).toBe(0);
    expect(Object.keys(r.visibilityOverrides)).toHaveLength(0);
    expect(r.validationErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multiple conditions in one row (AND semantics)
// ---------------------------------------------------------------------------

describe("multiple conditions (AND semantics)", () => {
  it("all conditions must be satisfied", () => {
    const t = table({
      rules: [
        {
          conditions: [
            { field: "category", operator: "eq", value: "IT" },
            { field: "amount", operator: "gt", value: 5000 },
          ],
          effects: [{ kind: "set_required", field: "tech_approval", required: true }],
        },
      ],
    });
    // Both met
    expect(evaluate([t], { category: "IT", amount: 6000 }).requirednessOverrides["tech_approval"]).toBe(true);
    // Only first met
    expect(evaluate([t], { category: "IT", amount: 3000 }).requirednessOverrides["tech_approval"]).toBeUndefined();
    // Only second met
    expect(evaluate([t], { category: "HR", amount: 6000 }).requirednessOverrides["tech_approval"]).toBeUndefined();
    // Neither met
    expect(evaluate([t], { category: "HR", amount: 3000 }).requirednessOverrides["tech_approval"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Multiple tables evaluated independently
// ---------------------------------------------------------------------------

describe("multiple tables", () => {
  it("evaluates each table independently and merges results", () => {
    const t1 = table({
      id: "table-visibility",
      name: "Visibility Rules",
      hitPolicy: "FIRST",
      rules: [
        {
          conditions: [{ field: "urgent", operator: "eq", value: true }],
          effects: [{ kind: "set_visibility", field: "escalation_path", visible: true }],
        },
      ],
    });
    const t2 = table({
      id: "table-routing",
      name: "Routing Rules",
      hitPolicy: "FIRST",
      rules: [
        {
          conditions: [{ field: "amount", operator: "gt", value: 1000 }],
          effects: [{ kind: "set_routing_outcome", name: "approver_tier", value: "manager" }],
        },
      ],
    });
    const r = evaluate([t1, t2], { urgent: true, amount: 5000 });
    expect(r.tablesEvaluated).toBe(2);
    expect(r.rulesMatched).toBe(2);
    expect(r.visibilityOverrides["escalation_path"]).toBe(true);
    expect(r.routingOutcomes["approver_tier"]).toBe("manager");
  });

  it("tableId is correctly reported in validation errors", () => {
    const t1 = table({
      id: "validity-check",
      name: "Validity",
      hitPolicy: "FIRST",
      rules: [
        {
          conditions: [{ field: "budget_code", operator: "absent" }],
          effects: [{ kind: "add_validation_error", field: "budget_code", message: "Required" }],
        },
      ],
    });
    const r = evaluate([t1], {});
    expect(r.validationErrors[0]?.tableId).toBe("validity-check");
  });
});

// ---------------------------------------------------------------------------
// mergeVisibility helper
// ---------------------------------------------------------------------------

describe("mergeVisibility", () => {
  it("shows hidden fields when DMN sets visible:true", () => {
    const floor1 = new Set(["name", "email"]);
    const result = evaluate(
      [
        table({
          rules: [
            {
              conditions: [],
              effects: [{ kind: "set_visibility", field: "phone", visible: true }],
            },
          ],
        }),
      ],
      {},
    );
    const eff = mergeVisibility(floor1, result);
    expect(eff.has("name")).toBe(true);
    expect(eff.has("email")).toBe(true);
    expect(eff.has("phone")).toBe(true);
  });

  it("hides Floor-1 visible fields when DMN sets visible:false", () => {
    const floor1 = new Set(["name", "email", "phone"]);
    const result = evaluate(
      [
        table({
          rules: [
            {
              conditions: [],
              effects: [{ kind: "set_visibility", field: "phone", visible: false }],
            },
          ],
        }),
      ],
      {},
    );
    const eff = mergeVisibility(floor1, result);
    expect(eff.has("phone")).toBe(false);
    expect(eff.has("name")).toBe(true);
  });

  it("no DMN visibility effects → identical to floor1", () => {
    const floor1 = new Set(["a", "b", "c"]);
    const result = evaluate([], {});
    const eff = mergeVisibility(floor1, result);
    expect([...eff].sort()).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// mergeRequiredness helper
// ---------------------------------------------------------------------------

describe("mergeRequiredness", () => {
  it("adds new required field via DMN", () => {
    const floor1 = new Set(["name"]);
    const result = evaluate(
      [
        table({
          rules: [
            {
              conditions: [],
              effects: [{ kind: "set_required", field: "comment", required: true }],
            },
          ],
        }),
      ],
      {},
    );
    const eff = mergeRequiredness(floor1, result);
    expect(eff.has("name")).toBe(true);
    expect(eff.has("comment")).toBe(true);
  });

  it("removes a Floor-1 required field when DMN sets required:false", () => {
    const floor1 = new Set(["name", "email"]);
    const result = evaluate(
      [
        table({
          rules: [
            {
              conditions: [],
              effects: [{ kind: "set_required", field: "email", required: false }],
            },
          ],
        }),
      ],
      {},
    );
    const eff = mergeRequiredness(floor1, result);
    expect(eff.has("email")).toBe(false);
    expect(eff.has("name")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("same input always produces same output", () => {
    const t = table({
      hitPolicy: "COLLECT",
      rules: [
        {
          conditions: [{ field: "amount", operator: "gt", value: 1000 }],
          effects: [{ kind: "set_routing_outcome", name: "level", value: "L2" }],
        },
        {
          conditions: [{ field: "urgent", operator: "eq", value: true }],
          effects: [{ kind: "set_visibility", field: "escalation", visible: true }],
        },
      ],
    });
    const bindings: NamedBindings = { amount: 5000, urgent: true };
    const r1 = evaluate([t], bindings);
    const r2 = evaluate([t], bindings);
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// Practical procurement scenario (integration-style)
// ---------------------------------------------------------------------------

describe("procurement scenario", () => {
  // Rule table: 3-level approver routing for a procurement form.
  // amount > 100000 → legal review required
  // amount > 50000 → CFO approval required + legal_review visible
  // amount > 10000 → manager approval, finance_review required
  // method == 'tender' → tender_committee_required = true

  const procurementTable: DmnRuleTable = {
    id: "procurement-routing",
    name: "Procurement Routing",
    hitPolicy: "COLLECT",
    rules: [
      {
        conditions: [{ field: "amount", operator: "gt", value: 100000 }],
        effects: [
          { kind: "set_required", field: "legal_review", required: true },
          { kind: "set_visibility", field: "legal_review", visible: true },
          { kind: "set_routing_outcome", name: "approver", value: "board" },
        ],
        annotation: "Large purchase requires board + legal",
      },
      {
        conditions: [{ field: "amount", operator: "gt", value: 50000 }],
        effects: [
          { kind: "set_visibility", field: "legal_review", visible: true },
          { kind: "set_routing_outcome", name: "approver", value: "cfo" },
        ],
        annotation: "Medium-large: CFO",
      },
      {
        conditions: [{ field: "amount", operator: "gt", value: 10000 }],
        effects: [
          { kind: "set_required", field: "finance_review", required: true },
          { kind: "set_routing_outcome", name: "approver", value: "manager" },
        ],
        annotation: "Medium: manager + finance review",
      },
      {
        conditions: [{ field: "method", operator: "eq", value: "tender" }],
        effects: [{ kind: "set_routing_outcome", name: "tender_committee_required", value: "true" }],
        annotation: "Tender always needs committee",
      },
    ],
  };

  it("amount=150000, method=direct → board, legal required, legal visible", () => {
    const r = evaluate([procurementTable], { amount: 150000, method: "direct" });
    // Rows 0 (>100k), 1 (>50k), 2 (>10k) all fire (COLLECT)
    // Last write wins for 'approver' → manager (row 2 fires last)
    // But legal_review: required=true (row 0), visible=true (rows 0+1)
    expect(r.requirednessOverrides["legal_review"]).toBe(true);
    expect(r.visibilityOverrides["legal_review"]).toBe(true);
    expect(r.requirednessOverrides["finance_review"]).toBe(true);
    expect(r.rulesMatched).toBe(3);
  });

  it("amount=25000 → manager approver, no legal", () => {
    const r = evaluate([procurementTable], { amount: 25000 });
    expect(r.routingOutcomes["approver"]).toBe("manager");
    expect(r.requirednessOverrides["legal_review"]).toBeUndefined();
    expect(r.visibilityOverrides["legal_review"]).toBeUndefined();
  });

  it("amount=5000 → no routing, no overrides", () => {
    const r = evaluate([procurementTable], { amount: 5000 });
    expect(r.routingOutcomes["approver"]).toBeUndefined();
    expect(r.rulesMatched).toBe(0);
  });

  it("method=tender regardless of amount → tender_committee_required", () => {
    const r = evaluate([procurementTable], { amount: 500, method: "tender" });
    expect(r.routingOutcomes["tender_committee_required"]).toBe("true");
    expect(r.routingOutcomes["approver"]).toBeUndefined();
  });
});
