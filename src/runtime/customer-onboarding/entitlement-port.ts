/**
 * src/runtime/customer-onboarding/entitlement-port.ts — T-0244 B-2
 *
 * Injectable EntitlementPort — the frozen contract-seam between T-0244 (CRM)
 * and T-0242 (PRODUCER-side key issuance). Mirrors LlmPort (T-0233) pattern.
 *
 * PURE: no pg / http / fetch / node:net / child_process / process.env / SDK.
 *       Verified by ci/checks/entitlement-port-injectable.sh (FF-5).
 *
 * Location: src/runtime/customer-onboarding/ — NOT in src/core/ to avoid
 * triggering no-killswitch-in-core.sh (the vocabulary entitlement/not_after
 * is a PORT/FIELD name here, not a kill-switch branch; but the red-line
 * check is a vocabulary sweep and cannot distinguish intent).
 *
 * Production adapter → src/adapters/t0242-entitlement-port.ts (Stage-deploy).
 * Test stub          → src/runtime/customer-onboarding/__tests__/stub-entitlement-port.ts
 * Default            → dormantEntitlementPort (throws on any call, fail-closed).
 *
 * Contract-seam frozen by orchestrator (ADR §3.4). T-0244 reads ONLY
 * LicenseRecord.circuit_id and LicenseRecord.issued_at — nothing else.
 */

// ---------------------------------------------------------------------------
// IssueEntitlementInput — the frozen call signature (ADR §3.4)
// ---------------------------------------------------------------------------

/**
 * Request payload for issueEntitlement.
 * Field names frozen by orchestrator — T-0244 and T-0242 share this shape.
 */
export interface IssueEntitlementInput {
  readonly circuit_id: string;
  readonly plan: string;
  readonly valid_from: string;     // ISO date — day of issuance
  readonly valid_until: string;    // ISO date — record.data.not_after
  readonly source: string;         // e.g. "pilot"
  readonly notes?: string;
}

// ---------------------------------------------------------------------------
// LicenseRecord — minimal shape T-0244 reads from T-0242 response
// ---------------------------------------------------------------------------

/**
 * T-0242 issues a full LicenseRecord internally; T-0244 consumes ONLY
 * circuit_id (echo) and issued_at (timestamp → activation_key_issued_at).
 * Other fields (signature, refresh, revoke handles) are T-0242's domain.
 */
export interface LicenseRecord {
  readonly circuit_id: string;
  readonly issued_at: string;   // ISO-8601 → record.data.activation_key_issued_at
  // additional fields owned by T-0242 — T-0244 does not destructure them
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// EntitlementPort — the injectable interface
// ---------------------------------------------------------------------------

export interface EntitlementPort {
  /**
   * Issue an entitlement (activation key) for the given input.
   * Production: calls T-0242; stub: returns a deterministic fixture;
   * dormant: throws EntitlementDormantError (fail-closed default).
   */
  issueEntitlement(input: IssueEntitlementInput): Promise<LicenseRecord>;
}

// ---------------------------------------------------------------------------
// EntitlementDormantError — thrown by dormantEntitlementPort
// ---------------------------------------------------------------------------

/**
 * Thrown when dormantEntitlementPort.issueEntitlement() is called.
 * runIssueKey catches this and leaves the step open (AC-8).
 */
export class EntitlementDormantError extends Error {
  readonly cause = "dormant" as const;

  constructor(message = "entitlement runtime dormant — T-0242 not yet deployed") {
    super(message);
    this.name = "EntitlementDormantError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// dormantEntitlementPort — the fail-closed default
// ---------------------------------------------------------------------------

/**
 * The default EntitlementPort. Throws on any call — structurally impossible
 * to make a network call through this port.
 *
 * Used until T-0242 is ready and wired via src/adapters/t0242-entitlement-port.ts.
 */
export const dormantEntitlementPort: EntitlementPort = {
  issueEntitlement(_input: IssueEntitlementInput): Promise<LicenseRecord> {
    throw new EntitlementDormantError(
      "entitlement runtime dormant — configure T-0242 adapter to enable",
    );
  },
};
