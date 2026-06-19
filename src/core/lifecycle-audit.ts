/**
 * src/core/lifecycle-audit.ts
 *
 * T-0068: PURE lifecycle → audit mapper (ADR §4.4/§4.5/§4.6). Projects a Flowable
 * instance lifecycle event into the canonical AuditEventInput shape (T-0031), with
 * a distinguishable actorType ∈ {human, agent, service} carried hash-covered in the
 * payload. IO-free, by the audit-grant-encoder.ts template.
 *
 * T-0332 (E15-S0b): emits the canonical TransitionPayload (transition-payload.ts)
 * under the TRANSITION_PAYLOAD_KEY inside audit_event.payload when tenantId +
 * processKey are supplied — making the §4 metrics queries form-neutral. See the
 * `transition` optional field on LifecycleAuditInput.
 *
 * DESIGN INVARIANTS (ADR §5 / FF-11):
 *  - No import from pg/http/https/net/fetch/child_process. IO-free.
 *  - AuditEventInput is imported from audit-grant-encoder.ts (T-0031) — NOT
 *    redefined. The lifecycle encoder is the second producer through the single
 *    canonical sink (appendAuditEvent), alongside the grant-trail encoder.
 *  - actorType lives in payload (preimage-covered) → tamper-detectable (AC-12).
 */

import { randomUUID } from "node:crypto";
import type { AuditEventInput } from "./audit-grant-encoder.js";
import type { OutboxRow } from "./outboxTypes.js";
import type { OnDispatched } from "./outboxDispatcher.js";
import type { AuditWriter, PgClientLike } from "../db/audit-writer.js";
import { buildTransitionPayload, TRANSITION_PAYLOAD_KEY } from "./transition-payload.js";

// ---------------------------------------------------------------------------
// ActorType + projection (FR-2 / §4.5). The discrimination axis is employee.kind
// (016: {human,agent}); 'service' is a CHANNEL (external-worker), not a new kind.
// ---------------------------------------------------------------------------

export type ActorType = "human" | "agent" | "service";

/** The channels a lifecycle actor may act under (drives agent↔service split). */
export type LifecycleChannel = "engine" | "external-worker" | "user-task" | "service";

/**
 * Pure projection employee.kind → actorType. 'human' from kind='human'. For
 * kind='agent': the external-worker / service channel ⇒ 'service' (bridge,
 * s-ledger, s-ocr, control-plane); the agent-runtime / user-task channel ⇒
 * 'agent'. The schema of `employee` is NOT changed (kind stays {human,agent}).
 */
export function projectActorType(
  kind: "human" | "agent",
  channel: LifecycleChannel,
): ActorType {
  if (kind === "human") return "human";
  return channel === "external-worker" || channel === "service" ? "service" : "agent";
}

// ---------------------------------------------------------------------------
// LifecycleAuditInput → AuditEventInput (ADR §4.4).
// ---------------------------------------------------------------------------

/**
 * T-0332 (E15-S0b): optional transition context carried by engine-path events so
 * `encodeLifecycleAuditEvent` can embed the canonical TransitionPayload under
 * TRANSITION_PAYLOAD_KEY. When present, ALL fields must be supplied by the caller
 * (makeAuditOnDispatched extracts them from the outbox row + resolved actor).
 *
 * `duration_ms` is null here because the engine path does not have wall-clock
 * duration at dispatch time — T-0335 fills it via the completeTask outbox in S1.
 */
export interface LifecycleTransitionContext {
  readonly tenantId: string;
  readonly processKey: string;
  /** null when the outbox row did not carry an instanceId. */
  readonly instanceId: string | null;
  /** BPMN activity / step name or event type used as the activity label. */
  readonly activity: string;
  /**
   * Duration in ms if available at call-site; null otherwise.
   * T-0335 fills this for the completeTask outbox path (S1).
   */
  readonly durationMs: number | null;
}

export type LifecycleAuditInput =
  | {
      kind: "instance.started";
      instanceId: string;
      processKey: string;
      actor: string;
      actorType: ActorType;
      via?: string | null;
      /** T-0332: optional transition context for TransitionPayload emission. */
      transition?: LifecycleTransitionContext;
    }
  | {
      kind: "task.completed";
      instanceId: string | null;
      jobId: string;
      actor: string;
      actorType: ActorType;
      via?: string | null;
      detail?: Record<string, unknown>;
      /** T-0332: optional transition context for TransitionPayload emission. */
      transition?: LifecycleTransitionContext;
    }
  | {
      kind: "task.failed";
      instanceId: string | null;
      jobId: string;
      actor: string;
      actorType: ActorType;
      via?: string | null;
      errorMessage?: string;
      /** T-0332: optional transition context for TransitionPayload emission. */
      transition?: LifecycleTransitionContext;
    };

/** Default channel per lifecycle kind (ADR §4.4 mapping). */
function defaultVia(e: LifecycleAuditInput): string {
  return e.kind === "instance.started" ? "engine" : "external-worker";
}

/**
 * Pure encoder: lifecycle event → AuditEventInput. `nowMs` supplied by caller
 * (Date.now() at call-site); `idOverride` for deterministic tests — exactly the
 * encodeGrantAuditEvent contract. The actorType is placed in payload, hash-covered.
 *
 * T-0332 (E15-S0b): when `e.transition` is present, embeds the canonical
 * TransitionPayload under TRANSITION_PAYLOAD_KEY inside the payload. This makes
 * §4 metric queries form-neutral: they can read `payload->>'transition_payload'`
 * regardless of which emit path produced the row.
 * `duration_ms` is null for all engine-path events until T-0335 fills it in S1.
 */
export function encodeLifecycleAuditEvent(
  e: LifecycleAuditInput,
  nowMs: number,
  idOverride?: string,
): AuditEventInput {
  const via = e.via ?? defaultVia(e);

  if (e.kind === "instance.started") {
    const payload: Record<string, unknown> = {
      actorType: e.actorType,
      instanceId: e.instanceId,
      processKey: e.processKey,
    };
    // T-0332: embed canonical transition payload when context is provided.
    if (e.transition) {
      payload[TRANSITION_PAYLOAD_KEY] = buildTransitionPayload({
        tenantId: e.transition.tenantId,
        instanceId: e.transition.instanceId,
        processKey: e.transition.processKey,
        activity: e.transition.activity,
        actor: e.actor,
        actorType: e.actorType,
        ts: nowMs,
        durationMs: e.transition.durationMs, // null — T-0335 fills via outbox (S1)
        verdict: "start",
      });
    }
    return {
      id: idOverride ?? randomUUID(),
      type: "instance.started",
      actor: e.actor,
      subject: e.instanceId,
      scope: null,
      via,
      proposed_by: null,
      confirmed_by: null,
      payload,
      occurred_at: nowMs,
    };
  }

  // task.completed | task.failed — instanceId is an OPAQUE pointer (may be null);
  // jobId (= outbox.aggregate_id, T-0067 reverse-map) is the durable ref.
  const payload: Record<string, unknown> = {
    actorType: e.actorType,
    instanceId: e.instanceId,
    aggregateId: e.jobId,
  };
  if (e.kind === "task.failed" && e.errorMessage !== undefined) {
    payload["errorMessage"] = e.errorMessage;
  }
  if (e.kind === "task.completed" && e.detail !== undefined) {
    payload["detail"] = e.detail;
  }

  // T-0332: embed canonical transition payload when context is provided.
  // verdict: "complete" for task.completed, "fail" for task.failed.
  // duration_ms: null here — T-0335 fills it via the completeTask outbox in S1.
  if (e.transition) {
    payload[TRANSITION_PAYLOAD_KEY] = buildTransitionPayload({
      tenantId: e.transition.tenantId,
      instanceId: e.transition.instanceId,
      processKey: e.transition.processKey,
      activity: e.transition.activity,
      actor: e.actor,
      actorType: e.actorType,
      ts: nowMs,
      durationMs: e.transition.durationMs, // null — T-0335 fills via outbox (S1)
      verdict: e.kind === "task.completed" ? "complete" : "fail",
    });
  }

  return {
    id: idOverride ?? randomUUID(),
    type: e.kind, // 'task.completed' | 'task.failed'
    actor: e.actor,
    subject: e.instanceId,
    scope: null,
    via,
    proposed_by: null,
    confirmed_by: null,
    payload,
    occurred_at: nowMs,
  };
}

// ---------------------------------------------------------------------------
// makeAuditOnDispatched — bridge of the T-0067 onDispatched seam (ADR §4.6).
//
// Returns an OnDispatched callback. T-0067 invokes it ONLY after a durable
// markDispatched (outboxDispatcher.ts `if (advanced)`), so exactly-once holds and
// no app-level dedup is needed (NF-4). For task_completed/task_failed it encodes
// and appends EXACTLY ONE row; for worker_lock_expired and any unknown eventType
// it is a NO-OP (0 appends) — anti-split-brain (FR-5/AC-9).
// ---------------------------------------------------------------------------

export interface AuditOnDispatchedDeps {
  writer: AuditWriter;
  /** Runs `fn` inside the caller's per-tenant transaction (GUC set). */
  withTenantTx: <T>(tenantId: string, fn: (tx: PgClientLike) => Promise<T>) => Promise<T>;
  /** Resolve the actor identity + projected actorType for an outbox row. */
  resolveActor: (row: OutboxRow) => Promise<{ actor: string; actorType: ActorType }>;
  /** Clock seam (defaults to Date.now). */
  now?: () => number;
}

/** Map an outbox eventType to a lifecycle audit kind, or null for no-op events. */
function lifecycleKindFor(eventType: string): "task.completed" | "task.failed" | null {
  if (eventType === "task_completed") return "task.completed";
  if (eventType === "task_failed") return "task.failed";
  // worker_lock_expired and any unknown type → no governance audit row.
  return null;
}

export function makeAuditOnDispatched(deps: AuditOnDispatchedDeps): OnDispatched {
  const now = deps.now ?? (() => Date.now());

  return async (row: OutboxRow): Promise<void> => {
    const kind = lifecycleKindFor(row.eventType);
    if (kind === null) return; // no-op: worker_lock_expired / unknown

    const { actor, actorType } = await deps.resolveActor(row);

    // instanceId pointer: best-effort from the outbox payload (opaque ref); null
    // when absent (the jobId/aggregateId still pins the row — §2.4).
    const instanceId =
      typeof row.payload["instanceId"] === "string"
        ? (row.payload["instanceId"] as string)
        : null;

    // T-0332 (E15-S0b): build the transition context for the canonical
    // TransitionPayload. processKey is best-effort from the outbox payload; falls
    // back to empty string when absent (prevents the field from being missing).
    // activity = the event type (e.g. "task_completed") — BPMN-level granularity is
    // not available at this outbox dispatch point (T-0335/S1 adds per-step detail).
    // duration_ms = null — T-0335 fills it via the completeTask outbox in S1.
    const processKey =
      typeof row.payload["processKey"] === "string"
        ? (row.payload["processKey"] as string)
        : "";

    const transition: LifecycleTransitionContext = {
      tenantId: row.tenantId,
      processKey,
      instanceId,
      activity: row.eventType,
      durationMs: null, // T-0335 fills via outbox (S1)
    };

    const input: LifecycleAuditInput =
      kind === "task.completed"
        ? {
            kind: "task.completed",
            instanceId,
            jobId: row.aggregateId,
            actor,
            actorType,
            transition,
          }
        : {
            kind: "task.failed",
            instanceId,
            jobId: row.aggregateId,
            actor,
            actorType,
            transition,
            ...(typeof row.payload["error"] === "string"
              ? { errorMessage: row.payload["error"] as string }
              : {}),
          };

    const event = encodeLifecycleAuditEvent(input, now());
    await deps.withTenantTx(row.tenantId, (tx) => deps.writer.appendAuditEvent(tx, event));
  };
}
