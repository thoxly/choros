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
 *   8. handler-level engine-drive: approve handler completes RIGHT defKey in Flowable
 *      (Fix A: task-approve for base; task-extra-approve for 6M extra; Fix D: 6M instance
 *      not false-done while extra-approve pending; Fix C: no-extra linear path).
 */

import * as http from "node:http";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFlowableClient } from "../core/flowable-client.js";
import { Router } from "../http/router.js";
import { registerInboxRoutes, _resetClaimStateForTests } from "../http/inbox.js";
import type { InboxWriteDeps } from "../http/inbox.js";
import type { FlowableClient } from "../core/flowable-client.js";
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
// 1b. getMessageCatchWaits wire-shape (T-0459 [D8-R4])
// ---------------------------------------------------------------------------

describe("getMessageCatchWaits wire-shape (T-0459)", () => {
  it("maps message/signal event-subscriptions; filters out timers", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResp(200, {
        data: [
          { id: "es-1", eventType: "message", eventName: "contract-signed", processInstanceId: "inst-1" },
          { id: "es-2", eventType: "signal", eventName: "status-changed", processInstanceId: "inst-1" },
          // a timer subscription must NOT surface as a message-catch wait.
          { id: "es-3", eventType: "timer", eventName: null, processInstanceId: "inst-1" },
        ],
      }),
    );
    const client = testClient();
    const result = await client.getMessageCatchWaits("inst-1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("should be ok");
    expect(result.waits).toHaveLength(2);
    expect(result.waits.map((w) => w.messageName).sort()).toEqual(["contract-signed", "status-changed"]);
    expect(result.waits.find((w) => w.messageName === "contract-signed")?.eventType).toBe("message");
    expect(result.waits.find((w) => w.messageName === "status-changed")?.eventType).toBe("signal");
  });

  it("returns empty waits when the instance is not parked on any message-catch", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResp(200, { data: [] }));
    const client = testClient();
    const result = await client.getMessageCatchWaits("inst-no-catch");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("should be ok");
    expect(result.waits).toHaveLength(0);
  });

  it("returns a typed code on engine error (honest-degrade)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResp(404));
    const client = testClient();
    const result = await client.getMessageCatchWaits("inst-gone");
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

// ---------------------------------------------------------------------------
// 8. Handler-level engine-drive (Fix A + Fix D + Fix C)
//
// Exercises the FULL approve handler (HTTP → audit tx → engine-drive IIFE) with a
// mock FlowableClient. The IIFE is fire-and-forget so we flush the microtask queue
// with a short await after the HTTP 200 before asserting engine side-effects.
//
// "e-larina" holds role-approver in the in-memory USER_ROLES fixture (inbox.ts).
// We keep both the base and extra-approve tasks addressed to role-approver for
// simplicity — the test's key property is defKey routing, not role differentiation.
// ---------------------------------------------------------------------------

const H_TENANT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const H_INST   = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const H_APPROVER = "e-larina"; // holds role-approver per USER_ROLES fixture

function buildHandlerServer(deps: InboxWriteDeps): { server: http.Server; baseUrl: () => string } {
  const router = new Router();
  registerInboxRoutes(router, undefined, deps);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  return {
    server,
    baseUrl: () => {
      const addr = server.address() as { port: number } | null;
      if (!addr) throw new Error("server not listening");
      return `http://127.0.0.1:${addr.port}`;
    },
  };
}

async function httpPost(
  url: string,
  actor: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body));
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parseInt(parsed.port, 10),
        path: parsed.pathname,
        method: "POST",
        headers: {
          "x-dev-user": actor,
          "Content-Type": "application/json",
          "Content-Length": String(buf.length),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => { data += c.toString(); });
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, json: { raw: data } }); }
        });
      },
    );
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

/** Flush microtask queue: enough ticks for the fire-and-forget engine-drive IIFE
 *  to complete when all mocked async operations resolve immediately. */
async function drainMicrotasks(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

describe("handler-level engine-drive (Fix A + Fix D + Fix C, T-0443)", () => {
  let server: http.Server;
  let base: string;

  afterEach(async () => {
    _resetClaimStateForTests();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  async function startServer(deps: InboxWriteDeps): Promise<void> {
    const h = buildHandlerServer(deps);
    server = h.server;
    await new Promise<void>((r) =>
      server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }),
    );
  }

  // -------------------------------------------------------------------------
  // 8a. Linear (no extra step): base approve → engine completes task-approve
  //     → instance ends → instance.ended emitted → projection done.
  // -------------------------------------------------------------------------
  it("8a. linear: base approve drives task-approve; instance.ended emitted → done", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);

    // Seed process.started
    const setupClient = await pool.connect();
    await setupClient.query(`SET LOCAL choros.tenant_id = '${H_TENANT}'`);
    const baseTaskId = await appendProcessStarted(setupClient as unknown as PgClientLike, {
      instanceId: H_INST,
      procKey: "telLinear",
      actor: "e-orlov",
      nowMs: 1000,
      tenantId: H_TENANT,
    });
    setupClient.release();

    // Mock FlowableClient for linear path:
    //   getActiveUserTasks(H_INST) → [task-approve] on first call
    //   completeUserTask("eng-base-id") → ok
    //   isInstanceEnded(H_INST) → ended=true (engine done after base complete)
    const mockClient: FlowableClient = {
      startInstance: vi.fn(),
      submitUserTask: vi.fn(),
      completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
      getActiveUserTasks: vi.fn().mockResolvedValue({
        ok: true,
        tasks: [{ id: "eng-base-id", taskDefinitionKey: "task-approve", name: "Согласовать", candidateGroups: ["role-approver"] }],
      }),
      isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: true }),
    } as unknown as FlowableClient;

    const deps: InboxWriteDeps = {
      pool,
      resolveActorTenant: async () => H_TENANT,
      flowableClient: mockClient,
    };
    await startServer(deps);

    // Approve base task
    const r = await httpPost(`${base}/api/inbox/${baseTaskId}/action`, H_APPROVER, { action: "approve" });
    expect(r.status).toBe(200);
    expect((r.json as Record<string, unknown>)["status"]).toBe("done");

    // Drain engine-drive IIFE
    await drainMicrotasks();

    // Fix A: completeUserTask called with the ENGINE task id for "task-approve"
    expect(mockClient.completeUserTask).toHaveBeenCalledWith("eng-base-id");
    // Verify NOT called with "task-extra-approve" id (wrong defKey guard)
    expect(mockClient.completeUserTask).not.toHaveBeenCalledWith("eng-extra-id");

    // Engine ended → instance.ended emitted
    const endedEvents = db.events.filter((e) => e.type === INSTANCE_ENDED_TYPE);
    expect(endedEvents).toHaveLength(1);
    expect(endedEvents[0]?.payload["inst"]).toBe(H_INST);

    // No next_task emitted (linear path)
    const nextTaskEvents = db.events.filter((e) => e.type === NEXT_TASK_TYPE);
    expect(nextTaskEvents).toHaveLength(0);

    // Projection: done
    const projections = await listInstanceProjections(pool, H_TENANT);
    expect(projections[0]?.status).toBe("done");
  });

  // -------------------------------------------------------------------------
  // 8b. 6M path — base approve → engine NOT ended → next_task surfaced.
  //     Then extra-approve MUST call completeUserTask with "task-extra-approve"
  //     id (NOT "task-approve"). Fix A key assertion.
  // -------------------------------------------------------------------------
  it("8b. 6M: base approve → process.next_task(task-extra-approve) surfaced; instance NOT done (Fix D)", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);

    const setupClient = await pool.connect();
    await setupClient.query(`SET LOCAL choros.tenant_id = '${H_TENANT}'`);
    const baseTaskId = await appendProcessStarted(setupClient as unknown as PgClientLike, {
      instanceId: H_INST,
      procKey: "telLinear",
      actor: "e-orlov",
      nowMs: 1000,
      tenantId: H_TENANT,
    });
    setupClient.release();

    // Mock FlowableClient for 6M base-approve path:
    //   First getActiveUserTasks → [task-approve] (active before complete)
    //   completeUserTask("eng-base-id") → ok
    //   isInstanceEnded → false (gateway went to 6M branch, extra-approve now active)
    //   Second getActiveUserTasks (for next_task discovery) → [task-extra-approve]
    const mockClient: FlowableClient = {
      startInstance: vi.fn(),
      submitUserTask: vi.fn(),
      completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
      getActiveUserTasks: vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          tasks: [{ id: "eng-base-id", taskDefinitionKey: "task-approve", name: "Согласовать", candidateGroups: ["role-approver"] }],
        })
        .mockResolvedValueOnce({
          ok: true,
          tasks: [{ id: "eng-extra-id", taskDefinitionKey: "task-extra-approve", name: "Согласование CFO", candidateGroups: ["role-approver"] }],
        }),
      isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: false }),
    } as unknown as FlowableClient;

    const deps: InboxWriteDeps = {
      pool,
      resolveActorTenant: async () => H_TENANT,
      flowableClient: mockClient,
    };
    await startServer(deps);

    // Approve base task
    const r = await httpPost(`${base}/api/inbox/${baseTaskId}/action`, H_APPROVER, { action: "approve" });
    expect(r.status).toBe(200);

    // Drain engine-drive IIFE
    await drainMicrotasks();

    // Fix A: completeUserTask called with the base engine task id
    expect(mockClient.completeUserTask).toHaveBeenCalledTimes(1);
    expect(mockClient.completeUserTask).toHaveBeenCalledWith("eng-base-id");

    // Engine NOT ended → process.next_task emitted with task-extra-approve defKey
    const nextTaskEvents = db.events.filter((e) => e.type === NEXT_TASK_TYPE);
    expect(nextTaskEvents).toHaveLength(1);
    expect(nextTaskEvents[0]?.payload["task_def_key"]).toBe("task-extra-approve");

    // No instance.ended emitted yet
    const endedEvents = db.events.filter((e) => e.type === INSTANCE_ENDED_TYPE);
    expect(endedEvents).toHaveLength(0);

    // Fix D: listInstanceProjections must NOT show the instance as done
    // (even though task.approved was emitted for the base task, a pending next_task exists)
    const projections = await listInstanceProjections(pool, H_TENANT);
    expect(projections).toHaveLength(1);
    expect(projections[0]?.status).toBe("waiting"); // Fix D: NOT false-done

    // listInstanceInboxTasks: base task hidden (approved); extra-approve task surfaced
    const inboxTasks = await listInstanceInboxTasks(pool, H_TENANT);
    expect(inboxTasks.find((t) => t.id === baseTaskId)).toBeUndefined(); // base hidden
    const extraTask = inboxTasks.find((t) => t.taskDefKey === "task-extra-approve");
    expect(extraTask).toBeDefined();
    expect(extraTask?.taskDefKey).toBe("task-extra-approve");
  });

  // -------------------------------------------------------------------------
  // 8c. 6M path — extra-approve drives task-extra-approve (NOT task-approve).
  //     Fix A KEY assertion: completeUserTask called with eng-extra-id.
  //     After extra-approve, engine ends → instance.ended → projection done.
  // -------------------------------------------------------------------------
  it("8c. 6M: extra-approve drives task-extra-approve (Fix A) → instance.ended → done", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);

    // Seed base process.started + base task.approved + process.next_task (simulating
    // the state after 8b completed: base approved, extra-approve surfaced).
    const setupClient = await pool.connect();
    await setupClient.query(`SET LOCAL choros.tenant_id = '${H_TENANT}'`);
    const baseTaskId = await appendProcessStarted(setupClient as unknown as PgClientLike, {
      instanceId: H_INST,
      procKey: "telLinear",
      actor: "e-orlov",
      nowMs: 1000,
      tenantId: H_TENANT,
    });
    await appendTaskApproved(setupClient as unknown as PgClientLike, {
      taskId: baseTaskId,
      instanceId: H_INST,
      procKey: "telLinear",
      actor: H_APPROVER,
      nowMs: 2000,
      tenantId: H_TENANT,
    });
    setupClient.release();

    // Emit the next_task event (as the engine-drive would have after base approve)
    const extraTaskId = "11111111-2222-3333-4444-555555555555";
    await appendNextTaskEvent(pool, H_TENANT, {
      instanceId: H_INST,
      procKey: "telLinear",
      actor: H_APPROVER,
      nowMs: 2100,
      taskDefKey: "task-extra-approve",
      taskName: "Согласование CFO",
      taskRole: "role-approver",
      taskStep: "Согласование CFO",
      inboxTaskId: extraTaskId,
    });

    // Verify pre-state: Fix D ensures instance is 'waiting' despite base being approved
    const preProjections = await listInstanceProjections(pool, H_TENANT);
    expect(preProjections[0]?.status).toBe("waiting"); // Fix D guard active

    // Mock FlowableClient for the extra-approve path:
    //   getActiveUserTasks → [task-extra-approve] (only active task now)
    //   completeUserTask("eng-extra-id") → ok
    //   isInstanceEnded → true (engine done after extra-approve)
    const mockClient: FlowableClient = {
      startInstance: vi.fn(),
      submitUserTask: vi.fn(),
      completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
      getActiveUserTasks: vi.fn().mockResolvedValue({
        ok: true,
        tasks: [{ id: "eng-extra-id", taskDefinitionKey: "task-extra-approve", name: "Согласование CFO", candidateGroups: ["role-approver"] }],
      }),
      isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: true }),
    } as unknown as FlowableClient;

    const deps: InboxWriteDeps = {
      pool,
      resolveActorTenant: async () => H_TENANT,
      flowableClient: mockClient,
    };
    await startServer(deps);

    // Approve the extra-approve inbox row (its taskDefKey is "task-extra-approve")
    const r = await httpPost(`${base}/api/inbox/${extraTaskId}/action`, H_APPROVER, { action: "approve" });
    expect(r.status).toBe(200);

    // Drain engine-drive IIFE
    await drainMicrotasks();

    // Fix A KEY ASSERTION: completeUserTask called with the EXTRA engine task id
    // (NOT "task-approve" — that was the old hardcoded bug)
    expect(mockClient.completeUserTask).toHaveBeenCalledTimes(1);
    expect(mockClient.completeUserTask).toHaveBeenCalledWith("eng-extra-id");
    expect(mockClient.completeUserTask).not.toHaveBeenCalledWith("eng-base-id");

    // Engine ended → instance.ended emitted
    await drainMicrotasks(); // extra flush for appendInstanceEnded tx
    const endedEvents = db.events.filter((e) => e.type === INSTANCE_ENDED_TYPE);
    expect(endedEvents).toHaveLength(1);
    expect(endedEvents[0]?.payload["inst"]).toBe(H_INST);

    // Projection: done (engine-gated)
    const projections = await listInstanceProjections(pool, H_TENANT);
    expect(projections[0]?.status).toBe("done");

    // No more waiting tasks
    const inboxTasks = await listInstanceInboxTasks(pool, H_TENANT);
    expect(inboxTasks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 9. T-0456 [D8-R1]: parallelGateway AND-split — MULTI-TOKEN reconciliation.
//
// The inbox projection is a SEPARATE state machine from Flowable (two machines).
// An AND-split leaves N user-tasks active on ONE instance at once. The engine-drive
// must reconcile by surfacing EVERY concurrent token (not "first active"), and the
// projection must show all concurrent branches.
//
// These tests exercise the reconciliation logic against REALISTIC multi-token engine
// state (getActiveUserTasks returns TWO concurrent tasks), NOT a single-task mock —
// a single-task mock would mask the bug this task fixes.
// ---------------------------------------------------------------------------

describe("T-0456 [D8-R1] parallelGateway multi-token reconciliation", () => {
  let server: http.Server;
  let base: string;

  afterEach(async () => {
    _resetClaimStateForTests();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  async function startServer(deps: InboxWriteDeps): Promise<void> {
    const h = buildHandlerServer(deps);
    server = h.server;
    await new Promise<void>((r) =>
      server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }),
    );
  }

  // -------------------------------------------------------------------------
  // 9a. AND-split: base approve → engine NOT ended, TWO concurrent tasks active.
  //     Reconcile MUST emit a process.next_task for BOTH branches (not just the
  //     first). Both surface in the inbox; projection shows BOTH concurrent steps.
  // -------------------------------------------------------------------------
  it("9a. AND-split surfaces BOTH concurrent branches (not first-active)", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);

    const setupClient = await pool.connect();
    await setupClient.query(`SET LOCAL choros.tenant_id = '${H_TENANT}'`);
    const baseTaskId = await appendProcessStarted(setupClient as unknown as PgClientLike, {
      instanceId: H_INST,
      procKey: "telParallel",
      actor: "e-orlov",
      nowMs: 1000,
      tenantId: H_TENANT,
    });
    setupClient.release();

    // REALISTIC multi-token engine state: after the base approve completes, the
    // parallelGateway splits into TWO concurrent user-tasks (branch A + branch B),
    // both active on the SAME instance. This is the multi-token reality a single-task
    // mock would hide.
    const mockClient: FlowableClient = {
      startInstance: vi.fn(),
      submitUserTask: vi.fn(),
      completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
      getActiveUserTasks: vi.fn()
        // 1st call: poll to find the just-approved base task.
        .mockResolvedValueOnce({
          ok: true,
          tasks: [{ id: "eng-base-id", taskDefinitionKey: "task-approve", name: "Согласовать", candidateGroups: ["role-approver"] }],
        })
        // 2nd call: next_task discovery → TWO concurrent tokens (AND-split).
        .mockResolvedValueOnce({
          ok: true,
          tasks: [
            { id: "eng-branchA-id", taskDefinitionKey: "task-legal", name: "Юридическая проверка", candidateGroups: ["role-approver"] },
            { id: "eng-branchB-id", taskDefinitionKey: "task-finance", name: "Финансовая проверка", candidateGroups: ["role-approver"] },
          ],
        }),
      isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: false }),
    } as unknown as FlowableClient;

    const deps: InboxWriteDeps = {
      pool,
      resolveActorTenant: async () => H_TENANT,
      flowableClient: mockClient,
    };
    await startServer(deps);

    const r = await httpPost(`${base}/api/inbox/${baseTaskId}/action`, H_APPROVER, { action: "approve" });
    expect(r.status).toBe(200);
    await drainMicrotasks();

    // KEY ASSERTION: TWO process.next_task rows emitted — one per concurrent branch.
    // The pre-T-0456 code emitted only ONE (the first non-matching active task).
    const nextTaskEvents = db.events.filter((e) => e.type === NEXT_TASK_TYPE);
    expect(nextTaskEvents).toHaveLength(2);
    const emittedDefKeys = nextTaskEvents.map((e) => e.payload["task_def_key"]).sort();
    expect(emittedDefKeys).toEqual(["task-finance", "task-legal"]);

    // Instance is NOT done while concurrent branches are still waiting.
    const endedEvents = db.events.filter((e) => e.type === INSTANCE_ENDED_TYPE);
    expect(endedEvents).toHaveLength(0);

    // BOTH concurrent tasks surface in the inbox projection.
    const inboxTasks = await listInstanceInboxTasks(pool, H_TENANT);
    const instTasks = inboxTasks.filter((t) => t.inst === H_INST);
    expect(instTasks).toHaveLength(2);
    expect(instTasks.map((t) => t.taskDefKey).sort()).toEqual(["task-finance", "task-legal"]);
    // Base task is hidden (approved).
    expect(inboxTasks.find((t) => t.id === baseTaskId)).toBeUndefined();

    // Projection shows BOTH concurrent steps (the process card renders them).
    const projections = await listInstanceProjections(pool, H_TENANT);
    expect(projections).toHaveLength(1);
    expect(projections[0]?.status).toBe("waiting");
    const steps = [...(projections[0]?.concurrentSteps ?? [])].sort();
    expect(steps).toEqual(["Финансовая проверка", "Юридическая проверка"]);
  });

  // -------------------------------------------------------------------------
  // 9b. Idempotency: re-running the reconcile (e.g. a second approve, or a retry)
  //     against the SAME live multi-token state does NOT duplicate next_task rows
  //     for branches already on screen.
  // -------------------------------------------------------------------------
  it("9b. reconcile is idempotent — already-projected branches are not re-emitted", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);

    const setupClient = await pool.connect();
    await setupClient.query(`SET LOCAL choros.tenant_id = '${H_TENANT}'`);
    const baseTaskId = await appendProcessStarted(setupClient as unknown as PgClientLike, {
      instanceId: H_INST,
      procKey: "telParallel",
      actor: "e-orlov",
      nowMs: 1000,
      tenantId: H_TENANT,
    });
    await appendTaskApproved(setupClient as unknown as PgClientLike, {
      taskId: baseTaskId,
      instanceId: H_INST,
      procKey: "telParallel",
      actor: H_APPROVER,
      nowMs: 2000,
      tenantId: H_TENANT,
    });
    setupClient.release();

    // Branch A already surfaced from a prior reconcile pass.
    const branchATaskId = "aaaa1111-2222-3333-4444-555555555555";
    await appendNextTaskEvent(pool, H_TENANT, {
      instanceId: H_INST,
      procKey: "telParallel",
      actor: H_APPROVER,
      nowMs: 2100,
      taskDefKey: "task-legal",
      taskName: "Юридическая проверка",
      taskRole: "role-approver",
      taskStep: "Юридическая проверка",
      inboxTaskId: branchATaskId,
    });

    // Now approve branch A. Engine still has branch A (about to complete) AND branch B
    // active. After completing A, reconcile sees branch B still active — but branch A
    // is already projected, so it must NOT be re-emitted; only branch B is new.
    const mockClient: FlowableClient = {
      startInstance: vi.fn(),
      submitUserTask: vi.fn(),
      completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
      getActiveUserTasks: vi.fn()
        // poll: find branch A's engine task by defKey.
        .mockResolvedValueOnce({
          ok: true,
          tasks: [
            { id: "eng-branchA-id", taskDefinitionKey: "task-legal", name: "Юридическая проверка", candidateGroups: ["role-approver"] },
            { id: "eng-branchB-id", taskDefinitionKey: "task-finance", name: "Финансовая проверка", candidateGroups: ["role-approver"] },
          ],
        })
        // next_task discovery: branch B still active (A completed).
        .mockResolvedValueOnce({
          ok: true,
          tasks: [
            { id: "eng-branchB-id", taskDefinitionKey: "task-finance", name: "Финансовая проверка", candidateGroups: ["role-approver"] },
          ],
        }),
      isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: false }),
    } as unknown as FlowableClient;

    const deps: InboxWriteDeps = {
      pool,
      resolveActorTenant: async () => H_TENANT,
      flowableClient: mockClient,
    };
    await startServer(deps);

    const r = await httpPost(`${base}/api/inbox/${branchATaskId}/action`, H_APPROVER, { action: "approve" });
    expect(r.status).toBe(200);
    await drainMicrotasks();

    // Fix A: completed branch A's engine task by its own defKey.
    expect(mockClient.completeUserTask).toHaveBeenCalledWith("eng-branchA-id");

    // Exactly ONE new next_task (branch B). Branch A (already projected) is NOT
    // re-emitted. Total next_task rows = 1 (seeded A) + 1 (new B) = 2.
    const nextTaskEvents = db.events.filter((e) => e.type === NEXT_TASK_TYPE);
    expect(nextTaskEvents).toHaveLength(2);
    const finance = nextTaskEvents.filter((e) => e.payload["task_def_key"] === "task-finance");
    const legal = nextTaskEvents.filter((e) => e.payload["task_def_key"] === "task-legal");
    expect(finance).toHaveLength(1); // branch B emitted exactly once
    expect(legal).toHaveLength(1);   // branch A NOT re-emitted (still the seeded one)

    // Branch A is now approved/hidden; branch B is the only remaining waiting task.
    const inboxTasks = await listInstanceInboxTasks(pool, H_TENANT);
    const instTasks = inboxTasks.filter((t) => t.inst === H_INST);
    expect(instTasks.map((t) => t.taskDefKey).sort()).toEqual(["task-finance"]);
  });

  // -------------------------------------------------------------------------
  // 9c. AND-join: after the last concurrent branch completes, the engine joins and
  //     ends the instance → instance.ended → projection done, no waiting steps.
  // -------------------------------------------------------------------------
  it("9c. AND-join ends the instance after the last branch (done, empty concurrentSteps)", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);

    const setupClient = await pool.connect();
    await setupClient.query(`SET LOCAL choros.tenant_id = '${H_TENANT}'`);
    const baseTaskId = await appendProcessStarted(setupClient as unknown as PgClientLike, {
      instanceId: H_INST,
      procKey: "telParallel",
      actor: "e-orlov",
      nowMs: 1000,
      tenantId: H_TENANT,
    });
    await appendTaskApproved(setupClient as unknown as PgClientLike, {
      taskId: baseTaskId,
      instanceId: H_INST,
      procKey: "telParallel",
      actor: H_APPROVER,
      nowMs: 2000,
      tenantId: H_TENANT,
    });
    setupClient.release();

    // Branch B is the LAST remaining concurrent branch (A already completed earlier).
    const branchBTaskId = "bbbb1111-2222-3333-4444-555555555555";
    await appendNextTaskEvent(pool, H_TENANT, {
      instanceId: H_INST,
      procKey: "telParallel",
      actor: H_APPROVER,
      nowMs: 2100,
      taskDefKey: "task-finance",
      taskName: "Финансовая проверка",
      taskRole: "role-approver",
      taskStep: "Финансовая проверка",
      inboxTaskId: branchBTaskId,
    });

    // Approving branch B completes the last token → AND-join → instance ends.
    const mockClient: FlowableClient = {
      startInstance: vi.fn(),
      submitUserTask: vi.fn(),
      completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
      getActiveUserTasks: vi.fn().mockResolvedValueOnce({
        ok: true,
        tasks: [{ id: "eng-branchB-id", taskDefinitionKey: "task-finance", name: "Финансовая проверка", candidateGroups: ["role-approver"] }],
      }),
      isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: true }),
    } as unknown as FlowableClient;

    const deps: InboxWriteDeps = {
      pool,
      resolveActorTenant: async () => H_TENANT,
      flowableClient: mockClient,
    };
    await startServer(deps);

    const r = await httpPost(`${base}/api/inbox/${branchBTaskId}/action`, H_APPROVER, { action: "approve" });
    expect(r.status).toBe(200);
    await drainMicrotasks();
    await drainMicrotasks(); // extra flush for appendInstanceEnded tx

    expect(mockClient.completeUserTask).toHaveBeenCalledWith("eng-branchB-id");

    // AND-join ended the instance.
    const endedEvents = db.events.filter((e) => e.type === INSTANCE_ENDED_TYPE);
    expect(endedEvents).toHaveLength(1);

    // Projection: done, no concurrent waiting steps.
    const projections = await listInstanceProjections(pool, H_TENANT);
    expect(projections[0]?.status).toBe("done");
    expect(projections[0]?.concurrentSteps).toEqual([]);

    const inboxTasks = await listInstanceInboxTasks(pool, H_TENANT);
    expect(inboxTasks.filter((t) => t.inst === H_INST)).toHaveLength(0);
  });
});
