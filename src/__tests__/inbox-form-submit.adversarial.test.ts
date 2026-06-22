/**
 * T-0417 · ADVERSARY (Враг red-team) — inbox form-submit INTEGRATION suite.
 *
 * Surface under attack: T-0400 [D7-2] + T-0396 — the POST /api/inbox/:id/action
 * approve handler in src/http/inbox.ts, end-to-end through validateAndFilterFormValues
 * (src/db/step-applier.ts) into the JSONB record.
 *
 * The existing inbox-form-submit-validation.test.ts (FSI-1..6) covers unknown-key,
 * enum, drift, backward-compat and a basic __proto__ strip. THIS suite attacks the
 * provenance-forgery and fail-open-boundary vectors:
 *
 *   AFS-1  client-supplied `approved_by` in formValues cannot override the actor
 *          (server is the provenance source) AND is rejected as an unknown key.
 *   AFS-2  client-supplied `decision` cannot forge the outcome verdict.
 *   AFS-3  client-supplied `comment` in formValues never overrides the canonical
 *          server comment.
 *   AFS-4  with a binding present, NO unknown key (incl. provenance) slips into
 *          the JSONB record — the only path that writes arbitrary keys is the
 *          no-binding backward-compat path (FSI-5), which is by design.
 *   AFS-5  __proto__/constructor/prototype submitted alongside a forged provenance
 *          key: proto stripped, provenance rejected → 422, ZERO record written.
 *
 * Reuses the fake-DB harness shape from inbox-form-submit-validation.test.ts.
 * Pure integration (in-process http + fake pg). Runnable NOW.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerInboxRoutes, _resetClaimStateForTests } from "../http/inbox.js";
import { appendProcessStarted } from "../http/process-projection.js";
import type { InboxWriteDeps } from "../http/inbox.js";
import type { PgClientLike } from "../db/audit-writer.js";
import type { OutboxEnqueuePort } from "../db/step-applier.js";
import { SOGLASOVANIE_SLUG } from "../db/step-applier.js";

const TENANT_ID = "44444444-4444-4444-4444-444444444444";
const APPROVER = "e-larina"; // holds role-approver in USER_ROLES fixture
const INSTANCE_ID = "flw-t0417-adv";
const PROC_KEY = "telLinear";
const APPLICATION_ID = "aaaabbbb-0417-0001-0000-000000000001";
const PRIMARY_REGISTRY_ID = "bbbbcccc-0417-0001-0000-000000000002";
const APPROVALS_REGISTRY_ID = "ccccdddd-0417-0001-0000-000000000003";

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
  recordInserts: Array<Record<string, unknown>> = [];
  bindingFields: unknown[] | null = null;
  approvalsRecordSchema: unknown = null;
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
          if (!db.heads.has(tenant)) db.heads.set(tenant, { seq: Number(params[0]), row_hash: params[1] as Buffer });
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
        if (/FROM choros\.audit_event/i.test(text)) {
          const type = params[0] as string;
          const tid = params[1] as string;
          const thirdParam = params[2];
          const instFilter = typeof thirdParam === "string" ? thirdParam : undefined;
          let filtered = db.events.filter((e) => e.type === type && e.tenant_id === tid);
          if (instFilter !== undefined) {
            filtered = filtered.filter((e) => (e.payload["inst"] as string | undefined) === instFilter);
          }
          const rows = filtered
            .sort((a, b) => a.occurred_at - b.occurred_at)
            .map((e) => ({ id: e.id, actor: e.actor, payload: e.payload, occurred_at: e.occurred_at }));
          return { rows };
        }
        if (/FROM choros\.process_app_binding/i.test(text)) {
          return { rows: [{ application_id: APPLICATION_ID }] };
        }
        if (/FROM choros\.registry_def/i.test(text)) {
          if (Array.isArray(params) && params.includes(SOGLASOVANIE_SLUG)) {
            return { rows: [{ id: APPROVALS_REGISTRY_ID, application_id: APPLICATION_ID, record_schema: db.approvalsRecordSchema }] };
          }
          return { rows: [{ id: PRIMARY_REGISTRY_ID, slug: "purchases", display_name: "Заявки" }] };
        }
        if (/FROM choros\.form_binding/i.test(text)) {
          if (db.bindingFields !== null) return { rows: [{ fields: db.bindingFields }] };
          return { rows: [] };
        }
        if (/FROM choros\.cross_app_ref/i.test(text)) return { rows: [] };
        if (/INSERT INTO choros\.record/i.test(text)) {
          const dataJson = params[3] as string | undefined;
          if (dataJson) {
            try { db.recordInserts.push(JSON.parse(dataJson) as Record<string, unknown>); }
            catch { /* ignore */ }
          }
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    return client as unknown as import("pg").PoolClient;
  }
  return { connect: async () => makeClient() } as unknown as import("pg").Pool;
}

function makeOutboxSpy(): { store: OutboxEnqueuePort } {
  const store: OutboxEnqueuePort = { enqueueInTx: async () => {} };
  return { store };
}

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
  method: string, url: string, headers: Record<string, string> = {}, body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname, port: parseInt(parsed.port, 10),
      path: parsed.pathname + parsed.search, method,
      headers: { ...headers, ...(buf ? { "Content-Type": "application/json", "Content-Length": String(buf.length) } : {}) },
    }, (res) => {
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

async function seedTask(db: FakeDb): Promise<string> {
  const pool = makeFakePool(db);
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(`SET LOCAL choros.tenant_id = '${TENANT_ID}'`);
  await client.query("SET LOCAL search_path TO choros");
  const taskId = await appendProcessStarted(client as unknown as PgClientLike, {
    instanceId: INSTANCE_ID, procKey: PROC_KEY, actor: "e-orlov", nowMs: Date.now(),
  });
  await client.query("COMMIT");
  client.release();
  return taskId;
}

describe("Враг · inbox approve — provenance forgery & fail-open boundary", () => {
  let server: http.Server;
  let base: string;

  async function start(deps?: InboxWriteDeps): Promise<void> {
    const h = buildServer(deps);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  }

  afterEach(async () => {
    _resetClaimStateForTests();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  function seedBinding(db: FakeDb): void {
    db.bindingFields = [
      { key: "title", type: "text", required: false },
      { key: "amount", type: "number", required: false },
    ];
    db.approvalsRecordSchema = {
      type: "object",
      properties: { title: { type: "string" }, amount: { type: "number" } },
    };
  }

  // AFS-1 ----------------------------------------------------------------------
  it("AFS-1: client formValues.approved_by is rejected as unknown_key (cannot forge approver)", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    seedBinding(db);
    await start({ pool: makeFakePool(db), resolveActorTenant: async () => TENANT_ID, outboxStore: makeOutboxSpy().store });

    const r = await httpReq("POST", `${base}/api/inbox/${taskId}/action`, { "x-dev-user": APPROVER }, {
      action: "approve",
      formValues: { title: "ok", approved_by: "e-ceo-forged" },
    });
    // approved_by is not a binding field → unknown_key → 422; nothing written.
    expect(r.status).toBe(422);
    expect((r.json as { error: { code: string } }).error.code).toBe("FORM_VALIDATION");
    expect(db.recordInserts.length).toBe(0);
  });

  // AFS-2 ----------------------------------------------------------------------
  it("AFS-2: client formValues.decision cannot forge the outcome verdict (unknown_key, no write)", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    seedBinding(db);
    await start({ pool: makeFakePool(db), resolveActorTenant: async () => TENANT_ID, outboxStore: makeOutboxSpy().store });

    const r = await httpReq("POST", `${base}/api/inbox/${taskId}/action`, { "x-dev-user": APPROVER }, {
      action: "approve",
      formValues: { title: "ok", decision: "Отклонить-forged" },
    });
    expect(r.status).toBe(422);
    expect(db.recordInserts.length).toBe(0);
  });

  // AFS-3 ----------------------------------------------------------------------
  it("AFS-3: with NO binding, server provenance still WINS over client formValues (approved_by==actor)", async () => {
    // The no-binding path is the fail-open backward-compat path: arbitrary keys
    // pass through. But the SERVER still appends decision/approved_by/comment AFTER
    // the spread, so a client-supplied approved_by is overwritten by the actor.
    const db = new FakeDb();
    const taskId = await seedTask(db);
    // db.bindingFields stays null → fail-open path.
    await start({ pool: makeFakePool(db), resolveActorTenant: async () => TENANT_ID, outboxStore: makeOutboxSpy().store });

    const r = await httpReq("POST", `${base}/api/inbox/${taskId}/action`, { "x-dev-user": APPROVER }, {
      action: "approve",
      formValues: { approved_by: "e-ceo-forged", decision: "forged-verdict", comment: "forged-comment" },
    });
    expect(r.status).toBe(200);
    expect(db.recordInserts.length).toBeGreaterThanOrEqual(1);
    const record = db.recordInserts[0];
    // Provenance is server-owned: actor wins, not the forged client value.
    expect(record["approved_by"]).toBe(APPROVER);
    expect(record["approved_by"]).not.toBe("e-ceo-forged");
    // decision is the server outcomeName (NOT the forged verdict).
    expect(record["decision"]).not.toBe("forged-verdict");
  });

  // AFS-4 ----------------------------------------------------------------------
  it("AFS-4: with a binding, only declared keys land in JSONB — every extra key is dropped", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    seedBinding(db);
    await start({ pool: makeFakePool(db), resolveActorTenant: async () => TENANT_ID, outboxStore: makeOutboxSpy().store });

    // Valid-only submit commits; record carries exactly title/amount + server provenance.
    const r = await httpReq("POST", `${base}/api/inbox/${taskId}/action`, { "x-dev-user": APPROVER }, {
      action: "approve",
      formValues: { title: "Laptop", amount: 90000 },
    });
    expect(r.status).toBe(200);
    const record = db.recordInserts[0];
    expect(record["title"]).toBe("Laptop");
    expect(record["amount"]).toBe(90000);
    expect(record["approved_by"]).toBe(APPROVER);
    // No stray attacker keys — the record's own keys are a known closed set.
    const allowed = new Set(["title", "amount", "decision", "approved_by", "comment"]);
    for (const k of Object.keys(record)) {
      expect(allowed.has(k)).toBe(true);
    }
  });

  // AFS-5 ----------------------------------------------------------------------
  it("AFS-5: proto keys + forged provenance together → 422, ZERO record, no pollution", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    seedBinding(db);
    await start({ pool: makeFakePool(db), resolveActorTenant: async () => TENANT_ID, outboxStore: makeOutboxSpy().store });

    // Build a payload with own __proto__ + constructor + a forged provenance field.
    const formValues: Record<string, unknown> = { title: "ok", approved_by: "e-forged" };
    formValues["__proto__"] = { polluted: true };
    formValues["constructor"] = "evil";

    const before = ({} as Record<string, unknown>)["polluted"];
    const r = await httpReq("POST", `${base}/api/inbox/${taskId}/action`, { "x-dev-user": APPROVER }, {
      action: "approve",
      formValues,
    });
    // approved_by is unknown → 422. Proto keys were stripped (not violations) but
    // the unknown provenance key fails the submit → nothing written.
    expect(r.status).toBe(422);
    expect(db.recordInserts.length).toBe(0);
    // No global prototype pollution.
    expect(({} as Record<string, unknown>)["polluted"]).toBe(before);
  });
});
