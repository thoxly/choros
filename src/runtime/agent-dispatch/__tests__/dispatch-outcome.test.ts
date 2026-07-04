/**
 * Unit tests for T-0378 [D4] applyAgentOutcome — outcome decomposition weld.
 *
 * Covers (test plan §6, static-now — fake pg client / in-memory audit + outbox + jobStore):
 *  - proceed       → applyStepResult invoked, agent.proceeded audit, task_completed
 *                    outbox (complete:<jobId>), jobStore.complete, step closed.
 *  - defer-to-human→ agent.deferred audit (inbox_task_id self-ref), task_completed
 *                    outbox, jobStore.complete (ACCEPTED DECISION 1: step ALWAYS closes).
 *  - fail-closed   → agent.blocked audit, jobStore.fail, step NOT closed.
 *  - idempotency   → re-run with same jobId dedups the task_completed outbox row.
 *
 * The proceed branch uses a fake pg client whose resolveInstanceTargetOnClient
 * yields `no_app_binding` → applyStepResult returns `skipped` (no real registry
 * needed) while the audit + outbox + complete weld still runs — proving the trigger
 * half WITHOUT live DB.
 */

import { describe, it, expect } from "vitest";
import type pg from "pg";
import { applyAgentOutcome, type ApplyOutcomeDeps, type DispatchJobStore } from "../dispatch-outcome.js";
import type { AgentStepContext } from "../agent-step-context.js";
import type { PrecheckOutcome } from "../../../core/agent-precheck-motor.js";
import type { PrecheckAnswer } from "../../../core/llm-port.js";
import { InMemoryAuditWriter, inMemoryTx } from "../../../db/audit-writer.js";
import { makeExternalTaskDeliver } from "../../../core/externalTaskBridge.js";


const TENANT = "a0000000-0000-0000-0000-000000000001";
const AGENT = "d0000000-0000-0000-0000-000000000006";
const NOW = 1_700_000_000_000;

function makeCtx(): AgentStepContext {
  return {
    tenantId: TENANT,
    jobId: "11111111-1111-1111-1111-111111111111",
    externalTaskId: "ext-1",
    instanceId: "22222222-2222-2222-2222-222222222222",
    procKey: "telLinear",
    agentEmployeeId: AGENT,
    roleId: "role-intake-agent",
    objective: { fields: { amount: 100 }, prompt: "Step: Триаж\nProcess: telLinear", instruction: "Триаж", answerForm: "agent_step_v1", hasInstruction: true },
    recordRef: { resolved: false, registryId: null, applicationId: null, primaryRecordId: null, snapshot: { amount: 100 } },
    tools: [],
    llm: { endpoint: null, model: null, secretHandle: null },
    autonomyThreshold: null,
    criticalityLevel: "routine",
    budget: { exhausted: false },
    nowMs: NOW,
  };
}

/** A fake outbox store that records enqueues + honours the idempotency key (dedup). */
class FakeOutbox {
  readonly rows: Array<{ aggregateKind: string; aggregateId: string; eventType: string; payload: Record<string, unknown>; idempotencyKey: string }> = [];
  private readonly keys = new Set<string>();
  async enqueueInTx(_client: pg.PoolClient, row: { aggregateKind: string; aggregateId: string; eventType: string; payload: Record<string, unknown>; idempotencyKey: string }): Promise<unknown> {
    if (this.keys.has(row.idempotencyKey)) {
      return undefined; // ON CONFLICT DO NOTHING (dedup)
    }
    this.keys.add(row.idempotencyKey);
    this.rows.push(row);
    return row;
  }
}

/** A fake job store recording complete/fail calls. */
class FakeJobStore implements DispatchJobStore {
  readonly completed: string[] = [];
  readonly failed: Array<{ jobId: string; retries: number }> = [];
  async complete(_workerId: string, jobId: string): Promise<{ ok: boolean }> {
    this.completed.push(jobId);
    return { ok: true };
  }
  async fail(_workerId: string, jobId: string, retries: number): Promise<{ ok: boolean }> {
    this.failed.push({ jobId, retries });
    return { ok: true };
  }
}

/**
 * Fake pg client for the proceed branch: returns a process.started row (so the
 * resolver reads proc_key) then empty binding → resolver yields `no_app_binding`
 * → applyStepResult returns `skipped` (no real registry write needed). Carries
 * `__tenantId` so the InMemoryAuditWriter (proceeded audit) serializes a chain.
 */
function fakeProceedClient(): pg.PoolClient {
  return {
    __tenantId: TENANT,
    query: async (sql: string) => {
      if (sql.includes("audit_event") && sql.includes("type = $1") && sql.includes("payload->>'inst'")) {
        // process.started lookup (resolver step 1)
        return { rows: [{ payload: { inst: "22222222-2222-2222-2222-222222222222", proc_key: "telLinear" } }] };
      }
      if (sql.includes("process_app_binding")) {
        return { rows: [] }; // no binding → no_app_binding → skip
      }
      return { rows: [] };
    },
  } as unknown as pg.PoolClient;
}

function baseDeps(audit: InMemoryAuditWriter, outbox: FakeOutbox, jobStore: FakeJobStore): ApplyOutcomeDeps {
  return { auditWriter: audit, outboxStore: outbox, jobStore, workerId: "agent-dispatcher" };
}

const DEMO_ANSWER: PrecheckAnswer = {
  answerForm: "agent_step_v1",
  redFlags: [],
  summary: "Заявка готова к согласованию",
};

describe("applyAgentOutcome — defer-to-human (ACCEPTED DECISION 1: step always closes)", () => {
  it("writes agent.deferred (self-ref inbox_task_id), task_completed outbox, completes the job", async () => {
    const audit = new InMemoryAuditWriter();
    const outbox = new FakeOutbox();
    const jobStore = new FakeJobStore();
    const ctx = makeCtx();
    const outcome: PrecheckOutcome = {
      kind: "defer-to-human",
      signal: "dormant",
      doubtReason: "llm runtime dormant — inference not available",
      inboxTaskRef: "pending",
    };

    const tx = inMemoryTx(TENANT) as unknown as pg.PoolClient;
    const result = await applyAgentOutcome(tx, ctx, outcome, baseDeps(audit, outbox, jobStore));

    expect(result.outcome).toBe("defer-to-human");
    expect(result.stepClosed).toBe(true);
    expect(result.inboxTaskRef).not.toBe("");

    const events = audit.rows(TENANT);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("agent.deferred");
    const payload = events[0].payload as Record<string, unknown>;
    // T-0221: inbox_task_id == audit_event.id (self-referential back-link).
    expect(payload["inbox_task_id"]).toBe(events[0].id);
    expect(payload["inbox_task_id"]).toBe(result.inboxTaskRef);
    expect(payload["doubt_reason"]).toBeTruthy();

    // The agent step closes: task_completed outbox + jobStore.complete.
    expect(outbox.rows.length).toBe(1);
    expect(outbox.rows[0].eventType).toBe("task_completed");
    expect(outbox.rows[0].idempotencyKey).toBe(`complete:${ctx.jobId}`);
    expect(jobStore.completed).toEqual([ctx.jobId]);
    expect(jobStore.failed.length).toBe(0);
  });
});

describe("applyAgentOutcome — fail-closed", () => {
  it("writes agent.blocked, fails the job (no step close)", async () => {
    const audit = new InMemoryAuditWriter();
    const outbox = new FakeOutbox();
    const jobStore = new FakeJobStore();
    const ctx = makeCtx();
    const outcome: PrecheckOutcome = { kind: "fail-closed", cause: "llm_error" };

    const tx = inMemoryTx(TENANT) as unknown as pg.PoolClient;
    const result = await applyAgentOutcome(tx, ctx, outcome, baseDeps(audit, outbox, jobStore));

    expect(result.outcome).toBe("fail-closed");
    expect(result.stepClosed).toBe(false);

    const events = audit.rows(TENANT);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("agent.blocked");
    expect((events[0].payload as Record<string, unknown>)["cause"]).toBe("llm_error");

    // No engine close: jobStore.fail, no task_completed outbox.
    expect(outbox.rows.length).toBe(0);
    expect(jobStore.completed.length).toBe(0);
    expect(jobStore.failed).toEqual([{ jobId: ctx.jobId, retries: 0 }]);
  });
});

describe("applyAgentOutcome — proceed (result-entity weld, no live DB)", () => {
  it("invokes applyStepResult, writes agent.proceeded, task_completed outbox, completes job", async () => {
    const audit = new InMemoryAuditWriter();
    const outbox = new FakeOutbox();
    const jobStore = new FakeJobStore();
    const ctx = makeCtx();
    const outcome: PrecheckOutcome = { kind: "proceed", answer: DEMO_ANSWER };

    // applyStepResult uses the (fake) pg client; the InMemoryAuditWriter is used by
    // applyAgentOutcome's appendAuditEvent — applyStepResult's own record.create
    // append uses makePgAuditWriter() against the fake client (returns rows:[]),
    // but the no_app_binding skip means applyStepResult returns BEFORE that write.
    const client = fakeProceedClient();
    const result = await applyAgentOutcome(client, ctx, outcome, baseDeps(audit, outbox, jobStore));

    expect(result.outcome).toBe("proceed");
    expect(result.stepClosed).toBe(true);

    // agent.proceeded audit appended via applyAgentOutcome (fake client carries
    // __tenantId so the InMemoryAuditWriter serializes a chain).
    const events = audit.rows(TENANT);
    expect(events.some((e) => e.type === "agent.proceeded")).toBe(true);

    // The load-bearing trigger half: task_completed outbox + jobStore.complete.
    expect(outbox.rows.some((r) => r.eventType === "task_completed" && r.idempotencyKey === `complete:${ctx.jobId}`)).toBe(true);
    expect(jobStore.completed).toEqual([ctx.jobId]);
  });
});

describe("T-0381 F5 — defer-to-human with agentDraft: prefilled escalation payload", () => {
  it("defer outcome with agentDraft → agent_draft appears in agent.deferred audit payload", async () => {
    const audit = new InMemoryAuditWriter();
    const outbox = new FakeOutbox();
    const jobStore = new FakeJobStore();
    const ctx = makeCtx();

    const draft: PrecheckAnswer = {
      answerForm: "agent_step_v1",
      redFlags: [{ clause: "§3.1", risk: "contract risk", severity: "high" }],
      summary: "Partial analysis completed — requires human review",
    };

    const outcome: PrecheckOutcome = {
      kind: "defer-to-human",
      signal: "threshold",
      doubtReason: "confidence 0.72 below autonomy threshold 0.85",
      inboxTaskRef: "pending",
      agentDraft: draft,
    };

    const tx = inMemoryTx(TENANT) as unknown as pg.PoolClient;
    const result = await applyAgentOutcome(tx, ctx, outcome, baseDeps(audit, outbox, jobStore));

    expect(result.outcome).toBe("defer-to-human");
    expect(result.stepClosed).toBe(true);

    const events = audit.rows(TENANT);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("agent.deferred");

    const payload = events[0].payload as Record<string, unknown>;
    // F5: agent_draft must appear in the audit payload.
    expect(payload["agent_draft"]).toBeDefined();
    const storedDraft = payload["agent_draft"] as PrecheckAnswer;
    expect(storedDraft.summary).toBe(draft.summary);
    expect(Array.isArray(storedDraft.redFlags)).toBe(true);
    expect((storedDraft.redFlags as Array<unknown>).length).toBe(1);
  });

  it("defer outcome WITHOUT agentDraft → agent_draft is null in payload (dormant path)", async () => {
    const audit = new InMemoryAuditWriter();
    const outbox = new FakeOutbox();
    const jobStore = new FakeJobStore();
    const ctx = makeCtx();

    const outcome: PrecheckOutcome = {
      kind: "defer-to-human",
      signal: "dormant",
      doubtReason: "llm runtime dormant — inference not available",
      inboxTaskRef: "pending",
      // agentDraft: absent (no LLM call happened)
    };

    const tx = inMemoryTx(TENANT) as unknown as pg.PoolClient;
    await applyAgentOutcome(tx, ctx, outcome, baseDeps(audit, outbox, jobStore));

    const events = audit.rows(TENANT);
    const payload = events[0].payload as Record<string, unknown>;
    // No draft in dormant path: agent_draft must be null (not undefined — serialised cleanly).
    expect(payload["agent_draft"]).toBeNull();
  });
});

describe("applyAgentOutcome — idempotency (lock-expiry re-run)", () => {
  it("re-run with same jobId dedups the task_completed outbox row", async () => {
    const audit = new InMemoryAuditWriter();
    const outbox = new FakeOutbox();
    const jobStore = new FakeJobStore();
    const ctx = makeCtx();
    const outcome: PrecheckOutcome = {
      kind: "defer-to-human",
      signal: "dormant",
      doubtReason: "dormant",
      inboxTaskRef: "pending",
    };
    const tx = inMemoryTx(TENANT) as unknown as pg.PoolClient;

    await applyAgentOutcome(tx, ctx, outcome, baseDeps(audit, outbox, jobStore));
    await applyAgentOutcome(tx, ctx, outcome, baseDeps(audit, outbox, jobStore));

    // Second run's task_completed enqueue is deduped by the complete:<jobId> key.
    const completeRows = outbox.rows.filter((r) => r.idempotencyKey === `complete:${ctx.jobId}`);
    expect(completeRows.length).toBe(1);
    // Both runs still completed the job (idempotent close — harmless).
    expect(jobStore.completed.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T-0644 (P0/столп4) — cross-component workerId consistency: the outbox row
// PRODUCED here (by the agent dispatcher, workerId="choros-agent-dispatcher")
// must still be deliverable to Flowable by the REAL bridge deliver function
// (makeExternalTaskDeliver), which uses its OWN workerId (the Flowable
// lock-holder) — NOT the producer's workerId embedded in the payload.
//
// This is the cross-component seam the LIVE_PROOF bug lived in: unit tests for
// dispatch-outcome.ts alone (above) only ever assert the OUTBOX ROW SHAPE; they
// never feed that row through the bridge's actual completeTask call, so they
// could not have caught (and did not catch) the workerId mismatch. This test
// closes that gap by driving the full chain: applyAgentOutcome → outbox row →
// makeExternalTaskDeliver → completeTask.
// ---------------------------------------------------------------------------
describe("T-0644: agent-dispatcher outbox row is deliverable through the REAL bridge deliver (workerId consistency)", () => {
  it("defer-to-human outcome's task_completed row completes via makeExternalTaskDeliver using the BRIDGE's workerId, not the dispatcher's", async () => {
    const audit = new InMemoryAuditWriter();
    const outbox = new FakeOutbox();
    const jobStore = new FakeJobStore();
    const ctx = makeCtx();
    const outcome: PrecheckOutcome = {
      kind: "defer-to-human",
      signal: "dormant",
      doubtReason: "llm runtime dormant — inference not available",
      inboxTaskRef: "pending",
    };

    const AGENT_DISPATCHER_ID = "choros-agent-dispatcher";
    const BRIDGE_LOCK_HOLDER = "choros-bridge";

    const tx = inMemoryTx(TENANT) as unknown as pg.PoolClient;
    await applyAgentOutcome(
      tx,
      ctx,
      outcome,
      { auditWriter: audit, outboxStore: outbox, jobStore, workerId: AGENT_DISPATCHER_ID },
    );

    // The agent dispatcher's own outbox row — payload.workerId is ITS identity,
    // structurally unrelated to whoever holds the Flowable lock.
    expect(outbox.rows).toHaveLength(1);
    const producedRow = outbox.rows[0];
    expect(producedRow.payload["workerId"]).toBe(AGENT_DISPATCHER_ID);

    // Feed that row through the REAL bridge deliver function, constructed with
    // the bridge's OWN workerId (the Flowable lock-holder identity) — mirrors
    // production wiring (lifecycle-bridge.ts: same bridgeWorkerId used for both
    // fetchAndLock and makeExternalTaskDeliver).
    const flowableClient = new MockFlowableClientForDispatchTest();
    const externalTaskId = "ext-defer-1";
    const pgJobStoreStub = {
      pool: makeMockPoolForDispatchTest(producedRow.aggregateId, externalTaskId),
    } as unknown as import("../../../core/postgres/pgJobStore.js").PostgresJobStore;

    const deliver = makeExternalTaskDeliver(flowableClient, pgJobStoreStub, undefined, BRIDGE_LOCK_HOLDER);

    const outboxRowForDeliver: import("../../../core/outboxTypes.js").OutboxRow = {
      tenantId: TENANT,
      id: "outbox-row-defer-1",
      aggregateKind: producedRow.aggregateKind,
      aggregateId: producedRow.aggregateId,
      eventType: producedRow.eventType,
      payload: producedRow.payload,
      state: "dispatching",
      idempotencyKey: producedRow.idempotencyKey,
      attempts: 0,
      createdAt: NOW,
      availableAt: NOW,
      dispatchedAt: undefined,
      lastError: undefined,
    };

    const result = await deliver(outboxRowForDeliver);

    expect(result.ok).toBe(true);
    expect(flowableClient.completeCalls).toHaveLength(1);
    const [calledTaskId, calledWorkerId] = flowableClient.completeCalls[0];
    expect(calledTaskId).toBe(externalTaskId);
    // THE KEYSTONE ASSERTION (T-0644): Flowable receives the BRIDGE's workerId
    // — the lock-holder — even though the outbox payload carries the AGENT
    // DISPATCHER's (different) workerId. Before the fix this would have been
    // AGENT_DISPATCHER_ID, which Flowable rejects as a lock-owner mismatch.
    expect(calledWorkerId).toBe(BRIDGE_LOCK_HOLDER);
    expect(calledWorkerId).not.toBe(AGENT_DISPATCHER_ID);
  });
});

// ---------------------------------------------------------------------------
// Minimal local doubles for the cross-component test above (avoid depending on
// externalTaskBridge.test.ts's private mock classes across test files).
// ---------------------------------------------------------------------------
import type {
  FlowableClient,
  ExternalTask,
  FetchResult,
  CompleteTaskResult,
  FailTaskResult,
  GetFirstUserTaskResult,
  CompleteUserTaskResult,
  GetActiveUserTasksResult,
  GetMessageCatchWaitsResult,
  CorrelateMessageResult,
  IsInstanceEndedResult,
} from "../../../core/flowable-client.js";

class MockFlowableClientForDispatchTest implements FlowableClient {
  completeCalls: Array<[string, string, Record<string, unknown> | undefined]> = [];
  failCalls: Array<[string, string, string, number, number]> = [];

  deployBpmn = (): never => { throw new Error("not used"); };
  startInstance = (): never => { throw new Error("not used"); };

  async fetchAndLock(): Promise<FetchResult> {
    return { ok: true, tasks: [] as ExternalTask[] };
  }

  async completeTask(
    taskId: string,
    workerId: string,
    variables?: Record<string, unknown>,
  ): Promise<CompleteTaskResult> {
    this.completeCalls.push([taskId, workerId, variables]);
    return { ok: true };
  }

  async failTask(
    taskId: string,
    workerId: string,
    errorMessage: string,
    retries: number,
    retryTimeoutMs: number,
  ): Promise<FailTaskResult> {
    this.failCalls.push([taskId, workerId, errorMessage, retries, retryTimeoutMs]);
    return { ok: true };
  }

  async getFirstActiveUserTask(): Promise<GetFirstUserTaskResult> {
    return { ok: true, taskId: null };
  }

  async completeUserTask(): Promise<CompleteUserTaskResult> {
    return { ok: true };
  }

  async getActiveUserTasks(): Promise<GetActiveUserTasksResult> {
    return { ok: true, tasks: [] };
  }

  async getMessageCatchWaits(): Promise<GetMessageCatchWaitsResult> {
    return { ok: true, waits: [] };
  }

  async correlateMessage(): Promise<CorrelateMessageResult> {
    return { ok: true };
  }

  async isInstanceEnded(): Promise<IsInstanceEndedResult> {
    return { ok: true, ended: false };
  }
}

/** Minimal pool double: answers ONLY the SELECT idempotency_key lookup the
 * bridge's lookupExternalTaskId issues, and absorbs everything else (BEGIN/
 * COMMIT/SELECT topic/DMN eval queries) with empty rows — mirrors the
 * makeMockPool/makeDmnBridgeMockPool doubles in externalTaskBridge.test.ts. */
function makeMockPoolForDispatchTest(jobId: string, externalTaskId: string): unknown {
  return {
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT idempotency_key") && params && params.length > 0) {
          return params[0] === jobId ? { rows: [{ idempotency_key: externalTaskId }] } : { rows: [] };
        }
        return { rows: [] };
      },
      release: () => {/* no-op */},
    }),
  };
}
