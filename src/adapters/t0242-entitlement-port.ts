/**
 * src/adapters/t0242-entitlement-port.ts — T-0244 B-10 (Stage-deploy stub)
 *
 * Production adapter that bridges EntitlementPort → T-0242 PRODUCER API.
 * This file is a STAGE-DEPLOY placeholder. T-0242 is currently IN DESIGN;
 * this adapter is dormant until T-0242 is ready and its endpoint is configured.
 *
 * IMPORTANT: This adapter lives in src/adapters/ (NOT in src/core/) and is
 * the ONLY place where a real HTTP call to T-0242 will eventually live.
 * - src/core/customer-subscription/ imports ONLY types from this zone.
 * - src/runtime/customer-onboarding/ accepts the port via DI.
 *
 * To enable in production:
 *  1. Set T0242_ENDPOINT in environment.
 *  2. Replace the throw below with a real fetch call to T-0242.
 *  3. Wire this adapter into the composition root (main.ts / server.ts).
 *
 * Until then, dormantEntitlementPort (from entitlement-port.ts) is the default.
 */

import type {
  EntitlementPort,
  IssueEntitlementInput,
  LicenseRecord,
} from "../runtime/customer-onboarding/entitlement-port.js";

/**
 * Stage-deploy production adapter for EntitlementPort.
 * Currently throws — T-0242 endpoint not yet deployed.
 * Replace the body with a real HTTP call to T-0242 when it ships.
 */
export class T0242EntitlementPort implements EntitlementPort {
  constructor(
    private readonly _endpoint: string,
    // In production: also takes a secret resolver or API key
  ) {}

  async issueEntitlement(input: IssueEntitlementInput): Promise<LicenseRecord> {
    // Stage-deploy placeholder.
    // When T-0242 ships, this becomes:
    //   const res = await fetch(`${this._endpoint}/v1/entitlements`, { method:"POST", body: JSON.stringify(input), ... })
    //   if (!res.ok) throw new Error(`T-0242 error: ${res.status}`)
    //   return await res.json() as LicenseRecord
    throw new Error(
      `T0242EntitlementPort: not yet implemented — endpoint=${this._endpoint}, input.circuit_id=${input.circuit_id}`,
    );
  }
}
