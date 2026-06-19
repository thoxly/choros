/**
 * src/core/gateway-journal.ts — T-0339 [E15-S3]
 *
 * Emitter for the `gateway.evaluated` transition-journal event (F2 Phase 1, §4.2).
 *
 * S5 (T-0340) wires the DMN runtime so `gateway.evaluated` is emitted on every
 * exclusive-gateway evaluation in the process. This module provides the PURE
 * emitter (IO-free payload builder) so that:
 *   (a) The mat-view (migration 079) + cycle-time analytics can reference the
 *       `gateway.evaluated` event type before S5 is wired.
 *   (b) The emitter contract is fixed in one place (single source of truth),
 *       matching the canonical TransitionPayload shape (T-0332 / src/core/transition-payload.ts).
 *   (c) Tests for S3 analytics can supply synthetic gateway.evaluated rows
 *       without waiting for S5.
 *
 * DESIGN INVARIANTS (ADR §5 / FF-11):
 *   - IO-free. No import from pg/http/https/net/fetch/child_process.
 *   - Uses buildTransitionPayload (single payload derivation source) — no parallel logic.
 *   - The `verdict` field carries the gateway's evaluated branch (e.g. "approved",
 *     "rejected", "escalated") — supplied by the S5 DMN caller.
 *   - `durationMs` is null (gateways are synchronous evaluations; no meaningful duration).
 *   - `activity` should be the BPMN exclusive-gateway element id / name.
 *
 * Usage (S5 / T-0340 wiring):
 *   const payload = buildGatewayEvaluatedPayload({ ... });
 *   await writer.appendAuditEvent(tx, {
 *     id: randomUUID(),
 *     type: GATEWAY_EVALUATED_TYPE,    // re-exported from process-projection.ts
 *     ...payload,                      // spread the built payload fields
 *   });
 */

import {
  buildTransitionPayload,
  TRANSITION_PAYLOAD_KEY,
  type TransitionPayload,
} from "./transition-payload.js";

// Re-export the type constant so S5/T-0340 imports from ONE seam.
export { GATEWAY_EVALUATED_TYPE } from "../http/process-projection.js";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface BuildGatewayEvaluatedPayloadArgs {
  readonly tenantId: string;
  readonly instanceId: string;
  readonly processKey: string;
  /** BPMN exclusive-gateway element id or name (e.g. "needsLawyer", "amountGw"). */
  readonly gatewayId: string;
  /** The actor that triggered the evaluation (usually the system/service). */
  readonly actor: string;
  /** actor_type: "service" for DMN pre-compute, "agent" for agent-driven evals. */
  readonly actorType: "human" | "agent" | "service";
  /** Epoch-ms of the evaluation. */
  readonly ts: number;
  /** The evaluated branch / verdict (e.g. "approved", "needs-lawyer", "escalate"). */
  readonly verdict: string;
}

/**
 * Build the payload object for a `gateway.evaluated` audit event (S3 / §4.2).
 * IO-free. Callers spread the result into the AuditEventInput shape.
 */
export function buildGatewayEvaluatedPayload(
  args: BuildGatewayEvaluatedPayloadArgs,
): {
  subject: string;
  scope: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const transitionPayload: TransitionPayload = buildTransitionPayload({
    tenantId: args.tenantId,
    instanceId: args.instanceId,
    processKey: args.processKey,
    activity: args.gatewayId,
    actor: args.actor,
    actorType: args.actorType,
    ts: args.ts,
    durationMs: null, // gateways are synchronous; no meaningful duration
    verdict: args.verdict,
  });

  return {
    subject: `instance:${args.instanceId}`,
    scope: {
      proc_key: args.processKey,
      gateway_id: args.gatewayId,
    },
    payload: {
      inst: args.instanceId,
      proc_key: args.processKey,
      gateway_id: args.gatewayId,
      verdict: args.verdict,
      [TRANSITION_PAYLOAD_KEY]: transitionPayload,
    },
  };
}
