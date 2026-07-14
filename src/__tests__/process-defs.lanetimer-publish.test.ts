/**
 * src/__tests__/process-defs.lanetimer-publish.test.ts
 *
 * T-0641 [follow-up T-0635]: lane-role-mapper (T-0457) and timer-escalation-mapper
 * (T-0458) carried the SAME unprotected `flowable:candidateGroups` / native timer
 * body injection T-0635 fixed for agent-task-external-mapper — WITHOUT ever
 * guaranteeing `xmlns:flowable` is declared on `<definitions>`. Worse, unlike the
 * agent-task mapper (relocated to publish-time-only by T-0635), lane/timer still
 * ran at DRAFT-SAVE time (POST /api/process-defs) and their output was persisted
 * straight into choros.process_definition.bpmn_xml.
 *
 * Two live defects, both fixed by this task:
 *   1. A lane-only or timer-only process (no agentTask at all) published with an
 *      UNBOUND `flowable` prefix — Flowable's deploy-time SAX parser rejects that
 *      with AttributePrefixUnbound. The pure lane/timer mapper unit tests never
 *      caught this because their fixtures hand-declare xmlns:flowable (unlike a
 *      real modeler export — web/src/canvas/choros-moddle-extension.js registers
 *      only the `choros` namespace).
 *   2. Draft-save mutated bpmn_xml (lane/timer candidateGroups/timer bodies baked
 *      into the persisted draft) — the ONLY publish-transform mapper still doing
 *      this after T-0635 relocated agent-task wiring to publish-time-only.
 *
 * THE FIX: relocate both mappers to publish-time-only (mirrors T-0635 exactly),
 * and add a SINGLE publish-time chokepoint — one unconditional, idempotent
 * `ensureFlowableNamespace` call in publishProcessByKey AFTER every mapper
 * (lane / timer / agent-task / userTask-role) has run and BEFORE lint/deploy —
 * instead of duplicating a per-mapper namespace guard into lane-role-mapper.ts
 * AND timer-escalation-mapper.ts (which would be three near-identical copies of
 * the same guard spread across three files).
 *
 * This file covers the ROUTE/PUBLISH-LEVEL behaviour with REALISTIC modeler-
 * exported fixtures (no xmlns:flowable — mirrors process-defs.agentxml-draft.test.ts
 * / process-defs.usertask-role.test.ts's MODELER_NS discipline). Pure lane/timer
 * transform unit tests (lane-role-mapper.test.ts, timer-escalation-mapper.test.ts)
 * are untouched and still pass — they exercise the string transform in isolation,
 * not this integration gap.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { registerProcessDefsRoutes, publishProcessByKey } from "../http/process-defs.js";
import type { FlowableClient } from "../core/flowable-client.js";

const TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const DEV_USER = "alice";
const TEST_RESOLVER = async () => TENANT_ID;
const AGENT_ID = "d0000000-0000-0000-0000-000000000006";

// ---------------------------------------------------------------------------
// Realistic modeler-exported fixtures — choros:* (+ base BPMN) ONLY, no
// xmlns:flowable (web/src/canvas/choros-moddle-extension.js registers only the
// `choros` namespace — the browser never emits xmlns:flowable on save).
// ---------------------------------------------------------------------------

const MODELER_NS =
  'xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:choros="http://choros.io/bpmn"';

/** Lane-only process — no agentTask, no timer event anywhere in the diagram. */
const LANE_ONLY_KEY = "lane-only-flow";
const LANE_ONLY_XML =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<definitions ${MODELER_NS} targetNamespace="http://choros.dev/test">\n` +
  `  <process id="${LANE_ONLY_KEY}" isExecutable="false">\n` +
  `    <laneSet id="LaneSet_1">\n` +
  `      <lane id="Lane_buh" name="Бухгалтер">\n` +
  `        <flowNodeRef>approve</flowNodeRef>\n` +
  `      </lane>\n` +
  `    </laneSet>\n` +
  `    <startEvent id="start"/>\n` +
  `    <userTask id="approve" name="Согласовать счёт"/>\n` +
  `    <endEvent id="end"/>\n` +
  `    <sequenceFlow id="f0" sourceRef="start" targetRef="approve"/>\n` +
  `    <sequenceFlow id="f1" sourceRef="approve" targetRef="end"/>\n` +
  `  </process>\n` +
  `</definitions>`;

/** Timer-only process — no lane, no agentTask; a boundary deadline + escalation. */
const TIMER_ONLY_KEY = "timer-only-flow";
const TIMER_ONLY_XML =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<definitions ${MODELER_NS} targetNamespace="http://choros.dev/test">\n` +
  `  <process id="${TIMER_ONLY_KEY}" isExecutable="false">\n` +
  `    <startEvent id="start"/>\n` +
  `    <userTask id="task-approve" name="Согласовать"/>\n` +
  `    <boundaryEvent id="bnd-deadline" attachedToRef="task-approve" cancelActivity="true" ` +
  `choros:timerDeadlineKind="duration" choros:timerDeadline="PT24H" choros:escalateTo="manager">\n` +
  `      <timerEventDefinition/>\n` +
  `    </boundaryEvent>\n` +
  `    <userTask id="task-escalate" name="Эскалация"/>\n` +
  `    <endEvent id="end"/>\n` +
  `    <sequenceFlow id="f0" sourceRef="start" targetRef="task-approve"/>\n` +
  `    <sequenceFlow id="f1" sourceRef="task-approve" targetRef="end"/>\n` +
  `    <sequenceFlow id="sf-esc" sourceRef="bnd-deadline" targetRef="task-escalate"/>\n` +
  `    <sequenceFlow id="f2" sourceRef="task-escalate" targetRef="end"/>\n` +
  `  </process>\n` +
  `</definitions>`;

/**
 * Adjacent case (skeptic finding): an agentTask that is ALREADY external (a prior
 * publish run already wired it — flowable:type="external"/flowable:topic present,
 * still no xmlns:flowable declared) PLUS a lane wrapping a plain userTask.
 * mapAgentTaskToExternal's own `wired` flag never fires here (alreadyExternal=true
 * skips it), so its internal namespace guard is silent — the lane mapper's
 * candidateGroups injection is the ONLY thing that needs xmlns:flowable in THIS
 * run. Proves the fix is a centralized chokepoint, not just "teach the agent-task
 * mapper's own guard to fire more often".
 */
const MIXED_KEY = "mixed-lane-agent-flow";
const MIXED_ALREADY_EXTERNAL_PLUS_LANE_XML =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<definitions ${MODELER_NS} targetNamespace="http://choros.dev/test">\n` +
  `  <process id="${MIXED_KEY}" isExecutable="false">\n` +
  `    <laneSet id="LaneSet_1">\n` +
  `      <lane id="Lane_buh" name="Бухгалтер">\n` +
  `        <flowNodeRef>approve</flowNodeRef>\n` +
  `      </lane>\n` +
  `    </laneSet>\n` +
  `    <startEvent id="start"/>\n` +
  `    <userTask id="approve" name="Согласовать"/>\n` +
  `    <serviceTask id="agentStep1" name="Авто-шаг" choros:executorType="agent" ` +
  `choros:agentRef="${AGENT_ID}" flowable:type="external" flowable:topic="agent-step"/>\n` +
  `    <endEvent id="end"/>\n` +
  `    <sequenceFlow id="f0" sourceRef="start" targetRef="approve"/>\n` +
  `    <sequenceFlow id="f1" sourceRef="approve" targetRef="agentStep1"/>\n` +
  `    <sequenceFlow id="f2" sourceRef="agentStep1" targetRef="end"/>\n` +
  `  </process>\n` +
  `</definitions>`;

// ---------------------------------------------------------------------------
// Test doubles — mirror process-defs.agentxml-draft.test.ts exactly.
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

function makePool(state: { bpmnXml: string | null; version: number; processKey: string; provisionedAgentIds: string[] }) {
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
    if (/FROM choros\.employee e/.test(s) && /JOIN choros\.role_assignment ra/.test(s)) {
      return { rows: [] }; // getHoldersForRole (advisory warnings) — no confirmed holders
    }
    if (/INSERT INTO choros\.process_definition/.test(s)) {
      // params: [tenantId, id, processKey, name, bpmnXml, version, nowMs]
      state.bpmnXml = params?.[4] as string;
      state.version = params?.[5] as number;
      return { rows: [] };
    }
    if (/UPDATE choros\.process_definition/.test(s)) {
      // The publish UPDATE only sets status/deployment_id/updated_at — bpmn_xml must
      // NOT be touched by this statement.
      expect(s).not.toMatch(/bpmn_xml\s*=/);
      return { rows: [] };
    }
    if (/FROM choros\.process_definition/.test(s) && /ORDER BY version DESC/.test(s)) {
      if (state.bpmnXml === null) return { rows: [] };
      return {
        rows: [{
          tenant_id: TENANT_ID, id: "row-1", process_key: state.processKey, name: "Test Process",
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
// Gate 1: lane-only process publishes without AttributePrefixUnbound.
// ---------------------------------------------------------------------------

describe("T-0641 gate 1 — lane-only process (no agentTask) publishes clean", () => {
  it("deployBpmn receives XML with xmlns:flowable declared and the lane role wired", async () => {
    const state = { bpmnXml: null as string | null, version: 0, processKey: LANE_ONLY_KEY, provisionedAgentIds: [] as string[] };
    const pool = makePool(state);
    const router = makeRouter();
    const flowable = makeFlowable();
    registerProcessDefsRoutes(router as any, pool as any, flowable, TEST_RESOLVER);

    await router.find("POST", "/api/process-defs")!.handler(
      makeReq(JSON.stringify({ processKey: LANE_ONLY_KEY, name: "Lane Only", bpmnXml: LANE_ONLY_XML })) as any,
      makeRes() as any, {},
    );

    const publishRes = makeRes();
    await router.find("POST", `/api/process-defs/${LANE_ONLY_KEY}/publish`)!.handler(
      makeReq() as any, publishRes as any, { key: LANE_ONLY_KEY },
    );

    expect(publishRes.statusCode).toBe(200);
    expect(publishRes.json.status).toBe("published");
    const deployedXml = (flowable.deployBpmn as any).mock.calls[0][0] as string;
    // xmlns:flowable declared → no AttributePrefixUnbound at real Flowable deploy.
    expect(deployedXml).toMatch(/xmlns:flowable="http:\/\/flowable\.org\/bpmn"/);
    // The lane→role wiring actually happened.
    expect(deployedXml).toMatch(/<userTask\b[^>]*id="approve"[^>]*flowable:candidateGroups="buhgalter"/);
  });
});

// ---------------------------------------------------------------------------
// Gate 2: timer-only process publishes without AttributePrefixUnbound.
// ---------------------------------------------------------------------------

describe("T-0641 gate 2 — timer-only process (no agentTask, no lane) publishes clean", () => {
  it("deployBpmn receives XML with xmlns:flowable declared, native timer body + escalation candidateGroups", async () => {
    const state = { bpmnXml: null as string | null, version: 0, processKey: TIMER_ONLY_KEY, provisionedAgentIds: [] as string[] };
    const pool = makePool(state);
    const router = makeRouter();
    const flowable = makeFlowable();
    registerProcessDefsRoutes(router as any, pool as any, flowable, TEST_RESOLVER);

    await router.find("POST", "/api/process-defs")!.handler(
      makeReq(JSON.stringify({ processKey: TIMER_ONLY_KEY, name: "Timer Only", bpmnXml: TIMER_ONLY_XML })) as any,
      makeRes() as any, {},
    );

    const publishRes = makeRes();
    await router.find("POST", `/api/process-defs/${TIMER_ONLY_KEY}/publish`)!.handler(
      makeReq() as any, publishRes as any, { key: TIMER_ONLY_KEY },
    );

    expect(publishRes.statusCode).toBe(200);
    expect(publishRes.json.status).toBe("published");
    const deployedXml = (flowable.deployBpmn as any).mock.calls[0][0] as string;
    expect(deployedXml).toMatch(/xmlns:flowable="http:\/\/flowable\.org\/bpmn"/);
    // Native timer body materialised (Flowable can actually schedule it).
    expect(deployedXml).toContain("<timeDuration>PT24H</timeDuration>");
    // Escalation target wired to the "manager" role slug.
    expect(deployedXml).toMatch(/<userTask\b[^>]*id="task-escalate"[^>]*flowable:candidateGroups="role-manager"/);
  });
});

// ---------------------------------------------------------------------------
// Gate 3: draft-save does NOT mutate bpmn_xml (byte-identical persisted row).
// ---------------------------------------------------------------------------

describe("T-0641 gate 3 — draft-save persists the AUTHOR's XML byte-identically", () => {
  it("lane-only: persisted row is byte-identical to the POSTed XML (no candidateGroups baked in)", async () => {
    const state = { bpmnXml: null as string | null, version: 0, processKey: LANE_ONLY_KEY, provisionedAgentIds: [] as string[] };
    const pool = makePool(state);
    const router = makeRouter();
    registerProcessDefsRoutes(router as any, pool as any, makeFlowable(), TEST_RESOLVER);

    const res = makeRes();
    await router.find("POST", "/api/process-defs")!.handler(
      makeReq(JSON.stringify({ processKey: LANE_ONLY_KEY, name: "Lane Only", bpmnXml: LANE_ONLY_XML })) as any,
      res as any, {},
    );

    expect(res.statusCode).toBe(201);
    expect(state.bpmnXml).toBe(LANE_ONLY_XML); // byte-identical, no mutation at all
    expect(state.bpmnXml).not.toContain("flowable:candidateGroups");
    expect(state.bpmnXml).not.toContain("xmlns:flowable");
  });

  it("timer-only: persisted row is byte-identical to the POSTed XML (no timer body / candidateGroups baked in)", async () => {
    const state = { bpmnXml: null as string | null, version: 0, processKey: TIMER_ONLY_KEY, provisionedAgentIds: [] as string[] };
    const pool = makePool(state);
    const router = makeRouter();
    registerProcessDefsRoutes(router as any, pool as any, makeFlowable(), TEST_RESOLVER);

    const res = makeRes();
    await router.find("POST", "/api/process-defs")!.handler(
      makeReq(JSON.stringify({ processKey: TIMER_ONLY_KEY, name: "Timer Only", bpmnXml: TIMER_ONLY_XML })) as any,
      res as any, {},
    );

    expect(res.statusCode).toBe(201);
    expect(state.bpmnXml).toBe(TIMER_ONLY_XML); // byte-identical
    expect(state.bpmnXml).not.toContain("<timeDuration>");
    expect(state.bpmnXml).not.toContain("flowable:candidateGroups");
  });

  it("publishing does not retroactively mutate the persisted draft row (bpmn_xml unchanged after publish)", async () => {
    const state = { bpmnXml: null as string | null, version: 0, processKey: LANE_ONLY_KEY, provisionedAgentIds: [] as string[] };
    const pool = makePool(state);
    const router = makeRouter();
    registerProcessDefsRoutes(router as any, pool as any, makeFlowable(), TEST_RESOLVER);

    await router.find("POST", "/api/process-defs")!.handler(
      makeReq(JSON.stringify({ processKey: LANE_ONLY_KEY, name: "Lane Only", bpmnXml: LANE_ONLY_XML })) as any,
      makeRes() as any, {},
    );
    const draftAfterSave = state.bpmnXml;

    const publishRes = makeRes();
    await router.find("POST", `/api/process-defs/${LANE_ONLY_KEY}/publish`)!.handler(
      makeReq() as any, publishRes as any, { key: LANE_ONLY_KEY },
    );

    expect(publishRes.statusCode).toBe(200);
    expect(state.bpmnXml).toBe(draftAfterSave);
    expect(state.bpmnXml).toBe(LANE_ONLY_XML);
  });

  it("re-GET after save returns the SAME author XML the client POSTed (round-trips clean, importXML-safe)", async () => {
    const state = { bpmnXml: null as string | null, version: 0, processKey: TIMER_ONLY_KEY, provisionedAgentIds: [] as string[] };
    const pool = makePool(state);
    const router = makeRouter();
    registerProcessDefsRoutes(router as any, pool as any, makeFlowable(), TEST_RESOLVER);

    await router.find("POST", "/api/process-defs")!.handler(
      makeReq(JSON.stringify({ processKey: TIMER_ONLY_KEY, name: "Timer Only", bpmnXml: TIMER_ONLY_XML })) as any,
      makeRes() as any, {},
    );

    const getRes = makeRes();
    await router.find("GET", `/api/process-defs/${TIMER_ONLY_KEY}`)!.handler(
      makeReq() as any, getRes as any, { key: TIMER_ONLY_KEY },
    );

    expect(getRes.statusCode).toBe(200);
    expect(getRes.json.bpmnXml).toBe(TIMER_ONLY_XML);
  });
});

// ---------------------------------------------------------------------------
// Gate 4: adjacent case — agentTask already-external (wired=false) + lane present.
// ---------------------------------------------------------------------------

describe("T-0641 gate 4 — adjacent case: agentTask already external + lane present still gets xmlns:flowable", () => {
  it("the chokepoint fires even though mapAgentTaskToExternal's own wired flag never does", async () => {
    const pool = makePool({
      bpmnXml: MIXED_ALREADY_EXTERNAL_PLUS_LANE_XML,
      version: 1,
      processKey: MIXED_KEY,
      provisionedAgentIds: [AGENT_ID],
    });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, MIXED_KEY);

    expect(result.status).toBe("published");
    const deployedXml = (flowable.deployBpmn as any).mock.calls[0][0] as string;
    // The lane wiring on "approve" needed the namespace — chokepoint supplied it
    // even though the agentTask was already external (its own guard stayed silent).
    expect(deployedXml).toMatch(/xmlns:flowable="http:\/\/flowable\.org\/bpmn"/);
    expect(deployedXml).toMatch(/<userTask\b[^>]*id="approve"[^>]*flowable:candidateGroups="buhgalter"/);
    // Exactly one xmlns:flowable declaration (not double-injected).
    expect((deployedXml.match(/xmlns:flowable=/g) ?? []).length).toBe(1);
  });
});
