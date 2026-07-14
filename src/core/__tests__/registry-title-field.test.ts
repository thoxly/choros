/**
 * src/core/__tests__/registry-title-field.test.ts — T-0613 (ADR-T0613, столп 6).
 *
 * ZERO IO — pure unit tests over pickTitleFieldKey (src/core/registry-title-field.ts).
 * No pg, no http, no fs.
 *
 * D-064 anti-case: field keys/values in these fixtures are GENERIC placeholders
 * (code/name/label/amount) — no business-domain literal ("ИНН"/"Поставщик"/
 * organisation name) appears here or in the module under test.
 *
 * Coverage:
 *   - a schema whose CODE-shaped field comes before its NAME-shaped field in
 *     property order → the title-field key is the name field, not the code.
 *   - a schema with no name/title-shaped key → falls back to the first plain
 *     textual (non-numeric/non-enum/non-boolean/etc.) field.
 *   - a schema with only a numeric/code field (no textual field at all) →
 *     null (graceful — caller keeps its own data-only fallback).
 *   - an explicit `x-title-field` annotation wins over both the name-shaped
 *     guess and the first-textual fallback.
 *   - malformed/absent schema → null, never throws.
 */

import { describe, it, expect } from "vitest";
import { pickTitleFieldKey } from "../registry-title-field.js";

describe("pickTitleFieldKey — step 3: first plain-textual field wins over an earlier numeric/code field", () => {
  it("code-shaped field (type:string, no name-like key) placed BEFORE a name-like field: name field wins", () => {
    // Regression fixture for the exact live defect (LIVE_PROOF T-0607): a
    // code/number field precedes the record's actual name in schema order.
    const schema = {
      type: "object",
      properties: {
        code: { type: "string" }, // e.g. a numeric-looking identifier code, first in schema order
        name: { type: "string" }, // the record's actual human-readable name, second
      },
    };
    expect(pickTitleFieldKey(schema)).toBe("name");
  });

  it("a genuinely numeric field before a name-like field: name field still wins (step 2 fires before step 3 even looks at types)", () => {
    const schema = {
      properties: {
        amount: { type: "number" },
        display_name: { type: "string" },
      },
    };
    expect(pickTitleFieldKey(schema)).toBe("display_name");
  });

  it("no name/title-shaped key present: falls back to the first plain-textual field, skipping a numeric field first in order", () => {
    const schema = {
      properties: {
        quantity: { type: "number" },
        description: { type: "string" },
      },
    };
    expect(pickTitleFieldKey(schema)).toBe("description");
  });

  it("Russian name-like key is recognized generically (наименование/название/имя/заголовок)", () => {
    const schema = {
      properties: {
        код: { type: "string" },
        наименование: { type: "string" },
      },
    };
    expect(pickTitleFieldKey(schema)).toBe("наименование");
  });

  it("title-like key matching is case-insensitive", () => {
    const schema = {
      properties: {
        Code: { type: "string" },
        DisplayName: { type: "string" },
      },
    };
    // "DisplayName" normalized ("displayname") matches the TITLE_LIKE_KEYS entry.
    expect(pickTitleFieldKey(schema)).toBe("DisplayName");
  });
});

describe("pickTitleFieldKey — step 4: no textual candidate at all → null (graceful fallback)", () => {
  it("only a numeric field, no textual field: returns null", () => {
    const schema = {
      properties: {
        amount: { type: "number" },
      },
    };
    expect(pickTitleFieldKey(schema)).toBeNull();
  });

  it("only enum/boolean/date-shaped fields, no plain text: returns null", () => {
    const schema = {
      properties: {
        status: { type: "string", enum: ["a", "b"] },
        active: { type: "boolean" },
        opened_at: { type: "string", format: "date" },
      },
    };
    expect(pickTitleFieldKey(schema)).toBeNull();
  });

  it("empty properties object: returns null", () => {
    expect(pickTitleFieldKey({ properties: {} })).toBeNull();
  });
});

describe("pickTitleFieldKey — step 1: explicit x-title-field annotation wins", () => {
  it("explicit x-title-field overrides both the name-shaped guess and first-textual fallback", () => {
    const schema = {
      properties: {
        name: { type: "string" },
        code: { type: "string" },
      },
      "x-title-field": "code",
    };
    // Tenant explicitly marked `code` as the title field — honored even
    // though `name` would otherwise win by the key-shape guess.
    expect(pickTitleFieldKey(schema)).toBe("code");
  });

  it("x-title-field pointing at a key that doesn't exist in properties is ignored (falls through to step 2/3)", () => {
    const schema = {
      properties: {
        name: { type: "string" },
      },
      "x-title-field": "nonexistent_key",
    };
    expect(pickTitleFieldKey(schema)).toBe("name");
  });

  it("x-title-field that isn't a string is ignored", () => {
    const schema = {
      properties: {
        name: { type: "string" },
      },
      "x-title-field": 42,
    };
    expect(pickTitleFieldKey(schema)).toBe("name");
  });
});

describe("pickTitleFieldKey — malformed/absent schema degrades to null, never throws", () => {
  it("null / undefined / non-object / missing properties", () => {
    expect(pickTitleFieldKey(null)).toBeNull();
    expect(pickTitleFieldKey(undefined)).toBeNull();
    expect(pickTitleFieldKey("not an object")).toBeNull();
    expect(pickTitleFieldKey({})).toBeNull();
    expect(pickTitleFieldKey({ properties: null })).toBeNull();
    expect(pickTitleFieldKey({ properties: "nope" })).toBeNull();
  });

  it("a malformed individual property definition is skipped, not thrown on", () => {
    const schema = {
      properties: {
        broken: "not an object",
        name: { type: "string" },
      },
    };
    expect(pickTitleFieldKey(schema)).toBe("name");
  });
});
