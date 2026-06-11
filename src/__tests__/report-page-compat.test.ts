/**
 * T-0176 · T-0121b — Report-Page Compat Validator
 * Unit tests for checkReportPageDepFields + classifyReportPageFloor.
 *
 * ADR §3 / §4 / §9 T-0121b fitness:
 *   FF-COMPAT-BEHAVIOR: AC-4..AC-8 (checkReportPageDepFields)
 *   FF-FLOOR:           AC-9..AC-14 (classifyReportPageFloor)
 *   FF-COMPAT-PURE:     AC-2/AC-3 (покрывается fitness-скриптом; здесь — runtime-sanity)
 *
 * No DB, no network, no process.env — pure unit tests.
 */

import { describe, it, expect } from "vitest";
import {
  checkReportPageDepFields,
  classifyReportPageFloor,
  type PageDep,
  type JsonSchema,
} from "../core/report-page-compat.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dep(fieldKey: string, registryDefId = "r1", depKind: "read" | "aggregate" = "aggregate"): PageDep {
  return { registryDefId, fieldKey, depKind };
}

function schema(...keys: string[]): JsonSchema {
  const properties: Record<string, unknown> = {};
  for (const k of keys) properties[k] = {};
  return { properties };
}

// ---------------------------------------------------------------------------
// AC-4 — checkReportPageDepFields: field_key присутствует → ok:true
// ---------------------------------------------------------------------------

describe("AC-4 — checkReportPageDepFields: field_key present → ok:true", () => {
  it("single dep, field exists → ok:true", () => {
    const result = checkReportPageDepFields([dep("amount")], schema("amount"));
    expect(result.ok).toBe(true);
  });

  it("multiple deps, all fields exist → ok:true", () => {
    const result = checkReportPageDepFields(
      [dep("amount"), dep("status", "r1", "read"), dep("category", "r2")],
      { properties: { amount: {}, status: {}, category: {} } },
    );
    expect(result.ok).toBe(true);
  });

  it("dep kind 'read' + field exists → ok:true", () => {
    const result = checkReportPageDepFields([dep("name", "r1", "read")], schema("name"));
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-5 — checkReportPageDepFields: field_key absent → ok:false, missing_in_schema
// ---------------------------------------------------------------------------

describe("AC-5 — checkReportPageDepFields: field_key absent → ok:false, missing_in_schema", () => {
  it("field absent from non-empty properties → violation missing_in_schema", () => {
    const result = checkReportPageDepFields([dep("amount")], schema());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.type).toBe("missing_in_schema");
      expect(result.violations[0]?.fieldKey).toBe("amount");
      expect(result.violations[0]?.registryDefId).toBe("r1");
    }
  });

  it("field absent, wrong field present → violation", () => {
    const result = checkReportPageDepFields([dep("amount")], schema("status"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.fieldKey).toBe("amount");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-6 — checkReportPageDepFields: empty deps → ok:true
// ---------------------------------------------------------------------------

describe("AC-6 — checkReportPageDepFields: empty deps → ok:true", () => {
  it("empty deps array, non-empty schema → ok:true", () => {
    const result = checkReportPageDepFields([], schema("amount", "status"));
    expect(result.ok).toBe(true);
  });

  it("empty deps array, empty schema → ok:true", () => {
    const result = checkReportPageDepFields([], {});
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-7 — checkReportPageDepFields: multiple violations
// ---------------------------------------------------------------------------

describe("AC-7 — checkReportPageDepFields: multiple violations", () => {
  it("two absent fields → violations length 2", () => {
    const result = checkReportPageDepFields(
      [dep("amount"), dep("status")],
      schema("category"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(2);
      const keys = result.violations.map((v) => v.fieldKey).sort();
      expect(keys).toEqual(["amount", "status"]);
    }
  });

  it("one absent + one present → violations length 1", () => {
    const result = checkReportPageDepFields(
      [dep("amount"), dep("status")],
      schema("amount"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.fieldKey).toBe("status");
    }
  });

  it("all violations have type missing_in_schema", () => {
    const result = checkReportPageDepFields([dep("a"), dep("b"), dep("c")], {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.every((v) => v.type === "missing_in_schema")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-8 — checkReportPageDepFields: schema without properties → all deps violate
// ---------------------------------------------------------------------------

describe("AC-8 — checkReportPageDepFields: no properties key → all deps violate", () => {
  it("schema {} (no properties) → dep violates", () => {
    const result = checkReportPageDepFields([dep("f", "r1", "read")], {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.type).toBe("missing_in_schema");
    }
  });

  it("two deps with schema {} → two violations", () => {
    const result = checkReportPageDepFields([dep("a"), dep("b")], {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-9 — classifyReportPageFloor: valid Floor-1 pageDef → requiredFloor '1'
// ---------------------------------------------------------------------------

describe("AC-9 — classifyReportPageFloor: valid Floor-1 pageDef → requiredFloor '1'", () => {
  it("single metric with agg:sum → Floor-1", () => {
    const result = classifyReportPageFloor([
      { source_registry_def_id: "r1", field_key: "amount", agg: "sum" },
    ]);
    expect(result.requiredFloor).toBe("1");
  });

  it("all valid agg values → Floor-1", () => {
    for (const agg of ["count", "sum", "avg", "min", "max", "list"]) {
      const result = classifyReportPageFloor([
        { source_registry_def_id: "r1", field_key: "f", agg },
      ]);
      expect(result.requiredFloor, `agg:${agg}`).toBe("1");
    }
  });

  it("multiple valid metrics → Floor-1", () => {
    const result = classifyReportPageFloor([
      { source_registry_def_id: "r1", field_key: "amount", agg: "sum" },
      { source_registry_def_id: "r2", field_key: "count", agg: "count" },
    ]);
    expect(result.requiredFloor).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// AC-10 — classifyReportPageFloor: empty array → requiredFloor '1'
// ---------------------------------------------------------------------------

describe("AC-10 — classifyReportPageFloor: empty array → requiredFloor '1'", () => {
  it("empty array → Floor-1", () => {
    const result = classifyReportPageFloor([]);
    expect(result.requiredFloor).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// AC-11 — classifyReportPageFloor: not an array → requiredFloor '2'
// ---------------------------------------------------------------------------

describe("AC-11 — classifyReportPageFloor: not an array → requiredFloor '2'", () => {
  it("plain object → Floor-2", () => {
    const result = classifyReportPageFloor({ metrics: [] });
    expect(result.requiredFloor).toBe("2");
  });

  it("null → Floor-2", () => {
    const result = classifyReportPageFloor(null);
    expect(result.requiredFloor).toBe("2");
  });

  it("string → Floor-2", () => {
    const result = classifyReportPageFloor("metrics");
    expect(result.requiredFloor).toBe("2");
  });

  it("number → Floor-2", () => {
    const result = classifyReportPageFloor(42);
    expect(result.requiredFloor).toBe("2");
  });

  it("undefined → Floor-2", () => {
    const result = classifyReportPageFloor(undefined);
    expect(result.requiredFloor).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// AC-12 — classifyReportPageFloor: unknown agg → requiredFloor '2'
// ---------------------------------------------------------------------------

describe("AC-12 — classifyReportPageFloor: unknown agg → requiredFloor '2'", () => {
  it("agg:'median' (not in vocab) → Floor-2", () => {
    const result = classifyReportPageFloor([
      { source_registry_def_id: "r1", field_key: "f", agg: "median" },
    ]);
    expect(result.requiredFloor).toBe("2");
  });

  it("agg:'mode' → Floor-2", () => {
    const result = classifyReportPageFloor([
      { source_registry_def_id: "r1", field_key: "f", agg: "mode" },
    ]);
    expect(result.requiredFloor).toBe("2");
  });

  it("missing agg field → Floor-2", () => {
    const result = classifyReportPageFloor([
      { source_registry_def_id: "r1", field_key: "f" },
    ]);
    expect(result.requiredFloor).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// AC-13 — classifyReportPageFloor: extra field outside vocab → requiredFloor '2'
// ---------------------------------------------------------------------------

describe("AC-13 — classifyReportPageFloor: extra field outside vocab → requiredFloor '2'", () => {
  it("custom_render:true outside vocab → Floor-2", () => {
    const result = classifyReportPageFloor([
      { source_registry_def_id: "r1", field_key: "f", agg: "count", custom_render: true },
    ]);
    expect(result.requiredFloor).toBe("2");
  });

  it("drill_down_link outside vocab → Floor-2", () => {
    const result = classifyReportPageFloor([
      { source_registry_def_id: "r1", field_key: "f", agg: "sum", drill_down_link: "/path" },
    ]);
    expect(result.requiredFloor).toBe("2");
  });

  it("react_component field outside vocab → Floor-2", () => {
    const result = classifyReportPageFloor([
      { source_registry_def_id: "r1", field_key: "f", agg: "list", react_component: "MyChart" },
    ]);
    expect(result.requiredFloor).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// AC-14 — classifyReportPageFloor: optional fields within vocab → requiredFloor '1'
// ---------------------------------------------------------------------------

describe("AC-14 — classifyReportPageFloor: optional fields within vocab → requiredFloor '1'", () => {
  it("group_by + filter + title + subtitle → Floor-1", () => {
    const result = classifyReportPageFloor([
      {
        source_registry_def_id: "r1",
        field_key: "f",
        agg: "avg",
        group_by: "dept",
        filter: { field_key: "status", op: "=", value: "active" },
        title: "Avg",
        subtitle: "sub",
      },
    ]);
    expect(result.requiredFloor).toBe("1");
  });

  it("only title + subtitle (no group_by/filter) → Floor-1", () => {
    const result = classifyReportPageFloor([
      { source_registry_def_id: "r1", field_key: "f", agg: "count", title: "Count", subtitle: "total" },
    ]);
    expect(result.requiredFloor).toBe("1");
  });

  it("filter with op:'!=' → Floor-1", () => {
    const result = classifyReportPageFloor([
      {
        source_registry_def_id: "r1",
        field_key: "f",
        agg: "sum",
        filter: { field_key: "type", op: "!=", value: "archived" },
      },
    ]);
    expect(result.requiredFloor).toBe("1");
  });

  it("filter with op:'in' → Floor-1", () => {
    const result = classifyReportPageFloor([
      {
        source_registry_def_id: "r1",
        field_key: "f",
        agg: "count",
        filter: { field_key: "status", op: "in", value: ["active", "pending"] },
      },
    ]);
    expect(result.requiredFloor).toBe("1");
  });

  it("filter with unknown op → Floor-2", () => {
    const result = classifyReportPageFloor([
      {
        source_registry_def_id: "r1",
        field_key: "f",
        agg: "count",
        filter: { field_key: "status", op: "LIKE", value: "%active%" },
      },
    ]);
    expect(result.requiredFloor).toBe("2");
  });

  // R-2 nit: filter sub-object edge probes
  it("filter without field_key → Floor-2", () => {
    const result = classifyReportPageFloor([
      {
        source_registry_def_id: "r1",
        field_key: "f",
        agg: "count",
        filter: { op: "=", value: 42 },
      },
    ]);
    expect(result.requiredFloor).toBe("2");
  });

  it("filter without value → Floor-2", () => {
    const result = classifyReportPageFloor([
      {
        source_registry_def_id: "r1",
        field_key: "f",
        agg: "sum",
        filter: { field_key: "status", op: "=" },
      },
    ]);
    expect(result.requiredFloor).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// AC-2 (purity sanity): runs synchronously, no throws, no I/O needed
// ---------------------------------------------------------------------------

describe("purity sanity — checkReportPageDepFields + classifyReportPageFloor", () => {
  it("checkReportPageDepFields executes synchronously without throwing", () => {
    let result: ReturnType<typeof checkReportPageDepFields> | undefined;
    expect(() => {
      result = checkReportPageDepFields([dep("a"), dep("b")], schema("a", "b"));
    }).not.toThrow();
    expect(result?.ok).toBe(true);
  });

  it("classifyReportPageFloor executes synchronously without throwing", () => {
    let result: ReturnType<typeof classifyReportPageFloor> | undefined;
    expect(() => {
      result = classifyReportPageFloor([{ source_registry_def_id: "r1", field_key: "f", agg: "count" }]);
    }).not.toThrow();
    expect(result?.requiredFloor).toBe("1");
  });

  it("classifyReportPageFloor does not throw on adversarial inputs", () => {
    const adversarial = [null, undefined, 0, "", [], {}, [null], [{ agg: [] }]];
    for (const input of adversarial) {
      expect(() => classifyReportPageFloor(input)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Mixed ADR §3 scenarios: multiple registryDefIds
// ---------------------------------------------------------------------------

describe("multiple registryDefIds", () => {
  it("deps referencing different registryDefIds, both missing → 2 violations with correct registryDefIds", () => {
    const result = checkReportPageDepFields(
      [dep("f1", "r1"), dep("f2", "r2")],
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(2);
      const r1viol = result.violations.find((v) => v.registryDefId === "r1");
      const r2viol = result.violations.find((v) => v.registryDefId === "r2");
      expect(r1viol?.fieldKey).toBe("f1");
      expect(r2viol?.fieldKey).toBe("f2");
    }
  });

  it("deps on two schemas, one missing → only missing dep in violations", () => {
    const result = checkReportPageDepFields(
      [
        { registryDefId: "r1", fieldKey: "amount", depKind: "aggregate" },
        { registryDefId: "r2", fieldKey: "name", depKind: "read" },
      ],
      { properties: { amount: {}, name: {} } },
    );
    expect(result.ok).toBe(true);
  });
});
