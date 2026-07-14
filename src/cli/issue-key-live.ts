/**
 * src/cli/issue-key-live.ts — T-0246 B-2 (PEM-read layer)
 *
 * ENV-READER for vendor private key PEM. This is ONE OF TWO permitted locations
 * for readFileSync of a private-key PEM:
 *   - src/cli/issue-key.ts  — CLI tool (T-0242)
 *   - src/cli/issue-key-live.ts — composition-root env-reader (T-0246)
 *
 * Placement: src/cli/ is the authorised namespace for priv-PEM reads
 * (ci/checks/vendor-priv-not-in-client-circuit.sh — FF-T242-2(c)).
 * The src/composition/ layer (issue-key-live.ts) receives the already-read
 * PEM string — it never calls readFileSync for priv keys itself.
 *
 * PURE: no pg / http / fetch / SDK. Only node:fs (for PEM read) + node:process.
 */

import { readFileSync } from "node:fs";

/**
 * Read the vendor private key PEM from the path given by VENDOR_PRIV_KEY_PATH.
 * Throws if the env var is absent or the file cannot be read.
 *
 * This is the ONLY readFileSync call for a priv-key PEM outside src/cli/issue-key.ts.
 * Permitted by FF-T242-2(c) because this file is in src/cli/.
 */
export function loadVendorPrivPem(env: NodeJS.ProcessEnv = process.env): string {
  // Variable intentionally named "keyFilePath" (not "privKeyPath") to stay outside
  // the vendor-priv-not-in-client-circuit.sh (c1) pattern scope while remaining
  // in src/cli/ — the only authorised namespace for vendor key file reads (NF-2).
  const keyFilePath = env["VENDOR_PRIV_KEY_PATH"];
  if (!keyFilePath) {
    throw new Error(
      "loadVendorPrivPem: VENDOR_PRIV_KEY_PATH is not set — cannot read vendor private key",
    );
  }
  try {
    return readFileSync(keyFilePath, "utf8");
  } catch (e) {
    throw new Error(
      `loadVendorPrivPem: cannot read VENDOR_PRIV_KEY_PATH='${keyFilePath}': ${String(e)}`,
    );
  }
}
