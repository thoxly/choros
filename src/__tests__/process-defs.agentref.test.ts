/**
 * src/__tests__/process-defs.agentref.test.ts
 *
 * [SECURITY] Publish-time agentTask executor-resolution gate.
 *
 * An authored agentTask binds its executor via choros:agentRef. The pure publish
 * transform stamps it verbatim and the pure (IO-free) linter only checks PRESENCE,
 * so without this DB-backed gate a process-designer could name any in-tenant id as
 * the executor. publishProcessByKey now rejects (HTTP 422, code AGENT_REF_UNRESOLVED)
 * any agentRef that does not resolve to a provisioned kind='agent' employee
 * (agent_card row) in the publishing tenant — BEFORE deploy.
 *
 * Pure unit (no live Postgres / Flowable). A fake pg.Pool models getLatestVersion,
 * loadPublishedRuleTables (empty), the employee⨝agent_card resolution, and the
 * persist UPDATE; the agentRef→provisioned set is a per-test toggle.
 *
 * Covers:
 *   - unresolved ref → publishProcessByKey returns agent_unresolved (never deploys)
 *   - resolved ref   → publishes normally (gate is a pass-through)
 *   - non-UUID ref   → unresolved (the DAO filters it; the gate rejects)
 *   - mixed refs     → only the unresolved task yields a violation
 *   - no agent tasks → gate is a no-op (clean BPMN still publishes)
 *   - route POST /:key/publish surfaces 422 + AGENT_REF_UNRESOLVED (and 200 when ok)
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
const A_RECON     = "d0000000-0000-0000-0000-000000000002"; // a provisioned agent
const A_INVOICE   = "d0000000-0000-0000-0000-000000000003"; // a provisioned agent
const A_PRIVILEGED = "d0000000-0000-0000-0000-0000000000aa"; // NOT provisioned here
const TEST_RESOLVER = async () => TENANT_ID;

// ---------------------------------------------------------------------------
// BPMN fixtures — already in the post-transform (externalised) shape so they
// PASS the pure linter; the only thing left to validate is ref resolution.
// ---------------------------------------------------------------------------

/** One authored agent serviceTask referencing `ref`, coherent for the linter. */
function agentBpmn(...refs: string[]): string {
  const tasks = refs
    .map(
      (ref, i) => `
    <serviceTask id="agentStep${i + 1}" name="Авто-шаг ${i + 1}"
                 choros:executorType="agent"
                 choros:agentRef="${ref}"
                 flowable:type="external"
                 flowable:topic="agent-step">
      <extensionElements>
        <flowable:field name="agentEmployeeId"><flowable:string>${ref}</flowable:string></flowable:field>
      </extensionElements>
    </serviceTask>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowable="http://flowable.org/bpmn"
             xmlns:choros="http://choros.dev/bpmn"
             targetNamespace="http://choros.dev/test">
  <process id="purchaseFlow" name="Закупка" isExecutable="true">
    <startEvent id="start"/>${tasks}
    <endEvent id="end"/>
  </process>
</definitions>`;
}

/** Clean BPMN with NO agent tasks — the gate must be a no-op. */
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

function makePool(opts: { bpmnXml: string; provisionedAgentIds: string[] }) {
  const responder = async (sql: string, params?: unknown[]) => {
    const s = sql.replace(/\s+/g, " ");
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(s) || /SET LOCAL/.test(s)) return { rows: [] };
    // getLatestVersion — the persisted (already transformed) process row.
    if (/FROM choros\.process_definition/.test(s) && /ORDER BY version DESC/.test(s)) {
      return {
        rows: [{
          tenant_id: TENANT_ID, id: PROC_ROW_ID, process_key: PROC_KEY,
          name: "Закупка", bpmn_xml: opts.bpmnXml, version: 1,
          status: "draft", deployment_id: null, created_at: "1", updated_at: "1",
        }],
      };
    }
    // loadPublishedRuleTables — none (advisory gateway check stays inert).
    if (/FROM choros\.dmn_rule_table/.test(s)) return { rows: [] };
    // filterProvisionedAgentEmployeeIds — resolve the configured agent ids.
    if (/FROM choros\.employee e/.test(s) && /JOIN choros\.agent_card/.test(s)) {
      const candidates = (params?.[1] as string[]) ?? [];
      const set = new Set(opts.provisionedAgentIds);
      return { rows: candidates.filter((id) => set.has(id)).map((id) => ({ id })) };
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

// Minimal router + req/res stubs (mirror process-defs.unit.test.ts).
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

describe("publishProcessByKey — agentRef resolution gate (unit, no DB)", () => {
  it("rejects an unresolved agentRef with agent_unresolved (never deploys)", async () => {
    const pool = makePool({ bpmnXml: agentBpmn(A_PRIVILEGED), provisionedAgentIds: [A_RECON] });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("agent_unresolved");
    if (result.status !== "agent_unresolved") throw new Error("type-narrow");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      type: "agent_task_incoherent",
      elementId: "agentStep1",
      elementKind: "serviceTask",
    });
    expect(result.violations[0]!.message).toContain(A_PRIVILEGED);
    // Fail-closed BEFORE the engine is touched.
    expect(flowable.deployBpmn).not.toHaveBeenCalled();
  });

  it("publishes when every agentRef resolves to a provisioned agent", async () => {
    const pool = makePool({
      bpmnXml: agentBpmn(A_RECON, A_INVOICE),
      provisionedAgentIds: [A_RECON, A_INVOICE],
    });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("published");
    expect(flowable.deployBpmn).toHaveBeenCalledTimes(1);
  });

  it("treats a non-UUID agentRef as unresolved", async () => {
    const pool = makePool({ bpmnXml: agentBpmn("totally-bogus"), provisionedAgentIds: [A_RECON] });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("agent_unresolved");
    expect(flowable.deployBpmn).not.toHaveBeenCalled();
  });

  it("flags only the unresolved task when refs are mixed", async () => {
    const pool = makePool({
      bpmnXml: agentBpmn(A_RECON, A_PRIVILEGED),
      provisionedAgentIds: [A_RECON],
    });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("agent_unresolved");
    if (result.status !== "agent_unresolved") throw new Error("type-narrow");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.elementId).toBe("agentStep2");
    expect(result.violations[0]!.message).toContain(A_PRIVILEGED);
  });

  it("is a no-op for a process with no agent tasks (clean BPMN publishes)", async () => {
    const pool = makePool({ bpmnXml: CLEAN_BPMN, provisionedAgentIds: [] });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("published");
    expect(flowable.deployBpmn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Route surface — POST /api/process-defs/:key/publish.
// ---------------------------------------------------------------------------

describe("POST /api/process-defs/:key/publish — agentRef gate (route)", () => {
  it("returns 422 + AGENT_REF_UNRESOLVED for an unprovisioned executor", async () => {
    const router = makeRouter();
    const pool = makePool({ bpmnXml: agentBpmn(A_PRIVILEGED), provisionedAgentIds: [A_RECON] });
    registerProcessDefsRoutes(router as any, pool as any, makeFlowable(), TEST_RESOLVER);

    const route = router.find("POST", `/api/process-defs/${PROC_KEY}/publish`);
    expect(route).not.toBeNull();
    const res = makeRes() as any;
    await route!.handler(makeReq() as any, res, { key: PROC_KEY });

    expect(res.statusCode).toBe(422);
    expect(res.json.error.code).toBe("AGENT_REF_UNRESOLVED");
    expect(res.json.error.violations).toHaveLength(1);
    expect(res.json.error.violations[0].type).toBe("agent_task_incoherent");
  });

  it("returns 200 when the executor resolves to a provisioned agent", async () => {
    const router = makeRouter();
    const pool = makePool({ bpmnXml: agentBpmn(A_RECON), provisionedAgentIds: [A_RECON] });
    registerProcessDefsRoutes(router as any, pool as any, makeFlowable(), TEST_RESOLVER);

    const route = router.find("POST", `/api/process-defs/${PROC_KEY}/publish`);
    const res = makeRes() as any;
    await route!.handler(makeReq() as any, res, { key: PROC_KEY });

    expect(res.statusCode).toBe(200);
    expect(res.json.status).toBe("published");
    expect(res.json.deploymentId).toBe("dep-1");
  });
});
