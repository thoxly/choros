/**
 * T-0282 · card-action approve route unit tests (ADR T-0278 §2.3 / §D, AC-5).
 *
 * Pure unit — no live Postgres. A small in-memory fake pg pool models the
 * append-only audit_event track the projection reads/writes: it serves the
 * process.started / task.approved SELECTs and accepts the canonical writer's
 * INSERT/UPDATE/SELECT-FOR-UPDATE sequence (appendAuditEvent). This lets the route
 * be exercised end-to-end (grant-deny, append, projection advance) without a DB;
 * the full RLS round-trip is in ci/checks/db/process-projection.test.ts.
 *
 * Covers:
 *   - 404 when the action route is not wired (no writeDeps)
 *   - 401 UNAUTHENTICATED when x-dev-user is absent
 *   - 400 VALIDATION when body is not an object / action ≠ "approve"
 *   - 404 NOT_FOUND when there is no waiting instance task with the id
 *   - 403 NOT_ELIGIBLE when the actor does not hold the task's role (approve grant)
 *   - 200 + status:done when the approver (holds role-approver) approves a waiting task
 *   - after approve, the projection advances (the waiting task drops)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerInboxRoutes, _resetClaimStateForTests } from "../http/inbox.js";
import {
  appendProcessStarted,
  listInstanceInboxTasks,
} from "../http/process-projection.js";
import type { InboxWriteDeps } from "../http/inbox.js";
import type { PgClientLike } from "../db/audit-writer.js";

// ---------------------------------------------------------------------------
// In-memory fake pg pool — models choros.audit_event as an append-only array,
// scoped by the SET LOCAL choros.tenant_id GUC. Serves the writer + projection.
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

        // SET LOCAL choros.tenant_id = '<uuid>'
        const m = /SET LOCAL choros\.tenant_id = '([^']+)'/.exec(text);
        if (m) {
          tenant = m[1];
          return { rows: [] };
        }
        if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
        if (/SET LOCAL search_path/i.test(text)) return { rows: [] };

        // writer: current_setting('choros.tenant_id')
        if (/current_setting\('choros\.tenant_id', false\)::uuid AS tenant_id/.test(text)) {
          return { rows: [{ tenant_id: tenant }] };
        }
        // writer: INSERT audit_head ... ON CONFLICT DO NOTHING (seed head)
        if (/INSERT INTO choros\.audit_head/i.test(text)) {
          if (!db.heads.has(tenant)) {
            db.heads.set(tenant, { seq: Number(params[0]), row_hash: params[1] as Buffer });
          }
          return { rows: [] };
        }
        // writer: SELECT seq, row_hash ... FOR UPDATE
        if (/FROM choros\.audit_head/i.test(text) && /FOR UPDATE/i.test(text)) {
          const head = db.heads.get(tenant) ?? { seq: 0, row_hash: Buffer.alloc(32) };
          return { rows: [{ seq: head.seq, row_hash: head.row_hash, vocab_version: 1 }] };
        }
        // writer: INSERT audit_event. Param order (audit-writer.ts):
        // [seq, id, type, actor, subject, scope, via, proposed_by, confirmed_by,
        //  payload, occurred_at, prev_hash, row_hash, vocab_version]
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
        // writer: UPDATE audit_head advance
        if (/UPDATE choros\.audit_head/i.test(text)) {
          db.heads.set(tenant, { seq: Number(params[0]), row_hash: params[1] as Buffer });
          return { rows: [] };
        }
        // projection: SELECT ... FROM choros.audit_event WHERE type = $1 AND tenant_id = $2
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

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
// e-larina holds role-approver (USER_ROLES fixture); e-kravtsova holds only fin-ctrl.
const APPROVER = "e-larina";
const NON_APPROVER = "e-kravtsova";

function makeDeps(db: FakeDb): InboxWriteDeps {
  return {
    pool: makeFakePool(db),
    resolveActorTenant: async () => TENANT_ID,
  };
}

/** Seed one waiting telLinear instance task in the fake db; returns its task id. */
async function seedStartedTask(db: FakeDb): Promise<string> {
  const pool = makeFakePool(db);
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(`SET LOCAL choros.tenant_id = '${TENANT_ID}'`);
  await client.query("SET LOCAL search_path TO choros");
  const taskId = await appendProcessStarted(client as unknown as PgClientLike, {
    instanceId: "flw-unit-1",
    procKey: "telLinear",
    actor: "e-orlov",
    nowMs: Date.now(),
  });
  await client.query("COMMIT");
  client.release();
  return taskId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("inbox approve action (T-0282)", () => {
  let server: http.Server;
  let base: string;
  let db: FakeDb;

  afterEach(async () => {
    _resetClaimStateForTests();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  async function start(deps?: InboxWriteDeps): Promise<void> {
    const h = buildServer(deps);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  }

  it("404 when the action route is not wired (no writeDeps)", async () => {
    await start(undefined);
    const r = await httpReq("POST", `${base}/api/inbox/x/action`, { "x-dev-user": APPROVER }, { action: "approve" });
    expect(r.status).toBe(404);
  });

  it("401 when x-dev-user is absent", async () => {
    db = new FakeDb();
    await start(makeDeps(db));
    const r = await httpReq("POST", `${base}/api/inbox/x/action`, {}, { action: "approve" });
    expect(r.status).toBe(401);
  });

  it("400 when action ≠ approve", async () => {
    db = new FakeDb();
    await start(makeDeps(db));
    const r = await httpReq("POST", `${base}/api/inbox/x/action`, { "x-dev-user": APPROVER }, { action: "reject" });
    expect(r.status).toBe(400);
  });

  it("400 when body is not an object", async () => {
    db = new FakeDb();
    await start(makeDeps(db));
    const r = await httpReq("POST", `${base}/api/inbox/x/action`, { "x-dev-user": APPROVER }, ["approve"]);
    expect(r.status).toBe(400);
  });

  it("404 NOT_FOUND when there is no waiting instance task with the id", async () => {
    db = new FakeDb();
    await start(makeDeps(db));
    const r = await httpReq("POST", `${base}/api/inbox/missing/action`, { "x-dev-user": APPROVER }, { action: "approve" });
    expect(r.status).toBe(404);
  });

  it("403 NOT_ELIGIBLE when the actor does not hold the task's role (approve grant)", async () => {
    db = new FakeDb();
    const taskId = await seedStartedTask(db);
    await start(makeDeps(db));
    const r = await httpReq("POST", `${base}/api/inbox/${taskId}/action`, { "x-dev-user": NON_APPROVER }, { action: "approve" });
    expect(r.status).toBe(403);
    const err = (r.json as Record<string, unknown>)["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("NOT_ELIGIBLE");
  });

  it("200 + status:done when the approver approves; the waiting task then drops", async () => {
    db = new FakeDb();
    const taskId = await seedStartedTask(db);
    await start(makeDeps(db));

    const r = await httpReq("POST", `${base}/api/inbox/${taskId}/action`, { "x-dev-user": APPROVER }, { action: "approve" });
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body["status"]).toBe("done");
    expect(body["instanceId"]).toBe("flw-unit-1");
    expect(body["action"]).toBe("approve");

    // Projection advanced: the waiting approval task is gone.
    const tasks = await listInstanceInboxTasks(makeFakePool(db), TENANT_ID);
    expect(tasks.find((t) => t.id === taskId)).toBeUndefined();
  });

  // T-0688 (stale-drawer, capstone T-0647 minor finding #1): a task can stop
  // being "waiting" between the moment the detail drawer loaded it and the
  // moment the human clicks «Выполнить шаг» — most commonly the T-0522
  // engine-drive reconcile-on-read net (every GET /api/inbox self-heals a
  // missed post-approve drive), or a duplicate click/second tab. Before this
  // fix, findWaitingInstanceTask returning null in EITHER case (genuinely
  // unknown taskId OR already-completed taskId) fell straight through to the
  // same generic 404 NOT_FOUND — which the client renders as "Эта задача уже
  // недоступна", even though the step in fact completed successfully. The
  // fix checks the projection track for a `done` row correlated to this exact
  // taskId before giving up; a match returns the ordinary 200 success shape
  // (idempotent), not an error.
  it("200 + status:done (idempotent) when the task was ALREADY approved by the time this action runs", async () => {
    db = new FakeDb();
    const taskId = await seedStartedTask(db);
    await start(makeDeps(db));

    // First approve — genuinely completes the step.
    const first = await httpReq("POST", `${base}/api/inbox/${taskId}/action`, { "x-dev-user": APPROVER }, { action: "approve" });
    expect(first.status).toBe(200);

    // Second approve on the SAME taskId — findWaitingInstanceTask now returns
    // null (the task is no longer waiting), but the projection shows it done.
    // Must be an honest 200 success echo, NOT the generic 404 "уже недоступна".
    const second = await httpReq("POST", `${base}/api/inbox/${taskId}/action`, { "x-dev-user": APPROVER }, { action: "approve" });
    expect(second.status).toBe(200);
    const body = second.json as Record<string, unknown>;
    expect(body["status"]).toBe("done");
    expect(body["instanceId"]).toBe("flw-unit-1");
    expect(body["action"]).toBe("approve");
    expect(body["engine"]).toBe("already");
  });

  it("404 NOT_FOUND (genuine) for a taskId that was never a real task at all — the already-done check must not mask this", async () => {
    db = new FakeDb();
    await seedStartedTask(db); // seeds an unrelated task — proves no accidental cross-match
    await start(makeDeps(db));
    const r = await httpReq("POST", `${base}/api/inbox/totally-unknown-id/action`, { "x-dev-user": APPROVER }, { action: "approve" });
    expect(r.status).toBe(404);
    const err = (r.json as Record<string, unknown>)["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// Start-emission seam (B↔D): appendProcessStarted writes a process.started event.
// ---------------------------------------------------------------------------

describe("start-emission seam — appendProcessStarted (T-0282 §2.3)", () => {
  let db: FakeDb;
  beforeEach(() => { db = new FakeDb(); });

  it("writes ONE process.started audit_event carrying the instance + waiting user-task", async () => {
    const taskId = await seedStartedTask(db);
    const started = db.events.filter((e) => e.type === "process.started");
    expect(started.length).toBe(1);
    expect(started[0].id).toBe(taskId);
    expect(started[0].payload["inst"]).toBe("flw-unit-1");
    expect(started[0].payload["proc_key"]).toBe("telLinear");
    expect(started[0].payload["task_role"]).toBe("role-approver");
  });
});
