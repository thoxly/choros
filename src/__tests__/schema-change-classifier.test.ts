/**
 * T-0177 · T-0121c — Schema-Change Classifier
 * Unit tests for classifySchemaChange (ADR §5 / spec AC-2..AC-6).
 *
 * No DB, no network, no process.env — pure unit tests.
 * Covers FF-SOFT-WARN + FF-DESTRUCTIVE-DENY (static / unit path).
 */

import { describe, it, expect } from "vitest";
import {
  classifySchemaChange,
  type AffectedDep,
  type JsonSchemaForClassify,
} from "../core/schema-change-classifier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dep(
  fieldKey: string,
  depKind: "read" | "aggregate" = "aggregate",
  pageId = "page-1",
  pageSlug = "my-report",
  registryDefId = "reg-1",
): AffectedDep {
  return { page_id: pageId, page_slug: pageSlug, registry_def_id: registryDefId, field_key: fieldKey, dep_kind: depKind };
}

function schema(fields: Record<string, unknown> = {}): JsonSchemaForClassify {
  return { properties: fields };
}

// ---------------------------------------------------------------------------
// AC-2 — Relabel-only / add field → softWarnings, no destructiveDeps
// ---------------------------------------------------------------------------

describe("AC-2 — soft changes produce warnings only, no destructive", () => {
  it("add new field with active dep on different field → no warnings, no destructive", () => {
    const old = schema({ amount: { type: "number" } });
    const newSch = schema({ amount: { type: "number" }, count: { type: "integer" } });
    const deps = [dep("amount")];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.softWarnings).toHaveLength(0);
    expect(result.destructiveDeps).toHaveLength(0);
  });

  it("relabel (title change) of field → no destructive, no warning for dep on that field", () => {
    const old = schema({ amount: { type: "number", title: "Old Title" } });
    const newSch = schema({ amount: { type: "number", title: "New Title" } });
    const deps = [dep("amount")];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.softWarnings).toHaveLength(0);
    expect(result.destructiveDeps).toHaveLength(0);
  });

  it("enum widening (more values) at aggregate dep → soft warning (not destructive)", () => {
    const old = schema({ status: { type: "string", enum: ["a", "b"] } });
    const newSch = schema({ status: { type: "string", enum: ["a", "b", "c"] } });
    const deps = [dep("status", "aggregate")];
    const result = classifySchemaChange(old, newSch, deps);
    // widening is NOT lossy → no destructive
    expect(result.destructiveDeps).toHaveLength(0);
    expect(result.softWarnings).toHaveLength(0);
  });

  it("toggle required (no type change) → no destructive", () => {
    const old = schema({ amount: { type: "number" } });
    const newSch = schema({ amount: { type: "number", required: true } });
    const deps = [dep("amount", "aggregate")];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.destructiveDeps).toHaveLength(0);
    expect(result.softWarnings).toHaveLength(0);
  });

  it("type-narrowing (number→integer) at READ dep → soft warning only", () => {
    // AC-5 counterpart
    const old = schema({ count: { type: "number" } });
    const newSch = schema({ count: { type: "integer" } });
    const deps = [dep("count", "read")];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.softWarnings).toHaveLength(1);
    expect(result.softWarnings[0]?.field_key).toBe("count");
    expect(result.destructiveDeps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-3 — Drop field_key → destructive
// ---------------------------------------------------------------------------

describe("AC-3 — drop field_key with active dep → destructive", () => {
  it("drop one field with one aggregate dep → destructiveDeps.length === 1", () => {
    const old = schema({ amount: { type: "number" } });
    const newSch = schema({});
    const deps = [dep("amount", "aggregate")];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.destructiveDeps).toHaveLength(1);
    expect(result.destructiveDeps[0]?.field_key).toBe("amount");
    expect(result.softWarnings).toHaveLength(0);
  });

  it("drop field with read dep → still destructive (drop is always destructive)", () => {
    const old = schema({ amount: { type: "number" } });
    const newSch = schema({});
    const deps = [dep("amount", "read")];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.destructiveDeps).toHaveLength(1);
  });

  it("drop field not in deps → no issue", () => {
    const old = schema({ amount: { type: "number" }, other: { type: "string" } });
    const newSch = schema({ amount: { type: "number" } });
    const deps = [dep("amount", "aggregate")];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.destructiveDeps).toHaveLength(0);
    expect(result.softWarnings).toHaveLength(0);
  });

  it("multiple deps on dropped field → all destructive", () => {
    const old = schema({ amount: { type: "number" } });
    const newSch = schema({});
    const deps = [
      dep("amount", "aggregate", "page-1", "report-1"),
      dep("amount", "read", "page-2", "report-2"),
    ];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.destructiveDeps).toHaveLength(2);
  });

  it("rename = drop old + add new → destructive for old dep", () => {
    // rename amount → amount_v2 (from dep's perspective: old key dropped)
    const old = schema({ amount: { type: "number" } });
    const newSch = schema({ amount_v2: { type: "number" } });
    const deps = [dep("amount", "aggregate")];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.destructiveDeps).toHaveLength(1);
    expect(result.destructiveDeps[0]?.field_key).toBe("amount");
  });
});

// ---------------------------------------------------------------------------
// AC-4 — lossy type-narrowing at aggregate dep → destructive
// ---------------------------------------------------------------------------

describe("AC-4 — lossy type-narrowing at aggregate → destructive", () => {
  it("number→integer at aggregate → destructive", () => {
    const old = schema({ count: { type: "number" } });
    const newSch = schema({ count: { type: "integer" } });
    const deps = [dep("count", "aggregate")];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.destructiveDeps).toHaveLength(1);
    expect(result.destructiveDeps[0]?.field_key).toBe("count");
    expect(result.softWarnings).toHaveLength(0);
  });

  it("string → enum (narrowing) at aggregate → destructive", () => {
    const old = schema({ status: { type: "string" } });
    const newSch = schema({ status: { type: "string", enum: ["active", "inactive"] } });
    const deps = [dep("status", "aggregate")];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.destructiveDeps).toHaveLength(1);
  });

  it("enum narrowing (fewer values) at aggregate → destructive", () => {
    const old = schema({ status: { type: "string", enum: ["a", "b", "c"] } });
    const newSch = schema({ status: { type: "string", enum: ["a"] } });
    const deps = [dep("status", "aggregate")];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.destructiveDeps).toHaveLength(1);
  });

  it("number→integer but no deps → no issue", () => {
    const old = schema({ count: { type: "number" } });
    const newSch = schema({ count: { type: "integer" } });
    const result = classifySchemaChange(old, newSch, []);
    expect(result.destructiveDeps).toHaveLength(0);
    expect(result.softWarnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-5 — lossy type-narrowing at read dep → soft warning
// ---------------------------------------------------------------------------

describe("AC-5 — lossy type-narrowing at read dep → soft warning", () => {
  it("number→integer at read dep → softWarnings, no destructive", () => {
    const old = schema({ count: { type: "number" } });
    const newSch = schema({ count: { type: "integer" } });
    const deps = [dep("count", "read")];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.softWarnings).toHaveLength(1);
    expect(result.softWarnings[0]?.field_key).toBe("count");
    expect(result.destructiveDeps).toHaveLength(0);
  });

  it("string → enum at read dep → soft warning", () => {
    const old = schema({ status: { type: "string" } });
    const newSch = schema({ status: { type: "string", enum: ["a", "b"] } });
    const deps = [dep("status", "read")];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.softWarnings).toHaveLength(1);
    expect(result.destructiveDeps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-6 — empty deps → both lists empty (no block)
// ---------------------------------------------------------------------------

describe("AC-6 — empty deps → no warnings, no destructive", () => {
  it("drop field with no deps → both lists empty", () => {
    const old = schema({ amount: { type: "number" } });
    const newSch = schema({});
    const result = classifySchemaChange(old, newSch, []);
    expect(result.softWarnings).toHaveLength(0);
    expect(result.destructiveDeps).toHaveLength(0);
  });

  it("empty schema with no deps → both lists empty", () => {
    const result = classifySchemaChange({}, {}, []);
    expect(result.softWarnings).toHaveLength(0);
    expect(result.destructiveDeps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Mixed scenarios
// ---------------------------------------------------------------------------

describe("Mixed: some soft, some destructive deps on same schema change", () => {
  it("drop one field + narrowing another → both flagged correctly", () => {
    const old = schema({
      amount: { type: "number" },
      count: { type: "number" },
    });
    const newSch = schema({
      count: { type: "integer" }, // amount dropped; count narrowed
    });
    const deps = [
      dep("amount", "aggregate", "page-1", "report-1"), // drop → destructive
      dep("count", "aggregate", "page-2", "report-2"),   // narrowing at aggregate → destructive
      dep("count", "read", "page-3", "report-3"),         // narrowing at read → soft
    ];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.destructiveDeps).toHaveLength(2);
    expect(result.softWarnings).toHaveLength(1);
    expect(result.softWarnings[0]?.dep_kind).toBe("read");
  });
});

// ---------------------------------------------------------------------------
// Schema with missing properties key → treated as empty
// ---------------------------------------------------------------------------

describe("Schema without properties field", () => {
  it("old schema has no properties, dep exists → dep treated as not in new schema → destructive", () => {
    const old: JsonSchemaForClassify = {}; // no properties
    const newSch: JsonSchemaForClassify = {}; // no properties
    const deps = [dep("amount", "aggregate")];
    // field_key not in newProps → destructive (field was not there, is not there)
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.destructiveDeps).toHaveLength(1);
  });

  it("new schema has properties, dep field present → no issue", () => {
    const old: JsonSchemaForClassify = {};
    const newSch = schema({ amount: { type: "number" } });
    const deps = [dep("amount", "aggregate")];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.destructiveDeps).toHaveLength(0);
    expect(result.softWarnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AffectedDep fields propagated correctly
// ---------------------------------------------------------------------------

describe("AffectedDep shape in results", () => {
  it("destructive result carries full AffectedDep fields", () => {
    const old = schema({ f: { type: "number" } });
    const newSch = schema({});
    const deps = [dep("f", "aggregate", "page-uuid-1", "my-slug", "reg-uuid-1")];
    const result = classifySchemaChange(old, newSch, deps);
    expect(result.destructiveDeps[0]).toMatchObject({
      page_id: "page-uuid-1",
      page_slug: "my-slug",
      registry_def_id: "reg-uuid-1",
      field_key: "f",
      dep_kind: "aggregate",
    });
  });
});
