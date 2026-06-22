/**
 * T-0401 [D7-3] — data-access-port unit tests
 *
 * Tests:
 *   DAP-1  parsePaginationParams — defaults (no params)
 *   DAP-2  parsePaginationParams — custom limit clamped to [1, MAX_PAGE_SIZE]
 *   DAP-3  parsePaginationParams — cursor round-trip (encode → decode → encode)
 *   DAP-4  parsePaginationParams — malformed cursor → null (graceful)
 *   DAP-5  applyFieldVisibilityRedaction — empty policy → no-op (NF-1)
 *   DAP-6  applyFieldVisibilityRedaction — role-scoped field redacted when ALL grants must confer it
 *   DAP-7  applyFieldVisibilityRedaction — redacted key is PHYSICALLY ABSENT from result (F-3)
 *   DAP-8  applyWriteMask — whole-resource (undefined facet) → never denied
 *   DAP-9  applyWriteMask — restricted facet blocks system-only field
 *   DAP-10 applyWriteMask — restricted facet allows non-system fields freely
 *   DAP-11 paginateInMemory — first page (page=0)
 *   DAP-12 paginateInMemory — last page
 *   DAP-13 paginateInMemory — page beyond end → clamped to last
 *   DAP-14 paginateInMemory — empty list → one page with empty items
 *   DAP-15 encodeRecordsCursor / decodeRecordsCursor — round-trip
 *   DAP-16 decodeRecordsCursor — malformed input → null
 */

import { describe, it, expect } from "vitest";
import {
  parsePaginationParams,
  applyFieldVisibilityRedaction,
  applyWriteMask,
  paginateInMemory,
  encodeRecordsCursor,
  decodeRecordsCursor,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  type RecordsCursor,
} from "../core/data-access-port.js";
import type { Grant } from "../core/grant-lattice.js";
import type { FieldVisibilityPolicy } from "../core/field-visibility.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(obj: Record<string, string>): URLSearchParams {
  return new URLSearchParams(obj);
}

// Minimal Grant that confers ALL fields (whole-resource: no resourceFacet).
function wholeResourceGrant(): Grant {
  return {
    id: "g1",
    subjectId: "actor",
    subjectKind: "human",
    tenantId: "t1",
    op: "record:read",
    resourceKind: "record",
    scope: null,
    resourceFacet: undefined,
    grantedAt: Date.now(),
    expiresAt: null,
    effectiveAt: null,
    via: null,
    proposedBy: null,
    confirmedBy: null,
  } as unknown as Grant;
}

// Minimal Grant that confers ONLY listed fields (facet-restricted).
function facetGrant(fields: string[]): Grant {
  return {
    ...wholeResourceGrant(),
    resourceFacet: { fields },
  } as unknown as Grant;
}

const EMPTY_POLICY: FieldVisibilityPolicy = { roleScopedFields: new Set() };
const POLICY_WITH_RESTRICTED: FieldVisibilityPolicy = {
  roleScopedFields: new Set(["restricted_field"]),
};

// ---------------------------------------------------------------------------
// DAP-1: parsePaginationParams — defaults
// ---------------------------------------------------------------------------
describe("T-0401 DAP-1: parsePaginationParams defaults", () => {
  it("returns DEFAULT_PAGE_SIZE limit and page=0 when no params", () => {
    const result = parsePaginationParams(makeParams({}));
    expect(result.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(result.page).toBe(0);
    expect(result.cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DAP-2: parsePaginationParams — clamping
// ---------------------------------------------------------------------------
describe("T-0401 DAP-2: parsePaginationParams limit clamping", () => {
  it("clamps limit above MAX_PAGE_SIZE to MAX_PAGE_SIZE", () => {
    const result = parsePaginationParams(makeParams({ limit: String(MAX_PAGE_SIZE + 1000) }));
    expect(result.limit).toBe(MAX_PAGE_SIZE);
  });

  it("clamps limit below 1 to 1", () => {
    const result = parsePaginationParams(makeParams({ limit: "0" }));
    expect(result.limit).toBe(1);
  });

  it("accepts a valid limit within range", () => {
    const result = parsePaginationParams(makeParams({ limit: "25" }));
    expect(result.limit).toBe(25);
  });

  it("uses DEFAULT_PAGE_SIZE for non-numeric limit", () => {
    const result = parsePaginationParams(makeParams({ limit: "abc" }));
    expect(result.limit).toBe(DEFAULT_PAGE_SIZE);
  });
});

// ---------------------------------------------------------------------------
// DAP-3: parsePaginationParams — cursor round-trip
// ---------------------------------------------------------------------------
describe("T-0401 DAP-3: parsePaginationParams cursor round-trip", () => {
  it("decodes a well-formed cursor from ?after=", () => {
    const cursor: RecordsCursor = { createdAt: 1700000000000, id: "abc-123" };
    const encoded = encodeRecordsCursor(cursor);
    const result = parsePaginationParams(makeParams({ after: encoded }));
    expect(result.cursor).not.toBeNull();
    expect(result.cursor!.createdAt).toBe(1700000000000);
    expect(result.cursor!.id).toBe("abc-123");
  });
});

// ---------------------------------------------------------------------------
// DAP-4: parsePaginationParams — malformed cursor
// ---------------------------------------------------------------------------
describe("T-0401 DAP-4: parsePaginationParams malformed cursor", () => {
  it("returns null cursor for garbage ?after= value", () => {
    const result = parsePaginationParams(makeParams({ after: "not-valid-base64!!" }));
    expect(result.cursor).toBeNull();
  });

  it("returns null cursor for base64 that decodes to non-object JSON", () => {
    const encoded = Buffer.from("42").toString("base64url");
    const result = parsePaginationParams(makeParams({ after: encoded }));
    expect(result.cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DAP-5: applyFieldVisibilityRedaction — empty policy is a no-op
// ---------------------------------------------------------------------------
describe("T-0401 DAP-5: applyFieldVisibilityRedaction empty policy (NF-1)", () => {
  it("with empty policy, all fields are visible (no-op)", () => {
    const data = { name: "Alice", age: 30, secret: "classified" };
    const unionVisible = new Set(Object.keys(data));
    const grants = [wholeResourceGrant()];

    const { redacted, redactedKeys } = applyFieldVisibilityRedaction(
      data,
      grants,
      unionVisible,
      EMPTY_POLICY,
    );

    expect(Object.keys(redacted)).toHaveLength(3);
    expect(redacted["name"]).toBe("Alice");
    expect(redacted["secret"]).toBe("classified");
    expect(redactedKeys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DAP-6: applyFieldVisibilityRedaction — role-scoped field redacted
// ---------------------------------------------------------------------------
describe("T-0401 DAP-6: applyFieldVisibilityRedaction role-scoped field redacted", () => {
  it("role-scoped field is redacted when facet-restricted grant does not confer it", () => {
    const data = { name: "Alice", restricted_field: "sensitive" };
    const unionVisible = new Set(Object.keys(data));
    // The grant only confers "name", NOT "restricted_field".
    const grants = [facetGrant(["name"])];

    const { redacted, redactedKeys } = applyFieldVisibilityRedaction(
      data,
      grants,
      unionVisible,
      POLICY_WITH_RESTRICTED,
    );

    expect(Object.keys(redacted)).toHaveLength(1);
    expect(redacted["name"]).toBe("Alice");
    expect(redactedKeys).toContain("restricted_field");
  });

  it("role-scoped field visible when whole-resource grant confers everything", () => {
    const data = { name: "Alice", restricted_field: "sensitive" };
    const unionVisible = new Set(Object.keys(data));
    const grants = [wholeResourceGrant()];

    const { redacted, redactedKeys } = applyFieldVisibilityRedaction(
      data,
      grants,
      unionVisible,
      POLICY_WITH_RESTRICTED,
    );

    expect(Object.keys(redacted)).toHaveLength(2);
    expect(redacted["restricted_field"]).toBe("sensitive");
    expect(redactedKeys).toHaveLength(0);
  });

  it("most-restrictive: if ANY grant withholds the role-scoped field, it is redacted", () => {
    const data = { name: "Alice", restricted_field: "sensitive" };
    const unionVisible = new Set(Object.keys(data));
    // Two grants: one whole-resource, one facet that omits restricted_field.
    // Most-restrictive-wins → restricted_field should be redacted.
    const grants = [wholeResourceGrant(), facetGrant(["name"])];

    const { redacted, redactedKeys } = applyFieldVisibilityRedaction(
      data,
      grants,
      unionVisible,
      POLICY_WITH_RESTRICTED,
    );

    expect("restricted_field" in redacted).toBe(false);
    expect(redactedKeys).toContain("restricted_field");
  });
});

// ---------------------------------------------------------------------------
// DAP-7: redacted key is PHYSICALLY ABSENT from result (F-3)
// ---------------------------------------------------------------------------
describe("T-0401 DAP-7: redacted key is physically absent (F-3)", () => {
  it("the redacted key is not present as null — it is entirely absent", () => {
    const data = { name: "Alice", restricted_field: "sensitive" };
    const unionVisible = new Set(Object.keys(data));
    const grants = [facetGrant(["name"])];

    const { redacted } = applyFieldVisibilityRedaction(
      data,
      grants,
      unionVisible,
      POLICY_WITH_RESTRICTED,
    );

    // Key must not exist at all, not even as null
    expect("restricted_field" in redacted).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(redacted, "restricted_field")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DAP-8: applyWriteMask — whole-resource never denied
// ---------------------------------------------------------------------------
describe("T-0401 DAP-8: applyWriteMask whole-resource never denied", () => {
  it("undefined writeFacet (system actor) is never denied", () => {
    const data = { circuit_id: "abc", activation_key_issued_at: 123 };
    const result = applyWriteMask(undefined, data);
    expect(result.denied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DAP-9: applyWriteMask — restricted facet blocks system-only field
// ---------------------------------------------------------------------------
describe("T-0401 DAP-9: applyWriteMask blocks system-only fields", () => {
  it("denies circuit_id when caller has restricted facet without it", () => {
    const data = { name: "test", circuit_id: "abc" };
    const result = applyWriteMask(["name"], data);
    expect(result.denied).toBe(true);
    if (result.denied) {
      expect(result.blockedFields).toContain("circuit_id");
    }
  });

  it("denies activation_key_issued_at when caller has restricted facet without it", () => {
    const data = { activation_key_issued_at: 1000 };
    const result = applyWriteMask(["name"], data);
    expect(result.denied).toBe(true);
    if (result.denied) {
      expect(result.blockedFields).toContain("activation_key_issued_at");
    }
  });
});

// ---------------------------------------------------------------------------
// DAP-10: applyWriteMask — restricted facet allows non-system fields
// ---------------------------------------------------------------------------
describe("T-0401 DAP-10: applyWriteMask allows non-system fields freely", () => {
  it("does not deny regular record fields even with restricted facet", () => {
    const data = { company_name: "ACME", plan: "basic" };
    const result = applyWriteMask(["company_name", "plan"], data);
    expect(result.denied).toBe(false);
  });

  it("does not deny non-system fields even when facet is empty", () => {
    // Non-system fields are not in SYSTEM_ONLY_FIELDS — they are always writable.
    const data = { company_name: "ACME" };
    const result = applyWriteMask([], data);
    expect(result.denied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DAP-11: paginateInMemory — first page
// ---------------------------------------------------------------------------
describe("T-0401 DAP-11: paginateInMemory first page", () => {
  it("returns first 3 items of 10 with limit=3", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = paginateInMemory(items, 0, 3);

    expect(result.items).toEqual([1, 2, 3]);
    expect(result.page).toBe(0);
    expect(result.total).toBe(10);
    expect(result.totalPages).toBe(4); // ceil(10/3)=4
    expect(result.limit).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// DAP-12: paginateInMemory — last page
// ---------------------------------------------------------------------------
describe("T-0401 DAP-12: paginateInMemory last page", () => {
  it("returns remaining items on last partial page", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = paginateInMemory(items, 3, 3); // page=3: items 9..10

    expect(result.items).toEqual([10]);
    expect(result.page).toBe(3);
    expect(result.total).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// DAP-13: paginateInMemory — page beyond end clamped
// ---------------------------------------------------------------------------
describe("T-0401 DAP-13: paginateInMemory page beyond end", () => {
  it("clamps page to last valid page when page > totalPages-1", () => {
    const items = [1, 2, 3];
    const result = paginateInMemory(items, 100, 2); // way beyond end

    expect(result.page).toBe(1); // last valid page (ceil(3/2)=2 pages → pages 0,1)
    expect(result.items).toEqual([3]);
  });
});

// ---------------------------------------------------------------------------
// DAP-14: paginateInMemory — empty list
// ---------------------------------------------------------------------------
describe("T-0401 DAP-14: paginateInMemory empty list", () => {
  it("returns one page with zero items when list is empty", () => {
    const result = paginateInMemory([], 0, 10);

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(1);
    expect(result.page).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DAP-15: encodeRecordsCursor / decodeRecordsCursor round-trip
// ---------------------------------------------------------------------------
describe("T-0401 DAP-15: cursor encode/decode round-trip", () => {
  it("decodes what was encoded with exact same values", () => {
    const original: RecordsCursor = {
      createdAt: 1717000000000,
      id: "00000000-0000-0000-0000-000000000001",
    };
    const encoded = encodeRecordsCursor(original);
    const decoded = decodeRecordsCursor(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.createdAt).toBe(original.createdAt);
    expect(decoded!.id).toBe(original.id);
  });

  it("produces an opaque base64url string (no slashes or padding)", () => {
    const cursor: RecordsCursor = { createdAt: 1, id: "x" };
    const encoded = encodeRecordsCursor(cursor);
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("=");
  });
});

// ---------------------------------------------------------------------------
// DAP-16: decodeRecordsCursor — malformed input
// ---------------------------------------------------------------------------
describe("T-0401 DAP-16: decodeRecordsCursor malformed input", () => {
  it("returns null for empty string", () => {
    expect(decodeRecordsCursor("")).toBeNull();
  });

  it("returns null for plain text", () => {
    expect(decodeRecordsCursor("hello world")).toBeNull();
  });

  it("returns null for base64 JSON object missing id field", () => {
    const encoded = Buffer.from(JSON.stringify({ createdAt: 123 })).toString("base64url");
    expect(decodeRecordsCursor(encoded)).toBeNull();
  });

  it("returns null for base64 JSON object missing createdAt field", () => {
    const encoded = Buffer.from(JSON.stringify({ id: "abc" })).toString("base64url");
    expect(decodeRecordsCursor(encoded)).toBeNull();
  });

  it("returns null for base64 that decodes to a JSON array", () => {
    const encoded = Buffer.from(JSON.stringify([1, 2, 3])).toString("base64url");
    expect(decodeRecordsCursor(encoded)).toBeNull();
  });
});
