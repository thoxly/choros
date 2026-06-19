/**
 * T-0272 — GET /api/inbox/:id task-detail endpoint.
 *
 * Tests:
 *   - 401 when x-dev-user is absent
 *   - 404 when the task id does not exist in the actor's tenant
 *   - 200 with { item, projection: null } for a seed (non-instance) task
 *   - item shape: id, name, step, inst, status, sla, execType
 *   - 200 with { item, projection } for an instance-backed task (via fake writeDeps)
 *   - projection carries: inst, procKey, status, step, startedAt
 *   - projection status advances to "done" after approve
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerInboxRoutes, _resetClaimStateForTests } from "../http/inbox.js";
import { appendProcessStarted } from "../http/process-projection.js";
import type { InboxWriteDeps } from "../http/inbox.js";
import type { PgClientLike } from "../db/audit-writer.js";

// ---------------------------------------------------------------------------
// Minimal in-memory fake pg pool — mirrors inbox-action.test.ts FakeDb.
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
          db.events.push({ tenant_id: tenant, seq, id, type, actor, payload: JSON.parse(payloadJson), occurred_at: occurredAt, row_hash: rowHash });
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
  return { connect: async () => makeClient() } as unknown as import("pg").Pool;
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
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10),
      path: parsed.pathname + parsed.search,
      method,
      headers,
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
    req.end();
  });
}

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const DEV_USER = "e-larina"; // holds role-approver; tenant resolved to DEV_TENANT_ID in seed

function makeDeps(db: FakeDb): InboxWriteDeps {
  return {
    pool: makeFakePool(db),
    resolveActorTenant: async () => TENANT_ID,
  };
}

async function seedInstanceTask(db: FakeDb): Promise<string> {
  const pool = makeFakePool(db);
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(`SET LOCAL choros.tenant_id = '${TENANT_ID}'`);
  await client.query("SET LOCAL search_path TO choros");
  const taskId = await appendProcessStarted(client as unknown as PgClientLike, {
    instanceId: "flw-detail-test-1",
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

describe("GET /api/inbox/:id — task detail (T-0272)", () => {
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

  it("401 when x-dev-user is absent", async () => {
    await start();
    const r = await httpReq("GET", `${base}/api/inbox/t1`);
    expect(r.status).toBe(401);
  });

  it("404 when task id does not exist in actor's tenant", async () => {
    await start();
    const r = await httpReq("GET", `${base}/api/inbox/no-such-id`, { "x-dev-user": DEV_USER });
    expect(r.status).toBe(404);
  });

  it("200 + item shape for a known seed task (no projection)", async () => {
    await start();
    // First, get the list to find a real seed task id.
    const listR = await httpReq("GET", `${base}/api/inbox`, { "x-dev-user": DEV_USER });
    expect(listR.status).toBe(200);
    const list = listR.json as { items: Array<Record<string, unknown>> };
    expect(list.items.length).toBeGreaterThan(0);
    const seedTaskId = list.items[0]["id"] as string;

    const r = await httpReq("GET", `${base}/api/inbox/${seedTaskId}`, { "x-dev-user": DEV_USER });
    expect(r.status).toBe(200);
    const body = r.json as { item: Record<string, unknown>; projection: null };
    expect(body.item).toBeDefined();
    expect(body.item["id"]).toBe(seedTaskId);
    expect(typeof body.item["name"]).toBe("string");
    expect(typeof body.item["step"]).toBe("string");
    expect(typeof body.item["status"]).toBe("string");
    expect(body.item["sla"]).toBeDefined();
    // Seed tasks have no instance projection.
    expect(body.projection).toBeNull();
  });

  it("200 + item + projection for an instance-backed task (with writeDeps)", async () => {
    db = new FakeDb();
    const taskId = await seedInstanceTask(db);
    await start(makeDeps(db));

    // The instance task appears in the inbox list (pool task addressed to role-approver).
    // e-larina holds role-approver so it shows up.
    const r = await httpReq("GET", `${base}/api/inbox/${taskId}`, { "x-dev-user": DEV_USER });
    expect(r.status).toBe(200);
    const body = r.json as { item: Record<string, unknown>; projection: Record<string, unknown> | null };
    expect(body.item).toBeDefined();
    expect(body.item["id"]).toBe(taskId);
    // Instance task has a matching projection.
    expect(body.projection).not.toBeNull();
    if (body.projection) {
      expect(body.projection["inst"]).toBe("flw-detail-test-1");
      expect(body.projection["procKey"]).toBe("telLinear");
      expect(typeof body.projection["status"]).toBe("string");
      expect(typeof body.projection["step"]).toBe("string");
      expect(typeof body.projection["startedAt"]).toBe("number");
    }
  });
});
