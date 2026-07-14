/**
 * T-0081 / E11.10 — Redaction integration tests via resolveFor
 *
 * Tests that the T-0081 most-restrictive-wins post-filter integrates correctly
 * with the single PDP (resolveFor in grant-resolver.ts). Verifies:
 *  - Physical key absence in ResolvedView.fields (not null — capability-not-text)
 *  - The hide-layer is applied BEFORE projectFields (so classification cannot
 *    resurrect a hidden field)
 *  - visibleFields() union semantics are UNCHANGED (F-5 integration)
 *  - NF-1: no fieldPolicy → byte-identical to pre-T-0081
 *
 * All IO is behind in-memory ports (pure, no DB).
 */

import { describe, it, expect } from "vitest";
import {
  type Grant,
  type AncestryOracle,
} from "../grant-lattice.js";
import {
  type GrantSource,
  type RecordSource,
  type ResolverDeps,
  resolveFor,
} from "../grant-resolver.js";
import {
  type FieldVisibilityPolicy,
} from "../field-visibility.js";
import {
  type ObjectHandle,
  type ResolveSubject,
  makeHandle,
} from "../object-handle.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TENANT = "tenant-test";
const REG_ID = "reg-test";
const REC_ID = "rec-test";
const NOW = 2_000_000;

/** Flat ancestry oracle: REC_ID ⊑ REG_ID (record is under registry). */
function makeOracle(): AncestryOracle {
  return {
    isDescendantOrSelf(_hierarchy, descendantId, ancestorId): boolean {
      if (descendantId === ancestorId) return true;
      if (descendantId === REC_ID && ancestorId === REG_ID) return true;
      return false;
    },
  };
}

function makeRecordSource(fields: Record<string, unknown>): RecordSource {
  return {
    async getRecord() { return fields; },
  };
}

function makeGrantSource(grants: Grant[]): GrantSource {
  return {
    async getGrants() { return grants; },
  };
}

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    tenantId: TENANT,
    id: "g-1",
    roleId: "role-1",
    resourceType: "record",
    operation: "read",
    // Scope at registry level (REG_ID) so it covers the record (REC_ID ⊑ REG_ID).
    scope: {
      kind: "node",
      hierarchy: "resource",
      nodeId: REG_ID,
      nodeLevel: "registry",
    },
    delegable: false,
    grantedBy: "admin",
    createdAt: NOW - 1000,
    ...overrides,
  };
}

function makeSubject(): ResolveSubject {
  return { tenantId: TENANT, subjectId: "user-1" };
}

function makeRecordHandle(): ObjectHandle {
  return makeHandle(
    { kind: "record", tenantId: TENANT, registryId: REG_ID, recordId: REC_ID },
    TENANT,
    undefined,
  );
}

// ---------------------------------------------------------------------------
// Integration: resolveFor with fieldPolicy applied
// ---------------------------------------------------------------------------

describe("resolveFor — T-0081 fieldPolicy integration", () => {
  it("NF-1: no fieldPolicy → byte-identical to pre-T-0081 (all visible fields in output)", async () => {
    const raw = { name: "Alice", salary: 100_000, department: "Eng" };
    const grant = makeGrant(); // whole-resource, no resourceFacet
    const deps: ResolverDeps = {
      grants: makeGrantSource([grant]),
      records: makeRecordSource(raw),
      ancestry: makeOracle(),
      now: () => NOW,
      // No fieldPolicy → NF-1 backward-compatible
    };
    const result = await resolveFor(deps, makeRecordHandle(), makeSubject(), "read");
    expect(result.denied).toBe(false);
    if (result.denied) return;
    expect(result.fields["name"]).toBe("Alice");
    expect(result.fields["salary"]).toBe(100_000);
    expect(result.fields["department"]).toBe("Eng");
  });

  it("F-2 integration: role-scoped field WITHOUT grant → physically absent in ResolvedView.fields", async () => {
    const raw = { name: "Alice", salary: 100_000 };
    // Grant with facet that includes 'name' but NOT 'salary'.
    const grant = makeGrant({ resourceFacet: { fields: ["name"] } });
    const policy: FieldVisibilityPolicy = { roleScopedFields: new Set(["salary"]) };
    const deps: ResolverDeps = {
      grants: makeGrantSource([grant]),
      records: makeRecordSource(raw),
      ancestry: makeOracle(),
      now: () => NOW,
      fieldPolicy: policy,
    };
    const result = await resolveFor(deps, makeRecordHandle(), makeSubject(), "read");
    expect(result.denied).toBe(false);
    if (result.denied) return;
    // 'name' should be present.
    expect("name" in result.fields).toBe(true);
    // 'salary' must be PHYSICALLY ABSENT (not null, not present at all).
    expect("salary" in result.fields).toBe(false);
    // Confirm it's not present-but-null.
    expect(result.fields["salary"]).toBeUndefined();
  });

  it("F-4 integration: multi-role most-restrictive — one dissenting role hides role-scoped field", async () => {
    const raw = { name: "Bob", salary: 200_000 };
    const policy: FieldVisibilityPolicy = { roleScopedFields: new Set(["salary"]) };
    // Role A: facet includes salary.
    const grantA = makeGrant({
      id: "g-a", roleId: "role-a",
      resourceFacet: { fields: ["name", "salary"] },
    });
    // Role B: facet does NOT include salary (restrictive).
    const grantB = makeGrant({
      id: "g-b", roleId: "role-b",
      resourceFacet: { fields: ["name"] },
    });
    const deps: ResolverDeps = {
      grants: makeGrantSource([grantA, grantB]),
      records: makeRecordSource(raw),
      ancestry: makeOracle(),
      now: () => NOW,
      fieldPolicy: policy,
    };
    const result = await resolveFor(deps, makeRecordHandle(), makeSubject(), "read");
    expect(result.denied).toBe(false);
    if (result.denied) return;
    // name is not role-scoped → visible via union-floor.
    expect("name" in result.fields).toBe(true);
    // salary is role-scoped and grantB doesn't confer it → HIDDEN.
    expect("salary" in result.fields).toBe(false);
  });

  it("F-5 integration: whole-resource grant + restrictive facet → role-scoped field hidden", async () => {
    const raw = { name: "Carol", fin: "secret-data" };
    const policy: FieldVisibilityPolicy = { roleScopedFields: new Set(["fin"]) };
    // Role A: whole-resource (would include 'fin' via union-floor).
    const grantWhole = makeGrant({
      id: "g-whole", roleId: "role-whole",
      resourceFacet: undefined,
    });
    // Role B: facet does NOT include 'fin'.
    const grantFacet = makeGrant({
      id: "g-facet", roleId: "role-facet",
      resourceFacet: { fields: ["name"] },
    });
    const deps: ResolverDeps = {
      grants: makeGrantSource([grantWhole, grantFacet]),
      records: makeRecordSource(raw),
      ancestry: makeOracle(),
      now: () => NOW,
      fieldPolicy: policy,
    };
    const result = await resolveFor(deps, makeRecordHandle(), makeSubject(), "read");
    expect(result.denied).toBe(false);
    if (result.denied) return;
    // name is not role-scoped → visible (union-floor: whole-resource grant confers it).
    expect("name" in result.fields).toBe(true);
    // fin is role-scoped; even though whole-resource grant is in covering, grantFacet
    // doesn't confer fin → most-restrictive-wins → HIDDEN.
    expect("fin" in result.fields).toBe(false);
  });

  it("F-6 integration: field hidden by role-policy cannot be recovered by classification", async () => {
    // This test verifies the ORDER: hide-layer runs before maskFields.
    // A field removed from effectiveVisible is not iterated by maskFields at all,
    // so classification cannot 'reveal' it back.
    // We verify this by checking physical absence in the output even when a
    // ClassificationSource is wired (which would 'reveal' a public field).
    const raw = { name: "Dave", sensitive: "private" };
    const policy: FieldVisibilityPolicy = { roleScopedFields: new Set(["sensitive"]) };
    // Grant with facet for 'name' only + a clearance marker so 'name' is revealed
    // (clearance: "restricted" ≥ class "public" → selectTransform → "reveal").
    const grant = makeGrant({
      resourceFacet: { fields: ["name"] },
      constraint: { clearance: "restricted" },
    });

    // Wire a classification source that would 'reveal' everything if it could reach it.
    // Even classifying 'sensitive' as 'public' cannot bring it back if hide-layer removed it.
    const classSource = {
      getClassifications: (_rt: string, _v: number) => ({
        governed: true,
        rows: [
          { resourceType: "record", facetField: "name", facetSchemaVersion: 0, class: "public" as const },
          // Even a 'public' classification on 'sensitive' cannot bring it back
          // because the hide-layer already removed it from effectiveVisible.
          { resourceType: "record", facetField: "sensitive", facetSchemaVersion: 0, class: "public" as const },
        ],
      }),
    };

    const deps: ResolverDeps = {
      grants: makeGrantSource([grant]),
      records: makeRecordSource(raw),
      ancestry: makeOracle(),
      now: () => NOW,
      fieldPolicy: policy,
      classifications: classSource,
    };
    const result = await resolveFor(deps, makeRecordHandle(), makeSubject(), "read");
    expect(result.denied).toBe(false);
    if (result.denied) return;
    // name is visible and classified public → present with raw value.
    expect("name" in result.fields).toBe(true);
    // sensitive was hidden by role-policy BEFORE maskFields → physically absent.
    // Classification's 'reveal' cannot recover a field that is not in effectiveVisible.
    expect("sensitive" in result.fields).toBe(false);
  });

  it("whole-resource grant alone with fieldPolicy: role-scoped field → visible (whole-resource confers all)", async () => {
    const raw = { name: "Eve", bonus: 5000 };
    const policy: FieldVisibilityPolicy = { roleScopedFields: new Set(["bonus"]) };
    // Single whole-resource grant → confers everything including role-scoped field.
    const grant = makeGrant({ resourceFacet: undefined });
    const deps: ResolverDeps = {
      grants: makeGrantSource([grant]),
      records: makeRecordSource(raw),
      ancestry: makeOracle(),
      now: () => NOW,
      fieldPolicy: policy,
    };
    const result = await resolveFor(deps, makeRecordHandle(), makeSubject(), "read");
    expect(result.denied).toBe(false);
    if (result.denied) return;
    // Whole-resource grant confers bonus → visible.
    expect("bonus" in result.fields).toBe(true);
    expect(result.fields["bonus"]).toBe(5000);
  });
});
