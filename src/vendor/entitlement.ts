/**
 * src/vendor/entitlement.ts — T-0127 (T-0198 impl)
 *
 * Vendor-layer composition that loads the activation key + the shipped vendor
 * public key, then calls the PURE `verifyKey` to produce the ActivationStatus.
 *
 * This module is the env/file boundary for activation (the pure verifier in
 * activation.ts deliberately reads NEITHER process.env NOR the filesystem). It
 * lives in src/vendor/** so the no-kill-switch invariant (FF-T127-1) holds:
 * src/core/** never imports this, never reads activation/entitlement state.
 *
 * Sources (in priority order):
 *   1. an explicitly-provided key string (e.g. from the request or a caller)
 *   2. CHOROS_ACTIVATION_KEY env var
 *   3. config/activation/activation.key file (gitignored runtime artifact)
 * If none present => autonomous mode (F-10), no error.
 *
 * The vendor public key is read from config/activation/vendor-pub.ed25519
 * (committed, shipped with the image) — overridable via CHOROS_VENDOR_PUBKEY_PATH.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { verifyKey, type ActivationStatus } from "./activation.js";

const DEFAULT_PUBKEY_PATH = "config/activation/vendor-pub.ed25519";
const DEFAULT_ACTIVATION_KEY_PATH = "config/activation/activation.key";

/** Resolved sources for activation evaluation (env boundary lives here). */
export interface ActivationSources {
  /** raw activation-key wire string, or null/empty for autonomous. */
  keyString: string | null;
  /** raw bytes of the vendor PEM public key. */
  vendorPubKey: Uint8Array | null;
}

/**
 * Resolve activation sources from env + filesystem. This is the ONLY place that
 * reads process.env / the filesystem for activation — keeps verifyKey pure.
 *
 * @param baseDir process working dir root for relative config paths (default cwd).
 */
export function resolveActivationSources(baseDir: string = process.cwd()): ActivationSources {
  // --- activation key (optional) -------------------------------------------
  let keyString: string | null = null;
  const envKey = process.env["CHOROS_ACTIVATION_KEY"];
  if (typeof envKey === "string" && envKey.trim().length > 0) {
    keyString = envKey.trim();
  } else {
    const keyPath = join(baseDir, DEFAULT_ACTIVATION_KEY_PATH);
    if (existsSync(keyPath)) {
      try {
        const fromFile = readFileSync(keyPath, "utf8").trim();
        keyString = fromFile.length > 0 ? fromFile : null;
      } catch {
        keyString = null;
      }
    }
  }

  // --- vendor public key (shipped) -----------------------------------------
  let vendorPubKey: Uint8Array | null = null;
  const pubPath = process.env["CHOROS_VENDOR_PUBKEY_PATH"] ?? join(baseDir, DEFAULT_PUBKEY_PATH);
  if (existsSync(pubPath)) {
    try {
      vendorPubKey = readFileSync(pubPath);
    } catch {
      vendorPubKey = null;
    }
  }

  return { keyString, vendorPubKey };
}

/**
 * Compute the current ActivationStatus from resolved sources + clock.
 *
 * If the vendor public key is missing entirely, no signature can be checked: the
 * circuit still runs (autonomous) — the absence of a trust anchor is NOT a halt.
 */
export function evaluateActivation(
  sources: ActivationSources,
  now: Date = new Date(),
): ActivationStatus {
  if (sources.vendorPubKey === null) {
    return {
      state: "autonomous",
      circuit_id: null,
      entitlements: null,
      not_after: null,
      reason: "vendor public key not present; cannot verify — autonomous",
    };
  }
  return verifyKey(sources.keyString ?? "", sources.vendorPubKey, now);
}

/**
 * Convenience: resolve sources from env/fs and evaluate in one call. Used by the
 * vendor HTTP edges and the installer summary path.
 */
export function currentActivationStatus(
  baseDir: string = process.cwd(),
  now: Date = new Date(),
): ActivationStatus {
  return evaluateActivation(resolveActivationSources(baseDir), now);
}
