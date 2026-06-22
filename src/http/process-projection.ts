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

// ---------------------------------------------------------------------------
// Audit event types (free-text `type` column; no enum constraint — migrations/006).
// ---------------------------------------------------------------------------

/** Emitted once on start: seeds the instance projection + its waiting user-task. */
export const PROCESS_STARTED_TYPE = "process.started";
/** Emitted once on card-action approve: advances the instance to `done`. */
export const TASK_APPROVED_TYPE = "task.approved";

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

  // T-0339 (E15-S3): emit instance.ended for the transition journal (F2 Phase 1).
  // The linear ТЭЛ path: approve → end → done (one task, one instance lifecycle end).
  // Only emitted when tenantId is supplied (S3 callers; backward-compat with T-0332/T-0335).
  if (args.tenantId) {
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
          durationMs: null, // instance total duration not computed here (can be derived from journal)
          verdict: "end",
        }),
      },
      occurred_at: args.nowMs,
    });
  }
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

/**
 * Read the raw started + approved events for a tenant, ordered oldest-first so the
 * fold is deterministic. Single tx, two scoped SELECTs over audit_event only.
 */
async function readEvents(
  pool: pg.Pool,
  tenantId: string,
  limit: number,
): Promise<{ started: StartedRow[]; approvedTaskIds: Set<string> }> {
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

    const approvedRes = await client.query<{ payload: Record<string, unknown> }>(
      `SELECT payload
         FROM choros.audit_event
        WHERE type = $1
          AND tenant_id = $2
        ORDER BY occurred_at ASC
        LIMIT $3`,
      [TASK_APPROVED_TYPE, tenantId, limit],
    );

    const approvedTaskIds = new Set<string>();
    for (const r of approvedRes.rows) {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      const tid = p["inbox_task_id"];
      if (typeof tid === "string" && tid.length > 0) approvedTaskIds.add(tid);
    }

    return { started: startedRes.rows, approvedTaskIds };
  });
}

function strField(payload: Record<string, unknown>, key: string, fallback: string): string {
  const v = payload[key];
  return typeof v === "string" && v.trim() !== "" ? v : fallback;
}

/**
 * Fold the audit track into InstanceProjection[]. A started instance is `waiting`
 * (its user-task awaits a human) until a matching `task.approved` (back-linked by
 * inbox_task_id) is observed, which advances it to `done` (ADR §2.3 / AC-6).
 */
export async function listInstanceProjections(
  pool: pg.Pool,
  tenantId: string,
  opts?: { limit?: number },
): Promise<InstanceProjection[]> {
  const limit = Math.min(opts?.limit ?? 200, 500);
  const { started, approvedTaskIds } = await readEvents(pool, tenantId, limit);

  return started.map((row): InstanceProjection => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const inst = strField(payload, "inst", `instance:${row.id}`);
    const procKey = strField(payload, "proc_key", "telLinear");
    const role = strField(payload, "task_role", APPROVER_ROLE);
    const step = strField(payload, "task_step", APPROVE_STEP);
    const done = approvedTaskIds.has(row.id);
    // T-0414 / T-0356: read originating record_id (present when started via on_create).
    const rawRecordId = payload["record_id"];
    const recordId = typeof rawRecordId === "string" && rawRecordId ? rawRecordId : undefined;
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
      ...(recordId !== undefined ? { recordId } : {}),
    };
  });
}

/**
 * Project the WAITING user-tasks of started instances into inbox rows, addressed
 * to the ROLE (candidateGroups → role), NOT to a person (ADR §2.3 / AC-3). A task
 * whose instance is already `done` (matching task.approved) is dropped — there is
 * nothing left to act on.
 */
export async function listInstanceInboxTasks(
  pool: pg.Pool,
  tenantId: string,
  opts?: { limit?: number },
): Promise<InstanceInboxTask[]> {
  const limit = Math.min(opts?.limit ?? 200, 500);
  const { started, approvedTaskIds } = await readEvents(pool, tenantId, limit);

  const tasks: InstanceInboxTask[] = [];
  for (const row of started) {
    if (approvedTaskIds.has(row.id)) continue; // already approved → no waiting task.
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    tasks.push({
      id: row.id,
      role: strField(payload, "task_role", APPROVER_ROLE),
      name: strField(payload, "task_name", APPROVE_TASK_NAME),
      step: strField(payload, "task_step", APPROVE_STEP),
      inst: strField(payload, "inst", `instance:${row.id}`),
      procKey: strField(payload, "proc_key", "telLinear"),
      occurredAt: row.occurred_at,
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
