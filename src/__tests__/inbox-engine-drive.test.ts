/**
 * T-0440 · inbox approve → engine-drive integration tests
 *
 * These tests cover the post-PG-tx engine-drive logic added in T-0440:
 *   1. ТЭЛ-shaped (amount>5M, needs-approval): approve#1 → engine advances →
 *      projection surfaces a SECOND waiting task («Доп. согласование») and
 *      instance is NOT done; approve#2 → engine ends → instance done.
 *   2. amount≤5M (standard): approve#1 → engine ends → instance done (one approve,
 *      no extra task).
 *   3. Regression: plain single-userTask process (no gateway or gateway routes to
 *      end) → approve → done, no extra task.
 *   4. completeUserTask backward-compat: the existing records.ts caller passes no
 *      variables — unaffected.
 *   5. Engine errors are best-effort / non-fatal: engine error does NOT prevent
 *      the PG approve from committing; the approve still returns 200.
 *
 * Pure unit — no live Postgres, no live Flowable. Fake pg pool (mirrors
 * inbox-action.test.ts) and stub FlowableClient (injectable via flowableClient
 * field of InboxWriteDeps).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerInboxRoutes, _resetClaimStateForTests, type InboxWriteDeps } from "../http/inbox.js";
import {
  appendProcessStarted,
  listInstanceInboxTasks,
  listInstanceProjections,
} from "../http/process-projection.js";
import type { PgClientLike } from "../db/audit-writer.js";
import type { FlowableClient, IsInstanceEndedResult, GetFirstUserTaskResult, CompleteUserTaskResult } from "../core/flowable-client.js";

// ---------------------------------------------------------------------------
// In-memory fake pg pool (mirrors inbox-action.test.ts)
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

class FakeDb {
  events: AuditRow[] = [];
  heads = new Map<string, { seq: number; row_hash: Buffer }>();
}

function makeFakePool(db: FakeDb): import("pg").Pool {
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
        if (/SAVEPOINT/i.test(text)) return { rows: [] };
        if (/RELEASE SAVEPOINT/i.test(text)) return { rows: [] };

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
            seq,
            id,
            type,
            actor,
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

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

function buildServer(deps?: InboxWriteDeps): { server: http.Server; baseUrl: () => string } {
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

async function httpReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const parsed = new URL(url);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...headers,
        ...(buf ? { "Content-Type": "application/json", "Content-Length": String(buf.length) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => { data += c.toString(); });
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode ?? 0, json: { raw: data } }); }
      });
    });
    req.on("error", reject);
    if (buf) req.write(buf);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const APPROVER = "e-larina"; // holds role-approver per USER_ROLES fixture

/** Seed one waiting telLinear instance task in the fake db; returns { taskId, instanceId }. */
async function seedStartedTask(
  db: FakeDb,
  instanceId = "flw-engine-drive-1",
): Promise<{ taskId: string; instanceId: string }> {
  const pool = makeFakePool(db);
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(`SET LOCAL choros.tenant_id = '${TENANT_ID}'`);
  await client.query("SET LOCAL search_path TO choros");
  const taskId = await appendProcessStarted(client as unknown as PgClientLike, {
    instanceId,
    procKey: "telLinear",
    actor: "e-orlov",
    nowMs: Date.now(),
  });
  await client.query("COMMIT");
  client.release();
  return { taskId, instanceId };
}

/** Build a stub FlowableClient for testing. */
function makeFlowable(overrides: Partial<FlowableClient> = {}): FlowableClient {
  return {
    deployBpmn: vi.fn(),
    startInstance: vi.fn(),
    fetchAndLock: vi.fn(),
    completeTask: vi.fn(),
    failTask: vi.fn(),
    getFirstActiveUserTask: vi.fn().mockResolvedValue({ ok: true, taskId: null } satisfies GetFirstUserTaskResult),
    completeUserTask: vi.fn().mockResolvedValue({ ok: true } satisfies CompleteUserTaskResult),
    isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: true } satisfies IsInstanceEndedResult),
    ...overrides,
  };
}

function makeDeps(db: FakeDb, flowableClient?: FlowableClient): InboxWriteDeps {
  return {
    pool: makeFakePool(db),
    resolveActorTenant: async () => TENANT_ID,
    flowableClient,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T-0440 inbox approve → engine-drive (multi-step process)", () => {
  let server: http.Server;
  let base: string;

  afterEach(async () => {
    _resetClaimStateForTests();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  async function startServer(deps: InboxWriteDeps): Promise<void> {
    const h = buildServer(deps);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  }

  // ── TC-1: ТЭЛ-shaped — gateway routes to «Доп. согласование» ──────────────
  it("TC-1: approve#1 → engine advances → second waiting task surfaced; instance NOT done", async () => {
    const db = new FakeDb();
    const { taskId, instanceId } = await seedStartedTask(db, "flw-branching-1");

    // Simulate: first getFirstActiveUserTask returns the initial Flowable user-task,
    // second call (post-complete) returns the post-gateway task.
    const flowable = makeFlowable({
      getFirstActiveUserTask: vi.fn()
        .mockResolvedValueOnce({ ok: true, taskId: "flw-task-initial" } satisfies GetFirstUserTaskResult)
        .mockResolvedValueOnce({ ok: true, taskId: "flw-task-extra" } satisfies GetFirstUserTaskResult),
      completeUserTask: vi.fn().mockResolvedValue({ ok: true } satisfies CompleteUserTaskResult),
    });

    await startServer(makeDeps(db, flowable));

    // Approve the initial task.
    const r = await httpReq(
      "POST",
      `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      { action: "approve" },
    );
    expect(r.status).toBe(200);

    // completeUserTask must have been called with the Flowable task id.
    expect(flowable.completeUserTask).toHaveBeenCalledWith("flw-task-initial");

    // A second waiting task must now appear in the inbox.
    const inboxTasks = await listInstanceInboxTasks(makeFakePool(db), TENANT_ID);
    const extraTask = inboxTasks.find((t) => t.inst === instanceId);
    expect(extraTask, "TC-1: second task must appear in inbox pool").toBeDefined();
    expect(extraTask!.id, "TC-1: second task must have a DIFFERENT id than the approved one").not.toBe(taskId);
    expect(extraTask!.step).toBe("Доп. согласование");

    // Instance must NOT be done.
    const projections = await listInstanceProjections(makeFakePool(db), TENANT_ID);
    const proj = projections.find((p) => p.inst === instanceId);
    expect(proj, "TC-1: instance projection must exist").toBeDefined();
    expect(proj!.status, "TC-1: instance must NOT be done after first approve").toBe("waiting");
  });

  // ── TC-2: approve#2 on the second task → engine ends → instance done ───────
  it("TC-2: approve#2 on post-gateway task → engine ends → instance done", async () => {
    const db = new FakeDb();
    const { taskId, instanceId } = await seedStartedTask(db, "flw-branching-2");

    // First approve: engine advances to second task.
    const flowable1 = makeFlowable({
      getFirstActiveUserTask: vi.fn()
        .mockResolvedValueOnce({ ok: true, taskId: "flw-task-initial" })
        .mockResolvedValueOnce({ ok: true, taskId: "flw-task-extra" }),
    });
    await startServer(makeDeps(db, flowable1));
    const r1 = await httpReq("POST", `${base}/api/inbox/${taskId}/action`, { "x-dev-user": APPROVER }, { action: "approve" });
    expect(r1.status).toBe(200);
    await new Promise<void>((r) => server.close(() => r()));

    // Find the second task in the inbox.
    const inboxAfterFirst = await listInstanceInboxTasks(makeFakePool(db), TENANT_ID);
    const extraTask = inboxAfterFirst.find((t) => t.inst === instanceId);
    expect(extraTask).toBeDefined();
    const extraTaskId = extraTask!.id;

    // Second approve: engine ends (no next task, instance ended).
    const flowable2 = makeFlowable({
      getFirstActiveUserTask: vi.fn()
        .mockResolvedValueOnce({ ok: true, taskId: "flw-task-extra" }) // drive the task
        .mockResolvedValueOnce({ ok: true, taskId: null }),             // post-complete: no new task
      isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: true }),
    });
    const h2 = buildServer(makeDeps(db, flowable2));
    server = h2.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h2.baseUrl(); r(); }));

    const r2 = await httpReq("POST", `${base}/api/inbox/${extraTaskId}/action`, { "x-dev-user": APPROVER }, { action: "approve" });
    expect(r2.status).toBe(200);

    // Instance must now be done.
    const projections = await listInstanceProjections(makeFakePool(db), TENANT_ID);
    const proj = projections.find((p) => p.inst === instanceId);
    expect(proj, "TC-2: instance projection must exist").toBeDefined();
    expect(proj!.status, "TC-2: instance must be done after second approve").toBe("done");

    // No more waiting tasks for this instance.
    const inboxAfterSecond = await listInstanceInboxTasks(makeFakePool(db), TENANT_ID);
    const remaining = inboxAfterSecond.filter((t) => t.inst === instanceId);
    expect(remaining).toHaveLength(0);
  });

  // ── TC-3: standard track — approve#1 → engine ends → instance done ─────────
  it("TC-3: amount≤5M (standard) — approve#1 → engine ends → instance done, no extra task", async () => {
    const db = new FakeDb();
    const { taskId, instanceId } = await seedStartedTask(db, "flw-standard-1");

    // Engine: complete user task → no new task (engine ends).
    const flowable = makeFlowable({
      getFirstActiveUserTask: vi.fn()
        .mockResolvedValueOnce({ ok: true, taskId: "flw-task-initial" }) // drive
        .mockResolvedValueOnce({ ok: true, taskId: null }),              // post-complete: none
      isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: true }),
    });

    await startServer(makeDeps(db, flowable));
    const r = await httpReq("POST", `${base}/api/inbox/${taskId}/action`, { "x-dev-user": APPROVER }, { action: "approve" });
    expect(r.status).toBe(200);

    // NO extra task emitted.
    const inboxAfter = await listInstanceInboxTasks(makeFakePool(db), TENANT_ID);
    const extras = inboxAfter.filter((t) => t.inst === instanceId);
    expect(extras, "TC-3: no extra task must appear in inbox").toHaveLength(0);

    // Instance must be done.
    const projections = await listInstanceProjections(makeFakePool(db), TENANT_ID);
    const proj = projections.find((p) => p.inst === instanceId);
    expect(proj!.status, "TC-3: instance must be done after single approve").toBe("done");
  });

  // ── TC-4: regression — no flowableClient → single-step linear works ─────────
  it("TC-4 regression: no flowableClient → approve → done, no extra task", async () => {
    const db = new FakeDb();
    const { taskId, instanceId } = await seedStartedTask(db, "flw-linear-no-engine");

    // No flowableClient in deps.
    await startServer(makeDeps(db, undefined));
    const r = await httpReq("POST", `${base}/api/inbox/${taskId}/action`, { "x-dev-user": APPROVER }, { action: "approve" });
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body["status"]).toBe("done");
    expect(body["instanceId"]).toBe(instanceId);

    // No extra task.
    const inboxAfter = await listInstanceInboxTasks(makeFakePool(db), TENANT_ID);
    expect(inboxAfter.filter((t) => t.inst === instanceId)).toHaveLength(0);

    // Instance done.
    const projections = await listInstanceProjections(makeFakePool(db), TENANT_ID);
    const proj = projections.find((p) => p.inst === instanceId);
    expect(proj!.status).toBe("done");
  });

  // ── TC-5: engine error is non-fatal ─────────────────────────────────────────
  it("TC-5: engine completeUserTask error is non-fatal — approve still returns 200", async () => {
    const db = new FakeDb();
    const { taskId } = await seedStartedTask(db, "flw-engine-error");

    const flowable = makeFlowable({
      getFirstActiveUserTask: vi.fn().mockResolvedValue({ ok: true, taskId: "flw-task-x" }),
      completeUserTask: vi.fn().mockResolvedValue({ ok: false, code: "ENGINE_UNAVAILABLE" as const }),
    });

    await startServer(makeDeps(db, flowable));
    const r = await httpReq("POST", `${base}/api/inbox/${taskId}/action`, { "x-dev-user": APPROVER }, { action: "approve" });
    // Approve must succeed (best-effort engine call, non-fatal).
    expect(r.status).toBe(200);
  });

  // ── TC-6: engine getFirstActiveUserTask fails — approve still returns 200 ───
  it("TC-6: engine getFirstActiveUserTask error is non-fatal — approve still returns 200", async () => {
    const db = new FakeDb();
    const { taskId } = await seedStartedTask(db, "flw-lookup-error");

    const flowable = makeFlowable({
      getFirstActiveUserTask: vi.fn().mockResolvedValue({ ok: false, code: "ENGINE_UNAVAILABLE" as const }),
    });

    await startServer(makeDeps(db, flowable));
    const r = await httpReq("POST", `${base}/api/inbox/${taskId}/action`, { "x-dev-user": APPROVER }, { action: "approve" });
    expect(r.status).toBe(200);
  });

  // ── TC-7: completeUserTask backward-compat (no variables) ───────────────────
  it("TC-7: completeUserTask backward-compat — no variables → still works", async () => {
    const db = new FakeDb();
    const { taskId } = await seedStartedTask(db, "flw-compat");

    // Simulate the existing records.ts caller pattern: call completeUserTask with no vars.
    // Verify the stub receives the call without error (the interface signature accepts optional vars).
    const completeUserTaskSpy = vi.fn().mockResolvedValue({ ok: true } satisfies CompleteUserTaskResult);
    const flowable = makeFlowable({
      getFirstActiveUserTask: vi.fn().mockResolvedValue({ ok: true, taskId: "flw-compat-task" }),
      completeUserTask: completeUserTaskSpy,
      isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: true }),
    });

    await startServer(makeDeps(db, flowable));
    const r = await httpReq("POST", `${base}/api/inbox/${taskId}/action`, { "x-dev-user": APPROVER }, { action: "approve" });
    expect(r.status).toBe(200);

    // completeUserTask was called with 1 arg (taskId only, no variables).
    expect(completeUserTaskSpy).toHaveBeenCalledTimes(1);
    const callArgs = completeUserTaskSpy.mock.calls[0];
    expect(callArgs![0]).toBe("flw-compat-task");
    // No second argument (variables) — backward compatible.
    expect(callArgs![1]).toBeUndefined();
  });
});
