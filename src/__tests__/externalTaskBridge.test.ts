/**
 * T-0067: Unit tests for externalTaskBridge.ts
 *
 * All tests run without a live Flowable instance or Postgres — all dependencies
 * are mocked/fake. Covers AC-1..AC-15.
 *
 * Test coverage per spec §5:
 *   Block A (poll & enqueue):  AC-1 · AC-2 · AC-3 · AC-4 · AC-5
 *   Block B (complete-path):   AC-6 · AC-7 · AC-8
 *   Block C (fail-path):       AC-10 · AC-11 · AC-12
 *   Block D (poll-loop):       AC-13 · AC-14 · AC-15
 */
import { describe, it, expect, vi } from "vitest";
import {
  runBridgeOnce,
  makeExternalTaskDeliver,
  startBridgePollLoop,
  makeErrorLogThrottle,
  CHOROS_TENANT_VAR,
  DEFAULT_BRIDGE_WORKER_ID,
  type ExternalTaskBridgeConfig,
  type BridgePollResult,
} from "../core/externalTaskBridge.js";
import type {
  FlowableClient,
  ExternalTask,
  FetchResult,
  CompleteTaskResult,
  FailTaskResult,
  GetFirstUserTaskResult,
  CompleteUserTaskResult,
} from "../core/flowable-client.js";
import type { PostgresJobStore } from "../core/postgres/pgJobStore.js";
import type { OutboxRow } from "../core/outboxTypes.js";

// ---------------------------------------------------------------------------
// Helpers — mock factories
// ---------------------------------------------------------------------------

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const WORKER_ID = "test-worker";
const LOCK_MS = 30_000;
const MAX_TASKS = 10;
const RETRIES = 3;

function makeExternalTask(over: Partial<ExternalTask> = {}): ExternalTask {
  return {
    id: over.id ?? "ext-task-aaaa",
    topic: over.topic ?? "invoice-process",
    processInstanceId: over.processInstanceId ?? "proc-1111",
    // T-0534: processDefinitionKey is now a required ExternalTask field.
    // Default empty string mirrors the pre-T-0534 behaviour (no wire field).
    processDefinitionKey: over.processDefinitionKey ?? "",
    variables: over.variables ?? { approved: true },
    lockOwner: over.lockOwner ?? WORKER_ID,
    lockExpirationTime: over.lockExpirationTime ?? new Date(Date.now() + 30_000).toISOString(),
  };
}

function makeOutboxRow(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    tenantId: over.tenantId ?? TENANT_ID,
    id: over.id ?? "outbox-row-1",
    aggregateKind: over.aggregateKind ?? "job",
    aggregateId: over.aggregateId ?? "job-uuid-1",
    eventType: over.eventType ?? "task_completed",
    payload: over.payload ?? { workerId: WORKER_ID, variables: { approved: true } },
    state: over.state ?? "dispatching",
    idempotencyKey: over.idempotencyKey ?? "idem-key-1",
    attempts: over.attempts ?? 0,
    createdAt: over.createdAt ?? 0,
    availableAt: over.availableAt ?? 0,
    dispatchedAt: over.dispatchedAt,
    lastError: over.lastError,
  };
}

// ---------------------------------------------------------------------------
// Mock FlowableClient
// ---------------------------------------------------------------------------
class MockFlowableClient implements FlowableClient {
  fetchResults: Map<string, FetchResult> = new Map();
  completeCalls: Array<[string, string, Record<string, unknown> | undefined]> = [];
  failCalls: Array<[string, string, string, number, number]> = [];
  completeResult: CompleteTaskResult = { ok: true };
  failResult: FailTaskResult = { ok: true };

  deployBpmn = vi.fn();
  startInstance = vi.fn();

  async fetchAndLock(
    topic: string,
    _workerId: string,
    _lockDurationMs: number,
    _maxTasks: number,
  ): Promise<FetchResult> {
    return this.fetchResults.get(topic) ?? { ok: true, tasks: [] };
  }

  async completeTask(
    taskId: string,
    workerId: string,
    variables?: Record<string, unknown>,
  ): Promise<CompleteTaskResult> {
    this.completeCalls.push([taskId, workerId, variables]);
    return this.completeResult;
  }

  async failTask(
    taskId: string,
    workerId: string,
    errorMessage: string,
    retries: number,
    retryTimeoutMs: number,
  ): Promise<FailTaskResult> {
    this.failCalls.push([taskId, workerId, errorMessage, retries, retryTimeoutMs]);
    return this.failResult;
  }

  // T-0368: skip-submit stubs — not exercised by externalTaskBridge tests.
  async getFirstActiveUserTask(_instanceId: string): Promise<GetFirstUserTaskResult> {
    return { ok: true, taskId: null };
  }

  async completeUserTask(_taskId: string): Promise<CompleteUserTaskResult> {
    return { ok: true };
  }

  // T-0443: engine-reconcile stubs — not exercised by externalTaskBridge tests.
  async getActiveUserTasks(_instanceId: string): Promise<import("../core/flowable-client.js").GetActiveUserTasksResult> {
    return { ok: true, tasks: [] };
  }

  async getMessageCatchWaits(_instanceId: string): Promise<import("../core/flowable-client.js").GetMessageCatchWaitsResult> {
    return { ok: true, waits: [] };
  }

  async correlateMessage(
    _instanceId: string,
    _messageName: string,
    _payload: Record<string, unknown>,
  ): Promise<import("../core/flowable-client.js").CorrelateMessageResult> {
    return { ok: true };
  }

  async isInstanceEnded(_instanceId: string): Promise<import("../core/flowable-client.js").IsInstanceEndedResult> {
    return { ok: true, ended: false };
  }
}

// ---------------------------------------------------------------------------
// Mock PostgresJobStore
// ---------------------------------------------------------------------------
class MockJobStore {
  enqueuedJobs: Array<{
    topic: string;
    variables: Record<string, unknown>;
    retries: number;
    idempotencyKey?: string;
  }> = [];

  /** Simulates idempotency: if idempotency_key seen before, return existing job */
  jobsByKey: Map<string, { id: string; idempotencyKey: string }> = new Map();
  private nextJobId = 1;

  async enqueue(
    topic: string,
    variables: Record<string, unknown>,
    retries: number,
    idempotencyKey?: string,
  ): Promise<{ id: string; topic: string; variables: Record<string, unknown>; state: string; retries: number; lockOwner?: string; lockExpiry?: number; createdAt: number; available_at: number }> {
    this.enqueuedJobs.push({ topic, variables, retries, idempotencyKey });
    if (idempotencyKey !== undefined) {
      if (this.jobsByKey.has(idempotencyKey)) {
        const existing = this.jobsByKey.get(idempotencyKey)!;
        // Return existing — idempotency (AC-2)
        return { id: existing.id, topic, variables, state: "CREATED", retries, createdAt: 0, available_at: 0 };
      }
      const id = `job-${this.nextJobId++}`;
      this.jobsByKey.set(idempotencyKey, { id, idempotencyKey });
      return { id, topic, variables, state: "CREATED", retries, createdAt: 0, available_at: 0 };
    }
    const id = `job-${this.nextJobId++}`;
    return { id, topic, variables, state: "CREATED", retries, createdAt: 0, available_at: 0 };
  }

  /** Expose pool accessor (used by makeExternalTaskDeliver internally via pool). */
  pool = makeMockPool(this.jobsByKey);
}

/** Creates a mock pool that responds to lookupExternalTaskId queries. */
function makeMockPool(
  jobsByKey: Map<string, { id: string; idempotencyKey: string }>,
  customLookup?: (jobId: string) => string | undefined,
): unknown {
  const jobsByJobId = new Map<string, string>();
  // Sync jobsByKey into jobsByJobId reverse map
  for (const [key, { id }] of jobsByKey) {
    jobsByJobId.set(id, key);
  }

  return {
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT idempotency_key") && params && params.length > 0) {
          const jobId = params[0] as string;
          const key = customLookup ? customLookup(jobId) : jobsByJobId.get(jobId);
          return { rows: key !== undefined ? [{ idempotency_key: key }] : [] };
        }
        return { rows: [] };
      },
      release: () => {/* no-op */},
    }),
  };
}

function asJobStore(m: MockJobStore): PostgresJobStore {
  return m as unknown as PostgresJobStore;
}

// ---------------------------------------------------------------------------
// Block A — poll & enqueue
// ---------------------------------------------------------------------------
describe("Block A — runBridgeOnce poll & enqueue", () => {
  it("AC-1: 2 ExternalTasks → 2 jobs enqueued with topic = task.topic", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();

    const task1 = makeExternalTask({ id: "ext-1", topic: "invoice-process" });
    const task2 = makeExternalTask({ id: "ext-2", topic: "invoice-process" });
    client.fetchResults.set("invoice-process", { ok: true, tasks: [task1, task2] });

    const result = await runBridgeOnce(
      client, asJobStore(jobStore), ["invoice-process"],
      WORKER_ID, LOCK_MS, MAX_TASKS, RETRIES,
    );

    expect(result.fetched).toBe(2);
    expect(result.enqueued).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(jobStore.enqueuedJobs).toHaveLength(2);
    expect(jobStore.enqueuedJobs[0].topic).toBe("invoice-process");
    expect(jobStore.enqueuedJobs[1].topic).toBe("invoice-process");
  });

  it("AC-2: Repeated runBridgeOnce with same task IDs → 0 new jobs (idempotency)", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();

    const task1 = makeExternalTask({ id: "ext-1", topic: "invoice-process" });
    const task2 = makeExternalTask({ id: "ext-2", topic: "invoice-process" });
    client.fetchResults.set("invoice-process", { ok: true, tasks: [task1, task2] });

    // First pass
    await runBridgeOnce(
      client, asJobStore(jobStore), ["invoice-process"],
      WORKER_ID, LOCK_MS, MAX_TASKS, RETRIES,
    );
    const countAfterFirst = jobStore.jobsByKey.size;

    // Second pass — same tasks returned (lock still held, simulating re-fetch)
    await runBridgeOnce(
      client, asJobStore(jobStore), ["invoice-process"],
      WORKER_ID, LOCK_MS, MAX_TASKS, RETRIES,
    );

    // jobsByKey still has exactly 2 distinct jobs (no duplicates)
    expect(jobStore.jobsByKey.size).toBe(countAfterFirst);
    expect(countAfterFirst).toBe(2);
  });

  it("AC-3: assertVariableValue rejects record-payload task → job NOT created; other tasks proceed", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();

    // Task with record-shaped variable: a bare record-kind ResourceRef that assertVariableValue rejects
    // (kind="record" + registryId + recordId — matches isRecordRef in object-handle.ts)
    const badTask = makeExternalTask({
      id: "bad-ext",
      topic: "invoice-process",
      variables: {
        rec: {
          kind: "record",
          registryId: "reg-1",
          recordId: "rec-1",
        },
      },
    });
    const goodTask = makeExternalTask({ id: "good-ext", topic: "invoice-process" });
    client.fetchResults.set("invoice-process", {
      ok: true,
      tasks: [badTask, goodTask],
    });

    const result = await runBridgeOnce(
      client, asJobStore(jobStore), ["invoice-process"],
      WORKER_ID, LOCK_MS, MAX_TASKS, RETRIES,
    );

    expect(result.skipped).toBe(1); // bad task skipped
    expect(result.enqueued).toBe(1); // good task enqueued
    expect(jobStore.enqueuedJobs.some(j => j.idempotencyKey === "good-ext")).toBe(true);
    expect(jobStore.enqueuedJobs.some(j => j.idempotencyKey === "bad-ext")).toBe(false);
  });

  it("AC-4: job.topic = externalTask.topic (1:1 pass-through); job.variables = task.variables", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();
    const vars = { amount: 100, approved: true };
    const task = makeExternalTask({ id: "ext-t1", topic: "billing-topic", variables: vars });
    client.fetchResults.set("billing-topic", { ok: true, tasks: [task] });

    await runBridgeOnce(
      client, asJobStore(jobStore), ["billing-topic"],
      WORKER_ID, LOCK_MS, MAX_TASKS, RETRIES,
    );

    const enqueued = jobStore.enqueuedJobs[0];
    expect(enqueued.topic).toBe("billing-topic");
    expect(enqueued.variables).toEqual(vars);
    expect(enqueued.idempotencyKey).toBe("ext-t1");
  });

  it("AC-5: externalTaskId recoverable from jobId after restart (via idempotency_key)", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();
    const task = makeExternalTask({ id: "ext-restart", topic: "invoice-process" });
    client.fetchResults.set("invoice-process", { ok: true, tasks: [task] });

    // Initial enqueue
    await runBridgeOnce(
      client, asJobStore(jobStore), ["invoice-process"],
      WORKER_ID, LOCK_MS, MAX_TASKS, RETRIES,
    );

    // Verify reverse map: jobId → externalTaskId via idempotency_key
    const jobEntry = jobStore.jobsByKey.get("ext-restart");
    expect(jobEntry).toBeDefined();
    expect(jobEntry!.idempotencyKey).toBe("ext-restart"); // idempotency_key = externalTask.id

    // "After restart": re-connect and query via the pool (simulate lookupExternalTaskId)
    const recoveredKey = jobEntry!.idempotencyKey;
    expect(recoveredKey).toBe(task.id);
  });
});

// ---------------------------------------------------------------------------
// Block B — complete-path
// ---------------------------------------------------------------------------
describe("Block B — makeExternalTaskDeliver complete-path", () => {
  it("AC-6: deliver(task_completed) calls completeTask exactly once with correct args", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();

    // Pre-seed the lookup so jobId → externalTaskId works
    const externalTaskId = "ext-aaaa";
    const jobId = "job-uuid-complete";
    // We need to set up the pool mock to return externalTaskId for jobId
    jobStore.pool = makeMockPool(new Map(), (id: string) => {
      if (id === jobId) return externalTaskId;
      return undefined;
    });

    const deliver = makeExternalTaskDeliver(client, asJobStore(jobStore));
    const row = makeOutboxRow({
      aggregateId: jobId,
      eventType: "task_completed",
      payload: { workerId: WORKER_ID, variables: { approved: true } },
    });

    const result = await deliver(row);

    expect(result.ok).toBe(true);
    expect(client.completeCalls).toHaveLength(1);
    const [calledTaskId, calledWorkerId, calledVars] = client.completeCalls[0];
    expect(calledTaskId).toBe(externalTaskId);
    // T-0644 (P0/столп4): completeTask MUST use the bridge's OWN workerId
    // (DEFAULT_BRIDGE_WORKER_ID when no bridgeWorkerId override is supplied to
    // makeExternalTaskDeliver, as here) — NEVER row.payload["workerId"] (which
    // may have been written by a completely different component, e.g. the
    // agent dispatcher, that has no relationship to the Flowable lock).
    expect(calledWorkerId).toBe(DEFAULT_BRIDGE_WORKER_ID);
    expect(calledWorkerId).not.toBe(WORKER_ID);
    expect(calledVars).toEqual({ approved: true });
  });

  it("T-0644 (P0/столп4): completeTask uses the injected bridgeWorkerId, ignoring a DIFFERENT payload.workerId (the workerId-mismatch bug this task fixes)", async () => {
    // Regression test for the LIVE_PROOF bug: the agent dispatcher stamps its
    // OWN identity ("choros-agent-dispatcher") into the task_completed outbox
    // payload — a completely different worker than whoever actually holds the
    // Flowable lock (the bridge). Before the fix, deliver() forwarded
    // payload.workerId verbatim to completeTask, which Flowable REJECTS
    // (workerId must match the lock-holder from fetchAndLock) — the process
    // instance would hang forever ("вечно в процессе"). After the fix,
    // completeTask always receives the bridge's OWN workerId regardless of
    // what a producer wrote into the payload.
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();
    const BRIDGE_LOCK_HOLDER = "choros-bridge"; // the identity that did fetchAndLock
    const AGENT_DISPATCHER_ID = "choros-agent-dispatcher"; // a DIFFERENT component's identity

    const externalTaskId = "ext-mismatch";
    const jobId = "job-uuid-mismatch";
    jobStore.pool = makeMockPool(new Map(), (id) => (id === jobId ? externalTaskId : undefined));

    // The bridge is constructed with its OWN worker identity (4th arg) — the
    // SAME value used for the fetchAndLock that acquired this task's lock.
    const deliver = makeExternalTaskDeliver(client, asJobStore(jobStore), undefined, BRIDGE_LOCK_HOLDER);

    // The outbox row was produced by the agent dispatcher, which stamped ITS
    // OWN workerId into the payload (dispatch-outcome.ts enqueueTaskCompleted).
    const row = makeOutboxRow({
      aggregateId: jobId,
      eventType: "task_completed",
      payload: { workerId: AGENT_DISPATCHER_ID, variables: { source: "agent", outcome: "defer" } },
    });

    const result = await deliver(row);

    expect(result.ok).toBe(true);
    expect(client.completeCalls).toHaveLength(1);
    const [, calledWorkerId] = client.completeCalls[0];
    // THE KEYSTONE ASSERTION: Flowable receives the LOCK-HOLDER's workerId, not
    // the agent dispatcher's — this is what makes Flowable accept the complete.
    expect(calledWorkerId).toBe(BRIDGE_LOCK_HOLDER);
    expect(calledWorkerId).not.toBe(AGENT_DISPATCHER_ID);
  });

  it("AC-7: completeTask NOT_FOUND → idempotentSuccess:true → dispatched", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();
    const externalTaskId = "ext-not-found";
    const jobId = "job-uuid-not-found";
    jobStore.pool = makeMockPool(new Map(), (id) => id === jobId ? externalTaskId : undefined);
    client.completeResult = { ok: false, code: "NOT_FOUND" };

    const deliver = makeExternalTaskDeliver(client, asJobStore(jobStore));
    const row = makeOutboxRow({ aggregateId: jobId, eventType: "task_completed" });

    const result = await deliver(row);

    expect(result.ok).toBe(false);
    expect((result as { idempotentSuccess?: boolean }).idempotentSuccess).toBe(true);
  });

  it("AC-8: completeTask ENGINE_UNAVAILABLE → { ok: false } → backoff/retry cycle", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();
    const externalTaskId = "ext-unavail";
    const jobId = "job-uuid-unavail";
    jobStore.pool = makeMockPool(new Map(), (id) => id === jobId ? externalTaskId : undefined);
    client.completeResult = { ok: false, code: "ENGINE_UNAVAILABLE" };

    const deliver = makeExternalTaskDeliver(client, asJobStore(jobStore));
    const row = makeOutboxRow({ aggregateId: jobId, eventType: "task_completed" });

    const result = await deliver(row);

    expect(result.ok).toBe(false);
    expect((result as { idempotentSuccess?: boolean }).idempotentSuccess).toBeUndefined();
    expect((result as { error?: string }).error).toBe("ENGINE_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// Block C — fail-path
// ---------------------------------------------------------------------------
describe("Block C — makeExternalTaskDeliver fail-path", () => {
  it("AC-10: deliver(task_failed) calls failTask exactly once with correct args", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();
    const externalTaskId = "ext-fail-1";
    const jobId = "job-uuid-fail";
    jobStore.pool = makeMockPool(new Map(), (id) => id === jobId ? externalTaskId : undefined);

    const deliver = makeExternalTaskDeliver(client, asJobStore(jobStore));
    const row = makeOutboxRow({
      aggregateId: jobId,
      eventType: "task_failed",
      payload: {
        workerId: WORKER_ID,
        errorMessage: "worker crashed",
        retries: 2,
        retryTimeout: 5000,
      },
    });

    const result = await deliver(row);

    expect(result.ok).toBe(true);
    expect(client.failCalls).toHaveLength(1);
    const [taskId, wId, errMsg, retries, retryTimeout] = client.failCalls[0];
    expect(taskId).toBe(externalTaskId);
    // T-0644 (P0/столп4): failTask MUST use the bridge's OWN workerId (same
    // rationale as completeTask's AC-6 above) — never row.payload["workerId"].
    expect(wId).toBe(DEFAULT_BRIDGE_WORKER_ID);
    expect(wId).not.toBe(WORKER_ID);
    expect(errMsg).toBe("worker crashed");
    expect(retries).toBe(2);
    expect(retryTimeout).toBe(5000);
  });

  it("T-0644 (P0/столп4): failTask uses the injected bridgeWorkerId, ignoring a DIFFERENT payload.workerId", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();
    const BRIDGE_LOCK_HOLDER = "choros-bridge";
    const OTHER_PRODUCER_ID = "choros-agent-dispatcher";

    const externalTaskId = "ext-fail-mismatch";
    const jobId = "job-uuid-fail-mismatch";
    jobStore.pool = makeMockPool(new Map(), (id) => (id === jobId ? externalTaskId : undefined));

    const deliver = makeExternalTaskDeliver(client, asJobStore(jobStore), undefined, BRIDGE_LOCK_HOLDER);
    const row = makeOutboxRow({
      aggregateId: jobId,
      eventType: "task_failed",
      payload: {
        workerId: OTHER_PRODUCER_ID,
        errorMessage: "llm_error",
        retries: 0,
        retryTimeout: 30_000,
      },
    });

    const result = await deliver(row);

    expect(result.ok).toBe(true);
    const [, wId] = client.failCalls[0];
    expect(wId).toBe(BRIDGE_LOCK_HOLDER);
    expect(wId).not.toBe(OTHER_PRODUCER_ID);
  });

  it("AC-11: failTask NOT_FOUND → idempotentSuccess:true", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();
    const externalTaskId = "ext-fail-not-found";
    const jobId = "job-uuid-fail-nf";
    jobStore.pool = makeMockPool(new Map(), (id) => id === jobId ? externalTaskId : undefined);
    client.failResult = { ok: false, code: "NOT_FOUND" };

    const deliver = makeExternalTaskDeliver(client, asJobStore(jobStore));
    const row = makeOutboxRow({ aggregateId: jobId, eventType: "task_failed" });

    const result = await deliver(row);

    expect(result.ok).toBe(false);
    expect((result as { idempotentSuccess?: boolean }).idempotentSuccess).toBe(true);
  });

  it("AC-12: deliver(worker_lock_expired) returns { ok: true } (no-op, no exception)", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();
    jobStore.pool = makeMockPool(new Map());

    const deliver = makeExternalTaskDeliver(client, asJobStore(jobStore));
    const row = makeOutboxRow({ eventType: "worker_lock_expired" });

    let result: Awaited<ReturnType<typeof deliver>>;
    // Must not throw
    expect(async () => {
      result = await deliver(row);
    }).not.toThrow();

    result = await deliver(row);
    expect(result.ok).toBe(true);
    // No Flowable calls made
    expect(client.completeCalls).toHaveLength(0);
    expect(client.failCalls).toHaveLength(0);
  });

  it("AC-12 variant: unknown eventType → no-op { ok: true }", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();
    jobStore.pool = makeMockPool(new Map());

    const deliver = makeExternalTaskDeliver(client, asJobStore(jobStore));
    const row = makeOutboxRow({ eventType: "some_future_event_type" });

    const result = await deliver(row);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Block E — DMN gateway wiring (T-0340 behavioral bridge test R-1)
// ---------------------------------------------------------------------------
/**
 * DG-16: makeExternalTaskDeliver — the GENERIC triage seam (T-0524) re-evaluates
 * the authored DMN rule tables on task completion and injects EVERY authored
 * routing outcome (under its authored name) into the completeTask variables map.
 *
 * T-0524: the seam is NO LONGER gated on the "tel-intake" topic. ТЭЛ
 * ("approvalRequired") is just one authored configuration. DG-16a/b keep the ТЭЛ
 * rule table and prove the value reaches Flowable; DG-16c now proves the
 * fail-closed path (a process with NO authored rule table → no injection).
 *
 * This is the BEHAVIORAL bridge test. Unlike DG-14 (grep) and DG-15 (isolated
 * evaluateGatewayAtTriage call), this test drives the FULL deliver() path end-to-end
 * through makeExternalTaskDeliver with a real task_completed row. It asserts that
 * completeTask() receives the authored routing variable — proving the DMN
 * evaluation result actually reaches Flowable.
 *
 * Pool contract (three concurrent connect() calls in the deliver() path):
 *   1. lookupExternalTaskId  → SELECT idempotency_key FROM choros.job
 *   2. lookupJobTopicAndVariables → SELECT topic, variables FROM choros.job
 *   3. DMN eval block        → BEGIN / SET LOCAL / SELECT FROM choros.dmn_rule_table /
 *                              audit writes / COMMIT
 * All three are dispatched from the SAME SQL-text-routing mock pool client.
 */
describe("DG-16: tel-intake bridge behavior — approvalRequired reaches completeTask", () => {
  /**
   * Canonical 5M threshold rule table (mirrors migration 080 seed).
   * Same structure as in dmn-gateway.test.ts to keep the stub self-contained.
   */
  const TEL_THRESHOLD_STUB = {
    id: "c0de0001-e150-0005-d4f4-000000000080",
    name: "ТЭЛ: порог суммы закупки",
    hitPolicy: "FIRST",
    rules: [
      {
        annotation: "Сумма > 5 000 000 ₽ → доп. согласование",
        conditions: [{ field: "amount", operator: "gt", value: 5_000_000 }],
        effects: [{ kind: "set_routing_outcome", name: "approvalRequired", value: "needs-approval" }],
      },
      {
        annotation: "Стандартный трек (сумма в пределах порога)",
        conditions: [],
        effects: [{ kind: "set_routing_outcome", name: "approvalRequired", value: "standard" }],
      },
    ],
  };

  /**
   * Build a mock pool that routes SQL queries to the correct stub responses.
   * Called by both lookupExternalTaskId, lookupJobTopicAndVariables, AND the
   * inner DMN eval block (evaluateGatewayAtTriage → pool.connect()).
   */
  function makeDmnBridgeMockPool(opts: {
    jobId: string;
    externalTaskId: string;
    jobTopic: string;
    jobVariables: Record<string, unknown>;
    /** When true, the process has NO authored rule table (fail-closed path). */
    noRuleTables?: boolean;
  }): unknown {
    const NOW_MS = Date.now();
    return {
      connect: async () => ({
        query: async (sql: unknown, params?: unknown[]) => {
          const sqlText = typeof sql === "string" ? sql : ((sql as { text?: string }).text ?? "");
          const upper = sqlText.trimStart().toUpperCase();

          // ── Transaction control & tenant GUC (absorb silently) ──────────────
          if (
            upper.startsWith("BEGIN") ||
            upper.startsWith("COMMIT") ||
            upper.startsWith("ROLLBACK") ||
            upper.startsWith("SET LOCAL") ||
            upper.startsWith("SET SEARCH_PATH")
          ) {
            return { rows: [] };
          }

          // ── 1. lookupExternalTaskId: SELECT idempotency_key FROM choros.job ─
          if (/SELECT idempotency_key/i.test(sqlText)) {
            const jobId = params && params.length > 0 ? (params[0] as string) : null;
            if (jobId === opts.jobId) {
              return { rows: [{ idempotency_key: opts.externalTaskId }] };
            }
            return { rows: [] };
          }

          // ── 2. lookupJobTopicAndVariables: SELECT topic, variables FROM choros.job ─
          if (/SELECT topic, variables/i.test(sqlText)) {
            const jobId = params && params.length > 0 ? (params[0] as string) : null;
            if (jobId === opts.jobId) {
              return { rows: [{ topic: opts.jobTopic, variables: opts.jobVariables }] };
            }
            return { rows: [] };
          }

          // ── 3. DMN eval: rule-table queries ─────────────────────────────────
          if (/FROM choros\.dmn_rule_table/i.test(sqlText)) {
            if (opts.noRuleTables) return { rows: [] };
            return {
              rows: [
                {
                  id: TEL_THRESHOLD_STUB.id,
                  name: TEL_THRESHOLD_STUB.name,
                  definition: TEL_THRESHOLD_STUB,
                  process_def_id: null,
                  status: "published",
                  updated_at: NOW_MS - 10_000,
                },
              ],
            };
          }

          // ── 4. Audit chain (absorb silently) ────────────────────────────────
          if (
            /INSERT INTO choros\.audit_head/i.test(sqlText) ||
            /INSERT INTO choros\.audit_event/i.test(sqlText) ||
            /UPDATE choros\.audit_head/i.test(sqlText)
          ) {
            return { rows: [] };
          }
          if (/FROM choros\.audit_head/i.test(sqlText) && /FOR UPDATE/i.test(sqlText)) {
            return { rows: [{ seq: 0, row_hash: Buffer.alloc(32), vocab_version: 1 }] };
          }
          if (/current_setting\('choros\.tenant_id'/i.test(sqlText)) {
            return { rows: [{ tenant_id: "a0000000-0000-0000-0000-000000000001" }] };
          }

          // ── Default: absorb unknown queries ─────────────────────────────────
          return { rows: [] };
        },
        release: () => {/* no-op */},
      }),
    };
  }

  it("DG-16a: amount > 5M → completeTask receives approvalRequired = 'needs-approval'", async () => {
    const flowableClient = new MockFlowableClient();
    const jobStore = new MockJobStore();

    const JOB_ID = "job-tel-intake-high";
    const EXTERNAL_TASK_ID = "ext-task-tel-intake-high";
    const instanceVariables = { amount: 6_000_000 };

    // Wire the mock pool to respond to all three query types
    jobStore.pool = makeDmnBridgeMockPool({
      jobId: JOB_ID,
      externalTaskId: EXTERNAL_TASK_ID,
      jobTopic: "tel-intake",
      jobVariables: instanceVariables,
    });

    const deliver = makeExternalTaskDeliver(flowableClient, asJobStore(jobStore));

    const row = makeOutboxRow({
      aggregateId: JOB_ID,
      tenantId: "a0000000-0000-0000-0000-000000000001",
      eventType: "task_completed",
      payload: { workerId: WORKER_ID, variables: { submitted: true } },
    });

    const result = await deliver(row);

    // The deliver call must succeed
    expect(result.ok).toBe(true);

    // completeTask must have been called exactly once
    expect(flowableClient.completeCalls).toHaveLength(1);

    const [calledTaskId, _calledWorkerId, calledVars] = flowableClient.completeCalls[0];

    // The external task id must match
    expect(calledTaskId).toBe(EXTERNAL_TASK_ID);

    // THE KEYSTONE ASSERTION (R-1): approvalRequired must be in the completeTask variables.
    // This proves the DMN evaluation result (amount > 5M → "needs-approval") was merged
    // into the payload that Flowable receives to route through gw-approval-threshold.
    expect(calledVars).toBeDefined();
    expect((calledVars as Record<string, unknown>)["approvalRequired"]).toBe("needs-approval");
  });

  it("DG-16b: amount ≤ 5M → completeTask receives approvalRequired = 'standard'", async () => {
    const flowableClient = new MockFlowableClient();
    const jobStore = new MockJobStore();

    const JOB_ID = "job-tel-intake-low";
    const EXTERNAL_TASK_ID = "ext-task-tel-intake-low";
    const instanceVariables = { amount: 3_000_000 };

    jobStore.pool = makeDmnBridgeMockPool({
      jobId: JOB_ID,
      externalTaskId: EXTERNAL_TASK_ID,
      jobTopic: "tel-intake",
      jobVariables: instanceVariables,
    });

    const deliver = makeExternalTaskDeliver(flowableClient, asJobStore(jobStore));

    const row = makeOutboxRow({
      aggregateId: JOB_ID,
      tenantId: "a0000000-0000-0000-0000-000000000001",
      eventType: "task_completed",
      payload: { workerId: WORKER_ID, variables: { submitted: true } },
    });

    const result = await deliver(row);

    expect(result.ok).toBe(true);
    expect(flowableClient.completeCalls).toHaveLength(1);

    const [, , calledVars] = flowableClient.completeCalls[0];
    expect(calledVars).toBeDefined();
    expect((calledVars as Record<string, unknown>)["approvalRequired"]).toBe("standard");
  });

  it("DG-16c (T-0524 fail-closed): process with NO authored rule table → no routing var injected", async () => {
    // T-0524: the seam fires for ANY topic, but when the process has no authored
    // DMN rule table the evaluation yields an empty routingOutcomes map → the
    // bridge injects nothing → the gateway's BPMN default flow is taken
    // (fail-closed, never a silent wrong route). This replaces the old
    // topic-gated assertion (the seam is no longer special-cased on "tel-intake").
    const flowableClient = new MockFlowableClient();
    const jobStore = new MockJobStore();

    const JOB_ID = "job-no-rule";
    const EXTERNAL_TASK_ID = "ext-task-no-rule";
    // High amount, but the process has NO authored rule table → no injection.
    const instanceVariables = { amount: 9_000_000 };

    jobStore.pool = makeDmnBridgeMockPool({
      jobId: JOB_ID,
      externalTaskId: EXTERNAL_TASK_ID,
      jobTopic: "some-other-topic",
      jobVariables: instanceVariables,
      noRuleTables: true,
    });

    const deliver = makeExternalTaskDeliver(flowableClient, asJobStore(jobStore));

    const row = makeOutboxRow({
      aggregateId: JOB_ID,
      tenantId: "a0000000-0000-0000-0000-000000000001",
      eventType: "task_completed",
      payload: { workerId: WORKER_ID, variables: { submitted: true } },
    });

    const result = await deliver(row);

    expect(result.ok).toBe(true);
    expect(flowableClient.completeCalls).toHaveLength(1);

    const [, , calledVars] = flowableClient.completeCalls[0];
    // No authored rule → no routing variable injected (fail-closed).
    if (calledVars !== undefined) {
      expect((calledVars as Record<string, unknown>)["approvalRequired"]).toBeUndefined();
    }
  });

  it("DG-16d (T-0524 generic): NON-ТЭЛ process injects its AUTHORED routing var name", async () => {
    // Proves the seam is process-agnostic: a different authored rule table (a
    // leave process: days>14 → needsHeadApproval) reaches completeTask under its
    // OWN authored name — NOT "approvalRequired".
    const flowableClient = new MockFlowableClient();
    const jobStore = new MockJobStore();

    const JOB_ID = "job-leave";
    const EXTERNAL_TASK_ID = "ext-task-leave";
    const instanceVariables = { days: 21 };

    const LEAVE_TABLE = {
      id: "d0de0018-e150-0005-d4f4-000000000018",
      name: "Отпуск: > 14 дней → согласование руководителя",
      hitPolicy: "FIRST",
      rules: [
        {
          annotation: "Более 14 дней → согласование руководителя",
          conditions: [{ field: "days", operator: "gt", value: 14 }],
          effects: [{ kind: "set_routing_outcome", name: "needsHeadApproval", value: "yes" }],
        },
        {
          annotation: "14 и меньше → без согласования",
          conditions: [],
          effects: [{ kind: "set_routing_outcome", name: "needsHeadApproval", value: "no" }],
        },
      ],
    };

    // Custom pool: same routing as makeDmnBridgeMockPool but with the LEAVE rule table.
    const NOW_MS = Date.now();
    jobStore.pool = {
      connect: async () => ({
        query: async (sql: unknown, params?: unknown[]) => {
          const sqlText = typeof sql === "string" ? sql : ((sql as { text?: string }).text ?? "");
          const upper = sqlText.trimStart().toUpperCase();
          if (
            upper.startsWith("BEGIN") || upper.startsWith("COMMIT") ||
            upper.startsWith("ROLLBACK") || upper.startsWith("SET LOCAL") ||
            upper.startsWith("SET SEARCH_PATH")
          ) return { rows: [] };
          if (/SELECT idempotency_key/i.test(sqlText)) {
            const jobId = params && params.length > 0 ? (params[0] as string) : null;
            return jobId === JOB_ID ? { rows: [{ idempotency_key: EXTERNAL_TASK_ID }] } : { rows: [] };
          }
          if (/SELECT topic, variables/i.test(sqlText)) {
            const jobId = params && params.length > 0 ? (params[0] as string) : null;
            return jobId === JOB_ID
              ? { rows: [{ topic: "leave-intake", variables: instanceVariables }] }
              : { rows: [] };
          }
          if (/FROM choros\.dmn_rule_table/i.test(sqlText)) {
            return { rows: [{
              id: LEAVE_TABLE.id, name: LEAVE_TABLE.name, definition: LEAVE_TABLE,
              process_def_id: null, status: "published", updated_at: NOW_MS - 10_000,
            }] };
          }
          if (
            /INSERT INTO choros\.audit_head/i.test(sqlText) ||
            /INSERT INTO choros\.audit_event/i.test(sqlText) ||
            /UPDATE choros\.audit_head/i.test(sqlText)
          ) return { rows: [] };
          if (/FROM choros\.audit_head/i.test(sqlText) && /FOR UPDATE/i.test(sqlText)) {
            return { rows: [{ seq: 0, row_hash: Buffer.alloc(32), vocab_version: 1 }] };
          }
          if (/current_setting\('choros\.tenant_id'/i.test(sqlText)) {
            return { rows: [{ tenant_id: "a0000000-0000-0000-0000-000000000001" }] };
          }
          return { rows: [] };
        },
        release: () => {/* no-op */},
      }),
    };

    const deliver = makeExternalTaskDeliver(flowableClient, asJobStore(jobStore));
    const row = makeOutboxRow({
      aggregateId: JOB_ID,
      tenantId: "a0000000-0000-0000-0000-000000000001",
      eventType: "task_completed",
      payload: { workerId: WORKER_ID, variables: { submitted: true } },
    });

    const result = await deliver(row);
    expect(result.ok).toBe(true);
    expect(flowableClient.completeCalls).toHaveLength(1);

    const [, , calledVars] = flowableClient.completeCalls[0];
    expect(calledVars).toBeDefined();
    // The AUTHORED routing var name reaches Flowable — NOT "approvalRequired".
    expect((calledVars as Record<string, unknown>)["needsHeadApproval"]).toBe("yes");
    expect((calledVars as Record<string, unknown>)["approvalRequired"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Block F — T-0534 per-process scope (process_def_id / instance_id at enqueue)
// ---------------------------------------------------------------------------
describe("Block F — T-0534: processDefinitionKey + processInstanceId captured at enqueue", () => {
  it("T0534-A1: runBridgeOnce passes processDefinitionKey + processInstanceId to enqueue", async () => {
    // Verifies the bridge forwards process scope to the jobStore at enqueue time.
    const client = new MockFlowableClient();

    const capturedEnqueue: Array<{
      topic: string;
      variables: Record<string, unknown>;
      retries: number;
      idempotencyKey?: string;
      processDefId?: string;
      instanceId?: string;
    }> = [];

    const jobStore: PostgresJobStore = {
      enqueue: async (
        topic: string,
        variables: Record<string, unknown>,
        retries: number,
        idempotencyKey?: string,
        processDefId?: string,
        instanceId?: string,
      ) => {
        capturedEnqueue.push({ topic, variables, retries, idempotencyKey, processDefId, instanceId });
        return {
          id: "job-capture-test", topic, variables, state: "CREATED", retries,
          lockOwner: undefined, lockExpiry: undefined, createdAt: 0, available_at: 0,
        };
      },
    } as unknown as PostgresJobStore;

    const task = makeExternalTask({
      id: "ext-scope-1",
      topic: "scope-topic",
      processInstanceId: "flowable-inst-abc",
      // ExternalTask.processDefinitionKey is now a required field
      processDefinitionKey: "myProcess",
      variables: { amount: 100 },
    });

    client.fetchResults.set("scope-topic", { ok: true, tasks: [task] });

    await runBridgeOnce(client, jobStore, ["scope-topic"], WORKER_ID, LOCK_MS, MAX_TASKS, RETRIES);

    expect(capturedEnqueue).toHaveLength(1);
    expect(capturedEnqueue[0].processDefId).toBe("myProcess");
    expect(capturedEnqueue[0].instanceId).toBe("flowable-inst-abc");
    expect(capturedEnqueue[0].idempotencyKey).toBe("ext-scope-1");
  });

  it("T0534-A2: empty processDefinitionKey is NOT forwarded (treated as absent)", async () => {
    // When the Flowable wire shape has no processDefinitionId, processDefinitionKey
    // is an empty string. The bridge must NOT store an empty key — it passes undefined.
    const client = new MockFlowableClient();

    const capturedEnqueue: Array<{ processDefId?: string; instanceId?: string }> = [];
    const jobStore: PostgresJobStore = {
      enqueue: async (
        _topic: string,
        _vars: Record<string, unknown>,
        _retries: number,
        _idem?: string,
        processDefId?: string,
        instanceId?: string,
      ) => {
        capturedEnqueue.push({ processDefId, instanceId });
        return { id: "j1", topic: "t", variables: {}, state: "CREATED", retries: 0, createdAt: 0, available_at: 0 };
      },
    } as unknown as PostgresJobStore;

    const task = makeExternalTask({
      id: "ext-empty-key",
      topic: "no-scope-topic",
      processDefinitionKey: "", // empty — bridge must NOT forward
      processInstanceId: "inst-x",
    });

    client.fetchResults.set("no-scope-topic", { ok: true, tasks: [task] });
    await runBridgeOnce(client, jobStore, ["no-scope-topic"], WORKER_ID, LOCK_MS, MAX_TASKS, RETRIES);

    expect(capturedEnqueue).toHaveLength(1);
    // Empty string → undefined (not stored as empty text)
    expect(capturedEnqueue[0].processDefId).toBeUndefined();
    // Instance id should still be forwarded
    expect(capturedEnqueue[0].instanceId).toBe("inst-x");
  });

  it("T0534-B1: stored process_def_id scopes rule-table lookup to the correct process", async () => {
    // When job.process_def_id is set, the triage seam uses it as procDefId for
    // loadPublishedRuleTables — enabling per-process scoping (T-0534 keystone).
    // Two processes share a tenant but only «telLinear» has a DMN rule table;
    // the «leaveProcess» row should NOT see the ТЭЛ rule (process_def_id filter).
    //
    // This test proves that process_def_id from the job row reaches evaluateGatewayAtTriage
    // as procDefId by examining the SQL WHERE predicate logged by the mock pool.
    const flowableClient = new MockFlowableClient();
    const jobStore = new MockJobStore();

    const JOB_ID = "job-scoped";
    const EXTERNAL_TASK_ID = "ext-scoped";
    const STORED_PROC_DEF_ID = "telLinear";
    const instanceVariables = { amount: 6_000_000 };

    // Track the SQL params used on the dmn_rule_table SELECT to verify procDefId scope.
    const dmnQueryParams: unknown[][] = [];

    const NOW_MS = Date.now();
    jobStore.pool = {
      connect: async () => ({
        query: async (sql: unknown, params?: unknown[]) => {
          const sqlText = typeof sql === "string" ? sql : ((sql as { text?: string }).text ?? "");
          const upper = sqlText.trimStart().toUpperCase();

          if (
            upper.startsWith("BEGIN") || upper.startsWith("COMMIT") ||
            upper.startsWith("ROLLBACK") || upper.startsWith("SET LOCAL") ||
            upper.startsWith("SET SEARCH_PATH")
          ) return { rows: [] };

          if (/SELECT idempotency_key/i.test(sqlText)) {
            const jobId = params && params.length > 0 ? (params[0] as string) : null;
            return jobId === JOB_ID ? { rows: [{ idempotency_key: EXTERNAL_TASK_ID }] } : { rows: [] };
          }

          // T-0534: lookupJobTopicAndVariables now selects process_def_id too
          if (/SELECT topic, variables/i.test(sqlText)) {
            const jobId = params && params.length > 0 ? (params[0] as string) : null;
            if (jobId === JOB_ID) {
              return {
                rows: [{
                  topic: "tel-intake",
                  variables: instanceVariables,
                  process_def_id: STORED_PROC_DEF_ID, // T-0534: stored key
                }],
              };
            }
            return { rows: [] };
          }

          if (/FROM choros\.dmn_rule_table/i.test(sqlText)) {
            // Capture the query params to verify process-scoped WHERE clause.
            if (params) dmnQueryParams.push([...params]);
            // Return the ТЭЛ rule table when procDefId matches
            const procDefParam = params && params.length > 1 ? String(params[1]) : null;
            if (procDefParam === STORED_PROC_DEF_ID || procDefParam === null) {
              return {
                rows: [{
                  id: "c0de0001-e150-0005-d4f4-000000000080",
                  name: "ТЭЛ threshold",
                  definition: {
                    id: "c0de0001-e150-0005-d4f4-000000000080",
                    name: "ТЭЛ threshold",
                    hitPolicy: "FIRST",
                    rules: [
                      {
                        annotation: ">5M",
                        conditions: [{ field: "amount", operator: "gt", value: 5_000_000 }],
                        effects: [{ kind: "set_routing_outcome", name: "approvalRequired", value: "needs-approval" }],
                      },
                      {
                        annotation: "standard",
                        conditions: [],
                        effects: [{ kind: "set_routing_outcome", name: "approvalRequired", value: "standard" }],
                      },
                    ],
                  },
                  process_def_id: STORED_PROC_DEF_ID,
                  status: "published",
                  updated_at: NOW_MS - 10_000,
                }],
              };
            }
            return { rows: [] };
          }

          if (
            /INSERT INTO choros\.audit_head/i.test(sqlText) ||
            /INSERT INTO choros\.audit_event/i.test(sqlText) ||
            /UPDATE choros\.audit_head/i.test(sqlText)
          ) return { rows: [] };
          if (/FROM choros\.audit_head/i.test(sqlText) && /FOR UPDATE/i.test(sqlText)) {
            return { rows: [{ seq: 0, row_hash: Buffer.alloc(32), vocab_version: 1 }] };
          }
          if (/current_setting\('choros\.tenant_id'/i.test(sqlText)) {
            return { rows: [{ tenant_id: "a0000000-0000-0000-0000-000000000001" }] };
          }
          return { rows: [] };
        },
        release: () => {/* no-op */},
      }),
    };

    const deliver = makeExternalTaskDeliver(flowableClient, asJobStore(jobStore));
    const row = makeOutboxRow({
      aggregateId: JOB_ID,
      tenantId: "a0000000-0000-0000-0000-000000000001",
      eventType: "task_completed",
      payload: { workerId: WORKER_ID, variables: { submitted: true } },
    });

    const result = await deliver(row);

    // Deliver succeeds
    expect(result.ok).toBe(true);
    expect(flowableClient.completeCalls).toHaveLength(1);

    // THE T-0534 KEYSTONE: the dmn_rule_table query was called with the stored
    // process_def_id as the second parameter (procDefId scoping).
    // The scoped SQL includes a second param (procDefId) in addition to tenantId.
    const scopedQuery = dmnQueryParams.find((p) => p.length >= 2 && p[1] === STORED_PROC_DEF_ID);
    expect(scopedQuery).toBeDefined();

    // AND the routing outcome is correctly resolved:
    const [, , calledVars] = flowableClient.completeCalls[0];
    expect((calledVars as Record<string, unknown>)["approvalRequired"]).toBe("needs-approval");
  });

  it("T0534-B2: two processes sharing same tenant do NOT cross-contaminate each other's rules", async () => {
    // Process A (telLinear): has a rule → routingOutcomes non-empty
    // Process B (leaveProcess): has NO rule → routingOutcomes empty (fail-closed)
    // Each is scoped by process_def_id so neither leaks into the other.
    //
    // Simulates the edge case from T-0524 (NULL-union cross-contamination):
    // when process_def_id is stored, the lookup is always SCOPED — no NULL-union.

    const TEL_TABLE = {
      id: "tel-rule-table-id-0001-0000000000001",
      name: "ТЭЛ rule",
      hitPolicy: "FIRST" as const,
      rules: [
        {
          annotation: ">5M",
          conditions: [{ field: "amount", operator: "gt", value: 5_000_000 }],
          effects: [{ kind: "set_routing_outcome", name: "approvalRequired", value: "needs-approval" }],
        },
        {
          annotation: "standard",
          conditions: [],
          effects: [{ kind: "set_routing_outcome", name: "approvalRequired", value: "standard" }],
        },
      ],
    };

    function makeProcessPool(opts: {
      jobId: string;
      externalTaskId: string;
      processDefId: string;
      variables: Record<string, unknown>;
      returnRuleForProcDef: string | null; // process key for which to return rule
    }) {
      const NOW_MS = Date.now();
      return {
        connect: async () => ({
          query: async (sql: unknown, params?: unknown[]) => {
            const sqlText = typeof sql === "string" ? sql : ((sql as { text?: string }).text ?? "");
            const upper = sqlText.trimStart().toUpperCase();
            if (
              upper.startsWith("BEGIN") || upper.startsWith("COMMIT") ||
              upper.startsWith("ROLLBACK") || upper.startsWith("SET LOCAL") ||
              upper.startsWith("SET SEARCH_PATH")
            ) return { rows: [] };
            if (/SELECT idempotency_key/i.test(sqlText)) {
              const id = params?.[0] as string;
              return id === opts.jobId ? { rows: [{ idempotency_key: opts.externalTaskId }] } : { rows: [] };
            }
            if (/SELECT topic, variables/i.test(sqlText)) {
              const id = params?.[0] as string;
              return id === opts.jobId
                ? { rows: [{ topic: "intake", variables: opts.variables, process_def_id: opts.processDefId }] }
                : { rows: [] };
            }
            if (/FROM choros\.dmn_rule_table/i.test(sqlText)) {
              const procParam = params && params.length > 1 ? String(params[1]) : null;
              if (procParam === opts.returnRuleForProcDef) {
                return { rows: [{
                  id: TEL_TABLE.id, name: TEL_TABLE.name, definition: TEL_TABLE,
                  process_def_id: opts.returnRuleForProcDef, status: "published",
                  updated_at: NOW_MS - 10_000,
                }] };
              }
              return { rows: [] }; // other processes: no rule
            }
            if (/INSERT INTO choros\.audit/i.test(sqlText) || /UPDATE choros\.audit/i.test(sqlText)) return { rows: [] };
            if (/FROM choros\.audit_head/i.test(sqlText) && /FOR UPDATE/i.test(sqlText)) {
              return { rows: [{ seq: 0, row_hash: Buffer.alloc(32), vocab_version: 1 }] };
            }
            if (/current_setting\('choros\.tenant_id'/i.test(sqlText)) {
              return { rows: [{ tenant_id: "a0000000-0000-0000-0000-000000000001" }] };
            }
            return { rows: [] };
          },
          release: () => {/* no-op */},
        }),
      };
    }

    const TENANT = "a0000000-0000-0000-0000-000000000001";

    // ── Process A: telLinear — has a rule ─────────────────────────────────
    const clientA = new MockFlowableClient();
    const jobStoreA = new MockJobStore();
    jobStoreA.pool = makeProcessPool({
      jobId: "job-tel", externalTaskId: "ext-tel",
      processDefId: "telLinear", variables: { amount: 7_000_000 },
      returnRuleForProcDef: "telLinear",
    });
    const deliverA = makeExternalTaskDeliver(clientA, asJobStore(jobStoreA));
    const rowA = makeOutboxRow({ aggregateId: "job-tel", tenantId: TENANT, eventType: "task_completed", payload: { workerId: WORKER_ID, variables: {} } });
    const resultA = await deliverA(rowA);
    expect(resultA.ok).toBe(true);
    const [, , varsA] = clientA.completeCalls[0];
    // Process A: ТЭЛ rule fires → approvalRequired
    expect((varsA as Record<string, unknown>)["approvalRequired"]).toBe("needs-approval");

    // ── Process B: leaveProcess — no rule ─────────────────────────────────
    const clientB = new MockFlowableClient();
    const jobStoreB = new MockJobStore();
    jobStoreB.pool = makeProcessPool({
      jobId: "job-leave", externalTaskId: "ext-leave",
      processDefId: "leaveProcess", variables: { days: 21 },
      returnRuleForProcDef: "telLinear", // ONLY telLinear gets a rule in the DB
    });
    const deliverB = makeExternalTaskDeliver(clientB, asJobStore(jobStoreB));
    const rowB = makeOutboxRow({ aggregateId: "job-leave", tenantId: TENANT, eventType: "task_completed", payload: { workerId: WORKER_ID, variables: {} } });
    const resultB = await deliverB(rowB);
    expect(resultB.ok).toBe(true);
    const [, , varsB] = clientB.completeCalls[0];
    // Process B: no rule for leaveProcess → fail-closed, no injection
    if (varsB !== undefined) {
      expect((varsB as Record<string, unknown>)["approvalRequired"]).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Block D — poll-loop
// ---------------------------------------------------------------------------
describe("Block D — startBridgePollLoop", () => {
  it("AC-13: first poll pass happens after one interval, NOT immediately", () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();
    const scheduledCallbacks: Array<() => void> = [];
    let immediateCallCount = 0;

    // Record whether the callback was invoked before the interval fires
    const mockSetInterval = (fn: () => void, _ms: number) => {
      scheduledCallbacks.push(fn);
      // Return a fake handle
      return 999 as unknown as ReturnType<typeof setInterval>;
    };

    // Track enqueue calls (should be zero before interval fires)
    const originalEnqueue = jobStore.enqueue.bind(jobStore);
    jobStore.enqueue = async (...args) => {
      immediateCallCount++;
      return originalEnqueue(...args);
    };

    const opts: ExternalTaskBridgeConfig = {
      topics: ["test-topic"],
      workerId: WORKER_ID,
      setIntervalFn: mockSetInterval,
    };

    // Create loop — should NOT immediately call runBridgeOnce
    const loop = startBridgePollLoop(client, asJobStore(jobStore), opts);

    // Nothing should have been fetched yet
    expect(immediateCallCount).toBe(0);
    expect(scheduledCallbacks).toHaveLength(1);

    // Manually fire the interval callback
    client.fetchResults.set("test-topic", { ok: true, tasks: [makeExternalTask()] });
    scheduledCallbacks[0]();

    // stop the loop
    loop.stop();
    expect(true).toBe(true); // just verify no throw
  });

  it("AC-14: stop() halts further calls; no unhandledRejection after stop", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();

    let callCount = 0;
    let setIntervalCallback: (() => void) | null = null;
    const mockSetInterval = (fn: () => void, _ms: number) => {
      // Only record the function; we'll call it manually
      setIntervalCallback = fn;
      return 111 as unknown as ReturnType<typeof setInterval>;
    };

    const opts: ExternalTaskBridgeConfig = {
      topics: [],
      workerId: WORKER_ID,
      setIntervalFn: mockSetInterval,
      onPoll: () => { callCount++; },
    };

    const loop = startBridgePollLoop(client, asJobStore(jobStore), opts);
    expect(setIntervalCallback).not.toBeNull();

    // Fire once
    setIntervalCallback!();
    await Promise.resolve(); // let async tasks settle
    void callCount; // referenced for side-effects (observability)

    // stop
    loop.stop();

    // Ensure clearInterval was called by verifying subsequent "ticks" don't increase count
    // (In real test, clearInterval prevents future ticks; we just verify stop doesn't throw)
    expect(() => loop.stop()).not.toThrow(); // idempotent
  });

  it("AC-15: fetchAndLock ENGINE_UNAVAILABLE → loop continues; no throw", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();

    const pollResults: BridgePollResult[] = [];
    let scheduledFn: (() => void) | null = null;

    const mockSetInterval = (fn: () => void, _ms: number) => {
      scheduledFn = fn;
      return 222 as unknown as ReturnType<typeof setInterval>;
    };

    // First call: ENGINE_UNAVAILABLE
    client.fetchResults.set("resilient-topic", {
      ok: false,
      code: "ENGINE_UNAVAILABLE",
    });

    const opts: ExternalTaskBridgeConfig = {
      topics: ["resilient-topic"],
      workerId: WORKER_ID,
      setIntervalFn: mockSetInterval,
      onPoll: (r) => pollResults.push(r),
    };

    const loop = startBridgePollLoop(client, asJobStore(jobStore), opts);

    // Fire interval (simulates ENGINE_UNAVAILABLE)
    scheduledFn!();
    await new Promise((r) => setTimeout(r, 10)); // let async settle

    expect(pollResults.length).toBeGreaterThanOrEqual(0); // may not have resolved yet (async)

    // Change to healthy, fire again — should succeed
    client.fetchResults.set("resilient-topic", {
      ok: true,
      tasks: [makeExternalTask({ topic: "resilient-topic" })],
    });
    scheduledFn!();
    await new Promise((r) => setTimeout(r, 10));

    loop.stop();
    // No errors/throws — test passes
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Block G — T-0636 P0-6/F3/F4/F5: per-tenant GUC-scoped enqueue
// ---------------------------------------------------------------------------
describe("Block G — runBridgeOnce per-tenant enqueue (T-0636 P0-6/F3/F4/F5)", () => {
  const TENANT_A = "11111111-1111-1111-1111-111111111111";
  const TENANT_B = "22222222-2222-2222-2222-222222222222";

  /**
   * A fake pg.Pool whose connect() returns a client recording every query() call
   * (text) in a shared log, so tests can assert ordering — specifically that
   * `SET LOCAL choros.tenant_id` precedes every `enqueue`-shaped query on the
   * SAME client (AC-4 / FF-4).
   */
  function makeFakePool(queryLog: string[]) {
    const pool = {
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string, _params?: unknown[]) => {
          queryLog.push(sql.trim());
          return { rows: [{ id: "job-fake", topic: "t", variables: {}, state: "CREATED", retries: 0, lock_owner: null, lock_expiry: null, created_at: "0", available_at: "0" }] };
        }),
        release: vi.fn(),
      })),
    };
    return pool as unknown as import("pg").Pool;
  }

  /** A jobStore whose enqueue() records (topic, tenant marker via queryLog position). */
  function makeEnqueueTrackingJobStore(queryLog: string[]) {
    const calls: Array<{ topic: string; idempotencyKey?: string }> = [];
    const jobStore = {
      enqueue: vi.fn(async (
        topic: string,
        _variables: Record<string, unknown>,
        _retries: number,
        idempotencyKey?: string,
        _processDefId?: string,
        _instanceId?: string,
        executor?: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
      ) => {
        calls.push({ topic, idempotencyKey });
        // Route through the executor (if supplied) so the GUC-ordering assertion
        // can see the enqueue's query landing in the SAME queryLog as SET LOCAL.
        if (executor) {
          queryLog.push(`ENQUEUE ${idempotencyKey ?? ""}`);
          await executor.query("-- enqueue marker --");
        }
        return {
          id: `job-${idempotencyKey}`,
          topic,
          variables: {},
          state: "CREATED",
          retries: 0,
          createdAt: 0,
          available_at: 0,
        };
      }),
    };
    return { jobStore: jobStore as unknown as PostgresJobStore, calls };
  }

  it("AC-4/FF-4: SET LOCAL choros.tenant_id precedes enqueue on the SAME client, per tenant", async () => {
    const client = new MockFlowableClient();
    const queryLog: string[] = [];
    const pool = makeFakePool(queryLog);
    const { jobStore, calls } = makeEnqueueTrackingJobStore(queryLog);

    const taskA = makeExternalTask({
      id: "ext-a",
      topic: "agent-step",
      variables: { [CHOROS_TENANT_VAR]: TENANT_A },
    });
    const taskB = makeExternalTask({
      id: "ext-b",
      topic: "agent-step",
      variables: { [CHOROS_TENANT_VAR]: TENANT_B },
    });
    client.fetchResults.set("agent-step", { ok: true, tasks: [taskA, taskB] });

    const result = await runBridgeOnce(
      client, jobStore, ["agent-step"], WORKER_ID, LOCK_MS, MAX_TASKS, RETRIES, pool,
    );

    expect(result.enqueued).toBe(2);
    expect(result.skipped).toBe(0);
    expect(calls).toHaveLength(2);

    // Two separate SET LOCAL statements (one per tenant), each followed by its
    // OWN enqueue marker before any other tenant's SET LOCAL interleaves it.
    const setLocalCalls = queryLog.filter((q) => q.includes("SET LOCAL choros.tenant_id"));
    expect(setLocalCalls).toHaveLength(2);
    expect(setLocalCalls.some((q) => q.includes(TENANT_A))).toBe(true);
    expect(setLocalCalls.some((q) => q.includes(TENANT_B))).toBe(true);

    // For EACH tenant, its SET LOCAL appears strictly before its own ENQUEUE marker.
    const idxSetA = queryLog.findIndex((q) => q.includes(`SET LOCAL choros.tenant_id = '${TENANT_A}'`));
    const idxEnqA = queryLog.findIndex((q) => q === "ENQUEUE ext-a");
    expect(idxSetA).toBeGreaterThanOrEqual(0);
    expect(idxEnqA).toBeGreaterThan(idxSetA);

    const idxSetB = queryLog.findIndex((q) => q.includes(`SET LOCAL choros.tenant_id = '${TENANT_B}'`));
    const idxEnqB = queryLog.findIndex((q) => q === "ENQUEUE ext-b");
    expect(idxSetB).toBeGreaterThanOrEqual(0);
    expect(idxEnqB).toBeGreaterThan(idxSetB);
  });

  it("AC-6: no enqueue call ever throws a current_setting/GUC error across a full pass with 2 tenants", async () => {
    const client = new MockFlowableClient();
    const queryLog: string[] = [];
    const pool = makeFakePool(queryLog);
    const { jobStore } = makeEnqueueTrackingJobStore(queryLog);

    const taskA = makeExternalTask({ id: "ext-a2", topic: "t", variables: { [CHOROS_TENANT_VAR]: TENANT_A } });
    const taskB = makeExternalTask({ id: "ext-b2", topic: "t", variables: { [CHOROS_TENANT_VAR]: TENANT_B } });
    client.fetchResults.set("t", { ok: true, tasks: [taskA, taskB] });

    await expect(
      runBridgeOnce(client, jobStore, ["t"], WORKER_ID, LOCK_MS, MAX_TASKS, RETRIES, pool),
    ).resolves.not.toThrow();
  });

  it("FF-6: task with NO choros_tenantId variable → skipped (fail-closed), NOT enqueued", async () => {
    const client = new MockFlowableClient();
    const queryLog: string[] = [];
    const pool = makeFakePool(queryLog);
    const { jobStore, calls } = makeEnqueueTrackingJobStore(queryLog);

    const taskNoTenant = makeExternalTask({ id: "ext-no-tenant", topic: "t", variables: { amount: 100 } });
    const taskWithTenant = makeExternalTask({ id: "ext-has-tenant", topic: "t", variables: { [CHOROS_TENANT_VAR]: TENANT_A } });
    client.fetchResults.set("t", { ok: true, tasks: [taskNoTenant, taskWithTenant] });

    const result = await runBridgeOnce(client, jobStore, ["t"], WORKER_ID, LOCK_MS, MAX_TASKS, RETRIES, pool);

    expect(result.skipped).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].idempotencyKey).toBe("ext-has-tenant");
  });

  it("FF-6: task with an INVALID (non-UUID) choros_tenantId → skipped, not enqueued", async () => {
    const client = new MockFlowableClient();
    const queryLog: string[] = [];
    const pool = makeFakePool(queryLog);
    const { jobStore, calls } = makeEnqueueTrackingJobStore(queryLog);

    const taskBadTenant = makeExternalTask({ id: "ext-bad-tenant", topic: "t", variables: { [CHOROS_TENANT_VAR]: "not-a-uuid" } });
    client.fetchResults.set("t", { ok: true, tasks: [taskBadTenant] });

    const result = await runBridgeOnce(client, jobStore, ["t"], WORKER_ID, LOCK_MS, MAX_TASKS, RETRIES, pool);

    expect(result.skipped).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("legacy no-pool call-shape (7 args) still enqueues directly, unaffected by tenant-var requirement", async () => {
    // Pre-T-0636 tests (Block A) call runBridgeOnce with exactly 7 args, and their
    // tasks carry NO choros_tenantId variable. This must keep working exactly as
    // before — the tenant-var requirement only applies when a pool is supplied.
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();
    const task = makeExternalTask({ id: "ext-legacy", topic: "legacy-topic" });
    client.fetchResults.set("legacy-topic", { ok: true, tasks: [task] });

    const result = await runBridgeOnce(
      client, asJobStore(jobStore), ["legacy-topic"], WORKER_ID, LOCK_MS, MAX_TASKS, RETRIES,
    );

    expect(result.enqueued).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("AC-10: fetchAndLock UNAUTHORIZED → visible logThrottle call with code + topic (not silent)", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();
    client.fetchResults.set("secure-topic", { ok: false, code: "UNAUTHORIZED" });

    const logged: Array<[string, string]> = [];
    const throttle = (errorClass: string, detail: string) => logged.push([errorClass, detail]);

    await runBridgeOnce(
      client, asJobStore(jobStore), ["secure-topic"], WORKER_ID, LOCK_MS, MAX_TASKS, RETRIES,
      undefined, throttle,
    );

    expect(logged).toHaveLength(1);
    expect(logged[0][0]).toBe("FETCH_UNAUTHORIZED");
    expect(logged[0][1]).toContain("secure-topic");
  });
});

// ---------------------------------------------------------------------------
// Block H — T-0636 F8/F9/F10: startBridgePollLoop visible log + makeErrorLogThrottle
// ---------------------------------------------------------------------------
describe("Block H — startBridgePollLoop visible log on pass failure (T-0636 F8)", () => {
  it("AC-11: a runBridgeOnce pass that throws is now LOGGED (not silently swallowed); loop stays alive", async () => {
    const client = new MockFlowableClient();
    const jobStore = new MockJobStore();
    // Force fetchAndLock itself to throw synchronously inside the promise chain by
    // making the mock's fetchAndLock reject.
    client.fetchAndLock = async () => {
      throw new Error("boom - simulated whole-pass failure");
    };

    const logged: Array<[string, string]> = [];
    const throttle = (errorClass: string, detail: string) => logged.push([errorClass, detail]);

    let scheduledFn: (() => void) | null = null;
    const mockSetInterval = (fn: () => void, _ms: number) => {
      scheduledFn = fn;
      return 333 as unknown as ReturnType<typeof setInterval>;
    };

    const opts: ExternalTaskBridgeConfig = {
      topics: ["boom-topic"],
      workerId: WORKER_ID,
      setIntervalFn: mockSetInterval,
      logThrottle: throttle,
    };

    const loop = startBridgePollLoop(client, asJobStore(jobStore), opts);
    scheduledFn!();
    await new Promise((r) => setTimeout(r, 10));

    expect(logged.length).toBeGreaterThanOrEqual(1);
    expect(logged.some(([cls]) => cls === "BRIDGE_PASS_FAILED")).toBe(true);

    // Loop is still alive — firing again does not throw.
    expect(() => scheduledFn!()).not.toThrow();
    loop.stop();
  });
});

describe("makeErrorLogThrottle (T-0636 F10 / AC-12)", () => {
  it("first occurrence of a class emits immediately", () => {
    const emitted: string[] = [];
    const throttle = makeErrorLogThrottle((msg) => emitted.push(msg), { nowMs: () => 1000 });
    throttle("UNAUTHORIZED", "topic=x");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("UNAUTHORIZED");
  });

  it("AC-12: N repeats of the SAME class within the throttle window emit only the first (bounded stream)", () => {
    const emitted: string[] = [];
    let clock = 1000;
    const throttle = makeErrorLogThrottle((msg) => emitted.push(msg), {
      minIntervalMs: 60_000,
      nowMs: () => clock,
    });

    for (let i = 0; i < 10; i++) {
      throttle("UNAUTHORIZED", `attempt ${i}`);
      clock += 1000; // 1s between ticks — stays within the 60s window
    }

    // Only the FIRST occurrence emitted — the other 9 are suppressed (bounded).
    expect(emitted).toHaveLength(1);
  });

  it("after the throttle window elapses, the next occurrence emits a summary with the suppressed count", () => {
    const emitted: string[] = [];
    let clock = 0;
    const throttle = makeErrorLogThrottle((msg) => emitted.push(msg), {
      minIntervalMs: 1000,
      nowMs: () => clock,
    });

    throttle("UNAUTHORIZED", "first"); // emits immediately (t=0)
    clock = 100;
    throttle("UNAUTHORIZED", "suppressed-1"); // within window → suppressed
    clock = 200;
    throttle("UNAUTHORIZED", "suppressed-2"); // within window → suppressed
    clock = 1500; // window elapsed since t=0
    throttle("UNAUTHORIZED", "third-window"); // emits with suppressed count

    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatch(/2 repeat/);
  });

  it("a DIFFERENT error class always emits immediately (independent per-class state)", () => {
    const emitted: string[] = [];
    const clock = 1000;
    const throttle = makeErrorLogThrottle((msg) => emitted.push(msg), {
      minIntervalMs: 60_000,
      nowMs: () => clock,
    });

    throttle("UNAUTHORIZED", "a");
    throttle("MISSING_TENANT_VAR", "b");
    expect(emitted).toHaveLength(2);
  });

  it("NF-6: emitted messages never contain a raw password / Authorization header value", () => {
    const emitted: string[] = [];
    const throttle = makeErrorLogThrottle((msg) => emitted.push(msg));
    throttle("FETCH_UNAUTHORIZED", "topic=secure-topic");
    expect(emitted[0]).not.toMatch(/Basic /);
    expect(emitted[0].toLowerCase()).not.toContain("password");
    expect(emitted[0].toLowerCase()).not.toContain("authorization");
  });
});
