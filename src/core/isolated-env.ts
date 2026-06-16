/**
 * src/core/isolated-env.ts — T-0088 E12.7: on-demand physical isolation config-flip.
 *
 * PURE, IO-FREE. No import from pg, http, https, net, fetch, child_process, fs,
 * process.env, Date.now, Math.random.
 *
 * This module models the ось C (axis C) decision from:
 *   docs/design/extensibility-and-authoring.md §3 / §8 / §9.6
 *
 * DESIGN INVARIANTS:
 *
 *  1. DEFAULT = logical tiers in one silo (physical_isolation_requested = false).
 *     A tenant with no flag set (or flag=false) uses the two logical tiers
 *     (draft→published) provided by T-0087.  This is the common path.
 *
 *  2. ESCALATION = config-flip (physical_isolation_requested = true).
 *     Setting this flag signals that the tenant has been escalated to a physically
 *     isolated contour. It does NOT provision anything — actual infra provisioning
 *     is human-gated (GT-4, founder-gated). The flag is the seam the rest of the
 *     system reads to route/gate escalation-aware operations.
 *
 *  3. REVERSIBLE. Flipping back to false re-enters logical-tier mode. No data is
 *     lost by the flip itself (the logical tier model — T-0087 — remains active
 *     in both states; the physical contour is an additive operational concern).
 *
 *  4. NO AUTO-PROVISION. Setting the flag never triggers createDatabase,
 *     provisionContour, or any new Postgres pool. Those are deploy-time,
 *     founder-gated operations that read this flag as their trigger signal but
 *     are not part of this module.
 *
 * Exports:
 *   IsolationMode          — "logical" | "physical" (resolved from the flag)
 *   resolveIsolationMode   — pure: boolean flag → IsolationMode
 *   IsolatedEnvEscalation  — input to decideIsolationEscalation
 *   EscalationDecision     — decision union (allow / reject) from decideIsolationEscalation
 *   decideIsolationEscalation — pure: validate a request to set the flag
 *   IsolatedEnvState       — snapshot of a tenant's isolation model state
 *   describeIsolatedEnvState  — pure: build a human-readable state description
 *
 * ADR cross-reference:
 *   extensibility-and-authoring.md §3 (ось C), §8 (on-demand escalation), §9.6 (defaults)
 *   T-0087-client-env-tiers.adr.md §2 / §3 / FF-8 (no auto-provision)
 */

// ---------------------------------------------------------------------------
// IsolationMode — resolved interpretation of the flag
// ---------------------------------------------------------------------------

/**
 * The resolved isolation mode for a tenant:
 *  - "logical"  — two logical tiers (draft→published) in one silo (DEFAULT, §8 ADR).
 *  - "physical" — tenant has been flagged for an on-demand physically isolated
 *                 contour (rare escalation; infra is deploy-time / founder-gated).
 */
export type IsolationMode = "logical" | "physical";

/**
 * Resolve the isolation mode from the raw flag stored on the tenant row.
 *
 * physical_isolation_requested = false (or absent) → "logical" (default)
 * physical_isolation_requested = true              → "physical" (escalation)
 *
 * Pure; no IO. Call this wherever the rest of the system needs to route
 * based on isolation mode.
 */
export function resolveIsolationMode(physicalIsolationRequested: boolean): IsolationMode {
  return physicalIsolationRequested ? "physical" : "logical";
}

// ---------------------------------------------------------------------------
// decideIsolationEscalation — pure decision on flag mutation requests
// ---------------------------------------------------------------------------

/** Input to decideIsolationEscalation. */
export interface IsolatedEnvEscalation {
  /**
   * The current flag value stored on the tenant row.
   * false = logical mode (default); true = physical escalation already set.
   */
  currentFlag: boolean;
  /**
   * The new flag value being requested.
   * true = escalate to physical; false = revert to logical (de-escalation).
   */
  requestedFlag: boolean;
  /**
   * From the AUTHENTICATED actor_type claim (T-0044 §9 discipline).
   * An autonomous agent cannot flip the isolation flag — it is a human-gate
   * operation (§8: «агент предлагает — человек подтверждает»).
   * MUST come from the authenticated source, never from the request body.
   */
  actorType: "human" | "agent";
}

/** Decision union returned by decideIsolationEscalation. */
export type EscalationDecision =
  | { ok: true;  action: "escalate";   from: false; to: true  }   // logical → physical
  | { ok: true;  action: "deescalate"; from: true;  to: false }   // physical → logical (revert)
  | { ok: true;  action: "noop";       flag: boolean           }   // flag unchanged (idempotent)
  | { ok: false; code: "FORBIDDEN_AGENT_ISOLATION_FLIP"        }   // agent tried to flip (AC-IE-2)
  | { ok: false; code: "NO_CHANGE"                             };  // requested === current (caller error)

/**
 * Pure decision: validates a request to mutate the physical_isolation_requested flag.
 *
 * - Agent actor → FORBIDDEN_AGENT_ISOLATION_FLIP (human-gate, §8 / T-0044 §9).
 * - requestedFlag === currentFlag → NO_CHANGE (idempotent-safe: no mutation needed).
 * - Human + escalate (false→true) → ok, action="escalate".
 * - Human + de-escalate (true→false) → ok, action="deescalate" (reversible, §8).
 *
 * NOTE: The DECISION does not provision or deprovision any infra. It returns the
 * intent; the service layer is responsible for persisting the flag and emitting
 * the audit event. No createDatabase / provisionContour / compose-up here.
 *
 * NO_CHANGE is returned as a separate code (not silently ignored) so the HTTP
 * layer can return a clear 409 / 200-with-noop rather than masking caller bugs.
 */
export function decideIsolationEscalation(
  input: IsolatedEnvEscalation,
): EscalationDecision {
  // Human-gate: agents cannot flip the isolation flag (§8 governance / T-0044).
  if (input.actorType === "agent") {
    return { ok: false, code: "FORBIDDEN_AGENT_ISOLATION_FLIP" };
  }
  // Idempotent: no-op if already in requested state.
  if (input.requestedFlag === input.currentFlag) {
    return { ok: false, code: "NO_CHANGE" };
  }
  // Escalate: logical → physical.
  if (!input.currentFlag && input.requestedFlag) {
    return { ok: true, action: "escalate", from: false, to: true };
  }
  // De-escalate: physical → logical (reversible, §8).
  // input.currentFlag === true && input.requestedFlag === false at this point.
  return { ok: true, action: "deescalate", from: true, to: false };
}

// ---------------------------------------------------------------------------
// IsolatedEnvState + describeIsolatedEnvState — snapshot / diagnostics
// ---------------------------------------------------------------------------

/**
 * A point-in-time snapshot of a tenant's isolation model state.
 * Used for diagnostics, audit payloads, and API responses.
 */
export interface IsolatedEnvState {
  /** Raw flag from the tenant row. */
  physicalIsolationRequested: boolean;
  /** Resolved interpretation. */
  mode: IsolationMode;
  /**
   * Whether actual infra provisioning has been completed (deploy-time, founder-gated).
   * This is a SEPARATE concern from the flag: the flag expresses intent; this field
   * reflects whether the physical contour is live. Day-1 default is false —
   * provisioning status is tracked outside this model (GT-4 / deploy pipeline).
   * Included here as the seam so the rest of the system can read a coherent snapshot.
   */
  contourProvisioned: boolean;
}

/**
 * Build a human-readable summary of the isolation state for changelogs / API responses.
 * Pure; no IO.
 */
export function describeIsolatedEnvState(state: IsolatedEnvState): string {
  if (!state.physicalIsolationRequested) {
    return "logical tiers (draft→published) in one silo — default ось-C (T-0088)";
  }
  if (state.contourProvisioned) {
    return "physical isolated contour — escalation active, contour provisioned (T-0088)";
  }
  return "physical isolation requested — contour NOT YET provisioned (flag set, deploy pending) (T-0088)";
}
