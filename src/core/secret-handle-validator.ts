/**
 * src/core/secret-handle-validator.ts — T-0025 E5.5 BYO-LLM Secret-Handle Custody
 *
 * PURE, IO-FREE module (FF-25-1). No pg/fetch/http/https/net/child_process imports.
 *
 * Exports:
 *   validateSecretHandleShape — RL-3 not-a-raw-key heuristic guard (FR-5).
 *   redactHandle              — opaque summary for status endpoint (FR-4).
 *   SecretResolverPort        — custody port TYPE for T-0039 / Stage-2 (§8).
 *
 * The validator is a SAFEGUARD, not a full parser. A passing value is stored AS-IS.
 * Stage-2 / T-0045 supplies the real resolveSecret implementation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The four rejection reasons (contract — part of AC test assertions). */
export type SecretHandleRejectReason =
  | "too_short"         // < 8 chars (FR-5 row 4)
  | "vendor_key_prefix" // sk- | sk-proj- | xai- | AIza (FR-5 row 1)
  | "bare_hex_token"    // ^[0-9a-fA-F]{32,}$ (FR-5 row 2)
  | "jwt_shape";        // eyJ… three Base64url dot-segments (FR-5 row 3)

/** Discriminated union returned by validateSecretHandleShape. */
export type SecretHandleVerdict =
  | { ok: true }
  | { ok: false; reason: SecretHandleRejectReason };

// ---------------------------------------------------------------------------
// Port type (custody boundary — T-0025 owns the declaration, Stage-2 owns impl)
// ---------------------------------------------------------------------------

/**
 * T-0025 owns this port TYPE (custody boundary).
 * T-0039's GrantProposeDeps.resolveSecret is structurally compatible with this.
 * The real implementation is Stage-2 / T-0045 — T-0025 NEVER invokes this.
 */
export interface SecretResolverPort {
  resolveSecret(handle: string, ctx: { tenantId: string }): Promise<string>;
}

// ---------------------------------------------------------------------------
// Rejection rules (ADR §2.1 — rejection ORDER is contract)
// ---------------------------------------------------------------------------

/** Vendor key prefixes rejected by RL-3 heuristic (AC-2/AC-3). */
const VENDOR_PREFIXES = ["sk-", "xai-", "AIza"] as const;

/**
 * /^[0-9a-fA-F]{32,}$/ — bare hex token heuristic (AC-4).
 * The 32+ lower bound matches bare hash/API-token patterns.
 */
const BARE_HEX_RE = /^[0-9a-fA-F]{32,}$/;

/**
 * JWT shape: begins with eyJ, three Base64url segments separated by `.`
 * (signature segment may be empty for an unsigned JWT) (AC-5).
 */
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

// ---------------------------------------------------------------------------
// validateSecretHandleShape
// ---------------------------------------------------------------------------

/**
 * PURE, IO-free RL-3 not-a-raw-key shape guard.
 *
 * Rejection order (frozen — the reason string is part of the contract for tests):
 *   1. too_short       — value.length < 8        (AC-6)
 *   2. vendor_key_prefix — starts with sk-, xai-, AIza  (AC-2/AC-3)
 *   3. bare_hex_token  — matches ^[0-9a-fA-F]{32,}$   (AC-4)
 *   4. jwt_shape       — matches eyJ three-segment pattern (AC-5)
 *
 * A value that passes this check is stored AS-IS (safeguard, not a parser).
 */
export function validateSecretHandleShape(value: string): SecretHandleVerdict {
  // Rule 1: too_short
  if (value.length < 8) {
    return { ok: false, reason: "too_short" };
  }

  // Rule 2: vendor_key_prefix (sk-proj- is a prefix of sk-; both caught by sk-)
  for (const prefix of VENDOR_PREFIXES) {
    if (value.startsWith(prefix)) {
      return { ok: false, reason: "vendor_key_prefix" };
    }
  }

  // Rule 3: bare_hex_token
  if (BARE_HEX_RE.test(value)) {
    return { ok: false, reason: "bare_hex_token" };
  }

  // Rule 4: jwt_shape
  if (JWT_RE.test(value)) {
    return { ok: false, reason: "jwt_shape" };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// redactHandle
// ---------------------------------------------------------------------------

/**
 * Returns a redacted summary for the status endpoint (FR-4).
 * NEVER returns the full value. Output examples:
 *   "vault://secret/agent/x" → "vault://..."
 *   "env://LLM_KEY"          → "env://..."
 *   "someOpaqueToken123"     → "someOpaq..."
 *
 * Used ONLY by the GET /status handler; never logged or placed in audit payload.
 */
export function redactHandle(value: string): string {
  // If the value looks like a scheme-based reference (contains "://"), return the scheme prefix.
  const schemeIdx = value.indexOf("://");
  if (schemeIdx !== -1) {
    return value.slice(0, schemeIdx + 3) + "...";
  }
  // Otherwise, return the first 8 characters + ellipsis.
  return value.slice(0, 8) + "...";
}
