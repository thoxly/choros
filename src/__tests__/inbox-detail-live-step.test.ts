/**
 * T-0718 [E16/P1, из re-proof T-0709] — GET /api/inbox/:id overlays the LIVE
 * engine step onto the projection so it no longer shows the frozen
 * process.started snapshot (the phantom step beside the item's live step).
 *
 * THE BUG (found live, T-0709 LIVE_PROOF): the inbox detail route returned
 * `projection` straight from listInstanceProjections — the audit snapshot frozen
 * at start, never re-derived as the token advanced. So the drawer showed the
 * item's LIVE step next to a PHANTOM projection.step (the default/next-node
 * snapshot). T-0709's overlay reached the catalog + /api/processes planes but
 * NOT this one.
 *
 * THE FIX: the SAME core resolveLiveNodesByInstance + overlayLiveSteps the other
 * two read surfaces use, applied to the single detail projection — single source
 * of truth, all three planes agree, honest degrade to the snapshot when the
 * engine is unreachable.
 *
 * These tests mirror inbox-detail.test.ts's fake-pg harness and
 * processes-live-instances.test.ts's makeLiveEngineStub pattern (reused shape).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerInboxRoutes, _resetClaimStateForTests } from "../http/inbox.js";
import { appendProcessStarted } from "../http/process-projection.js";
import type { InboxWriteDeps } from "../http/inbox.js";
import type { FlowableClient } from "../core/flowable-client.js";
import type { PgClientLike } from "../db/audit-writer.js";

// ---------------------------------------------------------------------------
// Minimal in-memory fake pg pool — identical to inbox-detail.test.ts.
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
// T-0750: DETAIL is now role-gated (resolveRolesForActor — the SAME
// ACTOR_ACTIVE-hardened resolver LIST uses, T-0738): the querying actor must
// hold the role the task is ADDRESSED TO. seedInstanceTask below passes an
// explicit approverRole ("fin-appr", a showcase-fixture role slug — not one
// of the D-064-banned case literals like "role-approver"/"e-larina"), and
// DEV_USER is the showcase persona already holding it (src/http/inbox.ts
// USER_ROLES) — kept an existing fixture pairing rather than inventing a
// new one. This suite is about the LIVE overlay (T-0718), not authority —
// the role plumbing here exists solely to satisfy the new detail gate.
const DEV_USER = "e-mironov";
const PROC_ACTOR = "e-test-initiator";
const INST_ID = "flw-inbox-live-1";
const PROC_KEY = "telLinear";
const TASK_ROLE = "fin-appr";

// The LIVE active node the engine reports for INST_ID — deliberately DIFFERENT
// from the process.started snapshot's default step ("Согласование", the phantom
// the repro showed). These are the ENGINE-supplied data the overlay reflects,
// NOT hardcoded case-values in platform code.
const LIVE_STEP = "Завершить проверку";
const LIVE_ROLE = "role-checker";

/**
 * FlowableClient stub exposing getActiveUserTasks — the live source the overlay
 * reads (mirrors processes-live-instances.test.ts makeLiveEngineStub).
 * `mode`: "live" → returns the live active task; "error" → engine down for the
 * instance; "empty" → no active user-task; "bare" → no getActiveUserTasks method.
 */
function makeFlowableStub(mode: "live" | "error" | "empty" | "bare"): FlowableClient | undefined {
  if (mode === "bare") return {} as unknown as FlowableClient;
  return {
    getActiveUserTasks: async (inst: string) => {
      if (inst !== INST_ID) return { ok: true as const, tasks: [] };
      if (mode === "error") return { ok: false as const, code: "ENGINE_DOWN" };
      if (mode === "empty") return { ok: true as const, tasks: [] };
      return {
        ok: true as const,
        tasks: [{ id: "et1", taskDefinitionKey: "k-check", name: LIVE_STEP, candidateGroups: [LIVE_ROLE] }],
      };
    },
  } as unknown as FlowableClient;
}

function makeDeps(db: FakeDb, flowableClient?: FlowableClient): InboxWriteDeps {
  return {
    pool: makeFakePool(db),
    resolveActorTenant: async () => TENANT_ID,
    ...(flowableClient ? { flowableClient } : {}),
  };
}

async function seedInstanceTask(db: FakeDb): Promise<string> {
  const pool = makeFakePool(db);
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(`SET LOCAL choros.tenant_id = '${TENANT_ID}'`);
  await client.query("SET LOCAL search_path TO choros");
  // No taskStep supplied → snapshot step defaults to APPROVE_STEP ("Согласование"),
  // exactly the phantom the repro showed.
  const taskId = await appendProcessStarted(client as unknown as PgClientLike, {
    instanceId: INST_ID,
    procKey: PROC_KEY,
    actor: PROC_ACTOR,
    nowMs: Date.now(),
    // T-0750: address the task to TASK_ROLE so DEV_USER (its holder) passes
    // the new DETAIL role-gate. See the DEV_USER comment above.
    approverRole: TASK_ROLE,
  });
  await client.query("COMMIT");
  client.release();
  return taskId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T-0718 · GET /api/inbox/:id overlays the LIVE engine step onto the projection", () => {
  let server: http.Server;
  let base: string;
  let db: FakeDb;

  afterEach(async () => {
    _resetClaimStateForTests();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  async function start(deps: InboxWriteDeps): Promise<void> {
    const h = buildServer(deps);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  }

  it("AC-1/AC-4: projection.step reflects the LIVE active node, not the frozen snapshot", async () => {
    db = new FakeDb();
    const taskId = await seedInstanceTask(db);
    await start(makeDeps(db, makeFlowableStub("live")));

    const r = await httpReq("GET", `${base}/api/inbox/${taskId}`, { "x-dev-user": DEV_USER });
    expect(r.status).toBe(200);
    const body = r.json as { item: Record<string, unknown>; projection: Record<string, unknown> | null };
    expect(body.projection).not.toBeNull();
    // The fix: projection.step is the LIVE engine node, not the process.started snapshot.
    expect(body.projection!["step"]).toBe(LIVE_STEP);
    expect(body.projection!["role"]).toBe(LIVE_ROLE);
    // concurrentSteps (InstanceProjection carries it) is overlaid with the live branch set.
    expect(body.projection!["concurrentSteps"]).toEqual([LIVE_STEP]);
  });

  it("AC-2: projection.step no longer shows the frozen phantom snapshot (repro closed)", async () => {
    db = new FakeDb();
    const taskId = await seedInstanceTask(db);

    // First, prove the phantom WITHOUT the overlay (no live engine): the projection
    // sits on the frozen process.started snapshot default ("Согласование") — the exact
    // phantom the repro showed beside the item's live step.
    await start(makeDeps(db)); // no flowableClient → snapshot path
    const snap = (await httpReq("GET", `${base}/api/inbox/${taskId}`, { "x-dev-user": DEV_USER }))
      .json as { projection: Record<string, unknown> | null };
    const frozenStep = snap.projection!["step"];
    expect(typeof frozenStep).toBe("string");
    expect(frozenStep).not.toBe(LIVE_STEP); // the frozen snapshot is NOT the live node.
    await new Promise<void>((res) => server.close(() => res()));

    // Now WITH the live engine: the same instance's projection.step moves to the LIVE
    // node — the divergence between the frozen phantom and the real active node is closed.
    await start(makeDeps(db, makeFlowableStub("live")));
    const live = (await httpReq("GET", `${base}/api/inbox/${taskId}`, { "x-dev-user": DEV_USER }))
      .json as { projection: Record<string, unknown> | null };
    expect(live.projection!["step"]).toBe(LIVE_STEP);
    expect(live.projection!["step"]).not.toBe(frozenStep); // no longer the phantom.
  });

  it("AC-5: engine down for the instance → projection degrades to the snapshot (never worse, still 200)", async () => {
    db = new FakeDb();
    const taskId = await seedInstanceTask(db);
    await start(makeDeps(db, makeFlowableStub("error")));

    const r = await httpReq("GET", `${base}/api/inbox/${taskId}`, { "x-dev-user": DEV_USER });
    expect(r.status).toBe(200);
    const body = r.json as { item: Record<string, unknown>; projection: Record<string, unknown> | null };
    expect(body.projection).not.toBeNull();
    // Honest degrade: the snapshot step is kept (NOT the live step — engine was down).
    expect(body.projection!["step"]).not.toBe(LIVE_STEP);
    expect(typeof body.projection!["step"]).toBe("string");
  });

  it("AC-5: no active user-task → projection stays on the snapshot", async () => {
    db = new FakeDb();
    const taskId = await seedInstanceTask(db);
    await start(makeDeps(db, makeFlowableStub("empty")));

    const r = await httpReq("GET", `${base}/api/inbox/${taskId}`, { "x-dev-user": DEV_USER });
    expect(r.status).toBe(200);
    const body = r.json as { projection: Record<string, unknown> | null };
    expect(body.projection).not.toBeNull();
    expect(body.projection!["step"]).not.toBe(LIVE_STEP);
  });

  it("AC-5: a bare flowable client (no getActiveUserTasks) leaves the snapshot untouched, no crash", async () => {
    db = new FakeDb();
    const taskId = await seedInstanceTask(db);
    await start(makeDeps(db, makeFlowableStub("bare")));

    const r = await httpReq("GET", `${base}/api/inbox/${taskId}`, { "x-dev-user": DEV_USER });
    expect(r.status).toBe(200);
    const body = r.json as { projection: Record<string, unknown> | null };
    expect(body.projection).not.toBeNull();
    expect(body.projection!["step"]).not.toBe(LIVE_STEP);
  });

  it("AC-5: no flowableClient injected at all → projection is the snapshot (backward-compatible)", async () => {
    db = new FakeDb();
    const taskId = await seedInstanceTask(db);
    await start(makeDeps(db)); // no flowableClient

    const r = await httpReq("GET", `${base}/api/inbox/${taskId}`, { "x-dev-user": DEV_USER });
    expect(r.status).toBe(200);
    const body = r.json as { projection: Record<string, unknown> | null };
    expect(body.projection).not.toBeNull();
    expect(body.projection!["step"]).not.toBe(LIVE_STEP);
  });
});
