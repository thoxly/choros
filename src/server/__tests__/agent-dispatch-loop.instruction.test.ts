/**
 * src/server/__tests__/agent-dispatch-loop.instruction.test.ts — T-0637 AC-5
 * (motor regression, ZERO changes to the motor itself).
 *
 * Proves the ADR's central claim end-to-end at unit level, using the REAL
 * competence-instruction DAO chain (agent-instruction-store.ts::saveDraft /
 * readPublished — the SAME `storeInstructionSource` object wired into
 * production at src/server/agent-dispatch-loop.ts:60), NOT a stub:
 *
 *   BEFORE any draft is published for an agent's employee_id:
 *     runAgentDispatchOnce → assembleAgentStepContext → ctx.objective.hasInstruction
 *     === false → run-agent-step.ts's "no published instruction for agent" branch
 *     fires → defer-to-human (signal=dormant), ZERO LLM calls.
 *
 *   AFTER saveDraft (real DAO) + promote (simulated the same way promoteTier does:
 *   flip tier='published' on the row saveDraft wrote — no new promote mechanism is
 *   exercised here, artifacts.ts/promoteTier already has its own coverage) for the
 *   SAME employee_id:
 *     readPublished (real DAO, reading the SAME in-memory row) returns the
 *     instruction text → ctx.objective.hasInstruction === true → the "no published
 *     instruction" branch does NOT fire → the motor proceeds to the live-gate and
 *     (with a stub LLM that succeeds) self-closes: agent.proceeded, ZERO changes
 *     to run-agent-step.ts / agent-step-context.ts / agent-dispatch-loop.ts wiring.
 *
 * This file imports ONLY the existing composition-root entrypoint
 * (runAgentDispatchOnce + storeInstructionSource, both exported from
 * src/server/agent-dispatch-loop.ts) — it does NOT import any file under
 * src/runtime/agent-dispatch/ directly, so it carries zero risk of being confused
 * with a change to that frozen zone (FF-15 matches CHANGED files via git diff,
 * and this is a new test file outside that directory importing only unchanged
 * exports).
 */

import { describe, it, expect } from "vitest";
import type pg from "pg";
import {
  runAgentDispatchOnce,
  storeInstructionSource,
  type AgentDispatchDeps,
} from "../agent-dispatch-loop.js";
import { mapAgentTaskToExternal } from "../../core/agent-task-external-mapper.js";
import type { Job } from "../../core/types.js";
import { StubLlmPort } from "../../core/__tests__/stub-llm-port.js";
import { InMemoryAuditWriter } from "../../db/audit-writer.js";
import { stubBudgetPort } from "../../runtime/agent-dispatch/agent-step-context.js";
import { saveDraft } from "../../db/agent-instruction-store.js";
import type { PgClientLike } from "../../db/audit-writer.js";

const TENANT = "a0000000-0000-0000-0000-000000000001";
const AGENT_ID = "d0000000-0000-0000-0000-000000000099";
const ROLE_ID = "role-competence-agent";
const INSTANCE = "33333333-3333-3333-3333-333333333333";
const NOW = 1_700_000_000_000;

const NS =
  'xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:flowable="http://flowable.org/bpmn" ' +
  'xmlns:choros="http://choros.io/bpmn"';

function publishAgentTask(): string {
  const authored =
    `<definitions ${NS}><process id="telLinear">` +
    `<serviceTask id="task-competence" name="Проверка" choros:executorType="agent" ` +
    `choros:agentRef="${AGENT_ID}" choros:assignedRoleId="${ROLE_ID}" ` +
    `choros:agentReadsFields="amount"/>` +
    `</process></definitions>`;
  return mapAgentTaskToExternal(authored);
}

function jobVarsFromPublishedXml(xml: string): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  const re = /<flowable:field name="([^"]+)"><flowable:string>([^<]*)<\/flowable:string><\/flowable:field>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) vars[m[1]!] = m[2]!;
  vars["instanceId"] = INSTANCE;
  vars["procKey"] = "telLinear";
  vars["fields"] = { amount: 250 };
  vars["__tenantId"] = TENANT;
  return vars;
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

/**
 * A minimal fake tx client that:
 *  (a) backs the REAL agent-instruction-store.ts DAO (readByTier/readCurrent/
 *      INSERT ... ON CONFLICT) with a single mutable in-memory row, so
 *      storeInstructionSource.readPublished (the SAME production DI-port impl)
 *      genuinely flips from null → non-null once the row's tier becomes
 *      'published' — no stub instruction source anywhere in this test.
 *  (b) answers the rest of assembleAgentStepContext's direct client.query calls
 *      the same way agent-step-weld.live-stub.test.ts's fakeLiveClient does
 *      (agent_card llm_* configured — live-gate path; no_app_binding for the
 *      record-ref resolution).
 */
interface InstructionRow {
  tenant_id: string;
  id: string;
  employee_id: string;
  employee_kind: string;
  tier: string;
  instruction_text: string;
  answer_form: string | null;
  instruction_meta: Record<string, unknown>;
  bundle_id: string | null;
  created_at: number;
  updated_at: number;
}

class SharedFakeClient implements PgClientLike {
  row: InstructionRow | null = null;
  readonly __tenantId = TENANT;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    // --- agent_instruction DAO reads/writes (real saveDraft / readPublished code) ---
    if (sql.includes("current_setting('choros.tenant_id', false)") && sql.trim().startsWith("SELECT")) {
      return { rows: [{ tenant_id: TENANT }] };
    }
    if (sql.includes("FROM choros.agent_instruction") && sql.includes("AND tier = $2")) {
      const tier = params[1] as string;
      return { rows: this.row && this.row.tier === tier ? [this.row] : [] };
    }
    if (sql.includes("FROM choros.agent_instruction") && sql.includes("WHERE employee_id = $1") && !sql.includes("tier = $2")) {
      return { rows: this.row ? [this.row] : [] };
    }
    if (sql.includes("INSERT INTO choros.agent_instruction")) {
      const [id, employeeId, text, form, metaJson, bundleId, now] = params as [
        string, string, string, string | null, string, string | null, number,
      ];
      this.row = {
        tenant_id: TENANT,
        id,
        employee_id: employeeId,
        employee_kind: "agent",
        tier: "draft",
        instruction_text: text,
        answer_form: form,
        instruction_meta: JSON.parse(metaJson) as Record<string, unknown>,
        bundle_id: bundleId,
        created_at: now,
        updated_at: now,
      };
      return { rows: [] };
    }

    // --- agent-step-context.ts direct client.query calls (mirrors fakeLiveClient) ---
    if (sql.includes("audit_event") && sql.includes("payload->>'inst'")) {
      return { rows: [{ payload: { inst: INSTANCE, proc_key: "telLinear" } }] };
    }
    if (sql.includes("process_app_binding")) {
      return { rows: [] }; // no_app_binding → applyStepResult skips
    }
    if (sql.includes("agent_card")) {
      // Live agent_card (llm_* configured) so a *published* instruction actually
      // reaches the live-gate rather than being masked by a dormant port.
      return {
        rows: [
          {
            llm_endpoint: "https://llm.test/v1",
            llm_model: "test-model",
            secret_handle_ref: "app://handle",
            autonomy_threshold: null,
          },
        ],
      };
    }
    return { rows: [] };
  }
}

/** Promote the currently-drafted row to published — the SAME tier flip promoteTier
 *  performs (UPDATE ... SET tier='published'); this proves the DAO chain, not a
 *  duplicate promote mechanism (promoteTier itself is exercised by
 *  agent-instruction-promote.test.ts through the real HTTP route). */
function promoteInMemory(client: SharedFakeClient): void {
  if (client.row) client.row = { ...client.row, tier: "published" };
}

function buildDeps(args: {
  job: Job;
  client: SharedFakeClient;
  audit: InMemoryAuditWriter;
  outbox: FakeOutbox;
  jobStore: FakeJobStore;
  llm: StubLlmPort;
}): AgentDispatchDeps {
  return {
    fetcher: { fetchAndLockAgentJobs: async () => [{ tenantId: TENANT, jobs: [args.job] }] },
    withTenantTx: async (_t, fn) => fn(args.client as unknown as pg.PoolClient),
    assembleDeps: {
      grants: { getGrants: async () => [] },
      tools: { listTools: async () => [] },
      roleGrants: { getRoleGrants: async () => [] }, // empty → routine criticality
      budget: stubBudgetPort,
      // THE REAL production DI-port implementation (src/server/agent-dispatch-loop.ts:60),
      // backed by our in-memory tx — NOT a stub instruction source.
      instruction: storeInstructionSource,
    },
    runDeps: { llm: args.llm, liveEnabled: true },
    applyDeps: { auditWriter: args.audit, outboxStore: args.outbox as never, jobStore: args.jobStore as never },
    workerId: "test-agent-dispatcher",
    topics: ["agent-step"],
    now: () => NOW,
  };
}

describe("T-0637 AC-5 — instruction gate flips via the REAL DAO, zero motor changes", () => {
  it("BEFORE any draft exists: defers with 'no published instruction for agent' (signal=dormant), zero LLM calls", async () => {
    const client = new SharedFakeClient(); // no row at all
    const audit = new InMemoryAuditWriter();
    const outbox = new FakeOutbox();
    const jobStore = new FakeJobStore();
    const stub = new StubLlmPort({ mode: "succeed", recordCalls: true });

    const summary = await runAgentDispatchOnce(
      buildDeps({ job: makeJob("11111111-1111-1111-1111-111111111111"), client, audit, outbox, jobStore, llm: stub }),
    );

    expect(summary.processed).toBe(1);
    expect(summary.deferred).toBe(1);
    expect(summary.proceeded).toBe(0);
    expect(stub.calls.length).toBe(0); // zero spend — gate fired BEFORE the LLM call

    const events = audit.rows(TENANT);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("agent.deferred");
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload["signal"]).toBe("dormant");
  });

  it("AFTER saveDraft (real DAO) + publish (tier flip) for the SAME employee_id: hasInstruction flips true, motor reaches the live-gate and proceeds", async () => {
    const client = new SharedFakeClient();

    // 1. Author a draft via the REAL saveDraft DAO call (the exact function the
    //    HTTP route in src/http/agents.ts calls through the facade) — proves the
    //    authoring write path, not a hand-rolled row. An in-memory audit writer
    //    stands in for the real hash-chained one (already covered by
    //    agent-instruction-routes.test.ts through the actual HTTP route + pg audit
    //    queries) — saveDraft only requires the AuditWriter interface.
    const writer = new InMemoryAuditWriter();
    await saveDraft(client, writer, {
      draft: {
        tenantId: TENANT,
        id: "aaaaaaaa-1111-1111-1111-111111111111",
        employeeId: AGENT_ID,
        instructionText: "Проверь заявку и посчитай итог по сумме.",
        answerForm: "agent_step_v1",
        instructionMeta: {},
        bundleId: null,
      },
      actor: "e-owner",
      actorType: "human",
      nowMs: NOW - 1000,
    });
    expect(client.row?.tier).toBe("draft");

    // 2. Publish — the SAME tier flip promoteTier performs on this row (the actual
    //    HTTP promote sequence is covered end-to-end by
    //    agent-instruction-promote.test.ts; here we only need the flipped row so
    //    readPublished — the REAL DAO read — returns non-null).
    promoteInMemory(client);
    expect(client.row?.tier).toBe("published");

    // 3. Sanity: the REAL readPublished DAO (same function wired as
    //    storeInstructionSource.readPublished in production) now returns the text.
    const published = await storeInstructionSource.readPublished(client, AGENT_ID);
    expect(published?.instructionText).toBe("Проверь заявку и посчитай итог по сумме.");

    // 4. Drive the full motor with the REAL instruction source.
    const audit = new InMemoryAuditWriter();
    const outbox = new FakeOutbox();
    const jobStore = new FakeJobStore();
    const stub = new StubLlmPort({ mode: "succeed", recordCalls: true });

    const summary = await runAgentDispatchOnce(
      buildDeps({ job: makeJob("22222222-2222-2222-2222-222222222222"), client, audit, outbox, jobStore, llm: stub }),
    );

    expect(summary.processed).toBe(1);
    expect(summary.proceeded).toBe(1);
    expect(summary.deferred).toBe(0);
    expect(summary.errored).toBe(0);

    // The "no published instruction for agent" branch did NOT fire — the LLM WAS
    // called (live-gate reached), zero motor code touched.
    expect(stub.calls.length).toBe(1);

    const events = audit.rows(TENANT);
    expect(events.some((e) => e.type === "agent.proceeded")).toBe(true);
    expect(events.some((e) => e.type === "agent.deferred" && (e.payload as Record<string, unknown>)["doubt_reason"] === "no published instruction for agent")).toBe(false);
    expect(outbox.rows.some((r) => r.eventType === "task_completed")).toBe(true);
    expect(jobStore.completed.length).toBe(1);
  });
});
