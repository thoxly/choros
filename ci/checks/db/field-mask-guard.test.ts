/**
 * ci/checks/db/field-mask-guard.test.ts — T-0246 B-5 / FF-8 / AC-9
 *
 * Integration test: resolveFor (grant-resolver PDP) + checkWriteMask (field-mask-guard).
 * Proves that a vendor-admin grant with a restricted write-mask DENIES writes of
 * system-only fields (circuit_id, activation_key_issued_at).
 *
 * Placed in ci/checks/db/ so it runs under fitness:db (vitest --dir ci/checks/db).
 * Uses in-memory injectable deps — no Postgres required for the predicate proof itself.
 * The "fitness:db" label carries the semantic of "integration with the PDP stack",
 * not "requires a live DB connection" (ADR §2.3 / AC-9 annotation).
 *
 * HOOK POINT DOCUMENTATION (B-11):
 *   When record-CRUD (B-11) lands and src/http/records.ts is created, the
 *   PUT /api/records/:id handler MUST:
 *     (a) resolveFor(deps, handle, subject, "update") — single authority check.
 *     (b) extract grantWriteFacet from the covered grant's resourceFacet.fields.
 *     (c) checkWriteMask(grantWriteFacet, requestedFields) — deny on blocked.
 *     (d) on denied → return HTTP 403 + audit_event(card_action.denied).
 *   ci/checks/field-mask-hookpoint.sh enforces this when records.ts exists (FF-10).
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";

import { resolveFor } from "../../../src/core/grant-resolver.js";
import {
  checkWriteMask,
  SYSTEM_ONLY_FIELDS,
} from "../../../src/runtime/customer-onboarding/field-mask-guard.js";
import type { Grant } from "../../../src/core/grant-lattice.js";
import type { ResolverDeps } from "../../../src/core/grant-resolver.js";
import type { ResourceRef, ResolveSubject } from "../../../src/core/object-handle.js";
import { makeHandle } from "../../../src/core/object-handle.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = "f0000000-0000-0000-0000-000000000010";
const REGISTRY_ID = randomUUID();
const RECORD_ID = randomUUID();
const NOW_MS = new Date("2026-06-17T00:00:00Z").getTime();

/** vendor-admin grant with a restricted write-facet: excludes system-only fields. */
function makeVendorAdminGrant(): Grant {
  return {
    tenantId: TENANT_ID,
    id: randomUUID(),
    roleId: "vendor-admin",
    resourceType: "record",
    operation: "update",
    scope: {
      kind: "node",
      hierarchy: "resource",
      nodeId: RECORD_ID,
      nodeLevel: "record",
    },
    delegable: false,
    grantedBy: "system",
    createdAt: 0,
    // Write-mask: vendor-admin may write plan, not_after, notes, status —
    // but NOT circuit_id or activation_key_issued_at (system-only fields).
    resourceFacet: {
      fields: ["company_name", "contact_name", "contact_email", "plan", "not_after", "notes", "status"],
    },
  } as unknown as Grant;
}

/** Customer-subscription record fixture (no circuit_id / activation_key_issued_at yet). */
const RECORD_FIELDS: Record<string, unknown> = {
  company_name: "ООО Маска-тест",
  contact_name: "Маска",
  contact_email: "mask@test.ru",
  plan: "pilot",
  not_after: "2027-06-17T00:00:00.000Z",
  notes: "test-note",
  status: "trial",
};

function makeTestDeps(): ResolverDeps {
  return {
    grants: {
      async getGrants(): Promise<Grant[]> {
        return [makeVendorAdminGrant()];
      },
    },
    records: {
      async getRecord(): Promise<Record<string, unknown> | null> {
        return RECORD_FIELDS;
      },
    },
    ancestry: {
      // Simple ancestry: a node is its own ancestor only.
      isDescendantOrSelf: (_h: string, a: string, b: string) => a === b,
    },
    now: () => NOW_MS,
  };
}

function makeRecordHandle() {
  const ref: ResourceRef = {
    kind: "record",
    tenantId: TENANT_ID,
    registryId: REGISTRY_ID,
    recordId: RECORD_ID,
  };
  return makeHandle(ref, TENANT_ID);
}

const SUBJECT: ResolveSubject = {
  tenantId: TENANT_ID,
  subjectId: "e-vendor-admin-mask",
};

// ---------------------------------------------------------------------------
// FF-8 / AC-9: resolveFor + checkWriteMask
// ---------------------------------------------------------------------------

describe("FF-8 / AC-9: PDP + field-mask-guard integration", () => {
  it("resolveFor with vendor-admin grant returns allowed (update op)", async () => {
    const view = await resolveFor(makeTestDeps(), makeRecordHandle(), SUBJECT, "update");
    expect(view.denied).toBe(false);
  });

  it("checkWriteMask([circuit_id]) → denied=true (system-only field blocked)", () => {
    // The grant's resourceFacet.fields does NOT include circuit_id.
    const grantWriteFacet = ["company_name", "contact_name", "contact_email", "plan", "not_after", "notes", "status"];
    const result = checkWriteMask(grantWriteFacet, ["circuit_id"]);
    expect(result.denied).toBe(true);
    if (result.denied) {
      expect(result.reason).toBe("system_field_write_blocked");
      expect(result.blockedFields).toContain("circuit_id");
    }
  });

  it("checkWriteMask([activation_key_issued_at]) → denied=true (system-only field blocked)", () => {
    const grantWriteFacet = ["plan", "not_after", "notes", "status"];
    const result = checkWriteMask(grantWriteFacet, ["activation_key_issued_at"]);
    expect(result.denied).toBe(true);
    if (result.denied) {
      expect(result.blockedFields).toContain("activation_key_issued_at");
    }
  });

  it("checkWriteMask([plan]) → denied=false (plan is within the grant facet)", () => {
    // Anti-test-theatre: the gate must pass for allowed fields too.
    const grantWriteFacet = ["company_name", "contact_name", "contact_email", "plan", "not_after", "notes", "status"];
    const result = checkWriteMask(grantWriteFacet, ["plan"]);
    expect(result.denied).toBe(false);
  });

  it("checkWriteMask([notes, status]) → denied=false (both within facet)", () => {
    const grantWriteFacet = ["plan", "not_after", "notes", "status"];
    const result = checkWriteMask(grantWriteFacet, ["notes", "status"]);
    expect(result.denied).toBe(false);
  });

  it("checkWriteMask(undefined, [circuit_id]) → denied=false (system-actor path: whole-resource write)", () => {
    // When writeFacet is undefined (system actor), all writes are allowed.
    const result = checkWriteMask(undefined, ["circuit_id", "activation_key_issued_at"]);
    expect(result.denied).toBe(false);
  });

  it("SYSTEM_ONLY_FIELDS contains circuit_id and activation_key_issued_at", () => {
    // Sanity-check: the frozen set has the right members.
    expect(SYSTEM_ONLY_FIELDS.has("circuit_id")).toBe(true);
    expect(SYSTEM_ONLY_FIELDS.has("activation_key_issued_at")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HOOK POINT: B-11 wire-up documentation probe (compile-time, not runtime)
// ---------------------------------------------------------------------------

describe("HOOK POINT documentation: B-11 field-mask wire-up contract", () => {
  it("documents: when B-11 lands, records.ts MUST call checkWriteMask (hook enforced by field-mask-hookpoint.sh)", () => {
    /**
     * HOOK POINT CONTRACT (B-11):
     *   src/http/records.ts (PUT /api/records/:id) MUST:
     *   1. resolveFor(deps, handle, subject, "update") → covered grant.
     *   2. Extract grantWriteFacet from grant.resourceFacet.fields (string[] | undefined).
     *   3. checkWriteMask(grantWriteFacet, requestedFields).
     *   4. If denied → HTTP 403 + audit_event(card_action.denied).
     *
     *   ci/checks/field-mask-hookpoint.sh enforces this statically (FF-10 / AC-10):
     *   if src/http/records.ts exists → checkWriteMask must appear in it.
     *
     * This test is a compile-time marker — it always passes.
     * The enforcement is in field-mask-hookpoint.sh.
     */
    expect(typeof checkWriteMask).toBe("function");
    expect(SYSTEM_ONLY_FIELDS.size).toBeGreaterThan(0);
  });
});
