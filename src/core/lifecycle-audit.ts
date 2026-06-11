/**
 * src/core/lifecycle-audit.ts
 *
 * T-0068: PURE lifecycle → audit mapper (ADR §4.4/§4.5/§4.6). Projects a Flowable
 * instance lifecycle event into the canonical AuditEventInput shape (T-0031), with
 * a distinguishable actorType ∈ {human, agent, service} carried hash-covered in the
 * payload. IO-free, by the audit-grant-encoder.ts template.
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

export type LifecycleAuditInput =
  | {
      kind: "instance.started";
      instanceId: string;
      processKey: string;
      actor: string;
      actorType: ActorType;
      via?: string | null;
    }
  | {
      kind: "task.completed";
      instanceId: string | null;
      jobId: string;
      actor: string;
      actorType: ActorType;
      via?: string | null;
      detail?: Record<string, unknown>;
    }
  | {
      kind: "task.failed";
      instanceId: string | null;
      jobId: string;
      actor: string;
      actorType: ActorType;
      via?: string | null;
      errorMessage?: string;
    };

/** Default channel per lifecycle kind (ADR §4.4 mapping). */
function defaultVia(e: LifecycleAuditInput): string {
  return e.kind === "instance.started" ? "engine" : "external-worker";
}

/**
 * Pure encoder: lifecycle event → AuditEventInput. `nowMs` supplied by caller
 * (Date.now() at call-site); `idOverride` for deterministic tests — exactly the
 * encodeGrantAuditEvent contract. The actorType is placed in payload, hash-covered.
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

    const input: LifecycleAuditInput =
      kind === "task.completed"
        ? {
            kind: "task.completed",
            instanceId,
            jobId: row.aggregateId,
            actor,
            actorType,
          }
        : {
            kind: "task.failed",
            instanceId,
            jobId: row.aggregateId,
            actor,
            actorType,
            ...(typeof row.payload["error"] === "string"
              ? { errorMessage: row.payload["error"] as string }
              : {}),
          };

    const event = encodeLifecycleAuditEvent(input, now());
    await deps.withTenantTx(row.tenantId, (tx) => deps.writer.appendAuditEvent(tx, event));
  };
}
