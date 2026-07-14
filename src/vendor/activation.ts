/**
 * src/vendor/activation.ts — T-0127 (T-0198 impl)
 *
 * Offline verifier for the `choros-key.v1` activation key.
 *
 * The activation key SELLS A SERVICE (updates + agentic maintenance + support),
 * it is NOT a kill-switch. An absent/expired/forged key NEVER halts or degrades
 * the circuit — it only changes the entitlement verdict that the VENDOR layer
 * consults before calling vendor services. The core (src/core/**) never reads
 * this module — that one-way edge is the executable form of the no-kill-switch
 * red-line (FF-T127-1).
 *
 * Wire format (KeyEnvelope.raw):
 *   choros1.<base64url(canonical-json payload)>.<base64url(ed25519 sig)>
 *
 * `verifyKey` is a PURE function:
 *   - zero-dep: uses only node:crypto (no http/https/fetch/pg/axios)
 *   - NO network call (offline-verifiable — NF-2; a mandatory call-home would
 *     itself be a covert kill-switch via availability)
 *   - NO DB
 *   - NO process.env read inside the verifier (the env boundary stays in the
 *     composition root; the vendor public key is passed in by the caller)
 *
 * Verdict (ActivationStatus.state):
 *   - 'active'     — signature valid AND not_before <= now < not_after
 *   - 'autonomous' — valid signature but expired (now >= not_after) OR no key
 *   - 'invalid'    — signature mismatch / parse error / malformed envelope
 *
 * 'invalid' and 'autonomous' both mean "the core keeps running"; only the
 * entitlement verdict differs.
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

// ---------------------------------------------------------------------------
// Object model (mirrors T-0127 contract object_model)
// ---------------------------------------------------------------------------

/** Named service-layer flags the subscription grants (Q-1). */
export interface EntitlementSet {
  /** entitled to self-upgrade / image pulls from the vendor. */
  updates: boolean;
  /** entitled to vendor agentic maintenance (fleet-ops). */
  agentic_ops: boolean;
  /** entitled to the vendor support channel. */
  support: boolean;
  /** informational plan tier label (free-form, vendor-defined). */
  tier: string;
}

/** Signed payload — the canonical-JSON body the vendor signs. */
export interface ActivationKey {
  /** format/version pin — 'choros-key.v1'. */
  key_version: string;
  /** identity of THIS circuit/installation to the vendor control-plane (Q-4). */
  circuit_id: string;
  /** issuing vendor id (e.g. 'choros'). */
  vendor: string;
  /** named service-layer flags the subscription grants (Q-1). */
  entitlements: EntitlementSet;
  /** RFC3339 issue timestamp. */
  issued_at: string;
  /** RFC3339 start of validity. */
  not_before: string;
  /** RFC3339 expiry; AFTER this the key is expired => autonomous, NEVER a halt. */
  not_after: string;
}

/** Wire form of the envelope. */
export interface KeyEnvelope {
  /** 'choros1.<base64url(payload-json)>.<base64url(ed25519-sig)>'. */
  raw: string;
  /** base64url canonical JSON of ActivationKey. */
  payload_b64: string;
  /** base64url Ed25519 signature over the canonical payload bytes. */
  sig_b64: string;
}

/** Vendor-layer verdict — NEVER computed in core. */
export interface ActivationStatus {
  /** 'active' | 'autonomous' (expired|missing) | 'invalid' (bad signature/parse). */
  state: "active" | "autonomous" | "invalid";
  /** present iff signature valid. */
  circuit_id: string | null;
  /** present iff state === 'active'. */
  entitlements: EntitlementSet | null;
  /** expiry timestamp if parsed, else null. */
  not_after: string | null;
  /** human-readable reason. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

const WIRE_PREFIX = "choros1";
const KEY_VERSION = "choros-key.v1";

// ---------------------------------------------------------------------------
// base64url <-> bytes (no padding) — node Buffer supports 'base64url'.
// ---------------------------------------------------------------------------

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

// ---------------------------------------------------------------------------
// Canonical JSON — sorted keys, no insignificant whitespace, UTF-8.
// Deterministic so the signer and verifier hash the SAME bytes.
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ":" + canonicalize(obj[k]),
  );
  return "{" + parts.join(",") + "}";
}

/**
 * Serialize an ActivationKey to the canonical bytes that get signed. Exported so
 * the dev signing helper and tests produce byte-identical input to the verifier.
 */
export function canonicalPayloadBytes(key: ActivationKey): Buffer {
  return Buffer.from(canonicalize(key), "utf8");
}

// ---------------------------------------------------------------------------
// Envelope parsing
// ---------------------------------------------------------------------------

/**
 * Parse the wire string into a KeyEnvelope. Returns null on any malformation.
 */
export function parseEnvelope(raw: string): KeyEnvelope | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 3) return null;
  const [prefix, payload_b64, sig_b64] = parts as [string, string, string];
  if (prefix !== WIRE_PREFIX) return null;
  if (payload_b64.length === 0 || sig_b64.length === 0) return null;
  return { raw: trimmed, payload_b64, sig_b64 };
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function isEntitlementSet(v: unknown): v is EntitlementSet {
  if (v === null || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e["updates"] === "boolean" &&
    typeof e["agentic_ops"] === "boolean" &&
    typeof e["support"] === "boolean" &&
    typeof e["tier"] === "string"
  );
}

function parsePayload(payloadBytes: Buffer): ActivationKey | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p["key_version"] !== "string" ||
    typeof p["circuit_id"] !== "string" ||
    typeof p["vendor"] !== "string" ||
    typeof p["issued_at"] !== "string" ||
    typeof p["not_before"] !== "string" ||
    typeof p["not_after"] !== "string" ||
    !isEntitlementSet(p["entitlements"])
  ) {
    return null;
  }
  return {
    key_version: p["key_version"] as string,
    circuit_id: p["circuit_id"] as string,
    vendor: p["vendor"] as string,
    entitlements: p["entitlements"] as EntitlementSet,
    issued_at: p["issued_at"] as string,
    not_before: p["not_before"] as string,
    not_after: p["not_after"] as string,
  };
}

// ---------------------------------------------------------------------------
// verifyKey — the offline, zero-dep, pure verifier.
// ---------------------------------------------------------------------------

/**
 * Verify an activation-key wire string against the vendor public key.
 *
 * @param envelope    wire string 'choros1.<payload>.<sig>'. Empty/whitespace =>
 *                    treated as "no key present" => autonomous.
 * @param vendorPubKey the vendor PUBLIC key, as the raw bytes of the PEM (SPKI)
 *                    file shipped with the image (config/activation/vendor-pub.ed25519).
 * @param now         injected clock (no Date.now() read inside — keeps the
 *                    function pure/testable).
 * @returns ActivationStatus — NEVER throws into a core path.
 */
export function verifyKey(
  envelope: string,
  vendorPubKey: Uint8Array,
  now: Date,
): ActivationStatus {
  // No key present => autonomous (F-10). Not an error.
  if (envelope === undefined || envelope === null || envelope.trim().length === 0) {
    return {
      state: "autonomous",
      circuit_id: null,
      entitlements: null,
      not_after: null,
      reason: "no key present",
    };
  }

  const parsed = parseEnvelope(envelope);
  if (parsed === null) {
    return {
      state: "invalid",
      circuit_id: null,
      entitlements: null,
      not_after: null,
      reason: "malformed envelope",
    };
  }

  const payloadBytes = b64urlDecode(parsed.payload_b64);
  const sigBytes = b64urlDecode(parsed.sig_b64);

  const key = parsePayload(payloadBytes);
  if (key === null) {
    return {
      state: "invalid",
      circuit_id: null,
      entitlements: null,
      not_after: null,
      reason: "payload parse error",
    };
  }

  if (key.key_version !== KEY_VERSION) {
    return {
      state: "invalid",
      circuit_id: null,
      entitlements: null,
      not_after: key.not_after,
      reason: `unsupported key_version '${key.key_version}'`,
    };
  }

  // Verify the Ed25519 signature over the CANONICAL payload bytes (not the
  // transported bytes — canonicalization makes signer/verifier agree even if the
  // transport JSON re-ordered keys).
  let signatureOk = false;
  try {
    const pubKeyObj = createPublicKey({
      key: Buffer.from(vendorPubKey),
      format: "pem",
    });
    signatureOk = cryptoVerify(
      null,
      canonicalPayloadBytes(key),
      pubKeyObj,
      sigBytes,
    );
  } catch {
    signatureOk = false;
  }

  if (!signatureOk) {
    return {
      state: "invalid",
      circuit_id: null,
      entitlements: null,
      not_after: key.not_after,
      reason: "signature mismatch",
    };
  }

  // Signature valid — now the term check decides active vs autonomous.
  const nowMs = now.getTime();
  const notBeforeMs = Date.parse(key.not_before);
  const notAfterMs = Date.parse(key.not_after);

  if (Number.isNaN(notBeforeMs) || Number.isNaN(notAfterMs)) {
    return {
      state: "invalid",
      circuit_id: key.circuit_id,
      entitlements: null,
      not_after: key.not_after,
      reason: "unparseable validity window",
    };
  }

  if (nowMs < notBeforeMs) {
    // Not yet valid — treated as autonomous (circuit runs; vendor services wait).
    return {
      state: "autonomous",
      circuit_id: key.circuit_id,
      entitlements: null,
      not_after: key.not_after,
      reason: `not yet valid (not_before ${key.not_before})`,
    };
  }

  if (nowMs >= notAfterMs) {
    // Expired => autonomous (NEVER a halt).
    return {
      state: "autonomous",
      circuit_id: key.circuit_id,
      entitlements: null,
      not_after: key.not_after,
      reason: `expired ${key.not_after}`,
    };
  }

  // In-term + valid signature => active.
  return {
    state: "active",
    circuit_id: key.circuit_id,
    entitlements: key.entitlements,
    not_after: key.not_after,
    reason: "active",
  };
}

// ---------------------------------------------------------------------------
// Entitlement helpers (vendor-layer only).
// ---------------------------------------------------------------------------

/** Service flags the vendor layer may gate on. */
export type VendorService = "updates" | "agentic_ops" | "support";

/**
 * Is the circuit entitled to a given vendor service RIGHT NOW?
 * Only true when the key is 'active' AND the specific flag is set.
 * Used ONLY by vendor endpoints to decide 402/403 — never by core.
 */
export function isEntitled(status: ActivationStatus, service: VendorService): boolean {
  if (status.state !== "active" || status.entitlements === null) return false;
  return status.entitlements[service] === true;
}
