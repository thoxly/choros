/**
 * src/__tests__/process-defs.appbinding.test.ts
 *
 * T-0559: Publish-coherence gate — a published (live) process must not depend on a
 * SANDBOX (draft) application it binds via choros.process_app_binding.
 *
 * The constructor links a process DEFINITION to the application(s) it drives. When
 * that process is published it becomes live; if a bound application is still
 * tier='draft', the live process would read/write a sandbox app. publishProcessByKey
 * now rejects (HTTP 422, code APP_BINDING_UNPUBLISHED) any publish whose process binds
 * a draft application — BEFORE deploy. A bundle promote pre-promotes the bound apps
 * (solution-bundles.ts §1) so they are already published by the time the process
 * publishes within the bundle; a standalone modeler publish has no such pre-step.
 *
 * Pure unit (no live Postgres / Flowable). A fake pg.Pool models getLatestVersion,
 * loadPublishedRuleTables (empty), the agentRef resolution (no agent tasks here), and
 * the process_app_binding ⨝ application draft-detection query whose rows are a
 * per-test toggle, plus the persist UPDATE.
 *
 * Covers:
 *   - process binding a DRAFT app → app_binding_unpublished (never deploys), 422 code
 *   - process binding a PUBLISHED app → publishes (the draft query returns no rows)
 *   - process with NO binding → publishes (gate is a no-op)
 *   - route POST /:key/publish surfaces 422 + APP_BINDING_UNPUBLISHED
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  registerProcessDefsRoutes,
  publishProcessByKey,
} from "../http/process-defs.js";
import type { FlowableClient } from "../core/flowable-client.js";

const TENANT_ID   = "a0000000-0000-0000-0000-000000000001";
const PROC_KEY    = "zakupka";
const PROC_ROW_ID = "d1111111-1111-1111-1111-111111111111";
const APP_DRAFT   = "e0000000-0000-0000-0000-0000000000d1";
const TEST_RESOLVER = async () => TENANT_ID;

// Clean BPMN with NO agent tasks — only the app-binding gate is exercised here.
const CLEAN_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             targetNamespace="http://choros.dev/test">
  <process id="plain" name="Plain" isExecutable="true">
    <startEvent id="start"/>
    <endEvent id="end"/>
    <sequenceFlow id="f1" sourceRef="start" targetRef="end"/>
  </process>
</definitions>`;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * draftBoundApps: rows the process_app_binding⨝application(tier='draft') query
 * returns. Empty = no draft-bound apps (either no binding, or every bound app is
 * already published) → gate passes.
 */
function makePool(opts: { draftBoundApps: Array<{ id: string; slug: string; display_name: string }> }) {
  const responder = async (sql: string, params?: unknown[]) => {
    void params;
    const s = sql.replace(/\s+/g, " ");
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(s) || /SET LOCAL/.test(s)) return { rows: [] };
    // T-0559 gate query — process_app_binding JOIN application WHERE tier='draft'.
    if (/FROM choros\.process_app_binding b/.test(s) && /JOIN choros\.application a/.test(s)) {
      return { rows: opts.draftBoundApps };
    }
    // getLatestVersion — the persisted (already transformed) process row.
    if (/FROM choros\.process_definition/.test(s) && /ORDER BY version DESC/.test(s)) {
      return {
        rows: [{
          tenant_id: TENANT_ID, id: PROC_ROW_ID, process_key: PROC_KEY,
          name: "Закупка", bpmn_xml: CLEAN_BPMN, version: 1,
          status: "draft", deployment_id: null, created_at: "1", updated_at: "1",
        }],
      };
    }
    // loadPublishedRuleTables — none.
    if (/FROM choros\.dmn_rule_table/.test(s)) return { rows: [] };
    // filterProvisionedAgentEmployeeIds — never hit (no agent tasks); return empty.
    if (/FROM choros\.employee e/.test(s) && /JOIN choros\.agent_card/.test(s)) {
      return { rows: [] };
    }
    // UPDATE persist + anything else.
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

function makeFlowable(): FlowableClient & { deployBpmn: ReturnType<typeof vi.fn> } {
  return {
    deployBpmn: vi.fn().mockResolvedValue({ ok: true, deploymentId: "dep-1" }),
    startInstance: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    fetchAndLock: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    completeTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    failTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    getFirstActiveUserTask: vi.fn().mockResolvedValue({ ok: true, taskId: null }),
    completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
    getActiveUserTasks: vi.fn().mockResolvedValue({ ok: true, tasks: [] }),
    isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: false }),
    getMessageCatchWaits: vi.fn().mockResolvedValue({ ok: true, waits: [] }),
  } as any;
}

function makeRouter() {
  const routes: Array<{ method: string; path: string; handler: any }> = [];
  return {
    register(method: string, path: string, handler: any) { routes.push({ method, path, handler }); },
    find(method: string, path: string) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const rp = r.path.split("/"), pp = path.split("/");
        if (rp.length !== pp.length) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < rp.length; i++) {
          if (rp[i]!.startsWith(":")) params[rp[i]!.slice(1)] = pp[i]!;
          else if (rp[i] !== pp[i]) { ok = false; break; }
        }
        if (ok) return { handler: r.handler, params };
      }
      return null;
    },
  };
}

function makeReq(): IncomingMessage {
  return {
    headers: { "x-dev-user": "alice" },
    on: vi.fn().mockImplementation((event: string, cb: () => void) => { if (event === "end") cb(); }),
    setEncoding: vi.fn(),
  } as unknown as IncomingMessage;
}

function makeRes() {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  return {
    statusCode: 200,
    headers,
    setHeader(name: string, value: string) { headers[name] = value; },
    end(body?: string) { if (body) chunks.push(body); },
    get body() { return chunks.join(""); },
    get json() { return JSON.parse(chunks.join("")); },
  } as unknown as ServerResponse & { body: string; json: any };
}

// ---------------------------------------------------------------------------
// publishProcessByKey — the gate, exercised directly.
// ---------------------------------------------------------------------------

describe("publishProcessByKey — app-binding coherence gate (unit, no DB)", () => {
  it("rejects publishing a process bound to a DRAFT app (never deploys)", async () => {
    const pool = makePool({
      draftBoundApps: [{ id: APP_DRAFT, slug: "vendors", display_name: "Поставщики" }],
    });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("app_binding_unpublished");
    if (result.status !== "app_binding_unpublished") throw new Error("type-narrow");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      type: "app_binding_unpublished",
      elementId: APP_DRAFT,
      elementKind: "application",
    });
    expect(result.violations[0]!.message).toContain("Поставщики");
    // Fail-closed BEFORE the engine is touched.
    expect(flowable.deployBpmn).not.toHaveBeenCalled();
  });

  it("publishes when every bound app is published (draft query returns no rows)", async () => {
    const pool = makePool({ draftBoundApps: [] });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("published");
    expect(flowable.deployBpmn).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a process with no app binding (publishes)", async () => {
    // No binding ⇒ the gate query returns no draft rows, identical to all-published.
    const pool = makePool({ draftBoundApps: [] });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("published");
    expect(flowable.deployBpmn).toHaveBeenCalledTimes(1);
  });

  it("lists every draft-bound app when more than one is unpublished", async () => {
    const pool = makePool({
      draftBoundApps: [
        { id: APP_DRAFT, slug: "vendors", display_name: "Поставщики" },
        { id: "e0000000-0000-0000-0000-0000000000d2", slug: "contracts", display_name: "Договоры" },
      ],
    });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("app_binding_unpublished");
    if (result.status !== "app_binding_unpublished") throw new Error("type-narrow");
    expect(result.violations).toHaveLength(2);
    expect(flowable.deployBpmn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Route surface — POST /api/process-defs/:key/publish.
// ---------------------------------------------------------------------------

describe("POST /api/process-defs/:key/publish — app-binding gate (route)", () => {
  it("returns 422 + APP_BINDING_UNPUBLISHED for a draft-bound app", async () => {
    const router = makeRouter();
    const pool = makePool({
      draftBoundApps: [{ id: APP_DRAFT, slug: "vendors", display_name: "Поставщики" }],
    });
    registerProcessDefsRoutes(router as any, pool as any, makeFlowable(), TEST_RESOLVER);

    const route = router.find("POST", `/api/process-defs/${PROC_KEY}/publish`);
    expect(route).not.toBeNull();
    const res = makeRes() as any;
    await route!.handler(makeReq() as any, res, { key: PROC_KEY });

    expect(res.statusCode).toBe(422);
    expect(res.json.error.code).toBe("APP_BINDING_UNPUBLISHED");
    expect(res.json.error.violations).toHaveLength(1);
    expect(res.json.error.violations[0].type).toBe("app_binding_unpublished");
  });

  it("returns 200 when every bound app is published", async () => {
    const router = makeRouter();
    const pool = makePool({ draftBoundApps: [] });
    registerProcessDefsRoutes(router as any, pool as any, makeFlowable(), TEST_RESOLVER);

    const route = router.find("POST", `/api/process-defs/${PROC_KEY}/publish`);
    const res = makeRes() as any;
    await route!.handler(makeReq() as any, res, { key: PROC_KEY });

    expect(res.statusCode).toBe(200);
    expect(res.json.status).toBe("published");
    expect(res.json.deploymentId).toBe("dep-1");
  });
});
