/**
 * src/core/bundle-commit.ts
 *
 * T-0083 · E12.2 — "Git under the hood": content-addressed commit of the bundle.
 *
 * PURE core: zero deps (no node:crypto, no process.env, no pg, no IO). The hash
 * function is INJECTED via BundleHashPort — the same injected-port pattern used
 * by T-0118 `KeyedDigest` in `grant-resolver.ts`. The impure SHA-256 adapter lives
 * in `bundle-commit-store.ts` (the adapter/non-pure layer).
 *
 * WHY this seam exists (mirrors T-0118 / `keyed-digest.ts` precedent):
 *   - `no-env-in-core.sh` and `keyed-digest-core-purity.sh` forbid `node:crypto`
 *     inside `src/core/`. Content-addressing requires SHA-256.
 *   - The hash port is injected at the adapter seam, exactly as T-0118 injected
 *     `KeyedDigest` into `ResolverDeps`. The pure core only calls the port.
 *
 * Design (ADR §7 extensibility-and-authoring.md):
 *   - BundleSnapshot: the five-member coherent bundle (BPMN + form + form-JSON-schema
 *     + object-schema + grants) captured as a deterministic serializable value.
 *     External members (BPMN/form-code) are present as opaque string blobs; the
 *     T-0082 bundle-members registry governs which are materialised vs deferred.
 *   - BundleCommit: a content-addressed commit object pointing to a BundleSnapshot.
 *     Chains via parent_hash (exactly like a git commit). The content_hash is the
 *     SHA-256 of the canonical serialisation of the snapshot + parent_hash, so
 *     same-bytes ⇒ same content_hash, always.
 *   - SemanticChange: human-readable element of the diff between two BundleCommits.
 *     "Git-like under the hood, semantic changelog outward" — the founder/user NEVER
 *     sees raw hashes (spec §7 "outward = семантический changelog").
 *
 * Determinism guarantee (ADR §7 D-1): same BundleSnapshot + same parent_hash ⇒
 *   identical content_hash. The canonical serialisation is JCS-style (keys sorted
 *   alphabetically, no undefined values, no non-JSON types). This mirrors
 *   `audit-preimage.ts` JCS implementation.
 *
 * GENESIS constant: the first commit in a bundle's history has parent_hash = GENESIS
 *   (32 zero bytes, same convention as `audit-preimage.ts` GENESIS_PREV_HASH).
 */

// ---------------------------------------------------------------------------
// GENESIS constant — the zero-hash parent for the first commit in a chain.
// 64 hex chars of zeros = 32 zero bytes (SHA-256 output size).
// ---------------------------------------------------------------------------

/** The genesis parent_hash value: 64 hex zeros. Used for the first commit in a chain. */
export const GENESIS_PARENT_HASH = "0".repeat(64) as string;

// ---------------------------------------------------------------------------
// BundleSnapshot — the coherent five-member bundle
// ---------------------------------------------------------------------------

/**
 * The coherent bundle snapshot to be committed. Captures all five members of the
 * bundle coherence unit (ADR §7 / T-0082 bundle_members.txt):
 *   1. object_schema  — the registry_def.record_schema (jsonb)
 *   2. grants         — the grant set for this bundle (serialised as JSON-safe array)
 *   3. bpmn_process   — BPMN XML (opaque string; may be empty/deferred per T-0082)
 *   4. form_code      — form code blob (opaque string; deferred member per T-0082)
 *   5. form_json_schema — form JSON-schema (deferred member per T-0082)
 *
 * All fields are required (deferred members send an empty string ""). This makes
 * the serialisation total (no undefined) and the canonical hash stable.
 *
 * Additional metadata (author, message) is carried on BundleCommit, NOT here —
 * so two commits with different messages but identical bundle state have different
 * content_hashes (because the preimage includes parent_hash + snapshot + metadata).
 */
export interface BundleSnapshot {
  /** Serialised object schema (jsonb as JSON string or stringified object). */
  object_schema: string;
  /**
   * Serialised grants array (JSON-stable representation of the grant set).
   * E.g. JSON.stringify of a sorted array of grant objects.
   */
  grants: string;
  /** BPMN XML blob or empty string if deferred. */
  bpmn_process: string;
  /** Form code blob or empty string if deferred. */
  form_code: string;
  /** Form JSON-schema blob or empty string if deferred. */
  form_json_schema: string;
}

// ---------------------------------------------------------------------------
// BundleCommit — content-addressed commit object
// ---------------------------------------------------------------------------

/**
 * A content-addressed commit of a BundleSnapshot. Chains via parent_hash to form
 * a content-addressed DAG (history of bundle versions for one tenant + bundle-id).
 *
 * The content_hash is produced by `computeContentHash` (injected via BundleHashPort):
 *   SHA-256(canonicalCommitPreimage(snapshot, parent_hash, author, message))
 *
 * The founder/user never sees content_hash or parent_hash directly; the outward
 * surface is the SemanticChange[] from `deriveSemanticChangelog`.
 */
export interface BundleCommit {
  /** The content address of this commit (64-char hex SHA-256). Stable: same inputs → same hash. */
  content_hash: string;
  /** The content_hash of the preceding commit, or GENESIS_PARENT_HASH for the first. */
  parent_hash: string;
  /** The bundle snapshot this commit captures. */
  snapshot: BundleSnapshot;
  /** Who authored this commit (e.g. agent actor string or user id). */
  author: string;
  /**
   * Human-written commit message (e.g. "add field X to object schema"). Optional;
   * empty string if absent. Included in the preimage so a re-message re-hashes.
   */
  message: string;
  /** Wall-clock timestamp in epoch-ms at the time of commit creation (injected, not Date.now()). */
  committed_at: number;
}

// ---------------------------------------------------------------------------
// BundleHashPort — the injected hashing capability (pure boundary)
// ---------------------------------------------------------------------------

/**
 * The ONLY impure dependency of the bundle-commit core: a function that computes
 * SHA-256 over arbitrary bytes. Injected at the adapter seam (bundle-commit-store.ts)
 * exactly as T-0118 injected `KeyedDigest` into `ResolverDeps`.
 *
 * The core never imports `node:crypto` — it calls this port. The port implementation
 * (`makeSha256Port` in `bundle-commit-store.ts`) owns the `node:crypto` import.
 *
 * Determinism contract: for the same `data` bytes, `hash(data)` MUST return the
 * same 64-char hex string every call (pure, no salt, no randomness).
 */
export interface BundleHashPort {
  /** Compute SHA-256 of `data`, return lowercase 64-char hex string. */
  hash(data: Buffer): string;
}

// ---------------------------------------------------------------------------
// Canonical preimage — deterministic serialisation (JCS-like, no node:crypto)
// ---------------------------------------------------------------------------

/** Length-prefix framing: 4-byte BE uint32, then the value bytes. */
function frame(value: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(value.length, 0);
  return Buffer.concat([len, value]);
}

/** Encode a string as UTF-8 bytes (caller frames). */
function encodeText(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

/** Encode a non-negative integer as 8 big-endian bytes (bigint safe range). */
function encodeInt64(n: number): Buffer {
  if (!Number.isInteger(n) || !Number.isSafeInteger(n) || n < 0) {
    throw new Error(`bundle-commit: committed_at must be a non-negative safe integer, got ${n}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(n), 0);
  return buf;
}

/**
 * Build the canonical, length-prefixed preimage of a BundleCommit input.
 *
 * Field order (FROZEN — changing breaks determinism):
 *   1. parent_hash (text, hex string)
 *   2. author (text)
 *   3. message (text)
 *   4. committed_at (int64 big-endian)
 *   5. snapshot.object_schema (text)
 *   6. snapshot.grants (text)
 *   7. snapshot.bpmn_process (text)
 *   8. snapshot.form_code (text)
 *   9. snapshot.form_json_schema (text)
 *
 * Each field is length-prefixed (4-byte BE uint32) so no two distinct inputs share a
 * preimage (same construction as `audit-preimage.ts` canonicalPreimage).
 */
export function canonicalCommitPreimage(
  snapshot: BundleSnapshot,
  parent_hash: string,
  author: string,
  message: string,
  committed_at: number,
): Buffer {
  return Buffer.concat([
    frame(encodeText(parent_hash)),       // 1. parent_hash
    frame(encodeText(author)),             // 2. author
    frame(encodeText(message)),            // 3. message
    frame(encodeInt64(committed_at)),      // 4. committed_at
    frame(encodeText(snapshot.object_schema)),    // 5. object_schema
    frame(encodeText(snapshot.grants)),           // 6. grants
    frame(encodeText(snapshot.bpmn_process)),      // 7. bpmn_process
    frame(encodeText(snapshot.form_code)),         // 8. form_code
    frame(encodeText(snapshot.form_json_schema)),  // 9. form_json_schema
  ]);
}

// ---------------------------------------------------------------------------
// makeCommit — assemble a BundleCommit via the injected hash port
// ---------------------------------------------------------------------------

/**
 * Create a new BundleCommit, computing the content_hash via the injected port.
 *
 * Determinism: same (snapshot, parent_hash, author, message, committed_at) + same
 * hash port ⇒ same content_hash. The port must be deterministic (SHA-256 is).
 *
 * @param snapshot     The coherent bundle snapshot.
 * @param parent_hash  Hash of the parent commit, or GENESIS_PARENT_HASH for first.
 * @param author       The authoring actor string.
 * @param message      Commit message (may be empty string).
 * @param committed_at Epoch-ms timestamp (injected by caller — never Date.now() in core).
 * @param port         The injected BundleHashPort (SHA-256 adapter).
 */
export function makeCommit(
  snapshot: BundleSnapshot,
  parent_hash: string,
  author: string,
  message: string,
  committed_at: number,
  port: BundleHashPort,
): BundleCommit {
  const preimage = canonicalCommitPreimage(snapshot, parent_hash, author, message, committed_at);
  const content_hash = port.hash(preimage);
  return {
    content_hash,
    parent_hash,
    snapshot,
    author,
    message,
    committed_at,
  };
}

// ---------------------------------------------------------------------------
// SemanticChange — human-readable diff element
// ---------------------------------------------------------------------------

/** Which bundle member changed between two BundleCommits. */
export type BundleMember =
  | "object_schema"
  | "grants"
  | "bpmn_process"
  | "form_code"
  | "form_json_schema";

/**
 * A single human-readable semantic change between two BundleCommit versions.
 *
 * ADR §7: "outward = semantic changelog" — the founder never sees raw hashes or
 * raw diffs. Each SemanticChange describes WHAT changed (member + kind) in
 * language the non-technical user can understand.
 */
export interface SemanticChange {
  /** Which member of the bundle changed. */
  member: BundleMember;
  /**
   * The kind of change:
   *   "added"   — member is non-empty in `to` but was empty/absent in `from`
   *   "removed" — member is non-empty in `from` but empty in `to`
   *   "updated" — member is non-empty in both but the content differs
   */
  kind: "added" | "removed" | "updated";
  /**
   * A short human-readable summary (e.g. "object schema updated",
   * "BPMN process definition added"). The full value is NOT exposed — only
   * the fact of change (mirrors T-0123 instruction_text change-flag pattern).
   */
  summary: string;
}

// ---------------------------------------------------------------------------
// deriveSemanticChangelog — pure semantic diff between two commits
// ---------------------------------------------------------------------------

const MEMBER_LABELS: Record<BundleMember, string> = {
  object_schema: "object schema",
  grants: "role/agent grants",
  bpmn_process: "BPMN process definition",
  form_code: "form code",
  form_json_schema: "form JSON-schema",
};

const MEMBERS: BundleMember[] = [
  "object_schema",
  "grants",
  "bpmn_process",
  "form_code",
  "form_json_schema",
];

/**
 * Derive a SemanticChange[] between two BundleCommits (from → to).
 *
 * For each of the five bundle members:
 *   - If the bytes are identical ⇒ no change
 *   - If `from` is empty and `to` is non-empty ⇒ "added"
 *   - If `from` is non-empty and `to` is empty  ⇒ "removed"
 *   - Otherwise (both non-empty, different)      ⇒ "updated"
 *
 * Returns an empty array if the two commits carry identical snapshots.
 * Never exposes the raw content_hash or parent_hash to the caller — the output
 * is a human-readable semantic list (ADR §7: "семантический changelog, НЕ raw diff").
 *
 * @param from  The earlier BundleCommit (previous version).
 * @param to    The later BundleCommit (new version).
 */
export function deriveSemanticChangelog(from: BundleCommit, to: BundleCommit): SemanticChange[] {
  const changes: SemanticChange[] = [];
  for (const member of MEMBERS) {
    const fromVal = from.snapshot[member];
    const toVal = to.snapshot[member];
    if (fromVal === toVal) continue;
    const label = MEMBER_LABELS[member];
    let kind: SemanticChange["kind"];
    if (!fromVal && toVal) {
      kind = "added";
    } else if (fromVal && !toVal) {
      kind = "removed";
    } else {
      kind = "updated";
    }
    changes.push({ member, kind, summary: `${label} ${kind}` });
  }
  return changes;
}
