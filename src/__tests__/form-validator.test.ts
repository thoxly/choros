/**
 * T-0102: unit tests for the pure server-side form validator.
 *
 * The HEART of the task: the server distrusts the client. These tests prove the
 * validator rejects every class of forged payload a tampered client could send
 * (bypassing the form-js sandbox UI), and accepts only well-formed submissions.
 *
 * T-0370: PURCHASE field set aligned to registry_def.record_schema «Заявки»
 * (migration 076, slug='purchases'): title (text, required) + amount (number) +
 * requester (text) + status (enum: pending|approved|rejected). Old fields
 * (supplier/subject/qty/price/budget/etc.) removed from PURCHASE form. Test
 * payloads updated accordingly; threat coverage is preserved across all classes.
 *
 * Threat classes covered (negative tests):
 *   - missing required field (title)
 *   - wrong type (string-for-number, number-for-string, object/array injection)
 *   - over-length string (title)
 *   - out-of-range number (amount below min, above max, NaN, Infinity)
 *   - disallowed enum value (status outside pending|approved|rejected)
 *   - unknown / extra forged field
 *   - non-object / wrong-shape payload
 *   - unknown form id
 *   - conditional requiredness (approval comment required on reject/return)
 * Positive tests: valid purchase + valid approval, and sanitized output.
 */
import { describe, it, expect } from "vitest";
import { validateFormSubmission, type FieldError } from "../core/form-validator.js";
import { getFormDef, formIds } from "../core/form-schema.js";

// A baseline VALID purchase payload — every test mutates one field off this.
// T-0370: registry-aligned fields (title/amount) replacing old form-level fields.
function validPurchase(): Record<string, unknown> {
  return {
    title: "Ноутбуки Lenovo ThinkPad T14 Gen 5",
    amount: 496000,
  };
}

function validApproval(): Record<string, unknown> {
  return { decision: "ok", next: "Е. Ларина · Финдиректор", checks: true };
}

function codesFor(errors: FieldError[], field: string): string[] {
  return errors.filter((e) => e.field === field).map((e) => e.code);
}

describe("form-validator: positive paths", () => {
  it("accepts a fully valid purchase payload", () => {
    const r = validateFormSubmission("purchase", validPurchase());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.value).toBeDefined();
  });

  it("accepts a valid approval payload (decision ok, no comment needed)", () => {
    const r = validateFormSubmission("approval", validApproval());
    expect(r.ok).toBe(true);
  });

  it("accepts approval with comment when decision is reject (conditional satisfied)", () => {
    const r = validateFormSubmission("approval", {
      decision: "reject",
      comment: "Бюджет статьи исчерпан.",
    });
    expect(r.ok).toBe(true);
  });

  it("allows optional fields to be omitted entirely", () => {
    // amount, requester, status are all optional; only title is required.
    const r = validateFormSubmission("purchase", {
      title: "Услуги поддержки",
      // amount/requester/status all omitted — all optional
    });
    expect(r.ok).toBe(true);
  });
});

describe("form-validator: missing required fields", () => {
  it("rejects when a required field is absent", () => {
    const p = validPurchase();
    delete p["title"]; // title is the only required field in the registry-aligned schema
    const r = validateFormSubmission("purchase", p);
    expect(r.ok).toBe(false);
    expect(codesFor(r.errors, "title")).toContain("MISSING_REQUIRED");
  });

  it("treats null and empty-string as absent for required fields", () => {
    const r1 = validateFormSubmission("purchase", { ...validPurchase(), title: "" });
    expect(codesFor(r1.errors, "title")).toContain("MISSING_REQUIRED");
    const r2 = validateFormSubmission("purchase", { ...validPurchase(), title: "   " });
    expect(codesFor(r2.errors, "title")).toContain("MISSING_REQUIRED");
    const r3 = validateFormSubmission("purchase", { ...validPurchase(), title: null });
    expect(codesFor(r3.errors, "title")).toContain("MISSING_REQUIRED");
  });

  it("requires approval.comment when decision is reject or return", () => {
    const rj = validateFormSubmission("approval", { decision: "reject" });
    expect(codesFor(rj.errors, "comment")).toContain("MISSING_REQUIRED");
    const rt = validateFormSubmission("approval", { decision: "return" });
    expect(codesFor(rt.errors, "comment")).toContain("MISSING_REQUIRED");
  });
});

describe("form-validator: wrong types (forged client payloads)", () => {
  it("rejects a string sent where a number is required (UI shows numeric, client forges string)", () => {
    // T-0369 coercion applies only in forms.ts (HTTP layer). The pure validator
    // is strict: a raw string for a number field is WRONG_TYPE.
    const r = validateFormSubmission("purchase", { ...validPurchase(), amount: "496000" });
    expect(codesFor(r.errors, "amount")).toContain("WRONG_TYPE");
  });

  it("rejects a number sent where a string is required", () => {
    const r = validateFormSubmission("purchase", { ...validPurchase(), title: 12345 });
    expect(codesFor(r.errors, "title")).toContain("WRONG_TYPE");
  });

  it("rejects an object / array injected into a scalar field", () => {
    const r1 = validateFormSubmission("purchase", { ...validPurchase(), title: { $ne: null } });
    expect(codesFor(r1.errors, "title")).toContain("WRONG_TYPE");
    const r2 = validateFormSubmission("purchase", { ...validPurchase(), amount: [1, 2, 3] });
    expect(codesFor(r2.errors, "amount")).toContain("WRONG_TYPE");
  });

  it("rejects a non-string sent for an enum field", () => {
    const r = validateFormSubmission("purchase", { ...validPurchase(), status: 1 });
    expect(codesFor(r.errors, "status")).toContain("WRONG_TYPE");
  });
});

describe("form-validator: out-of-range / over-length", () => {
  it("rejects a number below min", () => {
    // amount min: 0; negative is out of range
    const r = validateFormSubmission("purchase", { ...validPurchase(), amount: -1 });
    expect(codesFor(r.errors, "amount")).toContain("OUT_OF_RANGE");
  });

  it("rejects a number above max", () => {
    // amount max: 1_000_000_000; over that is out of range
    const r = validateFormSubmission("purchase", { ...validPurchase(), amount: 2_000_000_000 });
    expect(codesFor(r.errors, "amount")).toContain("OUT_OF_RANGE");
  });

  it("rejects NaN and Infinity disguised as numbers", () => {
    const rNaN = validateFormSubmission("purchase", { ...validPurchase(), amount: NaN });
    expect(codesFor(rNaN.errors, "amount")).toContain("WRONG_TYPE");
    const rInf = validateFormSubmission("purchase", { ...validPurchase(), amount: Infinity });
    expect(codesFor(rInf.errors, "amount")).toContain("WRONG_TYPE");
  });

  it("rejects an over-length text field (megabyte string the UI would never produce)", () => {
    // title maxLength: 500
    const r = validateFormSubmission("purchase", {
      ...validPurchase(),
      title: "x".repeat(10_000),
    });
    expect(codesFor(r.errors, "title")).toContain("TOO_LONG");
  });
});

describe("form-validator: disallowed enum values (forged options)", () => {
  it("rejects a status value not in the allowed option set (pending|approved|rejected)", () => {
    const r = validateFormSubmission("purchase", {
      ...validPurchase(),
      status: "auto-approved",
    });
    expect(codesFor(r.errors, "status")).toContain("DISALLOWED_VALUE");
  });

  it("rejects an approval decision outside ok|reject|return (privilege-escalation attempt)", () => {
    const r = validateFormSubmission("approval", { decision: "auto-approve" });
    expect(codesFor(r.errors, "decision")).toContain("DISALLOWED_VALUE");
  });
});

describe("form-validator: unknown / extra forged fields", () => {
  it("rejects an extra field the schema does not declare", () => {
    const r = validateFormSubmission("purchase", { ...validPurchase(), isAdmin: true });
    expect(r.ok).toBe(false);
    expect(codesFor(r.errors, "isAdmin")).toContain("UNKNOWN_FIELD");
  });

  it("rejects a forged approvedBy override (client tries to set server-computed field)", () => {
    const r = validateFormSubmission("purchase", { ...validPurchase(), approvedBy: "x", total: 1 });
    expect(codesFor(r.errors, "approvedBy")).toContain("UNKNOWN_FIELD");
    expect(codesFor(r.errors, "total")).toContain("UNKNOWN_FIELD");
  });

  it("does not leak unknown fields into the sanitized value on an otherwise-valid form", () => {
    // Even though every KNOWN field is valid, the unknown field makes it invalid;
    // and a relaxed caller using only `value` would still not see the forged key.
    const r = validateFormSubmission("purchase", { ...validPurchase(), backdoor: "1" });
    expect(r.ok).toBe(false);
    expect(r.value).toBeUndefined();
  });
});

describe("form-validator: malformed payloads & unknown forms", () => {
  it("rejects a non-object payload", () => {
    for (const bad of [null, undefined, 42, "string", [1, 2], true]) {
      const r = validateFormSubmission("purchase", bad);
      expect(r.ok).toBe(false);
      // null/non-object → NOT_AN_OBJECT (arrays are not plain objects either)
      expect(r.errors.some((e) => e.code === "NOT_AN_OBJECT")).toBe(true);
    }
  });

  it("rejects an unknown form id", () => {
    const r = validateFormSubmission("not-a-form", validPurchase());
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("UNKNOWN_FORM");
  });
});

describe("form-validator: sanitized output is server-truth", () => {
  it("returns only schema-declared fields in value", () => {
    const r = validateFormSubmission("approval", validApproval());
    expect(r.ok).toBe(true);
    const keys = Object.keys(r.value ?? {});
    const allowed = new Set(getFormDef("approval")?.fields.map((f) => f.key));
    for (const k of keys) expect(allowed.has(k)).toBe(true);
  });

  it("accumulates multiple field errors in one pass (not fail-fast)", () => {
    const r = validateFormSubmission("purchase", {
      // title missing (required), amount wrong type, status disallowed, extra field
      amount: "not-a-number",
      status: "Чёрная касса",
      hacked: 1,
    });
    expect(r.ok).toBe(false);
    // At minimum: title MISSING_REQUIRED, amount WRONG_TYPE, status DISALLOWED_VALUE, hacked UNKNOWN_FIELD
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe("form-schema: registry sanity", () => {
  it("exposes exactly the two MVP forms", () => {
    expect(formIds().sort()).toEqual(["approval", "purchase"]);
  });
});
