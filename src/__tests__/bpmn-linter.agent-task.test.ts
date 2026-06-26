/**
 * T-0460 [D8-R5] — bpmn-linter agent_task_incoherent coherence guard tests (FF-R5-5).
 *
 * A serviceTask the author marked as an agent step (choros:executorType="agent") MUST:
 *   - resolve to a known agentRef (choros:agentRef present), AND
 *   - carry the agent-step external-task shape (flowable:type="external" +
 *     flowable:topic="agent-step") post-transform.
 * A well-formed (post-transform) agent task PASSES; a half-wired one FAILS publish.
 */

import { describe, it, expect } from "vitest";
import { lintBpmn } from "../core/bpmn-linter.js";
import { mapAgentTaskToExternal } from "../core/agent-task-external-mapper.js";

const NS =
  'xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:flowable="http://flowable.org/bpmn" ' +
  'xmlns:choros="http://choros.io/bpmn"';

function proc(body: string): string {
  return `<definitions ${NS}><process id="p1">${body}</process></definitions>`;
}

const AGENT_ID = "d0000000-0000-0000-0000-000000000006";

function violationsOfType(xml: string, type: string): number {
  const r = lintBpmn(xml);
  if (r.ok) return 0;
  return r.violations.filter((v) => v.type === type).length;
}

describe("bpmn-linter agent_task_incoherent — POSITIVE (well-formed passes)", () => {
  it("a published (post-transform) agent task with ref + external shape passes", () => {
    const wired = mapAgentTaskToExternal(
      proc(
        `<serviceTask id="t1" name="Триаж" choros:executorType="agent" ` +
          `choros:agentRef="${AGENT_ID}" choros:assignedRoleId="role-x"/>`,
      ),
    );
    expect(lintBpmn(wired).ok).toBe(true);
  });

  it("a non-agent external serviceTask is ignored by this check (no false positive)", () => {
    const xml = proc(`<serviceTask id="t1" name="Notify" flowable:type="external" flowable:topic="notify"/>`);
    expect(violationsOfType(xml, "agent_task_incoherent")).toBe(0);
  });

  it("a diagram with no agent tasks is clean", () => {
    const xml = proc(`<userTask id="u1" name="Approve"/>`);
    expect(violationsOfType(xml, "agent_task_incoherent")).toBe(0);
  });
});

describe("bpmn-linter agent_task_incoherent — NEGATIVE (half-wired fails)", () => {
  it("agent step with NO agentRef fails", () => {
    // external shape present but no agentRef → cannot resolve an agent.
    const xml = proc(
      `<serviceTask id="t1" name="Step" choros:executorType="agent" ` +
        `flowable:type="external" flowable:topic="agent-step"/>`,
    );
    expect(violationsOfType(xml, "agent_task_incoherent")).toBeGreaterThanOrEqual(1);
  });

  it("agent step NOT externalised (no flowable:type) fails", () => {
    const xml = proc(
      `<serviceTask id="t1" name="Step" choros:executorType="agent" ` +
        `choros:agentRef="${AGENT_ID}"/>`,
    );
    expect(violationsOfType(xml, "agent_task_incoherent")).toBeGreaterThanOrEqual(1);
  });

  it("agent step external on the WRONG topic fails", () => {
    const xml = proc(
      `<serviceTask id="t1" name="Step" choros:executorType="agent" ` +
        `choros:agentRef="${AGENT_ID}" flowable:type="external" flowable:topic="tel-intake"/>`,
    );
    expect(violationsOfType(xml, "agent_task_incoherent")).toBeGreaterThanOrEqual(1);
  });

  it("agent step with NO id fails", () => {
    const xml = proc(
      `<serviceTask name="Step" choros:executorType="agent" ` +
        `choros:agentRef="${AGENT_ID}" flowable:type="external" flowable:topic="agent-step"/>`,
    );
    expect(violationsOfType(xml, "agent_task_incoherent")).toBeGreaterThanOrEqual(1);
  });
});
