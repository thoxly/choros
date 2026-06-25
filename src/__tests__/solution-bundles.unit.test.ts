/**
 * src/__tests__/solution-bundles.unit.test.ts — T-0465 (D8-G4): bundle-promote.
 *
 * Unit tests for POST /api/solution-bundles/:bundleId/promote — NO ambient DB.
 * A fake pg.Pool scripts row sets by SQL shape so the handler drives the REAL
 * promoteTier (artifacts.ts) + publishProcessByKey (process-defs.ts) paths.
 *
 * Invariant under test (T-0465 #4): a SINGLE bundle-promote call publishes ALL
 * bundle items together — apps + sections via the config tier flip, processes via
 * the publish path. Plus the human-gate (agents → 403) and empty-bundle → 404.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { registerSolutionBundleRoutes } from "../http/solution-bundles.js";
import type { FlowableClient } from "../core/flowable-client.js";

const TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const BUNDLE_ID = "b1111111-1111-1111-1111-111111111111";
const APP_ID_1 = "a1111111-1111-1111-1111-111111111111";
const REG_ID_1 = "c1111111-1111-1111-1111-111111111111";
const PROC_KEY = "soglasovanie-zakupki";

// ---------------------------------------------------------------------------
// Router stub (captures handlers; matches :param paths).
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

function makeRouter() {
  const routes: Array<{ method: string; path: string; handler: Handler }> = [];
  return {
    register(method: string, path: string, handler: Handler) {
      routes.push({ method, path, handler });
    },
    find(method: string, path: string) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const rp = route.path.split("/");
        const pp = path.split("/");
        if (rp.length !== pp.length) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < rp.length; i++) {
          if (rp[i]!.startsWith(":")) params[rp[i]!.slice(1)] = pp[i]!;
          else if (rp[i] !== pp[i]) { ok = false; break; }
        }
        if (ok) return { handler: route.handler, params };
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake pg.Pool — scripts row sets by SQL shape. Records all queries.
// ---------------------------------------------------------------------------

function makePool(opts: {
  actorType?: "human" | "agent";
  appIds?: string[];
  regIds?: string[];
  procKeys?: string[];
  /** process status row returned by getLatestVersion (status used by publish). */
  procStatus?: string;
}) {
  const queries: string[] = [];
  const responder = async (sql: string): Promise<{ rows: any[]; rowCount: number }> => {
    queries.push(sql);
    const s = sql.replace(/\s+/g, " ");

    // employee.type lookup (resolveActorType dev path)
    if (/FROM choros\.employee WHERE tenant_id = \$1 AND slug/.test(s)) {
      return { rows: [{ type: opts.actorType ?? "human" }], rowCount: 1 };
    }
    // bundle item resolution
    if (/SELECT id FROM choros\.application WHERE tenant_id = \$1 AND bundle_id/.test(s)) {
      return { rows: (opts.appIds ?? []).map((id) => ({ id })), rowCount: (opts.appIds ?? []).length };
    }
    if (/SELECT id FROM choros\.registry_def WHERE tenant_id = \$1 AND bundle_id/.test(s)) {
      return { rows: (opts.regIds ?? []).map((id) => ({ id })), rowCount: (opts.regIds ?? []).length };
    }
    if (/SELECT DISTINCT process_key FROM choros\.process_definition WHERE tenant_id = \$1 AND bundle_id/.test(s)) {
      return { rows: (opts.procKeys ?? []).map((process_key) => ({ process_key })), rowCount: (opts.procKeys ?? []).length };
    }
    // promoteTier: SELECT tier FOR UPDATE
    if (/SELECT tier FROM .* WHERE tenant_id = \$1 AND id = \$2 FOR UPDATE/.test(s)) {
      return { rows: [{ tier: "draft" }], rowCount: 1 };
    }
    // audit writer: resolve current tenant from GUC
    if (/current_setting\('choros\.tenant_id', false\)::uuid AS tenant_id/.test(s)) {
      return { rows: [{ tenant_id: TENANT_ID }], rowCount: 1 };
    }
    // audit_head ensure/select (audit writer). row_hash must be a 32-byte Buffer
    // (the canonical preimage validates prev_hash length).
    if (/FROM choros\.audit_head/.test(s)) {
      return { rows: [{ seq: "0", row_hash: Buffer.alloc(32, 0), vocab_version: 1 }], rowCount: 1 };
    }
    // publishProcessByKey: getLatestVersion — return the latest process row
    if (/FROM choros\.process_definition/.test(s) && /process_key/.test(s) && /ORDER BY version/.test(s)) {
      return {
        rows: [{
          id: "d1111111-1111-1111-1111-111111111111",
          tenant_id: TENANT_ID,
          process_key: PROC_KEY,
          name: "Согласование закупки",
          bpmn_xml: "<xml/>",
          version: 1,
          status: opts.procStatus ?? "draft",
          deployment_id: null,
          created_at: "1",
          updated_at: "1",
        }],
        rowCount: 1,
      };
    }
    // BEGIN/COMMIT/SET LOCAL/UPDATE/INSERT and any other → empty
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    _queries: queries,
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockImplementation(responder),
      release: vi.fn(),
    }),
    query: vi.fn().mockImplementation(responder),
  };
  return pool;
}

function makeFlowable(deployOk = true): FlowableClient {
  return {
    startInstance: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    fetchAndLock: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    completeTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    failTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    deployBpmn: vi.fn().mockResolvedValue(
      deployOk
        ? { ok: true, deploymentId: "dep-1" }
        : { ok: false, code: "ENGINE_UNAVAILABLE" as const },
    ),
    getFirstActiveUserTask: vi.fn().mockResolvedValue({ ok: true, taskId: null }),
    completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
    getActiveUserTasks: vi.fn().mockResolvedValue({ ok: true, tasks: [] }),
    isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: false }),
    getMessageCatchWaits: vi.fn().mockResolvedValue({ ok: true, waits: [] }),
  };
}

function makeReq(headers: Record<string, string> = { "x-dev-user": "e-orlov" }): IncomingMessage {
  return {
    headers,
    on: vi.fn().mockImplementation((event: string, cb: () => void) => { if (event === "end") cb(); }),
    setEncoding: vi.fn(),
  } as unknown as IncomingMessage;
}

function makeRes() {
  const chunks: string[] = [];
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(n: string, v: string) { this.headers[n] = v; },
    end(b?: string) { if (b) chunks.push(b); },
    get body() { return chunks.join(""); },
    get json() { return JSON.parse(this.body); },
  };
}

const TEST_RESOLVER = async () => TENANT_ID;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("solution-bundles bundle-promote (unit, no DB)", () => {
  let router: ReturnType<typeof makeRouter>;

  beforeEach(() => {
    router = makeRouter();
  });

  it("registers POST /api/solution-bundles/:bundleId/promote", () => {
    const pool = makePool({});
    registerSolutionBundleRoutes(router as any, { pool: pool as any, flowable: makeFlowable(), resolveActorTenant: TEST_RESOLVER });
    expect(router.find("POST", `/api/solution-bundles/${BUNDLE_ID}/promote`)).not.toBeNull();
  });

  it("401 when no actor identity (x-dev-user missing)", async () => {
    const pool = makePool({});
    registerSolutionBundleRoutes(router as any, { pool: pool as any, flowable: makeFlowable(), resolveActorTenant: TEST_RESOLVER });
    const route = router.find("POST", `/api/solution-bundles/${BUNDLE_ID}/promote`)!;
    await expect(
      route.handler(makeReq({}) as any, makeRes() as any, { bundleId: BUNDLE_ID }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("400 when bundleId is not a UUID", async () => {
    const pool = makePool({});
    registerSolutionBundleRoutes(router as any, { pool: pool as any, flowable: makeFlowable(), resolveActorTenant: TEST_RESOLVER });
    const route = router.find("POST", `/api/solution-bundles/not-a-uuid/promote`);
    expect(route).not.toBeNull();
    await expect(
      route!.handler(makeReq() as any, makeRes() as any, { bundleId: "not-a-uuid" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("403 when actor is an agent — bundle promote is human-only", async () => {
    const pool = makePool({ actorType: "agent", appIds: [APP_ID_1] });
    registerSolutionBundleRoutes(router as any, { pool: pool as any, flowable: makeFlowable(), resolveActorTenant: TEST_RESOLVER });
    const route = router.find("POST", `/api/solution-bundles/${BUNDLE_ID}/promote`)!;
    await expect(
      route.handler(makeReq() as any, makeRes() as any, { bundleId: BUNDLE_ID }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("404 when the bundle has no draft items", async () => {
    const pool = makePool({ actorType: "human", appIds: [], regIds: [], procKeys: [] });
    registerSolutionBundleRoutes(router as any, { pool: pool as any, flowable: makeFlowable(), resolveActorTenant: TEST_RESOLVER });
    const route = router.find("POST", `/api/solution-bundles/${BUNDLE_ID}/promote`)!;
    await expect(
      route.handler(makeReq() as any, makeRes() as any, { bundleId: BUNDLE_ID }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("INVARIANT #4: one promote publishes ALL bundle items together (app + section + process)", async () => {
    const pool = makePool({
      actorType: "human",
      appIds: [APP_ID_1],
      regIds: [REG_ID_1],
      procKeys: [PROC_KEY],
      procStatus: "draft",
    });
    const flowable = makeFlowable(true);
    registerSolutionBundleRoutes(router as any, { pool: pool as any, flowable, resolveActorTenant: TEST_RESOLVER });
    const route = router.find("POST", `/api/solution-bundles/${BUNDLE_ID}/promote`)!;
    const res = makeRes();
    await route.handler(makeReq() as any, res as any, { bundleId: BUNDLE_ID });

    expect(res.statusCode).toBe(200);
    const out = res.json;
    expect(out.bundleId).toBe(BUNDLE_ID);
    expect(out.promoted).toBe(true);
    // 1 app + 1 section + 1 process = 3 items, ALL published from ONE call.
    expect(out.itemCount).toBe(3);
    expect(out.promotedCount).toBe(3);
    const kinds = out.items.map((i: any) => i.kind).sort();
    expect(kinds).toEqual(["application", "process", "registry_def"]);
    expect(out.items.every((i: any) => i.ok)).toBe(true);

    // The process was actually deployed (publish path ran for the bundled process).
    expect(flowable.deployBpmn).toHaveBeenCalledTimes(1);
    // The config items flipped tier through promoteTier (UPDATE ... tier = 'published').
    const promoteUpdates = pool._queries.filter((q) => /tier = 'published'/.test(q.replace(/\s+/g, " ")));
    expect(promoteUpdates.length).toBe(2); // application + registry_def
  });

  it("partial promote (engine down on the process) → 207 multi-status, config items still flipped", async () => {
    const pool = makePool({
      actorType: "human",
      appIds: [APP_ID_1],
      procKeys: [PROC_KEY],
      procStatus: "draft",
    });
    const flowable = makeFlowable(false); // deploy fails → process engine_unavailable
    registerSolutionBundleRoutes(router as any, { pool: pool as any, flowable, resolveActorTenant: TEST_RESOLVER });
    const route = router.find("POST", `/api/solution-bundles/${BUNDLE_ID}/promote`)!;
    const res = makeRes();
    await route.handler(makeReq() as any, res as any, { bundleId: BUNDLE_ID });

    expect(res.statusCode).toBe(207); // partial
    const out = res.json;
    expect(out.promoted).toBe(false);
    expect(out.itemCount).toBe(2); // app + process
    expect(out.promotedCount).toBe(1); // only the app succeeded
    const proc = out.items.find((i: any) => i.kind === "process");
    expect(proc.ok).toBe(false);
  });
});
