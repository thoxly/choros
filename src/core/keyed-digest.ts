/**
 * src/core/keyed-digest.ts
 *
 * T-0118 (E4.3-fu, follow-up to T-0033's `F-1-hash-equality-oracle`). The
 * per-tenant **keyed-digest capability** that closes the masking equality-oracle.
 *
 * This is the IMPURE boundary that owns the secret-keyed HMAC: it imports
 * `node:crypto` (the `audit-preimage.ts` precedent) and lives OUTSIDE the pure
 * `data-classification.ts` core (C-4 / FF-DC9). The pure core receives only the
 * bound `digest()` *function* through the `MaskContext.keyedDigest` member — it
 * never imports crypto and never reads `process.env`.
 *
 * Contract (ADR §4.1, spec §4):
 *  - C-1 Tenant + field domain separation: the digest is a function of
 *    `(value, tenantId, resourceType, facetField, secret-key)`. Changing the
 *    tenant OR the field-identity changes the digest for the same value.
 *  - C-2 Keyed, not keyless: a secret key participates (HMAC-SHA256), so an
 *    observer of masked output without the key cannot reconstruct the digest for
 *    a guessed value (defeats offline rainbow/dictionary).
 *  - C-3 Determinism within scope (T-0033 AC-13 preserved): same
 *    `(value, tenant, field, key)` ⇒ same hex digest, every call.
 *  - Fail-closed (D-3/D-4): `digest()` returns `undefined` when no key is
 *    available; absence is a VALUE (undefined), never an exception. The caller
 *    (`maskFields`) omits the key (`drop`) — never the keyless djb2, never raw.
 *
 * Preimage canonicalization is length-prefixed (same family as
 * `audit-preimage.ts` `frame`) so no field-boundary ambiguity collides two
 * distinct inputs, e.g. `(resourceType="ab", facetField="c")` and
 * `(resourceType="a", facetField="bc")` digest differently (AC-3/AC-11).
 */

import { createHmac } from "node:crypto";

/** Identity a keyed digest is scoped to (domain separation, C-1). */
export interface KeyedDigestInput {
  /** The raw field value to digest (stringified canonically — see below). */
  value: unknown;
  /** Per-tenant separation (D-1, C-1) — already validated upstream. */
  tenantId: string;
  /** Field-identity part 1 — matches the classification-row key. */
  resourceType: string;
  /** Field-identity part 2 — matches the classification-row key. */
  facetField: string;
}

/**
 * Injected keyed-digest capability (ResolverDeps port pattern). PURE in the
 * functional sense (same input + same bound key ⇒ same output, C-3) but it is an
 * IMPURE module (imports `node:crypto`) — which is why it lives OUTSIDE the pure
 * data-classification core (C-4). Returns `undefined` when no key is available
 * for the tenant ⇒ the caller fails closed to `drop` (D-3, AC-5). It NEVER throws
 * for "no key": absence is a value (undefined), not an exception.
 */
export interface KeyedDigest {
  digest(input: KeyedDigestInput): string | undefined;
}

/** Length-prefix framing: 4-byte BE uint32 byte-count, then the value bytes. */
function frame(value: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(value.length, 0);
  return Buffer.concat([len, value]);
}

/**
 * Stringify a value the SAME way the pre-T-0118 keyless core did
 * (`typeof value === "string" ? value : JSON.stringify(value)`), so the
 * determinism contract (C-3 / AC-2 / AC-10) holds across value types. A value
 * that does not survive `JSON.stringify` (e.g. `undefined`, a bare bigint) is
 * coerced to the empty string — a stable, total mapping (no throw).
 */
function valueToString(value: unknown): string {
  if (typeof value === "string") return value;
  const s = JSON.stringify(value);
  return s === undefined ? "" : s;
}

/**
 * Build the canonical, length-prefixed preimage of
 * `(tenantId, resourceType, facetField, valueStr)`. Each segment is framed with
 * its own length so no boundary ambiguity collides two distinct inputs (C-1).
 */
function canonicalPreimage(input: KeyedDigestInput): Buffer {
  return Buffer.concat([
    frame(Buffer.from(input.tenantId, "utf8")),
    frame(Buffer.from(input.resourceType, "utf8")),
    frame(Buffer.from(input.facetField, "utf8")),
    frame(Buffer.from(valueToString(input.value), "utf8")),
  ]);
}

/**
 * Bind a silo secret into a `KeyedDigest`. HMAC-SHA256 over the canonical,
 * length-prefixed preimage keyed by `key` (the raw secret bytes, >= 32 in
 * production — provisioned per silo as `CHOROS_MASK_DIGEST_KEY`).
 *
 * If `key` is `undefined` or empty, the factory returns a `KeyedDigest` whose
 * `digest()` ALWAYS yields `undefined` — a present-but-keyless port is
 * indistinguishable from no port for the caller, and both fail closed to `drop`
 * (AC-5 / AC-6). This is the honest-degrade shape the composition root relies on
 * (key absent ⇒ no usable digest ⇒ every `hash` field drops, never raw, never
 * keyless).
 */
export function makeKeyedDigest(key: Buffer | undefined): KeyedDigest {
  if (key === undefined || key.length === 0) {
    return { digest: () => undefined };
  }
  // Copy the key bytes so the bound instance is not affected by later mutation
  // of the caller's buffer (the secret is captured once at the composition root).
  const boundKey = Buffer.from(key);
  return {
    digest(input: KeyedDigestInput): string | undefined {
      return createHmac("sha256", boundKey)
        .update(canonicalPreimage(input))
        .digest("hex");
    },
  };
}
