/**
 * Unit tests for T-0378 [D4] assembleAgentStepContext + runAgentDispatchOnce.
 *
 * Covers (test plan §6, static-now):
 *  - assembleAgentStepContext: objective / recordRef / tools / llm / autonomy /
 *    criticality assembled from a job row + injected ports; 0-grants → empty toolset.
 *  - runAgentDispatchOnce: one dormant agent-topic job → defer-to-human outcome,
 *    the job is consumed (jobStore.complete called), audit + outbox written —
 *    the keystone happy-path WITHOUT a network (dormant motor yields defer + step closes).
 *  - Dispatch loop lifecycle: injectable setIntervalFn → start → one pass → stop.
 */

import { describe, it, expect, vi } from "vitest";
import type pg from "pg";
import { assembleAgentStepContext, stubBudgetPort, type AssembleDeps, type InstructionSource, type PublishedInstructionResult } from "../agent-step-context.js";
import {
  runAgentDispatchOnce,
  startAgentDispatchLoop,
  DEFAULT_AGENT_TOPIC,
  type AgentDispatchDeps,
  type AgentJobFetcher,
  type TenantJobBatch,
} from "../../../server/agent-dispatch-loop.js";
import { type Job, JobState } from "../../../core/types.js";
import { dormantLlmPort } from "../../../core/llm-port.js";
import { InMemoryAuditWriter } from "../../../db/audit-writer.js";
import type { GrantSource } from "../../../core/grant-resolver.js";
import type { Grant } from "../../../core/grant-lattice.js";
import type { McpToolSource, McpToolRow } from "../../../core/mcp-tool-registry.js";
import type { RoleGrantSource } from "../../../core/role-criticality.js";
import type { DispatchJobStore } from "../dispatch-outcome.js";
import type { OutboxEnqueuePort } from "../../../db/step-applier.js";

const TENANT = "a0000000-0000-0000-0000-000000000001";
const AGENT = "d0000000-0000-0000-0000-000000000006";
const ROLE = "e0000000-0000-0000-0000-000000000005";
const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** GrantSource returning a fixed grant set for the agent. */
function fakeGrantSource(grants: Grant[]): GrantSource {
  return { async getGrants(): Promise<Grant[]> { return grants; } };
}

/** RoleGrantSource returning a fixed grant set for the role (criticality). */
function fakeRoleGrantSource(grants: Grant[]): RoleGrantSource {
  return { async getRoleGrants(): Promise<Grant[]> { return grants; } };
}

/** McpToolSource returning a fixed tool set. */
function fakeToolSource(tools: McpToolRow[]): McpToolSource {
  return { async listTools(): Promise<McpToolRow[]> { return tools; } };
}

/**
 * Stub InstructionSource (the DI port that replaces the direct readPublished import).
 * Returns a canned published instruction when hasInstruction=true (default), null otherwise.
 */
function fakeInstructionSource(opts: { hasInstruction?: boolean } = {}): InstructionSource {
  const hasInstruction = opts.hasInstruction ?? true;
  return {
    async readPublished(_tx, _employeeId): Promise<PublishedInstructionResult | null> {
      if (!hasInstruction) return null;
      return {
        instructionText: "Триаж",
        answerForm: "agent_step_v1",
      };
    },
  };
}

/**
 * Fake pg client for context assembly. Handles:
 *  - agent_card → one dormant row.
 *  - process.started (resolver step 1) → present, then no binding → no_app_binding.
 *
 * Note: agent_instruction is no longer queried via the pg client — it goes through
 * the InstructionSource DI port (fakeInstructionSource). The SQL branch is removed.
 */
function fakeContextClient(opts: { hasCard?: boolean } = {}): pg.PoolClient {
  const hasCard = opts.hasCard ?? true;
  return {
    __tenantId: TENANT,
    query: async (sql: string) => {
      if (sql.includes("FROM choros.agent_card")) {
        // The custody DAO (readAgentCardLlmConfigById) aliases the handle column
        // to the neutral `secret_handle_ref` — mirror that shape here (the raw
        // column name lives ONLY in the allow-listed DAO, FF-25-3).
        return hasCard
          ? { rows: [{ llm_endpoint: null, llm_model: null, secret_handle_ref: null, autonomy_threshold: null }] }
          : { rows: [] };
      }
      if (sql.includes("audit_event") && sql.includes("payload->>'inst'")) {
        return { rows: [{ payload: { inst: "inst-1", proc_key: "telLinear" } }] };
      }
      if (sql.includes("process_app_binding")) {
        return { rows: [] }; // no_app_binding → recordRef.resolved=false
      }
      return { rows: [] };
    },
  } as unknown as pg.PoolClient;
}

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    topic: DEFAULT_AGENT_TOPIC,
    variables: {
      __tenantId: TENANT,
      instanceId: "inst-1",
      procKey: "telLinear",
      agentEmployeeId: AGENT,
      roleId: ROLE,
      externalTaskId: "ext-1",
      fields: { amount: 100 },
    },
    state: JobState.LOCKED,
    retries: 0,
    lockOwner: "agent-dispatcher",
    lockExpiry: NOW + 30_000,
    createdAt: NOW,
    available_at: NOW,
    ...over,
  };
}

const assembleDeps = (over: Partial<AssembleDeps> = {}): AssembleDeps => ({
  grants: fakeGrantSource([]),
  tools: fakeToolSource([]),
  roleGrants: fakeRoleGrantSource([]),
  budget: stubBudgetPort,
  instruction: fakeInstructionSource(),
  ...over,
});

// ---------------------------------------------------------------------------
// assembleAgentStepContext
// ---------------------------------------------------------------------------

describe("assembleAgentStepContext", () => {
  it("assembles objective / recordRef / llm / autonomy / criticality from a job row", async () => {
    const client = fakeContextClient();
    const ctx = await assembleAgentStepContext(client, makeJob(), assembleDeps(), NOW);

    expect(ctx.tenantId).toBe(TENANT);
    expect(ctx.jobId).toBe("job-1");
    expect(ctx.agentEmployeeId).toBe(AGENT);
    expect(ctx.roleId).toBe(ROLE);
    expect(ctx.procKey).toBe("telLinear");
    expect(ctx.objective.hasInstruction).toBe(true);
    expect(ctx.objective.instruction).toBe("Триаж");
    expect(ctx.objective.answerForm).toBe("agent_step_v1");
    // No app binding → recordRef unresolved (honest).
    expect(ctx.recordRef.resolved).toBe(false);
    // Dormant card → llm nulls + null autonomy.
    expect(ctx.llm).toEqual({ endpoint: null, model: null, secretHandle: null });
    expect(ctx.autonomyThreshold).toBeNull();
    // No role grants → routine criticality (gate B does not force defer).
    expect(ctx.criticalityLevel).toBe("routine");
    // Stub budget.
    expect(ctx.budget.exhausted).toBe(false);
  });

  it("0 grants → empty toolset (AC: resolveAgentToolset 0 roles → 0 tools)", async () => {
    const tools: McpToolRow[] = [
      { tenantId: TENANT, id: "t1", name: "tool-1", description: null, declares: [], pureCompute: true, resourceOps: [], createdAt: 0, updatedAt: 0 },
    ];
    const client = fakeContextClient();
    const ctx = await assembleAgentStepContext(
      client,
      makeJob(),
      assembleDeps({ grants: fakeGrantSource([]), tools: fakeToolSource(tools) }),
      NOW,
    );
    // Zero grants → isToolReachable false for every tool → empty toolset.
    expect(ctx.tools.length).toBe(0);
  });

  it("missing published instruction → hasInstruction=false", async () => {
    const client = fakeContextClient();
    const ctx = await assembleAgentStepContext(
      client,
      makeJob(),
      assembleDeps({ instruction: fakeInstructionSource({ hasInstruction: false }) }),
      NOW,
    );
    expect(ctx.objective.hasInstruction).toBe(false);
    expect(ctx.objective.instruction).toBe("");
  });

  it("throws when the job carries no __tenantId (loop must thread it)", async () => {
    const client = fakeContextClient();
    const job = makeJob({ variables: { instanceId: "inst-1", agentEmployeeId: AGENT } });
    await expect(assembleAgentStepContext(client, job, assembleDeps(), NOW)).rejects.toThrow(/__tenantId/);
  });
});

// ---------------------------------------------------------------------------
// T-0677 — readJobVars() sources instanceId/procKey from job.instanceId /
// job.processDefId (migration 111, T-0534), NOT solely from job.variables.
//
// RED before the fix: readJobVars() read ONLY from `variables`, and the live
// agent-dispatch fetchers (pgJobStore.fetchAndLock / agent-dispatch-loop.ts's
// PostgresAgentJobFetcher) never populated `variables.instanceId` — that key
// comes from Flowable engine metadata (ExternalTask.processInstanceId), not a
// BPMN business variable. A job shaped like the ACTUAL live-proof T-0638
// repro (instanceId/processDefId on the Job object, NOT in variables) produced
// ctx.instanceId === "" pre-fix. This is the exact defect the PR fixes.
// ---------------------------------------------------------------------------
describe("assembleAgentStepContext — T-0677 job.instanceId/processDefId threading", () => {
  /** A job shaped like a REAL fetchAndLock/rowToJob result: no instanceId/procKey
   * inside `variables` at all (only what the bridge/business step actually sets),
   * but WITH the top-level instanceId/processDefId columns (migration 111). */
  function makeLiveShapedJob(over: Partial<Job> = {}): Job {
    return {
      id: "job-live-1",
      topic: DEFAULT_AGENT_TOPIC,
      variables: {
        __tenantId: TENANT,
        // NOTE: deliberately NO instanceId/procKey key here — mirrors the real
        // enqueue path (externalTaskBridge.ts passes Flowable engine metadata
        // as enqueue()'s positional processDefId/instanceId args, not as a
        // variables entry).
        agentEmployeeId: AGENT,
        roleId: ROLE,
        externalTaskId: "ext-live-1",
        fields: { amount: 100 },
      },
      state: JobState.LOCKED,
      retries: 0,
      lockOwner: "agent-dispatcher",
      lockExpiry: NOW + 30_000,
      createdAt: NOW,
      available_at: NOW,
      ...over,
    };
  }

  it("uses job.instanceId/job.processDefId when variables carries no instanceId (mutation-red pre-fix)", async () => {
    const client = fakeContextClient();
    const job = makeLiveShapedJob({
      instanceId: "99573238",
      processDefId: "telLinear",
    });
    const ctx = await assembleAgentStepContext(client, job, assembleDeps(), NOW);

    // Pre-fix, this was "" (readJobVars only looked at job.variables, which has
    // no instanceId key on this fixture) — the exact defect diagnosed by T-0638
    // live-proof (repro instance 99573238).
    expect(ctx.instanceId).toBe("99573238");
    expect(ctx.procKey).toBe("telLinear");
  });

  it("falls back to job.variables when job.instanceId/processDefId are absent (legacy job, backward-compat)", async () => {
    const client = fakeContextClient();
    // No top-level instanceId/processDefId (pre-migration-111 job, or a job whose
    // enqueue path never captured process scope) — variables carries the legacy
    // convention keys instead. Must not crash; must resolve from variables.
    const job = makeLiveShapedJob({
      variables: {
        __tenantId: TENANT,
        instanceId: "legacy-inst-1",
        procKey: "legacyProc",
        agentEmployeeId: AGENT,
        roleId: ROLE,
        externalTaskId: "ext-legacy-1",
        fields: {},
      },
      instanceId: undefined,
      processDefId: undefined,
    });
    const ctx = await assembleAgentStepContext(client, job, assembleDeps(), NOW);

    expect(ctx.instanceId).toBe("legacy-inst-1");
    expect(ctx.procKey).toBe("legacyProc");
  });

  it("job.instanceId=null (explicit DB NULL, migration 111 nullable column) does not crash — falls back cleanly", async () => {
    const client = fakeContextClient();
    const job = makeLiveShapedJob({
      variables: {
        __tenantId: TENANT,
        agentEmployeeId: AGENT,
        roleId: ROLE,
        externalTaskId: "ext-null-1",
        fields: {},
      },
      instanceId: null,
      processDefId: null,
    });
    const ctx = await assembleAgentStepContext(client, job, assembleDeps(), NOW);

    // No instanceId anywhere (neither column nor variables) → "" is the honest,
    // safe-degrade value (steers the motor toward defer, per readJobVars' doc).
    expect(ctx.instanceId).toBe("");
    expect(ctx.procKey).toBe("");
  });

  it("job.instanceId (real column) wins over a conflicting legacy variables.instanceId", async () => {
    const client = fakeContextClient();
    const job = makeLiveShapedJob({
      variables: {
        __tenantId: TENANT,
        instanceId: "stale-legacy-value",
        agentEmployeeId: AGENT,
        roleId: ROLE,
        externalTaskId: "ext-2",
        fields: {},
      },
      instanceId: "authoritative-999",
      processDefId: "telLinear",
    });
    const ctx = await assembleAgentStepContext(client, job, assembleDeps(), NOW);

    expect(ctx.instanceId).toBe("authoritative-999");
  });
});

// ---------------------------------------------------------------------------
// runAgentDispatchOnce — the keystone happy-path (dormant → defer → step closes)
// ---------------------------------------------------------------------------

class FakeOutbox implements OutboxEnqueuePort {
  readonly rows: Array<{ eventType: string; idempotencyKey: string }> = [];
  private readonly keys = new Set<string>();
  async enqueueInTx(_c: pg.PoolClient, row: { aggregateKind: string; aggregateId: string; eventType: string; payload: Record<string, unknown>; idempotencyKey: string }): Promise<unknown> {
    if (this.keys.has(row.idempotencyKey)) return undefined;
    this.keys.add(row.idempotencyKey);
    this.rows.push({ eventType: row.eventType, idempotencyKey: row.idempotencyKey });
    return row;
  }
}

class FakeJobStore implements DispatchJobStore {
  readonly completed: string[] = [];
  readonly failed: string[] = [];
  async complete(_w: string, jobId: string): Promise<{ ok: boolean }> { this.completed.push(jobId); return { ok: true }; }
  async fail(_w: string, jobId: string): Promise<{ ok: boolean }> { this.failed.push(jobId); return { ok: true }; }
}

/** Fetcher that yields one batch with one dormant agent job, once. */
function singleBatchFetcher(jobs: Job[]): { fetcher: AgentJobFetcher; passes: () => number } {
  let calls = 0;
  const fetcher: AgentJobFetcher = {
    async fetchAndLockAgentJobs(): Promise<readonly TenantJobBatch[]> {
      calls += 1;
      if (calls > 1) return []; // only the first pass yields work
      return [{ tenantId: TENANT, jobs }];
    },
  };
  return { fetcher, passes: () => calls };
}

function loopDeps(fetcher: AgentJobFetcher, audit: InMemoryAuditWriter, outbox: FakeOutbox, jobStore: FakeJobStore): AgentDispatchDeps {
  return {
    fetcher,
    // withTenantTx supplies the fake context client (the same client the assembler
    // reads from); applyAgentOutcome appends via the InMemoryAuditWriter using a
    // tx carrying __tenantId.
    withTenantTx: async <T,>(_tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
      return fn(fakeContextClient());
    },
    assembleDeps: assembleDeps(),
    runDeps: { llm: dormantLlmPort, liveEnabled: false },
    applyDeps: { auditWriter: audit, outboxStore: outbox, jobStore },
    workerId: "agent-dispatcher",
    topics: [DEFAULT_AGENT_TOPIC],
    now: () => NOW,
  };
}

describe("runAgentDispatchOnce — dormant keystone (job → context → motor → defer → close)", () => {
  it("consumes one dormant agent job → defer-to-human, step closes, audit + outbox written", async () => {
    const audit = new InMemoryAuditWriter();
    const outbox = new FakeOutbox();
    const jobStore = new FakeJobStore();
    const { fetcher } = singleBatchFetcher([makeJob()]);

    const summary = await runAgentDispatchOnce(loopDeps(fetcher, audit, outbox, jobStore));

    expect(summary.processed).toBe(1);
    expect(summary.deferred).toBe(1);
    expect(summary.errored).toBe(0);

    // Defer materialized as an inbox task (agent.deferred audit) AND the step closed.
    const events = audit.rows(TENANT);
    expect(events.some((e) => e.type === "agent.deferred")).toBe(true);
    expect(outbox.rows.some((r) => r.eventType === "task_completed")).toBe(true);
    expect(jobStore.completed).toEqual(["job-1"]);
    expect(jobStore.failed.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// startAgentDispatchLoop — lifecycle
// ---------------------------------------------------------------------------

describe("startAgentDispatchLoop — lifecycle", () => {
  it("no topics → degraded no-op handle (no loop)", () => {
    const audit = new InMemoryAuditWriter();
    const outbox = new FakeOutbox();
    const jobStore = new FakeJobStore();
    const { fetcher } = singleBatchFetcher([]);
    const deps = { ...loopDeps(fetcher, audit, outbox, jobStore), topics: [] as string[] };
    const setIntervalFn = vi.fn();
    const handle = startAgentDispatchLoop(deps, { setIntervalFn });
    expect(setIntervalFn).not.toHaveBeenCalled();
    handle.stop(); // idempotent no-op
    handle.stop();
  });

  it("with topics → schedules via injected setIntervalFn; stop() clears it", () => {
    const audit = new InMemoryAuditWriter();
    const outbox = new FakeOutbox();
    const jobStore = new FakeJobStore();
    const { fetcher } = singleBatchFetcher([makeJob()]);
    let registered: (() => void) | undefined;
    const fakeTimer = 123 as unknown as ReturnType<typeof setInterval>;
    const setIntervalFn = vi.fn((fn: () => void) => { registered = fn; return fakeTimer; });
    const clearSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});

    const handle = startAgentDispatchLoop(loopDeps(fetcher, audit, outbox, jobStore), { setIntervalFn });
    expect(setIntervalFn).toHaveBeenCalledOnce();
    expect(registered).toBeTypeOf("function");

    handle.stop();
    expect(clearSpy).toHaveBeenCalledWith(fakeTimer);
    clearSpy.mockRestore();
  });
});
