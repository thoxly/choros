/**
 * src/runtime/agent-dispatch/dispatch-outcome.ts — T-0378 [D4] (PD-2 dispatcher).
 *
 * Outcome decomposition — the load-bearing reuse weld. Turns one PrecheckOutcome
 * into durable effects inside ONE caller tenant tx (atomic per job):
 *
 *   proceed        → applyStepResult (result-entity F2)  ⊕  agent.proceeded audit
 *                    ⊕  task_completed outbox            ⊕  jobStore.complete
 *   defer-to-human → agent.deferred audit (planDeferTask) ⊕ task_completed outbox
 *                    ⊕  jobStore.complete   — the agent step ALWAYS closes; the
 *                    defer MATERIALIZES the next human inbox step (ACCEPTED DECISION
 *                    1, ADR §10 Q4). The deferred audit event IS the inbox task (D-061,
 *                    no new table); the engine routes downstream to «Согласование».
 *   fail-closed    → agent.blocked audit  ⊕  jobStore.fail(retries)  — no step close.
 *
 * REUSE (ADR §1):
 *   - applyStepResult (step-applier.ts)        — proceed result-entity write (A-branch).
 *   - planDeferTask (defer-inbox-producer.ts)  — defer task plan (role/name/doubt).
 *   - appendAuditEvent (audit-writer.ts)       — single canonical audit sink.
 *   - outbox enqueueInTx (smoke-runner shape)  — task_completed producer (the
 *                                                production trigger half, ADR §0).
 *   - jobStore complete/fail (pgJobStore.ts)   — idempotent close/park.
 *
 * IDEMPOTENCY (ADR §5): the whole decomposition runs in the caller's tenant tx that
 * ends with jobStore.complete/fail; a crash before COMMIT rolls back record+audit+
 * outbox together. The task_completed outbox row uses idempotencyKey
 * "complete:"+jobId (ON CONFLICT DO NOTHING) so a lock-expiry re-run dedups. The
 * step_applied outbox (in applyStepResult) is keyed step_applied:<inst>:<taskId>.
 *
 * The agent.proceeded / agent.deferred / agent.blocked event builders are LIFTED
 * here (the legal-precheck variants stay in run-precheck.ts with skill="legal_precheck";
 * these are skill-neutral with scope.via="agent-dispatch").
 */

import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuditWriter, PgClientLike } from "../../db/audit-writer.js";
import type { AuditEventInput } from "../../core/audit-grant-encoder.js";
import { planDeferTask } from "../../core/defer-inbox-producer.js";
import {
  applyStepResult,
  type OutboxEnqueuePort,
} from "../../db/step-applier.js";
// T-0575 [W1/деТЭЛ] BUG-015-agent (AC-11): the defer-to-human fallback role reads
// the SAME config-primitive as the base process.started projection
// (process-projection.ts resolveDefaultApproverRole) rather than re-hardcoding
// "role-approver" as an independent second literal.
import { resolveDefaultApproverRole } from "../../http/process-projection.js";
import type { PrecheckOutcome } from "../../core/agent-precheck-motor.js";
import type { AgentStepContext } from "./agent-step-context.js";

// ---------------------------------------------------------------------------
// JobStore surface the decomposer needs (complete/fail). Structural so both the
// Postgres and in-memory job stores satisfy it.
// ---------------------------------------------------------------------------

export interface DispatchJobStore {
  complete(
    workerId: string,
    jobId: string,
    payload?: Record<string, unknown>,
  ): Promise<{ ok: boolean; code?: string }>;
  fail(
    workerId: string,
    jobId: string,
    retries: number,
    retryTimeoutMs: number,
  ): Promise<{ ok: boolean; code?: string }>;
}

// ---------------------------------------------------------------------------
// ApplyOutcomeDeps — injected ports.
// ---------------------------------------------------------------------------

export interface ApplyOutcomeDeps {
  readonly auditWriter: AuditWriter;
  readonly outboxStore: OutboxEnqueuePort;
  readonly jobStore: DispatchJobStore;
  /** The dispatcher worker identity (must own the job lock for complete/fail). */
  readonly workerId: string;
  /** Retry budget for fail-closed (bridge retry policy). Default 0 (terminal). */
  readonly failRetries?: number;
  /** Retry back-off for fail-closed (ms). Default 30_000. */
  readonly failRetryTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Skill-neutral audit event builders.
// ---------------------------------------------------------------------------

function proceededAuditEvent(ctx: AgentStepContext, answerForm: string): AuditEventInput {
  return {
    id: randomUUID(),
    type: "agent.proceeded",
    actor: ctx.agentEmployeeId,
    subject: `agent:${ctx.agentEmployeeId}`,
    scope: { proc_key: ctx.procKey, answer_form: answerForm, via: "agent-dispatch" },
    via: "agent-dispatch",
    proposed_by: null,
    confirmed_by: null,
    payload: {
      proc_key: ctx.procKey,
      instance_id: ctx.instanceId,
      answer_form: answerForm,
    },
    occurred_at: ctx.nowMs,
  };
}

function deferredAuditEvent(
  taskId: string,
  ctx: AgentStepContext,
  doubtReason: string,
  signal: string,
  extra: {
    deferRole: string;
    deferSlaMinutes?: number;
    deferName: string;
    /**
     * F5 — agent draft for prefilled human escalation form (from DeferTaskPlan).
     * Included in the audit payload so the inbox projection can surface it to
     * the human reviewer as a prefilled accept/edit/reject form.
     * Null when absent (dormant / error — no LLM answer to carry).
     */
    agentDraft?: import("../../core/llm-port.js").PrecheckAnswer;
  },
): AuditEventInput {
  return {
    id: taskId,
    type: "agent.deferred",
    actor: ctx.agentEmployeeId,
    subject: `agent:${ctx.agentEmployeeId}`,
    scope: { proc_key: ctx.procKey, signal, via: "agent-dispatch" },
    via: "agent-dispatch",
    proposed_by: null,
    confirmed_by: null,
    // T-0221 shape: inbox_task_id == audit_event.id (self-referential back-link).
    payload: {
      doubt_reason: doubtReason,
      signal,
      inbox_task_id: taskId,
      instance_id: ctx.instanceId,
      proc_key: ctx.procKey,
      defer_role: extra.deferRole,
      defer_sla_minutes: extra.deferSlaMinutes ?? null,
      defer_name: extra.deferName,
      // F5: prefilled draft for human reviewer (null when dormant/error — no draft).
      agent_draft: extra.agentDraft ?? null,
    },
    occurred_at: ctx.nowMs,
  };
}

function blockedAuditEvent(
  ctx: AgentStepContext,
  cause: string,
  denyReason: string | undefined,
): AuditEventInput {
  return {
    id: randomUUID(),
    type: "agent.blocked",
    actor: ctx.agentEmployeeId,
    subject: `agent:${ctx.agentEmployeeId}`,
    scope: { proc_key: ctx.procKey, via: "agent-dispatch" },
    via: "agent-dispatch",
    proposed_by: null,
    confirmed_by: null,
    payload: { cause, deny_reason: denyReason ?? null, instance_id: ctx.instanceId },
    occurred_at: ctx.nowMs,
  };
}

// ---------------------------------------------------------------------------
// task_completed outbox row — the production trigger half (ADR §0 / smoke-runner
// shape). Enqueued in the SAME tx; delivered out-of-band by makeExternalTaskDeliver
// → completeTask in Flowable (which still runs evaluateGatewayAtTriage for the DMN
// seam, so the gateway late-compute is preserved — ADR §8 risk 3).
//
// T-0644 (P0/столп4) — IMPORTANT: `workerId` here is the AGENT DISPATCHER's own
// identity (deps.workerId in agent-dispatch-loop.ts, default
// "choros-agent-dispatcher") — the identity that holds the choros.job ROW LOCK
// (a Postgres-level lock, completely separate from Flowable's external-task
// lock). It is carried into `payload.workerId` for audit/observability ONLY
// ("who/what decided this Choros-side outcome"). makeExternalTaskDeliver
// (externalTaskBridge.ts) does NOT read this field when calling Flowable's
// completeTask/failTask — the Flowable lock is always held by the BRIDGE
// (fetchAndLock's own workerId), and the bridge uses its own configured
// bridgeWorkerId for the Flowable call regardless of what a job-outcome
// producer (this dispatcher, or any future producer) writes here. Do not
// repurpose this field as a Flowable-lock identity — see the doc-comment on
// makeExternalTaskDeliver for the full mismatch this separation prevents.
// ---------------------------------------------------------------------------

async function enqueueTaskCompleted(
  client: pg.PoolClient,
  outboxStore: OutboxEnqueuePort,
  ctx: AgentStepContext,
  variables: Record<string, unknown>,
  workerId: string,
): Promise<void> {
  await outboxStore.enqueueInTx(client, {
    aggregateKind: "job",
    aggregateId: ctx.jobId,
    eventType: "task_completed",
    payload: { workerId, variables },
    idempotencyKey: `complete:${ctx.jobId}`,
  });
}

// ---------------------------------------------------------------------------
// The decomposition result (for assertions / logging).
// ---------------------------------------------------------------------------

export interface ApplyOutcomeResult {
  readonly outcome: PrecheckOutcome["kind"];
  /** The defer/audit subject id (deferred task id, or "" for non-defer). */
  readonly inboxTaskRef: string;
  /** Whether the engine step was closed (job completed). */
  readonly stepClosed: boolean;
}

// ---------------------------------------------------------------------------
// applyAgentOutcome — decompose one outcome inside the caller tenant tx.
// ---------------------------------------------------------------------------

/**
 * Decompose a PrecheckOutcome into durable effects on the caller's open tenant tx.
 * Returns once all writes are enqueued and the job is completed/failed; the caller
 * COMMITs (atomic). Never opens its own tx.
 *
 * Day-1 ACCEPTED DECISION 1 (ADR §10 Q4): proceed AND defer both CLOSE the engine
 * step (jobStore.complete + task_completed outbox). The difference is the entity
 * effect + audit: proceed writes a result-entity (applyStepResult) + agent.proceeded;
 * defer writes ONLY the agent.deferred event (the inbox task), letting the engine
 * route downstream to the human «Согласование» step. fail-closed parks the job
 * (jobStore.fail) and does NOT close the engine step.
 */
export async function applyAgentOutcome(
  client: pg.PoolClient,
  ctx: AgentStepContext,
  outcome: PrecheckOutcome,
  deps: ApplyOutcomeDeps,
): Promise<ApplyOutcomeResult> {
  const tx = client as unknown as PgClientLike;
  const workerId = deps.workerId;

  if (outcome.kind === "proceed") {
    // --- Result-entity (F2): append a «Согласование» record under the app. ---
    // Map the agent answer into the standard outcome form (ADR §10 Q5).
    const formData: Record<string, unknown> = {
      decision: outcome.answer.summary,
      red_flags: outcome.answer.redFlags,
      decided_by: ctx.agentEmployeeId,
      source: "agent",
      answer_form: outcome.answer.answerForm,
    };
    await applyStepResult(client, {
      tenantId: ctx.tenantId,
      instanceId: ctx.instanceId,
      procKey: ctx.procKey,
      activity: "agent-step",
      actor: ctx.agentEmployeeId,
      taskId: ctx.jobId,
      stepClass: "A",
      formData,
      durationMs: null,
      nowMs: ctx.nowMs,
      outboxStore: deps.outboxStore,
    });

    // --- Audit the agent proceed. ---
    await deps.auditWriter.appendAuditEvent(tx, proceededAuditEvent(ctx, outcome.answer.answerForm));

    // --- Enqueue the task_completed outbox (the trigger half) + close the job. ---
    await enqueueTaskCompleted(
      client,
      deps.outboxStore,
      ctx,
      { source: "agent", outcome: "proceed" },
      workerId,
    );
    await deps.jobStore.complete(workerId, ctx.jobId, {
      source: "agent",
      outcome: "proceed",
    });
    return { outcome: "proceed", inboxTaskRef: "", stepClosed: true };
  }

  if (outcome.kind === "defer-to-human") {
    // --- Plan the defer task + mint the task id BEFORE the audit append so the
    //     self-referential inbox_task_id == audit_event.id (T-0221 FF-3). ---
    const plan = planDeferTask(outcome, {
      // T-0575 BUG-015-agent: fallback reads the single config-primitive source
      // (env CHOROS_DEFAULT_APPROVER_ROLE, defaulting to "role-approver") instead
      // of a second independently-hardcoded literal (AC-11).
      role: ctx.roleId !== "" ? ctx.roleId : resolveDefaultApproverRole(),
      agentEmployeeId: ctx.agentEmployeeId,
    });
    const taskId = randomUUID();
    await deps.auditWriter.appendAuditEvent(
      tx,
      deferredAuditEvent(taskId, ctx, plan.doubtReason, outcome.signal, {
        deferRole: plan.role,
        deferName: plan.name,
        // F5: carry the agent's draft (from planDeferTask which threads outcome.agentDraft).
        agentDraft: plan.agentDraft,
      }),
    );

    // --- ACCEPTED DECISION 1: the agent step ALWAYS closes. Enqueue task_completed
    //     so the engine routes downstream to the human step; close the job. ---
    await enqueueTaskCompleted(
      client,
      deps.outboxStore,
      ctx,
      { source: "agent", outcome: "defer", deferred: true, inbox_task_id: taskId },
      workerId,
    );
    await deps.jobStore.complete(workerId, ctx.jobId, {
      source: "agent",
      outcome: "defer",
      deferred: true,
    });
    return { outcome: "defer-to-human", inboxTaskRef: taskId, stepClosed: true };
  }

  // --- fail-closed: audit + park the job (no engine close). ---
  await deps.auditWriter.appendAuditEvent(
    tx,
    blockedAuditEvent(ctx, outcome.cause, outcome.denyReason),
  );
  await deps.jobStore.fail(
    workerId,
    ctx.jobId,
    deps.failRetries ?? 0,
    deps.failRetryTimeoutMs ?? 30_000,
  );
  return { outcome: "fail-closed", inboxTaskRef: "", stepClosed: false };
}
