/**
 * src/__tests__/vendor-activation-envelope-fuzz.adversarial.test.ts — T-0422 adversary (Враг)
 *
 * Extends T-0417's vendor coverage by FUZZING the Ed25519 activation envelope and
 * asserting the vendor edge is FAIL-CLOSED: any tampered / truncated / reordered /
 * empty-sig / wrong-key / malformed-base64 envelope resolves to state 'invalid'
 * and the gated /vendor/* service routes refuse with 403 ACTIVATION_INVALID.
 *
 * Two layers, both runnable NOW (pure crypto, no DB, no network, no live KC):
 *   1. verifyKey() unit fuzz — drives the offline verifier directly with a real
 *      throwaway Ed25519 keypair (mirrors activation.test.ts signing helpers).
 *      Vectors named in the T-0422 brief that activation.test.ts does NOT cover:
 *        - truncated signature (sig bytes chopped)
 *        - signature with appended/extra bytes
 *        - zero-length / all-zero signature
 *        - reordered payload JSON keys (must still verify via canonicalization —
 *          a non-regression: legitimate re-ordering is NOT a forgery)
 *        - EXTRA payload fields injected (privilege-escalation attempt)
 *        - malformed base64url in either segment
 *        - signature taken from a DIFFERENT (valid) payload swapped onto this one
 *   2. HTTP route fuzz — registers the real vendor-activation routes with an
 *      injected provider that runs verifyKey() over the fuzzed envelope, and
 *      asserts the gated service routes 403 (fail-closed) in BOTH auth modes.
 *
 * Anchor: an UNTAMPERED, correctly-signed, in-term key is the ONLY input that
 * yields 'active' / 200 — proving the fuzz isn't trivially passing by always
 * refusing.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as http from "node:http";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Router } from "../http/router.js";
import { registerVendorActivationRoutes } from "../http/vendor-activation.js";
import {
  verifyKey,
  canonicalPayloadBytes,
  type ActivationKey,
  type ActivationStatus,
  type EntitlementSet,
} from "../vendor/activation.js";

// ---------------------------------------------------------------------------
// Signing helpers (throwaway keypair, mirrors activation.test.ts)
// ---------------------------------------------------------------------------

function makeKeypair(): { privateKey: KeyObject; publicPem: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicPem = Buffer.from(publicKey.export({ type: "spki", format: "pem" }) as string, "utf8");
  return { privateKey, publicPem };
}

const ENTITLEMENTS: EntitlementSet = {
  updates: true,
  agentic_ops: true,
  support: true,
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

/** Sign the canonical payload bytes, returning the wire envelope. */
function signEnvelope(key: ActivationKey, privateKey: KeyObject): string {
  const payloadBytes = canonicalPayloadBytes(key);
  const sig = cryptoSign(null, payloadBytes, privateKey);
  return "choros1." + payloadBytes.toString("base64url") + "." + sig.toString("base64url");
}

/** Sign arbitrary raw payload bytes (lets us craft non-canonical / extra-field payloads). */
function signRawPayload(payloadBytes: Buffer, privateKey: KeyObject): string {
  const sig = cryptoSign(null, payloadBytes, privateKey);
  return "choros1." + payloadBytes.toString("base64url") + "." + sig.toString("base64url");
}

function splitEnvelope(env: string): [string, string, string] {
  const p = env.split(".");
  return [p[0]!, p[1]!, p[2]!];
}

// ---------------------------------------------------------------------------
// Layer 1 — verifyKey() Ed25519 envelope fuzz (the named T-0422 vectors).
// ---------------------------------------------------------------------------

describe("[T-0422] verifyKey Ed25519 envelope fuzz → fail-closed 'invalid'", () => {
  it("anchor: an untampered, correctly-signed in-term key → 'active' (fuzz not trivially refusing)", () => {
    const { privateKey, publicPem } = makeKeypair();
    const status = verifyKey(signEnvelope(makeKey(), privateKey), publicPem, NOW_IN_TERM);
    expect(status.state).toBe("active");
  });

  it("truncated signature (last bytes chopped) → 'invalid'", () => {
    const { privateKey, publicPem } = makeKeypair();
    const [prefix, payload, sig] = splitEnvelope(signEnvelope(makeKey(), privateKey));
    const sigBytes = Buffer.from(sig, "base64url");
    const truncated = sigBytes.subarray(0, sigBytes.length - 8).toString("base64url");
    const status = verifyKey(`${prefix}.${payload}.${truncated}`, publicPem, NOW_IN_TERM);
    expect(status.state).toBe("invalid");
  });

  it("signature with extra appended bytes → 'invalid'", () => {
    const { privateKey, publicPem } = makeKeypair();
    const [prefix, payload, sig] = splitEnvelope(signEnvelope(makeKey(), privateKey));
    const sigBytes = Buffer.from(sig, "base64url");
    const extended = Buffer.concat([sigBytes, Buffer.from([0x00, 0x01, 0x02, 0x03])]).toString("base64url");
    const status = verifyKey(`${prefix}.${payload}.${extended}`, publicPem, NOW_IN_TERM);
    expect(status.state).toBe("invalid");
  });

  it("all-zero signature (64 zero bytes) → 'invalid'", () => {
    const { privateKey, publicPem } = makeKeypair();
    const [prefix, payload] = splitEnvelope(signEnvelope(makeKey(), privateKey));
    const zeroSig = Buffer.alloc(64, 0).toString("base64url");
    const status = verifyKey(`${prefix}.${payload}.${zeroSig}`, publicPem, NOW_IN_TERM);
    expect(status.state).toBe("invalid");
  });

  it("empty signature segment → 'invalid' (parseEnvelope rejects empty seg → malformed)", () => {
    const { privateKey, publicPem } = makeKeypair();
    const [prefix, payload] = splitEnvelope(signEnvelope(makeKey(), privateKey));
    // sig segment empty → parseEnvelope returns null → 'malformed envelope'.
    const status = verifyKey(`${prefix}.${payload}.`, publicPem, NOW_IN_TERM);
    expect(status.state).toBe("invalid");
  });

  it("signature decodes to empty bytes (base64url of zero-length) → 'invalid'", () => {
    const { privateKey, publicPem } = makeKeypair();
    const [prefix, payload] = splitEnvelope(signEnvelope(makeKey(), privateKey));
    // "AA" base64url → a single 0x00 byte (1-byte sig, not 64) → verify fails.
    const status = verifyKey(`${prefix}.${payload}.AA`, publicPem, NOW_IN_TERM);
    expect(status.state).toBe("invalid");
  });

  it("EXTRA payload fields, signed (attacker controls extras) → ignored, confer NO authority", () => {
    // A self-signed key (attacker's own keypair) that adds rogue fields. Two facts
    // must hold for fail-closed: (a) verified against the REAL vendor key it is
    // 'invalid' (wrong signer); (b) even verified against the attacker's OWN key,
    // the extra fields are STRIPPED by parsePayload — the canonical signed bytes
    // are the 7 known fields only, so the extras grant nothing. The escalation
    // surface (is_admin / bonus_entitlements) simply does not exist in the model.
    const { privateKey: attackerKey, publicPem: attackerPub } = makeKeypair();
    const { publicPem: realVendorPub } = makeKeypair();

    const withExtras = {
      ...makeKey(),
      is_admin: true,
      bonus_entitlements: { kill_switch: true },
    };
    const transportBytes = Buffer.from(JSON.stringify(withExtras));
    // Attacker signs the bytes WITH THE EXTRAS, but the verifier re-canonicalizes
    // the PARSED key (7 known fields only) before checking the signature.
    const env = signRawPayload(transportBytes, attackerKey);

    // (a) Against the genuine vendor key → not trusted at all.
    expect(verifyKey(env, realVendorPub, NOW_IN_TERM).state).toBe("invalid");

    // (b) Against the ATTACKER's own key the signature mismatches anyway, because
    //     the verifier hashes the CANONICAL 7-field payload (no extras), not the
    //     transported bytes the attacker signed. Fail-closed, and crucially no
    //     'is_admin'/'kill_switch' field is ever surfaced in the status.
    const selfVerify = verifyKey(env, attackerPub, NOW_IN_TERM);
    expect(selfVerify.state).toBe("invalid");
    // The status shape carries ONLY the modelled fields — no rogue keys leak out.
    expect(Object.keys(selfVerify).sort()).toEqual(
      ["circuit_id", "entitlements", "not_after", "reason", "state"],
    );
  });

  it("reordered payload JSON keys with a freshly-correct signature → still 'active' (canonicalization, non-regression)", () => {
    const { privateKey, publicPem } = makeKeypair();
    // Transport a DIFFERENTLY key-ordered JSON, but sign the CANONICAL bytes (as
    // the real signer does). The verifier canonicalizes before verifying, so a
    // legitimate re-ordering must NOT be treated as a forgery.
    const key = makeKey();
    const reordered = {
      not_after: key.not_after,
      entitlements: key.entitlements,
      vendor: key.vendor,
      circuit_id: key.circuit_id,
      key_version: key.key_version,
      issued_at: key.issued_at,
      not_before: key.not_before,
    };
    const transportBytes = Buffer.from(JSON.stringify(reordered));
    // Sign canonical bytes, transport the reordered bytes.
    const canonicalSig = cryptoSign(null, canonicalPayloadBytes(key), privateKey);
    const env =
      "choros1." +
      transportBytes.toString("base64url") +
      "." +
      canonicalSig.toString("base64url");
    const status = verifyKey(env, publicPem, NOW_IN_TERM);
    expect(status.state).toBe("active");
  });

  it("reordered keys but signature over the TRANSPORTED (non-canonical) bytes → 'invalid' (only canonical sig is honoured)", () => {
    const { privateKey, publicPem } = makeKeypair();
    const key = makeKey();
    const reordered = { not_after: key.not_after, entitlements: key.entitlements, vendor: key.vendor, circuit_id: key.circuit_id, key_version: key.key_version, issued_at: key.issued_at, not_before: key.not_before };
    const transportBytes = Buffer.from(JSON.stringify(reordered));
    // Sign the TRANSPORT bytes (not canonical). Verifier re-canonicalizes → mismatch.
    const status = verifyKey(signRawPayload(transportBytes, privateKey), publicPem, NOW_IN_TERM);
    expect(status.state).toBe("invalid");
  });

  it("wrong vendor key (valid sig, different keypair) → 'invalid'", () => {
    const { privateKey } = makeKeypair();
    const { publicPem: otherPub } = makeKeypair();
    const status = verifyKey(signEnvelope(makeKey(), privateKey), otherPub, NOW_IN_TERM);
    expect(status.state).toBe("invalid");
  });

  it("malformed base64url in payload segment → 'invalid'", () => {
    const { privateKey, publicPem } = makeKeypair();
    const [prefix, , sig] = splitEnvelope(signEnvelope(makeKey(), privateKey));
    const status = verifyKey(`${prefix}.@@@not-b64@@@.${sig}`, publicPem, NOW_IN_TERM);
    expect(status.state).toBe("invalid");
  });

  it("malformed base64url in signature segment → 'invalid'", () => {
    const { privateKey, publicPem } = makeKeypair();
    const [prefix, payload] = splitEnvelope(signEnvelope(makeKey(), privateKey));
    const status = verifyKey(`${prefix}.${payload}.@@@not-b64@@@`, publicPem, NOW_IN_TERM);
    expect(status.state).toBe("invalid");
  });

  it("signature lifted from a DIFFERENT valid key, pasted onto this payload → 'invalid'", () => {
    const { privateKey, publicPem } = makeKeypair();
    const envA = signEnvelope(makeKey({ circuit_id: "aaaaaaaa-0000-0000-0000-000000000000" }), privateKey);
    const envB = signEnvelope(makeKey({ circuit_id: "bbbbbbbb-0000-0000-0000-000000000000" }), privateKey);
    const [prefix, payloadA] = splitEnvelope(envA);
    const [, , sigB] = splitEnvelope(envB);
    // payload A with signature B (both individually valid, but mismatched) → invalid.
    const status = verifyKey(`${prefix}.${payloadA}.${sigB}`, publicPem, NOW_IN_TERM);
    expect(status.state).toBe("invalid");
  });

  it("bit-flip in a single signature byte → 'invalid'", () => {
    const { privateKey, publicPem } = makeKeypair();
    const [prefix, payload, sig] = splitEnvelope(signEnvelope(makeKey(), privateKey));
    const sigBytes = Buffer.from(sig, "base64url");
    sigBytes[0] = sigBytes[0]! ^ 0x01; // flip one bit
    const status = verifyKey(`${prefix}.${payload}.${sigBytes.toString("base64url")}`, publicPem, NOW_IN_TERM);
    expect(status.state).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — the fuzzed verdict propagates to the HTTP edge: gated /vendor/*
// service routes refuse with 403 ACTIVATION_INVALID, in BOTH auth modes.
// ---------------------------------------------------------------------------

let server: http.Server;
let base: string;

/** Run verifyKey over a fuzzed envelope and serve that verdict to the routes. */
function makeInvalidProvider(): () => ActivationStatus {
  const { privateKey, publicPem } = makeKeypair();
  // A bit-flipped (forged) signature → 'invalid'.
  const [prefix, payload, sig] = splitEnvelope(signEnvelope(makeKey(), privateKey));
  const sigBytes = Buffer.from(sig, "base64url");
  sigBytes[5] = sigBytes[5]! ^ 0xff;
  const forgedEnv = `${prefix}.${payload}.${sigBytes.toString("base64url")}`;
  const status = verifyKey(forgedEnv, publicPem, NOW_IN_TERM);
  // Sanity: the forged envelope really is 'invalid' (else the route test is vacuous).
  if (status.state !== "invalid") {
    throw new Error(`fuzz setup error: expected 'invalid', got '${status.state}'`);
  }
  return () => status;
}

beforeAll(async () => {
  const router = new Router();
  registerVendorActivationRoutes(router, makeInvalidProvider());
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((r) =>
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      r();
    }),
  );
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const ORIGINAL_AUTH_MODE = process.env["CHOROS_AUTH_MODE"];
afterEach(() => {
  if (ORIGINAL_AUTH_MODE === undefined) delete process.env["CHOROS_AUTH_MODE"];
  else process.env["CHOROS_AUTH_MODE"] = ORIGINAL_AUTH_MODE;
});

function httpReq(method: string, path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(`${base}${path}`);
    const req = http.request(
      { hostname: parsed.hostname, port: parseInt(parsed.port, 10), path: parsed.pathname, method },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => { data += c.toString(); });
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, json: { raw: data } }); }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const VENDOR_GATED: Array<{ method: string; path: string }> = [
  { method: "POST", path: "/vendor/updates/check" },
  { method: "POST", path: "/vendor/agentic-ops/run" },
  { method: "GET", path: "/vendor/support/ticket" },
];

describe("[T-0422] fuzzed (forged-sig) envelope → 403 ACTIVATION_INVALID on gated /vendor/* (fail-closed, both modes)", () => {
  for (const mode of ["dev", "keycloak"]) {
    for (const v of VENDOR_GATED) {
      it(`[${mode}] ${v.method} ${v.path} → 403 ACTIVATION_INVALID`, async () => {
        process.env["CHOROS_AUTH_MODE"] = mode;
        const r = await httpReq(v.method, v.path);
        expect(r.status).toBe(403);
        expect((r.json as { error?: { code?: string } }).error?.code).toBe("ACTIVATION_INVALID");
      });
    }
  }

  it("the unauthenticated reporting endpoint still reports the verdict (200, 'invalid')", async () => {
    process.env["CHOROS_AUTH_MODE"] = "keycloak";
    const r = await httpReq("GET", "/vendor/activation");
    expect(r.status).toBe(200);
    expect((r.json as { state?: string }).state).toBe("invalid");
  });
});
