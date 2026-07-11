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
import { fallbackDefinitionName } from "../core/process-catalog-view.js";
import { selectEngineProcessNames } from "../db/engine-process-name.js";
import { findEmployeeById, isGenesisOwnerForTenant } from "../db/org.js";
import { isRecordReadable, type RowAncestry } from "../core/read-visibility.js";
import type { Grant, AncestryOracle } from "../core/grant-lattice.js";
// T-0756 [E16 §6, capstone T-0691 P1]: the safe source-record projection + the
// per-hop-ACL participant check reuse the ALREADY-MERGED authority resolvers —
// NO second grant/lattice math (FF-INST-VIS-2): getRoleSlugsForActor
// (role-eligibility, ACTOR_ACTIVE-gated T-0738), resolveActorPrivilege (the SAME
// sandbox-privilege resolver records.ts falls back to, T-0557), pickTitleFieldKey
// (schema-aware title picker, T-0613), isGenesisOwnerForTenant (owner, T-0658).
import { getRoleSlugsForActor } from "../db/grants-dao.js";
import { resolveActorPrivilege } from "../db/sandbox-gate-dao.js";
import { pickTitleFieldKey } from "../core/registry-title-field.js";

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
  /**
   * T-0614 [деТЭЛ]: the human-readable name of this instance's process DEFINITION,
   * resolved from choros.process_definition.name (latest version for procKey,
   * tenant-scoped) — or fallbackDefinitionName(procKey) (src/core/process-catalog-view.ts,
   * REUSED, not re-hardcoded) when no modeler row exists for this key (engine-only
   * definition, e.g. the seeded telLinear ТЭЛ). Replaces the case-literal
   * "Канонический линейный ТЭЛ" that processes.ts's projectionToInstance used to
   * assign to EVERY instance regardless of its actual process (D-064 violation, found
   * live by the founder 2026-07-03: purchaseApproval and acceptance-demo instances both
   * showed this one literal name).
   */
  readonly definitionName: string;
  /**
   * T-0614 [деТЭЛ]: number of steps of THIS instance already completed — the base
   * approve step (if approved) plus any APPROVED process.next_task rows for this
   * instance. An honest "known so far" count, NOT a case-literal (replaces the
   * hardcoded progress={done:2,total:3}|{done:3,total:3} of the linear ТЭЛ's 3 nodes).
   */
  readonly stepsDone: number;
  /**
   * T-0614 [деТЭЛ]: stepsDone + the number of CURRENTLY waiting concurrent steps
   * (concurrentSteps.length) for a non-done instance; equals stepsDone for a done
   * instance (no further steps this projection can honestly claim to know about).
   * This is deliberately NOT the full BPMN user-task count of the definition — the
   * projection has no cheap way to know unobserved future nodes without a live
   * engine query / BPMN parse, which ADR T-0278 §2.3 rejected as disproportionate
   * for the read path. See ADR-T0614 §4 O1 for the follow-up.
   */
  readonly stepsKnownTotal: number;
  /**
   * T-0614 [деТЭЛ]: the employee.kind ("human" | "agent") of the actor who STARTED
   * this instance (the only actor concretely bound to an InstanceProjection today),
   * resolved via findEmployeeById (mirrors the actorKind pattern in
   * src/http/inbox.ts:1370-1379) — non-fatal degrade to "human" when the actor is not
   * found or the resolve errors. Replaces the case-literal execs=["human","agent"]
   * that was assigned unconditionally to every instance. "service" is never
   * fabricated here — choros.employee.kind has no such value today (see ADR-T0614 §4
   * O2 for the follow-up once a service-executor source of truth exists).
   */
  readonly starterActorKind: "human" | "agent";
  /**
   * T-0654 [part A / UX-study §5.3]: the raw actor id of who STARTED this instance
   * (`process.started` audit_event.actor — the SAME value that feeds resolveActorKinds
   * above for starterActorKind). Surfaced so the display plane (src/http/processes.ts,
   * pg-free) can (a) resolve it to a human name via the injected resolveActorsDisplay
   * (T-0648) for «Запущен: <Имя>», and (b) evaluate the `?mine=` filter (starterId ===
   * the reading actor's slug) WITHOUT re-querying — never used to widen visibility (the
   * projection is already tenant-scoped). Always present.
   */
  readonly starterActorId: string;
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
  /**
   * T-0683 (D-064, wave-5 human-layer): the HUMAN-READABLE name of this task's
   * process DEFINITION — resolved from choros.process_definition.name (latest
   * version for procKey, tenant-scoped) via the SAME resolveDefinitionNames batch
   * already proven for listInstanceProjections (REUSED, not re-hardcoded), or
   * fallbackDefinitionName(procKey) when no modeler row exists (engine-only defs).
   * Surfaced so the inbox «ПРОЦЕСС» column can show a human process name as the
   * PRIMARY identifier instead of the raw instance-UUID (the capstone T-0647
   * defect: the operator's main screen showed `5ec293d1-77d7-…` as the primary
   * process key). NEVER empty — the fallback guarantees an honest human string.
   */
  readonly processName: string;
  /**
   * T-0683: originating business record id (present when the instance was started
   * by an on_create trigger; read from the process.started/next_task payload's
   * `record_id`). Absent for processes started outside the record-create path.
   * The client's RecordRef lazily resolves this to the record's TITLE — the
   * primary disambiguator between two instances of the same process definition.
   */
  readonly recordId?: string;
  /** Epoch-ms the task became available. */
  readonly occurredAt: number;
  /**
   * T-0443 / T-0571: BPMN task definition key for the engine user-task this inbox row
   * maps to. `process.next_task` rows always carry their OWN real defKey read from the
   * engine (e.g. "task-extra-approve" for the 6M branch) — untouched by T-0571.
   *
   * Base `process.started` rows carry `null` — a RESOLVE-BY-INSTANCE signal (T-0571,
   * BUG-014 fix), not a literal defKey to match against. The base process.started event
   * does not know (and must not guess) the BPMN author's chosen node name for a GENERIC
   * process — only the live engine knows which user-task is currently active for this
   * instance. The approve handler passes this signal through to
   * reconcileInstanceEngineDrive, which resolves the target engine task by "the active
   * user-task of THIS instanceId" rather than by string-matching a defKey (see
   * reconcileInstanceEngineDrive §post-approve completion). ADDITIVE: `string | null` —
   * every existing `.taskDefKey` consumer that only reads process.next_task rows (the
   * dedup Set in reconcileInstanceEngineDrive, reconcileInstanceTimers) is unaffected,
   * since those rows never carried `null`.
   */
  readonly taskDefKey: string | null;
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
// T-0575 [W1/деТЭЛ] BUG-015: config-primitive fallback defaults.
//
// PRINCIPLE (ADR-T0575 §2.1): the base (process.started) task's role/step/name
// are resolved from the LIVE engine's active user-task (candidateGroups[0]/name)
// at start time — see appendProcessStarted's callers (process-start.ts,
// records.ts), which now read flowable.getActiveUserTasks(instanceId) BEFORE
// calling appendProcessStarted and pass the resolved values through. The
// constants below survive ONLY as the NAMED, configurable fallback used when the
// engine is unreachable, the instance has no active user-task yet, or
// candidateGroups/name come back empty — never as the unconditional value.
//
// CONFIGURABLE (not a second hardcoded literal): resolveDefaultApproverRole()
// reads CHOROS_DEFAULT_APPROVER_ROLE (env), defaulting to "role-approver" for
// backward compatibility with the ТЭЛ seed (tel-linear.bpmn20.xml candidateGroups
// ="role-approver"). This is the SINGLE source of truth for the fallback role —
// dispatch-outcome.ts (BUG-015-agent, AC-11) imports it rather than re-hardcoding
// the string a second time.
// ---------------------------------------------------------------------------

/**
 * T-0575 config-primitive: the fallback approver role used ONLY when the live
 * engine's active user-task cannot be resolved (unreachable engine, no active
 * task yet, or empty candidateGroups). Env `CHOROS_DEFAULT_APPROVER_ROLE`,
 * defaulting to the ТЭЛ seed value "role-approver" for backward compatibility.
 * Not read in src/core/ (no-env-in-core.sh boundary) — this module is src/http/.
 */
export function resolveDefaultApproverRole(): string {
  const v = process.env["CHOROS_DEFAULT_APPROVER_ROLE"];
  return v !== undefined && v.trim() !== "" ? v : APPROVER_ROLE;
}

/**
 * T-0575 config-primitive: the fallback step/task-name label pair used ONLY when
 * the live engine's active user-task name is unavailable. Env
 * `CHOROS_DEFAULT_APPROVE_STEP` / `CHOROS_DEFAULT_APPROVE_TASK_NAME`, defaulting
 * to the ТЭЛ seed labels for backward compatibility.
 */
export function resolveDefaultApproveStep(): string {
  const v = process.env["CHOROS_DEFAULT_APPROVE_STEP"];
  return v !== undefined && v.trim() !== "" ? v : APPROVE_STEP;
}

/** @see resolveDefaultApproveStep */
export function resolveDefaultApproveTaskName(): string {
  const v = process.env["CHOROS_DEFAULT_APPROVE_TASK_NAME"];
  return v !== undefined && v.trim() !== "" ? v : APPROVE_TASK_NAME;
}

// ---------------------------------------------------------------------------
// Defaults — the canonical linear ТЭЛ U4 approval task (BPMN task-approve,
// candidateGroups="role-approver"). Retained as the NAMED values the config
// primitives above default to (ТЭЛ-compatibility, ADR §3) — no longer read
// directly as the unconditional value on the base-task projection path (that
// now goes through resolveDefaultApproverRole/resolveDefaultApproveStep/
// resolveDefaultApproveTaskName, which fall back to these same strings).
// ---------------------------------------------------------------------------

/** candidateGroups of the U4 approval user-task (tel-linear.bpmn20.xml). */
export const APPROVER_ROLE = "role-approver";
/** Step/node label of the U4 approval user-task. */
export const APPROVE_STEP = "Согласование";
/** Display name of the U4 approval inbox task. */
export const APPROVE_TASK_NAME = "Согласовать заявку";
/**
 * T-0616 [F-2, D-064 анти-кейс fix]: the ONE named fallback for `proc_key` when
 * a payload omits it entirely (legacy/malformed row — the write half always
 * writes `proc_key: args.procKey` unconditionally, see emitProcessStarted /
 * every appendNextTaskEvent call site, so this branch is near-unreachable in
 * practice).
 *
 * T-0614 originally defaulted this to the literal ENGINE key `"telLinear"` —
 * which meant an unknown/malformed row was displayed as the CONCRETE named
 * process "Канонический линейный ТЭЛ" (via fallbackDefinitionName), i.e. "I
 * don't know this process's key → assume it's ТЭЛ". That is itself a
 * micro-case-hardcode (review T-0614 F-2): a real, specific, existing
 * process's identity leaking onto rows that are not that process at all.
 *
 * Fixed here: the fallback is a NEUTRAL, honestly-synthetic key (not any real
 * process's key) — `fallbackDefinitionName` (src/core/process-catalog-view.ts,
 * REUSED) then echoes it back verbatim as the display name, same as it does
 * for every other unrecognized key. A malformed row now honestly renders as
 * "an unnamed process", never as a borrowed name from a real seeded process.
 */
export const DEFAULT_PROC_KEY = "process:unknown";

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
  // T-0575 BUG-015: callers now pass the LIVE engine's candidateGroups[0]/name
  // (read via flowable.getActiveUserTasks) when available; these config-primitive
  // fallbacks apply ONLY when the caller omits the field (engine unreachable, no
  // active user-task yet, or empty candidateGroups/name at the call site).
  const role = args.approverRole ?? resolveDefaultApproverRole();
  const step = args.step ?? resolveDefaultApproveStep();
  const taskName = args.taskName ?? resolveDefaultApproveTaskName();

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
 *
 * T-0588 (BLOCK-4): optional `onBehalfOf` — when the approve was authorized via
 * a Tier-2 substitution_rule (the actor does not hold `task.role` directly, but
 * stands in for an absent holder), the absent holder's employee SLUG. Mirrors
 * appendTaskClaimed's onBehalfOf (claim-projection.ts): recorded in the JSONB
 * payload (not a new audit_event column — same "no migration" reasoning as the
 * claim event), defaults to undefined so the payload key is OMITTED for a
 * normal role-assignment approve (byte-identical to pre-T-0588 behaviour).
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
    /**
     * T-0588 (BLOCK-4): when the approve was authorized via a Tier-2
     * substitution_rule, the absent holder's employee SLUG. Optional — defaults
     * to undefined, in which case the payload key is OMITTED (byte-identical to
     * the pre-T-0588 payload for a normal role-assignment approve).
     */
    readonly onBehalfOf?: string;
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
      // T-0588: on_behalf_of is present ONLY for a substitution-authorized approve.
      ...(args.onBehalfOf !== undefined ? { on_behalf_of: args.onBehalfOf } : {}),
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

// ---------------------------------------------------------------------------
// T-0721 (D-064, P1 из T-0714 — security/PDP): DETAIL read-visibility gate.
//
// THE PROBLEM (T-0714 §3 P1): GET /api/processes/:id returns Flowable's raw
// `variables` + full step `history` (with `completedBy*`) to ANY member of the
// tenant, regardless of whether they hold a READ grant on the instance's
// SOURCE RECORD. The same business values (sums, verdicts, field values) are
// already gated on the record plane by field-visibility (T-0081) and READ-PDP
// (T-0570) — this was a side-door around both.
//
// THE FIX (T-0714 §5 option c, phase 1): an instance's DETAIL visibility is
// INHERITED from the READ-visibility of its source record. Reuses the SAME
// single authority path records.ts already consumes — `isRecordReadable`
// (src/core/read-visibility.ts, pure, no second math) fed by the injected
// `resolveReadVisibility` resolver (grants + ancestry, wired byte-identically
// to records.ts's in src/server.ts — see ProcessReadVisibilityResolver in
// process-start.ts). This module owns ONLY the recordId → RowAncestry
// reverse-lookup (registryId/applicationId columns) the predicate needs —
// records.ts already has these columns in hand from its own SELECT; a
// process instance only carries `recordId`, so one extra tenant-scoped
// single-row fetch is unavoidable (T-0714 §5 "Против" — anticipated).
//
// RECORD-LESS INSTANCES (T-0714 §5 phase 1 fallback): an instance started
// WITHOUT create=start (no `recordId` — e.g. the explicit /api/processes/start
// launch affordance) is NOT narrowed by this gate — visibility stays
// tenant-default-open, unchanged from pre-T-0721 behaviour. Narrowing that
// case needs a process-definition-scoped read grant (T-0714 §5 phase 3,
// follow-up, out of scope here).
//
// Display-plane isolation (FF-INST-VIS-3 / FF-7-3): this predicate lives HERE
// (process-projection.ts already imports pg for the projection read-path) —
// processes.ts stays pg/src-db-free, it only calls this exported function
// through the pool it already threads into listInstanceProjections.
// ---------------------------------------------------------------------------

/**
 * Look up the READ-visibility ancestry columns (`registryId`, `applicationId`)
 * for ONE record, tenant-scoped. Returns `null` when the record does not exist
 * in this tenant (deleted / never existed) — the caller treats that as
 * NOT readable (honest-deny, never worse than a 404, never assumes an
 * existence it cannot prove). Pure data fetch — no grant/authority math here;
 * `isRecordReadable` (core/read-visibility.ts) remains the ONLY containment
 * decision (NF-5, FF-INST-VIS-2).
 */
async function loadRecordRowAncestry(
  pool: pg.Pool,
  tenantId: string,
  recordId: string,
): Promise<RowAncestry | null> {
  return withTenant(pool, tenantId, async (client) => {
    const res = await client.query<{ id: string; registry_id: string; application_id: string }>(
      `SELECT r.id, r.registry_id, rd.application_id
         FROM choros.record r
         JOIN choros.registry_def rd
           ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, recordId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { recordId: row.id, registryId: row.registry_id, applicationId: row.application_id };
  });
}

/**
 * T-0721: decide whether the DETAIL plane (`variables`/`history`/`completedBy*`)
 * of ONE instance is visible to the actor whose covering READ grants are
 * `grants` (already resolved ONCE per request by the injected
 * ProcessReadVisibilityResolver — NF-1, mirrors records.ts).
 *
 * - `recordId === undefined` (record-less instance) → `true` (phase-1 scope:
 *   NOT narrowed, see module doc-comment above).
 * - `recordId` present but the record no longer resolves in this tenant
 *   (deleted, or — defensively — a foreign id) → `false` (honest-deny).
 * - Otherwise → `isRecordReadable(rowAncestry, grants, ancestry, nowMs)`, the
 *   EXACT SAME predicate records.ts's LIST/DETAIL routes already gate on.
 */
export async function isInstanceDetailVisible(
  pool: pg.Pool,
  tenantId: string,
  recordId: string | undefined,
  grants: readonly Grant[],
  ancestry: AncestryOracle,
  nowMs: number,
): Promise<boolean> {
  if (recordId === undefined) return true;
  const rowAncestry = await loadRecordRowAncestry(pool, tenantId, recordId);
  if (rowAncestry === null) return false;
  return isRecordReadable(rowAncestry, grants, ancestry, nowMs);
}

// ---------------------------------------------------------------------------
// T-0722 (D-064, P2 из T-0714 — security/PDP): LIST read-visibility filter —
// Фаза 2 of option (c) (T-0721 above was Фаза 1, DETAIL). Narrows an ALREADY
// tenant-scoped `InstanceProjection[]` (the output of listInstanceProjections)
// to the subset the actor holds a covering READ grant for on the source
// record — the SAME predicate (isRecordReadable), the SAME grants/ancestry
// shape (resolved ONCE per request by the caller, NF-1), reused from
// isInstanceDetailVisible above — but BATCHED over the whole list in ONE
// extra SQL query instead of N+1 per-instance round-trips (DETAIL handles
// exactly one instance per request — 1 query is fine there; LIST can carry
// up to readEvents's internal 200-row cap, so a per-instance loop would be a
// real N+1). Mirrors resolveDefinitionNames/resolveActorKinds' batching
// pattern already established in this module.
// ---------------------------------------------------------------------------

/**
 * Batched sibling of `loadRecordRowAncestry`: resolve `{registryId,
 * applicationId}` for MANY records in ONE tenant-scoped query
 * (`id = ANY($2::uuid[])`) instead of one round-trip per record. Same
 * honest-deny contract per id: a recordId absent from the returned map means
 * "does not resolve in this tenant" (deleted / never existed) — the caller
 * treats that as NOT readable, never as an error. Pure data fetch — no
 * grant/authority math here; `isRecordReadable` remains the ONLY containment
 * decision (NF-5, FF-INST-VIS-2 precedent extended to the batched path).
 */
async function loadRecordRowAncestryBatch(
  pool: pg.Pool,
  tenantId: string,
  recordIds: readonly string[],
): Promise<Map<string, RowAncestry>> {
  return withTenant(pool, tenantId, async (client) => {
    const res = await client.query<{ id: string; registry_id: string; application_id: string }>(
      `SELECT r.id, r.registry_id, rd.application_id
         FROM choros.record r
         JOIN choros.registry_def rd
           ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
        WHERE r.tenant_id = $1 AND r.id = ANY($2::uuid[])`,
      [tenantId, recordIds],
    );
    const map = new Map<string, RowAncestry>();
    for (const row of res.rows) {
      map.set(row.id, { recordId: row.id, registryId: row.registry_id, applicationId: row.application_id });
    }
    return map;
  });
}

/**
 * T-0722: narrow `projections` to the instances the actor (whose covering
 * READ grants are `grants`, resolved ONCE per request by the caller — NF-1,
 * mirrors isInstanceDetailVisible/records.ts's LIST filter) may see, per the
 * READ-visibility of each instance's SOURCE RECORD.
 *
 * - Record-less instances (`recordId === undefined`) are NEVER narrowed —
 *   kept unconditionally (phase-1/2 scope, byte-identical to
 *   isInstanceDetailVisible's record-less branch and to pre-T-0722 LIST
 *   behaviour for those rows; see module doc-comment above §T-0721).
 * - A non-UUID-shaped recordId (malformed/legacy row) is treated as
 *   unresolvable WITHOUT touching the DB (dropped — see below for why this
 *   pre-validation exists here but not on isInstanceDetailVisible's
 *   single-instance path).
 * - A recordId that does not resolve in this tenant (deleted / foreign) is
 *   DROPPED (honest-deny — same posture as isInstanceDetailVisible's
 *   null-row branch).
 * - Otherwise → `isRecordReadable(rowAncestry, grants, ancestry, nowMs)`,
 *   the EXACT SAME predicate DETAIL and records.ts already gate on.
 *
 * Pure filter over the input array (preserves order, never re-fetches beyond
 * the ONE batched ancestry SELECT). Tenant/RLS additive-only (FF-INST-VIS-4):
 * this NARROWS an already tenant-scoped array — it is never the tenant
 * boundary itself, and the batched ancestry SELECT is itself tenant-scoped.
 */
export async function filterProjectionsByReadVisibility(
  pool: pg.Pool,
  tenantId: string,
  projections: readonly InstanceProjection[],
  grants: readonly Grant[],
  ancestry: AncestryOracle,
  nowMs: number,
): Promise<InstanceProjection[]> {
  // Only UUID-shaped recordIds are queried — a malformed recordId can never
  // resolve against choros.record's `uuid` column, so pre-filtering here
  // avoids a cast error aborting the WHOLE batch over one bad row (see
  // module ADR §2.5) — malformed ids fall straight through to the "not in
  // ancestryByRecordId" honest-drop branch below without a DB round-trip.
  const recordIds = [
    ...new Set(
      projections
        .map((p) => p.recordId)
        .filter((v): v is string => v !== undefined && UUID_RE.test(v)),
    ),
  ];

  const ancestryByRecordId =
    recordIds.length > 0 ? await loadRecordRowAncestryBatch(pool, tenantId, recordIds) : new Map<string, RowAncestry>();

  return projections.filter((p) => {
    if (p.recordId === undefined) return true; // record-less: unnarrowed (phase-1/2 scope)
    const rowAncestry = ancestryByRecordId.get(p.recordId);
    if (rowAncestry === undefined) return false; // malformed / deleted / foreign → honest-deny
    return isRecordReadable(rowAncestry, grants, ancestry, nowMs);
  });
}

// ---------------------------------------------------------------------------
// T-0756 (D-064, P1 из live-proof T-0691 — E16 §6 links) · per-hop ACL
// read-through projection of a process instance's SOURCE RECORD.
//
// THE DEFECT (T-0691 finding P1): the process card «ЗАПИСЬ-ИСТОЧНИК» rendered a
// RAW UUID and its GET /api/records/:id 404'd for the acting participant (the
// approver) — the person who just acted on the process could neither name nor
// open the record it is about. Cause: the source app is draft-tier (the
// sandbox gate T-0558 hides the record card from non-creators) AND/OR the actor
// lacks a READ grant. E16 §6: a participant sees a SAFE read-through projection
// (human title + type), never a hard 404, never a raw UUID; the full record
// stays under RLS + sandbox + READ-PDP.
//
// SINGLE-AUTHORITY (FF-INST-VIS-2): READ-PDP containment is ONLY isRecordReadable
// (read-visibility.ts); sandbox privilege is ONLY resolveActorPrivilege
// (sandbox-gate-dao.ts, the SAME resolver records.ts falls back to); role
// eligibility is ONLY getRoleSlugsForActor; owner is ONLY isGenesisOwnerForTenant.
// No bespoke grant/lattice math, no raw choros."grant" SQL in this module.
// ---------------------------------------------------------------------------

/**
 * The SAFE, minimal projection of a source record surfaced on a process card
 * (T-0756). Carries ONLY the human title + type + an honest openability flag —
 * NEVER the record's other `data` fields (those stay behind GET /api/records/:id
 * with RLS + sandbox + READ-PDP + field-visibility).
 */
export interface SourceRecordProjection {
  /** The source record's id (the same value the card already shows as a link target). */
  readonly id: string;
  /**
   * Human title — the registry's SCHEMA-DESIGNATED title field value
   * (pickTitleFieldKey: explicit x-title-field → title-like key → first plain
   * textual property), or a neutral «{typeLabel} · <id8>» when the schema has no
   * derivable title. Deliberately ONE designated field, never an arbitrary
   * data-order scan — no incidental field value leaks to a participant.
   */
  readonly title: string;
  /** The record's TYPE — the governing registry_def.display_name (generic, never a case literal). */
  readonly typeLabel: string;
  /**
   * True iff GET /api/records/:id would actually return 200 for this actor =
   * READ-PDP (isRecordReadable) AND sandbox-openable (privileged OR the owning
   * app is not draft OR the actor is the record's creator). The UI offers the
   * navigable «открыть» link ONLY when true — so it never dead-ends in a 404.
   */
  readonly canOpen: boolean;
  /** Owning application id — present ONLY when `canOpen` (the nav target the link needs). */
  readonly appId?: string;
}

function isPlainRecordObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Derive the SAFE human title of a record: the schema-designated title field's
 * value (via pickTitleFieldKey — the SAME picker the assistant digest uses,
 * T-0613), else a neutral `«{typeLabel} · <id8>»`. NEVER scans data in key order
 * for an arbitrary first field (that could surface a non-title/sensitive value
 * to a participant who lacks READ) — only the deliberately designated field.
 */
function deriveSafeRecordTitle(
  data: unknown,
  recordSchema: unknown,
  recordId: string,
  typeLabel: string,
): string {
  const obj = isPlainRecordObject(data) ? data : {};
  const key = pickTitleFieldKey(recordSchema);
  if (key !== null) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  const short = recordId.length >= 8 ? recordId.slice(0, 8) : recordId;
  return typeLabel.length > 0 ? `${typeLabel} · ${short}` : short;
}

/** Generic fallback type label — a domain-neutral noun, not a case literal (D-064). */
const GENERIC_RECORD_TYPE_LABEL = "Запись";

/**
 * T-0756: resolve the safe source-record projection for ONE record, tenant-scoped.
 *
 * `readVisibility` is the SAME `{grants, ancestry}` the T-0721 DETAIL gate resolves
 * once per request (NF-1). When it is `undefined` (resolveReadVisibility not wired —
 * honest-degrade, NF-2), READ-PDP is treated as open (matching records.ts's degrade)
 * and `canOpen` is decided by the sandbox gate alone.
 *
 * Returns `null` when the record no longer resolves in this tenant (deleted / foreign) —
 * the caller then omits `sourceRecord` (never a fabricated projection).
 */
export async function resolveSourceRecordProjection(
  pool: pg.Pool,
  tenantId: string,
  recordId: string,
  actorSlug: string,
  nowMs: number,
  readVisibility: { readonly grants: readonly Grant[]; readonly ancestry: AncestryOracle } | undefined,
): Promise<SourceRecordProjection | null> {
  const row = await withTenant(pool, tenantId, async (client) => {
    const res = await client.query<{
      id: string;
      registry_id: string;
      application_id: string;
      tier: string;
      created_by: string | null;
      data: unknown;
      record_schema: unknown;
      type_label: string | null;
    }>(
      `SELECT r.id, r.registry_id, rd.application_id, a.tier, r.created_by,
              r.data, rd.record_schema, rd.display_name AS type_label
         FROM choros.record r
         JOIN choros.registry_def rd
           ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
         JOIN choros.application a
           ON a.tenant_id = rd.tenant_id AND a.id = rd.application_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, recordId],
    );
    return res.rows[0] ?? null;
  });
  if (row === null) return null;

  // READ-PDP: the ONE containment predicate (isRecordReadable), fed the SAME
  // grants/ancestry the DETAIL gate uses. Absent resolver ⇒ honest-degrade open.
  const rowAncestry: RowAncestry = {
    recordId: row.id,
    registryId: row.registry_id,
    applicationId: row.application_id,
  };
  const readPdpOk =
    readVisibility === undefined
      ? true
      : isRecordReadable(rowAncestry, readVisibility.grants, readVisibility.ancestry, nowMs);

  // Sandbox openability (mirrors getRecordDetail's sandboxReadPredicate, T-0558):
  // a draft-tier record is hidden from a caller who is neither privileged nor its
  // creator. Only pay for the privilege resolve when a draft row would otherwise
  // be hidden (the branch that actually needs it).
  let actorIsPrivileged = false;
  if (row.tier === "draft" && row.created_by !== actorSlug) {
    const priv = await resolveActorPrivilege(pool, tenantId, actorSlug, nowMs);
    actorIsPrivileged = priv.isOwnerOrAdmin || priv.hasAuthoringDraftGrant;
  }
  const sandboxOpenable = actorIsPrivileged || row.tier !== "draft" || row.created_by === actorSlug;
  const canOpen = readPdpOk && sandboxOpenable;

  const typeLabel =
    typeof row.type_label === "string" && row.type_label.trim().length > 0
      ? row.type_label.trim()
      : GENERIC_RECORD_TYPE_LABEL;
  const title = deriveSafeRecordTitle(row.data, row.record_schema, row.id, typeLabel);

  return {
    id: row.id,
    title,
    typeLabel,
    canOpen,
    ...(canOpen ? { appId: row.application_id } : {}),
  };
}

/**
 * T-0756 per-hop ACL: is `actorSlug` a PARTICIPANT of instance `instanceId`?
 * A participant is entitled to the safe source-record projection even without a
 * READ grant on the source record (E16 §6). Tenant-scoped, fail-closed, reusing
 * merged authority only:
 *   (1) the actor APPEARS as an actor in this instance's append-only audit track
 *       (started / approved / claimed / next_task) — they ACTED on it; OR
 *   (2) the actor HOLDS the role of a task ever addressed on this instance
 *       (getRoleSlugsForActor ∩ the instance's audit task_role set) — eligible to
 *       act; ACTOR_ACTIVE-gated, so a deactivated role-holder resolves []; OR
 *   (3) the actor is the tenant OWNER (isGenesisOwnerForTenant, deactivation-safe).
 * A DB error in any resolver denies (never grants).
 */
export async function isInstanceParticipant(
  pool: pg.Pool,
  tenantId: string,
  instanceId: string,
  actorSlug: string,
  nowMs: number,
  fallbackSlug?: string,
): Promise<boolean> {
  if (!actorSlug) return false;

  const { actors, roles } = await withTenant(pool, tenantId, async (client) => {
    const res = await client.query<{
      actor: string | null;
      confirmed_by: string | null;
      task_role: string | null;
    }>(
      `SELECT actor, confirmed_by, payload->>'task_role' AS task_role
         FROM choros.audit_event
        WHERE tenant_id = $1 AND payload->>'inst' = $2`,
      [tenantId, instanceId],
    );
    const actorSet = new Set<string>();
    const roleSet = new Set<string>();
    for (const r of res.rows) {
      if (r.actor) actorSet.add(r.actor);
      if (r.confirmed_by) actorSet.add(r.confirmed_by);
      if (r.task_role) roleSet.add(r.task_role);
    }
    return { actors: actorSet, roles: roleSet };
  });

  // (1) acted on the instance.
  if (actors.has(actorSlug)) return true;
  if (fallbackSlug && fallbackSlug !== actorSlug && actors.has(fallbackSlug)) return true;

  // (2) holds the role of a task addressed on this instance (ACTOR_ACTIVE-gated).
  if (roles.size > 0) {
    try {
      const myRoles = await getRoleSlugsForActor(pool, tenantId, actorSlug, nowMs, fallbackSlug);
      if (myRoles.some((r) => roles.has(r))) return true;
    } catch {
      /* fail-closed: a role-resolution error never grants participant status */
    }
  }

  // (3) tenant owner (deactivation-safe).
  try {
    if (await isGenesisOwnerForTenant(pool, tenantId, actorSlug, nowMs)) return true;
  } catch {
    /* fail-closed */
  }
  return false;
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
  // T-0710 [E16, capstone T-0691 P2]: optional instance-id SCOPE, pushed into the
  // SQL WHERE clause of all four reads (every audit_event payload used here carries
  // `inst`). This is a HONEST narrowing — not a post-fetch filter over the LIMIT-
  // capped page: without it, a tenant with more than `limit` process.started rows
  // could have a specific instance's rows fall entirely outside the oldest-`limit`
  // window (ORDER BY occurred_at ASC LIMIT N), so an in-memory-only instance filter
  // downstream would silently see NOTHING for that instance even though it is real.
  // Scoping the WHERE clause itself means only THIS instance's (inherently few) rows
  // are fetched, independent of how many other instances the tenant has.
  instanceId?: string,
): Promise<{
  started: StartedRow[];
  endedInstanceIds: Set<string>;
  approvedTaskIds: Set<string>;
  nextTaskRows: NextTaskRow[];
}> {
  return withTenant(pool, tenantId, async (client) => {
    const instScope = instanceId ? ` AND payload->>'inst' = $4` : "";
    // $1 = type, $2 = tenantId, $3 = limit, $4 = instanceId (only when scoped) — the
    // SAME bind order for every one of the four queries below.
    const bind = (type: string): unknown[] =>
      instanceId ? [type, tenantId, limit, instanceId] : [type, tenantId, limit];

    const startedRes = await client.query<StartedRow>(
      `SELECT id, actor, payload, occurred_at::float8 AS occurred_at
         FROM choros.audit_event
        WHERE type = $1
          AND tenant_id = $2${instScope}
        ORDER BY occurred_at ASC
        LIMIT $3`,
      bind(PROCESS_STARTED_TYPE),
    );

    // T-0443: instance.ended → engine-gated done signal.
    const endedRes = await client.query<{ payload: Record<string, unknown> }>(
      `SELECT payload
         FROM choros.audit_event
        WHERE type = $1
          AND tenant_id = $2${instScope}
        ORDER BY occurred_at ASC
        LIMIT $3`,
      bind(INSTANCE_ENDED_TYPE),
    );

    // task.approved: kept for the listInstanceInboxTasks "hide base task after approve" logic.
    const approvedRes = await client.query<{ payload: Record<string, unknown> }>(
      `SELECT payload
         FROM choros.audit_event
        WHERE type = $1
          AND tenant_id = $2${instScope}
        ORDER BY occurred_at ASC
        LIMIT $3`,
      bind(TASK_APPROVED_TYPE),
    );

    // T-0443: process.next_task → post-gateway waiting task surfaced to inbox.
    const nextTaskRes = await client.query<NextTaskRow>(
      `SELECT id, payload, occurred_at::float8 AS occurred_at
         FROM choros.audit_event
        WHERE type = $1
          AND tenant_id = $2${instScope}
        ORDER BY occurred_at ASC
        LIMIT $3`,
      bind(NEXT_TASK_TYPE),
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

// ---------------------------------------------------------------------------
// T-0614 [деТЭЛ]: definitionName resolution — the honest replacement for the
// case-literal "Канонический линейный ТЭЛ" that used to be assigned to EVERY
// instance in processes.ts's projectionToInstance, regardless of its actual
// process. Reads choros.process_definition (074) inside the SAME tenant-scoped
// client this module already opens for the audit-event reads — one extra
// batched SELECT, no new pool/tx. Mirrors the DISTINCT ON latest-version
// pattern of src/http/process-catalog.ts's listProcessDefRows.
// ---------------------------------------------------------------------------

/**
 * Resolve { process_key → definition name } for the given keys, tenant-scoped.
 * Falls back to fallbackDefinitionName(key) (src/core/process-catalog-view.ts,
 * REUSED — not re-hardcoded here) for any key with no choros.process_definition
 * row (an engine-only definition, e.g. the seeded telLinear ТЭЛ). Never throws —
 * a DB error degrades every key to its honest fallback name (same
 * honest-degrade posture as the rest of this module's read half).
 */
async function resolveDefinitionNames(
  pool: pg.Pool,
  tenantId: string,
  procKeys: readonly string[],
): Promise<Map<string, string>> {
  const uniqueKeys = [...new Set(procKeys)];
  const names = new Map<string, string>();
  if (uniqueKeys.length === 0) return names;
  try {
    await withTenant(pool, tenantId, async (client) => {
      const { rows } = await client.query<{ process_key: string; name: string }>(
        `SELECT DISTINCT ON (process_key) process_key, name
           FROM choros.process_definition
          WHERE tenant_id = $1
            AND process_key = ANY($2::text[])
          ORDER BY process_key, version DESC`,
        [tenantId, uniqueKeys],
      );
      for (const r of rows) names.set(r.process_key, r.name);

      // T-0732 [E16, O-1 из T-0717]: SECOND (middle) tier — for keys with NO
      // modeler row (engine-source processes, e.g. telLinear deployed straight to
      // Flowable), resolve the human name from the tenant-scoped engine_process_name
      // overlay (migration 131) instead of demoting to the raw key. Precedence:
      // modeler row (above) > engine overlay (here) > fallbackDefinitionName (below).
      // Same tenant-scoped client → one tx; selectEngineProcessNames carries its own
      // explicit `WHERE tenant_id = $1` (+RLS) so a name from another tenant with the
      // same key can never leak here (T-0616 §F-1 class).
      const unresolved = uniqueKeys.filter((k) => !names.has(k));
      if (unresolved.length > 0) {
        const engineNames = await selectEngineProcessNames(client, tenantId, unresolved);
        for (const [key, name] of engineNames) names.set(key, name);
      }
    });
  } catch {
    // Honest degrade: every key falls back below (DB error is not fatal to the
    // read — the instance list must still render with honest fallback names).
  }
  for (const key of uniqueKeys) {
    if (!names.has(key)) names.set(key, fallbackDefinitionName(key));
  }
  return names;
}

// ---------------------------------------------------------------------------
// T-0614 [деТЭЛ]: starterActorKind resolution — the honest replacement for the
// case-literal execs=["human","agent"] unconditionally assigned to every
// instance. Resolves choros.employee.kind for the actor that STARTED each
// instance (the only actor concretely bound to an InstanceProjection today),
// mirroring the actorKind pattern in src/http/inbox.ts:1370-1379. Non-fatal
// degrade to "human" per-actor when the employee is not found or the resolve
// errors (findEmployeeById itself never throws on a not-found row — a thrown
// error here means a genuine DB-connectivity failure).
// ---------------------------------------------------------------------------

/** Resolve { actor slug → "human" | "agent" } for the given actors, tenant-scoped. */
async function resolveActorKinds(
  pool: pg.Pool,
  tenantId: string,
  actors: readonly string[],
): Promise<Map<string, "human" | "agent">> {
  const uniqueActors = [...new Set(actors)];
  const kinds = new Map<string, "human" | "agent">();
  await Promise.all(
    uniqueActors.map(async (actor) => {
      try {
        const emp = await findEmployeeById(pool, tenantId, actor);
        kinds.set(actor, emp?.type === "agent" ? "agent" : "human");
      } catch {
        // Honest degrade: unresolved actor ⇒ "human" (mirrors inbox.ts's actorKind
        // default — accurate for the common human pool-task-approve path).
        kinds.set(actor, "human");
      }
    }),
  );
  return kinds;
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
  // T-0614 [деТЭЛ]: count of APPROVED process.next_task rows per instance — the
  // post-gateway steps this instance has ALREADY completed (symmetric to the
  // pending-map above, which tracks the NOT-yet-approved ones). Feeds stepsDone
  // below; replaces the hardcoded {done:2,total:3}/{done:3,total:3} literal.
  const approvedNextTaskCountByInst = new Map<string, number>();
  // T-0710 [E16, capstone T-0691 P2]: instances that have AT LEAST ONE next_task
  // row — approved OR pending. Mirrors the T-0608 rule already proven below in
  // listInstanceInboxTasks ("instancesWithNextTask"): every next_task emit site
  // (reconcileInstanceTimers / reconcileInstanceEngineDrive / deliverMessageEnvelope
  // / surfaceMessageCatchWaits, and the ordinary post-gateway-approve path) only
  // appends a row after confirming — via a LIVE engine.getActiveUserTasks call —
  // that the engine already moved to a genuinely NEW active task. So a next_task
  // row's mere EXISTENCE is itself proof the base step is no longer the engine's
  // live task, independent of whether the base row's OWN task.approved audit event
  // was ever recorded. Without this, a legacy/malformed audit trail (base row
  // missing its task.approved — e.g. an older write path, or history pruning) makes
  // listInstanceProjections show BOTH the stale base step and the real next step as
  // if they were concurrent AND-split branches, when they are actually SEQUENTIAL
  // (found live: instance-detail «Текущий шаг» listing two steps for one token).
  const instancesWithAnyNextTask = new Set<string>();
  // T-0710: the role of the FIRST pending next_task row per instance (its
  // task_role) — lets the primary `role` field below follow the SAME supersession
  // fix as `step` (both become concurrentSteps[0]'s facts), preserving the
  // step===concurrentSteps[0] invariant the catalog/detail/inbox read planes all
  // rely on (T-0709/T-0718 single-source-of-truth), instead of swapping the
  // divergence from "detail vs catalog" to "concurrentSteps[0] vs step/role".
  const firstPendingNextRoleByInst = new Map<string, string>();
  for (const ntRow of nextTaskRows) {
    const p = (ntRow.payload ?? {}) as Record<string, unknown>;
    const ntInst = p["inst"];
    if (typeof ntInst !== "string" || ntInst.length === 0) continue;
    instancesWithAnyNextTask.add(ntInst);
    if (approvedTaskIds.has(ntRow.id)) {
      approvedNextTaskCountByInst.set(ntInst, (approvedNextTaskCountByInst.get(ntInst) ?? 0) + 1);
      continue;
    }
    pendingNextTaskInstanceIds.add(ntInst);
    const stepLabel = strField(p, "task_step", APPROVE_STEP);
    const arr = concurrentNextStepsByInst.get(ntInst);
    if (arr === undefined) {
      concurrentNextStepsByInst.set(ntInst, [stepLabel]);
      firstPendingNextRoleByInst.set(ntInst, strField(p, "task_role", APPROVER_ROLE));
    } else if (!arr.includes(stepLabel)) {
      arr.push(stepLabel);
    }
  }

  // T-0614 [деТЭЛ]: resolve procKey ONCE per row up front (reused below both for the
  // batched definitionName/actorKind lookups AND the final per-row map — avoids
  // re-deriving the same fallback-defaulted field twice per row). Keyed by ARRAY
  // INDEX, not row.id — `id` is the audit_event id (normally a fresh randomUUID per
  // event, but not a field this function should assume unique to safely key on).
  // Reuses the SAME DEFAULT_PROC_KEY named constant the rest of this module already
  // falls back to (no new literal occurrence added — see the constant's own
  // definition).
  const procKeyByIndex = started.map((row) =>
    strField((row.payload ?? {}) as Record<string, unknown>, "proc_key", DEFAULT_PROC_KEY),
  );

  // T-0614 [деТЭЛ]: resolve definitionName (per procKey) and starterActorKind (per
  // actor) ONCE, batched over the distinct values in this page — not per-row, and
  // not a new pool/tx (definitionName read shares this module's tenant-scoped
  // withTenant client; starterActorKind reuses findEmployeeById's own withTenant).
  const [definitionNames, actorKinds] = await Promise.all([
    resolveDefinitionNames(pool, tenantId, procKeyByIndex),
    resolveActorKinds(pool, tenantId, started.map((row) => row.actor)),
  ]);

  return started.map((row, rowIndex): InstanceProjection => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const inst = strField(payload, "inst", `instance:${row.id}`);
    const procKey = procKeyByIndex[rowIndex] ?? DEFAULT_PROC_KEY;
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
    // T-0614 [деТЭЛ] / T-0710: baseApproved computed ONCE and reused below (was
    // duplicated — one copy scoped inside the old `if (!done)` block, one for
    // stepsDone — risking the two silently drifting apart).
    const baseApproved = approvedTaskIds.has(row.id);
    // T-0710 [E16, capstone T-0691 P2]: true when a next_task row exists for this
    // instance (approved or pending) — proof (see instancesWithAnyNextTask above)
    // that the base step is superseded even though its OWN task.approved was never
    // recorded (a legacy/malformed audit row, the exact live-found symptom).
    const baseSuperseded = instancesWithAnyNextTask.has(inst);
    // T-0456 [D8-R1]: assemble the concurrent waiting steps. The base process.started
    // step is waiting until its own task.approved arrives (approvedTaskIds.has(row.id))
    // AND it has not been superseded by a next_task row (T-0710); pending next_task
    // rows add the post-split concurrent branches. A done instance has no waiting steps.
    const concurrentSteps: string[] = [];
    if (!done) {
      if (!baseApproved && !baseSuperseded) concurrentSteps.push(step);
      for (const ntStep of concurrentNextStepsByInst.get(inst) ?? []) {
        if (!concurrentSteps.includes(ntStep)) concurrentSteps.push(ntStep);
      }
      // Defensive: a waiting instance should always show at least its primary step.
      if (concurrentSteps.length === 0) concurrentSteps.push(step);
    }
    // T-0710: the primary step/role follow concurrentSteps[0] — the array's own
    // primary/first entry BY CONSTRUCTION (see the assembly above) — instead of
    // unconditionally echoing the base row's raw task_step/task_role. Before this,
    // `step`/`role` were the base's raw fields NO MATTER what concurrentSteps said,
    // even in the ALREADY-correctly-audited case (baseApproved=true, a pending
    // next_task row present, e.g. the 6M branch) — concurrentSteps rightly excluded
    // the base there too, but the primary fields silently kept echoing it (a
    // pre-existing gap this task's live-found symptom shares the root cause with).
    // Any read surface that shows the SINGLE primary field (the inbox drawer's
    // «Текущий шаг» — StepRef — and the /api/process-catalog admin list, neither of
    // which carries a nodes/concurrentSteps array) would otherwise still show the
    // stale/next-labelled base step while the detail page's nodes[] correctly moved
    // on — reintroducing a T-0709-class divergence between read surfaces.
    // `role` only swaps to the next-task's role when the primary actually moved off
    // the base's own label (concurrentSteps[0] !== step); firstPendingNextRoleByInst
    // has no entry when concurrentSteps[0] fell back to `step` itself (the defensive
    // re-add below, when the base is superseded but no PENDING next_task remains) —
    // the `?? role` degrade then keeps the base's own (still-accurate) role.
    const primaryStep = !done && concurrentSteps.length > 0 ? concurrentSteps[0]! : step;
    const primaryRole =
      !done && concurrentSteps.length > 0 && concurrentSteps[0] !== step
        ? (firstPendingNextRoleByInst.get(inst) ?? role)
        : role;
    // T-0614 [деТЭЛ]: honest "known so far" step count — replaces the hardcoded
    // 3-node-ТЭЛ progress literal. stepsDone = base approve (if approved) + approved
    // next_task rows for this instance; stepsKnownTotal = stepsDone (done instance,
    // no further steps this projection can honestly claim) or stepsDone + the
    // CURRENTLY waiting concurrent steps (non-done instance).
    const stepsDone = (baseApproved ? 1 : 0) + (approvedNextTaskCountByInst.get(inst) ?? 0);
    const stepsKnownTotal = done ? stepsDone : stepsDone + concurrentSteps.length;
    return {
      inst,
      procKey,
      role: primaryRole,
      step: done ? "Завершено" : primaryStep,
      status: done ? "done" : "waiting",
      startedAt: row.occurred_at,
      // row.id == process.started event id == inbox_task_id (self-referential back-link).
      // Surfaces on the projection so callers can correlate by taskId without a separate lookup.
      inboxTaskId: row.id,
      concurrentSteps,
      definitionName: definitionNames.get(procKey) ?? fallbackDefinitionName(procKey),
      stepsDone,
      stepsKnownTotal,
      starterActorKind: actorKinds.get(row.actor) ?? "human",
      // T-0654 [part A]: the raw starter actor id (same source as starterActorKind's
      // lookup). The display plane resolves it to a name / evaluates ?mine= against it.
      starterActorId: row.actor,
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
 *
 * T-0608 (пункт б, живой факт приёмки: «Заказ поставщику» showed TWICE — the
 * base process.started row AND a process.next_task row, with two different
 * deadlines). The base row was previously hidden ONLY on its OWN
 * task.approved (a human/our-endpoint action) or instance.ended — but a
 * process.next_task row can appear via a DIFFERENT path (timer escalation,
 * T-0458; engine-drive reconcile, T-0522/T-0571; message delivery, T-0459)
 * WITHOUT ever touching the base row's own task.approved. Every one of those
 * four emit sites (reconcileInstanceTimers / reconcileInstanceEngineDrive /
 * deliverMessageEnvelope / surfaceMessageCatchWaits) only appends a
 * process.next_task after confirming — via a LIVE engine.getActiveUserTasks
 * call — that the engine has moved to a genuinely NEW active task for that
 * instance. So the mere EXISTENCE of any process.next_task row for an
 * instance is itself proof the base step is no longer the engine's live task
 * for that instance, independent of whether OUR audit trail ever recorded an
 * explicit approve for the base row. The base row is now ALSO hidden once the
 * instance has at least one next_task row (regardless of that next_task's own
 * approved state — its mere presence proves the base step was already
 * superseded when it was emitted).
 */
export async function listInstanceInboxTasks(
  pool: pg.Pool,
  tenantId: string,
  opts?: {
    limit?: number;
    /**
     * T-0710 [E16, capstone T-0691 P2]: scope the read to ONE instance's rows,
     * pushed into readEvents's SQL WHERE clause (not a post-fetch filter) — see
     * readEvents's doc comment for why this matters (LIMIT-window truncation).
     */
    instanceId?: string;
  },
): Promise<InstanceInboxTask[]> {
  const limit = Math.min(opts?.limit ?? 200, 500);
  const { started, endedInstanceIds, approvedTaskIds, nextTaskRows } = await readEvents(
    pool,
    tenantId,
    limit,
    opts?.instanceId,
  );

  // T-0608 (пункт б): instances that have AT LEAST ONE process.next_task row
  // (approved or not) — proof the engine already advanced past the base step.
  const instancesWithNextTask = new Set<string>();
  for (const row of nextTaskRows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const inst = strField(payload, "inst", "");
    if (inst) instancesWithNextTask.add(inst);
  }

  // T-0683 (D-064, wave-5 human-layer): resolve the HUMAN process-definition name
  // for every distinct procKey across the surfaced tasks in ONE batched SELECT
  // (resolveDefinitionNames — the SAME helper listInstanceProjections already uses,
  // REUSED here, not re-hardcoded). This lets the inbox «ПРОЦЕСС» column show a
  // human process name as the PRIMARY identifier instead of the raw instance-UUID.
  // record_id is read per-row from the payload below (already persisted by
  // appendProcessStarted / appendNextTaskEvent) — no extra query.
  const procKeysForRows: string[] = [];
  for (const row of started) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    procKeysForRows.push(strField(p, "proc_key", DEFAULT_PROC_KEY));
  }
  for (const row of nextTaskRows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    procKeysForRows.push(strField(p, "proc_key", DEFAULT_PROC_KEY));
  }
  const definitionNames = await resolveDefinitionNames(pool, tenantId, procKeysForRows);
  const nameForKey = (procKey: string): string =>
    definitionNames.get(procKey) ?? fallbackDefinitionName(procKey);
  // T-0683: read record_id from a payload (present when started via on_create).
  const recordIdOf = (payload: Record<string, unknown>): string | undefined => {
    const raw = payload["record_id"];
    return typeof raw === "string" && raw.length > 0 ? raw : undefined;
  };

  const tasks: InstanceInboxTask[] = [];

  // 1. Base process.started rows (hide once approved, OR instance ended, OR
  //    superseded by a process.next_task row — T-0608 пункт б).
  for (const row of started) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const inst = strField(payload, "inst", `instance:${row.id}`);
    if (approvedTaskIds.has(row.id)) continue; // base approve done → hide base task.
    if (endedInstanceIds.has(inst)) continue; // instance ended → no more tasks.
    if (instancesWithNextTask.has(inst)) continue; // superseded by a live next_task (T-0608 б).
    tasks.push({
      id: row.id,
      role: strField(payload, "task_role", APPROVER_ROLE),
      name: strField(payload, "task_name", APPROVE_TASK_NAME),
      step: strField(payload, "task_step", APPROVE_STEP),
      inst,
      procKey: strField(payload, "proc_key", DEFAULT_PROC_KEY),
      // T-0683: human process name (batched) + originating record id (from payload).
      processName: nameForKey(strField(payload, "proc_key", DEFAULT_PROC_KEY)),
      ...(recordIdOf(payload) !== undefined ? { recordId: recordIdOf(payload) } : {}),
      occurredAt: row.occurred_at,
      // T-0571 (BUG-014 fix): base process.started rows no longer assert a literal
      // BPMN defKey — the projection does not know (and a GENERIC process's author
      // may have named the node anything) which engine taskDefinitionKey is currently
      // active. `null` is the RESOLVE-BY-INSTANCE signal: the approve handler's
      // engine-drive reconcile resolves the target task as "the active user-task of
      // this instanceId" (see reconcileInstanceEngineDrive), not by string equality.
      taskDefKey: null,
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
      procKey: strField(payload, "proc_key", DEFAULT_PROC_KEY),
      // T-0683: human process name (batched) + originating record id (from payload).
      processName: nameForKey(strField(payload, "proc_key", DEFAULT_PROC_KEY)),
      ...(recordIdOf(payload) !== undefined ? { recordId: recordIdOf(payload) } : {}),
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
  // T-0571: the BASE row's own recorded role, per instance, when the base is still
  // unresolved (taskDefKey=null — not yet approved, real engine defKey unknown to the
  // projection). Used by the exclusion rule below to recognise "the base step's own
  // still-active task" without a ТЭЛ-specific literal.
  const unresolvedBaseRoleByInst = new Map<string, string>();
  for (const t of projectedTasks) {
    let set = projectedDefKeysByInst.get(t.inst);
    if (set === undefined) {
      set = new Set<string>();
      projectedDefKeysByInst.set(t.inst, set);
    }
    if (t.taskDefKey !== null) {
      set.add(t.taskDefKey);
    } else {
      unresolvedBaseRoleByInst.set(t.inst, t.role);
    }
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
    const unresolvedBaseRole = unresolvedBaseRoleByInst.get(inst);
    const emittedThisPass = new Set<string>();

    for (const engineTask of engineResult.tasks) {
      const defKey = engineTask.taskDefinitionKey;
      if (projectedDefKeys.has(defKey)) continue; // already on screen.
      // T-0571 (regression guard, generic — not a ТЭЛ literal): while the base row is
      // still unresolved (not yet approved), the engine's active-task set legitimately
      // contains the base step's OWN still-pending task — the projection just does not
      // know its defKey yet (T-0571 §2.1: resolved live at approve time, not guessed).
      // A genuinely NEW timer-fired escalation task is, by the T-0458 escalation-mapper
      // design (timer-escalation-mapper.ts), addressed to a DIFFERENT role (the
      // escalation target userTask carries its OWN candidateGroups — manager/owner/an
      // explicit role — never the base step's own role). So: an active task whose
      // candidateGroups still overlaps the base row's OWN recorded role is the base
      // step itself (unfired) — not a new escalation — and must not be surfaced twice.
      if (
        unresolvedBaseRole !== undefined &&
        engineTask.candidateGroups.includes(unresolvedBaseRole)
      ) {
        continue;
      }
      if (emittedThisPass.has(defKey)) continue; // dedup within this pass.
      emittedThisPass.add(defKey);

      const role = engineTask.candidateGroups[0] ?? APPROVER_ROLE;
      const procKey = procKeyByInst.get(inst) ?? DEFAULT_PROC_KEY;
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
// T-0522 — durable, idempotent engine-drive reconcile (Option A hardening).
//
// Background: the post-approve engine-drive in inbox.ts (T-0443/T-0456) ran as a
// `void (async()=>{…})()` fire-and-forget IIFE that swallowed every engine/DB error
// to console.warn. A DMN-gateway-spawned second task («Доп.согласование» on the 6M
// branch) could therefore SILENTLY never appear if the async lost the timing race
// or the engine hiccuped — the prime suspect for CS-1 flakiness (ADR-T0432 §3.1).
//
// This function extracts that reconcile into ONE named, idempotent, error-EXPLICIT
// operation reused by BOTH callers:
//   1. the post-approve path (inbox.ts approve handler) — completes the engine user
//      task then reconciles the resulting token set, and
//   2. the reconcile-on-read net (inbox.ts GET /api/inbox) — re-drives any instance
//      that is approved-but-not-ended-and-has-no-pending-next-task, so a gateway task
//      the post-approve async missed self-heals on the next read.
//
// It is the engine-drive analogue of reconcileInstanceTimers (T-0458) /
// deliverMessageEnvelope (T-0459): same dedup-by-defKey idempotency, same honest
// engine port — but unlike the old IIFE it RETURNS the engine error instead of
// swallowing it, so callers (and tests) can observe a failed reconcile rather than a
// silent drop. NO schema change (additive — same process.next_task / instance.ended
// event model).
// ---------------------------------------------------------------------------

/**
 * Engine port for the durable engine-drive reconcile — the subset of FlowableClient
 * the post-approve / reconcile-on-read drive needs. Kept structural so this module
 * stays decoupled from the concrete client type (mirrors TimerReconcileEnginePort).
 */
export interface EngineDriveReconcilePort {
  getActiveUserTasks(
    instanceId: string,
  ): Promise<
    | { ok: true; tasks: ActiveEngineTask[] }
    | { ok: false; code: string }
  >;
  completeUserTask(
    engineTaskId: string,
  ): Promise<{ ok: true } | { ok: false; code: string }>;
  isInstanceEnded(
    instanceId: string,
  ): Promise<
    | { ok: true; ended: boolean }
    | { ok: false; code: string }
  >;
}

/** Outcome of a single engine-drive reconcile pass — explicit, never swallowed. */
export type EngineDriveResult =
  | {
      /** The reconcile completed (engine reachable). */
      readonly ok: true;
      /** True when the engine confirmed the instance ended → instance.ended emitted. */
      readonly ended: boolean;
      /** Number of NEW process.next_task rows emitted this pass (0 when nothing new). */
      readonly emitted: number;
      /** True when a matching engine user-task was found+completed this pass. */
      readonly completed: boolean;
      /**
       * T-0571 (NF-2/AC-8): true when `completed` is false ONLY because the instance
       * was ALREADY ended by a prior (idempotent-equivalent) drive — a legitimate
       * repeat, not a structural failure. The caller (inbox.ts) uses this to answer
       * 200 {engine:"already"} instead of treating a no-op completion as a silent
       * success indistinguishable from a real completion.
       */
      readonly alreadyEnded?: boolean;
    }
  | {
      /** The engine could not be reached / returned an error — NOT swallowed. */
      readonly ok: false;
      /** Typed engine error code (e.g. ENGINE_UNAVAILABLE, NOT_FOUND, or the T-0571
       *  structural codes ENGINE_TASK_NOT_FOUND / AMBIGUOUS_ACTIVE_TASK below). */
      readonly code: string;
      /** Which engine step failed (diagnostic). */
      readonly stage: "poll" | "complete" | "ended" | "next-tasks";
    };

/**
 * T-0571 (BUG-014 fix, ADR §4 FF-1): structural engine-drive error codes — the target
 * user-task for THIS instance was not found among the live active user-tasks (not a
 * transport/HTTP failure, a genuine mismatch between "what the approve action expected
 * to complete" and "what the engine currently has active"). Returned instead of the
 * old silent `{ok:true, completed:false}` (AC-7's "main evil").
 */
export const ENGINE_TASK_NOT_FOUND = "ENGINE_TASK_NOT_FOUND";
/**
 * T-0571 §2.1 contract: a BASE (process.started, resolve-by-instance) step must see
 * EXACTLY ONE active user-task for its instance at the moment of approve (the base
 * process.started event represents exactly one waiting human step by construction —
 * branches/AND-splits arrive as process.next_task with an already-real defKey, never
 * as a base row). More than one active user-task for a base-step instance is a
 * structural anomaly: honest refusal (this code) beats guessing "the first" and
 * completing the wrong token.
 */
export const AMBIGUOUS_ACTIVE_TASK = "AMBIGUOUS_ACTIVE_TASK";

/**
 * T-0591 (F-2, ADR-T0591-drive-deadline §2.2/§4): the OVERALL post-approve
 * drive-path deadline was exhausted before the reconcile finished — NOT a
 * transport/HTTP failure reported BY the engine, but the product choosing to
 * stop waiting. Distinct from ENGINE_TASK_NOT_FOUND/AMBIGUOUS_ACTIVE_TASK
 * (those are engine-observed structural facts); this one means "we don't
 * know what the engine did" — the underlying engine call may have completed
 * moments later. See ADR §2.2: reconcile-on-read (T-0522) self-heals the
 * projection on the NEXT read regardless of which outcome actually occurred.
 */
export const ENGINE_DRIVE_TIMEOUT = "ENGINE_DRIVE_TIMEOUT";

/** Sentinel returned by callWithBudget's race when the shared deadline wins. */
const BUDGET_EXHAUSTED = Symbol("BUDGET_EXHAUSTED");

/**
 * T-0591 (F-2): race a single engine-port call against the REMAINING slice of a
 * shared wall-clock deadline. Local to this module — deliberately NOT imported
 * from flowable-client.ts's internal makeTimeoutPromise/TIMEOUT_SENTINEL (those
 * are unexported implementation details of withRetry) and deliberately NOT a
 * change to FlowableClient/withRetry themselves (ADR §2.1/§3 B1: threading
 * AbortSignal through the whole client interface would widen blast radius to
 * deploy/start/fetchAndLock/failTask/etc., which this deadline has nothing to
 * do with). Mirrors the SAME Promise.race+timer-sentinel pattern already used by
 * flowable-client.ts's withRetry/pingEngine — same technique, applied one layer
 * up, over the port's already-promise-returning methods.
 *
 * - remaining <= 0: does NOT invoke `fn` at all (no point starting a call that
 *   cannot possibly finish in budget) — returns exhausted immediately.
 * - otherwise: races `fn()` against a timer for `remaining` ms. If the timer
 *   wins, the (still in-flight, withRetry-wrapped) call to the engine is simply
 *   no longer awaited here — it is NOT actively aborted (no AbortController
 *   plumbed to fetch, see ADR §2.1) and may still complete against the engine
 *   moments later with no observer on this side. This IS the source of the
 *   "timeout ≠ guaranteed non-success" semantics the spec requires (§2.2 NF-1):
 *   the caller cannot know whether the underlying operation eventually
 *   succeeded — reconcile-on-read (T-0522) is what closes that gap on the next
 *   read, not this function.
 */
async function callWithBudget<T>(
  fn: () => Promise<T>,
  deadlineAt: number,
): Promise<T | typeof BUDGET_EXHAUSTED> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return BUDGET_EXHAUSTED;

  return new Promise<T | typeof BUDGET_EXHAUSTED>((resolve, reject) => {
    const timer = setTimeout(() => resolve(BUDGET_EXHAUSTED), remaining);
    fn().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Durable, idempotent engine-drive reconcile for ONE instance.
 *
 * Flow (mirrors the original T-0443/T-0456 IIFE, but as a reusable error-explicit fn):
 *  1. If `completeEngineTask` is set (post-approve path) AND `approvedTaskDefKey` is
 *     given, poll the engine (up to pollTimeoutMs) for the user-task matching that
 *     defKey, then completeUserTask(engineTaskId). On the reconcile-on-read path
 *     `completeEngineTask` is false → step 1 is skipped (we only mirror state).
 *  2. isInstanceEnded → emit instance.ended (engine-gated done), OR
 *  3. surface EVERY live engine user-task not yet projected as a process.next_task
 *     (the T-0456 AND-split fan-out; the 6M «Доп.согласование» gateway task included).
 *
 * IDEMPOTENT (the load-bearing property): re-running on the same engine token set
 * does NOT duplicate tasks/events. Dedup is by taskDefKey against the live projection
 * (listInstanceInboxTasks) + within-pass; instance.ended is hidden-folded once present
 * and a re-emit is harmless (the projection treats a second ended row as the same done).
 * Completing an already-completed engine task is tolerated (engine returns NOT_FOUND
 * → idempotentSuccess-style; we proceed to reconcile regardless).
 *
 * ERROR-EXPLICIT: an unreachable engine returns { ok:false, code, stage } — the caller
 * decides (post-approve logs + relies on the on-read net to retry; on-read swallows so
 * the 200 is never blocked, but the NEXT read retries). Nothing is silently lost.
 *
 * @returns EngineDriveResult — never throws past this boundary for engine/DB hiccups
 *   in the emit loop (a failed emit is retried on the next pass); a hard programmer
 *   error (e.g. bad UUID) still throws as before.
 */
export async function reconcileInstanceEngineDrive(
  pool: pg.Pool,
  tenantId: string,
  engine: EngineDriveReconcilePort,
  args: {
    readonly instanceId: string;
    readonly procKey: string;
    /**
     * The defKey of the just-approved step (post-approve path), when it is a REAL
     * engine defKey already known to the projection (a process.next_task row, e.g.
     * the 6M "task-extra-approve" branch — those always carry the engine's own key).
     * OMITTED (undefined/null) for a BASE (process.started) step — T-0571 (BUG-014):
     * the base step is resolved by INSTANCE IDENTITY (§resolveByInstance below), not
     * by string-matching a literal, because a GENERIC process's author may have named
     * its first user-task anything. When omitted AND `completeEngineTask` is true, the
     * engine-drive resolves "the active user-task of this instanceId" directly (see
     * §2.1 contract: exactly one is expected; 0 → idempotent-already-ended or
     * structural failure; >1 → AMBIGUOUS_ACTIVE_TASK).
     */
    readonly approvedTaskDefKey?: string | null;
    /** When true (post-approve), complete the matching engine user-task before
     *  reconciling. When false/absent (on-read), skip completion — only mirror. */
    readonly completeEngineTask?: boolean;
    readonly actor: string;
    readonly nowMs?: number;
    /** Poll budget for finding the engine task to complete (post-approve only). */
    readonly pollTimeoutMs?: number;
    readonly pollIntervalMs?: number;
    /**
     * T-0591 (F-2, ADR-T0591-drive-deadline §2.4): OVERALL wall-clock budget (ms)
     * for the ENTIRE post-approve drive path (poll loop + completeUserTask + both
     * isInstanceEnded checks + fan-out getActiveUserTasks) — an INDEPENDENT ceiling
     * from pollTimeoutMs. pollTimeoutMs bounds "how long to wait between poll
     * iterations for a healthy-but-not-yet-routed engine"; driveDeadlineMs bounds
     * "how long the WHOLE synchronous approve HTTP response may take even if a
     * SINGLE engine-port call itself hangs/degrades" (the F-2 finding: a single
     * withRetry-wrapped call can stretch to ~40s+ on a slow engine, which
     * pollTimeoutMs alone does not interrupt because it is only checked BETWEEN
     * iterations, never around an in-flight call). Default 10_000.
     */
    readonly driveDeadlineMs?: number;
  },
): Promise<EngineDriveResult> {
  const nowMs = args.nowMs ?? Date.now();
  const pollTimeoutMs = args.pollTimeoutMs ?? 10_000;
  const pollIntervalMs = args.pollIntervalMs ?? 500;
  const driveDeadlineMs = args.driveDeadlineMs ?? 10_000;
  // T-0591: computed ONCE, at the top — shared by every engine-port call below via
  // callWithBudget. This is a WALL-CLOCK instant (epoch-ms), not a duration.
  const deadlineAt = Date.now() + driveDeadlineMs;

  let completed = false;
  let alreadyEnded = false;
  // T-0571: the REAL defKey that ended up completed this pass — either the caller's
  // own `approvedTaskDefKey` (next_task/literal path) or the defKey resolved live from
  // the engine (base/resolve-by-instance path). Used by step 3 below to exclude the
  // just-completed step from the "surface next tasks" fan-out (it is never its own
  // successor). Stays undefined when nothing was completed this pass.
  let completedDefKey: string | undefined;
  // T-0571 §2.1: resolve-by-instance mode when the caller has no real defKey to match
  // (the base process.started step) but still wants completion driven. The literal-key
  // path (`approvedTaskDefKey` present) stays for process.next_task steps, whose defKey
  // IS the engine's own key (read from a live getActiveUserTasks call earlier — never a
  // guessed literal) — matching by string there is matching by an authoritative value,
  // not a ТЭЛ-specific hardcode.
  const resolveByInstance = Boolean(args.completeEngineTask) && !args.approvedTaskDefKey;

  // 1. Post-approve completion (skipped on the reconcile-on-read net).
  if (args.completeEngineTask && (args.approvedTaskDefKey || resolveByInstance)) {
    let engineTaskId: string | null = null;
    let resolvedDefKey: string | undefined = args.approvedTaskDefKey ?? undefined;
    const pollStart = Date.now();
    // Poll for the engine user-task to complete (the triage external task / DMN gateway
    // variable may still be in flight). The gateway routing variable (approvalRequired /
    // TEL_GATEWAY_VAR) is injected UPSTREAM at the tel-intake seam (externalTaskBridge.ts)
    // BEFORE this point — completeUserTask takes no variables, it only advances the
    // already-routed token. We must not complete until the target task is actually
    // present (so we never complete the wrong/stale token).
    for (;;) {
      // T-0591 (FF-1): race this poll-tick's engine call against the SHARED
      // deadline, not just the per-call withRetry timeout. remaining<=0 short-
      // circuits without even starting the call (see callWithBudget doc-comment).
      const tasksResult = await callWithBudget(
        () => engine.getActiveUserTasks(args.instanceId),
        deadlineAt,
      );
      if (tasksResult === BUDGET_EXHAUSTED) {
        return { ok: false, code: ENGINE_DRIVE_TIMEOUT, stage: "poll" };
      }
      if (!tasksResult.ok) {
        return { ok: false, code: tasksResult.code, stage: "poll" };
      }

      if (resolveByInstance) {
        // T-0571 §2.1 contract: the base step owns EXACTLY ONE active user-task for
        // this instance by construction. 0 active tasks this poll tick just means "not
        // routed yet" (or already ended) — keep polling/exit below; >1 is a genuine
        // structural anomaly, not a timing artifact, so it fails FAST (no point polling
        // longer — the ambiguity will not resolve itself).
        if (tasksResult.tasks.length > 1) {
          return { ok: false, code: AMBIGUOUS_ACTIVE_TASK, stage: "poll" };
        }
        if (tasksResult.tasks.length === 1) {
          const only = tasksResult.tasks[0];
          if (only) {
            engineTaskId = only.id;
            resolvedDefKey = only.taskDefinitionKey;
          }
          break;
        }
        // length === 0 → fall through to the ended-check below (idempotent-already vs
        // structural-not-found is decided AFTER isInstanceEnded, not guessed here).
      } else {
        const match = tasksResult.tasks.find(
          (t) => t.taskDefinitionKey === args.approvedTaskDefKey,
        );
        if (match) {
          engineTaskId = match.id;
          break;
        }
      }
      // No matching/active task and no tasks at all → instance may have ended; stop polling.
      if (tasksResult.tasks.length === 0) break;
      if (Date.now() - pollStart >= pollTimeoutMs) break;
      // T-0591 (ADR §2.3): the shared deadline is a SECOND, independent ceiling on
      // top of pollTimeoutMs — effective loop bound is min(pollTimeoutMs, remaining
      // budget). Breaking here (rather than looping once more) falls through to the
      // same "engineTaskId still null" path below; the very next engine call
      // (completeUserTask is skipped since engineTaskId is null, so it lands on the
      // isInstanceEnded pre-ended-check) will itself immediately hit
      // BUDGET_EXHAUSTED via callWithBudget (remaining<=0) — no separate branch
      // needed, the timeout cascades through the existing control flow.
      if (Date.now() >= deadlineAt) break;
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    if (engineTaskId) {
      // T-0591 (FF-1): budget-race the completion call too — this is THE call
      // whose outcome the timeout semantics are most about (§2.2 NF-1 of the
      // spec): if the budget wins here, the completeUserTask request may still
      // land at the engine moments later — we simply stop waiting for it.
      const completeResult = await callWithBudget(
        () => engine.completeUserTask(engineTaskId as string),
        deadlineAt,
      );
      if (completeResult === BUDGET_EXHAUSTED) {
        return { ok: false, code: ENGINE_DRIVE_TIMEOUT, stage: "complete" };
      }
      // NOT_FOUND ⇒ already completed (idempotent re-run / concurrent drive). Proceed.
      if (!completeResult.ok && completeResult.code !== "NOT_FOUND") {
        return { ok: false, code: completeResult.code, stage: "complete" };
      }
      completed = true;
      completedDefKey = resolvedDefKey;
    } else {
      // T-0571 (AC-7, "main evil"): no target task was found to complete. Distinguish
      // a LEGITIMATE idempotent repeat (the instance is already ended — nothing was
      // ever going to be there to complete) from a genuine structural failure (the
      // instance is NOT ended, yet no active user-task matched what we expected to
      // complete — the old silent BUG-014 path). We cannot know which until we check
      // isInstanceEnded, so defer the verdict to step 2 by recording that completion
      // was attempted-but-empty; step 2 returns ENGINE_TASK_NOT_FOUND when not ended.
      resolvedDefKey = undefined;
    }

    if (!completed) {
      // Completion did not happen this pass — find out WHY before proceeding.
      // T-0591: if the shared budget is already exhausted (e.g. the poll loop
      // above broke on the deadline, not on pollTimeoutMs/empty-list), this call
      // short-circuits to BUDGET_EXHAUSTED without a network round-trip — the
      // timeout cascades through the existing control flow (ADR §2.3).
      const preEndedResult = await callWithBudget(
        () => engine.isInstanceEnded(args.instanceId),
        deadlineAt,
      );
      if (preEndedResult === BUDGET_EXHAUSTED) {
        return { ok: false, code: ENGINE_DRIVE_TIMEOUT, stage: "poll" };
      }
      if (!preEndedResult.ok) {
        return { ok: false, code: preEndedResult.code, stage: "ended" };
      }
      if (preEndedResult.ended) {
        // Legitimate idempotent repeat: nothing to complete because the instance (and
        // therefore this step) is already done. NF-2 honest-success, not a failure.
        alreadyEnded = true;
      } else {
        // Structural failure (BUG-014's root cause, now surfaced instead of silently
        // swallowed): the instance is alive but no active user-task matched.
        return { ok: false, code: ENGINE_TASK_NOT_FOUND, stage: "poll" };
      }
    }
  }

  // 2. Reconcile: ended → instance.ended; else surface live engine tasks.
  // T-0591 (FF-1): still budget-raced — reached even on the reconcile-on-read
  // (mirror) path where completeEngineTask is false/absent (step 1 above is
  // skipped entirely); deadlineAt still bounds this call the same way.
  const endedResult = await callWithBudget(
    () => engine.isInstanceEnded(args.instanceId),
    deadlineAt,
  );
  if (endedResult === BUDGET_EXHAUSTED) {
    return { ok: false, code: ENGINE_DRIVE_TIMEOUT, stage: "ended" };
  }
  if (!endedResult.ok) {
    return { ok: false, code: endedResult.code, stage: "ended" };
  }

  // T-0441 [analytics contract — DO NOT drop this guard]: `instance.ended` is emitted
  // from this ONE call site and ONLY when the engine confirms the instance actually
  // ended (endedResult.ended). The "not really ended" signal — a post-gateway
  // `process.next_task` still live / !isInstanceEnded — falls through to step 3 below,
  // which surfaces the next step instead of ending. Emitting `instance.ended` on the
  // approve of an INTERMEDIATE step of a BRANCHING process (base → DMN gateway →
  // extra-approve) would write a PHANTOM completion into the transition journal,
  // distorting the process_transition_journal / cycle-time analytics
  // (src/db/transition-journal.ts). Pinned live (real Postgres, mutation-proof) by
  // ci/checks/db/T-0441-branching-instance-ended-guard.db.test.ts.
  if (endedResult.ended) {
    // Engine confirms done. Emit instance.ended ONLY if not already present, so a
    // re-run (on-read net after the post-approve already ended it) does not pile up
    // duplicate ended rows. Best-effort emit (a failed write is retried next pass).
    try {
      const endedRowAlreadyProjected = await isInstanceEndedProjected(pool, tenantId, args.instanceId);
      if (!endedRowAlreadyProjected) {
        await withTenant(pool, tenantId, async (client) => {
          await appendInstanceEnded(client as unknown as PgClientLike, {
            taskId: randomUUID(),
            instanceId: args.instanceId,
            procKey: args.procKey,
            actor: args.actor,
            nowMs,
            tenantId,
          });
        });
      }
    } catch {
      // best-effort — next read reconciles.
    }
    return { ok: true, ended: true, emitted: 0, completed, ...(alreadyEnded ? { alreadyEnded: true } : {}) };
  }

  // 3. Engine has more tokens → surface EVERY live user-task not yet projected.
  // T-0591 (FF-1): budget-raced like the other four call sites. Note this fan-out
  // is the ASYNC/eventually-consistent half of the contract (ADR-T0571 §2.3) —
  // a timeout here still surfaces as ok:false to the caller (inbox.ts logs it,
  // does not fail the already-decided 200/502 above it in a way that changes
  // completion semantics), and reconcile-on-read retries it on the next GET
  // /api/inbox regardless.
  const nextTasksResult = await callWithBudget(
    () => engine.getActiveUserTasks(args.instanceId),
    deadlineAt,
  );
  if (nextTasksResult === BUDGET_EXHAUSTED) {
    return { ok: false, code: ENGINE_DRIVE_TIMEOUT, stage: "next-tasks" };
  }
  if (!nextTasksResult.ok) {
    return { ok: false, code: nextTasksResult.code, stage: "next-tasks" };
  }

  let emitted = 0;
  if (nextTasksResult.tasks.length > 0) {
    // Dedup against (a) the just-completed defKey and (b) tasks already projected as
    // waiting for this instance (base process.started + prior process.next_task rows).
    //
    // T-0571 note (base row unresolved, taskDefKey=null): this fan-out step is reached
    // in mirror mode (completeEngineTask:false) via reconcileInboxEngineDriveOnRead,
    // which re-drives every WAITING instance. In the REAL product flow (inbox.ts) the
    // base's task.approved is always committed BEFORE any engine-drive reconcile call
    // runs (same tx, strictly before) — so by the time this fan-out executes for a
    // GIVEN instance, either the base row is already hidden (approved) or this pass IS
    // the post-approve completion pass itself (completedDefKey is set). An instance
    // whose base row is still unresolved AND has never been approved is therefore not
    // reachable here with a genuinely-new gateway task to hide (a gateway only spawns a
    // new token AFTER the step it follows completes). No extra guard is needed beyond
    // the existing alreadyProjectedDefKeys / completedDefKey exclusions above.
    let alreadyProjectedDefKeys = new Set<string>();
    try {
      const projected = await listInstanceInboxTasks(pool, tenantId);
      alreadyProjectedDefKeys = new Set(
        projected
          .filter((t) => t.inst === args.instanceId)
          .map((t) => t.taskDefKey)
          .filter((k): k is string => k !== null),
      );
    } catch {
      // read failed — fall through with empty set; dedup-within-pass still guards.
    }

    const emittedThisPass = new Set<string>();
    for (const nextTask of nextTasksResult.tasks) {
      const defKey = nextTask.taskDefinitionKey;
      // T-0571: exclude the step we just completed THIS pass — completedDefKey is
      // either the caller's literal (next_task path) or the LIVE-resolved defKey
      // (base/resolve-by-instance path), never a guessed literal.
      if (defKey === completedDefKey) continue; // step we just completed
      if (alreadyProjectedDefKeys.has(defKey)) continue; // already on screen
      if (emittedThisPass.has(defKey)) continue; // dedup within this pass
      emittedThisPass.add(defKey);

      const nextRole = nextTask.candidateGroups[0] ?? APPROVER_ROLE;
      try {
        await appendNextTaskEvent(pool, tenantId, {
          instanceId: args.instanceId,
          procKey: args.procKey,
          actor: args.actor,
          nowMs,
          taskDefKey: defKey,
          taskName: nextTask.name || APPROVE_TASK_NAME,
          taskRole: nextRole,
          taskStep: nextTask.name || APPROVE_STEP,
          inboxTaskId: randomUUID(),
        });
        emitted++;
      } catch {
        // best-effort — a failed emit is retried on the next reconcile pass.
      }
    }
  }

  return { ok: true, ended: false, emitted, completed };
}

/**
 * Has an `instance.ended` EVENT already been emitted for this instance? Used by the
 * engine-drive reconcile to avoid piling up a duplicate ended row on a re-run (the
 * on-read net re-driving an instance the post-approve already ended).
 *
 * IMPORTANT: this checks the raw instance.ended EVENT, NOT the folded `done` status —
 * the projection's backward-compat fallback (process-projection §Fix-D) folds an
 * approved-with-no-pending-next-task instance to `done` even BEFORE instance.ended is
 * written, so using the folded status here would wrongly suppress the engine-gated
 * ended emit (regressing the linear path). Tenant-scoped, BYPASSRLS guard via
 * withTenant. Degrades to false on read error (a duplicate ended row folds harmlessly
 * to the same `done`, so a false-negative only re-emits — never blocks done).
 */
async function isInstanceEndedProjected(
  pool: pg.Pool,
  tenantId: string,
  instanceId: string,
): Promise<boolean> {
  try {
    return await withTenant(pool, tenantId, async (client) => {
      const res = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload
           FROM choros.audit_event
          WHERE type = $1
            AND tenant_id = $2
          ORDER BY occurred_at ASC`,
        [INSTANCE_ENDED_TYPE, tenantId],
      );
      for (const r of res.rows) {
        const p = (r.payload ?? {}) as Record<string, unknown>;
        if (p["inst"] === instanceId) return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}

/**
 * Reconcile-on-read engine-drive net (T-0522). The read-side analogue of
 * reconcileInstanceTimers, but for the post-approve/gateway path: for each WAITING
 * instance that has been APPROVED at least once but is not yet ended, ask the engine
 * for its live token set and surface any gateway-spawned user-task the post-approve
 * async missed. This is the durability safety net — even if the fire-and-forget
 * post-approve drive lost the race or hit a transient engine error, the very next
 * inbox read self-heals the missing «Доп.согласование» row.
 *
 * Idempotent (dedup by defKey inside reconcileInstanceEngineDrive); best-effort
 * (engine/DB hiccups degrade silently — the NEXT read retries; the inbox 200 is never
 * blocked). Pure state-mirror: completeEngineTask=false, so it NEVER completes a user
 * task (that is the human's action) — it only reflects engine state the human's prior
 * approve already advanced.
 *
 * @returns total number of next_task rows newly emitted across all instances.
 */
export async function reconcileInboxEngineDriveOnRead(
  pool: pg.Pool,
  tenantId: string,
  engine: EngineDriveReconcilePort,
  opts?: { nowMs?: number; actor?: string; limit?: number },
): Promise<number> {
  const nowMs = opts?.nowMs ?? Date.now();
  const actor = opts?.actor ?? "system:engine-drive";

  let projections: InstanceProjection[];
  let projectedTasks: InstanceInboxTask[];
  try {
    projections = await listInstanceProjections(pool, tenantId, { limit: opts?.limit });
    projectedTasks = await listInstanceInboxTasks(pool, tenantId);
  } catch {
    return 0; // read-projection — degrade silently.
  }

  // Candidate instances: WAITING (not done) AND already approved at least once (so the
  // human acted and the engine should have advanced) BUT with no pending next_task /
  // message-catch / escalation row already on screen for the post-gateway step. An
  // instance with a base task still un-approved is on the normal approve path — the
  // on-read net does not pre-empt it. We approximate "approved at least once" by: the
  // instance is waiting AND has fewer un-approved base rows than it would if untouched —
  // but simplest + safe: re-drive every WAITING instance; reconcileInstanceEngineDrive
  // is a pure idempotent mirror (completeEngineTask=false) so re-driving an un-approved
  // instance only re-confirms its current token (no duplicate, no premature completion).
  const waiting = projections.filter((p) => p.status !== "done");
  if (waiting.length === 0) return 0;

  // Skip instances that are parked on a message-catch (T-0459 owns those) — their
  // "next task" is a message arrival, not a gateway token; re-driving would just no-op
  // but we avoid the engine round-trip.
  const messageCatchInsts = new Set(
    projectedTasks.filter((t) => t.messageCatch === true).map((t) => t.inst),
  );

  let total = 0;
  for (const p of waiting) {
    if (messageCatchInsts.has(p.inst)) continue;
    let result: EngineDriveResult;
    try {
      result = await reconcileInstanceEngineDrive(pool, tenantId, engine, {
        instanceId: p.inst,
        procKey: p.procKey,
        completeEngineTask: false, // PURE MIRROR — never complete a task on read.
        actor,
        nowMs,
      });
    } catch {
      continue; // engine/DB hiccup for this instance — try others; next read retries.
    }
    if (result.ok) total += result.emitted;
    // result.ok === false ⇒ engine unreachable for this instance; the next read retries.
  }

  return total;
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
          projected
            .filter((t) => t.inst === inst)
            // T-0571: base rows carry taskDefKey=null (resolve-by-instance signal).
            .map((t) => t.taskDefKey)
            .filter((k): k is string => k !== null),
        );
        const procKey =
          projected.find((t) => t.inst === inst)?.procKey ?? DEFAULT_PROC_KEY;
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
        procKey: DEFAULT_PROC_KEY,
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
