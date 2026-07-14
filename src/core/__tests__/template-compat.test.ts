/**
 * T-0235 · T-0124: Unit tests for checkTemplateDepFields (no I/O, no DB).
 *
 * Mirrors binding-compat.test.ts (T-0072) and report-page-compat discipline.
 * Pure function under test — all assertions are synchronous.
 *
 * FF-TEMPLATE-COHERENCE: checkTemplateDepFields is the zero-I/O check mirror
 * of checkBindingCompat (T-0072) / checkReportPageDepFields (T-0121).
 * One control plane for «artifact ↔ schema field» coherence (NF-1 ADR §2.9).
 */

import { describe, it, expect } from "vitest";
import {
  checkTemplateDepFields,
  type TemplateDep,
  type TemplateJsonSchema,
} from "../template-compat.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dep(
  fieldKey: string,
  depKind: "read" | "aggregate" = "read",
  stale = false,
): TemplateDep {
  return {
    templateId: "tmpl-001",
    registryDefId: "reg-001",
    fieldKey,
    depKind,
    stale,
  };
}

function schema(...keys: string[]): TemplateJsonSchema {
  const properties: Record<string, unknown> = {};
  for (const k of keys) {
    properties[k] = { type: "string" };
  }
  return { properties };
}

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

describe("checkTemplateDepFields — happy path", () => {
  it("returns ok:true when all dep fieldKeys are present in schema", () => {
    const deps: TemplateDep[] = [dep("status"), dep("contractNo"), dep("date", "aggregate")];
    const s = schema("status", "contractNo", "date", "amount");
    const result = checkTemplateDepFields(deps, s);
    expect(result.ok).toBe(true);
  });

  it("returns ok:true when deps array is empty", () => {
    const result = checkTemplateDepFields([], schema("foo", "bar"));
    expect(result.ok).toBe(true);
  });

  it("returns ok:true when schema has no properties (empty schema) and no deps", () => {
    const result = checkTemplateDepFields([], {});
    expect(result.ok).toBe(true);
  });

  it("returns ok:true when dep is stale — stale deps are skipped", () => {
    // stale=true dep whose field is NOT in schema should be ignored
    const deps: TemplateDep[] = [dep("deleted_field", "read", true)];
    const result = checkTemplateDepFields(deps, schema("other_field"));
    expect(result.ok).toBe(true);
  });

  it("returns ok:true when mix of stale (field absent) and non-stale (field present)", () => {
    const deps: TemplateDep[] = [
      dep("active_field", "read", false),
      dep("gone_field", "read", true), // stale — ignored
    ];
    const result = checkTemplateDepFields(deps, schema("active_field"));
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Violation tests
// ---------------------------------------------------------------------------

describe("checkTemplateDepFields — violations", () => {
  it("returns ok:false with missing_in_schema when fieldKey not in schema", () => {
    const deps: TemplateDep[] = [dep("missing_field")];
    const s = schema("other_field");
    const result = checkTemplateDepFields(deps, s);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].type).toBe("missing_in_schema");
      expect(result.violations[0].fieldKey).toBe("missing_field");
      expect(result.violations[0].templateId).toBe("tmpl-001");
      expect(result.violations[0].registryDefId).toBe("reg-001");
    }
  });

  it("reports all missing fields when multiple deps are absent", () => {
    const deps: TemplateDep[] = [dep("fieldA"), dep("fieldB"), dep("fieldC")];
    const s = schema("fieldB"); // only fieldB present
    const result = checkTemplateDepFields(deps, s);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(2);
      const keys = result.violations.map((v) => v.fieldKey).sort();
      expect(keys).toEqual(["fieldA", "fieldC"]);
    }
  });

  it("returns ok:false when schema has no properties and there are non-stale deps", () => {
    const deps: TemplateDep[] = [dep("anyField")];
    const result = checkTemplateDepFields(deps, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0].type).toBe("missing_in_schema");
    }
  });

  it("non-stale dep on absent field with stale dep on also-absent field: only non-stale is a violation", () => {
    const deps: TemplateDep[] = [
      dep("active_missing", "read", false),
      dep("stale_missing", "read", true),
    ];
    const result = checkTemplateDepFields(deps, schema("something_else"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].fieldKey).toBe("active_missing");
    }
  });
});

// ---------------------------------------------------------------------------
// dep_kind coverage
// ---------------------------------------------------------------------------

describe("checkTemplateDepFields — dep_kind semantics", () => {
  it("aggregate dep is treated same as read for coherence check", () => {
    // 'aggregate' fieldKey must still be in schema
    const deps: TemplateDep[] = [dep("amount", "aggregate")];
    const s = schema("amount");
    expect(checkTemplateDepFields(deps, s).ok).toBe(true);

    const s2 = schema("other");
    const result = checkTemplateDepFields(deps, s2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0].fieldKey).toBe("amount");
    }
  });
});

// ---------------------------------------------------------------------------
// Message format
// ---------------------------------------------------------------------------

describe("checkTemplateDepFields — violation message", () => {
  it("includes templateId, registryDefId and fieldKey in message", () => {
    const dep1: TemplateDep = {
      templateId: "tmpl-xyz",
      registryDefId: "reg-abc",
      fieldKey: "contractStatus",
      depKind: "read",
      stale: false,
    };
    const result = checkTemplateDepFields([dep1], {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const msg = result.violations[0].message;
      expect(msg).toContain("contractStatus");
      expect(msg).toContain("reg-abc");
      expect(msg).toContain("tmpl-xyz");
    }
  });
});
