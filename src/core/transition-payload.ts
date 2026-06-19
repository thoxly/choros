/**
 * src/core/transition-payload.ts
 *
 * T-0332 [E15-S0b]: Unified transition-event payload contract.
 *
 * Defines ONE canonical transition payload shape, neutral to the step-result form
 * (F1-A registry-append vs F1-B inline-update). Both emit paths — the engine
 * onDispatched callback (lifecycle-audit.ts) and the non-engine inbox approve
 * transaction (process-projection.ts) — embed a `transition_payload` key carrying
 * this shape into the existing `audit_event` payload (F2 Phase 1: NO new table).
 *
 * This makes the §4 metrics queries independent of which step-result form is in use:
 * consumers (S3 journal, T-0339 analytics) read `payload->>'transition_payload'`
 * regardless of whether the surrounding event was emitted via the engine path or the
 * human-approval path.
 *
 * DESIGN INVARIANTS (mirroring lifecycle-audit.ts):
 *  - Pure / IO-free. No import from pg/http/https/net/fetch/child_process.
 *  - `actor_type` MUST be derived via `projectActorType` (re-exported here for
 *    convenience); emitters must not invent a parallel derivation.
 *  - `duration_ms`: populated where the value is already available at the call-site;
 *    set to null with a comment where T-0335 (completeTask duration pipeline) fills
 *    it in via the outbox. Do NOT compute durations here — that is T-0335's job.
 *  - `verdict`: a domain verdict field that is form-neutral (approve / complete /
 *    fail / etc.). Emitters supply the concrete string; consumers branch on it.
 *  - NO new DB table. Consumers read this from `audit_event.payload`.
 */

// Re-export so emitters import from one seam, not two.
export { projectActorType } from "./lifecycle-audit.js";
export type { ActorType, LifecycleChannel } from "./lifecycle-audit.js";

// ---------------------------------------------------------------------------
// Canonical TransitionPayload type (§3 / §4.2 contract).
//
// tenant_id   — scoping key for all metric GROUP-BY queries.
// instance_id — Flowable/process instance id (may be null for engine-path jobs
//               where the instanceId is not yet resolved at dispatch time).
// process_key — BPMN process definition key (e.g. "telLinear").
// activity    — BPMN activity / step name or audit event type acting as activity.
// actor       — slug / id of the actor who completed the transition.
// actor_type  — "human" | "agent" | "service", derived via projectActorType.
// ts          — epoch-ms of the transition event (== audit_event.occurred_at).
// duration_ms — null until T-0335 fills it via the completeTask outbox; populated
//               for non-engine paths where wall-clock duration is not tracked yet.
// verdict     — form-neutral domain outcome (e.g. "approve", "complete", "fail").
//               The meaning is per-activity; consumers branch on this field.
// ---------------------------------------------------------------------------

export interface TransitionPayload {
  readonly tenant_id: string;
  readonly instance_id: string | null;
  readonly process_key: string;
  readonly activity: string;
  readonly actor: string;
  readonly actor_type: "human" | "agent" | "service";
  readonly ts: number;
  /**
   * Task duration in milliseconds. null on the engine path until T-0335 completes
   * the completeTask duration pipeline; may be null on non-engine paths that do not
   * yet track wall-clock duration. T-0335 fills this field via the outbox in S1.
   */
  readonly duration_ms: number | null;
  /**
   * Domain verdict — form-neutral outcome. Examples:
   *   "approve"   (inbox card-action approve, non-engine path)
   *   "complete"  (external task completed, engine path)
   *   "fail"      (external task failed, engine path)
   */
  readonly verdict: string;
}

// ---------------------------------------------------------------------------
// Builder — pure function that constructs a canonical TransitionPayload.
// Call-sites supply all fields; the builder validates nothing (types do that).
// ---------------------------------------------------------------------------

export interface BuildTransitionPayloadArgs {
  readonly tenantId: string;
  readonly instanceId: string | null;
  readonly processKey: string;
  readonly activity: string;
  readonly actor: string;
  readonly actorType: "human" | "agent" | "service";
  readonly ts: number;
  /** Pass null if not yet available (T-0335 fills it later). */
  readonly durationMs: number | null;
  readonly verdict: string;
}

/**
 * Build the canonical TransitionPayload from the given args.
 * Both the engine path (lifecycle-audit.ts `makeAuditOnDispatched`) and the
 * non-engine path (process-projection.ts `appendTaskApproved`) call this builder
 * so both produce an identical-shape object under the `transition_payload` key.
 */
export function buildTransitionPayload(args: BuildTransitionPayloadArgs): TransitionPayload {
  return {
    tenant_id: args.tenantId,
    instance_id: args.instanceId,
    process_key: args.processKey,
    activity: args.activity,
    actor: args.actor,
    actor_type: args.actorType,
    ts: args.ts,
    duration_ms: args.durationMs,
    verdict: args.verdict,
  };
}

// ---------------------------------------------------------------------------
// Key constant — the payload property name under which the TransitionPayload is
// embedded in audit_event.payload. Centralised so emitters and consumers can
// import it rather than duplicate the string literal.
// ---------------------------------------------------------------------------

/** The key under which TransitionPayload is nested in audit_event.payload. */
export const TRANSITION_PAYLOAD_KEY = "transition_payload" as const;
