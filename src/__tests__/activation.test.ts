/**
 * T-0127 / T-0198 — activation verifier unit tests (FF-T127-9).
 *
 * Generates a throwaway Ed25519 keypair in-test (no committed private key),
 * signs canonical payloads, and asserts verifyKey's verdicts:
 *   - valid in-term key          => 'active' with circuit_id + entitlements
 *   - validly-signed expired key  => 'autonomous' (NEVER a halt)
 *   - tampered payload            => 'invalid'
 *   - missing key                 => 'autonomous'
 * Plus the entitlement helper and envelope edge cases.
 *
 * No DB, no network, no process.env — mirrors the verifier's purity.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import {
  verifyKey,
  isEntitled,
  parseEnvelope,
  canonicalPayloadBytes,
  type ActivationKey,
  type EntitlementSet,
} from "../vendor/activation.js";

// ---------------------------------------------------------------------------
// Test signing helpers (dev-only; the real signer is control-plane / vendor).
// ---------------------------------------------------------------------------

function makeKeypair(): { privateKey: KeyObject; publicPem: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicPem = Buffer.from(publicKey.export({ type: "spki", format: "pem" }) as string, "utf8");
  return { privateKey, publicPem };
}

function signEnvelope(key: ActivationKey, privateKey: KeyObject): string {
  const payloadBytes = canonicalPayloadBytes(key);
  const sig = cryptoSign(null, payloadBytes, privateKey);
  return (
    "choros1." +
    payloadBytes.toString("base64url") +
    "." +
    sig.toString("base64url")
  );
}

const ENTITLEMENTS: EntitlementSet = {
  updates: true,
  agentic_ops: true,
  support: false,
  tier: "pro",
};

function makeKey(overrides: Partial<ActivationKey> = {}): ActivationKey {
  return {
    key_version: "choros-key.v1",
    circuit_id: "11111111-1111-1111-1111-111111111111",
    vendor: "choros",
    entitlements: ENTITLEMENTS,
    issued_at: "2026-01-01T00:00:00Z",
    not_before: "2026-01-01T00:00:00Z",
    not_after: "2027-01-01T00:00:00Z",
    ...overrides,
  };
}

const NOW_IN_TERM = new Date("2026-06-13T00:00:00Z");

// ---------------------------------------------------------------------------
// verifyKey — active
// ---------------------------------------------------------------------------

describe("verifyKey — active (FF-T127-9)", () => {
  it("returns 'active' with circuit_id + entitlements for a valid in-term key", () => {
    const { privateKey, publicPem } = makeKeypair();
    const env = signEnvelope(makeKey(), privateKey);

    const status = verifyKey(env, publicPem, NOW_IN_TERM);

    expect(status.state).toBe("active");
    expect(status.circuit_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(status.entitlements).toEqual(ENTITLEMENTS);
    expect(status.not_after).toBe("2027-01-01T00:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// verifyKey — autonomous (expired / not-yet / missing)
// ---------------------------------------------------------------------------

describe("verifyKey — autonomous (expired key never halts core)", () => {
  it("returns 'autonomous' for a validly-signed but expired key", () => {
    const { privateKey, publicPem } = makeKeypair();
    const env = signEnvelope(
      makeKey({ not_after: "2026-02-01T00:00:00Z" }),
      privateKey,
    );

    // now (2026-06-13) is AFTER not_after.
    const status = verifyKey(env, publicPem, NOW_IN_TERM);

    expect(status.state).toBe("autonomous");
    expect(status.circuit_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(status.entitlements).toBeNull();
    expect(status.reason).toContain("expired");
  });

  it("returns 'autonomous' for a not-yet-valid key", () => {
    const { privateKey, publicPem } = makeKeypair();
    const env = signEnvelope(
      makeKey({ not_before: "2030-01-01T00:00:00Z", not_after: "2031-01-01T00:00:00Z" }),
      privateKey,
    );

    const status = verifyKey(env, publicPem, NOW_IN_TERM);

    expect(status.state).toBe("autonomous");
    expect(status.entitlements).toBeNull();
  });

  it("returns 'autonomous' for a missing key (empty string)", () => {
    const { publicPem } = makeKeypair();
    const status = verifyKey("", publicPem, NOW_IN_TERM);

    expect(status.state).toBe("autonomous");
    expect(status.circuit_id).toBeNull();
    expect(status.reason).toContain("no key present");
  });
});

// ---------------------------------------------------------------------------
// verifyKey — invalid (tampered / wrong key / malformed)
// ---------------------------------------------------------------------------

describe("verifyKey — invalid (forgery detected locally, core stays up)", () => {
  it("returns 'invalid' for a tampered payload (signature mismatch)", () => {
    const { privateKey, publicPem } = makeKeypair();
    const env = signEnvelope(makeKey(), privateKey);

    // Tamper: swap the payload segment for a different (re-encoded) payload while
    // keeping the original signature.
    const parts = env.split(".");
    const forgedPayload = makeKey({ circuit_id: "deadbeef-0000-0000-0000-000000000000" });
    parts[1] = canonicalPayloadBytes(forgedPayload).toString("base64url");
    const tampered = parts.join(".");

    const status = verifyKey(tampered, publicPem, NOW_IN_TERM);

    expect(status.state).toBe("invalid");
    expect(status.entitlements).toBeNull();
    expect(status.reason).toContain("signature mismatch");
  });

  it("returns 'invalid' when verified against a DIFFERENT vendor public key", () => {
    const { privateKey } = makeKeypair();
    const { publicPem: otherPub } = makeKeypair();
    const env = signEnvelope(makeKey(), privateKey);

    const status = verifyKey(env, otherPub, NOW_IN_TERM);

    expect(status.state).toBe("invalid");
  });

  it("returns 'invalid' for a malformed envelope", () => {
    const { publicPem } = makeKeypair();
    expect(verifyKey("not-an-envelope", publicPem, NOW_IN_TERM).state).toBe("invalid");
    expect(verifyKey("choros1.onlyonepart", publicPem, NOW_IN_TERM).state).toBe("invalid");
    expect(verifyKey("wrongprefix.aaa.bbb", publicPem, NOW_IN_TERM).state).toBe("invalid");
  });

  it("returns 'invalid' for an unsupported key_version", () => {
    const { privateKey, publicPem } = makeKeypair();
    const env = signEnvelope(makeKey({ key_version: "choros-key.v2" }), privateKey);

    const status = verifyKey(env, publicPem, NOW_IN_TERM);
    expect(status.state).toBe("invalid");
    expect(status.reason).toContain("key_version");
  });
});

// ---------------------------------------------------------------------------
// isEntitled — vendor-layer helper
// ---------------------------------------------------------------------------

describe("isEntitled", () => {
  it("true only when active AND the flag is set", () => {
    const { privateKey, publicPem } = makeKeypair();
    const status = verifyKey(signEnvelope(makeKey(), privateKey), publicPem, NOW_IN_TERM);

    expect(isEntitled(status, "updates")).toBe(true);
    expect(isEntitled(status, "agentic_ops")).toBe(true);
    expect(isEntitled(status, "support")).toBe(false); // flag unset in plan
  });

  it("false for autonomous/invalid regardless of flag", () => {
    const { publicPem } = makeKeypair();
    const autonomous = verifyKey("", publicPem, NOW_IN_TERM);
    expect(isEntitled(autonomous, "updates")).toBe(false);
    expect(isEntitled(autonomous, "support")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseEnvelope — wire-format edge cases
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Committed dev keypair — the shipped public key verifies a real signed fixture.
// Proves config/activation/vendor-pub.ed25519 is a genuine trust anchor, not a stub.
// ---------------------------------------------------------------------------

describe("committed vendor-pub.ed25519 verifies the dev fixture key", () => {
  it("'active' for the fixture signed by the dev private key", () => {
    const repoRoot = join(__dirname, "..", "..");
    const pubPem = readFileSync(join(repoRoot, "config/activation/vendor-pub.ed25519"));
    const wire = readFileSync(
      join(repoRoot, "src/__tests__/fixtures/activation/dev-active.key"),
      "utf8",
    ).trim();

    const status = verifyKey(wire, pubPem, new Date("2026-06-13T00:00:00Z"));

    expect(status.state).toBe("active");
    expect(status.circuit_id).toBe("c0000000-0000-0000-0000-0000000000aa");
    expect(status.entitlements?.support).toBe(true);
  });
});

describe("parseEnvelope", () => {
  it("parses a well-formed envelope into three parts", () => {
    const env = parseEnvelope("choros1.AAAA.BBBB");
    expect(env).not.toBeNull();
    expect(env?.payload_b64).toBe("AAAA");
    expect(env?.sig_b64).toBe("BBBB");
  });

  it("rejects wrong prefix / wrong part count / empty segments", () => {
    expect(parseEnvelope("nope.AAAA.BBBB")).toBeNull();
    expect(parseEnvelope("choros1.AAAA")).toBeNull();
    expect(parseEnvelope("choros1..BBBB")).toBeNull();
    expect(parseEnvelope("choros1.AAAA.")).toBeNull();
  });
});
