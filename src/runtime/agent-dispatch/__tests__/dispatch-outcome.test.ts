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
    objective: { fields: { amount: 100 }, instruction: "Триаж", answerForm: "agent_step_v1", hasInstruction: true },
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
