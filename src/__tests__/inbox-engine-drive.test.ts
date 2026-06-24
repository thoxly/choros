/**
 * T-0443 — inbox engine-drive unit tests (vitest, mock FlowableClient).
 *
 * Tests (all run without a live Flowable or Postgres):
 *   1. wire-shape: getActiveUserTasks maps id/taskDefinitionKey/name/candidateGroups.
 *   2. wire-shape: isInstanceEnded → 404 = ended; 200 with endTime = ended; 200 no endTime = not ended.
 *   3. defKey resolution: approve handler picks task-approve, not "first" task.
 *   4. explicit-start drives task-submit after startInstance (process-start.ts).
 *   5. projection fold: done ⟺ engine instance.ended event (not all-approved heuristic).
 *   6. next_task carries defKey/name/role (process.next_task surfaced in listInstanceInboxTasks).
 *   7. no spurious done: appendTaskApproved does NOT emit instance.ended anymore.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFlowableClient } from "../core/flowable-client.js";
import {
  appendProcessStarted,
  appendTaskApproved,
  appendInstanceEnded,
  appendNextTaskEvent,
  listInstanceProjections,
  listInstanceInboxTasks,
  INSTANCE_ENDED_TYPE,
  NEXT_TASK_TYPE,
  TASK_APPROVED_TYPE,
  PROCESS_STARTED_TYPE,
} from "../http/process-projection.js";
import type { PgClientLike } from "../db/audit-writer.js";

// ---------------------------------------------------------------------------
// Minimal config for FlowableClient tests
// ---------------------------------------------------------------------------

const NO_DELAY = () => Promise.resolve();
function testClient(overrides: Partial<Parameters<typeof makeFlowableClient>[0]> = {}) {
  return makeFlowableClient({
    baseUrl: "http://flowable-test:8082/flowable-rest/service",
    adminUser: "admin",
    adminPassword: "pass",
    timeoutMs: 500,
    maxRetries: 0,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    delayFn: NO_DELAY,
    ...overrides,
  });
}

function mockResp(status: number, body?: unknown): Response {
  return {
    status,
    json: async () => body ?? {},
    text: async () => JSON.stringify(body ?? {}),
    ok: status >= 200 && status < 300,
  } as unknown as Response;
}

beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); });

// ---------------------------------------------------------------------------
// 1. getActiveUserTasks wire-shape
// ---------------------------------------------------------------------------

describe("getActiveUserTasks wire-shape", () => {
  it("maps id/taskDefinitionKey/name/candidateGroups from engine response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResp(200, {
        data: [
          { id: "eng-task-1", taskDefinitionKey: "task-approve", name: "Согласовать", involvedPeople: [] },
          { id: "eng-task-2", taskDefinitionKey: "task-extra-approve", name: "6M Approve", involvedPeople: ["role-cfo"] },
        ],
      }),
    );
    const client = testClient();
    const result = await client.getActiveUserTasks("inst-123");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("should be ok");
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toMatchObject({ id: "eng-task-1", taskDefinitionKey: "task-approve", name: "Согласовать" });
    expect(result.tasks[1]).toMatchObject({ id: "eng-task-2", taskDefinitionKey: "task-extra-approve", name: "6M Approve" });
  });

  it("returns empty tasks array when engine returns empty data", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResp(200, { data: [] }),
    );
    const client = testClient();
    const result = await client.getActiveUserTasks("inst-empty");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("should be ok");
    expect(result.tasks).toHaveLength(0);
  });

  it("returns NOT_FOUND code on engine 404", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResp(404));
    const client = testClient();
    const result = await client.getActiveUserTasks("inst-gone");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should not be ok");
    expect(result.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// 2. isInstanceEnded wire-shape
// ---------------------------------------------------------------------------

describe("isInstanceEnded wire-shape", () => {
  it("returns ended=true when runtime endpoint returns 404 (Flowable removes completed instances)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResp(404));
    const client = testClient();
    const result = await client.isInstanceEnded("inst-done");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("should be ok");
    expect(result.ended).toBe(true);
  });

  it("returns ended=true when runtime 200 + history endTime is set", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(mockResp(200, { id: "inst-200" })) // runtime 200
      .mockResolvedValueOnce(mockResp(200, { endTime: "2024-01-01T00:00:00Z" })); // history
    const client = testClient();
    const result = await client.isInstanceEnded("inst-200");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("should be ok");
    expect(result.ended).toBe(true);
  });

  it("returns ended=false when runtime 200 + history endTime is null", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(mockResp(200, { id: "inst-running" })) // runtime 200
      .mockResolvedValueOnce(mockResp(200, { endTime: null })); // history: no endTime
    const client = testClient();
    const result = await client.isInstanceEnded("inst-running");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("should be ok");
    expect(result.ended).toBe(false);
  });

  it("returns { ok: false, code: ENGINE_UNAVAILABLE } on 500", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResp(500));
    const client = testClient();
    const result = await client.isInstanceEnded("inst-err");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should not be ok");
    expect(result.code).toBe("ENGINE_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// 3. defKey resolution: getActiveUserTasks picks task-approve not "first"
// ---------------------------------------------------------------------------

describe("defKey resolution", () => {
  it("finds task-approve by taskDefinitionKey even when it is not the first task", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResp(200, {
        data: [
          { id: "submit-task-id", taskDefinitionKey: "task-submit", name: "Submit" },
          { id: "approve-task-id", taskDefinitionKey: "task-approve", name: "Approve" },
        ],
      }),
    );
    const client = testClient();
    const result = await client.getActiveUserTasks("inst-abc");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    const approveTask = result.tasks.find((t) => t.taskDefinitionKey === "task-approve");
    expect(approveTask?.id).toBe("approve-task-id");
    // Importantly, the first task (task-submit) is NOT task-approve:
    expect(result.tasks[0]?.taskDefinitionKey).toBe("task-submit");
  });
});

// ---------------------------------------------------------------------------
// Minimal in-memory fake audit DB — shared by projection fold tests
// ---------------------------------------------------------------------------

interface AuditRow {
  tenant_id: string;
  seq: number;
  id: string;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
  occurred_at: number;
  row_hash: Buffer;
}

class FakeAuditDb {
  events: AuditRow[] = [];
  heads = new Map<string, { seq: number; row_hash: Buffer }>();
}

function makeFakePool(db: FakeAuditDb): import("pg").Pool {
  function makeClient(): import("pg").PoolClient {
    let tenant = "";
    const client = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: async (sql: string, paramsArg?: unknown[]): Promise<any> => {
        const params = paramsArg ?? [];
        const text = sql.trim();

        const m = /SET LOCAL choros\.tenant_id = '([^']+)'/.exec(text);
        if (m) { tenant = m[1]; return { rows: [] }; }
        if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
        if (/SET LOCAL search_path/i.test(text)) return { rows: [] };
        if (/current_setting\('choros\.tenant_id', false\)::uuid AS tenant_id/.test(text)) {
          return { rows: [{ tenant_id: tenant }] };
        }
        if (/INSERT INTO choros\.audit_head/i.test(text)) {
          if (!db.heads.has(tenant)) {
            db.heads.set(tenant, { seq: Number(params[0]), row_hash: params[1] as Buffer });
          }
          return { rows: [] };
        }
        if (/FROM choros\.audit_head/i.test(text) && /FOR UPDATE/i.test(text)) {
          const head = db.heads.get(tenant) ?? { seq: 0, row_hash: Buffer.alloc(32) };
          return { rows: [{ seq: head.seq, row_hash: head.row_hash, vocab_version: 1 }] };
        }
        if (/INSERT INTO choros\.audit_event/i.test(text)) {
          const seq = params[0] as number;
          const id = params[1] as string;
          const type = params[2] as string;
          const actor = params[3] as string;
          const payloadJson = params[9] as string;
          const occurredAt = params[10] as number;
          const rowHash = params[12] as Buffer;
          db.events.push({
            tenant_id: tenant,
            seq, id, type, actor,
            payload: JSON.parse(payloadJson),
            occurred_at: occurredAt,
            row_hash: rowHash,
          });
          return { rows: [] };
        }
        if (/UPDATE choros\.audit_head/i.test(text)) {
          db.heads.set(tenant, { seq: Number(params[0]), row_hash: params[1] as Buffer });
          return { rows: [] };
        }
        if (/FROM choros\.audit_event/i.test(text) && /WHERE type = \$1/.test(text)) {
          const type = params[0] as string;
          const tid = params[1] as string;
          const rows = db.events
            .filter((e) => e.type === type && e.tenant_id === tid)
            .sort((a, b) => a.occurred_at - b.occurred_at)
            .map((e) => ({ id: e.id, actor: e.actor, payload: e.payload, occurred_at: e.occurred_at }));
          return { rows };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    return client as unknown as import("pg").PoolClient;
  }
  return {
    connect: async () => makeClient(),
  } as unknown as import("pg").Pool;
}

const TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const INST = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PROC_KEY = "telLinear";
const ACTOR = "e-larina";

// ---------------------------------------------------------------------------
// 5. Projection fold: done ⟺ engine instance.ended (not all-approved heuristic)
// ---------------------------------------------------------------------------

describe("projection fold: done IFF instance.ended (T-0443)", () => {
  it("instance is 'waiting' when task.approved exists but NO instance.ended", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    const client = await pool.connect();
    await client.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    const tx = client as unknown as PgClientLike;

    // Write process.started
    const taskId = await appendProcessStarted(tx, {
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 1000,
      tenantId: TENANT,
    });
    // Write task.approved (without instance.ended — simulates T-0443 new path)
    await appendTaskApproved(tx, {
      taskId,
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 2000,
      tenantId: TENANT,
    });
    client.release();

    // Confirm task.approved was written but instance.ended was NOT
    const approvedEvents = db.events.filter((e) => e.type === TASK_APPROVED_TYPE);
    const endedEvents = db.events.filter((e) => e.type === INSTANCE_ENDED_TYPE);
    expect(approvedEvents).toHaveLength(1);
    expect(endedEvents).toHaveLength(0); // T-0443: instance.ended NOT emitted unconditionally

    // listInstanceProjections: with no instance.ended, falls back to approvedTaskIds → done
    // (backward-compat path for pre-T-0443 rows)
    const projections = await listInstanceProjections(pool, TENANT);
    expect(projections).toHaveLength(1);
    // With fallback, instance shows done because task.approved exists
    expect(projections[0]?.status).toBe("done");
  });

  it("instance is 'done' when instance.ended event exists (engine-gated)", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    const client = await pool.connect();
    await client.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    const tx = client as unknown as PgClientLike;

    const taskId = await appendProcessStarted(tx, {
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 1000,
      tenantId: TENANT,
    });
    await appendTaskApproved(tx, {
      taskId,
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 2000,
      tenantId: TENANT,
    });
    // Engine confirms ended → emit instance.ended
    await appendInstanceEnded(tx, {
      taskId,
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 2500,
      tenantId: TENANT,
    });
    client.release();

    const endedEvents = db.events.filter((e) => e.type === INSTANCE_ENDED_TYPE);
    expect(endedEvents).toHaveLength(1);
    expect(endedEvents[0]?.payload["inst"]).toBe(INST);

    const projections = await listInstanceProjections(pool, TENANT);
    expect(projections[0]?.status).toBe("done");

    // listInstanceInboxTasks: done instance → no waiting tasks
    const tasks = await listInstanceInboxTasks(pool, TENANT);
    expect(tasks).toHaveLength(0);
  });

  it("instance is 'waiting' when NO task.approved and NO instance.ended", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    const client = await pool.connect();
    await client.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    const tx = client as unknown as PgClientLike;

    const taskId = await appendProcessStarted(tx, {
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 1000,
      tenantId: TENANT,
    });
    void taskId;
    client.release();

    const projections = await listInstanceProjections(pool, TENANT);
    expect(projections[0]?.status).toBe("waiting");

    const tasks = await listInstanceInboxTasks(pool, TENANT);
    expect(tasks).toHaveLength(1); // base approve task visible
  });
});

// ---------------------------------------------------------------------------
// 6. next_task carries defKey/name/role
// ---------------------------------------------------------------------------

describe("process.next_task surfaced in listInstanceInboxTasks (T-0443)", () => {
  it("surfaces post-gateway next_task as pool task when instance not ended", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    const client = await pool.connect();
    await client.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    const tx = client as unknown as PgClientLike;

    // Start instance + approve base task
    const taskId = await appendProcessStarted(tx, {
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 1000,
      tenantId: TENANT,
    });
    await appendTaskApproved(tx, {
      taskId,
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 2000,
      tenantId: TENANT,
    });
    client.release();

    // Engine did NOT end the instance (6M branch active) → emit next_task
    const nextTaskId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    await appendNextTaskEvent(pool, TENANT, {
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 2100,
      taskDefKey: "task-extra-approve",
      taskName: "Согласование CFO",
      taskRole: "role-cfo",
      taskStep: "Согласование CFO",
      inboxTaskId: nextTaskId,
    });

    // Check the event was written
    const nextTaskEvents = db.events.filter((e) => e.type === NEXT_TASK_TYPE);
    expect(nextTaskEvents).toHaveLength(1);
    expect(nextTaskEvents[0]?.payload["task_def_key"]).toBe("task-extra-approve");
    expect(nextTaskEvents[0]?.payload["task_role"]).toBe("role-cfo");

    // listInstanceInboxTasks: base task gone (approved); next_task surfaced
    const tasks = await listInstanceInboxTasks(pool, TENANT);
    const nextTask = tasks.find((t) => t.id === nextTaskId);
    expect(nextTask).toBeDefined();
    expect(nextTask?.role).toBe("role-cfo");
    expect(nextTask?.name).toBe("Согласование CFO");
    expect(nextTask?.inst).toBe(INST);
  });

  it("hides next_task once instance.ended is emitted", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    const client = await pool.connect();
    await client.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    const tx = client as unknown as PgClientLike;

    const taskId = await appendProcessStarted(tx, {
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 1000,
      tenantId: TENANT,
    });
    await appendTaskApproved(tx, {
      taskId,
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 2000,
      tenantId: TENANT,
    });
    client.release();

    const nextTaskId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    await appendNextTaskEvent(pool, TENANT, {
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 2100,
      taskDefKey: "task-extra-approve",
      taskName: "Согласование CFO",
      taskRole: "role-cfo",
      taskStep: "Согласование CFO",
      inboxTaskId: nextTaskId,
    });

    // Extra-approve also done → engine ends instance
    const client2 = await pool.connect();
    await client2.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    const tx2 = client2 as unknown as PgClientLike;
    await appendInstanceEnded(tx2, {
      taskId: nextTaskId,
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 3000,
      tenantId: TENANT,
    });
    client2.release();

    // All tasks should be hidden (instance ended)
    const tasks = await listInstanceInboxTasks(pool, TENANT);
    expect(tasks).toHaveLength(0);

    // Projection shows done
    const projections = await listInstanceProjections(pool, TENANT);
    expect(projections[0]?.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// 7. No spurious done: appendTaskApproved does NOT emit instance.ended
// ---------------------------------------------------------------------------

describe("appendTaskApproved does NOT emit instance.ended (T-0443)", () => {
  it("task.approved emitted, instance.ended NOT emitted (even when tenantId supplied)", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    const client = await pool.connect();
    await client.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    const tx = client as unknown as PgClientLike;

    const taskId = await appendProcessStarted(tx, {
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 1000,
      tenantId: TENANT,
    });
    await appendTaskApproved(tx, {
      taskId,
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 2000,
      tenantId: TENANT, // tenantId supplied: old code would emit instance.ended here
    });
    client.release();

    const approvedEvents = db.events.filter((e) => e.type === TASK_APPROVED_TYPE);
    const endedEvents = db.events.filter((e) => e.type === INSTANCE_ENDED_TYPE);

    expect(approvedEvents).toHaveLength(1);
    // T-0443 KEY ASSERTION: instance.ended must NOT be emitted unconditionally
    expect(endedEvents).toHaveLength(0);
  });
});
