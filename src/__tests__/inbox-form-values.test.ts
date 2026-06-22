/**
 * T-0396 — inbox action formValues persistence tests
 *
 * Verifies that human-filled form values submitted in the POST /api/inbox/:id/action
 * body (as `formValues`) are forwarded into applyStepResult's formData and written
 * into the «Согласование» step-result entity record.
 *
 * Tests:
 *   FV-1  formValues present → keys appear in the step_applied outbox variables payload
 *   FV-2  formValues present → keys appear in the record INSERT data JSON
 *   FV-3  action without formValues still succeeds (backward compat)
 *   FV-4  formValues cannot override canonical provenance fields (decision, approved_by)
 *   FV-5  formValues=null is treated as empty (graceful degradation, not a 400)
 *   FV-6  formValues=[] (array) is treated as empty (plain-object guard)
 *   FV-7  formValues with nested/mixed values are forwarded verbatim
 *   FV-8  body.comment (canonical) overrides any comment key in formValues
 *   FV-9  formValues.comment is evicted when body.comment is absent (canonical path wins)
 *   FV-10 prototype-pollution sentinel keys (__proto__, constructor, prototype) are stripped
 *
 * Architecture note: tests FV-1 and FV-2 wire a spy outboxStore to intercept the
 * step_applied payload and a record-capturing fake pool to intercept the record
 * INSERT.  FV-3–FV-7 use the simpler no-outbox pattern (HTTP-level assertions only).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerInboxRoutes, _resetClaimStateForTests } from "../http/inbox.js";
import {
  appendProcessStarted,
} from "../http/process-projection.js";
import type { InboxWriteDeps } from "../http/inbox.js";
import type { PgClientLike } from "../db/audit-writer.js";
import type { OutboxEnqueuePort } from "../db/step-applier.js";
import { SOGLASOVANIE_SLUG } from "../db/step-applier.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = "33333333-3333-3333-3333-333333333333";
const APPROVER = "e-larina"; // holds role-approver in USER_ROLES fixture
const INSTANCE_ID = "flw-fv-test";
const PROC_KEY = "telLinear";
const APPLICATION_ID = "aaaaaaaa-0396-0001-0000-000000000001";
const PRIMARY_REGISTRY_ID = "bbbbbbbb-0396-0001-0000-000000000002";
const APPROVALS_REGISTRY_ID = "cccccccc-0396-0001-0000-000000000003";

// ---------------------------------------------------------------------------
// Fake pool — audit_event track + step-applier DB paths
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
  /** Captured record INSERT data (parsed JSON). */
  recordInserts: Array<Record<string, unknown>> = [];
}

/**
 * Build a fake pool that:
 * - Models the audit_event chain (for appendProcessStarted + appendTaskApproved).
 * - Returns stub rows for the step-applier DB paths (resolved + approvals registry +
 *   cross_app_ref absent) so applyStepResult runs through the A-branch.
 * - Captures record INSERT data JSON for assertion.
 */
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
          // Two distinct callers of audit_event:
          //   A. resolveInstanceTargetOnClient (step-applier):
          //        WHERE type = $1 AND tenant_id = $2 AND payload->>'inst' = $3
          //        params: [type, tenantId, instanceId]
          //   B. process-projection readEvents:
          //        WHERE type = $1 AND tenant_id = $2 ORDER BY ... LIMIT $3
          //        params: [type, tenantId, limitNumber]
          // Distinguish by whether $3 is a string (A) or a number (B).
          const type = params[0] as string;
          const tid = params[1] as string;
          const thirdParam = params[2];
          const instFilter =
            typeof thirdParam === "string" ? thirdParam : undefined;
          let filtered = db.events.filter(
            (e) => e.type === type && e.tenant_id === tid,
          );
          if (instFilter !== undefined) {
            // Resolver path: filter by inst in payload
            filtered = filtered.filter(
              (e) => (e.payload["inst"] as string | undefined) === instFilter,
            );
          }
          const rows = filtered
            .sort((a, b) => a.occurred_at - b.occurred_at)
            .map((e) => ({ id: e.id, actor: e.actor, payload: e.payload, occurred_at: e.occurred_at }));
          return { rows };
        }

        // -----------------------------------------------------------------------
        // step-applier DB paths: resolveInstanceTargetOnClient needs:
        //   1. audit_event WHERE type='process.started' AND tenant_id=$2 → above
        //   2. process_app_binding → applicationId
        //   3. registry_def (primary + approvals)
        //   4. cross_app_ref → null (no cross-ref in this test)
        // -----------------------------------------------------------------------
        if (/FROM choros\.process_app_binding/i.test(text)) {
          return { rows: [{ application_id: APPLICATION_ID }] };
        }
        if (/FROM choros\.registry_def/i.test(text)) {
          // resolveApprovalsRegistry — slug filter
          if (Array.isArray(params) && params.includes(SOGLASOVANIE_SLUG)) {
            return { rows: [{ id: APPROVALS_REGISTRY_ID, application_id: APPLICATION_ID }] };
          }
          // resolver's primary registry
          return { rows: [{ id: PRIMARY_REGISTRY_ID, slug: "purchases", display_name: "Заявки" }] };
        }
        if (/FROM choros\.cross_app_ref/i.test(text)) {
          return { rows: [] }; // no cross-ref — straightforward A path
        }
        if (/FROM choros\.form_binding/i.test(text)) {
          return { rows: [] }; // no step-class marker → defaults to 'A'
        }

        // Capture record INSERT: INSERT INTO choros.record (tenant_id, id, registry_id, data, ...)
        // Param order: $1=tenant_id, $2=id, $3=registry_id, $4=data::jsonb, $5=ts, $6=actor
        if (/INSERT INTO choros\.record/i.test(text)) {
          const dataJson = params[3] as string | undefined;
          if (dataJson) {
            try {
              db.recordInserts.push(JSON.parse(dataJson) as Record<string, unknown>);
            } catch {
              // ignore parse errors in test infra
            }
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

// ---------------------------------------------------------------------------
// Outbox spy
// ---------------------------------------------------------------------------

interface EnqueuedRow {
  aggregateKind: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

function makeOutboxSpy(): { store: OutboxEnqueuePort; enqueued: EnqueuedRow[] } {
  const enqueued: EnqueuedRow[] = [];
  const store: OutboxEnqueuePort = {
    enqueueInTx: async (_client, row) => {
      enqueued.push(row as EnqueuedRow);
    },
  };
  return { store, enqueued };
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

/** Seed one waiting instance task in the fake db; returns its task id. */
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
// Tests — with outbox spy (verify data reaches the entity record)
// ---------------------------------------------------------------------------

describe("inbox action — formValues persistence (T-0396)", () => {
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
  // FV-1: formValues keys appear in the step_applied outbox variables payload
  // -------------------------------------------------------------------------
  it("FV-1: formValues → step_applied outbox payload.variables contains the form fields", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    const { store, enqueued } = makeOutboxSpy();
    await start({
      pool: makeFakePool(db),
      resolveActorTenant: async () => TENANT_ID,
      outboxStore: store,
    });

    const r = await httpReq(
      "POST", `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      {
        action: "approve",
        outcome: "Согласовать",
        formValues: { title: "Ноутбук Dell", amount: 85000, currency: "RUB" },
      },
    );
    expect(r.status).toBe(200);

    // The step_applied outbox row should carry the form values in `variables`
    const stepApplied = enqueued.find((e) => e.eventType === "step_applied");
    expect(stepApplied).toBeDefined();
    const vars = stepApplied?.payload["variables"] as Record<string, unknown>;
    expect(vars).toBeDefined();
    expect(vars["title"]).toBe("Ноутбук Dell");
    expect(vars["amount"]).toBe(85000);
    expect(vars["currency"]).toBe("RUB");
    // Canonical provenance fields also present
    expect(vars["decision"]).toBe("Согласовать");
    expect(vars["approved_by"]).toBe(APPROVER);
  });

  // -------------------------------------------------------------------------
  // FV-2: formValues keys appear in the record INSERT data JSON
  // -------------------------------------------------------------------------
  it("FV-2: formValues → record INSERT data contains the form fields", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    const { store } = makeOutboxSpy();
    await start({
      pool: makeFakePool(db),
      resolveActorTenant: async () => TENANT_ID,
      outboxStore: store,
    });

    await httpReq(
      "POST", `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      {
        action: "approve",
        formValues: { vendor: "ООО «Вектор»", category: "IT" },
      },
    );

    // The record INSERT should have captured the data
    expect(db.recordInserts.length).toBeGreaterThanOrEqual(1);
    const data = db.recordInserts[0];
    expect(data["vendor"]).toBe("ООО «Вектор»");
    expect(data["category"]).toBe("IT");
    // Canonical provenance field written
    expect(data["approved_by"]).toBe(APPROVER);
  });

  // -------------------------------------------------------------------------
  // FV-3: action without formValues still succeeds (backward compat)
  // -------------------------------------------------------------------------
  it("FV-3: action without formValues succeeds — backward compatible", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    const { store, enqueued } = makeOutboxSpy();
    await start({
      pool: makeFakePool(db),
      resolveActorTenant: async () => TENANT_ID,
      outboxStore: store,
    });

    const r = await httpReq(
      "POST", `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      { action: "approve" },
    );
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body["status"]).toBe("done");

    // step_applied still emitted; variables contains only canonical fields
    const stepApplied = enqueued.find((e) => e.eventType === "step_applied");
    expect(stepApplied).toBeDefined();
    const vars = stepApplied?.payload["variables"] as Record<string, unknown>;
    expect(vars["approved_by"]).toBe(APPROVER);
    expect(vars["decision"]).toBe("approve"); // default
  });

  // -------------------------------------------------------------------------
  // FV-4: formValues cannot override canonical provenance fields
  //        decision and approved_by come from the server, not the client
  // -------------------------------------------------------------------------
  it("FV-4: client formValues cannot override canonical decision/approved_by fields", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    const { store, enqueued } = makeOutboxSpy();
    await start({
      pool: makeFakePool(db),
      resolveActorTenant: async () => TENANT_ID,
      outboxStore: store,
    });

    await httpReq(
      "POST", `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      {
        action: "approve",
        outcome: "Согласовать",
        // Attempt to override provenance fields via formValues — must be blocked
        formValues: {
          decision: "HACKED",
          approved_by: "evil-actor",
          legitimateField: "ok",
        },
      },
    );

    const stepApplied = enqueued.find((e) => e.eventType === "step_applied");
    const vars = stepApplied?.payload["variables"] as Record<string, unknown>;
    // Canonical fields win — server-set values survive
    expect(vars["decision"]).toBe("Согласовать");   // outcome from body, not "HACKED"
    expect(vars["approved_by"]).toBe(APPROVER);     // real actor, not "evil-actor"
    // Legitimate form field still passed through
    expect(vars["legitimateField"]).toBe("ok");
  });

  // -------------------------------------------------------------------------
  // FV-5: formValues=null treated as empty (graceful degradation, not 400)
  // -------------------------------------------------------------------------
  it("FV-5: formValues=null is ignored gracefully — action succeeds", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    await start({
      pool: makeFakePool(db),
      resolveActorTenant: async () => TENANT_ID,
    });

    const r = await httpReq(
      "POST", `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      { action: "approve", formValues: null },
    );
    expect(r.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // FV-6: formValues=[] (array) treated as empty (plain-object guard)
  // -------------------------------------------------------------------------
  it("FV-6: formValues=[] (array) is ignored gracefully — action succeeds", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    await start({
      pool: makeFakePool(db),
      resolveActorTenant: async () => TENANT_ID,
    });

    const r = await httpReq(
      "POST", `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      { action: "approve", formValues: [] },
    );
    expect(r.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // FV-7: formValues with nested/mixed types are forwarded verbatim
  // -------------------------------------------------------------------------
  it("FV-7: formValues with nested/mixed types forwarded verbatim to entity record", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    const { store, enqueued } = makeOutboxSpy();
    await start({
      pool: makeFakePool(db),
      resolveActorTenant: async () => TENANT_ID,
      outboxStore: store,
    });

    const formValues = {
      title: "Закупка оборудования",
      amount: 125_000,
      approved: true,
      tags: ["urgent", "it"],
      meta: { department: "Engineering" },
    };

    const r = await httpReq(
      "POST", `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      { action: "approve", formValues },
    );
    expect(r.status).toBe(200);

    const stepApplied = enqueued.find((e) => e.eventType === "step_applied");
    const vars = stepApplied?.payload["variables"] as Record<string, unknown>;
    expect(vars["title"]).toBe("Закупка оборудования");
    expect(vars["amount"]).toBe(125_000);
    expect(vars["approved"]).toBe(true);
    expect(vars["tags"]).toEqual(["urgent", "it"]);
    expect(vars["meta"]).toEqual({ department: "Engineering" });
  });

  // -------------------------------------------------------------------------
  // FV-8: body.comment (canonical) overrides a comment key inside formValues
  // The canonical comment comes from body.comment → outcomeComment, NOT from
  // the client-supplied formValues["comment"] key.
  // -------------------------------------------------------------------------
  it("FV-8: body.comment overrides formValues.comment — canonical comment always wins", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    const { store, enqueued } = makeOutboxSpy();
    await start({
      pool: makeFakePool(db),
      resolveActorTenant: async () => TENANT_ID,
      outboxStore: store,
    });

    await httpReq(
      "POST", `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      {
        action: "approve",
        // Canonical comment provided via body.comment
        comment: "Approved after review",
        // Client also sends a comment in formValues — should be evicted
        formValues: {
          comment: "INJECTED COMMENT",
          legitimateField: "ok",
        },
      },
    );

    const stepApplied = enqueued.find((e) => e.eventType === "step_applied");
    const vars = stepApplied?.payload["variables"] as Record<string, unknown>;
    // Canonical body.comment wins; the formValues["comment"] is evicted
    expect(vars["comment"]).toBe("Approved after review");
    // Legitimate form field still present
    expect(vars["legitimateField"]).toBe("ok");
  });

  // -------------------------------------------------------------------------
  // FV-9: when body.comment is absent, formValues.comment is evicted — the
  // canonical comment path (body.comment) is the only valid source for "comment".
  // A client cannot bypass the canonical path by putting comment in formValues.
  // -------------------------------------------------------------------------
  it("FV-9: formValues.comment is evicted when body.comment is absent", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    const { store, enqueued } = makeOutboxSpy();
    await start({
      pool: makeFakePool(db),
      resolveActorTenant: async () => TENANT_ID,
      outboxStore: store,
    });

    await httpReq(
      "POST", `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      {
        action: "approve",
        // No body.comment — canonical comment is absent
        formValues: {
          comment: "SHOULD NOT PERSIST",
          otherField: "value",
        },
      },
    );

    const stepApplied = enqueued.find((e) => e.eventType === "step_applied");
    const vars = stepApplied?.payload["variables"] as Record<string, unknown>;
    // formValues["comment"] must NOT appear as the persisted comment value.
    // (comment key may be present with value undefined — JSON serialises it away.)
    expect(vars["comment"]).toBeUndefined();
    // Other fields still forwarded
    expect(vars["otherField"]).toBe("value");
  });

  // -------------------------------------------------------------------------
  // FV-10: prototype-pollution sentinel keys are stripped before storing
  // Keys __proto__, constructor, prototype in formValues must never reach the
  // persisted JSONB record data.
  // -------------------------------------------------------------------------
  it("FV-10: __proto__/constructor/prototype keys are stripped from formValues", async () => {
    const db = new FakeDb();
    const taskId = await seedTask(db);
    const { store, enqueued } = makeOutboxSpy();
    await start({
      pool: makeFakePool(db),
      resolveActorTenant: async () => TENANT_ID,
      outboxStore: store,
    });

    // Build the body manually to include literal proto-sentinel keys
    const formValues: Record<string, unknown> = {
      legitimateField: "safe",
      amount: 42,
    };
    // Assign sentinel keys via index access (not spread shorthand)
    formValues["__proto__"] = { polluted: true };
    formValues["constructor"] = "evil";
    formValues["prototype"] = { hack: true };

    await httpReq(
      "POST", `${base}/api/inbox/${taskId}/action`,
      { "x-dev-user": APPROVER },
      { action: "approve", formValues },
    );

    const stepApplied = enqueued.find((e) => e.eventType === "step_applied");
    const vars = stepApplied?.payload["variables"] as Record<string, unknown>;

    // Sentinel keys must NOT be present in the persisted payload
    expect(Object.prototype.hasOwnProperty.call(vars, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(vars, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(vars, "prototype")).toBe(false);

    // Legitimate fields are still forwarded
    expect(vars["legitimateField"]).toBe("safe");
    expect(vars["amount"]).toBe(42);
  });
});
