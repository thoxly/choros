/**
 * T-0575 [W1/деТЭЛ] BUG-017 — FF-5 (AC-7): the approve HTTP path surfaces a
 * STRUCTURED, typed error when a step requires a target-result registry but
 * none is configured (process_app_binding resolves an application, but the
 * application has no registry matching the resolved target_registry_slug) —
 * not a bare, undiagnosable 500 (the BUG-017 "500 without a log" symptom).
 *
 * Full HTTP round-trip (registerInboxRoutes, the SAME handler production
 * traffic hits) with an in-memory pg stub — mirrors inbox-engine-drive.test.ts's
 * FakeAuditDb/makeFakePool + buildHandlerServer/httpPost harness, extended to
 * also answer the step-applier's resolveInstanceTargetOnClient /
 * resolveApprovalsRegistry queries (process_app_binding, registry_def,
 * cross_app_ref) so applyStepResult's fail-honest path is genuinely reached.
 *
 * RED on the pre-T-0575 code: applyStepResult threw a bare `new Error(...)` —
 * the router mapped any non-HttpError to a generic 500 {error:{code:"INTERNAL"}}
 * with no distinguishing code or context. GREEN after the fix: the SAME
 * unresolved-target condition throws StepTargetUnresolvedError (HttpError
 * subclass, code STEP_TARGET_UNRESOLVED, status 422) which the router surfaces
 * verbatim in the {error:{code,message}} envelope, and a structured
 * console.warn logs tenantId/processKey/applicationId/expectedSlug (BUG-017:
 * "not a silent 500").
 */

import * as http from "node:http";
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerInboxRoutes, _resetClaimStateForTests } from "../http/inbox.js";
import type { InboxWriteDeps } from "../http/inbox.js";
import { Router } from "../http/router.js";
import { appendProcessStarted } from "../http/process-projection.js";
import type { PgClientLike } from "../db/audit-writer.js";
import type { OutboxEnqueuePort } from "../db/step-applier.js";

// ---------------------------------------------------------------------------
// In-memory audit + resolver-query stub pool (extends the
// inbox-engine-drive.test.ts FakeAuditDb/makeFakePool pattern with the
// additional tables applyStepResult's resolution path reads: process_app_binding,
// registry_def, cross_app_ref).
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
  /** application_id resolved for the process_app_binding row (application EXISTS). */
  applicationId = "";
  /** The registry_def slug the binding row resolves to (drives resolveApprovalsRegistry). */
  bindingTargetRegistrySlug: string | null = null;
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
        if (/SAVEPOINT/i.test(text)) return { rows: [] };
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
        // resolveInstanceTargetOnClient step 1: process.started audit_event by
        // (type, tenant, payload->>'inst') — DISTINCT from readEvents' shape
        // below (same WHERE type=$1 AND tenant_id=$2 prefix, but that query has
        // NO payload->>'inst' predicate — its $3 is a LIMIT, not an instanceId).
        if (/FROM choros\.audit_event/i.test(text) && /payload->>'inst' = \$3/.test(text)) {
          const type = params[0] as string;
          const tid = params[1] as string;
          const instanceId = params[2] as string;
          const row = db.events.find(
            (e) => e.type === type && e.tenant_id === tid && e.payload["inst"] === instanceId,
          );
          return { rows: row ? [{ payload: row.payload }] : [] };
        }
        // readEvents (listInstanceInboxTasks / findWaitingInstanceTask): fetch
        // ALL rows of a given type for the tenant (filtering by instance/id
        // happens in JS afterward). Covers process.started / instance.ended /
        // task.approved / process.next_task — all four share this exact shape.
        if (/FROM choros\.audit_event/i.test(text) && /WHERE type = \$1/.test(text)) {
          const type = params[0] as string;
          const tid = params[1] as string;
          const rows = db.events
            .filter((e) => e.type === type && e.tenant_id === tid)
            .sort((a, b) => a.occurred_at - b.occurred_at)
            .map((e) => ({ id: e.id, actor: e.actor, payload: e.payload, occurred_at: e.occurred_at }));
          return { rows };
        }
        // resolveInstanceTargetOnClient step 2: process_app_binding → application_id.
        if (/FROM choros\.process_app_binding/i.test(text)) {
          if (!db.applicationId) return { rows: [] };
          return { rows: [{ application_id: db.applicationId, target_registry_slug: db.bindingTargetRegistrySlug }] };
        }
        // resolveInstanceTargetOnClient step 3 (primary, no slug filter) AND
        // resolveApprovalsRegistry (slug filter) — same table, disambiguate by
        // whether the query filters on slug.
        if (/FROM choros\.registry_def/i.test(text)) {
          const hasSlugFilter = /AND slug = \$3/.test(text);
          if (hasSlugFilter) {
            const requestedSlug = params[2] as string;
            // The application has NO registry matching the resolved slug — the
            // exact BUG-017/AC-7 unresolved-target condition.
            if (requestedSlug === db.bindingTargetRegistrySlug || requestedSlug === "soglasovanie") {
              return { rows: [] }; // no approvals-equivalent registry seeded
            }
            return { rows: [] };
          }
          // Primary registry query (resolver's own target, unrelated to A-branch).
          return { rows: [{ id: "11111111-1111-1111-1111-111111111111", slug: "purchases", display_name: "Заявки" }] };
        }
        if (/FROM choros\.cross_app_ref/i.test(text)) return { rows: [] };
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

function makeOutboxStore(): OutboxEnqueuePort {
  return {
    enqueueInTx: async () => {
      // Not reached on the fail-closed path (the throw happens before enqueue).
    },
  };
}

const TENANT = "99999999-9999-9999-9999-999999999999";
const INST = "88888888-8888-8888-8888-888888888888";
const APPLICATION_ID = "77777777-7777-7777-7777-777777777777";
const APPROVER = "e-larina"; // holds role-approver per USER_ROLES fixture (inbox.ts)

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

function httpPost(
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

describe("T-0575 FF-5/AC-7 — step-target-unresolved is a structured 422, not a bare 500", () => {
  let server: http.Server;

  afterEach(async () => {
    _resetClaimStateForTests();
    if (server) await new Promise<void>((r) => server.close(() => r()));
    vi.restoreAllMocks();
  });

  it("approve on an instance whose bound application has NO registry for the resolved target slug → 422 {error:{code:'STEP_TARGET_UNRESOLVED'}}", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const db = new FakeDb();
    db.applicationId = APPLICATION_ID;
    // No explicit binding override → resolves to the config-primitive default
    // ("soglasovanie") — which this application does NOT have seeded.
    db.bindingTargetRegistrySlug = null;

    const pool = makeFakePool(db);

    // Seed the process.started projection row (role defaults to role-approver,
    // which APPROVER holds per the USER_ROLES fixture — PDP gate passes).
    const setupClient = await pool.connect();
    await setupClient.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    const baseTaskId = await appendProcessStarted(setupClient as unknown as PgClientLike, {
      instanceId: INST,
      procKey: "genericProc",
      actor: "system:test-seed",
      nowMs: 1000,
      tenantId: TENANT,
    });
    setupClient.release();

    const deps: InboxWriteDeps = {
      pool,
      resolveActorTenant: async () => TENANT,
      outboxStore: makeOutboxStore(),
      // No flowableClient: engine-drive is skipped (not configured), isolating
      // this test to the applyStepResult fail-honest path (FF-5's actual target).
    };
    const h = buildHandlerServer(deps);
    server = h.server;
    const base = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(h.baseUrl()));
    });

    const r = await httpPost(`${base}/api/inbox/${baseTaskId}/action`, APPROVER, { action: "approve" });

    // THE PROOF (AC-7): a STRUCTURED 422, not a bare/generic 500.
    expect(r.status).toBe(422);
    const body = r.json as { error?: { code?: string; message?: string } };
    expect(body.error).toBeDefined();
    expect(body.error?.code).toBe("STEP_TARGET_UNRESOLVED");
    expect(body.error?.message).toMatch(/genericProc/);
    expect(body.error?.message).toMatch(/soglasovanie/);

    // Logged with diagnostic context (tenantId/processKey/applicationId/expectedSlug)
    // — NOT a silent/undiagnosable failure (BUG-017 symptom).
    const warnCalls = warnSpy.mock.calls.map((c) => c.join(" "));
    const loggedLine = warnCalls.find((line) => line.includes("STEP_TARGET_UNRESOLVED"));
    expect(loggedLine).toBeDefined();
    expect(loggedLine).toContain(TENANT);
    expect(loggedLine).toContain("genericProc");
    expect(loggedLine).toContain(APPLICATION_ID);
  });

  it("approve on an instance whose bound application HAS the configured registry → 200 (regression: fail-honest path is NOT over-triggered)", async () => {
    const db = new FakeDb();
    db.applicationId = APPLICATION_ID;
    db.bindingTargetRegistrySlug = "arbitrary-target-slug";

    const pool = makeFakePool(db);
    // Override the registry_def stub for THIS test: the approvals registry
    // resolves successfully when the slug matches the binding's override.
    const originalConnect = pool.connect.bind(pool);
    pool.connect = (async () => {
      const client = await originalConnect();
      const originalQuery = client.query.bind(client);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).query = async (sql: string, params?: unknown[]) => {
        const text = sql.trim();
        if (/FROM choros\.registry_def/i.test(text) && /AND slug = \$3/.test(text)) {
          const requestedSlug = (params ?? [])[2];
          if (requestedSlug === "arbitrary-target-slug") {
            return { rows: [{ id: "22222222-2222-2222-2222-222222222222", application_id: APPLICATION_ID }] };
          }
          return { rows: [] };
        }
        return originalQuery(sql, params);
      };
      return client;
    }) as typeof pool.connect;

    const setupClient = await pool.connect();
    await setupClient.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    const baseTaskId = await appendProcessStarted(setupClient as unknown as PgClientLike, {
      instanceId: INST,
      procKey: "genericProc2",
      actor: "system:test-seed",
      nowMs: 1000,
      tenantId: TENANT,
    });
    setupClient.release();

    const deps: InboxWriteDeps = {
      pool,
      resolveActorTenant: async () => TENANT,
      outboxStore: makeOutboxStore(),
    };
    const h = buildHandlerServer(deps);
    server = h.server;
    const base = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(h.baseUrl()));
    });

    const r = await httpPost(`${base}/api/inbox/${baseTaskId}/action`, APPROVER, { action: "approve" });

    expect(r.status).toBe(200);
    const body = r.json as { status?: string };
    expect(body.status).toBe("done");
  });
});
