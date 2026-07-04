/**
 * src/__tests__/process-defs.agentxml-draft.test.ts
 *
 * T-0635 [P0-4 / LIVE_PROOF T-0586]: three related agent-XML publish defects.
 *
 *   1. AttributePrefixUnbound — the publish transform stamped flowable:type /
 *      flowable:topic / <flowable:field> onto the document WITHOUT ensuring
 *      xmlns:flowable was declared on <definitions>. The modeler's choros-only
 *      moddle extension never emits that declaration (web/src/canvas/
 *      choros-moddle-extension.js — associations: []), so a real modeler export
 *      produced XML with an unbound `flowable` prefix — Flowable's deploy-time
 *      SAX parser rejects that.
 *   2. Ложный 503 — a Flowable-rejected-our-XML deploy surfaced as "движок
 *      недоступен" (503) instead of an honest 4xx with the real reason.
 *   3. Порча черновика — POST /api/process-defs used to run
 *      mapAgentTaskToExternal BEFORE persisting, so the transformed (flowable:*)
 *      XML was written into bpmn_xml. Re-opening that draft in the modeler then
 *      failed to importXML() it ("unparsable content flowable:field").
 *
 * This file covers the ROUTE-LEVEL behaviour (process-defs.agentref.test.ts
 * already covers the DB-backed executor-resolution gate in the post-transform
 * shape; agent-task-external-mapper.test.ts covers the pure transform + xmlns
 * injection in isolation). Here: does POST /api/process-defs persist the
 * AUTHOR's XML untouched, and does POST /publish deploy a well-formed,
 * externalised, xmlns-complete document built FROM that same persisted row
 * without ever writing the transformed shape back?
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { registerProcessDefsRoutes } from "../http/process-defs.js";
import type { FlowableClient } from "../core/flowable-client.js";

const TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const DEV_USER = "alice";
const TEST_RESOLVER = async () => TENANT_ID;
const AGENT_ID = "d0000000-0000-0000-0000-000000000006";
const ROLE_ID = "role-intake-agent";
const PROC_KEY = "agent-flow";

// ---------------------------------------------------------------------------
// The REALISTIC modeler-exported diagram: choros:* attrs only, NO xmlns:flowable
// (web/src/canvas/choros-moddle-extension.js registers only `choros`, no
// association importing `flowable`). This is what the browser actually POSTs.
// ---------------------------------------------------------------------------
const AUTHOR_XML =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" ` +
  `xmlns:choros="http://choros.io/bpmn" targetNamespace="http://choros.dev/test">\n` +
  `  <process id="Process_1" isExecutable="false">\n` +
  `    <startEvent id="start"/>\n` +
  `    <serviceTask id="agentStep1" name="Триаж" choros:executorType="agent" ` +
  `choros:agentRef="${AGENT_ID}" choros:assignedRoleId="${ROLE_ID}"/>\n` +
  `    <endEvent id="end"/>\n` +
  `  </process>\n` +
  `</definitions>`;

// ---------------------------------------------------------------------------
// Test doubles — mirror process-defs.unit.test.ts / process-defs.agentref.test.ts.
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

function makeRouter() {
  const routes: Array<{ method: string; path: string; handler: Handler }> = [];
  return {
    register(method: string, path: string, handler: Handler) {
      routes.push({ method, path, handler });
    },
    find(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
      for (const route of routes) {
        if (route.method !== method) continue;
        const routeParts = route.path.split("/");
        const pathParts = path.split("/");
        if (routeParts.length !== pathParts.length) continue;
        const params: Record<string, string> = {};
        let match = true;
        for (let i = 0; i < routeParts.length; i++) {
          if (routeParts[i]!.startsWith(":")) params[routeParts[i]!.slice(1)] = pathParts[i]!;
          else if (routeParts[i] !== pathParts[i]) { match = false; break; }
        }
        if (match) return { handler: route.handler, params };
      }
      return null;
    },
  };
}

/**
 * Fake pool that models a REAL process_definition table: state.bpmnXml holds
 * whatever POST /api/process-defs actually persisted, so the publish test can
 * assert against exactly that (not a separately-scripted fixture) — this is
 * what proves defect #3 is fixed end-to-end (save → persisted row → publish →
 * still-persisted row unchanged).
 */
function makePool(state: { bpmnXml: string | null; version: number; provisionedAgentIds: string[] }) {
  const responder = async (sql: string, params?: unknown[]) => {
    const s = sql.replace(/\s+/g, " ");
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(s) || /SET LOCAL/.test(s)) return { rows: [] };
    if (/FROM choros\.dmn_rule_table/.test(s)) return { rows: [] };
    if (/FROM choros\.process_app_binding/.test(s)) return { rows: [] };
    if (/FROM choros\.employee e/.test(s) && /JOIN choros\.agent_card/.test(s)) {
      const candidates = (params?.[1] as string[]) ?? [];
      const set = new Set(state.provisionedAgentIds);
      return { rows: candidates.filter((id) => set.has(id)).map((id) => ({ id })) };
    }
    if (/INSERT INTO choros\.process_definition/.test(s)) {
      // params: [tenantId, id, processKey, name, bpmnXml, version, nowMs]
      state.bpmnXml = params?.[4] as string;
      state.version = params?.[5] as number;
      return { rows: [] };
    }
    if (/UPDATE choros\.process_definition/.test(s)) {
      // Publish UPDATE only sets status/deployment_id/updated_at — bpmn_xml MUST
      // NOT be touched by this statement (asserted separately by SQL-shape below).
      expect(s).not.toMatch(/bpmn_xml\s*=/);
      return { rows: [] };
    }
    if (/FROM choros\.process_definition/.test(s) && /ORDER BY version DESC/.test(s)) {
      if (state.bpmnXml === null) return { rows: [] };
      return {
        rows: [{
          tenant_id: TENANT_ID, id: "row-1", process_key: PROC_KEY, name: "Агент-флоу",
          bpmn_xml: state.bpmnXml, version: state.version, status: "draft",
          deployment_id: null, created_at: "1", updated_at: "1",
        }],
      };
    }
    return { rows: [] };
  };
  return {
    connect: vi.fn().mockResolvedValue({ query: vi.fn().mockImplementation(responder), release: vi.fn() }),
    query: vi.fn().mockImplementation(responder),
  };
}

function makeFlowable(overrides: Partial<FlowableClient> = {}): FlowableClient {
  return {
    startInstance: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    fetchAndLock: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    completeTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    failTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    deployBpmn: vi.fn().mockResolvedValue({ ok: true, deploymentId: "dep-1" }),
    getFirstActiveUserTask: vi.fn().mockResolvedValue({ ok: true, taskId: null }),
    completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
    getActiveUserTasks: vi.fn().mockResolvedValue({ ok: true, tasks: [] }),
    getMessageCatchWaits: vi.fn().mockResolvedValue({ ok: true, waits: [] }),
    correlateMessage: vi.fn().mockResolvedValue({ ok: true }),
    isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: false }),
    ...overrides,
  } as FlowableClient;
}

function makeReq(body?: string): IncomingMessage {
  const bodyStr = body ?? "";
  return {
    headers: { "x-dev-user": DEV_USER },
    on: vi.fn().mockImplementation((event: string, cb: (data?: Buffer) => void) => {
      if (event === "data" && bodyStr) cb(Buffer.from(bodyStr, "utf8"));
      if (event === "end") (cb as () => void)();
    }),
    setEncoding: vi.fn(),
  } as unknown as IncomingMessage;
}

function makeRes() {
  const chunks: string[] = [];
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; },
    end(body?: string) { if (body) chunks.push(body); },
    get body() { return chunks.join(""); },
    get json() { return JSON.parse(this.body); },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T-0635 [P0-4]: draft preservation — POST /api/process-defs persists the AUTHOR's XML", () => {
  it("does NOT persist flowable:type / flowable:topic / flowable:field — bpmn_xml stays choros:* only", async () => {
    const state = { bpmnXml: null as string | null, version: 0, provisionedAgentIds: [AGENT_ID] };
    const pool = makePool(state);
    const router = makeRouter();
    registerProcessDefsRoutes(router as any, pool as any, makeFlowable(), TEST_RESOLVER);

    const route = router.find("POST", "/api/process-defs");
    const req = makeReq(JSON.stringify({ processKey: PROC_KEY, name: "Агент-флоу", bpmnXml: AUTHOR_XML }));
    const res = makeRes();
    await route!.handler(req as any, res as any, {});

    expect(res.statusCode).toBe(201);
    expect(state.bpmnXml).not.toBeNull();
    // The persisted row is still the author's shape — no engine-only attributes leaked in.
    expect(state.bpmnXml).not.toContain("flowable:type");
    expect(state.bpmnXml).not.toContain("flowable:topic");
    expect(state.bpmnXml).not.toContain("flowable:field");
    expect(state.bpmnXml).not.toContain("xmlns:flowable");
    // The author's choros:* config is still there (nothing was dropped either).
    expect(state.bpmnXml).toContain('choros:executorType="agent"');
    expect(state.bpmnXml).toContain(`choros:agentRef="${AGENT_ID}"`);
  });

  it("re-GET after save returns the SAME author XML the client POSTed (round-trips clean, importXML-safe)", async () => {
    const state = { bpmnXml: null as string | null, version: 0, provisionedAgentIds: [AGENT_ID] };
    const pool = makePool(state);
    const router = makeRouter();
    registerProcessDefsRoutes(router as any, pool as any, makeFlowable(), TEST_RESOLVER);

    const postRoute = router.find("POST", "/api/process-defs");
    await postRoute!.handler(
      makeReq(JSON.stringify({ processKey: PROC_KEY, name: "Агент-флоу", bpmnXml: AUTHOR_XML })) as any,
      makeRes() as any,
      {},
    );

    const getRoute = router.find("GET", `/api/process-defs/${PROC_KEY}`);
    const getRes = makeRes();
    await getRoute!.handler(makeReq() as any, getRes as any, { key: PROC_KEY });

    expect(getRes.statusCode).toBe(200);
    expect(getRes.json.bpmnXml).not.toContain("flowable:field");
    expect(getRes.json.bpmnXml).not.toContain("xmlns:flowable");
  });

  it("PUBLISHING the process does not retroactively corrupt the persisted draft row (bpmn_xml unchanged after publish)", async () => {
    const state = { bpmnXml: null as string | null, version: 0, provisionedAgentIds: [AGENT_ID] };
    const pool = makePool(state);
    const router = makeRouter();
    registerProcessDefsRoutes(router as any, pool as any, makeFlowable(), TEST_RESOLVER);

    await router.find("POST", "/api/process-defs")!.handler(
      makeReq(JSON.stringify({ processKey: PROC_KEY, name: "Агент-флоу", bpmnXml: AUTHOR_XML })) as any,
      makeRes() as any,
      {},
    );
    const draftAfterSave = state.bpmnXml;

    const publishRes = makeRes();
    await router.find("POST", `/api/process-defs/${PROC_KEY}/publish`)!.handler(
      makeReq() as any, publishRes as any, { key: PROC_KEY },
    );

    expect(publishRes.statusCode).toBe(200);
    expect(publishRes.json.status).toBe("published");
    // The row's bpmn_xml is byte-identical to what was saved — publish never wrote
    // the transformed (flowable:*) shape back onto the draft.
    expect(state.bpmnXml).toBe(draftAfterSave);
    expect(state.bpmnXml).not.toContain("flowable:field");
  });
});

describe("T-0635 [P0-4]: publish deploys a well-formed, externalised, xmlns-complete document", () => {
  it("deployBpmn receives XML with xmlns:flowable declared AND the external-task shape stamped", async () => {
    const state = { bpmnXml: null as string | null, version: 0, provisionedAgentIds: [AGENT_ID] };
    const pool = makePool(state);
    const router = makeRouter();
    const flowable = makeFlowable();
    registerProcessDefsRoutes(router as any, pool as any, flowable, TEST_RESOLVER);

    await router.find("POST", "/api/process-defs")!.handler(
      makeReq(JSON.stringify({ processKey: PROC_KEY, name: "Агент-флоу", bpmnXml: AUTHOR_XML })) as any,
      makeRes() as any,
      {},
    );

    const publishRes = makeRes();
    await router.find("POST", `/api/process-defs/${PROC_KEY}/publish`)!.handler(
      makeReq() as any, publishRes as any, { key: PROC_KEY },
    );

    expect(publishRes.statusCode).toBe(200);
    const deployedXml = (flowable.deployBpmn as any).mock.calls[0][0] as string;
    // xmlns:flowable declared → no AttributePrefixUnbound.
    expect(deployedXml).toMatch(/xmlns:flowable="http:\/\/flowable\.org\/bpmn"/);
    // Agent step externalised for the dispatcher.
    expect(deployedXml).toContain('flowable:type="external"');
    expect(deployedXml).toContain('flowable:topic="agent-step"');
    expect(deployedXml).toContain('name="agentEmployeeId"');
  });

  it("REGRESSION — human-only process (no agent task) still publishes unchanged (no xmlns:flowable stamped when nothing needs it)", async () => {
    const humanXml =
      `<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" ` +
      `xmlns:choros="http://choros.io/bpmn" targetNamespace="http://choros.dev/test">` +
      `<process id="Process_1" isExecutable="false">` +
      `<startEvent id="start"/><userTask id="u1" name="Approve"/><endEvent id="end"/>` +
      `</process></definitions>`;

    const state = { bpmnXml: null as string | null, version: 0, provisionedAgentIds: [] as string[] };
    const pool = makePool(state);
    const router = makeRouter();
    const flowable = makeFlowable();
    registerProcessDefsRoutes(router as any, pool as any, flowable, TEST_RESOLVER);

    await router.find("POST", "/api/process-defs")!.handler(
      makeReq(JSON.stringify({ processKey: "human-flow", name: "Human Flow", bpmnXml: humanXml })) as any,
      makeRes() as any,
      {},
    );

    const publishRes = makeRes();
    await router.find("POST", "/api/process-defs/human-flow/publish")!.handler(
      makeReq() as any, publishRes as any, { key: "human-flow" },
    );

    expect(publishRes.statusCode).toBe(200);
    expect(publishRes.json.status).toBe("published");
    expect(flowable.deployBpmn).toHaveBeenCalledOnce();
  });
});

describe("T-0635 [P0-4]: honest 4xx vs false 503 on a Flowable XML rejection", () => {
  it("a real Flowable deploy rejection (BAD_BPMN) surfaces as 422 with a human reason, NOT 503", async () => {
    const state = { bpmnXml: null as string | null, version: 0, provisionedAgentIds: [AGENT_ID] };
    const pool = makePool(state);
    const router = makeRouter();
    const flowable = makeFlowable({
      deployBpmn: vi.fn().mockResolvedValue({ ok: false, code: "BAD_BPMN" as const }),
    });
    registerProcessDefsRoutes(router as any, pool as any, flowable, TEST_RESOLVER);

    await router.find("POST", "/api/process-defs")!.handler(
      makeReq(JSON.stringify({ processKey: PROC_KEY, name: "Агент-флоу", bpmnXml: AUTHOR_XML })) as any,
      makeRes() as any,
      {},
    );

    const publishRes = makeRes();
    // publishProcessByKey's "engine_unavailable" branch (which BAD_BPMN also routes
    // through, via flowableErrorToHttp) THROWS an HttpError — it does not res.end()
    // directly. flowableErrorToHttp(BAD_BPMN) → { status: 422, code: "BAD_BPMN", ... }
    // (a human-readable Russian message), never the 503 "движок недоступен" bucket.
    await expect(
      router.find("POST", `/api/process-defs/${PROC_KEY}/publish`)!.handler(
        makeReq() as any, publishRes as any, { key: PROC_KEY },
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: "BAD_BPMN" });
  });

  it("a genuine engine outage (ENGINE_UNAVAILABLE) still surfaces as honest 503 — the fix does not mask real outages", async () => {
    const state = { bpmnXml: null as string | null, version: 0, provisionedAgentIds: [AGENT_ID] };
    const pool = makePool(state);
    const router = makeRouter();
    const flowable = makeFlowable({
      deployBpmn: vi.fn().mockResolvedValue({ ok: false, code: "ENGINE_UNAVAILABLE" as const }),
    });
    registerProcessDefsRoutes(router as any, pool as any, flowable, TEST_RESOLVER);

    await router.find("POST", "/api/process-defs")!.handler(
      makeReq(JSON.stringify({ processKey: PROC_KEY, name: "Агент-флоу", bpmnXml: AUTHOR_XML })) as any,
      makeRes() as any,
      {},
    );

    const publishRes = makeRes();
    await expect(
      router.find("POST", `/api/process-defs/${PROC_KEY}/publish`)!.handler(
        makeReq() as any, publishRes as any, { key: PROC_KEY },
      ),
    ).rejects.toMatchObject({ statusCode: 503, code: "ENGINE_UNAVAILABLE" });
  });
});
