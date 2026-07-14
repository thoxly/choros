/**
 * src/adapters/t0242-entitlement-port.ts — T-0246 B-1
 *
 * Live adapter bridging EntitlementPort → T-0242 PRODUCER API (src/vendor/issuance.ts).
 *
 * Design invariants (ADR §2.1/§2.5):
 *  - ALL dependencies injected via constructor (store + privKeyPem).
 *  - PEM is NEVER read from file inside this class — callers pass it as argument (NF-2).
 *  - No HTTP / fetch / SDK imports — only node:crypto is used (inside issuance.ts).
 *  - Sits in src/adapters/ (NOT src/core/ / src/runtime/) — outside the zones
 *    covered by entitlement-port-injectable.sh (c) and no-killswitch-in-crm.sh (1).
 *
 * Composition root (env-gate + PEM-read) → src/cli/issue-key-live.ts (env-read PEM)
 *   + src/composition/issue-key-live.ts (wires store + adapter).
 *
 * FF checked by:
 *  - vendor-priv-not-in-client-circuit.sh (FF-T242-2): no readFileSync/priv in this file.
 *  - no-killswitch-in-crm.sh (FF-7): no activation.ts import, no vendor import in issue-key.ts.
 *  - entitlement-port-injectable.sh (FF-5): port type unchanged, DI pattern preserved.
 */

import {
  issueEntitlement as vendorIssueEntitlement,
  signKey,
  PILOT_PLAN,
  PRO_PLAN,
  type LicenseStore,
  type IssueParams,
  type PlanSpec,
} from "../vendor/issuance.js";
import type {
  EntitlementPort,
  IssueEntitlementInput,
  LicenseRecord as PortLicenseRecord,
} from "../runtime/customer-onboarding/entitlement-port.js";

// ---------------------------------------------------------------------------
// T0242EntitlementPortDeps — all dependencies injected (NF-2)
// ---------------------------------------------------------------------------

export interface T0242EntitlementPortDeps {
  /** Injectable store: FileLicenseStore (prod) or InMemoryLicenseStore (tests). */
  readonly store: LicenseStore;
  /** PEM bytes of the Ed25519 private key — passed as argument, NEVER read here. */
  readonly privKeyPem: string | Buffer;
  /** Injectable clock (default: () => new Date()). */
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// T0242EntitlementPort — thin bridge: port → vendor producer API
// ---------------------------------------------------------------------------

/**
 * Live EntitlementPort adapter. Delegates to vendor issueEntitlement + signKey.
 *
 * issueEntitlement(input):
 *  1. Maps port IssueEntitlementInput → vendor IssueParams (plan-string → PlanSpec preset;
 *     source narrow with fail-closed default "pilot").
 *  2. Calls vendorIssueEntitlement (idempotent by circuit_id).
 *  3. Calls signKey to prove round-trip capability (throws on revoked record — AC-6).
 *  4. Returns LicenseRecord (vendor ⊇ port shape: circuit_id + issued_at always present).
 */
export class T0242EntitlementPort implements EntitlementPort {
  constructor(private readonly deps: T0242EntitlementPortDeps) {}

  async issueEntitlement(input: IssueEntitlementInput): Promise<PortLicenseRecord> {
    const now = (this.deps.now ?? (() => new Date()))();

    // (1) Map port-input → vendor IssueParams.
    const params: IssueParams = {
      circuit_id: input.circuit_id,
      plan: planSpecFor(input.plan),
      valid_from: input.valid_from,
      valid_until: input.valid_until,
      source: vendorSourceFor(input.source),
      notes: input.notes,
    };

    // (2) Issue (idempotent by circuit_id) → persists record in store.
    const rec = vendorIssueEntitlement(params, this.deps.store, now);

    // (3) Sign → proves round-trip capability; throws on revoked record (AC-6 test FF-5).
    // The wire string is not persisted in this phase (B-11 boundary / Step-5c deferral).
    void signKey(rec, this.deps.privKeyPem, now);

    // (4) Return minimal shape T-0244 reads (circuit_id + issued_at; vendor rec ⊇ port shape).
    return rec as unknown as PortLicenseRecord;
  }
}

// ---------------------------------------------------------------------------
// Helpers: plan-string → PlanSpec / source-string → vendor union
// ---------------------------------------------------------------------------

/**
 * Map a plan string from the port input to a vendor PlanSpec preset.
 * Default: PILOT_PLAN (fail-safe — pilot has fewer entitlements than pro).
 */
function planSpecFor(plan: string): PlanSpec {
  return plan === "pro" ? PRO_PLAN : PILOT_PLAN;
}

/**
 * Narrow a source string to the vendor IssueParams["source"] union.
 * Unrecognised value → "pilot" (fail-closed default).
 */
function vendorSourceFor(s: string): IssueParams["source"] {
  const VALID = ["pilot", "billing", "trial", "saas"] as const;
  return (VALID as readonly string[]).includes(s)
    ? (s as IssueParams["source"])
    : "pilot";
}
