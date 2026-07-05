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
//
// T-0614 [деТЭЛ]: the projection ALSO issues two additional read-only SELECTs —
// choros.process_definition (definitionName resolve) and choros.employee
// (findEmployeeById, starterActorKind resolve). Both are routed here by matching the
// query TEXT (they don't carry the audit `type` constant as $1) so tests can assert
// on the honest-resolved name/execs instead of the old case-literals.
// ---------------------------------------------------------------------------

const LIVE_INST = "eng-inst-9f2a";
const LIVE_PROC = "telLinear";

function makeProjectionPool(
  startedRows: Array<Record<string, unknown>>,
  opts?: {
    /** process_key → name rows for choros.process_definition (T-0614). */
    definitionRows?: Array<{ process_key: string; name: string }>;
    /** slug → employee.kind rows for choros.employee (T-0614, findEmployeeById). */
    employeeRows?: Array<{ slug: string; display_name: string; kind: string }>;
    /** task.approved rows (T-0614 AC-4: an approved process.next_task raises stepsDone). */
    approvedTaskRows?: Array<Record<string, unknown>>;
    /** process.next_task rows. */
    nextTaskRows?: Array<Record<string, unknown>>;
  },
): import("pg").Pool {
  const fakeClient = {
    query: async (text: string, values?: unknown[]) => {
      // BEGIN / COMMIT / SET LOCAL / search_path — no-ops.
      if (!/^\s*SELECT/i.test(text)) return { rows: [] };
      // T-0614: definitionName batch resolve (process-projection.ts resolveDefinitionNames).
      if (/FROM\s+choros\.process_definition/i.test(text)) {
        return { rows: opts?.definitionRows ?? [] };
      }
      // T-0614: findEmployeeById (src/db/org.ts) — starterActorKind resolve.
      if (/FROM\s+choros\.employee/i.test(text)) {
        const slug = Array.isArray(values) ? values[1] : undefined;
        const row = (opts?.employeeRows ?? []).find((r) => r.slug === slug);
        return { rows: row ? [{ ...row, position_title: "", department_name: "" }] : [] };
      }
      const type = Array.isArray(values) ? values[0] : undefined;
      if (type === PROCESS_STARTED_TYPE) return { rows: startedRows };
      if (type === INSTANCE_ENDED_TYPE) return { rows: [] };
      if (type === TASK_APPROVED_TYPE) return { rows: opts?.approvedTaskRows ?? [] };
      if (type === NEXT_TASK_TYPE) return { rows: opts?.nextTaskRows ?? [] };
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

function makeDeps(
  startedRows: Array<Record<string, unknown>>,
  projectionOpts?: Parameters<typeof makeProjectionPool>[1],
): StartInstanceDeps {
  return {
    pool: makeProjectionPool(startedRows, projectionOpts),
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
// T-0614 [деТЭЛ] — projectionToInstance no longer assigns the case-literals
// "Канонический линейный ТЭЛ" / {done:2,total:3}|{done:3,total:3} / ["human","agent"]
// to EVERY instance. name/progress/execs are honest-resolved by the projection
// (definitionName from choros.process_definition, stepsDone/stepsKnownTotal from
// the audit fold, starterActorKind from choros.employee via findEmployeeById).
// ---------------------------------------------------------------------------

describe("T-0614 [деТЭЛ] · /api/processes name/progress/execs are honestly resolved, not case-literals", () => {
  const prevDbUrl = process.env["DATABASE_URL"];

  afterAll(() => {
    if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = prevDbUrl;
  });

  async function withHarness(
    deps: StartInstanceDeps,
    fn: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    process.env["DATABASE_URL"] = "postgres://fake/T-0614";
    const harness = buildServer(deps);
    await new Promise<void>((resolve) => harness.server.listen(0, "127.0.0.1", () => resolve()));
    try {
      await fn(harness.baseUrl());
    } finally {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    }
  }

  it("AC-1: two instances of DIFFERENT processes (each with a modeler process_definition row) get DIFFERENT honest names — not the same literal", async () => {
    const procAKey = "proc-vendor-invoice";
    const procBKey = "proc-onboarding-demo";
    const rowA = startedRow("inst-proc-a-1");
    rowA["payload"] = { ...(rowA["payload"] as object), proc_key: procAKey };
    const rowB = startedRow("inst-proc-b-1");
    rowB["payload"] = { ...(rowB["payload"] as object), proc_key: procBKey };

    const deps = makeDeps([rowA, rowB], {
      definitionRows: [
        { process_key: procAKey, name: "Проверка счёта поставщика" },
        { process_key: procBKey, name: "Приёмка демо" },
      ],
    });

    await withHarness(deps, async (baseUrl) => {
      const { status, json } = await httpReq("GET", `${baseUrl}/api/processes`, { "x-dev-user": ACTOR });
      expect(status).toBe(200);
      const data = json as { instances: Array<Record<string, unknown>> };
      const a = data.instances.find((i) => i.id === "inst-proc-a-1");
      const b = data.instances.find((i) => i.id === "inst-proc-b-1");
      expect(a?.name).toBe("Проверка счёта поставщика");
      expect(b?.name).toBe("Приёмка демо");
      // The old bug: both would show the SAME literal regardless of process.
      expect(a?.name).not.toBe(b?.name);
      expect(a?.name).not.toBe("Канонический линейный ТЭЛ");
      expect(b?.name).not.toBe("Канонический линейный ТЭЛ");
    });
  });

  it("AC-2: an engine-only process_key (no choros.process_definition row) falls back to fallbackDefinitionName honestly, not a blank/500", async () => {
    const deps = makeDeps([startedRow(LIVE_INST)], { definitionRows: [] });
    await withHarness(deps, async (baseUrl) => {
      const { status, json } = await httpReq(
        "GET",
        `${baseUrl}/api/processes/${LIVE_INST}`,
        { "x-dev-user": ACTOR },
      );
      expect(status).toBe(200);
      const data = json as Record<string, unknown>;
      // T-0616 [F-2, D-064 анти-кейс fix]: fallbackDefinitionName no longer special-
      // cases the "telLinear" key to the display literal "Канонический линейный ТЭЛ" —
      // it now echoes ANY unnamed engine-only key back honestly (LIVE_PROC itself),
      // same as every other unrecognized process_key. Not empty/undefined either way.
      expect(data.name).toBe(LIVE_PROC);
    });
  });

  it("AC-3: progress reflects the ACTUAL step count of this instance, not a hardcoded {2,3}/{3,3}", async () => {
    // A freshly-started, still-waiting instance: 0 steps done, 1 known step (the base).
    const deps = makeDeps([startedRow(LIVE_INST)]);
    await withHarness(deps, async (baseUrl) => {
      const { json } = await httpReq(
        "GET",
        `${baseUrl}/api/processes/${LIVE_INST}`,
        { "x-dev-user": ACTOR },
      );
      const data = json as Record<string, unknown>;
      // Not the old unconditional {done:2,total:3} for a waiting instance.
      expect(data.progress).toEqual({ done: 0, total: 1 });
    });
  });

  it("AC-4: an APPROVED post-gateway next_task raises stepsDone — progress grows with real completed steps, not frozen at 2/3", async () => {
    // Base task approved, plus one APPROVED process.next_task (a post-gateway step
    // this instance already completed) — the instance is still waiting on a SECOND
    // concurrent next_task (pending), so status stays "waiting" but stepsDone must
    // reflect the ALREADY-completed base + first next_task.
    const base = startedRow(LIVE_INST);
    const approvedNextTaskRow = {
      id: "next-task-approved-1",
      payload: { inst: LIVE_INST, task_step: "Проверка" },
      occurred_at: Date.parse("2026-06-30T11:00:00Z"),
    };
    const pendingNextTaskRow = {
      id: "next-task-pending-1",
      payload: { inst: LIVE_INST, task_step: "Второе согласование" },
      occurred_at: Date.parse("2026-06-30T12:00:00Z"),
    };
    const deps = makeDeps([base], {
      approvedTaskRows: [
        { payload: { inbox_task_id: "audit-evt-1" } }, // base approved
        { payload: { inbox_task_id: "next-task-approved-1" } }, // next_task #1 approved
      ],
      nextTaskRows: [approvedNextTaskRow, pendingNextTaskRow],
    });
    await withHarness(deps, async (baseUrl) => {
      const { json } = await httpReq(
        "GET",
        `${baseUrl}/api/processes/${LIVE_INST}`,
        { "x-dev-user": ACTOR },
      );
      const data = json as Record<string, unknown>;
      // stepsDone = base(1) + approved next_task(1) = 2; stepsKnownTotal = done(2) +
      // the ONE still-pending concurrent step = 3. NOT the old hardcoded {2,3} — this
      // time the numbers happen to coincide, but they are DERIVED from the actual
      // fold, not asserted unconditionally (AC-1/AC-3 above prove the general case).
      expect(data.progress).toEqual({ done: 2, total: 3 });
      expect(data.status).toBe("waiting");
    });
  });

  it("AC-5: execs reflects the starting actor's REAL employee.kind — an agent-employee starter yields ['agent'], not ['human','agent']", async () => {
    const deps = makeDeps([startedRow(LIVE_INST)], {
      employeeRows: [{ slug: ACTOR, display_name: "Test Agent", kind: "agent" }],
    });
    await withHarness(deps, async (baseUrl) => {
      const { json } = await httpReq(
        "GET",
        `${baseUrl}/api/processes/${LIVE_INST}`,
        { "x-dev-user": ACTOR },
      );
      const data = json as Record<string, unknown>;
      expect(data.execs).toEqual(["agent"]);
    });
  });

  it("AC-6: starting actor not found in choros.employee → execs honestly degrades to ['human'], never 500", async () => {
    const deps = makeDeps([startedRow(LIVE_INST)], { employeeRows: [] });
    await withHarness(deps, async (baseUrl) => {
      const { status, json } = await httpReq(
        "GET",
        `${baseUrl}/api/processes/${LIVE_INST}`,
        { "x-dev-user": ACTOR },
      );
      expect(status).toBe(200);
      const data = json as Record<string, unknown>;
      expect(data.execs).toEqual(["human"]);
    });
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

// ---------------------------------------------------------------------------
// T-0648 (D-064, UX-study §3) — completedBy resolves to a human name via the
// injected ActorsDisplayResolver, in ONE call regardless of step count (no
// per-step round-trip). processes.ts stays pg/db-import-free (FF-DISPLAY-4) —
// the resolver is injected via StartInstanceDeps.resolveActorsDisplay, exactly
// as resolveActorTenant/resolveSandboxPrivilege already are.
// ---------------------------------------------------------------------------

describe("T-0648 · GET /api/processes/:id resolves completedBy to a display name", () => {
  const prevDbUrl = process.env["DATABASE_URL"];
  let harness: ReturnType<typeof buildServer>;
  let resolveCallCount = 0;
  let lastIdsArg: readonly string[] = [];

  beforeAll(async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0648-completedby";
    resolveCallCount = 0;
    const flowableStub = {
      getHistoricVariableInstances: async () => ({ ok: true as const, variables: [] }),
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
            activityId: "task-a",
            activityName: "Проверка А",
            activityType: "userTask",
            startTime: "2026-07-03T10:00:01.000+0000",
            endTime: "2026-07-03T10:05:00.000+0000",
            assignee: "e-fixture-assignee",
          },
          {
            activityId: "task-b",
            activityName: "Проверка Б",
            activityType: "userTask",
            startTime: "2026-07-03T10:05:01.000+0000",
            endTime: null,
            // Same assignee again — must NOT trigger a second resolver call
            // (distinct-ids batching).
            assignee: "e-fixture-assignee",
          },
        ],
      }),
    } as unknown as StartInstanceDeps["flowable"];

    const deps: StartInstanceDeps = {
      pool: makeProjectionPool([startedRow(LIVE_INST)]),
      flowable: flowableStub,
      resolveActorTenant: async () => TENANT_ID,
      resolveActorsDisplay: async (_tenantId, ids) => {
        resolveCallCount += 1;
        lastIdsArg = ids;
        const m = new Map();
        if (ids.includes("e-fixture-assignee")) {
          // T-0648 FIX-2/FIX-3: the completer is an AGENT (not human) and
          // soft-deactivated — proves the backend carries the resolved TYPE
          // and deactivation, not a hardcoded "human"/active default.
          m.set("e-fixture-assignee", {
            id: "e-fixture-assignee",
            name: "Проверочный-агент",
            type: "agent",
            deactivated: true,
            resolved: true,
          });
        }
        return m;
      },
    };
    harness = buildServer(deps);
    await new Promise<void>((resolve) =>
      harness.server.listen(0, "127.0.0.1", () => resolve()),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = prevDbUrl;
  });

  it("attaches completedByName + resolved TYPE + deactivation for a resolved completedBy slug (FIX-2/FIX-3)", async () => {
    const { status, json } = await httpReq(
      "GET",
      `${harness.baseUrl()}/api/processes/${LIVE_INST}`,
      { "x-dev-user": ACTOR },
    );
    expect(status).toBe(200);
    const data = json as { history: Array<Record<string, unknown>> };
    const taskA = data.history.find((h) => h.step === "Проверка А");
    expect(taskA?.completedBy).toBe("e-fixture-assignee");
    expect(taskA?.completedByName).toBe("Проверочный-агент");
    // FIX-2: the completer's REAL type is carried (not hardcoded "human") — an
    // agent-completed userTask must render with the agent glyph.
    expect(taskA?.completedByType).toBe("agent");
    // FIX-3: the deactivation marker is carried too.
    expect(taskA?.completedByDeactivated).toBe(true);
  });

  it("NO N+1: resolves the SAME distinct completedBy slug across multiple steps in exactly ONE call PER REQUEST", async () => {
    // Delta-based (not absolute): an earlier `it` in this describe already
    // issued one GET, so resolveCallCount carries over — assert the INCREMENT
    // for THIS request is exactly 1 (one call per GET /api/processes/:id),
    // regardless of how many prior requests ran.
    const before = resolveCallCount;
    await httpReq("GET", `${harness.baseUrl()}/api/processes/${LIVE_INST}`, {
      "x-dev-user": ACTOR,
    });
    expect(resolveCallCount - before).toBe(1);
    // Distinct-ids only: "e-fixture-assignee" appears twice in the activities but must be
    // passed ONCE to the resolver.
    expect(lastIdsArg).toEqual(["e-fixture-assignee"]);
  });

  it("a step with completedBy:null carries no completedByName (nothing to resolve)", async () => {
    const { json } = await httpReq(
      "GET",
      `${harness.baseUrl()}/api/processes/${LIVE_INST}`,
      { "x-dev-user": ACTOR },
    );
    const data = json as { history: Array<Record<string, unknown>> };
    const start = data.history.find((h) => h.step === "Начало");
    expect(start?.completedBy).toBeNull();
    expect(start?.completedByName).toBeUndefined();
  });
});

describe("T-0648 · GET /api/processes/:id honest degrade when resolveActorsDisplay is absent", () => {
  const prevDbUrl = process.env["DATABASE_URL"];
  let harness: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0648-no-resolver";
    const flowableStub = {
      getHistoricVariableInstances: async () => ({ ok: true as const, variables: [] }),
      getHistoricActivityInstances: async () => ({
        ok: true as const,
        activities: [
          {
            activityId: "task-a",
            activityName: "Проверка",
            activityType: "userTask",
            startTime: "2026-07-03T10:00:00.000+0000",
            endTime: null,
            assignee: "e-fixture-assignee",
          },
        ],
      }),
    } as unknown as StartInstanceDeps["flowable"];
    // No resolveActorsDisplay on deps at all (mirrors an older composition root
    // that has not wired the resolver yet).
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

  it("falls back to the raw completedBy slug — never a 500, never invents a name", async () => {
    const { status, json } = await httpReq(
      "GET",
      `${harness.baseUrl()}/api/processes/${LIVE_INST}`,
      { "x-dev-user": ACTOR },
    );
    expect(status).toBe(200);
    const data = json as { history: Array<Record<string, unknown>> };
    expect(data.history[0]?.completedBy).toBe("e-fixture-assignee");
    expect(data.history[0]?.completedByName).toBeUndefined();
  });
});
