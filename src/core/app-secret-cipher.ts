/**
 * src/core/app-secret-cipher.ts — T-0476 [E-AGENTS L3]
 *
 * AEAD envelope encryption for the app:// secret store (migration 106, app_secret).
 *
 * Spec: docs/specs/agent-registry-and-llm-keys.spec.md §4 п.4, §5.
 *
 * THE CRYPTO. A tenant's raw API key is sealed with AES-256-GCM — an AUTHENTICATED
 * cipher (confidentiality + integrity). Each encryption draws a fresh random 12-byte
 * nonce (the GCM IV); the 16-byte GCM auth tag is appended to the ciphertext so a
 * tampered row fails decryption (auth-tag mismatch → throw, never silent). The raw
 * key is NEVER persisted, logged, or returned — only {ciphertext, nonce, keyVersion}
 * leave this module, and decrypt() returns the plaintext to its IMMEDIATE caller only
 * (the composition-root resolveSecret), never further.
 *
 * PURITY / ENV BOUNDARY (no-env-in-core.sh, FF-T163): this module NEVER reads
 * process.env. The 32-byte master key is passed in EXPLICITLY by the composition
 * root (src/server.ts reads APP_SECRET_MASTER_KEY and derives the key). This mirrors
 * the env-secret-allowlist.ts pattern (pure decision, env read only at the root) and
 * makes the crypto unit-testable in isolation with a deterministic key.
 *
 * KEY VERSIONING / ROTATION (spec §10 non-goal): key_version is carried on every
 * sealed row so a future rotation can re-key old rows. v1 is the current master key.
 * Rotation itself is a later task — this module only stamps and validates the version.
 *
 * DORMANCY (spec §4 п.4): when the master key is UNSET the store is DORMANT. This
 * module models that as a typed error (AppSecretStoreUnconfiguredError) raised by
 * loadMasterKey(undefined) — the route turns it into an honest 503/"secret store not
 * configured" and NEVER stores plaintext / NEVER crashes the process.
 */

import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants (AES-256-GCM)
// ---------------------------------------------------------------------------

/** AES-256-GCM. 32-byte key, 12-byte IV (NIST-recommended GCM nonce length). */
const ALGO = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The current master-key version. New rows are sealed at this version. */
export const CURRENT_KEY_VERSION = 1;

// ---------------------------------------------------------------------------
// Errors (typed so the route can map them to honest HTTP without leaking)
// ---------------------------------------------------------------------------

/**
 * Raised when APP_SECRET_MASTER_KEY is unset/blank → the app:// store is DORMANT.
 * The route maps this to a 503 "secret store not configured" (honest, no crash, no
 * plaintext stored). NEVER carries any key material in its message.
 */
export class AppSecretStoreUnconfiguredError extends Error {
  readonly code = "APP_SECRET_STORE_UNCONFIGURED" as const;
  constructor() {
    super("app:// secret store is not configured (APP_SECRET_MASTER_KEY unset)");
    this.name = "AppSecretStoreUnconfiguredError";
  }
}

/** Raised on decrypt failure (auth-tag mismatch / corrupt row / wrong key). */
export class AppSecretDecryptError extends Error {
  readonly code = "APP_SECRET_DECRYPT_FAILED" as const;
  constructor(message: string) {
    // message is a STATIC reason — never includes ciphertext/plaintext/key bytes.
    super(message);
    this.name = "AppSecretDecryptError";
  }
}

// ---------------------------------------------------------------------------
// Master-key derivation
// ---------------------------------------------------------------------------

/**
 * Derive the 32-byte AES-256 master key from the raw env value.
 *
 * Accepts ANY non-empty string and folds it to exactly 32 bytes via SHA-256 — this
 * lets the operator supply either a 64-hex-char key OR an arbitrary passphrase; both
 * yield a uniform 256-bit key. (A future KMS path would replace this derivation; the
 * column key_version distinguishes the regime.)
 *
 * @param raw the APP_SECRET_MASTER_KEY env value (or undefined when unset).
 * @throws AppSecretStoreUnconfiguredError when raw is undefined/empty (DORMANT).
 */
export function loadMasterKey(raw: string | undefined | null): Buffer {
  if (raw === undefined || raw === null || raw.trim().length === 0) {
    throw new AppSecretStoreUnconfiguredError();
  }
  // SHA-256 fold → uniform 32 bytes regardless of input length/encoding.
  return createHash("sha256").update(raw, "utf8").digest().subarray(0, KEY_BYTES);
}

/** True iff a usable master key is configured (store is ACTIVE, not dormant). */
export function isSecretStoreConfigured(raw: string | undefined | null): boolean {
  return typeof raw === "string" && raw.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt
// ---------------------------------------------------------------------------

/** The sealed output of an encryption — exactly what the app_secret row stores. */
export interface SealedSecret {
  /** AES-256-GCM ciphertext WITH the 16-byte auth tag appended. */
  readonly ciphertext: Buffer;
  /** The random 12-byte GCM nonce (IV), unique per encryption. */
  readonly nonce: Buffer;
  /** The master-key version that sealed this row. */
  readonly keyVersion: number;
}

/**
 * Seal a plaintext secret with AES-256-GCM under the given master key.
 * Draws a FRESH random nonce per call (never reused). Returns ciphertext (tag
 * appended) + nonce + keyVersion — the raw plaintext is NOT retained anywhere.
 *
 * @param plaintext the raw secret (e.g. an API key). Must be non-empty.
 * @param masterKey the 32-byte key from loadMasterKey().
 */
export function encryptSecret(plaintext: string, masterKey: Buffer): SealedSecret {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptSecret: plaintext must be a non-empty string");
  }
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== KEY_BYTES) {
    throw new Error("encryptSecret: masterKey must be a 32-byte Buffer");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, masterKey, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store ciphertext WITH the auth tag appended (single bytea column).
  const ciphertext = Buffer.concat([enc, tag]);
  return { ciphertext, nonce, keyVersion: CURRENT_KEY_VERSION };
}

/**
 * Decrypt a sealed secret back to plaintext. Verifies the GCM auth tag — a tampered
 * or corrupt row throws AppSecretDecryptError (never returns garbage, never silent).
 *
 * The returned plaintext is for the IMMEDIATE caller only (resolveSecret at the
 * composition root). It MUST NOT be logged, returned in an API response, or egressed.
 *
 * @param sealed the {ciphertext(+tag), nonce, keyVersion} read from app_secret.
 * @param masterKey the 32-byte key from loadMasterKey() for sealed.keyVersion.
 */
export function decryptSecret(sealed: SealedSecret, masterKey: Buffer): string {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== KEY_BYTES) {
    throw new Error("decryptSecret: masterKey must be a 32-byte Buffer");
  }
  const { ciphertext, nonce } = sealed;
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length <= TAG_BYTES) {
    throw new AppSecretDecryptError("ciphertext too short (missing auth tag)");
  }
  if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) {
    throw new AppSecretDecryptError("invalid nonce length");
  }
  // Split the appended auth tag off the ciphertext.
  const enc = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, masterKey, nonce);
  decipher.setAuthTag(tag);
  try {
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    // GCM tag mismatch (wrong key or tampered row) → opaque error, no detail leak.
    throw new AppSecretDecryptError("authentication failed (wrong key or corrupt row)");
  }
}
