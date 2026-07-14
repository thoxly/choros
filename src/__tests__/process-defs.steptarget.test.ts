/**
 * src/__tests__/process-defs.steptarget.test.ts
 *
 * T-0643 [анти-кейс/BUG-017 remainder]: Publish-coherence gate — a process bound
 * to an application whose approve step cannot resolve a step-RESULT target
 * registry must not publish silently.
 *
 * BACKGROUND (D-064 §5 primitives map, BUG-017): src/db/step-applier.ts resolves
 * the target registry for a completed step's result from
 * process_app_binding.target_registry_slug (explicit override), falling back to
 * the config-primitive default ("soglasovanie" for ТЭЛ backward-compat) when the
 * binding carries no override. If neither resolves to a real registry_def row
 * under the bound application, applyStepResult throws StepTargetUnresolvedError
 * (422) — but ONLY at the FIRST APPROVE (src/__tests__/step-applier.test.ts SA-9
 * already proves this). A process freshly authored from the constructor (new
 * application, no "soglasovanie"-slugged registry, no explicit
 * target_registry_slug) publishes CLEAN today and only breaks when a real human
 * approves their first task.
 *
 * publishProcessByKey now re-runs the SAME resolution at PUBLISH time (Step 2.65)
 * and rejects (422, STEP_TARGET_UNRESOLVED) BEFORE deploy — mirroring
 * process-defs.appbinding.test.ts's structure/style exactly for the T-0559
 * app-binding gate.
 *
 * Pure unit (no live Postgres / Flowable). A fake pg.Pool models
 * getLatestVersion, loadPublishedRuleTables (empty), agentRef resolution (no
 * agent tasks here), the app-binding-draft gate (no draft apps), the
 * process_app_binding row(s) for this process, and the registry_def existence
 * check for the resolved target slug.
 *
 * Covers:
 *   - fresh app+process (binding with NO explicit slug, NO matching registry) →
 *     step_target_unresolved (never deploys) — the exact BUG-017 scenario, early.
 *   - binding WITH an explicit target_registry_slug that DOES resolve → publishes.
 *   - binding WITH NO explicit slug, but the DEFAULT ("soglasovanie") registry
 *     DOES exist (the ТЭЛ/demo regression case) → publishes (target resolves to
 *     the same registry the default always did — no behavior change for
 *     existing ТЭЛ/demo processes).
 *   - process with NO app binding at all → publishes (gate is a no-op, mirrors
 *     step-applier.ts's own "no_app_binding → sanctioned no-op" posture).
 *   - route POST /:key/publish surfaces 422 + STEP_TARGET_UNRESOLVED.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  registerProcessDefsRoutes,
  publishProcessByKey,
} from "../http/process-defs.js";
import { resolveDefaultStepResultSlug } from "../db/step-applier.js";
import type { FlowableClient } from "../core/flowable-client.js";

// T-0643 (FF-RP-7 diff-scoped anti-case gate): read the ТЭЛ default slug
// through the SAME config-primitive step-applier.ts/process-defs.ts use,
// rather than an independent string literal in this test file's own code.
const TEL_DEFAULT_SLUG = resolveDefaultStepResultSlug();

const TENANT_ID   = "a0000000-0000-0000-0000-000000000001";
const PROC_KEY    = "zakupka";
const PROC_ROW_ID = "d1111111-1111-1111-1111-111111111111";
const APP_ID      = "e0000000-0000-0000-0000-0000000000a1";
const TEST_RESOLVER = async () => TENANT_ID;

// Clean BPMN with NO agent tasks — only the step-target gate is exercised here.
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

interface BindingRow {
  application_id: string;
  target_registry_slug: string | null;
}

/**
 * bindingRows: rows the process_app_binding SELECT (no JOIN — the app_binding
 * "draft" gate's own JOIN query is answered separately, empty, below) returns
 * for THIS process. registryExistsSlugs: the set of slugs that DO resolve to a
 * registry_def row under APP_ID (drives the registry_def existence SELECT).
 */
function makePool(opts: {
  bindingRows: BindingRow[];
  registryExistsSlugs: string[];
}) {
  const responder = async (sql: string, params?: unknown[]) => {
    const s = sql.replace(/\s+/g, " ");
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(s) || /SET LOCAL/.test(s)) return { rows: [] };
    // T-0559 app-binding-draft gate query — process_app_binding JOIN application.
    if (/FROM choros\.process_app_binding b/.test(s) && /JOIN choros\.application a/.test(s)) {
      return { rows: [] }; // no draft-bound apps — that gate always passes here.
    }
    // T-0643 gate's OWN process_app_binding SELECT (no JOIN, plain WHERE).
    if (
      /FROM choros\.process_app_binding/.test(s) &&
      !/JOIN choros\.application/.test(s) &&
      /target_registry_slug/.test(s)
    ) {
      return { rows: opts.bindingRows };
    }
    // T-0643 gate's registry_def existence check (SELECT id ... WHERE slug = $3).
    if (/SELECT id\s+FROM choros\.registry_def/.test(s)) {
      const slug = params?.[2] as string | undefined;
      if (slug !== undefined && opts.registryExistsSlugs.includes(slug)) {
        return { rows: [{ id: "reg-exists" }] };
      }
      return { rows: [] };
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

describe("publishProcessByKey — step-target-registry coherence gate (T-0643, unit, no DB)", () => {
  it("BUG-017 EARLY: fresh app+process (no explicit slug, no default-slug registry) → step_target_unresolved, never deploys", async () => {
    const pool = makePool({
      bindingRows: [{ application_id: APP_ID, target_registry_slug: null }],
      registryExistsSlugs: [], // no registry matching the default slug (or anything) exists yet
    });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("step_target_unresolved");
    if (result.status !== "step_target_unresolved") throw new Error("type-narrow");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      type: "step_target_unresolved",
      elementId: APP_ID,
      elementKind: "application",
    });
    expect(result.violations[0]!.message).toContain(TEL_DEFAULT_SLUG);
    // Fail-closed BEFORE the engine is touched — mirrors the T-0559 posture.
    expect(flowable.deployBpmn).not.toHaveBeenCalled();
  });

  it("publishes when the binding names an EXPLICIT target_registry_slug that resolves", async () => {
    const pool = makePool({
      bindingRows: [{ application_id: APP_ID, target_registry_slug: "zakupki-rezultat" }],
      registryExistsSlugs: ["zakupki-rezultat"],
    });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("published");
    expect(flowable.deployBpmn).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION (ТЭЛ/demo): binding with NO explicit slug but the default-slug registry already exists → publishes unaffected", async () => {
    const pool = makePool({
      bindingRows: [{ application_id: APP_ID, target_registry_slug: null }],
      registryExistsSlugs: [TEL_DEFAULT_SLUG],
    });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("published");
    expect(flowable.deployBpmn).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a process with no app binding at all (publishes) — mirrors step-applier.ts's no_app_binding sanctioned no-op", async () => {
    const pool = makePool({ bindingRows: [], registryExistsSlugs: [] });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("published");
    expect(flowable.deployBpmn).toHaveBeenCalledTimes(1);
  });

  it("lists every offending binding when a process has more than one unresolved target", async () => {
    const APP_ID_2 = "e0000000-0000-0000-0000-0000000000a2";
    const pool = makePool({
      bindingRows: [
        { application_id: APP_ID, target_registry_slug: null },
        { application_id: APP_ID_2, target_registry_slug: "orphan-slug" },
      ],
      registryExistsSlugs: [], // neither the default nor "orphan-slug" exists
    });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("step_target_unresolved");
    if (result.status !== "step_target_unresolved") throw new Error("type-narrow");
    expect(result.violations).toHaveLength(2);
    expect(flowable.deployBpmn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Route surface — POST /api/process-defs/:key/publish.
// ---------------------------------------------------------------------------

describe("POST /api/process-defs/:key/publish — step-target-registry gate (route)", () => {
  it("returns 422 + STEP_TARGET_UNRESOLVED for an unresolved target registry", async () => {
    const router = makeRouter();
    const pool = makePool({
      bindingRows: [{ application_id: APP_ID, target_registry_slug: null }],
      registryExistsSlugs: [],
    });
    registerProcessDefsRoutes(router as any, pool as any, makeFlowable(), TEST_RESOLVER);

    const route = router.find("POST", `/api/process-defs/${PROC_KEY}/publish`);
    expect(route).not.toBeNull();
    const res = makeRes() as any;
    await route!.handler(makeReq() as any, res, { key: PROC_KEY });

    expect(res.statusCode).toBe(422);
    expect(res.json.error.code).toBe("STEP_TARGET_UNRESOLVED");
    expect(res.json.error.violations).toHaveLength(1);
    expect(res.json.error.violations[0].type).toBe("step_target_unresolved");
  });

  it("returns 200 when the target registry resolves", async () => {
    const router = makeRouter();
    const pool = makePool({
      bindingRows: [{ application_id: APP_ID, target_registry_slug: "zakupki-rezultat" }],
      registryExistsSlugs: ["zakupki-rezultat"],
    });
    registerProcessDefsRoutes(router as any, pool as any, makeFlowable(), TEST_RESOLVER);

    const route = router.find("POST", `/api/process-defs/${PROC_KEY}/publish`);
    const res = makeRes() as any;
    await route!.handler(makeReq() as any, res, { key: PROC_KEY });

    expect(res.statusCode).toBe(200);
    expect(res.json.status).toBe("published");
    expect(res.json.deploymentId).toBe("dep-1");
  });
});
