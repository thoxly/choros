/**
 * src/core/audit-preimage.ts
 *
 * T-0068 (owner of the T-0016 §4.3 canonical preimage). PURE, zero-dep beyond
 * `node:crypto`. Produces the deterministic, length-prefixed preimage of one
 * audit_event row and its SHA-256 row_hash. This module is the SINGLE source of
 * truth for the on-chain encoding (vocab_version = 1) — both the Postgres writer
 * (src/db/audit-writer.ts) and the InMemoryAuditWriter compute through it, so the
 * static-now unit golden and the live-DB chain can never drift apart.
 *
 * DESIGN INVARIANTS (ADR §4.3, NF-1/NF-7):
 *  - No import from pg/http/https/net/fetch/child_process. IO-free.
 *  - Field set & order are EXACT (see CANONICAL_FIELD_ORDER). Any change to the
 *    field set, order, encoding, hash, or genesis constants MUST bump
 *    VOCAB_VERSION — which flips the golden digest (FF-3) and reddens CI.
 *  - Each field is length-prefixed: 4-byte big-endian uint32 byte-count, then the
 *    value bytes. NULL is the sentinel length 0xFFFFFFFF with zero value bytes —
 *    distinct from an empty string (length 0, zero value bytes). NULL ≠ "".
 *  - jsonb fields (scope, payload) are JCS/RFC8785-canonicalized before encoding,
 *    so permuted object keys yield an identical preimage.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Vocab + genesis constants (part of vocab_version = 1; ADR §4.3).
// ---------------------------------------------------------------------------

/** The pinned vocabulary version of the canonical encoding. */
export const VOCAB_VERSION = 1 as const;

/** Genesis seq for the first row of a tenant's chain. */
export const GENESIS_SEQ = 1 as const;

/** Genesis prev_hash: 32 zero bytes (the chain anchor before seq=1). */
export const GENESIS_PREV_HASH: Buffer = Buffer.alloc(32, 0);

/** NULL length-prefix sentinel: max uint32, distinct from any real byte length. */
const NULL_SENTINEL = 0xffffffff;

// ---------------------------------------------------------------------------
// Canonical row shape (the writer assembles this; preimage encodes it).
// ---------------------------------------------------------------------------

/**
 * The exact set of fields fed into the preimage, in canonical order. `row_hash`
 * is the OUTPUT and is NOT part of its own preimage.
 */
export interface CanonicalAuditRow {
  tenant_id: string; // uuid (dashed form)
  seq: number; // bigint (safe < 2^53)
  id: string; // uuid (dashed form)
  type: string; // text
  actor: string; // text
  subject: string | null; // text | null
  scope: unknown | null; // jsonb | null (JCS-canonicalized)
  via: string | null; // text | null
  proposed_by: string | null; // text | null
  confirmed_by: string | null; // text | null
  payload: unknown; // jsonb (JCS-canonicalized; NOT NULL per migration 006)
  occurred_at: number; // bigint epoch-ms
  prev_hash: Buffer; // bytea (32 bytes)
  vocab_version: number; // smallint
}

/**
 * The canonical field order. Documented as a value (not just a comment) so the
 * encoder loop and any reviewer reference the same single list. Changing this
 * order is a vocab bump (FF-3 golden flips).
 */
export const CANONICAL_FIELD_ORDER = [
  "tenant_id",
  "seq",
  "id",
  "type",
  "actor",
  "subject",
  "scope",
  "via",
  "proposed_by",
  "confirmed_by",
  "payload",
  "occurred_at",
  "prev_hash",
  "vocab_version",
] as const;

// ---------------------------------------------------------------------------
// Low-level field encoders (each returns the VALUE bytes; framing adds length).
// ---------------------------------------------------------------------------

/** Length-prefix framing: 4-byte BE uint32 byte-count, then the value bytes. */
function frame(value: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(value.length, 0);
  return Buffer.concat([len, value]);
}

/** The NULL frame: sentinel length 0xFFFFFFFF and zero value bytes. */
function frameNull(): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(NULL_SENTINEL, 0);
  return len;
}

/** Parse a dashed UUID into its 16 raw big-endian bytes. */
function encodeUuid(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`audit-preimage: invalid uuid '${uuid}'`);
  }
  return Buffer.from(hex, "hex");
}

/** Encode a bigint-valued number as 8 raw big-endian bytes (two's complement). */
function encodeBigint(n: number): Buffer {
  if (!Number.isInteger(n)) {
    throw new Error(`audit-preimage: bigint field is not an integer: ${n}`);
  }
  if (!Number.isSafeInteger(n)) {
    throw new Error(`audit-preimage: bigint field exceeds safe integer range: ${n}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(n), 0);
  return buf;
}

/** Encode a smallint as 2 raw big-endian bytes. */
function encodeSmallint(n: number): Buffer {
  if (!Number.isInteger(n) || n < -32768 || n > 32767) {
    throw new Error(`audit-preimage: smallint out of range: ${n}`);
  }
  const buf = Buffer.alloc(2);
  buf.writeInt16BE(n, 0);
  return buf;
}

/** Encode a text value as UTF-8 bytes (caller frames; NULL handled by frameNull). */
function encodeText(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

// ---------------------------------------------------------------------------
// JCS / RFC 8785 canonical JSON (zero-dep; ADR §4.3 JCS profile).
//
// Object keys sorted by UTF-16 code unit; strings JSON-escaped per RFC 8785;
// numbers as shortest roundtrip integer/decimal (no trailing .0, no exponent
// where avoidable — JS Number.prototype.toString already yields this for the
// JSON value range Choros payloads carry); arrays preserve order; no whitespace.
// Only string/number/boolean/null/object/array are permitted — any other type
// (Date, bigint, function, undefined) is rejected as an encoding error.
// ---------------------------------------------------------------------------

/** RFC 8785 string escaping (the same set JSON.stringify produces for strings). */
function jcsString(s: string): string {
  // JSON.stringify on a string produces RFC 8785-compliant escaping (it escapes
  // the two-char short forms and \u00xx control chars, leaving all other code
  // points literal UTF-8). This matches the 8785 string production exactly.
  return JSON.stringify(s);
}

function jcsNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`audit-preimage: non-finite number in jsonb: ${n}`);
  }
  // Integers in safe range serialize without a fractional part or exponent;
  // JS toString already yields the shortest roundtrip form for these.
  return String(n);
}

function jcsCanonicalize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return jcsNumber(value as number);
  if (t === "string") return jcsString(value as string);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => jcsCanonicalize(v)).join(",") + "]";
  }
  if (t === "object") {
    // Only PLAIN objects are valid JSON containers. Reject Date, Map, class
    // instances, etc. — they would silently serialize to {} (losing data and
    // breaking the verifier invariant). A plain object has Object.prototype or a
    // null prototype.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const ctorName =
        (proto as { constructor?: { name?: string } } | null)?.constructor?.name ?? "unknown";
      throw new Error(
        `audit-preimage: non-plain object in jsonb (${ctorName}) is not valid JSON`,
      );
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(); // default sort = UTF-16 code-unit order
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) {
        throw new Error(`audit-preimage: undefined value at jsonb key '${k}' (not JSON)`);
      }
      parts.push(jcsString(k) + ":" + jcsCanonicalize(v));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`audit-preimage: unsupported jsonb value type '${t}'`);
}

/** Encode a jsonb field (frames with length; NULL handled by caller via frameNull). */
function encodeJsonb(value: unknown): Buffer {
  return Buffer.from(jcsCanonicalize(value), "utf8");
}

// ---------------------------------------------------------------------------
// canonicalPreimage — the single deterministic encoding (ADR §4.3).
// ---------------------------------------------------------------------------

/**
 * Build the canonical preimage Buffer for an audit row. Deterministic and
 * length-unambiguous: same logical row → identical bytes; NULL ≠ ""; permuted
 * jsonb keys → identical preimage (JCS).
 */
export function canonicalPreimage(row: CanonicalAuditRow): Buffer {
  const parts: Buffer[] = [];

  // 1. tenant_id (uuid, 16 raw bytes)
  parts.push(frame(encodeUuid(row.tenant_id)));
  // 2. seq (bigint, 8 bytes)
  parts.push(frame(encodeBigint(row.seq)));
  // 3. id (uuid, 16 raw bytes)
  parts.push(frame(encodeUuid(row.id)));
  // 4. type (text, NOT NULL)
  parts.push(frame(encodeText(row.type)));
  // 5. actor (text, NOT NULL)
  parts.push(frame(encodeText(row.actor)));
  // 6. subject (text | null)
  parts.push(row.subject === null ? frameNull() : frame(encodeText(row.subject)));
  // 7. scope (jsonb | null)
  parts.push(row.scope === null ? frameNull() : frame(encodeJsonb(row.scope)));
  // 8. via (text | null)
  parts.push(row.via === null ? frameNull() : frame(encodeText(row.via)));
  // 9. proposed_by (text | null)
  parts.push(row.proposed_by === null ? frameNull() : frame(encodeText(row.proposed_by)));
  // 10. confirmed_by (text | null)
  parts.push(row.confirmed_by === null ? frameNull() : frame(encodeText(row.confirmed_by)));
  // 11. payload (jsonb, NOT NULL per migration 006)
  if (row.payload === null || row.payload === undefined) {
    throw new Error("audit-preimage: payload is NOT NULL (migration 006); got null/undefined");
  }
  parts.push(frame(encodeJsonb(row.payload)));
  // 12. occurred_at (bigint, 8 bytes)
  parts.push(frame(encodeBigint(row.occurred_at)));
  // 13. prev_hash (bytea, 32 bytes)
  if (!Buffer.isBuffer(row.prev_hash) || row.prev_hash.length !== 32) {
    throw new Error("audit-preimage: prev_hash must be a 32-byte Buffer");
  }
  parts.push(frame(row.prev_hash));
  // 14. vocab_version (smallint, 2 bytes)
  parts.push(frame(encodeSmallint(row.vocab_version)));

  return Buffer.concat(parts);
}

/** SHA-256 of the canonical preimage = the row_hash (32 bytes, vocab=1). */
export function rowHash(row: CanonicalAuditRow): Buffer {
  return createHash("sha256").update(canonicalPreimage(row)).digest();
}
