/**
 * T-0564 · /api/processes list + detail live-instance projection tests.
 *
 * ROOT CAUSE (fixed here): the two GET routes in src/http/processes.ts were NOT
 * withAuth-wrapped and, in the list handler, fed the JWT `sub` straight into
 * resolveActorTenant — so keycloak personas (sub=UUID ≠ slug) fail-closed and every
 * real caller saw an EMPTY list. The `:id` route had no DB branch at all, so a live
 * (non-seed) instance id always 404'd.
 *
 * These are pure unit tests (no live Postgres): the pg pool is faked to return one
 * `process.started` audit_event row, so listInstanceProjections folds a single live
 * instance. DATABASE_URL is set for the DB-branch (hasDb()) tests and cleared for the
 * no-DB fallback test. Auth mode stays dev (default) → withAuth is a pass-through and
 * the x-dev-user header value IS the actor slug (the fix's dev branch).
 *
 * A live-PG round-trip (real RLS tenant isolation over choros.audit_event) is DEFERRED
 * to the integration pass — the fake pool proves the wiring (withAuth wrap + slug
 * resolution + :id projection branch), not the SQL semantics.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerProcessesRoutes } from "../http/processes.js";
import type { StartInstanceDeps } from "../http/process-start.js";
import {
  PROCESS_STARTED_TYPE,
  INSTANCE_ENDED_TYPE,
  TASK_APPROVED_TYPE,
  NEXT_TASK_TYPE,
} from "../http/process-projection.js";

// ---------------------------------------------------------------------------
// A fake pg pool whose SELECTs return the audit rows for ONE started instance.
// readEvents() (process-projection.ts) issues 4 SELECTs (started / instance.ended /
// task.approved / process.next_task) inside a tenant tx; we route by the $1 type arg.
// ---------------------------------------------------------------------------

const LIVE_INST = "eng-inst-9f2a";
const LIVE_PROC = "telLinear";

function makeProjectionPool(startedRows: Array<Record<string, unknown>>): import("pg").Pool {
  const fakeClient = {
    query: async (text: string, values?: unknown[]) => {
      // BEGIN / COMMIT / SET LOCAL / search_path — no-ops.
      if (!/^\s*SELECT/i.test(text)) return { rows: [] };
      const type = Array.isArray(values) ? values[0] : undefined;
      if (type === PROCESS_STARTED_TYPE) return { rows: startedRows };
      if (type === INSTANCE_ENDED_TYPE) return { rows: [] };
      if (type === TASK_APPROVED_TYPE) return { rows: [] };
      if (type === NEXT_TASK_TYPE) return { rows: [] };
      return { rows: [] };
    },
    release: () => {},
  };
  return {
    connect: async () => fakeClient as unknown as import("pg").PoolClient,
  } as unknown as import("pg").Pool;
}

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR = "e-test-approver";

/** One started-instance audit row, shaped as readEvents expects (StartedRow). */
function startedRow(inst: string): Record<string, unknown> {
  return {
    id: "audit-evt-1",
    actor: ACTOR,
    payload: {
      inst,
      proc_key: LIVE_PROC,
      task_role: "role-approver",
      task_step: "Согласование",
      inbox_task_id: "audit-evt-1",
    },
    occurred_at: Date.parse("2026-06-30T10:00:00Z"),
  };
}

function makeDeps(startedRows: Array<Record<string, unknown>>): StartInstanceDeps {
  return {
    pool: makeProjectionPool(startedRows),
    // FlowableClient is not exercised by the read GETs — a bare stub suffices.
    flowable: {} as unknown as StartInstanceDeps["flowable"],
    resolveActorTenant: async () => TENANT_ID,
  };
}

// ---------------------------------------------------------------------------
// HTTP harness (mirrors process-start.test.ts)
// ---------------------------------------------------------------------------

function buildServer(deps?: StartInstanceDeps): {
  server: http.Server;
  baseUrl: () => string;
} {
  const router = new Router();
  registerProcessesRoutes(router, undefined, deps);
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
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parseInt(parsed.port, 10),
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: { raw: data } });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// DB-mode tests — an authenticated (dev x-dev-user) caller sees the live instance.
// ---------------------------------------------------------------------------

describe("T-0564 · /api/processes DB-mode live projection", () => {
  const prevDbUrl = process.env["DATABASE_URL"];
  let harness: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    // hasDb() ⇒ take the projection branch. (The fake pool never actually parses this.)
    process.env["DATABASE_URL"] = "postgres://fake/T-0564";
    harness = buildServer(makeDeps([startedRow(LIVE_INST)]));
    await new Promise<void>((resolve) =>
      harness.server.listen(0, "127.0.0.1", () => resolve()),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = prevDbUrl;
  });

  it("GET /api/processes lists the live started instance for an authenticated actor", async () => {
    const { status, json } = await httpReq("GET", `${harness.baseUrl()}/api/processes`, {
      "x-dev-user": ACTOR,
    });
    expect(status).toBe(200);
    const data = json as { instances: Array<Record<string, unknown>> };
    expect(Array.isArray(data.instances)).toBe(true);
    const live = data.instances.find((i) => i.id === LIVE_INST);
    expect(live).toBeDefined();
    // Wire contract: id == p.inst; mapped via projectionToInstance.
    expect(live?.id).toBe(LIVE_INST);
    expect(live?.procId).toBe(LIVE_PROC);
    expect(["running", "waiting", "done"]).toContain(live?.status);
  });

  it("GET /api/processes returns honest-empty (no seed leak) when no actor is present", async () => {
    // No x-dev-user in dev mode ⇒ no actor ⇒ empty list (T-0301: seed must NOT leak
    // into the DB-mode read for real tenants).
    const { status, json } = await httpReq("GET", `${harness.baseUrl()}/api/processes`);
    expect(status).toBe(200);
    const data = json as { instances: unknown[] };
    expect(data.instances).toEqual([]);
  });

  it("GET /api/processes/:id finds the live instance by its inst-id (T-0556 detail fetch)", async () => {
    const { status, json } = await httpReq(
      "GET",
      `${harness.baseUrl()}/api/processes/${LIVE_INST}`,
      { "x-dev-user": ACTOR },
    );
    expect(status).toBe(200);
    const data = json as Record<string, unknown>;
    expect(data.id).toBe(LIVE_INST);
    expect(data.procId).toBe(LIVE_PROC);
  });

  it("GET /api/processes/:id returns 404 for an unknown instance id", async () => {
    const { status } = await httpReq(
      "GET",
      `${harness.baseUrl()}/api/processes/does-not-exist`,
      { "x-dev-user": ACTOR },
    );
    expect(status).toBe(404);
  });

  it("GET /api/processes/:id does NOT serve the seed fixture in DB mode (404 for INS-7731)", async () => {
    // INS-7731 exists only in the no-DB seed fixture. In DB mode it must NOT leak.
    const { status } = await httpReq(
      "GET",
      `${harness.baseUrl()}/api/processes/INS-7731`,
      { "x-dev-user": ACTOR },
    );
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// No-DB fallback — the seed list + detail still work without DATABASE_URL.
// ---------------------------------------------------------------------------

describe("T-0564 · /api/processes no-DB fallback (seed preserved)", () => {
  const prevDbUrl = process.env["DATABASE_URL"];
  let harness: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    delete process.env["DATABASE_URL"]; // hasDb() === false ⇒ seed path.
    // No startDeps: the display-plane-only registration (E2E/no-DB posture).
    harness = buildServer(undefined);
    await new Promise<void>((resolve) =>
      harness.server.listen(0, "127.0.0.1", () => resolve()),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = prevDbUrl;
  });

  it("GET /api/processes returns the non-empty seed list", async () => {
    const { status, json } = await httpReq("GET", `${harness.baseUrl()}/api/processes`);
    expect(status).toBe(200);
    const data = json as { instances: Array<Record<string, unknown>> };
    expect(data.instances.length).toBeGreaterThan(0);
    expect(data.instances.some((i) => i.id === "INS-7731")).toBe(true);
  });

  it("GET /api/processes/:id returns the seed instance", async () => {
    const { status, json } = await httpReq(
      "GET",
      `${harness.baseUrl()}/api/processes/INS-7731`,
    );
    expect(status).toBe(200);
    expect((json as Record<string, unknown>).id).toBe("INS-7731");
  });

  it("GET /api/processes/:id 404s an unknown seed id", async () => {
    const { status } = await httpReq(
      "GET",
      `${harness.baseUrl()}/api/processes/NOPE`,
    );
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// T-0609 — variables + detailed transition history on GET /api/processes/:id
// (DB-mode). Live acceptance finding: a P0 gateway-branch diagnosis previously
// required raw SQL against the Flowable tables because no product surface
// showed instance variables or activity-level history.
// ---------------------------------------------------------------------------

function makeDepsWithFlowable(
  startedRows: Array<Record<string, unknown>>,
  flowable: StartInstanceDeps["flowable"],
): StartInstanceDeps {
  return {
    pool: makeProjectionPool(startedRows),
    flowable,
    resolveActorTenant: async () => TENANT_ID,
  };
}

describe("T-0609 · GET /api/processes/:id variables + history", () => {
  const prevDbUrl = process.env["DATABASE_URL"];
  let harness: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0609";
    const flowableStub = {
      getHistoricVariableInstances: async () => ({
        ok: true as const,
        variables: [{ name: "amount", value: 42000 }],
      }),
      getHistoricActivityInstances: async () => ({
        ok: true as const,
        activities: [
          {
            activityId: "start1",
            activityName: "Начало",
            activityType: "startEvent",
            startTime: "2026-07-03T10:00:00.000+0000",
            endTime: "2026-07-03T10:00:00.000+0000",
            assignee: null,
          },
          {
            activityId: "task-approve",
            activityName: "Утверждение",
            activityType: "userTask",
            startTime: "2026-07-03T10:00:01.000+0000",
            endTime: null,
            assignee: "e-test-approver",
          },
        ],
      }),
    } as unknown as StartInstanceDeps["flowable"];
    harness = buildServer(makeDepsWithFlowable([startedRow(LIVE_INST)], flowableStub));
    await new Promise<void>((resolve) =>
      harness.server.listen(0, "127.0.0.1", () => resolve()),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = prevDbUrl;
  });

  it("AC-7: returns variables[] and history[] alongside the existing projection fields", async () => {
    const { status, json } = await httpReq(
      "GET",
      `${harness.baseUrl()}/api/processes/${LIVE_INST}`,
      { "x-dev-user": ACTOR },
    );
    expect(status).toBe(200);
    const data = json as Record<string, unknown>;
    // Regression: existing fields untouched.
    expect(data.id).toBe(LIVE_INST);
    expect(data.procId).toBe(LIVE_PROC);
    // New fields.
    expect(data.variables).toEqual([{ name: "amount", value: 42000 }]);
    expect(data.historyAvailable).toBe(true);
    expect(data.history).toEqual([
      {
        step: "Начало",
        kind: "startEvent",
        startedAt: "2026-07-03T10:00:00.000+0000",
        endedAt: "2026-07-03T10:00:00.000+0000",
        completedBy: null,
      },
      {
        step: "Утверждение",
        kind: "userTask",
        startedAt: "2026-07-03T10:00:01.000+0000",
        endedAt: null,
        completedBy: "e-test-approver",
      },
    ]);
  });
});

describe("T-0609 · GET /api/processes/:id honest degrade when the engine is unavailable", () => {
  const prevDbUrl = process.env["DATABASE_URL"];
  let harness: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0609-degrade";
    const flowableStub = {
      getHistoricVariableInstances: async () => ({ ok: false as const, code: "ENGINE_UNAVAILABLE" as const }),
      getHistoricActivityInstances: async () => ({ ok: false as const, code: "ENGINE_UNAVAILABLE" as const }),
    } as unknown as StartInstanceDeps["flowable"];
    harness = buildServer(makeDepsWithFlowable([startedRow(LIVE_INST)], flowableStub));
    await new Promise<void>((resolve) =>
      harness.server.listen(0, "127.0.0.1", () => resolve()),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = prevDbUrl;
  });

  it("AC-8: engine error degrades to empty variables/history + historyAvailable:false, still 200", async () => {
    const { status, json } = await httpReq(
      "GET",
      `${harness.baseUrl()}/api/processes/${LIVE_INST}`,
      { "x-dev-user": ACTOR },
    );
    expect(status).toBe(200);
    const data = json as Record<string, unknown>;
    expect(data.id).toBe(LIVE_INST);
    expect(data.variables).toEqual([]);
    expect(data.history).toEqual([]);
    expect(data.historyAvailable).toBe(false);
  });
});

describe("T-0609 · GET /api/processes/:id with a bare FlowableClient stub (no history methods)", () => {
  const prevDbUrl = process.env["DATABASE_URL"];
  let harness: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    // Mirrors the pre-existing "T-0564 DB-mode" harness's bare {} stub (dozens of other
    // tests in this file use the SAME pattern) — the optional-method guard in
    // fetchInstanceHistoryDetail must degrade safely rather than throw.
    process.env["DATABASE_URL"] = "postgres://fake/T-0609-bare";
    harness = buildServer(makeDeps([startedRow(LIVE_INST)]));
    await new Promise<void>((resolve) =>
      harness.server.listen(0, "127.0.0.1", () => resolve()),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = prevDbUrl;
  });

  it("AC-9 regression: tenant-scope gate unchanged, response stays 200 with honest-empty history fields", async () => {
    const { status, json } = await httpReq(
      "GET",
      `${harness.baseUrl()}/api/processes/${LIVE_INST}`,
      { "x-dev-user": ACTOR },
    );
    expect(status).toBe(200);
    const data = json as Record<string, unknown>;
    expect(data.variables).toEqual([]);
    expect(data.history).toEqual([]);
    expect(data.historyAvailable).toBe(false);
  });

  it("AC-9 regression: a non-member actor still gets 404 (visibility not widened)", async () => {
    const { status } = await httpReq(
      "GET",
      `${harness.baseUrl()}/api/processes/does-not-exist`,
      { "x-dev-user": ACTOR },
    );
    expect(status).toBe(404);
  });
});
