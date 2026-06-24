/**
 * T-0433 — Unit tests for src/core/dmn-rule-table-validate.ts
 *
 * Pure function tests — no IO, no DB, no pg.
 *
 * Covers:
 *   - Well-formed 2-rule FIRST table → ok: true
 *   - Missing name → NAME_EMPTY violation
 *   - hitPolicy !== 'FIRST' → HIT_POLICY_UNSUPPORTED violation
 *   - Empty rules array → RULES_EMPTY violation
 *   - Unknown operator → UNKNOWN_OPERATOR violation (named)
 *   - Rule with no set_routing_outcome effect → MISSING_ROUTING_OUTCOME violation
 *   - Inconsistent routing-outcome names across rules → INCONSISTENT_ROUTING_NAME violation
 *   - All violations are named (code is present on each)
 */

import { describe, it, expect } from "vitest";
import { validateDmnRuleTable } from "../core/dmn-rule-table-validate.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** A canonical 2-rule FIRST table with consistent routing outcome. */
function wellFormedTable(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "ТЭЛ: порог суммы закупки",
    hitPolicy: "FIRST",
    rules: [
      {
        annotation: "Сумма > 5 000 000 ₽ — требуется доп. согласование",
        conditions: [{ field: "amount", operator: "gt", value: 5000000 }],
        effects: [
          { kind: "set_routing_outcome", name: "approvalRequired", value: "needs-approval" },
        ],
      },
      {
        annotation: "Стандартный трек (сумма в пределах порога)",
        conditions: [],
        effects: [
          { kind: "set_routing_outcome", name: "approvalRequired", value: "standard" },
        ],
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — acceptance of valid input
// ---------------------------------------------------------------------------

describe("validateDmnRuleTable — well-formed input", () => {
  it("accepts a well-formed 2-rule FIRST table", () => {
    const result = validateDmnRuleTable(wellFormedTable());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("ТЭЛ: порог суммы закупки");
    expect(result.value.hitPolicy).toBe("FIRST");
    expect(result.value.rules).toHaveLength(2);
  });

  it("accepts a table with multiple condition operators (gt, eq, in, present, absent)", () => {
    const result = validateDmnRuleTable({
      name: "Multi-operator test",
      hitPolicy: "FIRST",
      rules: [
        {
          conditions: [
            { field: "amount", operator: "gt", value: 100 },
            { field: "category", operator: "eq", value: "IT" },
            { field: "tags", operator: "in", value: ["a", "b"] },
            { field: "supplier", operator: "present" },
          ],
          effects: [
            { kind: "set_routing_outcome", name: "outcome", value: "matched" },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("preserves id from the input when it is a valid UUID", () => {
    const id = "aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb";
    const result = validateDmnRuleTable(wellFormedTable({ id }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(id);
  });

  it("sets id to empty string when not supplied (upsertRuleTableDraft allocates UUID)", () => {
    const input = wellFormedTable();
    (input as Record<string, unknown>)["id"] = undefined;
    const result = validateDmnRuleTable(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Tests — violations
// ---------------------------------------------------------------------------

describe("validateDmnRuleTable — violations", () => {
  it("returns NAME_EMPTY when name is missing", () => {
    const result = validateDmnRuleTable({ ...wellFormedTable() as object, name: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain("NAME_EMPTY");
  });

  it("returns NAME_EMPTY when name is whitespace-only", () => {
    const result = validateDmnRuleTable({ ...wellFormedTable() as object, name: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.some((v) => v.code === "NAME_EMPTY")).toBe(true);
  });

  it("returns NAME_EMPTY when name is absent", () => {
    const input = { ...wellFormedTable() as object };
    delete (input as Record<string, unknown>)["name"];
    const result = validateDmnRuleTable(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.some((v) => v.code === "NAME_EMPTY")).toBe(true);
  });

  it("returns HIT_POLICY_UNSUPPORTED when hitPolicy is COLLECT", () => {
    const result = validateDmnRuleTable({ ...wellFormedTable() as object, hitPolicy: "COLLECT" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain("HIT_POLICY_UNSUPPORTED");
  });

  it("returns HIT_POLICY_UNSUPPORTED when hitPolicy is an unknown string", () => {
    const result = validateDmnRuleTable({ ...wellFormedTable() as object, hitPolicy: "UNIQUE" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.some((v) => v.code === "HIT_POLICY_UNSUPPORTED")).toBe(true);
  });

  it("returns RULES_EMPTY when rules array is empty", () => {
    const result = validateDmnRuleTable({ ...wellFormedTable() as object, rules: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.some((v) => v.code === "RULES_EMPTY")).toBe(true);
  });

  it("returns UNKNOWN_OPERATOR for an invalid operator string", () => {
    const result = validateDmnRuleTable({
      name: "Bad operator",
      hitPolicy: "FIRST",
      rules: [
        {
          conditions: [{ field: "amount", operator: "BETWEEN", value: [100, 500] }],
          effects: [{ kind: "set_routing_outcome", name: "route", value: "ok" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain("UNKNOWN_OPERATOR");
  });

  it("reports ruleIndex on UNKNOWN_OPERATOR violation", () => {
    const result = validateDmnRuleTable({
      name: "Bad operator",
      hitPolicy: "FIRST",
      rules: [
        {
          // rule 0: valid
          conditions: [],
          effects: [{ kind: "set_routing_outcome", name: "route", value: "ok" }],
        },
        {
          // rule 1: bad operator
          conditions: [{ field: "x", operator: "invalid_op" }],
          effects: [{ kind: "set_routing_outcome", name: "route", value: "fail" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const opViolation = result.violations.find((v) => v.code === "UNKNOWN_OPERATOR");
    expect(opViolation).toBeDefined();
    expect(opViolation?.ruleIndex).toBe(1);
  });

  it("returns MISSING_ROUTING_OUTCOME when a rule has no set_routing_outcome effect", () => {
    const result = validateDmnRuleTable({
      name: "No routing",
      hitPolicy: "FIRST",
      rules: [
        {
          conditions: [],
          effects: [
            { kind: "set_visibility", field: "x", visible: true },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.some((v) => v.code === "MISSING_ROUTING_OUTCOME")).toBe(true);
  });

  it("returns INCONSISTENT_ROUTING_NAME when rules use different routing-outcome names", () => {
    const result = validateDmnRuleTable({
      name: "Inconsistent names",
      hitPolicy: "FIRST",
      rules: [
        {
          conditions: [{ field: "amount", operator: "gt", value: 1000 }],
          effects: [{ kind: "set_routing_outcome", name: "outcomeName", value: "high" }],
        },
        {
          conditions: [],
          effects: [{ kind: "set_routing_outcome", name: "differentName", value: "low" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.some((v) => v.code === "INCONSISTENT_ROUTING_NAME")).toBe(true);
  });

  it("violations have both code and message", () => {
    const result = validateDmnRuleTable({
      name: "",
      hitPolicy: "COLLECT",
      rules: [
        {
          conditions: [{ field: "x", operator: "notareal" }],
          effects: [],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const v of result.violations) {
      expect(typeof v.code).toBe("string");
      expect(v.code.length).toBeGreaterThan(0);
      expect(typeof v.message).toBe("string");
      expect(v.message.length).toBeGreaterThan(0);
    }
  });

  it("returns ok:false when input is not an object", () => {
    expect(validateDmnRuleTable("not an object").ok).toBe(false);
    expect(validateDmnRuleTable(null).ok).toBe(false);
    expect(validateDmnRuleTable([]).ok).toBe(false);
    expect(validateDmnRuleTable(42).ok).toBe(false);
  });
});
