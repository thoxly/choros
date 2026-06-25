/**
 * src/__tests__/app-secret-cipher.test.ts — T-0476 [E-AGENTS L3]
 *
 * Pure unit tests for the AEAD envelope cipher + the app:// handle helpers. No DB,
 * runs in the default vitest project. The DB/RLS/route end-to-end proofs live in
 * ci/checks/db/app_secret_store.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  loadMasterKey,
  isSecretStoreConfigured,
  CURRENT_KEY_VERSION,
  AppSecretStoreUnconfiguredError,
  AppSecretDecryptError,
} from "../core/app-secret-cipher.js";
import {
  isAppHandle,
  parseAppHandle,
  makeAppHandle,
  validateSecretHandleShape,
  redactHandle,
} from "../core/secret-handle-validator.js";

describe("app-secret-cipher — AES-256-GCM envelope encryption", () => {
  const KEY_RAW = "test-master-key-0123456789";

  it("round-trips plaintext; ciphertext differs from plaintext", () => {
    const key = loadMasterKey(KEY_RAW);
    const pt = "sk-proj-very-secret-llm-key-987654321";
    const sealed = encryptSecret(pt, key);
    expect(sealed.keyVersion).toBe(CURRENT_KEY_VERSION);
    expect(sealed.nonce.length).toBe(12);
    expect(sealed.ciphertext.length).toBeGreaterThan(16); // GCM tag appended
    expect(sealed.ciphertext.toString("utf8")).not.toContain(pt);
    expect(decryptSecret(sealed, key)).toBe(pt);
  });

  it("fresh random nonce per call → no nonce/ciphertext reuse", () => {
    const key = loadMasterKey(KEY_RAW);
    const a = encryptSecret("same", key);
    const b = encryptSecret("same", key);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("tamper detection: a flipped byte fails the auth tag", () => {
    const key = loadMasterKey(KEY_RAW);
    const sealed = encryptSecret("payload", key);
    const bad = Buffer.from(sealed.ciphertext);
    bad[0] = bad[0]! ^ 0x01;
    expect(() => decryptSecret({ ...sealed, ciphertext: bad }, key)).toThrow(AppSecretDecryptError);
  });

  it("wrong key fails authentication", () => {
    const sealed = encryptSecret("payload", loadMasterKey("key-a"));
    expect(() => decryptSecret(sealed, loadMasterKey("key-b"))).toThrow(AppSecretDecryptError);
  });

  it("nonce of wrong length is rejected by decrypt", () => {
    const key = loadMasterKey(KEY_RAW);
    const sealed = encryptSecret("payload", key);
    expect(() =>
      decryptSecret({ ...sealed, nonce: Buffer.alloc(8) }, key),
    ).toThrow(AppSecretDecryptError);
  });

  it("dormant: loadMasterKey throws when unset/blank; isSecretStoreConfigured is false", () => {
    expect(() => loadMasterKey(undefined)).toThrow(AppSecretStoreUnconfiguredError);
    expect(() => loadMasterKey(null)).toThrow(AppSecretStoreUnconfiguredError);
    expect(() => loadMasterKey("")).toThrow(AppSecretStoreUnconfiguredError);
    expect(() => loadMasterKey("  ")).toThrow(AppSecretStoreUnconfiguredError);
    expect(isSecretStoreConfigured(undefined)).toBe(false);
    expect(isSecretStoreConfigured("")).toBe(false);
    expect(isSecretStoreConfigured("k")).toBe(true);
  });

  it("derives a 32-byte key from any input length", () => {
    expect(loadMasterKey("x").length).toBe(32);
    expect(loadMasterKey("a".repeat(200)).length).toBe(32);
  });
});

describe("app:// handle helpers + shape validation", () => {
  const id = "11111111-2222-3333-4444-555555555555";

  it("makeAppHandle / isAppHandle / parseAppHandle round-trip", () => {
    const h = makeAppHandle(id);
    expect(h).toBe(`app://${id}`);
    expect(isAppHandle(h)).toBe(true);
    expect(parseAppHandle(h)).toEqual({ secretId: id });
  });

  it("parseAppHandle rejects non-app and malformed ids", () => {
    expect(parseAppHandle("env://X")).toBeNull();
    expect(parseAppHandle("app://not-a-uuid")).toBeNull();
    expect(parseAppHandle("app://")).toBeNull();
    expect(isAppHandle("vault://x")).toBe(false);
  });

  it("an app:// handle PASSES validateSecretHandleShape (it is a scheme ref, not a raw key)", () => {
    const v = validateSecretHandleShape(makeAppHandle(id));
    expect(v.ok).toBe(true);
  });

  it("redactHandle collapses app:// to the scheme only", () => {
    expect(redactHandle(makeAppHandle(id))).toBe("app://...");
  });
});
