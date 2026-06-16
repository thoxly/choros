/**
 * T-0081 / E11.10 — Pure unit tests for field-visibility.ts
 *
 * Covers fitness criteria F-1..F-6 (pure tier), and the serverProjectForm
 * edge helper. No DB, no IO.
 *
 * F-1 — viewer with grant sees field (whole-resource or facet ∋ f)
 * F-2 — viewer without grant: field physically absent + redaction marker
 * F-3 — redacted ≠ present-but-null (structural test via serverProjectForm)
 * F-4 — most-restrictive-wins for multi-role viewer
 * F-5 — permissive role does NOT widen a restrictive one for role-scoped field
 * F-6 — clearance orthogonal to hide (hide happens before classification)
 */

import { describe, it, expect } from "vitest";
import {
  type FieldVisibilityPolicy,
  type FieldProjection,
  roleFieldVisibility,
  serverProjectForm,
} from "../field-visibility.js";
import { type Grant } from "../grant-lattice.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const T = "tenant-A";
const NOW = 1_000_000;

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    tenantId: T,
    id: "g-1",
    roleId: "role-1",
    resourceType: "record",
    operation: "read",
    scope: { kind: "node", hierarchy: "resource", nodeId: "rec-1", nodeLevel: "record" },
    delegable: false,
    grantedBy: "admin",
    createdAt: NOW - 100,
    ...overrides,
  };
}

function makeWholeResourceGrant(overrides: Partial<Grant> = {}): Grant {
  return makeGrant({ resourceFacet: undefined, ...overrides });
}

function makeFacetGrant(fields: string[], overrides: Partial<Grant> = {}): Grant {
  return makeGrant({ resourceFacet: { fields }, ...overrides });
}

const emptyPolicy: FieldVisibilityPolicy = { roleScopedFields: new Set() };
const policyWithF: FieldVisibilityPolicy = { roleScopedFields: new Set(["f_restricted"]) };

// ---------------------------------------------------------------------------
// F-1: viewer with grant sees role-scoped field
// ---------------------------------------------------------------------------

describe("F-1 — viewer with grant sees role-scoped field", () => {
  it("whole-resource grant confers role-scoped field", () => {
    const covering = [makeWholeResourceGrant()];
    const unionVisible = new Set(["f_public", "f_restricted"]);
    const { effectiveVisible, redactedFields } = roleFieldVisibility(
      covering, unionVisible, policyWithF
    );
    expect(effectiveVisible.has("f_restricted")).toBe(true);
    expect(redactedFields).not.toContain("f_restricted");
  });

  it("facet grant with the role-scoped field confers it", () => {
    const covering = [makeFacetGrant(["f_public", "f_restricted"])];
    const unionVisible = new Set(["f_public", "f_restricted"]);
    const { effectiveVisible, redactedFields } = roleFieldVisibility(
      covering, unionVisible, policyWithF
    );
    expect(effectiveVisible.has("f_restricted")).toBe(true);
    expect(redactedFields).not.toContain("f_restricted");
  });

  it("no-op when policy has no role-scoped fields (NF-1 byte-identical)", () => {
    const covering = [makeFacetGrant(["f_public"])];
    const unionVisible = new Set(["f_public", "f_restricted"]);
    const { effectiveVisible, redactedFields } = roleFieldVisibility(
      covering, unionVisible, emptyPolicy
    );
    // With empty policy, everything in unionVisible passes through unchanged.
    expect(effectiveVisible.has("f_public")).toBe(true);
    expect(effectiveVisible.has("f_restricted")).toBe(true);
    expect(redactedFields).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F-2: viewer without grant — field physically absent + redaction marker
// ---------------------------------------------------------------------------

describe("F-2 — viewer without role-scoped grant: field hidden + redaction marker", () => {
  it("facet grant WITHOUT the role-scoped field hides it", () => {
    // Role has a facet that includes f_public but NOT f_restricted.
    const covering = [makeFacetGrant(["f_public"])];
    const unionVisible = new Set(["f_public", "f_restricted"]);
    const { effectiveVisible, redactedFields } = roleFieldVisibility(
      covering, unionVisible, policyWithF
    );
    // f_restricted must NOT be in effectiveVisible.
    expect(effectiveVisible.has("f_restricted")).toBe(false);
    // f_restricted must be in redactedFields.
    expect(redactedFields).toContain("f_restricted");
    // f_public is not role-scoped → still visible.
    expect(effectiveVisible.has("f_public")).toBe(true);
  });

  it("effectiveVisible ⊆ unionVisible (only narrows, never widens)", () => {
    const covering = [makeFacetGrant(["f_public"])];
    const unionVisible = new Set(["f_public", "f_restricted"]);
    const { effectiveVisible } = roleFieldVisibility(covering, unionVisible, policyWithF);
    for (const f of effectiveVisible) {
      expect(unionVisible.has(f)).toBe(true);
    }
  });

  it("field physically absent: serverProjectForm marks it redacted (not present-but-null)", () => {
    // Simulating: PDP has already dropped f_restricted from resolvedFields.
    const resolvedFields = { f_public: "hello" };
    const redactedFields = ["f_restricted"];
    const fieldLabels = { f_restricted: "Restricted Field" };
    const projection = serverProjectForm(
      ["f_public", "f_restricted"],
      fieldLabels,
      resolvedFields,
      redactedFields,
    );
    const restricted = projection.find((p) => p.key === "f_restricted");
    expect(restricted).toBeDefined();
    expect(restricted!.visible).toBe(false);
    // Must be structurally { visible: false, redacted: true, label } — no 'value' key.
    expect("value" in restricted!).toBe(false);
    expect((restricted as Extract<FieldProjection, { visible: false }>).redacted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F-3: redacted ≠ present-but-null (structural distinction)
// ---------------------------------------------------------------------------

describe("F-3 — redacted ≠ present-but-null (structural distinction)", () => {
  it("visible field with null value: { visible: true, value: null }", () => {
    const resolvedFields = { f_public: null };
    const projection = serverProjectForm(["f_public"], {}, resolvedFields, []);
    const fPublic = projection.find((p) => p.key === "f_public");
    expect(fPublic!.visible).toBe(true);
    expect("value" in fPublic!).toBe(true);
    expect((fPublic as Extract<FieldProjection, { visible: true }>).value).toBeNull();
  });

  it("redacted field: { visible: false, redacted: true, label } — no value key", () => {
    const resolvedFields = {};
    const projection = serverProjectForm(
      ["f_restricted"],
      { f_restricted: "Restricted" },
      resolvedFields,
      ["f_restricted"],
    );
    const r = projection.find((p) => p.key === "f_restricted");
    expect(r!.visible).toBe(false);
    expect("value" in r!).toBe(false);
    expect((r as Extract<FieldProjection, { visible: false }>).redacted).toBe(true);
    expect((r as Extract<FieldProjection, { visible: false }>).label).toBe("Restricted");
  });

  it("two states are structurally distinct (null-value vs redacted)", () => {
    const resolvedFields = { f_public: null };
    const projection = serverProjectForm(
      ["f_public", "f_restricted"],
      { f_restricted: "R" },
      resolvedFields,
      ["f_restricted"],
    );
    const pub = projection.find((p) => p.key === "f_public")!;
    const red = projection.find((p) => p.key === "f_restricted")!;
    // Visible-with-null has visible:true and value key.
    expect(pub.visible).toBe(true);
    expect("value" in pub).toBe(true);
    // Redacted has visible:false and NO value key.
    expect(red.visible).toBe(false);
    expect("value" in red).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F-4: most-restrictive-wins for multi-role viewer
// ---------------------------------------------------------------------------

describe("F-4 — most-restrictive-wins for multi-role viewer", () => {
  it("two roles: one confers f_restricted, other does not → field HIDDEN", () => {
    const policy: FieldVisibilityPolicy = { roleScopedFields: new Set(["f_restricted"]) };
    // Role-1 facet: includes f_restricted.
    const grantX = makeFacetGrant(["f_public", "f_restricted"], { id: "g-x", roleId: "role-x" });
    // Role-2 facet: does NOT include f_restricted.
    const grantY = makeFacetGrant(["f_public"], { id: "g-y", roleId: "role-y" });

    const covering = [grantX, grantY];
    const unionVisible = new Set(["f_public", "f_restricted"]); // union-floor includes both
    const { effectiveVisible, redactedFields } = roleFieldVisibility(covering, unionVisible, policy);

    // Most-restrictive: grantY does not confer f_restricted → HIDDEN.
    expect(effectiveVisible.has("f_restricted")).toBe(false);
    expect(redactedFields).toContain("f_restricted");
    // f_public is not role-scoped → still visible.
    expect(effectiveVisible.has("f_public")).toBe(true);
  });

  it("two roles: BOTH confer f_restricted → field VISIBLE", () => {
    const policy: FieldVisibilityPolicy = { roleScopedFields: new Set(["f_restricted"]) };
    const grantX = makeFacetGrant(["f_public", "f_restricted"], { id: "g-x", roleId: "role-x" });
    const grantY = makeFacetGrant(["f_public", "f_restricted"], { id: "g-y", roleId: "role-y" });

    const covering = [grantX, grantY];
    const unionVisible = new Set(["f_public", "f_restricted"]);
    const { effectiveVisible, redactedFields } = roleFieldVisibility(covering, unionVisible, policy);

    expect(effectiveVisible.has("f_restricted")).toBe(true);
    expect(redactedFields).not.toContain("f_restricted");
  });

  it("three roles: two confer, one doesn't → HIDDEN (any dissenter hides)", () => {
    const policy: FieldVisibilityPolicy = { roleScopedFields: new Set(["f_secret"]) };
    const g1 = makeFacetGrant(["f_public", "f_secret"], { id: "g-1", roleId: "r1" });
    const g2 = makeFacetGrant(["f_public", "f_secret"], { id: "g-2", roleId: "r2" });
    const g3 = makeFacetGrant(["f_public"], { id: "g-3", roleId: "r3" }); // dissenter
    const covering = [g1, g2, g3];
    const unionVisible = new Set(["f_public", "f_secret"]);
    const { effectiveVisible, redactedFields } = roleFieldVisibility(covering, unionVisible, policy);
    expect(effectiveVisible.has("f_secret")).toBe(false);
    expect(redactedFields).toContain("f_secret");
  });
});

// ---------------------------------------------------------------------------
// F-5: permissive role does NOT widen a restrictive one for role-scoped field
// ---------------------------------------------------------------------------

describe("F-5 — permissive role does NOT widen restrictive for role-scoped field (security)", () => {
  it("whole-resource grant + restrictive facet grant: role-scoped field still hidden", () => {
    const policy: FieldVisibilityPolicy = { roleScopedFields: new Set(["f_restricted"]) };
    // Role A: whole-resource (would give f_restricted via union-floor).
    const grantWhole = makeWholeResourceGrant({ id: "g-whole", roleId: "role-whole" });
    // Role B: facet that does NOT include f_restricted.
    const grantFacet = makeFacetGrant(["f_public"], { id: "g-facet", roleId: "role-facet" });

    const covering = [grantWhole, grantFacet];
    // union-floor includes f_restricted because whole-resource grant is in covering.
    const unionVisible = new Set(["f_public", "f_restricted"]);
    const { effectiveVisible, redactedFields } = roleFieldVisibility(covering, unionVisible, policy);

    // Even though grantWhole is whole-resource, grantFacet's restrictive policy
    // on a role-scoped field means f_restricted must be HIDDEN.
    expect(effectiveVisible.has("f_restricted")).toBe(false);
    expect(redactedFields).toContain("f_restricted");
    // f_public is not role-scoped → whole-resource floor holds.
    expect(effectiveVisible.has("f_public")).toBe(true);
  });

  it("eff ⊆ unionVisible always (never widens)", () => {
    const policy: FieldVisibilityPolicy = { roleScopedFields: new Set(["f_restricted"]) };
    const grantWhole = makeWholeResourceGrant({ id: "g-whole" });
    const grantFacet = makeFacetGrant(["f_public"], { id: "g-facet" });
    const unionVisible = new Set(["f_public", "f_restricted", "f_extra"]);
    const { effectiveVisible } = roleFieldVisibility([grantWhole, grantFacet], unionVisible, policy);
    for (const f of effectiveVisible) {
      expect(unionVisible.has(f)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// F-6: hide-layer orthogonal to classification (hide before mask)
// ---------------------------------------------------------------------------

describe("F-6 — hide-layer orthogonal to classification (field absent before maskFields)", () => {
  it("field removed by hide-layer is absent from effectiveVisible → not iterated by maskFields", () => {
    const policy: FieldVisibilityPolicy = { roleScopedFields: new Set(["fin_field"]) };
    // Grant does NOT confer fin_field → it is role-scoped and gets hidden.
    const grant = makeFacetGrant(["name"]);
    const unionVisible = new Set(["name", "fin_field"]);
    const { effectiveVisible, redactedFields } = roleFieldVisibility([grant], unionVisible, policy);

    // fin_field must be absent from effectiveVisible — classification masking
    // (maskFields) only iterates effectiveVisible, so fin_field cannot "reappear"
    // through a reveal/partial transform. (F-6 is a construction guarantee: the
    // pure function returns eff that excludes it, and projectFields only sees eff.)
    expect(effectiveVisible.has("fin_field")).toBe(false);
    expect(redactedFields).toContain("fin_field");
    expect(effectiveVisible.has("name")).toBe(true);
  });

  it("no field can be added by hide-layer (monotone subtract-only)", () => {
    const policy: FieldVisibilityPolicy = { roleScopedFields: new Set(["f_a", "f_b"]) };
    const grant = makeFacetGrant(["f_a"]); // only confers f_a
    // unionVisible has only f_a (f_b not even in union-floor — wouldn't appear anyway).
    const unionVisible = new Set(["f_a"]);
    const { effectiveVisible } = roleFieldVisibility([grant], unionVisible, policy);
    // effectiveVisible can only be a subset of unionVisible.
    expect(effectiveVisible.size).toBeLessThanOrEqual(unionVisible.size);
    for (const f of effectiveVisible) {
      expect(unionVisible.has(f)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases and invariants
// ---------------------------------------------------------------------------

describe("Edge cases and invariants", () => {
  it("empty unionVisible → empty effectiveVisible, empty redactedFields", () => {
    const grant = makeWholeResourceGrant();
    const { effectiveVisible, redactedFields } = roleFieldVisibility(
      [grant], new Set(), policyWithF
    );
    expect(effectiveVisible.size).toBe(0);
    expect(redactedFields).toHaveLength(0);
  });

  it("non-role-scoped fields always pass through unchanged (union-floor)", () => {
    const policy: FieldVisibilityPolicy = { roleScopedFields: new Set(["only_this"]) };
    // Grant without only_this in facet.
    const grant = makeFacetGrant(["field_a", "field_b"]);
    const unionVisible = new Set(["field_a", "field_b", "only_this"]);
    const { effectiveVisible } = roleFieldVisibility([grant], unionVisible, policy);
    // Non-role-scoped fields are unchanged.
    expect(effectiveVisible.has("field_a")).toBe(true);
    expect(effectiveVisible.has("field_b")).toBe(true);
    // Role-scoped field without explicit grant → hidden.
    expect(effectiveVisible.has("only_this")).toBe(false);
  });

  it("malformed facet (non-array fields) ⇒ fail-closed: zero conferred → role-scoped field hidden", () => {
    const policy: FieldVisibilityPolicy = { roleScopedFields: new Set(["f_secret"]) };
    const grantMalformed = makeGrant({ resourceFacet: { fields: 123 } }); // malformed
    const unionVisible = new Set(["f_secret"]);
    const { effectiveVisible, redactedFields } = roleFieldVisibility(
      [grantMalformed], unionVisible, policy
    );
    // Malformed facet confers nothing → role-scoped field is hidden (fail-closed).
    expect(effectiveVisible.has("f_secret")).toBe(false);
    expect(redactedFields).toContain("f_secret");
  });

  it("serverProjectForm: field in neither resolvedFields nor redactedFields is omitted", () => {
    const projection = serverProjectForm(
      ["f_present", "f_absent", "f_redacted"],
      { f_redacted: "Redacted" },
      { f_present: 42 },
      ["f_redacted"],
    );
    // f_present → visible
    // f_redacted → redacted marker
    // f_absent → omitted (not in resolvedFields, not in redactedFields)
    expect(projection).toHaveLength(2);
    expect(projection.find((p) => p.key === "f_absent")).toBeUndefined();
  });

  it("serverProjectForm: uses key as label fallback when fieldLabels missing", () => {
    const projection = serverProjectForm(
      ["f_hidden"],
      {}, // no labels
      {},
      ["f_hidden"],
    );
    const r = projection.find((p) => p.key === "f_hidden");
    expect(r!.visible).toBe(false);
    expect((r as Extract<FieldProjection, { visible: false }>).label).toBe("f_hidden");
  });
});
