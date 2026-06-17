/**
 * src/composition/issue-key-live.ts — T-0246 B-2 (ports-wiring layer)
 *
 * Env-gated composition root for the "Выпустить ключ" wiring.
 * Mirrors the pattern of src/runtime/legal-precheck/demo-run.ts.
 *
 * Two-layer design (ADR §2.5):
 *  - PEM READ  → src/cli/issue-key-live.ts::loadVendorPrivPem (src/cli/ is the
 *                authorised namespace per FF-T242-2(c)).
 *  - PORT WIRE → this file accepts ledgerPath + privKeyPem as arguments, builds
 *                FileLicenseStore + T0242EntitlementPort. No file-IO for priv keys.
 *
 * makeEntitlementWiring(env):
 *  - CUSTOMER_ONBOARDING_LIVE !== "true" ⇒ dormant (fail-closed, default).
 *  - CUSTOMER_ONBOARDING_LIVE === "true" ⇒ reads VENDOR_LEDGER_PATH +
 *    VENDOR_PRIV_KEY_PATH via the cli layer, builds live adapter.
 *
 * NOT imported by server.ts — no live HTTP caller for runIssueKey exists yet
 * (B-11 boundary). This module is the composition seam for when B-11 lands.
 */

import { FileLicenseStore } from "../vendor/file-license-store.js";
import { T0242EntitlementPort } from "../adapters/t0242-entitlement-port.js";
import {
  dormantEntitlementPort,
  type EntitlementPort,
} from "../runtime/customer-onboarding/entitlement-port.js";
import { loadVendorPrivPem } from "../cli/issue-key-live.js";

// ---------------------------------------------------------------------------
// LiveEntitlementWiring — the result of makeEntitlementWiring
// ---------------------------------------------------------------------------

export interface LiveEntitlementWiring {
  /** The resolved port: live adapter or dormant fail-closed stub. */
  readonly entitlement: EntitlementPort;
  /** True iff CUSTOMER_ONBOARDING_LIVE==="true" and live adapter was constructed. */
  readonly liveEnabled: boolean;
}

// ---------------------------------------------------------------------------
// makeEntitlementWiring — env-gate factory
// ---------------------------------------------------------------------------

/**
 * Reads env at composition time and returns the wiring.
 *
 * live path:
 *   CUSTOMER_ONBOARDING_LIVE=true
 *   VENDOR_LEDGER_PATH=<path-to-ledger.json>
 *   VENDOR_PRIV_KEY_PATH=<path-to-priv.pem>   ← read by cli/issue-key-live.ts
 *
 * dormant path (default): CUSTOMER_ONBOARDING_LIVE absent or !== "true".
 */
export function makeEntitlementWiring(
  env: NodeJS.ProcessEnv = process.env,
): LiveEntitlementWiring {
  if (env["CUSTOMER_ONBOARDING_LIVE"] !== "true") {
    return { entitlement: dormantEntitlementPort, liveEnabled: false };
  }

  const ledgerPath = requireEnv(env, "VENDOR_LEDGER_PATH");
  // PEM read delegated to cli layer (the authorised namespace for priv-file read).
  const privKeyPem = loadVendorPrivPem(env);
  const store = new FileLicenseStore(ledgerPath);

  return {
    entitlement: new T0242EntitlementPort({ store, privKeyPem }),
    liveEnabled: true,
  };
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const val = env[key];
  if (!val) {
    throw new Error(
      `makeEntitlementWiring: ${key} is required when CUSTOMER_ONBOARDING_LIVE=true`,
    );
  }
  return val;
}
