/**
 * src/http/process-projection.ts — T-0282 (ADR T-0278 §D, §2.3 FROZEN seam A↔B↔D).
 *
 * The engine→screen projection. ADR §2.3 froze the contract: a started instance
 * becomes VISIBLE on the same processes/inbox screens through the EXISTING
 * append-only `audit_event` track — NOT a live-Flowable query (ADR rejected that as
 * disproportionate), and NOT a new table (D-061 / FF defer-no-new-table; the same
 * track that backs the T-0221 defer projection in deferred-inbox-store.ts).
 *
 * Two halves, one append-only track:
 *   WRITE (emission seam B↔D — see process-start.ts):
 *     - appendProcessStarted: on start, emit ONE audit_event(type='process.started')
 *       carrying the InstanceProjection seed + the waiting approver user-task (U4,
 *       candidateGroups → role-approver). Goes through the canonical writer
 *       (appendAuditEvent) inside the caller's tenant-scoped tx — never raw INSERT
 *       (audit_writer_isolation.sh: single write path is src/db/audit-writer.ts).
 *     - appendTaskApproved: on card-action approve, emit ONE
 *       audit_event(type='task.approved') that advances the instance to `done`.
 *   READ (projection — pure read, mirrors deferred-inbox-store.ts):
 *     - listInstanceProjections: fold started + approved events into
 *       InstanceProjection[] (inst, role, step, status running|waiting|done).
 *     - listInstanceInboxTasks: surface the waiting approver user-task as an inbox
 *       row addressed to the ROLE (candidateGroups → role), hidden once done.
 *
 * Why this module (not inline in processes.ts): FF-DISPLAY-4 / FF-7-3
 * (pack-serve-no-write.sh, start-route-isolation.sh) forbid src/http/processes.ts
 * from importing pg / src/db/*. The read-projection NEEDS pg. ADR §3 sanctions
 * extracting it into a dedicated module that processes.ts merely imports — keeping
 * processes.ts display-plane-pure while the GET merge reads runtime state.
 *
 * Tenant-scoping: the read path runs under withTenant (SET LOCAL choros.tenant_id)
 * with an explicit `WHERE tenant_id = $1` BYPASSRLS guard — exact copy of the
 * deferred-inbox-store.ts / audit-grant-trail.ts pattern. The write path runs inside
 * the caller's already-open tenant tx (the start tx in process-start.ts).
 */

import pg from "pg";
import { randomUUID } from "node:crypto";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import type { AuditEventInput } from "../core/audit-grant-encoder.js";
import {
  buildTransitionPayload,
  TRANSITION_PAYLOAD_KEY,
  projectActorType,
} from "../core/transition-payload.js";
import {
  validateEnvelope,
  correlateEnvelope,
  type MessageSubscription,
  type CorrelationResult,
} from "../core/message-correlation.js";

// ---------------------------------------------------------------------------
// Audit event types (free-text `type` column; no enum constraint — migrations/006).
// ---------------------------------------------------------------------------

/** Emitted once on start: seeds the instance projection + its waiting user-task. */
export const PROCESS_STARTED_TYPE = "process.started";
/** Emitted once on card-action approve: advances the instance to `done`. */
export const TASK_APPROVED_TYPE = "task.approved";
/**
 * T-0443: Emitted when the engine surfaces a NEW waiting user-task post-gateway
 * (e.g. task-extra-approve in the 6M branch). Carries task_def_key, proc_key,
 * task_role, task_step, task_name, inbox_task_id so the projection read can
 * surface the next pool task addressed to the right role.
 */
export const NEXT_TASK_TYPE = "process.next_task";

// ---------------------------------------------------------------------------
// T-0339 [E15-S3]: Canonical 6-event transition journal event-type constants.
// These are the types queried by the mat-view (migration 079) + cycle-time
// analytics. They are NOT replacement types — they are ADDITIONAL events emitted
// alongside the existing projection events for the transition journal.
// ---------------------------------------------------------------------------

/** F2/S3: emitted alongside process.started to seed the transition journal. */
export const INSTANCE_STARTED_TYPE = "instance.started";
/** F2/S3: emitted when a waiting user-task is created (pool task seeded). */
export const TASK_CREATED_TYPE = "task.created";
/** F2/S3: emitted when an instance fully ends (all steps done). */
export const INSTANCE_ENDED_TYPE = "instance.ended";
/**
 * F2/S3: emitted when a gateway is evaluated (S5 DMN wiring, T-0340).
 * Stub constant here so cycle-time queries + mat-view can reference the type
 * before S5 is wired. Actual emission is in src/core/gateway-journal.ts.
 */
export const GATEWAY_EVALUATED_TYPE = "gateway.evaluated";

// ---------------------------------------------------------------------------
// UUID guard — mirrors deferred-inbox-store.ts.
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// FROZEN projection contract (ADR §2.3): InstanceProjection + the waiting
// user-task fields (id, role, inst, step, status). These are the fields A (BPMN
// roles), B (start emission) and D (read/advance) all agree on.
// ---------------------------------------------------------------------------

/** Lifecycle status of a projected instance. */
export type InstanceStatus = "running" | "waiting" | "done";

/** The projected instance shape (ADR §2.3 InstanceProjection). */
export interface InstanceProjection {
  /** Flowable process-instance id (the engine truth this projection mirrors). */
  readonly inst: string;
  /** Process-definition key (e.g. "telLinear"). */
  readonly procKey: string;
  /** Role the current waiting user-task is addressed to (candidateGroups → role). */
  readonly role: string;
  /** Human-readable current step / node name. */
  readonly step: string;
  /** running | waiting | done. */
  readonly status: InstanceStatus;
  /** Epoch-ms the instance was started. */
  readonly startedAt: number;
  /**
   * The inbox task id that corresponds to this projection — equal to the
   * process.started audit_event.id (the self-referential inbox_task_id).
   * Used by the detail route to correlate a done projection to the requested
   * taskId instead of returning the first-done-wins arbitrary match.
   */
  readonly inboxTaskId: string;
  /**
   * T-0414 / T-0356: originating record id when this instance was started by an
   * on_create trigger. Absent (undefined) for instances started via the explicit
   * launch affordance (/api/processes/start). Surfaced on the wire so the e2e
   * acceptance spec can correlate a create=start instance back to the record that
   * triggered it without a separate query.
   */
  readonly recordId?: string;
  /**
   * T-0456 [D8-R1]: the CONCURRENT waiting steps of this instance — one entry per
   * currently-active user-task (an AND-split / parallelGateway leaves several tokens
   * active at once). For a single-token (linear) instance this is a 1-element array
   * equal to [step]; for a done instance it is empty. The process card renders this
   * to show all concurrent branches instead of a single "current node".
   *
   * Always present (length ≥ 0). `step` remains the primary/first step for
   * backward compatibility with callers that only show one node.
   */
  readonly concurrentSteps: readonly string[];
}

/** The waiting user-task surfaced to inbox, addressed to a ROLE (not a person). */
export interface InstanceInboxTask {
  /** Stable task id (== the process.started audit_event.id). */
  readonly id: string;
  /** Role the task is addressed to (candidateGroups → role). */
  readonly role: string;
  /** Human-readable task name. */
  readonly name: string;
  /** Step / node context. */
  readonly step: string;
  /** Flowable instance id the task belongs to. */
  readonly inst: string;
  /** Process-definition key. */
  readonly procKey: string;
  /** Epoch-ms the task became available. */
  readonly occurredAt: number;
  /**
   * T-0443: BPMN task definition key for the engine user-task this inbox row maps to.
   * Base process.started rows default to "task-approve"; process.next_task rows carry
   * their own defKey (e.g. "task-extra-approve" for the 6M branch).
   * Used by the approve handler to complete the RIGHT engine task instead of always
   * targeting the hardcoded "task-approve" defKey.
   */
  readonly taskDefKey: string;
  /**
   * T-0458 [D8-R3]: true when this waiting task was surfaced by a TIMER FIRING
   * (a boundary/intermediate deadline elapsed → Flowable routed the token to the
   * escalation user-task). Drives the inbox «Эскалации» tab and the escalation
   * styling without client-side string-matching. Set on the process.next_task row
   * the timer-firing reconcile emits (reconcileInstanceTimers); false/absent for
   * ordinary post-gateway next-tasks.
   */
  readonly escalated?: boolean;
  /**
   * T-0458 [D8-R3] / F5: the pre-fill reason for the escalation form (e.g.
   * «Истёк срок согласования»). Surfaced so the escalation inbox row opens a
   * PRE-FILLED form rather than a blank one (spec §3.4). Absent for non-escalation
   * tasks.
   */
  readonly doubtReason?: string;
  /**
   * T-0459 [D8-R4]: true when this waiting row represents an instance PARKED ON A
   * MESSAGE-CATCH (receiveTask / intermediateCatchEvent(message|signal)) — it is
   * WAITING for a correlated message to arrive, not for a human decision. Drives the
   * process card / inbox to render «Ожидает сообщения» instead of an actionable
   * approve button, and is cleared (the row dropped) once the catch fires. Set on the
   * process.next_task row the message-wait reconcile emits; absent for ordinary tasks.
   */
  readonly messageCatch?: boolean;
  /**
   * T-0459 [D8-R4]: the message/signal name this catch is waiting for (surfaced for
   * the card label «Ожидает: <messageName>»). Present only on messageCatch rows.
   */
  readonly messageName?: string;
}

// ---------------------------------------------------------------------------
// Defaults — the canonical linear ТЭЛ U4 approval task (BPMN task-approve,
// candidateGroups="role-approver"). The projection seeds these so a started
// telLinear instance surfaces its waiting approval task to the approver role.
// ---------------------------------------------------------------------------

/** candidateGroups of the U4 approval user-task (tel-linear.bpmn20.xml). */
export const APPROVER_ROLE = "role-approver";
/** Step/node label of the U4 approval user-task. */
export const APPROVE_STEP = "Согласование";
/** Display name of the U4 approval inbox task. */
export const APPROVE_TASK_NAME = "Согласовать заявку";

// ---------------------------------------------------------------------------
// WRITE half — emission seam (called from process-start.ts on start, and from
// the inbox approve card-action handler on approve). Both go through the single
// canonical audit writer (appendAuditEvent), never raw INSERT.
// ---------------------------------------------------------------------------

const writer = makePgAuditWriter();

/**
 * Emit the `process.started` projection event for a freshly started instance.
 *
 * Runs INSIDE the caller's already-open tenant-scoped tx (process-start.ts's
 * withTenantTx, SET LOCAL choros.tenant_id + FORCE RLS) so the projection write is
 * scoped to the actor's tenant in the SAME transaction as the engine start
 * (caller ROLLBACK undoes both). Returns the minted task id (== audit_event.id)
 * that addresses the waiting approval user-task.
 *
 * The payload carries the InstanceProjection seed + the waiting U4 user-task fields
 * so the read projection can fold a single event into both the processes list and
 * the inbox pool task (ADR §2.3).
 */
export async function appendProcessStarted(
  tx: PgClientLike,
  args: {
    readonly instanceId: string;
    readonly procKey: string;
    readonly actor: string;
    readonly nowMs: number;
    /** Role the waiting user-task is addressed to; defaults to the U4 approver role. */
    readonly approverRole?: string;
    /** Step/node label of the waiting user-task; defaults to APPROVE_STEP. */
    readonly step?: string;
    /** Display name of the waiting inbox task; defaults to APPROVE_TASK_NAME. */
    readonly taskName?: string;
    /**
     * T-0339 (E15-S3): tenant id for transition-journal events (instance.started +
     * task.created). Optional for backward-compat; when absent the transition_payload
     * is omitted from the journal events (pre-S3 callers).
     */
    readonly tenantId?: string;
    /**
     * T-0356 (E16): the originating record id when this process was started by an
     * on_create trigger (create = start). Persisted into the process.started payload
     * as `record_id` so the resolver can later expose it as primaryRecordId, letting
     * the step-applier write the real «Заявки» record id into cross_app_ref instead
     * of the instanceId placeholder. Optional — callers that start a process outside
     * the record-create path (process-start.ts) simply omit it.
     */
    readonly recordId?: string;
  },
): Promise<string> {
  const taskId = randomUUID();
  const role = args.approverRole ?? APPROVER_ROLE;
  const step = args.step ?? APPROVE_STEP;
  const taskName = args.taskName ?? APPROVE_TASK_NAME;

  // --- 1. process.started (projection seed — FROZEN shape, must not change) ---
  const input: AuditEventInput = {
    id: taskId,
    type: PROCESS_STARTED_TYPE,
    actor: args.actor,
    subject: `instance:${args.instanceId}`,
    scope: { proc_key: args.procKey },
    via: "process-start",
    proposed_by: null,
    confirmed_by: null,
    payload: {
      inst: args.instanceId,
      proc_key: args.procKey,
      // The waiting user-task (U4 approval, candidateGroups → role) the inbox
      // projection surfaces to the approver role pool (ADR §2.3 / AC-3).
      task_role: role,
      task_step: step,
      task_name: taskName,
      inbox_task_id: taskId, // self-referential back-link (mirrors T-0221 FF-3).
      // T-0356 (E16): originating record id from the on_create trigger path.
      // Absent when the process was started via the explicit launch affordance.
      ...(args.recordId !== undefined ? { record_id: args.recordId } : {}),
    },
    occurred_at: args.nowMs,
  };
  await writer.appendAuditEvent(tx, input);

  // --- 2. T-0339 (E15-S3): emit instance.started + task.created for the
  //    transition journal (F2 Phase 1). Only when tenantId is supplied (S3 callers).
  //    These are ADDITIVE events; the process.started projection above is unchanged.
  if (args.tenantId) {
    const actorType = projectActorType("human", "user-task"); // process start = human actor

    // instance.started — lifecycle start of the process instance
    await writer.appendAuditEvent(tx, {
      id: randomUUID(),
      type: INSTANCE_STARTED_TYPE,
      actor: args.actor,
      subject: `instance:${args.instanceId}`,
      scope: { proc_key: args.procKey },
      via: "process-start",
      proposed_by: null,
      confirmed_by: null,
      payload: {
        inst: args.instanceId,
        proc_key: args.procKey,
        [TRANSITION_PAYLOAD_KEY]: buildTransitionPayload({
          tenantId: args.tenantId,
          instanceId: args.instanceId,
          processKey: args.procKey,
          activity: INSTANCE_STARTED_TYPE,
          actor: args.actor,
          actorType,
          ts: args.nowMs,
          durationMs: null,
          verdict: "start",
        }),
      },
      occurred_at: args.nowMs,
    });

    // task.created — the waiting user-task seeded for the first step
    await writer.appendAuditEvent(tx, {
      id: randomUUID(),
      type: TASK_CREATED_TYPE,
      actor: args.actor,
      subject: `task:${taskId}`,
      scope: { proc_key: args.procKey, task_id: taskId, role },
      via: "process-start",
      proposed_by: null,
      confirmed_by: null,
      payload: {
        task_id: taskId,
        inst: args.instanceId,
        proc_key: args.procKey,
        role,
        step,
        task_name: taskName,
        [TRANSITION_PAYLOAD_KEY]: buildTransitionPayload({
          tenantId: args.tenantId,
          instanceId: args.instanceId,
          processKey: args.procKey,
          activity: TASK_CREATED_TYPE,
          actor: args.actor,
          actorType,
          ts: args.nowMs,
          durationMs: null,
          verdict: "created",
        }),
      },
      occurred_at: args.nowMs,
    });
  }

  return taskId;
}

/**
 * Emit the `task.approved` projection event that advances the instance to `done`
 * (ADR §2.3 / AC-5 / AC-6). Runs inside the caller's tenant-scoped tx so the audit
 * write is atomic with the decision. `taskId` is the approved inbox task id (==
 * the process.started event id); `instanceId` is the Flowable instance it advances.
 *
 * T-0332 (E15-S0b): embeds the canonical TransitionPayload under
 * TRANSITION_PAYLOAD_KEY in the payload. actor_type = "human" (the approve path
 * is always a human user-task; projectActorType("human", "user-task") = "human").
 * tenantId is optional for backward compat; when absent, the TransitionPayload
 * tenant_id is set to "" (metrics queries filter by tenant independently).
 *
 * T-0335 (E15-S1b): `durationMs` is now threaded in from the approve handler
 * (nowMs - task.occurredAt) instead of being hard-coded null. Optional for
 * backward-compat (callers without a duration pass nothing → null, preserving the
 * T-0332 contract); the approve route always supplies it now so the
 * transition_payload.duration_ms is a positive int.
 */
export async function appendTaskApproved(
  tx: PgClientLike,
  args: {
    readonly taskId: string;
    readonly instanceId: string;
    readonly procKey: string;
    readonly actor: string;
    readonly nowMs: number;
    /**
     * T-0332: tenant id for the canonical TransitionPayload.
     * Pass the resolved tenantId (already available at the call-site in inbox.ts).
     * Optional for backward-compat; defaults to "" if not supplied.
     */
    readonly tenantId?: string;
    /**
     * T-0335: wall-clock task duration in ms, computed once in the approve handler
     * (nowMs - process.started occurred_at). Optional for backward-compat — absent
     * ⇒ null (the pre-T-0335 behaviour).
     */
    readonly durationMs?: number | null;
  },
): Promise<void> {
  // T-0332: actor_type for human approve path is always "human" (user-task channel).
  // projectActorType is imported from transition-payload.ts which re-exports it from
  // lifecycle-audit.ts — single derivation source, no parallel logic.
  const actorType = projectActorType("human", "user-task"); // = "human"

  const input: AuditEventInput = {
    id: randomUUID(),
    type: TASK_APPROVED_TYPE,
    actor: args.actor,
    subject: `instance:${args.instanceId}`,
    scope: { proc_key: args.procKey },
    via: "inbox-approve",
    proposed_by: null,
    confirmed_by: args.actor,
    payload: {
      inst: args.instanceId,
      proc_key: args.procKey,
      // Back-link to the approved waiting task so the read fold can match it.
      inbox_task_id: args.taskId,
      transition: "approve",
      // The post-transition target node (linear ТЭЛ: approve → end → done).
      to_status: "done",
      // T-0332: canonical TransitionPayload — same shape as the engine path,
      // form-neutral. duration_ms = null (not available here; T-0335 fills in S1).
      [TRANSITION_PAYLOAD_KEY]: buildTransitionPayload({
        tenantId: args.tenantId ?? "",
        instanceId: args.instanceId,
        processKey: args.procKey,
        activity: TASK_APPROVED_TYPE,
        actor: args.actor,
        actorType,
        ts: args.nowMs,
        // T-0335: real wall-clock duration threaded from the approve handler
        // (nowMs - task.occurredAt). Defaults to null for legacy callers.
        durationMs: args.durationMs ?? null,
        verdict: "approve",
      }),
    },
    occurred_at: args.nowMs,
  };

  await writer.appendAuditEvent(tx, input);

  // T-0443: instance.ended is NO LONGER emitted unconditionally here.
  // It is emitted from the inbox approve handler AFTER the engine confirms
  // (isInstanceEnded) so that a 2-step approval (task-approve → gateway →
  // task-extra-approve) does NOT falsely signal instance done.
  // Callers that want the engine-gated done signal must call appendInstanceEnded.
}

/**
 * T-0443: Standalone `instance.ended` emitter — called by the inbox approve
 * handler AFTER the engine confirms the instance has ended (isInstanceEnded).
 * Separated from appendTaskApproved so a 2-step process doesn't falsely end.
 *
 * Runs INSIDE the caller's already-open tenant-scoped tx (same pattern as
 * appendTaskApproved — atomic with any surrounding audit writes).
 */
export async function appendInstanceEnded(
  tx: PgClientLike,
  args: {
    readonly taskId: string;
    readonly instanceId: string;
    readonly procKey: string;
    readonly actor: string;
    readonly nowMs: number;
    readonly tenantId: string;
  },
): Promise<void> {
  const actorType = projectActorType("human", "user-task");
  await writer.appendAuditEvent(tx, {
    id: randomUUID(),
    type: INSTANCE_ENDED_TYPE,
    actor: args.actor,
    subject: `instance:${args.instanceId}`,
    scope: { proc_key: args.procKey },
    via: "inbox-approve",
    proposed_by: null,
    confirmed_by: args.actor,
    payload: {
      inst: args.instanceId,
      proc_key: args.procKey,
      inbox_task_id: args.taskId,
      [TRANSITION_PAYLOAD_KEY]: buildTransitionPayload({
        tenantId: args.tenantId,
        instanceId: args.instanceId,
        processKey: args.procKey,
        activity: INSTANCE_ENDED_TYPE,
        actor: args.actor,
        actorType,
        ts: args.nowMs,
        durationMs: null,
        verdict: "end",
      }),
    },
    occurred_at: args.nowMs,
  });
}

/**
 * T-0443: Emit a `process.next_task` event when the engine surfaces a new
 * waiting user-task post-gateway (e.g. task-extra-approve in the 6M branch).
 *
 * The payload carries task_def_key, proc_key, task_role, task_step, task_name,
 * inbox_task_id (a fresh UUID) so the projection read can surface the next
 * pool task addressed to the right role without any new DB tables.
 *
 * Runs OUTSIDE any TX (called after the approve tx committed — best-effort,
 * non-fatal on failure). Uses a standalone pool connection.
 */
export async function appendNextTaskEvent(
  pool: pg.Pool,
  tenantId: string,
  args: {
    readonly instanceId: string;
    readonly procKey: string;
    readonly actor: string;
    readonly nowMs: number;
    readonly taskDefKey: string;
    readonly taskName: string;
    readonly taskRole: string;
    readonly taskStep: string;
    /** New inbox task id for the next waiting task (fresh UUID from caller). */
    readonly inboxTaskId: string;
    /**
     * T-0458 [D8-R3]: when true, this next_task is an ESCALATION surfaced by a
     * timer firing. Marks the row as escalated so the inbox «Эскалации» tab and
     * styling pick it up. Optional — ordinary post-gateway next-tasks omit it.
     */
    readonly escalated?: boolean;
    /**
     * T-0458 [D8-R3] / F5: pre-fill reason for the escalation form (e.g. «Истёк
     * срок согласования»). Surfaced so the escalation row opens a pre-filled form.
     */
    readonly doubtReason?: string;
    /**
     * T-0458 [D8-R3]: the `via` provenance for the audit event. Defaults to
     * "inbox-approve" (the T-0443 post-approve reconcile). The timer-firing
     * reconcile passes "timer-fire" so the provenance is honest.
     */
    readonly via?: string;
    /**
     * T-0459 [D8-R4]: mark this next_task as a MESSAGE-CATCH WAIT (the instance is
     * parked waiting for a correlated message). The message-wait reconcile sets this
     * so the inbox/card renders «Ожидает сообщения» instead of an approve button.
     */
    readonly messageCatch?: boolean;
    /**
     * T-0459 [D8-R4]: the message/signal name a messageCatch row is waiting for.
     */
    readonly messageName?: string;
  },
): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    await writer.appendAuditEvent(client as unknown as PgClientLike, {
      id: args.inboxTaskId,
      type: NEXT_TASK_TYPE,
      actor: args.actor,
      subject: `instance:${args.instanceId}`,
      scope: { proc_key: args.procKey },
      via: args.via ?? "inbox-approve",
      proposed_by: null,
      confirmed_by: null,
      payload: {
        inst: args.instanceId,
        proc_key: args.procKey,
        task_def_key: args.taskDefKey,
        task_role: args.taskRole,
        task_step: args.taskStep,
        task_name: args.taskName,
        inbox_task_id: args.inboxTaskId,
        // T-0458 [D8-R3]: escalation provenance (timer firing) + F5 prefill reason.
        ...(args.escalated ? { escalated: true } : {}),
        ...(args.doubtReason ? { doubt_reason: args.doubtReason } : {}),
        // T-0459 [D8-R4]: message-catch wait provenance + the awaited message name.
        ...(args.messageCatch ? { message_catch: true } : {}),
        ...(args.messageName ? { message_name: args.messageName } : {}),
      },
      occurred_at: args.nowMs,
    });
  });
}

// ---------------------------------------------------------------------------
// READ half — projection. Mirrors deferred-inbox-store.ts withTenant pattern.
// Reads ONLY choros.audit_event (process.started + task.approved). NO writes here.
// ---------------------------------------------------------------------------

async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuid(tenantId, "tenantId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

interface StartedRow {
  id: string;
  actor: string;
  payload: Record<string, unknown>;
  occurred_at: number;
}

interface NextTaskRow {
  id: string;
  payload: Record<string, unknown>;
  occurred_at: number;
}

/**
 * T-0443: Read the raw started + ended + next_task events for a tenant.
 *
 * done fold (T-0443): instance is `done` IFF an `instance.ended` event exists
 * whose payload.inst matches the started instance. This is engine-gated — the
 * ended event is emitted ONLY when isInstanceEnded() confirms, preventing false
 * done on multi-step (6M) gateway branches.
 *
 * next_task fold: `process.next_task` events surface additional pool tasks
 * for post-gateway waiting steps (e.g. task-extra-approve on 6M branch).
 * A next_task row is hidden once any started instance referencing it is ended.
 *
 * backward-compat: still also reads task.approved for listInstanceInboxTasks
 * filtering (a task.approved without a following instance.ended means the 6M
 * branch is now active — the base task is done but the instance is not).
 */
async function readEvents(
  pool: pg.Pool,
  tenantId: string,
  limit: number,
): Promise<{
  started: StartedRow[];
  endedInstanceIds: Set<string>;
  approvedTaskIds: Set<string>;
  nextTaskRows: NextTaskRow[];
}> {
  return withTenant(pool, tenantId, async (client) => {
    const startedRes = await client.query<StartedRow>(
      `SELECT id, actor, payload, occurred_at::float8 AS occurred_at
         FROM choros.audit_event
        WHERE type = $1
          AND tenant_id = $2
        ORDER BY occurred_at ASC
        LIMIT $3`,
      [PROCESS_STARTED_TYPE, tenantId, limit],
    );

    // T-0443: instance.ended → engine-gated done signal.
    const endedRes = await client.query<{ payload: Record<string, unknown> }>(
      `SELECT payload
         FROM choros.audit_event
        WHERE type = $1
          AND tenant_id = $2
        ORDER BY occurred_at ASC
        LIMIT $3`,
      [INSTANCE_ENDED_TYPE, tenantId, limit],
    );

    // task.approved: kept for the listInstanceInboxTasks "hide base task after approve" logic.
    const approvedRes = await client.query<{ payload: Record<string, unknown> }>(
      `SELECT payload
         FROM choros.audit_event
        WHERE type = $1
          AND tenant_id = $2
        ORDER BY occurred_at ASC
        LIMIT $3`,
      [TASK_APPROVED_TYPE, tenantId, limit],
    );

    // T-0443: process.next_task → post-gateway waiting task surfaced to inbox.
    const nextTaskRes = await client.query<NextTaskRow>(
      `SELECT id, payload, occurred_at::float8 AS occurred_at
         FROM choros.audit_event
        WHERE type = $1
          AND tenant_id = $2
        ORDER BY occurred_at ASC
        LIMIT $3`,
      [NEXT_TASK_TYPE, tenantId, limit],
    );

    const endedInstanceIds = new Set<string>();
    for (const r of endedRes.rows) {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      const inst = p["inst"];
      if (typeof inst === "string" && inst.length > 0) endedInstanceIds.add(inst);
    }

    const approvedTaskIds = new Set<string>();
    for (const r of approvedRes.rows) {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      const tid = p["inbox_task_id"];
      if (typeof tid === "string" && tid.length > 0) approvedTaskIds.add(tid);
    }

    return {
      started: startedRes.rows,
      endedInstanceIds,
      approvedTaskIds,
      nextTaskRows: nextTaskRes.rows,
    };
  });
}

function strField(payload: Record<string, unknown>, key: string, fallback: string): string {
  const v = payload[key];
  return typeof v === "string" && v.trim() !== "" ? v : fallback;
}

/**
 * Fold the audit track into InstanceProjection[].
 *
 * T-0443: A started instance is `done` IFF an `instance.ended` event exists
 * for its instance id — engine-gated, prevents false-done on 6M gateway branch.
 * Until then, it is `waiting` (its user-task awaits a human action).
 *
 * Backward-compat: for instances approved before T-0443 was deployed (no
 * `instance.ended` event recorded), the approvedTaskIds fallback ensures they
 * show as `done` rather than stuck in `waiting`.
 */
export async function listInstanceProjections(
  pool: pg.Pool,
  tenantId: string,
  opts?: { limit?: number },
): Promise<InstanceProjection[]> {
  const limit = Math.min(opts?.limit ?? 200, 500);
  const { started, endedInstanceIds, approvedTaskIds, nextTaskRows } = await readEvents(pool, tenantId, limit);

  // T-0443 Fix D: compute which instances have a PENDING (unapproved) next_task.
  // The backward-compat fallback (approvedTaskIds.has(row.id)) must NOT fire while
  // task-extra-approve is still waiting — that would falsely mark the 6M instance done.
  // A next_task is pending when its row.id is NOT yet in approvedTaskIds.
  const pendingNextTaskInstanceIds = new Set<string>();
  // T-0456 [D8-R1]: collect the CONCURRENT waiting steps per instance from pending
  // next_task rows. Multiple pending next_task rows for one instance = an AND-split's
  // concurrent branches. Keyed by instance id → ordered list of step labels.
  const concurrentNextStepsByInst = new Map<string, string[]>();
  for (const ntRow of nextTaskRows) {
    if (!approvedTaskIds.has(ntRow.id)) {
      const p = (ntRow.payload ?? {}) as Record<string, unknown>;
      const ntInst = p["inst"];
      if (typeof ntInst === "string" && ntInst.length > 0) {
        pendingNextTaskInstanceIds.add(ntInst);
        const stepLabel = strField(p, "task_step", APPROVE_STEP);
        const arr = concurrentNextStepsByInst.get(ntInst);
        if (arr === undefined) {
          concurrentNextStepsByInst.set(ntInst, [stepLabel]);
        } else if (!arr.includes(stepLabel)) {
          arr.push(stepLabel);
        }
      }
    }
  }

  return started.map((row): InstanceProjection => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const inst = strField(payload, "inst", `instance:${row.id}`);
    const procKey = strField(payload, "proc_key", "telLinear");
    const role = strField(payload, "task_role", APPROVER_ROLE);
    const step = strField(payload, "task_step", APPROVE_STEP);
    // T-0443: done IFF engine-gated instance.ended event exists for this instance.
    // Backward-compat fallback: task.approved exists (pre-T-0443 rows with no instance.ended)
    // BUT only when there is no pending next_task — a pending next_task means the 6M branch
    // is active and the instance is genuinely still waiting (Fix D).
    const done =
      endedInstanceIds.has(inst) ||
      (approvedTaskIds.has(row.id) && !pendingNextTaskInstanceIds.has(inst));
    // T-0414 / T-0356: read originating record_id (present when started via on_create).
    const rawRecordId = payload["record_id"];
    const recordId = typeof rawRecordId === "string" && rawRecordId ? rawRecordId : undefined;
    // T-0456 [D8-R1]: assemble the concurrent waiting steps. The base process.started
    // step is waiting until its own task.approved arrives (approvedTaskIds.has(row.id));
    // pending next_task rows add the post-split concurrent branches. A done instance
    // has no waiting steps.
    const concurrentSteps: string[] = [];
    if (!done) {
      const baseApproved = approvedTaskIds.has(row.id);
      if (!baseApproved) concurrentSteps.push(step);
      for (const ntStep of concurrentNextStepsByInst.get(inst) ?? []) {
        if (!concurrentSteps.includes(ntStep)) concurrentSteps.push(ntStep);
      }
      // Defensive: a waiting instance should always show at least its primary step.
      if (concurrentSteps.length === 0) concurrentSteps.push(step);
    }
    return {
      inst,
      procKey,
      role,
      step: done ? "Завершено" : step,
      status: done ? "done" : "waiting",
      startedAt: row.occurred_at,
      // row.id == process.started event id == inbox_task_id (self-referential back-link).
      // Surfaces on the projection so callers can correlate by taskId without a separate lookup.
      inboxTaskId: row.id,
      concurrentSteps,
      ...(recordId !== undefined ? { recordId } : {}),
    };
  });
}

/**
 * Project the WAITING user-tasks of started instances into inbox rows, addressed
 * to the ROLE (candidateGroups → role), NOT to a person (ADR §2.3 / AC-3). A task
 * whose instance is `done` (engine-gated instance.ended event) is dropped.
 *
 * T-0443: Also surfaces `process.next_task` rows for post-gateway waiting tasks
 * (e.g. task-extra-approve on the 6M branch). A next_task row is hidden once
 * the instance has ended (endedInstanceIds check).
 *
 * Base task (process.started) is hidden once task.approved exists for it — the
 * base approve step is done regardless of whether the instance itself ended
 * (the 6M extra-approve step is then exposed via process.next_task).
 */
export async function listInstanceInboxTasks(
  pool: pg.Pool,
  tenantId: string,
  opts?: { limit?: number },
): Promise<InstanceInboxTask[]> {
  const limit = Math.min(opts?.limit ?? 200, 500);
  const { started, endedInstanceIds, approvedTaskIds, nextTaskRows } = await readEvents(pool, tenantId, limit);

  const tasks: InstanceInboxTask[] = [];

  // 1. Base process.started rows (hide once approved OR instance ended).
  for (const row of started) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const inst = strField(payload, "inst", `instance:${row.id}`);
    if (approvedTaskIds.has(row.id)) continue; // base approve done → hide base task.
    if (endedInstanceIds.has(inst)) continue; // instance ended → no more tasks.
    tasks.push({
      id: row.id,
      role: strField(payload, "task_role", APPROVER_ROLE),
      name: strField(payload, "task_name", APPROVE_TASK_NAME),
      step: strField(payload, "task_step", APPROVE_STEP),
      inst,
      procKey: strField(payload, "proc_key", "telLinear"),
      occurredAt: row.occurred_at,
      // T-0443: base process.started rows always map to the primary approve BPMN task.
      taskDefKey: "task-approve",
    });
  }

  // 2. T-0443: process.next_task rows (post-gateway waiting steps).
  // Hide once the instance has ended or if the next_task itself was approved.
  for (const row of nextTaskRows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const inst = strField(payload, "inst", "");
    if (!inst) continue;
    if (endedInstanceIds.has(inst)) continue; // instance ended → no more tasks.
    if (approvedTaskIds.has(row.id)) continue; // this next_task was approved → hide.
    // T-0458 [D8-R3]: surface escalation provenance + F5 prefill reason from the payload.
    const isEscalated = payload["escalated"] === true;
    const doubtReason = typeof payload["doubt_reason"] === "string" && payload["doubt_reason"]
      ? (payload["doubt_reason"] as string)
      : undefined;
    // T-0459 [D8-R4]: surface message-catch wait provenance + awaited message name.
    const isMessageCatch = payload["message_catch"] === true;
    const messageName = typeof payload["message_name"] === "string" && payload["message_name"]
      ? (payload["message_name"] as string)
      : undefined;
    tasks.push({
      id: row.id,
      role: strField(payload, "task_role", APPROVER_ROLE),
      name: strField(payload, "task_name", APPROVE_TASK_NAME),
      step: strField(payload, "task_step", APPROVE_STEP),
      inst,
      procKey: strField(payload, "proc_key", "telLinear"),
      occurredAt: row.occurred_at,
      // T-0443 Fix A: process.next_task payload carries task_def_key set by the engine-drive
      // handler (appendNextTaskEvent writes it). Use it so the approve handler can complete
      // the RIGHT engine user-task (e.g. "task-extra-approve" on the 6M branch).
      taskDefKey: strField(payload, "task_def_key", "task-approve"),
      ...(isEscalated ? { escalated: true } : {}),
      ...(doubtReason ? { doubtReason } : {}),
      ...(isMessageCatch ? { messageCatch: true } : {}),
      ...(messageName ? { messageName } : {}),
    });
  }

  return tasks;
}

/**
 * Look up a single waiting instance-task by its id within a tenant (for the approve
 * card-action precondition: the task must exist, be waiting — not yet approved — and
 * be addressed to a role). Returns null when absent or already approved.
 */
export async function findWaitingInstanceTask(
  pool: pg.Pool,
  tenantId: string,
  taskId: string,
): Promise<InstanceInboxTask | null> {
  const tasks = await listInstanceInboxTasks(pool, tenantId);
  return tasks.find((t) => t.id === taskId) ?? null;
}

// ---------------------------------------------------------------------------
// T-0458 [D8-R3]: timer-firing projection (reconcile-on-read).
// ---------------------------------------------------------------------------

/** Minimal engine-task shape — a structural subset of FlowableClient's ActiveUserTask
 * so this projection module stays decoupled from the engine client type. */
export interface ActiveEngineTask {
  readonly id: string;
  readonly taskDefinitionKey: string;
  readonly name: string;
  readonly candidateGroups: readonly string[];
}

/** Minimal engine port the timer reconcile needs (a subset of FlowableClient). */
export interface TimerReconcileEnginePort {
  getActiveUserTasks(
    instanceId: string,
  ): Promise<
    | { ok: true; tasks: ActiveEngineTask[] }
    | { ok: false; code: string }
  >;
}

/**
 * F5 default pre-fill reason for a timer-fired escalation form. The deadline
 * elapsed, so the escalation reviewer opens a form pre-filled with this reason.
 */
export const TIMER_ESCALATION_REASON = "Истёк срок шага — эскалация по таймеру";

/**
 * Timer-firing projection. For each WAITING instance, compare the live engine
 * user-task set against what the audit-event projection already surfaces. A
 * boundary/intermediate TIMER that fired in Flowable routes the token to the
 * escalation user-task, which becomes a NEW active engine task. Any such task that
 * is not yet projected is surfaced as a `process.next_task(escalated)` row — the
 * firing projection — addressed to the escalation role (the candidateGroups the
 * timer-escalation mapper stamped) with an F5 pre-fill reason.
 *
 * This is the read-side analogue of the post-approve engine-drive reconcile in
 * inbox.ts (T-0443/T-0456). A timer fires WITHOUT a human action, so the firing
 * cannot be projected on the approve path; it is reconciled when the inbox/processes
 * screen is read (the natural moment a user would see the escalation appear).
 *
 * Best-effort + idempotent: a task already projected (base, prior next_task, or a
 * prior timer-fire emission) is NOT re-emitted (dedup by defKey per instance). Engine
 * failures degrade silently (the projection is never a hard dependency of the read).
 *
 * @returns the number of escalation rows emitted (0 when nothing fired / nothing new).
 */
export async function reconcileInstanceTimers(
  pool: pg.Pool,
  tenantId: string,
  engine: TimerReconcileEnginePort,
  opts?: { nowMs?: number; actor?: string; limit?: number },
): Promise<number> {
  const nowMs = opts?.nowMs ?? Date.now();
  const actor = opts?.actor ?? "system:timer";

  // Read current projection state once: which instances are waiting, and which
  // defKeys are already surfaced per instance (to dedup re-emission).
  let projections: InstanceProjection[];
  let projectedTasks: InstanceInboxTask[];
  try {
    projections = await listInstanceProjections(pool, tenantId, { limit: opts?.limit });
    projectedTasks = await listInstanceInboxTasks(pool, tenantId);
  } catch {
    return 0; // read-projection — degrade silently.
  }

  const waitingInstanceIds = projections
    .filter((p) => p.status !== "done")
    .map((p) => p.inst);
  if (waitingInstanceIds.length === 0) return 0;

  // defKeys already projected per instance (base + next_task rows).
  const projectedDefKeysByInst = new Map<string, Set<string>>();
  for (const t of projectedTasks) {
    let set = projectedDefKeysByInst.get(t.inst);
    if (set === undefined) {
      set = new Set<string>();
      projectedDefKeysByInst.set(t.inst, set);
    }
    set.add(t.taskDefKey);
  }
  // procKey per instance (for the emitted event scope).
  const procKeyByInst = new Map<string, string>();
  for (const p of projections) procKeyByInst.set(p.inst, p.procKey);

  let emitted = 0;

  for (const inst of waitingInstanceIds) {
    let engineResult;
    try {
      engineResult = await engine.getActiveUserTasks(inst);
    } catch {
      continue; // engine hiccup for this instance — skip, try others.
    }
    if (!engineResult.ok || engineResult.tasks.length === 0) continue;

    const projectedDefKeys = projectedDefKeysByInst.get(inst) ?? new Set<string>();
    const emittedThisPass = new Set<string>();

    for (const engineTask of engineResult.tasks) {
      const defKey = engineTask.taskDefinitionKey;
      if (projectedDefKeys.has(defKey)) continue; // already on screen.
      if (emittedThisPass.has(defKey)) continue; // dedup within this pass.
      emittedThisPass.add(defKey);

      const role = engineTask.candidateGroups[0] ?? APPROVER_ROLE;
      const procKey = procKeyByInst.get(inst) ?? "telLinear";
      const taskName = engineTask.name || APPROVE_TASK_NAME;

      try {
        await appendNextTaskEvent(pool, tenantId, {
          instanceId: inst,
          procKey,
          actor,
          nowMs,
          taskDefKey: defKey,
          taskName,
          taskRole: role,
          taskStep: taskName,
          inboxTaskId: randomUUID(),
          // T-0458 [D8-R3]: this surfacing came from a timer firing → escalation.
          escalated: true,
          doubtReason: TIMER_ESCALATION_REASON,
          via: "timer-fire",
        });
        emitted++;
      } catch {
        // best-effort — a failed emit just means it is retried on the next read.
      }
    }
  }

  return emitted;
}

// ---------------------------------------------------------------------------
// T-0459 [D8-R4]: message/signal catch — waiting projection + correlated delivery.
//
// Two halves mirroring the timer reconcile pattern (T-0458) + the engine-drive
// reconcile (T-0443/T-0456):
//
//   WAITING PROJECTION (reconcile-on-read): an instance PARKED on a message-catch
//   (receiveTask / intermediateCatchEvent(message|signal)) shows as WAITING with a
//   «Ожидает сообщения» row — NOT stuck, NOT done. The base process card already
//   renders any non-done instance as waiting; surfaceMessageCatchWaits adds the
//   honest «waiting on a message» row carrying the awaited messageName so the card
//   says WHAT it waits for.
//
//   CORRELATED DELIVERY: deliverMessageEnvelope validates an inbound envelope,
//   correlates it (TENANT-FAIL-CLOSED via the pure core), signals each fired
//   instance in the live engine, and reconciles the engine's NEW active task into
//   the projection (reuse the T-0456 engine-drive reconcile pattern). A message for
//   the wrong / unknown tenant is rejected — never delivered cross-tenant.
// ---------------------------------------------------------------------------

/**
 * Default display name/step for a message-catch waiting row («Ожидает сообщения»).
 */
export const MESSAGE_WAIT_TASK_NAME = "Ожидает сообщения";
export const MESSAGE_WAIT_STEP = "Ожидание сообщения";

/**
 * Minimal engine port the message delivery needs — a structural subset of
 * FlowableClient. `correlateMessage` signals a parked message-catch in the live
 * engine (Flowable's message correlation API); `getActiveUserTasks` lets the
 * post-delivery reconcile surface the NEW active task the firing produced. Kept
 * structural so this module stays decoupled from the concrete client type.
 */
export interface MessageDeliveryEnginePort {
  /**
   * Signal a correlated message into a specific process instance (the catch fires).
   * Flowable: POST /runtime/process-instances/{id}/event or the message-event
   * correlation endpoint. Returns ok:false (with a code) on engine error — the
   * delivery is best-effort and never throws past this boundary.
   */
  correlateMessage(
    instanceId: string,
    messageName: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; code: string }>;
  getActiveUserTasks(
    instanceId: string,
  ): Promise<
    | { ok: true; tasks: ActiveEngineTask[] }
    | { ok: false; code: string }
  >;
}

/**
 * Port that loads the WAITING message-catch subscriptions for a tenant — the
 * instances parked on a message-catch, each with its resolved correlation key (the
 * value of the element's correlationField on the bound record), messageName and
 * broadcast flag. Injected so the pure correlation core is exercised against real
 * subscriptions while the impure load (BPMN config + record field) is testable.
 *
 * In production this is backed by the message-catch waiting rows + the element
 * config + a record-field read; tests supply a fixture array directly.
 */
export interface MessageSubscriptionSource {
  listWaitingSubscriptions(tenantId: string): Promise<MessageSubscription[]>;
}

/**
 * Result of attempting to deliver an inbound envelope.
 *  - rejected:"bad-envelope"  → the envelope failed shape validation (fail-closed).
 *  - rejected:"wrong-tenant"  → a name+key match existed only in another tenant
 *                               (TENANT-FAIL-CLOSED — never delivered cross-tenant).
 *  - rejected:"no-match"      → nothing correlated in this tenant.
 *  - delivered                → ≥1 instance fired; firedInstances lists them.
 */
export type DeliveryResult =
  | { delivered: true; firedInstances: string[] }
  | { delivered: false; rejected: "bad-envelope" | "wrong-tenant" | "no-match"; reason: string };

/**
 * Deliver an inbound message envelope. Pure decision (correlateEnvelope) + impure
 * effects (engine signal, projection reconcile) behind injected ports.
 *
 * Flow:
 *  1. Validate the envelope shape (fail-closed on anything malformed).
 *  2. Load the WAITING subscriptions for the envelope's tenant ONLY (the source is
 *     called with envelope.tenant — a subscription source must itself be
 *     tenant-scoped; the correlation core ALSO re-checks tenant on every candidate,
 *     so even a leaky source can never deliver cross-tenant).
 *  3. correlateEnvelope → fired instance ids (TENANT-FAIL-CLOSED, point-to-point for
 *     messages, broadcast within-tenant for signals).
 *  4. For each fired instance: signal the engine, then reconcile the new active task
 *     into the projection so the inbox advances (catch fired → next step appears).
 *
 * Never throws past this boundary — engine/DB hiccups degrade to a best-effort
 * partial delivery (the envelope can be re-delivered; correlation is idempotent on
 * the projection side via dedup).
 */
export async function deliverMessageEnvelope(
  pool: pg.Pool,
  rawEnvelope: unknown,
  subscriptionSource: MessageSubscriptionSource,
  engine: MessageDeliveryEnginePort,
  opts?: { nowMs?: number; actor?: string },
): Promise<DeliveryResult> {
  const nowMs = opts?.nowMs ?? Date.now();
  const actor = opts?.actor ?? "system:message";

  // 1. Shape validation — fail-closed.
  const validation = validateEnvelope(rawEnvelope);
  if (!validation.ok) {
    return { delivered: false, rejected: "bad-envelope", reason: validation.reason };
  }
  const envelope = validation.envelope;

  // 2. Load waiting subscriptions for THIS tenant only.
  let subscriptions: MessageSubscription[];
  try {
    subscriptions = await subscriptionSource.listWaitingSubscriptions(envelope.tenant);
  } catch {
    // Cannot load — treat as no match (fail-closed; never delivers cross-tenant).
    return { delivered: false, rejected: "no-match", reason: "subscription load failed" };
  }

  // 3. Pure correlation — TENANT-FAIL-CLOSED is enforced inside correlateEnvelope.
  const result: CorrelationResult = correlateEnvelope(envelope, subscriptions);

  if (!result.delivered) {
    if (result.tenantRejected) {
      return {
        delivered: false,
        rejected: "wrong-tenant",
        reason: "message rejected: name+key matched only in a different tenant (tenant-fail-closed)",
      };
    }
    return { delivered: false, rejected: "no-match", reason: "no waiting catch correlated this message" };
  }

  // 4. Signal each fired instance + reconcile its new active task into the projection.
  const fired: string[] = [];
  for (const inst of result.firedInstances) {
    let signalled = false;
    try {
      const r = await engine.correlateMessage(inst, envelope.messageName, { ...envelope.payload });
      signalled = r.ok;
    } catch {
      signalled = false;
    }
    if (!signalled) continue; // engine couldn't fire this instance — skip; retriable.
    fired.push(inst);

    // The catch fired → the engine has advanced to a NEW active task. Reconcile it
    // into the projection (reuse the T-0456 engine-drive pattern). Best-effort.
    try {
      const tasksResult = await engine.getActiveUserTasks(inst);
      if (tasksResult.ok) {
        const projected = await listInstanceInboxTasks(pool, envelope.tenant);
        const projectedDefKeys = new Set(
          projected.filter((t) => t.inst === inst).map((t) => t.taskDefKey),
        );
        const procKey =
          projected.find((t) => t.inst === inst)?.procKey ?? "telLinear";
        const emittedThisPass = new Set<string>();
        for (const engineTask of tasksResult.tasks) {
          const defKey = engineTask.taskDefinitionKey;
          if (projectedDefKeys.has(defKey)) continue; // already on screen.
          if (emittedThisPass.has(defKey)) continue;
          emittedThisPass.add(defKey);
          await appendNextTaskEvent(pool, envelope.tenant, {
            instanceId: inst,
            procKey,
            actor,
            nowMs,
            taskDefKey: defKey,
            taskName: engineTask.name || APPROVE_TASK_NAME,
            taskRole: engineTask.candidateGroups[0] ?? APPROVER_ROLE,
            taskStep: engineTask.name || APPROVE_STEP,
            inboxTaskId: randomUUID(),
            via: "message-fire",
          });
        }
      }
    } catch {
      // best-effort — the next read reconciles; the catch already fired in the engine.
    }
  }

  if (fired.length === 0) {
    // Correlated but the engine could not fire any (transient) — retriable.
    return { delivered: false, rejected: "no-match", reason: "correlated but engine signal failed" };
  }
  return { delivered: true, firedInstances: fired };
}

/**
 * WAITING PROJECTION for message-catches. For each parked subscription, emit a
 * `process.next_task(messageCatch)` row so the instance shows «Ожидает сообщения» in
 * the inbox/process card — surfacing the wait as WAITING (not stuck, not done) and
 * naming WHAT it waits for. Idempotent: a wait row already surfaced for the same
 * instance+messageName is not re-emitted (dedup by the (inst, message_name) pair).
 *
 * Best-effort + degrade-silent (read-projection, never a hard dependency). Returns
 * the number of wait rows newly emitted.
 */
export async function surfaceMessageCatchWaits(
  pool: pg.Pool,
  tenantId: string,
  subscriptionSource: MessageSubscriptionSource,
  opts?: { nowMs?: number; actor?: string },
): Promise<number> {
  const nowMs = opts?.nowMs ?? Date.now();
  const actor = opts?.actor ?? "system:message";

  let subscriptions: MessageSubscription[];
  let projected: InstanceInboxTask[];
  try {
    subscriptions = await subscriptionSource.listWaitingSubscriptions(tenantId);
    projected = await listInstanceInboxTasks(pool, tenantId);
  } catch {
    return 0;
  }
  if (subscriptions.length === 0) return 0;

  // Already-surfaced (inst, messageName) waits — dedup so re-reads don't pile rows.
  const surfaced = new Set<string>();
  for (const t of projected) {
    if (t.messageCatch && t.messageName) surfaced.add(`${t.inst}::${t.messageName}`);
  }

  let emitted = 0;
  for (const sub of subscriptions) {
    const key = `${sub.inst}::${sub.messageName}`;
    if (surfaced.has(key)) continue;
    surfaced.add(key); // also dedup within this pass.
    try {
      await appendNextTaskEvent(pool, tenantId, {
        instanceId: sub.inst,
        procKey: "telLinear",
        actor,
        nowMs,
        taskDefKey: `message-catch:${sub.messageName}`,
        taskName: MESSAGE_WAIT_TASK_NAME,
        taskRole: APPROVER_ROLE,
        taskStep: MESSAGE_WAIT_STEP,
        inboxTaskId: randomUUID(),
        via: "message-wait",
        messageCatch: true,
        messageName: sub.messageName,
      });
      emitted++;
    } catch {
      // best-effort — retried on next read.
    }
  }
  return emitted;
}

// ---------------------------------------------------------------------------
// T-0459 [D8-R4]: engine-backed MessageSubscriptionSource for the LIVE read.
//
// The waiting projection (surfaceMessageCatchWaits) needs to know WHICH instances
// are parked on a message-catch. The engine truth for that is the active
// event-subscriptions of each WAITING instance: a token parked on a receiveTask /
// intermediateCatchEvent(message|signal) / message-boundary registers a
// "message"/"signal" event-subscription. This factory builds a
// MessageSubscriptionSource that:
//   1. reads the currently-waiting instances from the projection (the same source
//      the timer reconcile uses — listInstanceProjections, status != done), and
//   2. asks the engine which of them carry a parked message/signal catch
//      (getMessageCatchWaits), turning each into a MessageSubscription.
//
// Honest-degrade: any engine/DB hiccup for a single instance is swallowed (that
// instance is simply not surfaced this pass — retried on the next read); the source
// never throws past its own boundary. Keeps the engine port injectable so the live
// read can mirror the reconcileInstanceTimers wiring exactly.
// ---------------------------------------------------------------------------

/**
 * Minimal engine port the message-wait read-projection needs — a structural subset
 * of FlowableClient. Reveals the parked message/signal catches of a live instance.
 */
export interface MessageWaitEnginePort {
  getMessageCatchWaits(
    instanceId: string,
  ): Promise<
    | { ok: true; waits: { messageName: string; eventType: string }[] }
    | { ok: false; code: string }
  >;
}

/**
 * Build a MessageSubscriptionSource backed by the live engine: enumerate the
 * waiting instances of a tenant (projection) and project each instance's parked
 * message/signal catches (engine) into MessageSubscription rows. The correlationKey
 * is NOT load-bearing on the waiting path (surfaceMessageCatchWaits keys only on
 * inst + messageName); it is filled with the instance id as an honest non-empty
 * placeholder (the DELIVERY path — deliverMessageEnvelope — sources its
 * subscriptions with the real record-field key, Stage-2 Pull seam).
 *
 * Best-effort: a per-instance engine failure is skipped (degrade-silent). A failure
 * to read the projection returns an empty subscription set (so the wait projection
 * simply emits nothing this pass).
 */
export function makeEngineMessageSubscriptionSource(
  pool: pg.Pool,
  engine: MessageWaitEnginePort,
  opts?: { limit?: number },
): MessageSubscriptionSource {
  return {
    async listWaitingSubscriptions(tenantId: string): Promise<MessageSubscription[]> {
      let projections: InstanceProjection[];
      try {
        projections = await listInstanceProjections(pool, tenantId, { limit: opts?.limit });
      } catch {
        return []; // cannot read projection — surface nothing (degrade-silent).
      }
      const waitingInstanceIds = projections
        .filter((p) => p.status !== "done")
        .map((p) => p.inst);
      if (waitingInstanceIds.length === 0) return [];

      const subscriptions: MessageSubscription[] = [];
      for (const inst of waitingInstanceIds) {
        let result;
        try {
          result = await engine.getMessageCatchWaits(inst);
        } catch {
          continue; // engine hiccup for this instance — skip, try others.
        }
        if (!result.ok || result.waits.length === 0) continue;
        for (const w of result.waits) {
          if (!w.messageName) continue;
          subscriptions.push({
            inst,
            tenant: tenantId,
            messageName: w.messageName,
            // correlationKey unused on the waiting path (dedup is inst+messageName);
            // a non-empty honest placeholder keeps the shape valid.
            correlationKey: inst,
            broadcast: w.eventType.toLowerCase() === "signal",
          });
        }
      }
      return subscriptions;
    },
  };
}
