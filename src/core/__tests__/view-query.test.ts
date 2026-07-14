/**
 * T-0581 (view registry) — src/core/view-query.ts unit tests.
 *
 * Covers:
 *   AC-13/FF-VR-3  Injection safety: a hostile field_key never reaches the SQL
 *                  string as raw text (whitelist-drop); filter VALUES are ALWAYS
 *                  bind params, never string-interpolated.
 *   R-3            Numeric field types are ::numeric-cast in ORDER BY / WHERE so
 *                  "10" sorts after "9" (not lexicographically before it).
 *   R-4            NULL/absent-key semantics: is_empty/is_not_empty use IS NULL
 *                  OR = ''; gt/lt on an absent (NULL) key never matches (documented
 *                  SQL NULL-comparison semantics, not a silent throw).
 *   FR-8/AC-7      A filter over a field_key ABSENT from visibleFieldKeys is
 *                  silently dropped (never becomes a SQL predicate) — no oracle.
 */

import { describe, it, expect } from "vitest";
import { buildFieldKeyWhitelist, translateFilters, translateSort } from "../view-query.js";
import type { ViewFilter, ViewSort } from "../view-config.js";

const RECORD_SCHEMA = {
  type: "object",
  properties: {
    amount: { type: "number", "x-money": { currency: "RUB" } },
    status: { type: "string", enum: ["open", "won", "lost"] },
    notes: { type: "string" },
    signup_date: { type: "string", "x-date": true },
    tags: { type: "array", items: { type: "string", enum: ["a", "b"] }, "x-multi-select": true },
  },
  required: [],
  "x-field-order": ["amount", "status", "notes", "signup_date", "tags"],
};

const whitelist = buildFieldKeyWhitelist(RECORD_SCHEMA);

describe("view-query: buildFieldKeyWhitelist", () => {
  it("includes every record_schema field plus the created_at pseudo-column", () => {
    expect(whitelist.typeByKey.get("amount")).toBe("money");
    expect(whitelist.typeByKey.get("created_at")).toBe("created_at");
    expect(whitelist.typeByKey.has("not_a_field")).toBe(false);
  });
});

describe("AC-13/FF-VR-3: injection safety", () => {
  it("drops a filter whose field_key is NOT in the whitelist (never becomes SQL)", () => {
    const filters: ViewFilter[] = [
      { field_key: "amount'; DROP TABLE choros.record; --", op: "eq", value: 1 },
    ];
    const { conds, params } = translateFilters(filters, whitelist, 1);
    expect(conds).toEqual([]);
    expect(params).toEqual([]);
  });

  it("a value containing SQL metacharacters is passed as a bind param, never concatenated", () => {
    const filters: ViewFilter[] = [
      { field_key: "notes", op: "eq", value: "x'; DROP TABLE choros.record; --" },
    ];
    const { conds, params } = translateFilters(filters, whitelist, 1);
    expect(conds).toHaveLength(1);
    // The SQL text must reference ONLY a $-placeholder for the value — the raw
    // hostile string must never appear inside the emitted SQL fragment.
    expect(conds[0]).not.toContain("DROP TABLE");
    expect(conds[0]).toMatch(/\$\d+$/);
    expect(params).toContain("x'; DROP TABLE choros.record; --");
  });

  it("field_key drives a FIXED code-controlled template, not raw interpolation of attacker text", () => {
    // Even a "look-alike" field_key that happens to match a real key exactly
    // (the ONLY way to pass the whitelist) still only ever produces the fixed
    // `r.data->>'<key>'` shape — there is no way to smuggle extra SQL via the key
    // because the key must be an EXACT Map member (whitelist.has), not a prefix
    // or pattern match.
    const filters: ViewFilter[] = [{ field_key: "amount", op: "eq", value: 5 }];
    const { conds } = translateFilters(filters, whitelist, 1);
    expect(conds[0]).toBe("(r.data->>'amount')::numeric = $2");
  });

  it("in-operator value array is passed as a single bind param (text[]), not interpolated per-item", () => {
    const filters: ViewFilter[] = [{ field_key: "status", op: "in", value: ["open", "won"] }];
    const { conds, params } = translateFilters(filters, whitelist, 1);
    expect(conds[0]).toBe("r.data->>'status' = ANY($2::text[])");
    expect(params).toEqual([["open", "won"]]);
  });
});

describe("R-3: numeric field types are ::numeric-cast (10 sorts after 9)", () => {
  it("translateSort casts a money field to ::numeric", () => {
    const sort: ViewSort[] = [{ field_key: "amount", dir: "desc" }];
    const { orderBy } = translateSort(sort, whitelist);
    expect(orderBy).toBe("(r.data->>'amount')::numeric DESC, r.id ASC");
  });

  it("translateFilters casts a money field to ::numeric for gt/gte/lt/lte/between", () => {
    const filters: ViewFilter[] = [{ field_key: "amount", op: "gte", value: 100000 }];
    const { conds } = translateFilters(filters, whitelist, 1);
    expect(conds[0]).toBe("(r.data->>'amount')::numeric >= $2");
  });

  it("does NOT cast a string/date field (lexicographic order is correct for ISO dates)", () => {
    const sort: ViewSort[] = [{ field_key: "signup_date", dir: "asc" }];
    const { orderBy } = translateSort(sort, whitelist);
    expect(orderBy).toBe("r.data->>'signup_date' ASC, r.id ASC");
  });

  it("always appends r.id ASC as a stable secondary key, even for an empty sort", () => {
    const { orderBy } = translateSort([], whitelist);
    expect(orderBy).toBe("r.id ASC");
  });
});

describe("R-4: NULL / absent-key semantics", () => {
  it("is_empty matches NULL OR empty-string (absent key or explicit empty)", () => {
    const filters: ViewFilter[] = [{ field_key: "notes", op: "is_empty", value: null }];
    const { conds, params } = translateFilters(filters, whitelist, 1);
    expect(conds[0]).toBe("(r.data->>'notes' IS NULL OR r.data->>'notes' = '')");
    expect(params).toEqual([]); // no bind params — pure NULL/empty check
  });

  it("is_not_empty requires NOT NULL AND NOT empty-string", () => {
    const filters: ViewFilter[] = [{ field_key: "notes", op: "is_not_empty", value: null }];
    const { conds } = translateFilters(filters, whitelist, 1);
    expect(conds[0]).toBe("(r.data->>'notes' IS NOT NULL AND r.data->>'notes' <> '')");
  });

  it("gt/lt use a plain SQL comparison against the JSONB text path (NULL never matches, standard SQL three-valued logic)", () => {
    const filters: ViewFilter[] = [{ field_key: "amount", op: "gt", value: 0 }];
    const { conds } = translateFilters(filters, whitelist, 1);
    // No IS NULL guard is added — this documents that gt/lt/between rely on
    // standard SQL NULL semantics (NULL > 0 is UNKNOWN, row excluded), matching
    // the ADR's documented R-4 resolution (no special-casing beyond is_empty/
    // is_not_empty, which exist precisely to let callers test absence explicitly).
    expect(conds[0]).toBe("(r.data->>'amount')::numeric > $2");
  });
});

describe("FR-8/AC-7: visibleFieldKeys excludes redacted fields from translation", () => {
  it("drops a filter over a field_key NOT in visibleFieldKeys (never becomes SQL — no oracle)", () => {
    const filters: ViewFilter[] = [{ field_key: "amount", op: "eq", value: 999999 }];
    const visibleFieldKeys = new Set(["status", "notes"]); // amount is redacted for this actor
    const { conds, params } = translateFilters(filters, whitelist, 1, visibleFieldKeys);
    expect(conds).toEqual([]);
    expect(params).toEqual([]);
  });

  it("keeps a filter over a field_key that IS in visibleFieldKeys", () => {
    const filters: ViewFilter[] = [{ field_key: "status", op: "eq", value: "open" }];
    const visibleFieldKeys = new Set(["status", "notes"]);
    const { conds } = translateFilters(filters, whitelist, 1, visibleFieldKeys);
    expect(conds).toHaveLength(1);
  });

  it("when visibleFieldKeys is omitted entirely, no field is excluded on that basis (honest-degrade)", () => {
    const filters: ViewFilter[] = [{ field_key: "amount", op: "eq", value: 1 }];
    const { conds } = translateFilters(filters, whitelist, 1, undefined);
    expect(conds).toHaveLength(1);
  });
});

describe("invalid operator-for-type is dropped defensively (validateViewConfig is the primary gate)", () => {
  it("drops a gt filter on a select field (not in its allowed-ops list)", () => {
    const filters: ViewFilter[] = [{ field_key: "status", op: "gt", value: "open" }];
    const { conds } = translateFilters(filters, whitelist, 1);
    expect(conds).toEqual([]);
  });
});

describe("translateSort drops non-whitelisted / non-sortable keys defensively", () => {
  it("drops a sort on multi-select (tags) — not server-sortable", () => {
    const { orderBy } = translateSort([{ field_key: "tags", dir: "asc" }], whitelist);
    expect(orderBy).toBe("r.id ASC");
  });

  it("drops a sort on an unknown field_key", () => {
    const { orderBy } = translateSort([{ field_key: "ghost", dir: "asc" }], whitelist);
    expect(orderBy).toBe("r.id ASC");
  });
});
