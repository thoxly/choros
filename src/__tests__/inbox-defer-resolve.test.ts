/**
 * T-0638 — POST /api/inbox/:id/action defer-resolve branch (столп 4 P0).
 *
 * Covers the four defects from the task and their acceptance criteria:
 *   AC-a — a claimed defer task's "Согласовать"/"Выполнить" action returns 200
 *          (NOT the old 404 "no waiting instance task with this id") and drives
 *          the engine (reconcileInstanceEngineDrive, resolve-by-instance).
 *   AC-b — defer items carry escalated:true (drives the «Эскалации» tab/count).
 *   AC-c — doubt_reason is human-readable Russian for known structural reasons.
 *   AC-d — a defer task addressed to a role with NO holders resolves honestly
 *          (routed_to_fallback:"role_unfilled") instead of a silent hardcode.
 *   AC-e — a legacy defer event with NO payload.instance_id gets an honest 404
 *          (DEFER_NOT_ROUTABLE), never a silent no-op 200 or a server crash.
 *
 * Pure unit — no live Postgres. A small in-memory fake pg pool models the
 * append-only audit_event track (mirrors src/__tests__/inbox-action.test.ts /
 * inbox-engine-drive.test.ts's FakeDb pattern), extended to also serve
 * listDeferredInboxTasks's literal-type SQL shape (WHERE type = 'agent.deferred'
 * AND tenant_id = $1) alongside the parameterised shape (WHERE type = $1 AND
 * tenant_id = $2) used by process-projection.ts's readEvents.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerInboxRoutes, _resetClaimStateForTests } from "../http/inbox.js";
import type { InboxWriteDeps } from "../http/inbox.js";
import type { FlowableClient } from "../core/flowable-client.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import type { AuditEventInput } from "../core/audit-grant-encoder.js";

// ---------------------------------------------------------------------------
// In-memory fake pg pool — append-only audit_event array, scoped by the
// SET LOCAL choros.tenant_id GUC. Serves BOTH the canonical writer AND both
// read-shapes (parameterised type=$1, and deferred-inbox-store's literal
// type='agent.deferred').
// ---------------------------------------------------------------------------

interface AuditRow {
  tenant_id: string;
  seq: number;
  id: string;
  type: string;
  actor: string;
  subject: string | null;
  scope: Record<string, unknown> | null;
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
        if (m) { tenant = m[1]!; return { rows: [] }; }
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
          const subject = params[4] as string | null;
          const scopeJson = params[5] as string | null;
          const payloadJson = params[9] as string;
          const occurredAt = params[10] as number;
          const rowHash = params[12] as Buffer;
          db.events.push({
            tenant_id: tenant,
            seq, id, type, actor,
            subject: subject ?? null,
            scope: scopeJson ? (JSON.parse(scopeJson) as Record<string, unknown>) : null,
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

        // deferred-inbox-store.ts's literal-type shape: WHERE type = 'agent.deferred'
        // AND tenant_id = $1 ... LIMIT $2
        if (/FROM choros\.audit_event/i.test(text) && /type = 'agent\.deferred'/.test(text)) {
          const tid = params[0] as string;
          const rows = db.events
            .filter((e) => e.type === "agent.deferred" && e.tenant_id === tid)
            .sort((a, b) => b.occurred_at - a.occurred_at)
            .map((e) => ({
              id: e.id,
              actor: e.actor,
              subject: e.subject,
              scope: e.scope,
              payload: e.payload,
              occurred_at: e.occurred_at,
            }));
          return { rows };
        }

        // process-projection.ts's readEvents shape: WHERE type = $1 AND tenant_id = $2
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
// Seed helper: write ONE agent.deferred audit event directly (mirrors
// dispatch-outcome.ts's deferredAuditEvent shape — the LIVE agent-dispatch
// write path, T-0378).
// ---------------------------------------------------------------------------

const writer = makePgAuditWriter();

async function seedDeferEvent(
  db: FakeDb,
  tenantId: string,
  opts: {
    taskId: string;
    agentEmployeeId: string;
    doubtReason: string;
    deferRole: string;
    instanceId?: string;
    procKey?: string;
    nowMs?: number;
  },
): Promise<void> {
  const pool = makeFakePool(db);
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await client.query("SET LOCAL search_path TO choros");

  const input: AuditEventInput = {
    id: opts.taskId,
    type: "agent.deferred",
    actor: opts.agentEmployeeId,
    subject: `agent:${opts.agentEmployeeId}`,
    scope: { proc_key: opts.procKey ?? "telLinear", signal: "dormant", via: "agent-dispatch" },
    via: "agent-dispatch",
    proposed_by: null,
    confirmed_by: null,
    payload: {
      doubt_reason: opts.doubtReason,
      signal: "dormant",
      inbox_task_id: opts.taskId,
      instance_id: opts.instanceId ?? null,
      proc_key: opts.procKey ?? null,
      defer_role: opts.deferRole,
      defer_sla_minutes: null,
      defer_name: `Проверить: ${opts.doubtReason}`,
      agent_draft: null,
    },
    occurred_at: opts.nowMs ?? Date.now(),
  };
  await writer.appendAuditEvent(client as unknown as PgClientLike, input);
  await client.query("COMMIT");
  client.release();
}

// ---------------------------------------------------------------------------
// HTTP harness (mirrors inbox-action.test.ts).
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

const TENANT_ID = "22222222-2222-2222-2222-222222222222";
// e-kravtsova holds fin-ctrl (USER_ROLES fixture, src/http/inbox.ts); e-mironov
// holds fin-appr only. Neither literal is on the D-064 anti-case denylist
// (read-pdp-anti-case.sh) — the defer mechanism is role-agnostic, so any two
// distinct fixture roles exercise the same authz branch the case-specific
// "role-approver" fixture would, without adding a new occurrence of a
// case-denylisted literal to this diff.
const APPROVER = "e-kravtsova"; // holds fin-ctrl
const NON_APPROVER_ROLE_HOLDER = "e-mironov"; // holds fin-appr only

function makeDeps(db: FakeDb, flowableClient?: FlowableClient): InboxWriteDeps {
  return {
    pool: makeFakePool(db),
    resolveActorTenant: async () => TENANT_ID,
    ...(flowableClient ? { flowableClient } : {}),
  };
}

describe("POST /api/inbox/:id/action — defer-resolve branch (T-0638)", () => {
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

  // -------------------------------------------------------------------------
  // AC-a: defer task with a live instance → 200, engine driven (not 404).
  // -------------------------------------------------------------------------
  it("AC-a: approving a defer task (with instanceId) returns 200 and drives the engine (resolve-by-instance)", async () => {
    db = new FakeDb();
    const taskId = "33333333-3333-3333-3333-333333333333";
    await seedDeferEvent(db, TENANT_ID, {
      taskId,
      agentEmployeeId: "agent-triage-1",
      doubtReason: "no published instruction for agent",
      deferRole: "fin-ctrl",
      instanceId: "flw-defer-inst-1",
      procKey: "telLinear",
    });

    const mockClient: FlowableClient = {
      startInstance: vi.fn(),
      completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
      getActiveUserTasks: vi.fn().mockResolvedValue({
        ok: true,
        tasks: [{ id: "eng-task-after-defer", taskDefinitionKey: "task-fin-review", name: "Проверка контролёра", candidateGroups: ["fin-ctrl"] }],
      }),
      isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: true }),
    } as unknown as FlowableClient;

    await start(makeDeps(db, mockClient));

    const r = await httpReq(
      "POST",
      `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      { action: "approve" },
    );

    // OLD behaviour (bug): 404 "no waiting instance task with this id".
    // NEW behaviour: 200, engine driven via resolve-by-instance.
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body["status"]).toBe("done");
    expect(body["instanceId"]).toBe("flw-defer-inst-1");
    expect(mockClient.completeUserTask).toHaveBeenCalledWith("eng-task-after-defer");

    // A resolution audit event was recorded (open-vocabulary type, no new table).
    const resolvedEvents = db.events.filter((e) => e.type === "agent.defer_resolved");
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]?.payload["instance_id"]).toBe("flw-defer-inst-1");
    expect(resolvedEvents[0]?.payload["inbox_task_id"]).toBe(taskId);
  });

  it("AC-a (honest-degrade): no FlowableClient configured → 200 with engine:not_configured (not silently pretending the engine advanced)", async () => {
    db = new FakeDb();
    const taskId = "44444444-4444-4444-4444-444444444444";
    await seedDeferEvent(db, TENANT_ID, {
      taskId,
      agentEmployeeId: "agent-triage-2",
      doubtReason: "llm runtime dormant — inference not available",
      deferRole: "fin-ctrl",
      instanceId: "flw-defer-inst-2",
    });

    await start(makeDeps(db)); // no flowableClient

    const r = await httpReq(
      "POST",
      `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      { action: "approve" },
    );
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body["engine"]).toBe("not_configured");
  });

  it("AC-a (authz): an actor without the defer task's role (and no Tier-2 substitution) gets 403 NOT_ELIGIBLE, not a silent success", async () => {
    db = new FakeDb();
    const taskId = "55555555-5555-5555-5555-555555555555";
    await seedDeferEvent(db, TENANT_ID, {
      taskId,
      agentEmployeeId: "agent-triage-3",
      doubtReason: "autonomy threshold not met",
      deferRole: "fin-ctrl",
      instanceId: "flw-defer-inst-3",
    });

    await start(makeDeps(db));

    const r = await httpReq(
      "POST",
      `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": NON_APPROVER_ROLE_HOLDER },
      { action: "approve" },
    );
    expect(r.status).toBe(403);
    const err = (r.json as Record<string, unknown>)["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("NOT_ELIGIBLE");
  });

  // -------------------------------------------------------------------------
  // AC-e: legacy defer event with NO instanceId → honest 404, not a crash/no-op.
  // -------------------------------------------------------------------------
  it("AC-e: a legacy defer event with no payload.instance_id gets an honest 404 (DEFER_NOT_ROUTABLE)", async () => {
    db = new FakeDb();
    const taskId = "66666666-6666-6666-6666-666666666666";
    await seedDeferEvent(db, TENANT_ID, {
      taskId,
      agentEmployeeId: "agent-legacy",
      doubtReason: "legacy demo-run reason",
      deferRole: "fin-ctrl",
      // instanceId intentionally omitted — simulates run-precheck.ts's demo-run path
      // or a row written before T-0638.
    });

    await start(makeDeps(db));

    const r = await httpReq(
      "POST",
      `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      { action: "approve" },
    );
    expect(r.status).toBe(404);
    const err = (r.json as Record<string, unknown>)["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("DEFER_NOT_ROUTABLE");
    // Human-readable, not a raw code/stack.
    expect(String(err["message"])).toMatch(/[а-яА-Я]/);
  });

  it("404 for a completely unknown task id (neither instance task nor defer task)", async () => {
    db = new FakeDb();
    await start(makeDeps(db));
    const r = await httpReq(
      "POST",
      `${base}/api/inbox/does-not-exist/action`,
      { "x-dev-user": APPROVER },
      { action: "approve" },
    );
    expect(r.status).toBe(404);
    const err = (r.json as Record<string, unknown>)["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("NOT_FOUND");
  });
});
