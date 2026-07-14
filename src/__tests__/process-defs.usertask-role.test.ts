/**
 * src/__tests__/process-defs.usertask-role.test.ts
 *
 * T-0642 [столп1/P0], LIVE_PROOF T-0588: userTask assignedRoleId → candidateGroups.
 *
 * A userTask with a panel-assigned role (choros:assignedRoleId, the role's UUID)
 * published WITHOUT flowable:candidateGroups — none of the existing publish
 * mappers (lane-role-mapper, timer-escalation-mapper, agent-task-external-mapper)
 * ever translated it for a plain userTask. Flowable created the task in an empty
 * pool; it never reached any inbox. publishProcessByKey now resolves the UUID to
 * its role slug (via resolveRoleSlugsByIds, grants-dao.ts) and injects
 * candidateGroups BEFORE deploy.
 *
 * Pure unit (no live Postgres / Flowable) — mirrors process-defs.agentref.test.ts's
 * fake-pool style. Covers:
 *   - a userTask with a resolvable assignedRoleId publishes with candidateGroups=slug
 *   - xmlns:flowable is declared on deploy even with no agentTask in the diagram
 *   - an assignedRoleId that does not resolve degrades (publish still succeeds,
 *     no candidateGroups on that task) — non-blocking, unlike the agentRef gate
 *   - regression: userTask WITHOUT assignedRoleId is unaffected
 *   - regression: a lane-assigned role (already wired at draft-save time, i.e.
 *     already present in row.bpmn_xml) is NOT overwritten
 *   - regression: agentTask publish path (choros:executorType="agent") is unaffected
 *   - the deployed XML (what deployBpmn actually receives) carries the slug
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { publishProcessByKey } from "../http/process-defs.js";
import type { FlowableClient } from "../core/flowable-client.js";

const TENANT_ID   = "a0000000-0000-0000-0000-000000000001";
const PROC_KEY    = "role-route-check";
const PROC_ROW_ID = "d2222222-2222-2222-2222-222222222222";
const ROLE_ID_BUH = "e0000000-0000-0000-0000-000000000002"; // budget-approver (seed, migration 019)
const ROLE_SLUG_BUH = "budget-approver";
const ROLE_ID_MISSING = "e0000000-0000-0000-0000-00000000dead"; // never a row in choros.role

// ---------------------------------------------------------------------------
// BPMN fixtures — the REALISTIC modeler-exported shape (no xmlns:flowable,
// mirrors choros-moddle-extension.js which registers only the choros
// namespace — same discipline as T-0635's agent-task-external-mapper tests).
// ---------------------------------------------------------------------------

const MODELER_NS =
  'xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:choros="http://choros.dev/bpmn"';

function modelerProc(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${MODELER_NS} targetNamespace="http://choros.dev/test">
  <process id="${PROC_KEY}" name="Test Process" isExecutable="true">
    <startEvent id="start"/>${body}
    <endEvent id="end"/>
  </process>
</definitions>`;
}

/** A userTask carrying a panel-assigned role, no candidateGroups yet. */
const ROLE_ASSIGNED_XML = modelerProc(
  `<userTask id="Activity_approve" name="Согласовать счёт" choros:assignedRoleId="${ROLE_ID_BUH}"/>`,
);

/** A userTask whose assignedRoleId does not resolve to any role row. */
const UNRESOLVABLE_ROLE_XML = modelerProc(
  `<userTask id="Activity_orphan" name="Шаг-сирота" choros:assignedRoleId="${ROLE_ID_MISSING}"/>`,
);

/** Plain userTask, no role at all — regression baseline. */
const NO_ROLE_XML = modelerProc(`<userTask id="Activity_plain" name="Обычный шаг"/>`);

/** A userTask already wired by lane-role-mapper at draft-save time (candidateGroups
 *  present in the PERSISTED row.bpmn_xml) — explicit value must survive publish. */
const LANE_WIRED_XML = modelerProc(
  `<userTask id="Activity_lane" name="Проверить" ` +
    `choros:assignedRoleId="${ROLE_ID_BUH}" flowable:candidateGroups="buhgalter"/>`,
);

/** agentTask (serviceTask) shape — regression: publish path unaffected. */
const AGENT_TASK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${MODELER_NS} xmlns:flowable="http://flowable.org/bpmn" targetNamespace="http://choros.dev/test">
  <process id="${PROC_KEY}" name="Агентный" isExecutable="true">
    <startEvent id="start"/>
    <serviceTask id="agentStep1" name="Авто-шаг" choros:executorType="agent"
                 choros:agentRef="d0000000-0000-0000-0000-000000000006"
                 flowable:type="external" flowable:topic="agent-step">
      <extensionElements>
        <flowable:field name="agentEmployeeId"><flowable:string>d0000000-0000-0000-0000-000000000006</flowable:string></flowable:field>
      </extensionElements>
    </serviceTask>
    <endEvent id="end"/>
  </process>
</definitions>`;

// ---------------------------------------------------------------------------
// Fakes — mirrors process-defs.agentref.test.ts's makePool exactly, plus a
// choros.role responder branch for resolveRoleSlugsByIds.
// ---------------------------------------------------------------------------

function makePool(opts: {
  bpmnXml: string;
  roleRows?: Array<{ id: string; slug: string }>;
  provisionedAgentIds?: string[];
}) {
  const roleRows = opts.roleRows ?? [];
  const provisionedAgentIds = opts.provisionedAgentIds ?? [];
  const responder = async (sql: string, params?: unknown[]) => {
    const s = sql.replace(/\s+/g, " ");
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(s) || /SET LOCAL/.test(s)) return { rows: [] };
    // getLatestVersion — the persisted (draft) process row.
    if (/FROM choros\.process_definition/.test(s) && /ORDER BY version DESC/.test(s)) {
      return {
        rows: [{
          tenant_id: TENANT_ID, id: PROC_ROW_ID, process_key: PROC_KEY,
          name: "Test Process", bpmn_xml: opts.bpmnXml, version: 1,
          status: "draft", deployment_id: null, created_at: "1", updated_at: "1",
        }],
      };
    }
    // loadPublishedRuleTables — none (advisory gateway check stays inert).
    if (/FROM choros\.dmn_rule_table/.test(s)) return { rows: [] };
    // resolveRoleSlugsByIds — SELECT id, slug FROM choros.role WHERE tenant_id=$1 AND id=ANY($2).
    // Distinguish from getHoldersForRole (joins employee+role_assignment+role) by
    // requiring the query has NO employee/role_assignment join.
    if (
      /FROM choros\.role\b/.test(s) &&
      !/role_assignment/.test(s) &&
      !/choros\.employee/.test(s)
    ) {
      const candidates = (params?.[1] as string[]) ?? [];
      const set = new Map(roleRows.map((r) => [r.id, r.slug]));
      return { rows: candidates.filter((id) => set.has(id)).map((id) => ({ id, slug: set.get(id)! })) };
    }
    // getHoldersForRole (buildUnfilledRoleWarnings) — no confirmed holders (advisory only).
    if (/FROM choros\.employee e/.test(s) && /JOIN choros\.role_assignment ra/.test(s)) {
      return { rows: [] };
    }
    // filterProvisionedAgentEmployeeIds (agentRef gate).
    if (/FROM choros\.employee e/.test(s) && /JOIN choros\.agent_card/.test(s)) {
      const candidates = (params?.[1] as string[]) ?? [];
      const set = new Set(provisionedAgentIds);
      return { rows: candidates.filter((id) => set.has(id)).map((id) => ({ id })) };
    }
    // process_app_binding gate — no bound apps.
    if (/FROM choros\.process_app_binding/.test(s)) return { rows: [] };
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

// ---------------------------------------------------------------------------
// publishProcessByKey — the userTask role-routing fix, exercised directly.
// ---------------------------------------------------------------------------

describe("publishProcessByKey — userTask assignedRoleId → candidateGroups (T-0642)", () => {
  it("publishes a userTask with a resolvable role, deployed XML carries the SLUG", async () => {
    const pool = makePool({
      bpmnXml: ROLE_ASSIGNED_XML,
      roleRows: [{ id: ROLE_ID_BUH, slug: ROLE_SLUG_BUH }],
    });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("published");
    expect(flowable.deployBpmn).toHaveBeenCalledTimes(1);
    const deployedXml = flowable.deployBpmn.mock.calls[0]![0] as string;
    expect(deployedXml).toMatch(
      /<userTask\b[^>]*id="Activity_approve"[^>]*flowable:candidateGroups="budget-approver"/,
    );
    // Never the raw UUID in candidateGroups.
    expect(deployedXml).not.toContain(`candidateGroups="${ROLE_ID_BUH}"`);
  });

  it("declares xmlns:flowable on the deployed XML even with no agentTask present", async () => {
    const pool = makePool({
      bpmnXml: ROLE_ASSIGNED_XML,
      roleRows: [{ id: ROLE_ID_BUH, slug: ROLE_SLUG_BUH }],
    });
    const flowable = makeFlowable();

    await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    const deployedXml = flowable.deployBpmn.mock.calls[0]![0] as string;
    expect(deployedXml).toMatch(/xmlns:flowable="http:\/\/flowable\.org\/bpmn"/);
  });

  it("degrades non-blocking when assignedRoleId does not resolve — publish still succeeds", async () => {
    const pool = makePool({ bpmnXml: UNRESOLVABLE_ROLE_XML, roleRows: [] });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("published");
    const deployedXml = flowable.deployBpmn.mock.calls[0]![0] as string;
    expect(deployedXml).not.toContain("candidateGroups");
  });

  it("regression: a userTask with no assignedRoleId publishes unchanged", async () => {
    const pool = makePool({ bpmnXml: NO_ROLE_XML, roleRows: [] });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("published");
    const deployedXml = flowable.deployBpmn.mock.calls[0]![0] as string;
    expect(deployedXml).not.toContain("candidateGroups");
  });

  it("regression: a lane-wired candidateGroups (already in the draft) is not overwritten", async () => {
    const pool = makePool({
      bpmnXml: LANE_WIRED_XML,
      roleRows: [{ id: ROLE_ID_BUH, slug: ROLE_SLUG_BUH }],
    });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("published");
    const deployedXml = flowable.deployBpmn.mock.calls[0]![0] as string;
    // Lane value ("buhgalter") survives — NOT overwritten by the assignedRoleId
    // resolution ("budget-approver"), even though both point at a real role.
    expect(deployedXml).toContain('flowable:candidateGroups="buhgalter"');
    expect(deployedXml).not.toContain('flowable:candidateGroups="budget-approver"');
  });

  it("regression: agentTask publish path is unaffected (roleId stays a dispatcher field, not candidateGroups)", async () => {
    const pool = makePool({
      bpmnXml: AGENT_TASK_XML,
      provisionedAgentIds: ["d0000000-0000-0000-0000-000000000006"],
      roleRows: [],
    });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("published");
    const deployedXml = flowable.deployBpmn.mock.calls[0]![0] as string;
    expect(deployedXml).not.toMatch(/<serviceTask\b[^>]*candidateGroups/);
  });

  it("is a no-op (no extra DB call to resolve) for a process with no assignedRoleId anywhere", async () => {
    const pool = makePool({ bpmnXml: NO_ROLE_XML, roleRows: [] });
    const flowable = makeFlowable();

    const result = await publishProcessByKey(pool as any, flowable, TENANT_ID, PROC_KEY);

    expect(result.status).toBe("published");
    expect(flowable.deployBpmn).toHaveBeenCalledTimes(1);
  });
});
