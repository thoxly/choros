/**
 * T-0644 (P0/столп4) — cross-component workerId consistency test.
 *
 * LIVE_PROOF diagnosis: an agent-step outcome (proceed/defer) is decomposed by
 * applyAgentOutcome (src/runtime/agent-dispatch/dispatch-outcome.ts, a FROZEN
 * T-0586 zone this task does not modify) into a task_completed outbox row whose
 * payload carries the AGENT DISPATCHER's own workerId (e.g.
 * "choros-agent-dispatcher" — see agent-dispatch-loop.ts's ApplyOutcomeDeps.workerId).
 * That row is later delivered by makeExternalTaskDeliver (src/core/externalTaskBridge.ts)
 * to Flowable's completeTask/failTask. Flowable REJECTS a completeTask/failTask call
 * whose workerId does not match the ACTUAL lock-holder (always the bridge itself,
 * via fetchAndLock) — before the T-0644 fix, the bridge forwarded
 * row.payload["workerId"] verbatim, so ANY outbox row produced by a component other
 * than the bridge (concretely: the agent dispatcher) was structurally undeliverable
 * → 5 failed attempts → outbox row goes 'dead' → the process instance never
 * advances ("вечно в процессе").
 *
 * This test proves the FULL cross-component chain end-to-end using the REAL
 * applyAgentOutcome (imported read-only from the frozen zone — this test file
 * lives OUTSIDE src/runtime/agent-dispatch/ specifically so it can assert on that
 * zone's behavior without triggering the FF-15 zone-freeze fitness gate, which
 * blocks *modifications* to files under that path, not read-only imports from
 * tests elsewhere) and the REAL makeExternalTaskDeliver: the agent dispatcher's
 * own outbox row is still deliverable to Flowable using the BRIDGE's workerId,
 * never the dispatcher's.
 */

import { describe, it, expect } from "vitest";
import type pg from "pg";
import {
  applyAgentOutcome,
  type ApplyOutcomeDeps,
  type DispatchJobStore,
} from "../runtime/agent-dispatch/dispatch-outcome.js";
import type { AgentStepContext } from "../runtime/agent-dispatch/agent-step-context.js";
import type { PrecheckOutcome } from "../core/agent-precheck-motor.js";
import { InMemoryAuditWriter, inMemoryTx } from "../db/audit-writer.js";
import { makeExternalTaskDeliver } from "../core/externalTaskBridge.js";
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
} from "../core/flowable-client.js";
import type { PostgresJobStore } from "../core/postgres/pgJobStore.js";
import type { OutboxRow } from "../core/outboxTypes.js";

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

/** A fake outbox store that records enqueues (mirrors dispatch-outcome.test.ts's FakeOutbox). */
class FakeOutbox {
  readonly rows: Array<{ aggregateKind: string; aggregateId: string; eventType: string; payload: Record<string, unknown>; idempotencyKey: string }> = [];
  private readonly keys = new Set<string>();
  async enqueueInTx(_client: pg.PoolClient, row: { aggregateKind: string; aggregateId: string; eventType: string; payload: Record<string, unknown>; idempotencyKey: string }): Promise<unknown> {
    if (this.keys.has(row.idempotencyKey)) return undefined;
    this.keys.add(row.idempotencyKey);
    this.rows.push(row);
    return row;
  }
}

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

/** Minimal FlowableClient double recording completeTask/failTask calls. */
class MockFlowableClientForBridgeWorkerIdTest implements FlowableClient {
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

/** Minimal pool double answering ONLY the lookupExternalTaskId SELECT (mirrors
 * externalTaskBridge.test.ts's makeMockPool). */
function makePoolDouble(jobId: string, externalTaskId: string): unknown {
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
    const applyDeps: ApplyOutcomeDeps = {
      auditWriter: audit,
      outboxStore: outbox,
      jobStore,
      workerId: AGENT_DISPATCHER_ID,
    };
    await applyAgentOutcome(tx, ctx, outcome, applyDeps);

    // The agent dispatcher's own outbox row — payload.workerId is ITS identity,
    // structurally unrelated to whoever holds the Flowable lock.
    expect(outbox.rows).toHaveLength(1);
    const producedRow = outbox.rows[0];
    expect(producedRow.payload["workerId"]).toBe(AGENT_DISPATCHER_ID);

    // Feed that row through the REAL bridge deliver function, constructed with
    // the bridge's OWN workerId (the Flowable lock-holder identity) — mirrors
    // production wiring (lifecycle-bridge.ts: same bridgeWorkerId used for both
    // fetchAndLock and makeExternalTaskDeliver).
    const flowableClient = new MockFlowableClientForBridgeWorkerIdTest();
    const externalTaskId = "ext-defer-1";
    const pgJobStoreStub = {
      pool: makePoolDouble(producedRow.aggregateId, externalTaskId),
    } as unknown as PostgresJobStore;

    const deliver = makeExternalTaskDeliver(flowableClient, pgJobStoreStub, undefined, BRIDGE_LOCK_HOLDER);

    const outboxRowForDeliver: OutboxRow = {
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
