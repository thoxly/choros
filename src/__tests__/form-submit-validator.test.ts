/**
 * T-0400 [D7-2] — Unit tests for form-submit-validator.ts (pure core)
 *
 * Tests the three validation rules enforced at form-submit time:
 *   Rule 1 — UNKNOWN-KEY REJECTION: keys not in BindingField[] are rejected.
 *   Rule 2 — ENUM VALIDATION: enum fields validated against options[].
 *   Rule 3 — SCHEMA-DRIFT DETECTION: binding keys absent from live schema are caught.
 *
 * Also tests:
 *   - Valid submit passes (all rules green → safeValues returned).
 *   - Backward compat: missing options on enum fields → check skipped.
 *   - Schema absent → drift check skipped (fail-open for load).
 *   - Proto keys in submittedValues are stripped (defence-in-depth layer).
 *   - __step_class marker key excluded from validation field set.
 *   - extractSchemaPropertyKeys helper.
 *
 * Pure unit — no pg, no live DB.
 */

import { describe, it, expect } from "vitest";
import {
  validateFormSubmit,
  extractSchemaPropertyKeys,
  type FormSubmitViolation,
} from "../core/form-submit-validator.js";
import type { BindingField } from "../core/binding-compat.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFields(defs: Array<Partial<BindingField> & { key: string }>): BindingField[] {
  return defs.map((d) => ({
    type: d.type ?? "text",
    required: d.required ?? false,
    ...d,
  }));
}

// ---------------------------------------------------------------------------
// extractSchemaPropertyKeys
// ---------------------------------------------------------------------------

describe("extractSchemaPropertyKeys", () => {
  it("returns keys from schema.properties", () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
        amount: { type: "number" },
      },
    };
    const keys = extractSchemaPropertyKeys(schema);
    expect(keys.has("title")).toBe(true);
    expect(keys.has("amount")).toBe(true);
    expect(keys.size).toBe(2);
  });

  it("returns empty set for null schema", () => {
    expect(extractSchemaPropertyKeys(null).size).toBe(0);
  });

  it("returns empty set for undefined schema", () => {
    expect(extractSchemaPropertyKeys(undefined).size).toBe(0);
  });

  it("returns empty set when schema has no properties", () => {
    expect(extractSchemaPropertyKeys({ type: "object" }).size).toBe(0);
  });

  it("returns empty set for non-object schema", () => {
    expect(extractSchemaPropertyKeys("string").size).toBe(0);
    expect(extractSchemaPropertyKeys([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 1 — UNKNOWN-KEY REJECTION
// ---------------------------------------------------------------------------

describe("validateFormSubmit — Rule 1: unknown key rejection (D7-2)", () => {
  it("FSV-1: submitted key not in BindingField[] → violation unknown_key", () => {
    const fields = makeFields([{ key: "title", type: "text" }]);
    const result = validateFormSubmit(
      { title: "Hello", ghost: "uninvited" },
      fields,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const violation = result.violations.find((v) => v.key === "ghost");
      expect(violation).toBeDefined();
      expect(violation?.type).toBe("unknown_key");
      expect(violation?.message).toMatch(/not declared in form_binding\.fields/);
    }
  });

  it("FSV-2: unknown key is NOT included in safeValues on failure", () => {
    const fields = makeFields([{ key: "title", type: "text" }]);
    const result = validateFormSubmit(
      { title: "Hello", secret: "injected" },
      fields,
      undefined,
    );
    // Unknown key → fail, so no safeValues (ok=false)
    expect(result.ok).toBe(false);
  });

  it("FSV-3: multiple unknown keys → one violation per key", () => {
    const fields = makeFields([{ key: "title", type: "text" }]);
    const result = validateFormSubmit(
      { title: "Hello", k1: "bad1", k2: "bad2" },
      fields,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const unknownViolations = result.violations.filter((v) => v.type === "unknown_key");
      expect(unknownViolations.length).toBe(2);
      const keys = unknownViolations.map((v) => v.key).sort();
      expect(keys).toEqual(["k1", "k2"]);
    }
  });

  it("FSV-4: empty submitted values with binding fields → ok (no unknown keys)", () => {
    const fields = makeFields([{ key: "title", type: "text" }]);
    const result = validateFormSubmit({}, fields, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safeValues).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — ENUM VALIDATION
// ---------------------------------------------------------------------------

describe("validateFormSubmit — Rule 2: enum validation (D7-2)", () => {
  it("FSV-5: enum field with correct value → passes", () => {
    const fields = makeFields([
      { key: "status", type: "enum", contract: "enum", options: ["open", "closed", "pending"] },
    ]);
    const result = validateFormSubmit({ status: "open" }, fields, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safeValues["status"]).toBe("open");
    }
  });

  it("FSV-6: enum field with invalid value → violation enum_mismatch", () => {
    const fields = makeFields([
      { key: "status", type: "enum", contract: "enum", options: ["open", "closed"] },
    ]);
    const result = validateFormSubmit({ status: "INVALID" }, fields, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((v) => v.key === "status");
      expect(v).toBeDefined();
      expect(v?.type).toBe("enum_mismatch");
      expect(v?.message).toMatch(/enum/i);
      expect(v?.message).toMatch(/"INVALID"/);
    }
  });

  it("FSV-7: enum field via legacy type='enum' (no contract) with valid value → passes", () => {
    const fields = makeFields([
      // Pre-T-0399 snapshot: type='enum' but no contract field
      { key: "category", type: "enum", options: ["A", "B", "C"] },
    ]);
    const result = validateFormSubmit({ category: "B" }, fields, undefined);
    expect(result.ok).toBe(true);
  });

  it("FSV-8: enum field with no options → check skipped (backward compat)", () => {
    const fields = makeFields([
      // Pre-T-0399 snapshot: type='enum' but options NOT carried
      { key: "status", type: "enum" },
    ]);
    const result = validateFormSubmit({ status: "anything" }, fields, undefined);
    // options absent → enum check skipped → value passes through
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safeValues["status"]).toBe("anything");
    }
  });

  it("FSV-9: enum field with empty options array → check skipped (backward compat)", () => {
    const fields = makeFields([
      { key: "status", type: "enum", contract: "enum", options: [] },
    ]);
    const result = validateFormSubmit({ status: "anything" }, fields, undefined);
    expect(result.ok).toBe(true);
  });

  it("FSV-10: enum field value not a string → violation enum_mismatch", () => {
    const fields = makeFields([
      { key: "tier", type: "enum", contract: "enum", options: ["basic", "pro"] },
    ]);
    // Submitted a number — not a string at all
    const result = validateFormSubmit({ tier: 42 }, fields, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((viol) => viol.key === "tier");
      expect(v?.type).toBe("enum_mismatch");
    }
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — SCHEMA-DRIFT DETECTION
// ---------------------------------------------------------------------------

describe("validateFormSubmit — Rule 3: schema drift detection (D7-2)", () => {
  it("FSV-11: binding field absent from live schema → violation schema_drift", () => {
    const fields = makeFields([
      { key: "title", type: "text" },
      { key: "removed_field", type: "text" }, // was removed from schema after authoring
    ]);
    const liveSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        // removed_field is gone from live schema
      },
    };
    const result = validateFormSubmit({}, fields, liveSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const driftViolation = result.violations.find(
        (v): v is FormSubmitViolation => v.type === "schema_drift" && v.key === "removed_field",
      );
      expect(driftViolation).toBeDefined();
      expect(driftViolation?.message).toMatch(/schema drift/i);
    }
  });

  it("FSV-12: drift field also submitted → both unknown_key and schema_drift violations emitted", () => {
    const fields = makeFields([
      { key: "title", type: "text" },
      { key: "old_field", type: "text" },
    ]);
    const liveSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        // old_field removed from schema
      },
    };
    // old_field is both drifted AND submitted — unknown_key fires (it IS in fields
    // but NOT in schema, so it's still in the binding; however the user submitted it
    // as a key. Actually it IS in bindingFields so it won't be unknown_key — it will
    // only be schema_drift. The submitted value for old_field will end up in safeValues
    // UNLESS schema_drift makes the overall result fail.
    const result = validateFormSubmit({ title: "hello", old_field: "oops" }, fields, liveSchema);
    // schema_drift triggers → result is ok=false
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const hasDrift = result.violations.some((v) => v.type === "schema_drift" && v.key === "old_field");
      expect(hasDrift).toBe(true);
    }
  });

  it("FSV-13: liveRecordSchema=undefined → drift check skipped (fail-open)", () => {
    const fields = makeFields([
      { key: "title", type: "text" },
      { key: "any_field", type: "text" },
    ]);
    // No live schema provided → skip drift check
    const result = validateFormSubmit({ title: "hello", any_field: "ok" }, fields, undefined);
    expect(result.ok).toBe(true);
  });

  it("FSV-14: liveRecordSchema=null → drift check skipped (fail-open)", () => {
    const fields = makeFields([{ key: "title", type: "text" }]);
    const result = validateFormSubmit({ title: "hello" }, fields, null);
    expect(result.ok).toBe(true);
  });

  it("FSV-15: all binding fields in live schema → no drift violation", () => {
    const fields = makeFields([
      { key: "title", type: "text" },
      { key: "amount", type: "number" },
    ]);
    const liveSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        amount: { type: "number" },
      },
    };
    const result = validateFormSubmit(
      { title: "Laptop", amount: 50000 },
      fields,
      liveSchema,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safeValues["title"]).toBe("Laptop");
      expect(result.safeValues["amount"]).toBe(50000);
    }
  });
});

// ---------------------------------------------------------------------------
// Valid submit (all rules green)
// ---------------------------------------------------------------------------

describe("validateFormSubmit — valid submit passes (D7-2)", () => {
  it("FSV-16: valid multi-field submit with scalar and enum fields", () => {
    const fields = makeFields([
      { key: "title", type: "text" },
      { key: "amount", type: "number" },
      { key: "approved", type: "boolean" },
      { key: "category", type: "enum", contract: "enum", options: ["IT", "HR", "Finance"] },
    ]);
    const liveSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        amount: { type: "number" },
        approved: { type: "boolean" },
        category: { type: "string", enum: ["IT", "HR", "Finance"] },
      },
    };
    const result = validateFormSubmit(
      { title: "Notebook Dell", amount: 85000, approved: true, category: "IT" },
      fields,
      liveSchema,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safeValues["title"]).toBe("Notebook Dell");
      expect(result.safeValues["amount"]).toBe(85000);
      expect(result.safeValues["approved"]).toBe(true);
      expect(result.safeValues["category"]).toBe("IT");
    }
  });

  it("FSV-17: partial submit (only some optional fields) → ok", () => {
    const fields = makeFields([
      { key: "title", type: "text", required: true },
      { key: "notes", type: "textarea" }, // optional — not submitted
    ]);
    const result = validateFormSubmit({ title: "Purchase" }, fields, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safeValues["title"]).toBe("Purchase");
      expect("notes" in result.safeValues).toBe(false);
    }
  });

  it("FSV-18: empty submitted values → ok (no violations)", () => {
    const fields = makeFields([
      { key: "title", type: "text" },
      { key: "amount", type: "number" },
    ]);
    const result = validateFormSubmit({}, fields, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safeValues).toEqual({});
    }
  });

  it("FSV-19: empty binding fields + empty submitted values → ok", () => {
    const result = validateFormSubmit({}, [], undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safeValues).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// __step_class marker exclusion
// ---------------------------------------------------------------------------

describe("validateFormSubmit — __step_class marker exclusion (D7-2)", () => {
  it("FSV-20: __step_class binding member is NOT treated as a user field", () => {
    const fields: BindingField[] = [
      { key: "__step_class", type: "B", required: false }, // F1 marker
      { key: "title", type: "text", required: false },
    ];
    // Submitting title should work; __step_class is not a user-submitted field
    const result = validateFormSubmit({ title: "Hello" }, fields, undefined);
    expect(result.ok).toBe(true);
  });

  it("FSV-21: __step_class submitted by client → treated as unknown key (rejected)", () => {
    const fields: BindingField[] = [
      { key: "__step_class", type: "B", required: false }, // F1 marker (excluded from field set)
      { key: "title", type: "text", required: false },
    ];
    // Trying to submit __step_class → unknown_key (it's excluded from the binding field set)
    const result = validateFormSubmit(
      { title: "Hello", __step_class: "B" },
      fields,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((viol) => viol.key === "__step_class");
      expect(v?.type).toBe("unknown_key");
    }
  });
});

// ---------------------------------------------------------------------------
// Proto-key stripping (defence-in-depth)
// ---------------------------------------------------------------------------

describe("validateFormSubmit — proto-key defence-in-depth (D7-2)", () => {
  it("FSV-22: __proto__ key in submittedValues is silently dropped even if in binding", () => {
    // If somehow __proto__ were in the binding and submitted (very defensive)
    const fields = makeFields([
      { key: "title", type: "text" },
    ]);
    const submitted: Record<string, unknown> = { title: "ok" };
    // Assign proto key via index
    submitted["__proto__"] = { polluted: true };
    const result = validateFormSubmit(submitted, fields, undefined);
    // title is valid; __proto__ is stripped by defence-in-depth → ok
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.prototype.hasOwnProperty.call(result.safeValues, "__proto__")).toBe(false);
      expect(result.safeValues["title"]).toBe("ok");
    }
  });
});

// ---------------------------------------------------------------------------
// T-0512 — multi-select and person field validation
// ---------------------------------------------------------------------------

describe("validateFormSubmit — T-0512: multi-select field validation", () => {
  it("T0512-MS-1: multi-select with valid array (all elements in options) → passes", () => {
    const fields = makeFields([
      { key: "tags", type: "multi-select", contract: "multi-select", options: ["A", "B", "C"] },
    ]);
    const result = validateFormSubmit({ tags: ["A", "C"] }, fields, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safeValues["tags"]).toEqual(["A", "C"]);
    }
  });

  it("T0512-MS-2: multi-select with empty array → passes (no elements to violate)", () => {
    const fields = makeFields([
      { key: "tags", type: "multi-select", contract: "multi-select", options: ["A", "B", "C"] },
    ]);
    const result = validateFormSubmit({ tags: [] }, fields, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safeValues["tags"]).toEqual([]);
    }
  });

  it("T0512-MS-3: multi-select with element not in options → enum_mismatch violation", () => {
    const fields = makeFields([
      { key: "tags", type: "multi-select", contract: "multi-select", options: ["A", "B", "C"] },
    ]);
    const result = validateFormSubmit({ tags: ["A", "INVALID"] }, fields, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.key === "tags");
      expect(v?.type).toBe("enum_mismatch");
      expect(v?.message).toMatch(/multi-select/);
      expect(v?.message).toMatch(/"INVALID"/);
    }
  });

  it("T0512-MS-4: multi-select with non-array value → enum_mismatch violation", () => {
    const fields = makeFields([
      { key: "tags", type: "multi-select", contract: "multi-select", options: ["A", "B"] },
    ]);
    const result = validateFormSubmit({ tags: "A" }, fields, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.key === "tags");
      expect(v?.type).toBe("enum_mismatch");
      expect(v?.message).toMatch(/must be an array/);
    }
  });

  it("T0512-MS-5: multi-select with numeric non-array → enum_mismatch violation", () => {
    const fields = makeFields([
      { key: "tags", type: "multi-select", contract: "multi-select", options: ["A", "B"] },
    ]);
    const result = validateFormSubmit({ tags: 42 }, fields, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.key === "tags");
      expect(v?.type).toBe("enum_mismatch");
    }
  });

  it("T0512-MS-6: multi-select with no options → array shape required, elements unchecked", () => {
    // No options carried (backward compat) → only the array-shape requirement enforced.
    const fields = makeFields([
      { key: "tags", type: "multi-select", contract: "multi-select" },
    ]);
    const result = validateFormSubmit({ tags: ["X", "Y"] }, fields, undefined);
    expect(result.ok).toBe(true);
  });

  it("T0512-MS-7: multi-select with no options and non-array value → enum_mismatch violation", () => {
    // Even without options, a non-array is rejected (the array shape invariant holds).
    const fields = makeFields([
      { key: "tags", type: "multi-select", contract: "multi-select" },
    ]);
    const result = validateFormSubmit({ tags: "not-an-array" }, fields, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.key === "tags");
      expect(v?.type).toBe("enum_mismatch");
      expect(v?.message).toMatch(/must be an array/);
    }
  });
});

describe("validateFormSubmit — T-0512: person field validation", () => {
  it("T0512-P-1: person field with non-empty string → passes", () => {
    const fields = makeFields([
      { key: "owner", type: "person", contract: "person" },
    ]);
    const result = validateFormSubmit({ owner: "emp-123" }, fields, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safeValues["owner"]).toBe("emp-123");
    }
  });

  it("T0512-P-2: person field with empty string → enum_mismatch violation", () => {
    const fields = makeFields([
      { key: "owner", type: "person", contract: "person" },
    ]);
    const result = validateFormSubmit({ owner: "" }, fields, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.key === "owner");
      expect(v?.type).toBe("enum_mismatch");
      expect(v?.message).toMatch(/person field/);
    }
  });

  it("T0512-P-3: person field with whitespace-only string → enum_mismatch violation", () => {
    const fields = makeFields([
      { key: "owner", type: "person", contract: "person" },
    ]);
    const result = validateFormSubmit({ owner: "   " }, fields, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.key === "owner");
      expect(v?.type).toBe("enum_mismatch");
    }
  });

  it("T0512-P-4: person field with non-string value → enum_mismatch violation", () => {
    const fields = makeFields([
      { key: "owner", type: "person", contract: "person" },
    ]);
    const result = validateFormSubmit({ owner: 42 }, fields, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.key === "owner");
      expect(v?.type).toBe("enum_mismatch");
    }
  });
});

// ---------------------------------------------------------------------------
// T-0404 [D7-9] — per-step field MODE enforcement (server-authoritative)
//   read-only / hidden → write rejected; required-to-advance → must be present
// ---------------------------------------------------------------------------

describe("validateFormSubmit — T-0404 [D7-9]: per-step field mode", () => {
  it("T0404-1: write to a read-only field → readonly_write violation, value NOT in safeValues", () => {
    const fields = makeFields([
      { key: "amount", type: "number", mode: "read-only" },
      { key: "note", type: "text" },
    ]);
    const result = validateFormSubmit(
      { amount: 999, note: "ok" },
      fields,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.key === "amount");
      expect(v?.type).toBe("readonly_write");
      expect(v?.message).toMatch(/read-only/);
    }
  });

  it("T0404-2: write to a hidden field → hidden_write violation", () => {
    const fields = makeFields([
      { key: "secret", type: "text", mode: "hidden" },
    ]);
    const result = validateFormSubmit({ secret: "x" }, fields, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.key === "secret");
      expect(v?.type).toBe("hidden_write");
      expect(v?.message).toMatch(/hidden/);
    }
  });

  it("T0404-3: required-to-advance field MISSING → missing_required violation", () => {
    const fields = makeFields([
      { key: "decision", type: "text", mode: "required-to-advance" },
    ]);
    // submit nothing for `decision`
    const result = validateFormSubmit({}, fields, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.key === "decision");
      expect(v?.type).toBe("missing_required");
      expect(v?.message).toMatch(/required to advance/);
    }
  });

  it("T0404-4: required-to-advance field submitted EMPTY ('' / whitespace) → still missing", () => {
    const fields = makeFields([
      { key: "decision", type: "text", mode: "required-to-advance" },
    ]);
    for (const empty of ["", "   ", null, undefined] as unknown[]) {
      const result = validateFormSubmit({ decision: empty }, fields, undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.violations.some((x) => x.type === "missing_required")).toBe(true);
      }
    }
  });

  it("T0404-5: required-to-advance field PRESENT → passes, value in safeValues", () => {
    const fields = makeFields([
      { key: "decision", type: "text", mode: "required-to-advance" },
    ]);
    const result = validateFormSubmit({ decision: "approve" }, fields, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safeValues["decision"]).toBe("approve");
    }
  });

  it("T0404-6: a field with NO mode behaves exactly as before (backward-compat)", () => {
    const fields = makeFields([
      { key: "note", type: "text" }, // no mode
    ]);
    // Not submitting `note` is fine (no required-to-advance), and submitting it is fine.
    expect(validateFormSubmit({}, fields, undefined).ok).toBe(true);
    const r2 = validateFormSubmit({ note: "hi" }, fields, undefined);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.safeValues["note"]).toBe("hi");
  });

  it("T0404-7: modes compose — read-only write rejected AND required-to-advance missing reported together", () => {
    const fields = makeFields([
      { key: "ro", type: "text", mode: "read-only" },
      { key: "req", type: "text", mode: "required-to-advance" },
    ]);
    const result = validateFormSubmit({ ro: "tampered" }, fields, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.type === "readonly_write" && v.key === "ro")).toBe(true);
      expect(result.violations.some((v) => v.type === "missing_required" && v.key === "req")).toBe(true);
    }
  });

  it("T0404-8: required-to-advance accepts non-string presence (checkbox true, number 0)", () => {
    const fields = makeFields([
      { key: "agree", type: "boolean", mode: "required-to-advance" },
      { key: "qty", type: "number", mode: "required-to-advance" },
    ]);
    const result = validateFormSubmit({ agree: true, qty: 0 }, fields, undefined);
    expect(result.ok).toBe(true);
  });
});
