/**
 * T-0460 [D8-R5] — FULL WELD, live-stub branches (FF-R5-4).
 *
 * Proves the SAME publish→dispatch weld as the dormant test, but with a stub LLM that
 * returns a valid high-confidence answer and a LIVE agent_card (llm_* configured) +
 * liveEnabled=true. NO live LLM, NO deploy, NO network — the stub is deterministic.
 *
 *  (1) PROCEED: confidence ≥ threshold → the motor self-closes the step:
 *        applyStepResult (attempted), ONE agent.proceeded audit, task_completed
 *        enqueued, job completed.
 *  (2) CRITICALITY DEFER (gate B): a critical-role agent step ALWAYS defers, BEFORE the
 *        LLM call — no spend — regardless of confidence (F3: an agent never executes a
 *        critical step itself).
 *
 * Both branches drive the real runAgentDispatchOnce loop (assemble → run → apply) with
 * the job variables the publish transform stamped.
 */

import { describe, it, expect } from "vitest";
import type pg from "pg";
import { mapAgentTaskToExternal } from "../../../core/agent-task-external-mapper.js";
import { runAgentDispatchOnce, type AgentDispatchDeps } from "../../../server/agent-dispatch-loop.js";
import type { Job } from "../../../core/types.js";
import { StubLlmPort } from "../../../core/__tests__/stub-llm-port.js";
import { InMemoryAuditWriter } from "../../../db/audit-writer.js";
import { stubBudgetPort } from "../agent-step-context.js";
import type { Grant, GrantScope } from "../../../core/grant-lattice.js";
import type { Operation, ResourceType } from "../../../core/grant-lattice.js";

const TENANT = "a0000000-0000-0000-0000-000000000001";
const AGENT_ID = "d0000000-0000-0000-0000-000000000006";
const ROLE_ID = "role-intake-agent";
const INSTANCE = "22222222-2222-2222-2222-222222222222";
const NOW = 1_700_000_000_000;

const NS =
  'xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:flowable="http://flowable.org/bpmn" ' +
  'xmlns:choros="http://choros.io/bpmn"';

function publishAgentTask(): string {
  const authored =
    `<definitions ${NS}><process id="telLinear">` +
    `<serviceTask id="task-triage" name="Триаж" choros:executorType="agent" ` +
    `choros:agentRef="${AGENT_ID}" choros:assignedRoleId="${ROLE_ID}" ` +
    `choros:agentReadsFields="amount"/>` +
    `</process></definitions>`;
  return mapAgentTaskToExternal(authored);
}

/** Build job variables from the stamped flowable:field entries + engine correlation. */
function jobVarsFromPublishedXml(xml: string): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  const re = /<flowable:field name="([^"]+)"><flowable:string>([^<]*)<\/flowable:string><\/flowable:field>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) vars[m[1]!] = m[2]!;
  vars["instanceId"] = INSTANCE;
  vars["procKey"] = "telLinear";
  vars["fields"] = { amount: 100 };
  vars["__tenantId"] = TENANT;
  return vars;
}

/** Live agent_card (llm_* non-null) → live port path; no_app_binding for record ref. */
function fakeLiveClient(): pg.PoolClient {
  return {
    __tenantId: TENANT,
    query: async (sql: string) => {
      if (sql.includes("audit_event") && sql.includes("payload->>'inst'")) {
        return { rows: [{ payload: { inst: INSTANCE, proc_key: "telLinear" } }] };
      }
      if (sql.includes("process_app_binding")) return { rows: [] }; // no_app_binding → skip
      if (sql.includes("agent_card")) {
        return {
          rows: [
            { llm_endpoint: "https://llm.test/v1", llm_model: "test-model", secret_handle_ref: "app://handle", autonomy_threshold: null },
          ],
        };
      }
      return { rows: [] };
    },
  } as unknown as pg.PoolClient;
}

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
  async complete(_w: string, jobId: string): Promise<{ ok: boolean }> { this.completed.push(jobId); return { ok: true }; }
  async fail(_w: string, jobId: string): Promise<{ ok: boolean }> { this.failed.push(jobId); return { ok: true }; }
}

/** A critical grant (operation=approve) → roleCriticality → "critical" (gate B). */
function criticalGrant(): Grant {
  const WHOLE_SCOPE: GrantScope = { kind: "set", members: [] };
  return {
    tenantId: TENANT,
    id: "g-critical",
    roleId: ROLE_ID,
    resourceType: "record" as ResourceType,
    operation: "approve" as Operation,
    scope: WHOLE_SCOPE,
    delegable: false,
    grantedBy: "owner",
    createdAt: 0,
  };
}

function buildDeps(args: {
  job: Job;
  client: pg.PoolClient;
  audit: InMemoryAuditWriter;
  outbox: FakeOutbox;
  jobStore: FakeJobStore;
  stub: StubLlmPort;
  roleGrants: Grant[];
}): AgentDispatchDeps {
  return {
    fetcher: { fetchAndLockAgentJobs: async () => [{ tenantId: TENANT, jobs: [args.job] }] },
    withTenantTx: async (_t, fn) => fn(args.client),
    assembleDeps: {
      grants: { getGrants: async () => [] },
      tools: { listTools: async () => [] },
      roleGrants: { getRoleGrants: async () => args.roleGrants },
      budget: stubBudgetPort,
      instruction: {
        readPublished: async () => ({ instructionText: "Триаж заявки", answerForm: "agent_step_v1" }),
      },
    },
    runDeps: { llm: args.stub, liveEnabled: true },
    applyDeps: { auditWriter: args.audit, outboxStore: args.outbox as never, jobStore: args.jobStore as never },
    workerId: "test-agent-dispatcher",
    topics: ["agent-step"],
    now: () => NOW,
  };
}

function makeJob(id: string): Job {
  return {
    id,
    topic: "agent-step",
    variables: jobVarsFromPublishedXml(publishAgentTask()),
    state: "LOCKED",
    retries: 0,
    createdAt: NOW,
    available_at: NOW,
  } as Job;
}

describe("T-0460 weld (live-stub) — PROCEED branch (FF-R5-4)", () => {
  it("high-confidence stub + live agent_card → self-close: agent.proceeded, task_completed, job complete", async () => {
    const audit = new InMemoryAuditWriter();
    const outbox = new FakeOutbox();
    const jobStore = new FakeJobStore();
    const stub = new StubLlmPort({ mode: "succeed", recordCalls: true }); // confidence 0.92

    const deps = buildDeps({
      job: makeJob("11111111-1111-1111-1111-111111111111"),
      client: fakeLiveClient(),
      audit,
      outbox,
      jobStore,
      stub,
      roleGrants: [], // routine → gate B does NOT fire → LLM runs
    });

    const summary = await runAgentDispatchOnce(deps);

    expect(summary.processed).toBe(1);
    expect(summary.proceeded).toBe(1);
    expect(summary.deferred).toBe(0);
    expect(summary.errored).toBe(0);

    // The LLM WAS called exactly once (live path).
    expect(stub.calls.length).toBe(1);

    // agent.proceeded audit (NOT deferred/blocked).
    const events = audit.rows(TENANT);
    expect(events.some((e) => e.type === "agent.proceeded")).toBe(true);
    expect(events.some((e) => e.type === "agent.deferred")).toBe(false);

    // The step closed: task_completed outbox + job complete.
    expect(outbox.rows.some((r) => r.eventType === "task_completed")).toBe(true);
    expect(jobStore.completed.length).toBe(1);
    expect(jobStore.failed.length).toBe(0);
  });
});

describe("T-0460 weld (live-stub) — CRITICALITY DEFER branch (gate B, FF-R5-4)", () => {
  it("critical role → ALWAYS defers BEFORE the LLM call (zero spend), regardless of confidence", async () => {
    const audit = new InMemoryAuditWriter();
    const outbox = new FakeOutbox();
    const jobStore = new FakeJobStore();
    const stub = new StubLlmPort({ mode: "succeed", recordCalls: true }); // would be 0.92 if called

    const deps = buildDeps({
      job: makeJob("22222222-2222-2222-2222-222222222223"),
      client: fakeLiveClient(), // live llm_* configured
      audit,
      outbox,
      jobStore,
      stub,
      roleGrants: [criticalGrant()], // critical → gate B fires first
    });

    const summary = await runAgentDispatchOnce(deps);

    expect(summary.processed).toBe(1);
    expect(summary.deferred).toBe(1);
    expect(summary.proceeded).toBe(0);

    // Gate B short-circuits: the LLM was NEVER called (no spend) even though live+configured.
    expect(stub.calls.length).toBe(0);

    // agent.deferred (signal=threshold for the criticality ceiling), step closed.
    const events = audit.rows(TENANT);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("agent.deferred");
    expect((events[0].payload as Record<string, unknown>)["signal"]).toBe("threshold");
    expect(jobStore.completed.length).toBe(1);
  });
});
