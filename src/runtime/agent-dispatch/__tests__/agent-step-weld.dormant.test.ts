/**
 * T-0460 [D8-R5] — FULL WELD, dormant branch (FF-R5-3).
 *
 * Proves the WHOLE chain end-to-end at unit level (no live LLM, no deploy):
 *
 *   author an agentTask serviceTask
 *     → mapAgentTaskToExternal (publish transform) stamps the agent-step external shape
 *       + the dispatcher variables (agentEmployeeId/roleId/stepName/fields)
 *     → the variables the bridge WOULD enqueue become a synthetic agent-step job
 *     → runAgentDispatchOnce: assembleAgentStepContext → runAgentStep → applyAgentOutcome
 *     → with liveEnabled=false (dormantLlmPort) the motor DEFERS to a human:
 *          ONE agent.deferred audit event (signal=dormant), task_completed enqueued,
 *          job completed, ZERO LLM call (zero spend).
 *
 * This is the honest dormant default: an authored agentTask runs the real dispatcher
 * and escalates to a human inbox without an LLM key, no crash, no spend. Going live is
 * a config flip (liveEnabled=true + BYO llm_*), no code change.
 *
 * The job's variables are derived from the REAL published XML (we read back the stamped
 * flowable:field entries) so the weld proves the publish transform produced exactly the
 * keys assembleAgentStepContext consumes — not a hand-tuned fixture.
 */

import { describe, it, expect } from "vitest";
import type pg from "pg";
import { mapAgentTaskToExternal } from "../../../core/agent-task-external-mapper.js";
import { runAgentDispatchOnce, type AgentDispatchDeps } from "../../../server/agent-dispatch-loop.js";
import type { Job } from "../../../core/types.js";
import { StubLlmPort } from "../../../core/__tests__/stub-llm-port.js";
import { InMemoryAuditWriter } from "../../../db/audit-writer.js";
import { stubBudgetPort } from "../agent-step-context.js";

const TENANT = "a0000000-0000-0000-0000-000000000001";
const AGENT_ID = "d0000000-0000-0000-0000-000000000006";
const ROLE_ID = "role-intake-agent";
const INSTANCE = "22222222-2222-2222-2222-222222222222";
const NOW = 1_700_000_000_000;

const NS =
  'xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:flowable="http://flowable.org/bpmn" ' +
  'xmlns:choros="http://choros.io/bpmn"';

/** Author + publish an agentTask; return the stamped XML. */
function publishAgentTask(): string {
  const authored =
    `<definitions ${NS}><process id="telLinear">` +
    `<serviceTask id="task-triage" name="Триаж" choros:executorType="agent" ` +
    `choros:agentRef="${AGENT_ID}" choros:assignedRoleId="${ROLE_ID}" ` +
    `choros:agentReadsFields="amount"/>` +
    `</process></definitions>`;
  return mapAgentTaskToExternal(authored);
}

/**
 * Read the stamped flowable:field entries back out of the published XML and build the
 * job variables the bridge would enqueue (externalTaskBridge: jobStore.enqueue(topic,
 * task.variables, …)). This proves the publish transform produced exactly the keys the
 * dispatcher reads. instanceId/procKey/fields are threaded by the engine at fetchAndLock
 * (the live process variables / form snapshot), so we add them here as the bridge would.
 */
function jobVarsFromPublishedXml(xml: string): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  const re = /<flowable:field name="([^"]+)"><flowable:string>([^<]*)<\/flowable:string><\/flowable:field>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    vars[m[1]!] = m[2]!;
  }
  // Engine-threaded correlation (live process vars at fetchAndLock) + tenant (bridge).
  vars["instanceId"] = INSTANCE;
  vars["procKey"] = "telLinear";
  vars["fields"] = { amount: 100 };
  vars["__tenantId"] = TENANT;
  return vars;
}

/**
 * Fake pg client: resolveInstanceTargetOnClient → no_app_binding (no registry write),
 * readAgentCardLlmConfigById → DORMANT (all llm_* NULL). Carries __tenantId so the
 * InMemoryAuditWriter serialises a chain. Mirrors dispatch-outcome.test.ts's fake.
 */
function fakeDormantClient(): pg.PoolClient {
  return {
    __tenantId: TENANT,
    query: async (sql: string) => {
      if (sql.includes("audit_event") && sql.includes("payload->>'inst'")) {
        return { rows: [{ payload: { inst: INSTANCE, proc_key: "telLinear" } }] };
      }
      if (sql.includes("process_app_binding")) {
        return { rows: [] }; // no_app_binding → applyStepResult skips
      }
      if (sql.includes("agent_card")) {
        // DORMANT agent_card — llm_* NULL → dormant motor.
        return { rows: [{ llm_endpoint: null, llm_model: null, secret_handle_ref: null, autonomy_threshold: null }] };
      }
      return { rows: [] };
    },
  } as unknown as pg.PoolClient;
}

/** Recording outbox + jobStore (mirror dispatch-outcome.test.ts fakes). */
class FakeOutbox {
  readonly rows: Array<{ eventType: string; idempotencyKey: string }> = [];
  private readonly keys = new Set<string>();
  async enqueueInTx(_c: pg.PoolClient, row: { eventType: string; idempotencyKey: string }): Promise<unknown> {
    if (this.keys.has(row.idempotencyKey)) return undefined;
    this.keys.add(row.idempotencyKey);
    this.rows.push(row);
    return row;
  }
}
class FakeJobStore {
  readonly completed: string[] = [];
  readonly failed: string[] = [];
  async complete(_w: string, jobId: string): Promise<{ ok: boolean }> {
    this.completed.push(jobId);
    return { ok: true };
  }
  async fail(_w: string, jobId: string): Promise<{ ok: boolean }> {
    this.failed.push(jobId);
    return { ok: true };
  }
}

function buildWeldDeps(args: {
  job: Job;
  client: pg.PoolClient;
  audit: InMemoryAuditWriter;
  outbox: FakeOutbox;
  jobStore: FakeJobStore;
  llm: AgentDispatchDeps["runDeps"]["llm"];
  liveEnabled: boolean;
  hasInstruction: boolean;
}): AgentDispatchDeps {
  return {
    fetcher: {
      fetchAndLockAgentJobs: async () => [{ tenantId: TENANT, jobs: [args.job] }],
    },
    // Use the injected fake client (NOT a real tx) so the assemble step's direct
    // client.query reads hit our fake. The loop wraps the body in this fn.
    withTenantTx: async (_tenantId, fn) => fn(args.client),
    assembleDeps: {
      grants: { getGrants: async () => [] },
      tools: { listTools: async () => [] },
      roleGrants: { getRoleGrants: async () => [] }, // empty → criticality "routine"
      budget: stubBudgetPort,
      instruction: {
        readPublished: async () =>
          args.hasInstruction
            ? { instructionText: "Триаж заявки — проверь сумму", answerForm: "agent_step_v1" }
            : null,
      },
    },
    runDeps: { llm: args.llm, liveEnabled: args.liveEnabled },
    applyDeps: {
      auditWriter: args.audit,
      outboxStore: args.outbox as never,
      jobStore: args.jobStore as never,
    },
    workerId: "test-agent-dispatcher",
    topics: ["agent-step"],
    now: () => NOW,
  };
}

describe("T-0460 weld (dormant) — authored agentTask → dispatch → defer-to-human (FF-R5-3)", () => {
  it("dormant LLM: ONE agent.deferred (signal=dormant), task_completed, job complete, ZERO spend", async () => {
    const xml = publishAgentTask();
    // Sanity: the publish transform stamped the dispatcher variables.
    const vars = jobVarsFromPublishedXml(xml);
    expect(vars["agentEmployeeId"]).toBe(AGENT_ID);
    expect(vars["roleId"]).toBe(ROLE_ID);
    expect(vars["stepName"]).toBe("Триаж");

    const job: Job = {
      id: "11111111-1111-1111-1111-111111111111",
      topic: "agent-step",
      variables: vars,
      state: "LOCKED",
      retries: 0,
      createdAt: NOW,
      available_at: NOW,
    } as Job;

    const audit = new InMemoryAuditWriter();
    const outbox = new FakeOutbox();
    const jobStore = new FakeJobStore();
    // A stub that WOULD succeed — but liveEnabled=false forces dormantLlmPort, so it is
    // NEVER called. recordCalls proves zero spend.
    const stub = new StubLlmPort({ mode: "succeed", recordCalls: true });

    const deps = buildWeldDeps({
      job,
      client: fakeDormantClient(),
      audit,
      outbox,
      jobStore,
      llm: stub,
      liveEnabled: false,
      hasInstruction: true,
    });

    const summary = await runAgentDispatchOnce(deps);

    // The whole weld ran and DEFERRED.
    expect(summary.processed).toBe(1);
    expect(summary.deferred).toBe(1);
    expect(summary.proceeded).toBe(0);
    expect(summary.errored).toBe(0);

    // ZERO LLM spend (dormant port forced — stub never called).
    expect(stub.calls.length).toBe(0);

    // ONE agent.deferred audit event with signal=dormant.
    const events = audit.rows(TENANT);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("agent.deferred");
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload["signal"]).toBe("dormant");
    // Self-referential inbox task (D-061: the event IS the inbox task).
    expect(payload["inbox_task_id"]).toBe(events[0].id);
    // Dormant → no LLM answer → agent_draft null (prefill absent, honest).
    expect(payload["agent_draft"]).toBeNull();

    // The agent step closed through the engine (task_completed outbox + job complete).
    expect(outbox.rows.some((r) => r.eventType === "task_completed")).toBe(true);
    expect(jobStore.completed).toEqual([job.id]);
    expect(jobStore.failed.length).toBe(0);
  });

  it("liveEnabled=true but llm_* unconfigured (dormant agent_card) → still defers, zero spend", async () => {
    // The three-lock dormancy: even with liveEnabled=true, NULL llm_* → dormant port.
    const vars = jobVarsFromPublishedXml(publishAgentTask());
    const job: Job = {
      id: "33333333-3333-3333-3333-333333333333",
      topic: "agent-step",
      variables: vars,
      state: "LOCKED",
      retries: 0,
      createdAt: NOW,
      available_at: NOW,
    } as Job;

    const audit = new InMemoryAuditWriter();
    const outbox = new FakeOutbox();
    const jobStore = new FakeJobStore();
    const stub = new StubLlmPort({ mode: "succeed", recordCalls: true });

    const deps = buildWeldDeps({
      job,
      client: fakeDormantClient(), // agent_card llm_* NULL
      audit,
      outbox,
      jobStore,
      llm: stub,
      liveEnabled: true, // live flag ON, but config dormant
      hasInstruction: true,
    });

    const summary = await runAgentDispatchOnce(deps);
    expect(summary.deferred).toBe(1);
    expect(stub.calls.length).toBe(0); // zero spend — llm_* NULL → dormant port
    const events = audit.rows(TENANT);
    expect((events[0].payload as Record<string, unknown>)["signal"]).toBe("dormant");
  });
});
