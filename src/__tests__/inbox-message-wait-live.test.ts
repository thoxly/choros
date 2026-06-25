/**
 * src/__tests__/inbox-message-wait-live.test.ts — T-0459 [D8-R4].
 *
 * LIVE-READ wiring proof: a process instance PARKED ON A MESSAGE-CATCH surfaces as a
 * WAITING inbox row («Ожидает сообщения» + the awaited messageName) through the
 * actual GET /api/inbox handler — NOT just the pure surfaceMessageCatchWaits unit
 * (which message-waiting-projection.test.ts already covers).
 *
 * This is the read-side analogue of the T-0458 timer reconcile wiring: the GET
 * handler, when a FlowableClient + DB are present, asks the engine which waiting
 * instances carry a parked message/signal event-subscription (getMessageCatchWaits)
 * and surfaces each as a waiting row in THIS response. Honest-degrade: an engine
 * failure must NOT break the 200.
 *
 * Harness: the in-memory FakeAuditDb from inbox-engine-drive.test.ts, injected as the
 * org pool via a vi.mock of ../db/org.js (importActual preserves every other export so
 * the surrounding DAOs are untouched). DATABASE_URL is set so the handler's hasDb()
 * branch fires. The route is driven over real HTTP, exactly like a live read.
 */

import * as http from "node:http";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory fake audit DB (mirrors inbox-engine-drive.test.ts harness).
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

const FAKE_DB = new FakeAuditDb();

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
          db.events.push({
            tenant_id: tenant,
            seq: params[0] as number,
            id: params[1] as string,
            type: params[2] as string,
            actor: params[3] as string,
            payload: JSON.parse(params[9] as string),
            occurred_at: params[10] as number,
            row_hash: params[12] as Buffer,
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
  return { connect: async () => makeClient() } as unknown as import("pg").Pool;
}

const TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const INST = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ACTOR = "e-larina"; // any actor; the message-wait row is role-addressed (pool).
const MESSAGE_NAME = "contract-signed";

// ---------------------------------------------------------------------------
// Mock ../db/org.js: inject the fake pool as the org pool + a fixed tenant
// resolver. importActual preserves every other export untouched.
// ---------------------------------------------------------------------------
vi.mock("../db/org.js", async () => {
  const actual = await vi.importActual<typeof import("../db/org.js")>("../db/org.js");
  return {
    ...actual,
    getOrgPool: () => makeFakePool(FAKE_DB),
    resolveActorTenant: async () => TENANT,
  };
});

// Import AFTER the mock is declared (hoisted by vitest, but keep order explicit).
import { registerInboxRoutes, _resetClaimStateForTests, type InboxWriteDeps } from "../http/inbox.js";
import { Router } from "../http/router.js";
import { appendProcessStarted } from "../http/process-projection.js";
import type { PgClientLike } from "../db/audit-writer.js";
import type { FlowableClient } from "../core/flowable-client.js";

// ---------------------------------------------------------------------------
// A FlowableClient whose getMessageCatchWaits reports the parked catch. All
// other methods are inert stubs (not exercised by the GET read path).
// ---------------------------------------------------------------------------
function engineWithParkedCatch(
  waits: { messageName: string; eventType: string }[],
  opts?: { failWaits?: boolean },
): FlowableClient {
  const inert = async () => ({ ok: true as const });
  return {
    deployBpmn: async () => ({ ok: true, deploymentId: "d" }),
    startInstance: async () => ({ ok: true, instanceId: "i" }),
    fetchAndLock: async () => ({ ok: true, tasks: [] }),
    completeTask: inert,
    failTask: inert,
    getFirstActiveUserTask: async () => ({ ok: true, taskId: null }),
    completeUserTask: inert,
    // No active user-tasks: the instance is parked on a message-catch, not a userTask.
    getActiveUserTasks: async () => ({ ok: true, tasks: [] }),
    getMessageCatchWaits: async () =>
      opts?.failWaits
        ? ({ ok: false, code: "ENGINE_UNAVAILABLE" } as const)
        : ({ ok: true, waits } as const),
    isInstanceEnded: async () => ({ ok: true, ended: false }),
    pingEngine: async () => ({ ok: true, reachable: true }),
  } as unknown as FlowableClient;
}

function makeDeps(flowableClient: FlowableClient): InboxWriteDeps {
  return {
    pool: makeFakePool(FAKE_DB),
    resolveActorTenant: async () => TENANT,
    flowableClient,
  };
}

async function seedStartedInstance(): Promise<void> {
  const pool = makeFakePool(FAKE_DB);
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
  await appendProcessStarted(client as unknown as PgClientLike, {
    instanceId: INST,
    procKey: "telLinear",
    actor: ACTOR,
    nowMs: 1000,
    tenantId: TENANT,
  });
  await client.query("COMMIT");
  client.release();
}

function httpGet(
  url: string,
  actor: string,
  path: string,
): Promise<{ status: number; json: { items: Array<Record<string, unknown>> } }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url + path);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parseInt(parsed.port, 10),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: { "x-dev-user": actor },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => { data += c.toString(); });
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, json: { items: [] } }); }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function startServer(deps: InboxWriteDeps): Promise<{ server: http.Server; base: string }> {
  const router = new Router();
  registerInboxRoutes(router, undefined, deps);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${addr.port}` };
}

describe("T-0459 [D8-R4] — GET /api/inbox surfaces a parked message-catch as a WAITING row (live read)", () => {
  let server: http.Server | undefined;

  beforeEach(() => {
    FAKE_DB.events = [];
    FAKE_DB.heads.clear();
    vi.stubEnv("DATABASE_URL", "postgres://fake/test"); // hasDb() === true
  });

  afterEach(async () => {
    _resetClaimStateForTests();
    vi.unstubAllEnvs();
    if (server) { await new Promise<void>((r) => server!.close(() => r())); server = undefined; }
  });

  it("a parked message-catch surfaces as «Ожидает сообщения» with the awaited messageName via GET /api/inbox", async () => {
    await seedStartedInstance();
    const engine = engineWithParkedCatch([{ messageName: MESSAGE_NAME, eventType: "message" }]);
    const started = await startServer(makeDeps(engine));
    server = started.server;

    const res = await httpGet(started.base, ACTOR, "/api/inbox?tab=all");
    expect(res.status).toBe(200);

    // The wiring fired on the live read: a message-catch waiting row is now present.
    const waitRow = res.json.items.find((i) => i["messageCatch"] === true);
    expect(waitRow).toBeDefined();
    expect(waitRow?.["messageName"]).toBe(MESSAGE_NAME);
    expect(waitRow?.["name"]).toBe("Ожидает сообщения");
    expect(waitRow?.["status"]).toBe("waiting");
    expect(waitRow?.["inst"]).toBe(INST);
  });

  it("idempotent: a second GET does NOT duplicate the message-catch waiting row", async () => {
    await seedStartedInstance();
    const engine = engineWithParkedCatch([{ messageName: MESSAGE_NAME, eventType: "message" }]);
    const started = await startServer(makeDeps(engine));
    server = started.server;

    await httpGet(started.base, ACTOR, "/api/inbox?tab=all");
    const res2 = await httpGet(started.base, ACTOR, "/api/inbox?tab=all");
    expect(res2.status).toBe(200);

    const waits = res2.json.items.filter((i) => i["messageCatch"] === true);
    expect(waits).toHaveLength(1); // dedup by inst+messageName held across reads.
  });

  it("honest-degrade: an engine failure on getMessageCatchWaits still returns 200", async () => {
    await seedStartedInstance();
    const engine = engineWithParkedCatch([], { failWaits: true });
    const started = await startServer(makeDeps(engine));
    server = started.server;

    const res = await httpGet(started.base, ACTOR, "/api/inbox?tab=all");
    expect(res.status).toBe(200);
    // No catch surfaced (engine could not report), but the read never failed.
    const waits = res.json.items.filter((i) => i["messageCatch"] === true);
    expect(waits).toHaveLength(0);
  });
});
