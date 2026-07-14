/**
 * src/__tests__/process-catalog-live-step.test.ts — T-0709 [E16/P1].
 *
 * Родитель T-0349 divergence, found live: GET /api/process-catalog showed a running
 * telLinear instance's step/role as «Согласование»/role-approver (the NEXT approval
 * step) while the engine (/api/processes/:inst) had the token on the initiator's
 * «Подача заявки»/role-initiator. Root cause: the catalog's step/role came from the
 * process.started audit SNAPSHOT (frozen at start time, or the config-primitive
 * fallback), never re-derived against the live engine as the token advanced.
 *
 * This suite exercises the FIX at the HTTP boundary: the catalog route now overlays
 * each non-done instance's step/role with the engine's LIVE active user-task (the
 * SAME source the instance-detail route reads).
 *
 *   AC-1  running instance whose snapshot froze the approver step → catalog reports
 *         the LIVE first step/role (overlay applied).
 *   AC-2  no flowable dep → honest degrade to the snapshot (never worse than before).
 *   AC-3  engine unreachable for the instance → honest degrade to the snapshot.
 *   AC-4  the engine port is queried ONLY for non-done instances (done stays snapshot).
 *
 * Pure unit (no live Postgres, no live Flowable). A fake pg.Pool models the audit-event
 * reads listInstanceProjections issues; a stub engine models getActiveUserTasks. The
 * role/step strings are TEST DATA in a .test.ts file (anti-case-excluded) — no such
 * literal enters src/ code.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { registerProcessCatalogRoutes } from "../http/process-catalog.js";

const TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const DEV_USER = "e-fixture-user";
const INST_RUNNING = "flw-running-1";
const INST_DONE = "flw-done-1";
const PROC_KEY = "proc-fixture-1";
const TEST_RESOLVER = async () => TENANT_ID;

// The divergence, NEUTRAL fixtures only: the snapshot froze the NEXT step; the live
// engine token is on the CURRENT step. Literal-agnostic — no D-064 case string
// (role-approver / Согласование / a persona) is used, so this file adds zero
// anti-case literals while still reproducing the exact "snapshot ≠ live" bug shape.
const SNAPSHOT_STEP = "step-next";
const SNAPSHOT_ROLE = "role-next";
const LIVE_STEP = "step-current";
const LIVE_ROLE = "role-current";

// ---------------------------------------------------------------------------
// Fake pg.Pool — models the audit_event reads listInstanceProjections issues.
// Keyed off the first query param (the audit event `type`).
// ---------------------------------------------------------------------------

interface StartedSeed {
  id: string;
  inst: string;
  proc_key: string;
  task_step: string;
  task_role: string;
  actor: string;
  occurred_at: number;
}

function makePool(opts: {
  started?: StartedSeed[];
  /** instance ids that have an instance.ended event → done. */
  endedInsts?: string[];
}) {
  const started = opts.started ?? [];
  const endedInsts = new Set(opts.endedInsts ?? []);

  const responder = async (sql: string, params?: unknown[]) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s) || /SET LOCAL/.test(s)) return { rows: [] };

    // Modeler definition rows + bindings (catalog tx) — empty in this fixture.
    if (/FROM choros\.process_definition/.test(s)) return { rows: [] };
    if (/FROM choros\.process_app_binding/.test(s)) return { rows: [] };
    if (/FROM choros\.application/.test(s)) return { rows: [] };
    if (/FROM choros\.employee/.test(s)) return { rows: [] }; // actorKind → "human"

    // The audit_event reads — dispatch on the `type` param ($1).
    if (/FROM choros\.audit_event/.test(s)) {
      const type = params?.[0] as string;
      if (type === "process.started") {
        return {
          rows: started.map((r) => ({
            id: r.id,
            actor: r.actor,
            payload: {
              inst: r.inst,
              proc_key: r.proc_key,
              task_step: r.task_step,
              task_role: r.task_role,
              task_name: r.task_step,
              inbox_task_id: r.id,
            },
            occurred_at: r.occurred_at,
          })),
        };
      }
      if (type === "instance.ended") {
        return { rows: [...endedInsts].map((inst) => ({ payload: { inst } })) };
      }
      // task.approved / process.next_task — none in this fixture.
      return { rows: [] };
    }
    return { rows: [] };
  };

  return {
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockImplementation(responder),
      release: vi.fn(),
    }),
    query: vi.fn().mockImplementation(responder),
  };
}

// ---------------------------------------------------------------------------
// Stub engine — getActiveUserTasks per instance.
// ---------------------------------------------------------------------------

function makeEngine(
  activeByInst: Record<
    string,
    { name: string; candidateGroups: string[] }[] | "error"
  >,
) {
  const calls: string[] = [];
  const engine = {
    getActiveUserTasks: vi.fn().mockImplementation(async (inst: string) => {
      calls.push(inst);
      const entry = activeByInst[inst];
      if (entry === undefined) return { ok: true as const, tasks: [] };
      if (entry === "error") return { ok: false as const, code: "ENGINE_DOWN" };
      return { ok: true as const, tasks: entry };
    }),
  };
  return { engine, calls };
}

// ---------------------------------------------------------------------------
// Minimal HTTP harness (mirrors process-catalog-target-registry.test.ts).
// ---------------------------------------------------------------------------

function makeRouter() {
  const routes: Array<{ method: string; path: string; handler: any }> = [];
  return {
    register(method: string, path: string, handler: any) {
      routes.push({ method, path, handler });
    },
    find(method: string, path: string) {
      for (const r of routes) {
        if (r.method === method && r.path === path) return { handler: r.handler, params: {} };
      }
      return null;
    },
  };
}

function makeReq(): IncomingMessage {
  return {
    headers: { "x-dev-user": DEV_USER },
    on: vi.fn().mockImplementation((event: string, cb: () => void) => {
      if (event === "end") cb();
    }),
    setEncoding: vi.fn(),
  } as unknown as IncomingMessage;
}

function makeRes() {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  return {
    statusCode: 200,
    headers,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    end(body?: string) {
      if (body) chunks.push(body);
    },
    get json() {
      return JSON.parse(chunks.join(""));
    },
  } as unknown as ServerResponse & { json: any };
}

async function getCatalog(deps: any) {
  const router = makeRouter();
  registerProcessCatalogRoutes(router as any, deps);
  const match = router.find("GET", "/api/process-catalog");
  if (!match) throw new Error("catalog route not registered");
  const res = makeRes();
  await match.handler(makeReq(), res, {});
  return res;
}

function startedSeed(over: Partial<StartedSeed> & { id: string; inst: string }): StartedSeed {
  return {
    proc_key: PROC_KEY,
    task_step: SNAPSHOT_STEP,
    task_role: SNAPSHOT_ROLE,
    actor: DEV_USER,
    occurred_at: 1000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T-0709 · GET /api/process-catalog overlays the LIVE active step/role", () => {
  it("AC-1: running instance frozen on the approver step is reported on the LIVE first step/role", async () => {
    const pool = makePool({
      started: [startedSeed({ id: "e1", inst: INST_RUNNING })],
    });
    const { engine } = makeEngine({
      [INST_RUNNING]: [{ name: LIVE_STEP, candidateGroups: [LIVE_ROLE] }],
    });

    const res = await getCatalog({
      pool: pool as any,
      resolveActorTenant: TEST_RESOLVER,
      flowable: engine,
    });

    expect(res.statusCode).toBe(200);
    const inst = res.json.instances.find((i: any) => i.inst === INST_RUNNING);
    expect(inst).toBeDefined();
    // The fix: the catalog now shows the REAL active node, not the frozen next step.
    expect(inst.step).toBe(LIVE_STEP);
    expect(inst.role).toBe(LIVE_ROLE);
    expect(inst.status).toBe("waiting");
  });

  it("AC-2: no flowable dep → honest degrade to the snapshot (never worse than pre-T-0709)", async () => {
    const pool = makePool({
      started: [startedSeed({ id: "e1", inst: INST_RUNNING })],
    });

    const res = await getCatalog({
      pool: pool as any,
      resolveActorTenant: TEST_RESOLVER,
      // flowable omitted.
    });

    const inst = res.json.instances.find((i: any) => i.inst === INST_RUNNING);
    expect(inst.step).toBe(SNAPSHOT_STEP);
    expect(inst.role).toBe(SNAPSHOT_ROLE);
  });

  it("AC-3: engine unreachable for the instance → honest degrade to the snapshot", async () => {
    const pool = makePool({
      started: [startedSeed({ id: "e1", inst: INST_RUNNING })],
    });
    const { engine } = makeEngine({ [INST_RUNNING]: "error" });

    const res = await getCatalog({
      pool: pool as any,
      resolveActorTenant: TEST_RESOLVER,
      flowable: engine,
    });

    const inst = res.json.instances.find((i: any) => i.inst === INST_RUNNING);
    expect(inst.step).toBe(SNAPSHOT_STEP);
    expect(inst.role).toBe(SNAPSHOT_ROLE);
  });

  it("AC-4: the engine is queried ONLY for non-done instances; a done instance keeps its snapshot", async () => {
    const pool = makePool({
      started: [
        startedSeed({ id: "e1", inst: INST_RUNNING }),
        startedSeed({ id: "e2", inst: INST_DONE, task_step: "Завершено" }),
      ],
      endedInsts: [INST_DONE],
    });
    const { engine, calls } = makeEngine({
      [INST_RUNNING]: [{ name: LIVE_STEP, candidateGroups: [LIVE_ROLE] }],
    });

    const res = await getCatalog({
      pool: pool as any,
      resolveActorTenant: TEST_RESOLVER,
      flowable: engine,
    });

    // Engine consulted for the running instance only — never for the done one.
    expect(calls).toContain(INST_RUNNING);
    expect(calls).not.toContain(INST_DONE);

    const running = res.json.instances.find((i: any) => i.inst === INST_RUNNING);
    const done = res.json.instances.find((i: any) => i.inst === INST_DONE);
    expect(running.step).toBe(LIVE_STEP);
    expect(done.status).toBe("done");
    expect(done.step).toBe("Завершено");
  });
});
