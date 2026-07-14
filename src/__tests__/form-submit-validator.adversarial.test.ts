/**
 * T-0417 · ADVERSARY (Враг red-team) — form-submit PURE validator suite.
 *
 * Surface under attack: T-0400 [D7-2] src/core/form-submit-validator.ts
 *   (validateFormSubmit + extractSchemaPropertyKeys).
 *
 * The existing form-submit-validator.test.ts covers the happy/violation cases.
 * THIS suite hammers the validator with the attacker's toolbox:
 *   - prototype-pollution keys (__proto__, constructor, prototype) — the validator
 *     is a second defense layer; even if the caller skipped its strip, these keys
 *     must NEVER appear in safeValues.
 *   - provenance keys (decision, approved_by, comment) injected as form fields —
 *     they are not in BindingField[] → must be rejected as unknown_key (the server
 *     is the sole source of provenance).
 *   - inherited-property confusion (constructor/toString/hasOwnProperty as keys).
 *   - schema-property prototype pollution via extractSchemaPropertyKeys.
 *   - "looks valid but isn't" enum coercion (object/array/number values).
 *
 * Pure unit. Runnable NOW.
 */

import { describe, it, expect } from "vitest";
import {
  validateFormSubmit,
  extractSchemaPropertyKeys,
} from "../core/form-submit-validator.js";
import type { BindingField } from "../core/binding-compat.js";

// ---------------------------------------------------------------------------
// 1. PROTO-POLLUTION — the validator's second-layer PROTO_KEYS strip.
//    safeValues must never carry __proto__ / constructor / prototype, and the
//    global Object.prototype must never be polluted.
// ---------------------------------------------------------------------------
describe("Враг · prototype-pollution keys never reach safeValues", () => {
  const PROTO_KEYS = ["__proto__", "constructor", "prototype"];

  for (const protoKey of PROTO_KEYS) {
    it(`drops "${protoKey}" even when it is the ONLY submitted key (no caller strip)`, () => {
      // Build the submitted object via defineProperty so __proto__ is an OWN
      // enumerable key (a JSON.parse'd payload produces exactly this shape).
      const submitted: Record<string, unknown> = {};
      Object.defineProperty(submitted, protoKey, {
        value: { polluted: true },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const fields: BindingField[] = [{ key: "title", type: "text", required: false }];

      const result = validateFormSubmit(submitted, fields, undefined);
      // The proto key is silently skipped (continue), so no unknown_key violation
      // is raised for it AND it never lands in safeValues.
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Object.prototype.hasOwnProperty.call(result.safeValues, protoKey)).toBe(false);
      }
    });
  }

  it("a proto key alongside a valid key → valid key passes, proto key dropped", () => {
    const submitted = JSON.parse('{"title":"ok","__proto__":{"x":1},"constructor":"evil"}');
    const fields: BindingField[] = [{ key: "title", type: "text", required: false }];
    const result = validateFormSubmit(submitted, fields, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safeValues).toEqual({ title: "ok" });
      expect(Object.prototype.hasOwnProperty.call(result.safeValues, "__proto__")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(result.safeValues, "constructor")).toBe(false);
    }
  });

  it("does NOT pollute the global Object.prototype", () => {
    const before = ({} as Record<string, unknown>)["polluted"];
    const submitted = JSON.parse('{"__proto__":{"polluted":"yes"}}');
    const fields: BindingField[] = [{ key: "title", type: "text", required: false }];
    validateFormSubmit(submitted, fields, undefined);
    // No global pollution from running the validator.
    expect(({} as Record<string, unknown>)["polluted"]).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 2. PROVENANCE OVERRIDE — a client cannot inject server-controlled provenance
//    fields through the form. decision/approved_by/comment are NOT in
//    BindingField[] → rejected as unknown_key (never reach safeValues).
// ---------------------------------------------------------------------------
describe("Враг · client-supplied provenance fields are rejected as unknown_key", () => {
  const fields: BindingField[] = [
    { key: "title", type: "text", required: false },
    { key: "amount", type: "number", required: false },
  ];

  for (const prov of ["decision", "approved_by", "comment"]) {
    it(`rejects "${prov}" injected as a form field (unknown_key, not in safeValues)`, () => {
      const result = validateFormSubmit(
        { title: "x", [prov]: "ATTACKER-CONTROLLED" },
        fields,
        undefined,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.violations.some((v) => v.type === "unknown_key" && v.key === prov)).toBe(true);
      }
    });
  }

  it("rejects ALL provenance fields at once + keeps the valid one out of a failing result", () => {
    const result = validateFormSubmit(
      {
        title: "x",
        decision: "Согласовать", // forge approval verdict
        approved_by: "e-attacker", // forge approver identity
        comment: "forged",
      },
      fields,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const rejectedKeys = result.violations.filter((v) => v.type === "unknown_key").map((v) => v.key);
      expect(rejectedKeys).toEqual(expect.arrayContaining(["decision", "approved_by", "comment"]));
      // No safeValues on a failing result (nothing to write).
      expect("safeValues" in result).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. INHERITED-PROPERTY CONFUSION — keys that exist on Object.prototype
//    (toString, hasOwnProperty, valueOf) must be treated as unknown keys, not
//    accidentally accepted via prototype-chain lookup of fieldMap.
// ---------------------------------------------------------------------------
describe("Враг · inherited Object.prototype names are unknown keys, not accepted", () => {
  const fields: BindingField[] = [{ key: "title", type: "text", required: false }];

  for (const inherited of ["toString", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
    it(`"${inherited}" submitted as a field → unknown_key (Map lookup is not chain-confused)`, () => {
      const result = validateFormSubmit({ [inherited]: "x" }, fields, undefined);
      // fieldMap is a Map (not a plain object), so Map.get("toString") is undefined
      // → unknown_key. (A plain-object lookup would have returned Object.prototype.toString.)
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.violations.some((v) => v.type === "unknown_key" && v.key === inherited)).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. ENUM COERCION — a non-string value for an enum field must be an
//    enum_mismatch (never coerced into the options list).
// ---------------------------------------------------------------------------
describe("Враг · enum fields reject non-string / structurally-tricky values", () => {
  const fields: BindingField[] = [
    { key: "status", type: "enum", required: false, options: ["open", "closed"] },
  ];

  const BAD_VALUES: Array<{ label: string; value: unknown }> = [
    { label: "number", value: 1 },
    { label: "boolean", value: true },
    { label: "null", value: null },
    { label: "object", value: { toString: () => "open" } }, // toString-coercion trick
    { label: "array", value: ["open"] },
    { label: "String-object", value: new String("open") }, // boxed string ≠ primitive
    { label: "whitespace-padded", value: " open" }, // not an exact option member
    { label: "case-variant", value: "OPEN" },
  ];

  for (const { label, value } of BAD_VALUES) {
    it(`enum rejects ${label} value (enum_mismatch)`, () => {
      const result = validateFormSubmit({ status: value }, fields, undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.violations.some((v) => v.type === "enum_mismatch" && v.key === "status")).toBe(true);
      }
    });
  }

  it("the exact option string passes (positive control)", () => {
    const result = validateFormSubmit({ status: "open" }, fields, undefined);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. extractSchemaPropertyKeys — a malicious record_schema cannot smuggle
//    inherited / proto property names into the drift-allowlist, and cannot crash.
// ---------------------------------------------------------------------------
describe("Враг · extractSchemaPropertyKeys is pollution-safe and only returns OWN keys", () => {
  it("ignores a __proto__ key inside properties (no chain pollution)", () => {
    const schema = JSON.parse('{"type":"object","properties":{"title":{},"__proto__":{"x":1}}}');
    const keys = extractSchemaPropertyKeys(schema);
    // __proto__ via JSON.parse is an own key of `properties`, so Object.keys may or
    // may not include it — but the global prototype must NOT be polluted and the
    // set must contain the real field.
    expect(keys.has("title")).toBe(true);
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });

  it("returns empty for a `properties` that is an array (not an object map)", () => {
    const keys = extractSchemaPropertyKeys({ type: "object", properties: ["a", "b"] });
    expect(keys.size).toBe(0);
  });

  it("returns empty for a properties=null / primitive schema (no throw)", () => {
    expect(extractSchemaPropertyKeys({ properties: null }).size).toBe(0);
    expect(extractSchemaPropertyKeys(42).size).toBe(0);
    expect(extractSchemaPropertyKeys("str").size).toBe(0);
    expect(extractSchemaPropertyKeys([]).size).toBe(0);
  });

  it("schema-drift: a binding field NOT in the live schema is flagged even if not submitted", () => {
    const fields: BindingField[] = [
      { key: "title", type: "text", required: false },
      { key: "ghost_field", type: "text", required: false }, // removed from live schema
    ];
    const liveSchema = { type: "object", properties: { title: {} } };
    const result = validateFormSubmit({ title: "ok" }, fields, liveSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.type === "schema_drift" && v.key === "ghost_field")).toBe(true);
    }
  });
});
