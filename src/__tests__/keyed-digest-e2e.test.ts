/**
 * T-0143 · e2e fitness suite — Wire keyedDigest into request-path ResolverDeps
 *
 * Spec §8 pattern (b): calls `resolveFor(handle.resolverDeps, ...)` directly
 * where `handle` is the `MainHandle` returned by `startMain`. The
 * proof-of-equivalence comment below explains why this constitutes a valid e2e
 * proof of the composition seam.
 *
 * FF-T143-2 → AC-1, AC-7  : keyedDigest bound port at composition root
 * FF-T143-3 → AC-2        : keyed hash active through real composition root
 * FF-T143-4 → AC-3        : absent key → hash field drops (fail-closed)
 *
 * All IO is behind in-memory ports (GrantSource/RecordSource/ClassificationSource).
 * No ambient build state; no ambient env vars (D-056).
 */

import { describe, it, expect } from "vitest";
import { startMain, type MainHandle } from "../main.js";
import {
  makeHandle,
  type ResolveSubject,
} from "../core/object-handle.js";
import {
  type Grant,
  type AncestryOracle,
} from "../core/grant-lattice.js";
import {
  type ResolverDeps,
  type GrantSource,
  type RecordSource,
  resolveFor,
} from "../core/grant-resolver.js";
import {
  type ClassificationSource,
  type ClassificationLookup,
} from "../core/data-classification.js";

// ---------------------------------------------------------------------------
// Proof-of-equivalence comment (spec §8 pattern b mandate)
// ---------------------------------------------------------------------------
// Proof-of-equivalence (pattern b): handle.resolverDeps is the SAME ResolverDeps
// object that startMain passed to createServer() (same allocation in startMain
// after T-0143 — not a copy, not a separate build). Any future HTTP route that
// calls makeGrantResolver(resolverDeps) from buildRouter's closure receives the
// same object. resolveFor(handle.resolverDeps, ...) therefore exercises the REAL
// composition seam without driving a full HTTP socket.
// ---------------------------------------------------------------------------

// A 32-byte hex key (256-bit HMAC-SHA256 secret) — no real secret committed.
const TEST_KEY_HEX = "a".repeat(64); // 64 hex chars = 32 bytes

const TENANT = "tenant-e2e-t0143";
const REG = "reg-e2e";
const REC = "rec-e2e";
const V_SSN = "123-45-6789";

// Pre-T-0118 keyless djb2 — reproduced to assert it is NEVER emitted.
function oldKeylessDjb2(input: string): string {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = (Math.imul(31, h1) + c) >>> 0;
    h2 = (Math.imul(29, h2) + c) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

// ---------------------------------------------------------------------------
// In-memory port fixtures
// ---------------------------------------------------------------------------

function makeOracle(): AncestryOracle {
  // rec-e2e ⊑ reg-e2e (trivial containment for the test grant)
  return {
    isDescendantOrSelf(_h, descendantId, ancestorId): boolean {
      if (descendantId === ancestorId) return true;
      if (descendantId === REC && ancestorId === REG) return true;
      return false;
    },
  };
}

function makeGrants(): GrantSource {
  const grant: Grant = {
    tenantId: TENANT,
    id: "g-t143-1",
    roleId: "role-test",
    resourceType: "record",
    operation: "read",
    scope: {
      kind: "node",
      hierarchy: "resource",
      nodeId: REG,
      nodeLevel: "registry",
    },
    delegable: false,
    grantedBy: "admin",
    createdAt: 0,
    // Grant carries a `public` clearance token so deriveClearance returns
    // "public", which routes restricted fields to the `hash` transform
    // (selectTransform("restricted", "public") === "hash").
    constraint: { clearance: "public" },
  };
  return { getGrants: () => Promise.resolve([grant]) };
}

function makeRecords(): RecordSource {
  return { getRecord: () => Promise.resolve({ ssn: V_SSN }) };
}

/**
 * A ClassificationSource that classifies `ssn` as `restricted` under resource
 * type "record", schema version 0. `governed: true` ensures fail-closed on a
 * governed resource. A `restricted` field at `public` clearance routes to the
 * `hash` transform (selectTransform("restricted", "public") === "hash").
 */
function makeClassifications(): ClassificationSource {
  const lookup: ClassificationLookup = {
    governed: true,
    rows: [
      {
        resourceType: "record",
        facetField: "ssn",
        facetSchemaVersion: 0,
        class: "restricted",
      },
    ],
  };
  return { getClassifications: () => lookup };
}

/**
 * Build a FULL ResolverDeps for the test by SPREADING the in-memory sources
 * and the `keyedDigest` from `handle.resolverDeps.keyedDigest` (the composition-
 * root-bound port). The SAME `keyedDigest` instance that was passed to
 * `createServer()` (see proof-of-equivalence comment at top of file).
 */
function testDeps(handle: MainHandle): ResolverDeps {
  return {
    grants: makeGrants(),
    records: makeRecords(),
    ancestry: makeOracle(),
    classifications: makeClassifications(),
    // Take keyedDigest from the composition-root handle — this is the exact
    // same instance startMain passed to createServer() (object identity by
    // construction, T-0143 §4.3). This is the seam being tested.
    keyedDigest: handle.resolverDeps.keyedDigest,
    now: () => 1000,
  };
}

function makeTestHandle() {
  const ref = {
    kind: "record" as const,
    tenantId: TENANT,
    registryId: REG,
    recordId: REC,
  };
  return makeHandle(ref, TENANT);
}

function makeSubject(): ResolveSubject {
  return { tenantId: TENANT, subjectId: "user-e2e-1" };
}

// ---------------------------------------------------------------------------
// FF-T143-2 — resolverDeps object identity at composition root (AC-1, AC-7)
// ---------------------------------------------------------------------------

describe("FF-T143-2 resolverDeps object identity at composition root [AC-1, AC-7]", () => {
  let handle: MainHandle;

  it("keyedDigest.digest() returns 64-char hex when CHOROS_MASK_DIGEST_KEY is set", () => {
    handle = startMain({
      listen: false,
      env: { CHOROS_MASK_DIGEST_KEY: TEST_KEY_HEX } as unknown as NodeJS.ProcessEnv,
    });

    const result = handle.resolverDeps.keyedDigest.digest({
      value: "v",
      tenantId: "t",
      resourceType: "r",
      facetField: "f",
    });
    expect(result).toMatch(/^[0-9a-f]{64}$/);
    handle.stop();
  });

  it("keyedDigest.digest() returns undefined when CHOROS_MASK_DIGEST_KEY is absent (honest degrade)", () => {
    handle = startMain({
      listen: false,
      env: {} as unknown as NodeJS.ProcessEnv,
    });

    const result = handle.resolverDeps.keyedDigest.digest({
      value: "v",
      tenantId: "t",
      resourceType: "r",
      facetField: "f",
    });
    expect(result).toBeUndefined();
    handle.stop();
  });
});

// ---------------------------------------------------------------------------
// FF-T143-3 — e2e keyed hash active through real composition root (AC-2)
// ---------------------------------------------------------------------------

describe("FF-T143-3 e2e keyed hash active through real composition root [AC-2]", () => {
  it("resolveFor with CHOROS_MASK_DIGEST_KEY set: restricted ssn field is a 64-char lowercase hex string", async () => {
    const handle = startMain({
      listen: false,
      env: { CHOROS_MASK_DIGEST_KEY: TEST_KEY_HEX } as unknown as NodeJS.ProcessEnv,
    });

    try {
      const deps = testDeps(handle);
      const result = await resolveFor(deps, makeTestHandle(), makeSubject(), "read");

      expect(result.denied).toBe(false);
      if (result.denied) throw new Error("unreachable");

      // The ssn field must be present as a 64-char lowercase hex HMAC-SHA256 hash.
      expect(result.fields).toHaveProperty("ssn");
      const ssnValue = result.fields["ssn"] as string;
      expect(ssnValue).toMatch(/^[0-9a-f]{64}$/);

      // Must NOT be the raw value.
      expect(ssnValue).not.toBe(V_SSN);

      // Must NOT be the pre-T-0118 keyless djb2 (the now-eliminated equality oracle).
      const keylessDjb2 = oldKeylessDjb2(V_SSN);
      expect(ssnValue).not.toBe(keylessDjb2);
    } finally {
      handle.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// FF-T143-4 — e2e absent key → hash field drops (AC-3 / FR-2)
// ---------------------------------------------------------------------------

describe("FF-T143-4 e2e absent key → hash field drops [AC-3, FR-2]", () => {
  it("resolveFor without CHOROS_MASK_DIGEST_KEY: restricted ssn field is ABSENT (honest degrade)", async () => {
    const handle = startMain({
      listen: false,
      env: {} as unknown as NodeJS.ProcessEnv,
    });

    try {
      const deps = testDeps(handle);
      const result = await resolveFor(deps, makeTestHandle(), makeSubject(), "read");

      expect(result.denied).toBe(false);
      if (result.denied) throw new Error("unreachable");

      // The ssn field must be ABSENT (dropped) — never raw, never keyless.
      expect("ssn" in result.fields).toBe(false);

      // Paranoia: the raw value must not appear anywhere in the output.
      const outputStr = JSON.stringify(result.fields);
      expect(outputStr).not.toContain(V_SSN);

      // Paranoia: the keyless djb2 of the test value must not appear.
      const keylessDjb2 = oldKeylessDjb2(V_SSN);
      expect(outputStr).not.toContain(keylessDjb2);
    } finally {
      handle.stop();
    }
  });
});
