/**
 * T-0400 [D7-2] — inbox action: runtime form-submit validation (integration)
 *
 * Tests that POST /api/inbox/:id/action enforces the PD-9 invariant at runtime:
 *   FSI-1  Unknown key → 422 FORM_VALIDATION (not written to JSONB)
 *   FSI-2  Enum mismatch → 422 FORM_VALIDATION
 *   FSI-3  Schema drift (binding field removed from live schema) → 422 FORM_VALIDATION
 *   FSI-4  Valid submit with binding → 200 (safeValues written, not raw values)
 *   FSI-5  Submit without form binding (no form_binding row) → 200 (backward compat)
 *   FSI-6  Proto-pollution keys stripped AND not in binding → 422 unknown_key
 *
 * Architecture: the fake DB must now return form_binding.fields AND
 * registry_def.record_schema rows for the validateAndFilterFormValues path that
 * runs inside the withTenantTx approve handler (before applyStepResult).
 *
 * Extends the fake pool pattern from inbox-form-values.test.ts.
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = "44444444-4444-4444-4444-444444444444";
const APPROVER = "e-larina"; // holds role-approver in USER_ROLES fixture
const INSTANCE_ID = "flw-t0400-test";
const PROC_KEY = "telLinear";
const APPLICATION_ID = "aaaabbbb-0400-0001-0000-000000000001";
const PRIMARY_REGISTRY_ID = "bbbbcccc-0400-0001-0000-000000000002";
const APPROVALS_REGISTRY_ID = "ccccdddd-0400-0001-0000-000000000003";

// ---------------------------------------------------------------------------
// Fake DB
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
  recordInserts: Array<Record<string, unknown>> = [];
  /**
   * Binding fields to return for form_binding query.
   * null → no binding row (backward compat test)
   */
  bindingFields: unknown[] | null = null;
  /**
   * record_schema to return for the approvals registry_def.
   * null → no record_schema (drift check skipped)
   */
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

        // step-applier DB paths
        if (/FROM choros\.process_app_binding/i.test(text)) {
          return { rows: [{ application_id: APPLICATION_ID }] };
        }

        if (/FROM choros\.registry_def/i.test(text)) {
          // Both validateAndFilterFormValues (schema-load) AND resolveApprovalsRegistry
          // (applyStepResult) query registry_def WHERE slug=SOGLASOVANIE_SLUG.
          // Return a row with ALL needed columns so both callers work:
          //   validateAndFilterFormValues needs `record_schema`
          //   resolveApprovalsRegistry needs `id, application_id`
          if (Array.isArray(params) && params.includes(SOGLASOVANIE_SLUG)) {
            return {
              rows: [{
                id: APPROVALS_REGISTRY_ID,
                application_id: APPLICATION_ID,
                record_schema: db.approvalsRecordSchema,
              }],
            };
          }
          // Primary registry (resolver path — no slug filter)
          return { rows: [{ id: PRIMARY_REGISTRY_ID, slug: "purchases", display_name: "Заявки" }] };
        }

        // T-0400: form_binding query for validateAndFilterFormValues
        if (/FROM choros\.form_binding/i.test(text)) {
          if (db.bindingFields !== null) {
            return { rows: [{ fields: db.bindingFields }] };
          }
          return { rows: [] }; // no binding → skip validation (backward compat)
        }

        if (/FROM choros\.cross_app_ref/i.test(text)) {
          return { rows: [] };
        }

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
  return {
    connect: async () => makeClient(),
  } as unknown as import("pg").Pool;
}

function makeOutboxSpy(): { store: OutboxEnqueuePort; enqueued: Array<Record<string, unknown>> } {
  const enqueued: Array<Record<string, unknown>> = [];
  const store: OutboxEnqueuePort = {
    enqueueInTx: async (_client, row) => { enqueued.push(row as Record<string, unknown>); },
  };
  return { store, enqueued };
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

async function seedTask(db: FakeDb): Promise<string> {
  const pool = makeFakePool(db);
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(`SET LOCAL choros.tenant_id = '${TENANT_ID}'`);
  await client.query("SET LOCAL search_path TO choros");
  const taskId = await appendProcessStarted(client as unknown as PgClientLike, {
    instanceId: INSTANCE_ID,
    procKey: PROC_KEY,
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

describe("inbox action — form-submit validation (T-0400 D7-2)", () => {
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

  // -------------------------------------------------------------------------
  // FSI-1: Unknown key → 422
  // -------------------------------------------------------------------------
  it("FSI-1: unknown key in formValues → 422 FORM_VALIDATION (not written to JSONB)", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    // Binding declares only "title"; submitting "ghost" is an unknown key
    db.bindingFields = [
      { key: "title", type: "text", required: false },
    ];
    db.approvalsRecordSchema = {
      type: "object",
      properties: { title: { type: "string" } },
    };
    const { store } = makeOutboxSpy();
    await start({
      pool: makeFakePool(db),
      resolveActorTenant: async () => TENANT_ID,
      outboxStore: store,
    });

    const r = await httpReq(
      "POST", `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      { action: "approve", formValues: { title: "Laptop", ghost: "injected" } },
    );
    expect(r.status).toBe(422);
    const body = r.json as Record<string, unknown>;
    const errEnvelope = body["error"] as Record<string, unknown>;
    expect(errEnvelope["code"]).toBe("FORM_VALIDATION");
    expect(String(errEnvelope["message"])).toMatch(/ghost/);

    // ghost key must NOT appear in any record INSERT
    expect(db.recordInserts.every((row) => !("ghost" in row))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // FSI-2: Enum mismatch → 422
  // -------------------------------------------------------------------------
  it("FSI-2: enum field value not in options → 422 FORM_VALIDATION", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    db.bindingFields = [
      { key: "status", type: "enum", contract: "enum", options: ["open", "closed"], required: false },
    ];
    db.approvalsRecordSchema = {
      type: "object",
      properties: { status: { type: "string" } },
    };
    const { store } = makeOutboxSpy();
    await start({
      pool: makeFakePool(db),
      resolveActorTenant: async () => TENANT_ID,
      outboxStore: store,
    });

    const r = await httpReq(
      "POST", `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      { action: "approve", formValues: { status: "INVALID_OPTION" } },
    );
    expect(r.status).toBe(422);
    const body = r.json as Record<string, unknown>;
    const errEnvelope = body["error"] as Record<string, unknown>;
    expect(errEnvelope["code"]).toBe("FORM_VALIDATION");
    expect(String(errEnvelope["message"])).toMatch(/enum_mismatch/);
  });

  // -------------------------------------------------------------------------
  // FSI-3: Schema drift → 422
  // -------------------------------------------------------------------------
  it("FSI-3: binding field removed from live schema → 422 FORM_VALIDATION (schema drift)", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    // Binding still references "old_field" but the live schema no longer has it
    db.bindingFields = [
      { key: "title", type: "text", required: false },
      { key: "old_field", type: "text", required: false }, // drifted
    ];
    db.approvalsRecordSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        // old_field has been removed from the live schema
      },
    };
    const { store } = makeOutboxSpy();
    await start({
      pool: makeFakePool(db),
      resolveActorTenant: async () => TENANT_ID,
      outboxStore: store,
    });

    const r = await httpReq(
      "POST", `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      { action: "approve", formValues: { title: "Laptop" } },
    );
    expect(r.status).toBe(422);
    const body = r.json as Record<string, unknown>;
    const errEnvelope = body["error"] as Record<string, unknown>;
    expect(errEnvelope["code"]).toBe("FORM_VALIDATION");
    expect(String(errEnvelope["message"])).toMatch(/schema_drift/);
    expect(String(errEnvelope["message"])).toMatch(/old_field/);
  });

  // -------------------------------------------------------------------------
  // FSI-4: Valid submit with binding → 200, safeValues written
  // -------------------------------------------------------------------------
  it("FSI-4: valid submit against binding → 200, only declared fields in record", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    db.bindingFields = [
      { key: "title", type: "text", required: true },
      { key: "amount", type: "number", required: false },
    ];
    db.approvalsRecordSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        amount: { type: "number" },
      },
    };
    const { store } = makeOutboxSpy();
    await start({
      pool: makeFakePool(db),
      resolveActorTenant: async () => TENANT_ID,
      outboxStore: store,
    });

    const r = await httpReq(
      "POST", `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      { action: "approve", formValues: { title: "Notebook", amount: 85000 } },
    );
    expect(r.status).toBe(200);
    // Record must contain the valid fields
    expect(db.recordInserts.length).toBeGreaterThanOrEqual(1);
    const record = db.recordInserts[0];
    expect(record["title"]).toBe("Notebook");
    expect(record["amount"]).toBe(85000);
    // Provenance fields also present
    expect(record["approved_by"]).toBe(APPROVER);
  });

  // -------------------------------------------------------------------------
  // FSI-5: No form binding → 200, all values pass through (backward compat)
  // -------------------------------------------------------------------------
  it("FSI-5: no form_binding row → 200 (backward compat, all values pass through)", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    // db.bindingFields remains null → no validation
    const { store } = makeOutboxSpy();
    await start({
      pool: makeFakePool(db),
      resolveActorTenant: async () => TENANT_ID,
      outboxStore: store,
    });

    const r = await httpReq(
      "POST", `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      { action: "approve", formValues: { anyKey: "anyValue", anotherKey: 42 } },
    );
    expect(r.status).toBe(200);
    expect(db.recordInserts.length).toBeGreaterThanOrEqual(1);
    const record = db.recordInserts[0];
    // Without binding, all values pass through
    expect(record["anyKey"]).toBe("anyValue");
    expect(record["anotherKey"]).toBe(42);
  });

  // -------------------------------------------------------------------------
  // FSI-6: Proto-pollution keys stripped + rejected as unknown
  // -------------------------------------------------------------------------
  it("FSI-6: __proto__ key stripped before validation; not written to JSONB", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    db.bindingFields = [
      { key: "title", type: "text", required: false },
    ];
    db.approvalsRecordSchema = {
      type: "object",
      properties: { title: { type: "string" } },
    };
    const { store } = makeOutboxSpy();
    await start({
      pool: makeFakePool(db),
      resolveActorTenant: async () => TENANT_ID,
      outboxStore: store,
    });

    const formValues: Record<string, unknown> = { title: "Laptop" };
    formValues["__proto__"] = { polluted: true };
    formValues["constructor"] = "evil";

    const r = await httpReq(
      "POST", `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      { action: "approve", formValues },
    );
    // title is valid; proto keys are stripped → no violations → 200
    expect(r.status).toBe(200);
    // Ensure proto keys didn't land in the record (use hasOwnProperty — 'constructor' is
    // inherited from Object.prototype and 'in' would incorrectly match it)
    expect(
      db.recordInserts.every(
        (row) =>
          !Object.prototype.hasOwnProperty.call(row, "__proto__") &&
          !Object.prototype.hasOwnProperty.call(row, "constructor"),
      ),
    ).toBe(true);
  });
});
