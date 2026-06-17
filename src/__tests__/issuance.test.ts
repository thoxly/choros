/**
 * T-0242 — vendor entitlement issuance unit tests
 *
 * Covers AC-1..AC-9, AC-14 (plan presets).
 * Uses in-memory LicenseStore (no filesystem, no DB, no network).
 * Generates a throwaway Ed25519 keypair in-test — no committed private key.
 * Uses the REAL verifyKey from activation.ts for round-trip tests (AC-3..AC-5).
 */

import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  issueEntitlement,
  signKey,
  refreshKey,
  revokeEntitlement,
  PILOT_PLAN,
  PRO_PLAN,
  type IssueParams,
} from "../vendor/issuance.js";
import { InMemoryLicenseStore } from "../vendor/file-license-store.js";
import { verifyKey } from "../vendor/activation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKeypair(): { privatePem: Buffer; publicPem: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = Buffer.from(
    privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    "utf8",
  );
  const publicPem = Buffer.from(
    publicKey.export({ type: "spki", format: "pem" }) as string,
    "utf8",
  );
  return { privatePem, publicPem };
}

const NOW = new Date("2026-01-01T00:00:00Z");
const VALID_FROM = "2026-01-01T00:00:00.000Z";
const VALID_UNTIL = "2027-01-01T00:00:00.000Z";
const MID = new Date("2026-06-01T00:00:00Z"); // in-term

function baseParams(overrides: Partial<IssueParams> = {}): IssueParams {
  return {
    circuit_id: "test-circuit-abc123",
    plan: PILOT_PLAN,
    valid_from: VALID_FROM,
    valid_until: VALID_UNTIL,
    source: "pilot",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("issueEntitlement", () => {
  it("AC-1: creates LicenseRecord with status=active and correct fields", () => {
    const store = new InMemoryLicenseStore();
    const rec = issueEntitlement(baseParams(), store, NOW);

    expect(rec.status).toBe("active");
    expect(rec.circuit_id).toBe("test-circuit-abc123");
    expect(rec.plan).toEqual(PILOT_PLAN);
    expect(rec.valid_from).toBe(VALID_FROM);
    expect(rec.valid_until).toBe(VALID_UNTIL);
    expect(rec.source).toBe("pilot");
    expect(rec.issued_at).toBe(NOW.toISOString());
    expect(rec.revoked_at).toBeNull();
    expect(rec.revoked_by).toBeNull();
    expect(typeof rec.id).toBe("string");
    expect(rec.id.length).toBeGreaterThan(0);
  });

  it("AC-2: repeat call with same circuit_id updates record, issued_at immutable", () => {
    const store = new InMemoryLicenseStore();
    const first = issueEntitlement(baseParams(), store, NOW);

    const laterNow = new Date("2026-02-01T00:00:00Z");
    const second = issueEntitlement(
      baseParams({
        plan: PRO_PLAN,
        valid_from: "2026-02-01T00:00:00.000Z",
        valid_until: "2027-02-01T00:00:00.000Z",
      }),
      store,
      laterNow,
    );

    // Same id, issued_at preserved.
    expect(second.id).toBe(first.id);
    expect(second.issued_at).toBe(first.issued_at); // immutable
    // Updated fields.
    expect(second.plan).toEqual(PRO_PLAN);
    expect(second.valid_from).toBe("2026-02-01T00:00:00.000Z");
    expect(second.status).toBe("active");
    // Only one record.
    expect(store.getByCircuit("test-circuit-abc123")).not.toBeNull();
  });

  it("AC-14: pilot plan creates EntitlementSet {updates:true, agentic_ops:false, support:true, tier:pilot}", () => {
    const store = new InMemoryLicenseStore();
    const rec = issueEntitlement(baseParams({ plan: PILOT_PLAN }), store, NOW);
    expect(rec.plan.entitlements).toEqual({
      updates: true,
      agentic_ops: false,
      support: true,
      tier: "pilot",
    });
  });
});

describe("signKey", () => {
  const { privatePem, publicPem } = makeKeypair();

  it("AC-3: returns choros1.<b64>.<b64> wire, verifyKey accepts it as active", () => {
    const store = new InMemoryLicenseStore();
    const rec = issueEntitlement(baseParams(), store, NOW);
    const wire = signKey(rec, privatePem, MID);

    expect(wire).toMatch(/^choros1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const result = verifyKey(wire, publicPem, MID);
    expect(result.state).toBe("active");
  });

  it("AC-4: circuit_id in payload matches record.circuit_id after round-trip", () => {
    const store = new InMemoryLicenseStore();
    const rec = issueEntitlement(baseParams({ circuit_id: "cid-99" }), store, NOW);
    const wire = signKey(rec, privatePem, MID);

    const result = verifyKey(wire, publicPem, MID);
    expect(result.circuit_id).toBe("cid-99");
  });

  it("AC-5: entitlements in payload match record.plan after round-trip", () => {
    const store = new InMemoryLicenseStore();
    const rec = issueEntitlement(baseParams({ plan: PRO_PLAN }), store, NOW);
    const wire = signKey(rec, privatePem, MID);

    const result = verifyKey(wire, publicPem, MID);
    expect(result.entitlements).toEqual(PRO_PLAN.entitlements);
  });

  it("AC-7: throws when record status is revoked", () => {
    const store = new InMemoryLicenseStore();
    const rec = issueEntitlement(baseParams(), store, NOW);
    const revoked = revokeEntitlement(rec.circuit_id, "admin", store, MID);

    expect(() => signKey(revoked, privatePem, MID)).toThrow(/revoked/i);
  });
});

describe("refreshKey", () => {
  const { privatePem, publicPem } = makeKeypair();

  it("AC-6: updates last_signed, returns valid wire, plan/valid_from/valid_until unchanged", () => {
    const store = new InMemoryLicenseStore();
    const rec = issueEntitlement(baseParams(), store, NOW);
    expect(rec.last_signed).toBeNull();

    const refreshNow = new Date("2026-03-01T00:00:00Z");
    const wire = refreshKey(rec.circuit_id, privatePem, store, refreshNow);

    expect(wire).toMatch(/^choros1\./);

    const after = store.getByCircuit(rec.circuit_id)!;
    expect(after.last_signed).toBe(refreshNow.toISOString());
    expect(after.plan).toEqual(PILOT_PLAN);
    expect(after.valid_from).toBe(VALID_FROM);
    expect(after.valid_until).toBe(VALID_UNTIL);

    const verif = verifyKey(wire, publicPem, MID);
    expect(verif.state).toBe("active");
  });

  it("AC-7: throws when record is revoked", () => {
    const store = new InMemoryLicenseStore();
    const rec = issueEntitlement(baseParams(), store, NOW);
    revokeEntitlement(rec.circuit_id, "admin", store, MID);

    expect(() => refreshKey(rec.circuit_id, privatePem, store, MID)).toThrow(/revoked/i);
  });
});

describe("revokeEntitlement", () => {
  const { privatePem, publicPem } = makeKeypair();

  it("AC-9: sets status=revoked, revoked_at non-null, revoked_by = passed arg", () => {
    const store = new InMemoryLicenseStore();
    const rec = issueEntitlement(baseParams(), store, NOW);
    const revoked = revokeEntitlement(rec.circuit_id, "ops-user", store, MID);

    expect(revoked.status).toBe("revoked");
    expect(revoked.revoked_at).toBe(MID.toISOString());
    expect(revoked.revoked_by).toBe("ops-user");
  });

  it("AC-8: revoke ≠ halt — previously signed wire remains verifiable in-term", () => {
    const store = new InMemoryLicenseStore();
    const rec = issueEntitlement(baseParams(), store, NOW);
    // Sign BEFORE revoke.
    const wire = signKey(rec, privatePem, NOW);

    // Revoke.
    revokeEntitlement(rec.circuit_id, "admin", store, MID);

    // Wire signed before revoke still verifies active when checked in-term.
    const result = verifyKey(wire, publicPem, MID);
    expect(result.state).toBe("active");
  });

  it("AC-7: signKey throws after revoke (refreshKey path)", () => {
    const store = new InMemoryLicenseStore();
    issueEntitlement(baseParams(), store, NOW);
    const revoked = revokeEntitlement("test-circuit-abc123", "admin", store, MID);
    expect(() => signKey(revoked, privatePem, MID)).toThrow();
    expect(() => refreshKey("test-circuit-abc123", privatePem, store, MID)).toThrow();
  });
});
