/**
 * T-0102: unit tests for the pure server-side form validator.
 *
 * The HEART of the task: the server distrusts the client. These tests prove the
 * validator rejects every class of forged payload a tampered client could send
 * (bypassing the form-js sandbox UI), and accepts only well-formed submissions.
 *
 * Threat classes covered (negative tests):
 *   - missing required field
 *   - wrong type (string-for-number, number-for-string, object/array injection)
 *   - over-length string
 *   - out-of-range number (below min, above max, NaN, Infinity)
 *   - disallowed enum value (a value the UI dropdown never offered)
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
function validPurchase(): Record<string, unknown> {
  return {
    supplier: "ООО «Вектор»",
    category: "IT-оборудование",
    subject: "Ноутбуки Lenovo ThinkPad T14 Gen 5",
    qty: 4,
    price: 124000,
    due: "21.06.2026",
    budget: "ИТ-инфраструктура · CAPEX",
    method: "Прямая",
    reason: "Замена парка устройств отдела разработки.",
    urgent: false,
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
    const r = validateFormSubmission("purchase", {
      supplier: "АО «Линия»",
      subject: "Услуги поддержки",
      budget: "Операционные ИТ · OPEX",
      // qty/price/category/method/reason/urgent/due all omitted — all optional
    });
    expect(r.ok).toBe(true);
  });
});

describe("form-validator: missing required fields", () => {
  it("rejects when a required field is absent", () => {
    const p = validPurchase();
    delete p["supplier"];
    const r = validateFormSubmission("purchase", p);
    expect(r.ok).toBe(false);
    expect(codesFor(r.errors, "supplier")).toContain("MISSING_REQUIRED");
  });

  it("treats null and empty-string as absent for required fields", () => {
    const r1 = validateFormSubmission("purchase", { ...validPurchase(), subject: "" });
    expect(codesFor(r1.errors, "subject")).toContain("MISSING_REQUIRED");
    const r2 = validateFormSubmission("purchase", { ...validPurchase(), subject: "   " });
    expect(codesFor(r2.errors, "subject")).toContain("MISSING_REQUIRED");
    const r3 = validateFormSubmission("purchase", { ...validPurchase(), budget: null });
    expect(codesFor(r3.errors, "budget")).toContain("MISSING_REQUIRED");
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
    const r = validateFormSubmission("purchase", { ...validPurchase(), qty: "4" });
    expect(codesFor(r.errors, "qty")).toContain("WRONG_TYPE");
  });

  it("rejects a number sent where a string is required", () => {
    const r = validateFormSubmission("purchase", { ...validPurchase(), subject: 12345 });
    expect(codesFor(r.errors, "subject")).toContain("WRONG_TYPE");
  });

  it("rejects an object / array injected into a scalar field", () => {
    const r1 = validateFormSubmission("purchase", { ...validPurchase(), subject: { $ne: null } });
    expect(codesFor(r1.errors, "subject")).toContain("WRONG_TYPE");
    const r2 = validateFormSubmission("purchase", { ...validPurchase(), qty: [1, 2, 3] });
    expect(codesFor(r2.errors, "qty")).toContain("WRONG_TYPE");
  });

  it("rejects a non-boolean sent for a checkbox field", () => {
    const r = validateFormSubmission("purchase", { ...validPurchase(), urgent: "true" });
    expect(codesFor(r.errors, "urgent")).toContain("WRONG_TYPE");
  });

  it("rejects a non-string sent for an enum field", () => {
    const r = validateFormSubmission("purchase", { ...validPurchase(), supplier: 1 });
    expect(codesFor(r.errors, "supplier")).toContain("WRONG_TYPE");
  });
});

describe("form-validator: out-of-range / over-length", () => {
  it("rejects a number below min", () => {
    const r = validateFormSubmission("purchase", { ...validPurchase(), qty: 0 });
    expect(codesFor(r.errors, "qty")).toContain("OUT_OF_RANGE");
  });

  it("rejects a number above max", () => {
    const r = validateFormSubmission("purchase", { ...validPurchase(), price: 9_999_999_999 });
    expect(codesFor(r.errors, "price")).toContain("OUT_OF_RANGE");
  });

  it("rejects NaN and Infinity disguised as numbers", () => {
    const rNaN = validateFormSubmission("purchase", { ...validPurchase(), qty: NaN });
    expect(codesFor(rNaN.errors, "qty")).toContain("WRONG_TYPE");
    const rInf = validateFormSubmission("purchase", { ...validPurchase(), price: Infinity });
    expect(codesFor(rInf.errors, "price")).toContain("WRONG_TYPE");
  });

  it("rejects an over-length text field (megabyte string the UI would never produce)", () => {
    const r = validateFormSubmission("purchase", {
      ...validPurchase(),
      subject: "x".repeat(10_000),
    });
    expect(codesFor(r.errors, "subject")).toContain("TOO_LONG");
  });
});

describe("form-validator: disallowed enum values (forged options)", () => {
  it("rejects a supplier value not in the allowed option set", () => {
    const r = validateFormSubmission("purchase", {
      ...validPurchase(),
      supplier: "ООО «Подставная компания»",
    });
    expect(codesFor(r.errors, "supplier")).toContain("DISALLOWED_VALUE");
  });

  it("rejects an approval decision outside ok|reject|return (privilege-escalation attempt)", () => {
    const r = validateFormSubmission("approval", { decision: "auto-approve" });
    expect(codesFor(r.errors, "decision")).toContain("DISALLOWED_VALUE");
  });

  it("rejects a budget article the UI never offered", () => {
    const r = validateFormSubmission("purchase", { ...validPurchase(), budget: "Чёрная касса" });
    expect(codesFor(r.errors, "budget")).toContain("DISALLOWED_VALUE");
  });
});

describe("form-validator: unknown / extra forged fields", () => {
  it("rejects an extra field the schema does not declare", () => {
    const r = validateFormSubmission("purchase", { ...validPurchase(), isAdmin: true });
    expect(r.ok).toBe(false);
    expect(codesFor(r.errors, "isAdmin")).toContain("UNKNOWN_FIELD");
  });

  it("rejects a forged amount/total override (client tries to set server-computed field)", () => {
    const r = validateFormSubmission("purchase", { ...validPurchase(), total: 1, approvedBy: "x" });
    expect(codesFor(r.errors, "total")).toContain("UNKNOWN_FIELD");
    expect(codesFor(r.errors, "approvedBy")).toContain("UNKNOWN_FIELD");
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
      // supplier missing, qty wrong type, budget disallowed, extra field
      subject: "ok",
      qty: "nope",
      budget: "Чёрная касса",
      hacked: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe("form-schema: registry sanity", () => {
  it("exposes exactly the two MVP forms", () => {
    expect(formIds().sort()).toEqual(["approval", "purchase"]);
  });
});
