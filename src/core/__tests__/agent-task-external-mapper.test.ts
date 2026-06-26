/**
 * Unit tests for T-0460 [D8-R5] mapAgentTaskToExternal — the authoring→runtime seam.
 *
 * Covers (FF-R5-1 / FF-R5-2, static-now — no DB / network / LLM):
 *  - PURE + idempotent (f(f(x))==f(x)) + additive: agent serviceTask gains the
 *    external-task shape; non-agent tasks + already-external tasks + no-agent diagrams
 *    are untouched.
 *  - The stamped external task carries flowable:type="external" + flowable:topic=
 *    AGENT_STEP_TOPIC AND the dispatcher variable keys (agentEmployeeId from
 *    choros:agentRef, roleId, stepName, agentReadsFields/agentWritesFields).
 *  - agentRef → agentEmployeeId is the identity mapping.
 *  - Self-closing and paired serviceTask forms both wire correctly.
 *  - Cross-check: the published task passes lintBpmn (no agent_task_incoherent).
 */

import { describe, it, expect } from "vitest";
import {
  mapAgentTaskToExternal,
  extractAgentTaskConfigs,
  AGENT_STEP_TOPIC,
} from "../agent-task-external-mapper.js";
import { lintBpmn } from "../bpmn-linter.js";

const NS =
  'xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:flowable="http://flowable.org/bpmn" ' +
  'xmlns:choros="http://choros.io/bpmn"';

/** Wrap body fragments in a minimal well-formed process so lintBpmn accepts it. */
function proc(body: string): string {
  return `<definitions ${NS}><process id="p1">${body}</process></definitions>`;
}

const AGENT_ID = "d0000000-0000-0000-0000-000000000006";
const ROLE_ID = "role-intake-agent";

/** A paired agent serviceTask carrying the full authored config. */
function agentTaskPaired(): string {
  return (
    `<serviceTask id="task-triage" name="Триаж" ` +
    `choros:executorType="agent" choros:agentRef="${AGENT_ID}" ` +
    `choros:assignedRoleId="${ROLE_ID}" choros:agentReadsFields="amount,vendor" ` +
    `choros:agentWritesFields="decision">` +
    `<documentation>agent step</documentation>` +
    `</serviceTask>`
  );
}

describe("mapAgentTaskToExternal — externalisation (FF-R5-1)", () => {
  it("stamps flowable:type=external + flowable:topic=agent-step onto an agent serviceTask", () => {
    const out = mapAgentTaskToExternal(proc(agentTaskPaired()));
    expect(out).toContain('flowable:type="external"');
    expect(out).toContain(`flowable:topic="${AGENT_STEP_TOPIC}"`);
    expect(AGENT_STEP_TOPIC).toBe("agent-step");
  });

  it("wires a SELF-CLOSING agent serviceTask (expands to a paired element with a body)", () => {
    const selfClose =
      `<serviceTask id="t1" name="Step" choros:executorType="agent" ` +
      `choros:agentRef="${AGENT_ID}" choros:assignedRoleId="${ROLE_ID}"/>`;
    const out = mapAgentTaskToExternal(proc(selfClose));
    expect(out).toContain('flowable:type="external"');
    expect(out).toContain(`flowable:topic="${AGENT_STEP_TOPIC}"`);
    expect(out).toContain("</serviceTask>"); // expanded from self-close to paired
    expect(out).toContain("<extensionElements>");
  });

  it("is IDEMPOTENT — f(f(x)) == f(x) (re-running does not double-stamp)", () => {
    const once = mapAgentTaskToExternal(proc(agentTaskPaired()));
    const twice = mapAgentTaskToExternal(once);
    expect(twice).toBe(once);
    // exactly one type/topic attribute pair.
    expect((once.match(/flowable:type="external"/g) ?? []).length).toBe(1);
    expect((once.match(/flowable:topic=/g) ?? []).length).toBe(1);
  });

  it("leaves an ALREADY-external agent serviceTask untouched (author / prior wins)", () => {
    const already =
      `<serviceTask id="t1" name="Step" choros:executorType="agent" ` +
      `choros:agentRef="${AGENT_ID}" flowable:type="external" flowable:topic="agent-step"/>`;
    const input = proc(already);
    expect(mapAgentTaskToExternal(input)).toBe(input);
  });

  it("ADDITIVE — a non-agent serviceTask is untouched", () => {
    const nonAgent = `<serviceTask id="t1" name="Notify" flowable:type="external" flowable:topic="notify"/>`;
    const input = proc(nonAgent);
    expect(mapAgentTaskToExternal(input)).toBe(input);
  });

  it("ADDITIVE — a diagram with NO agent tasks is returned byte-identical", () => {
    const input = proc(`<userTask id="u1" name="Approve"/><serviceTask id="s1" name="X"/>`);
    expect(mapAgentTaskToExternal(input)).toBe(input);
  });

  it("an id-less agent serviceTask is skipped by the transform (linter flags it separately)", () => {
    const noId = `<serviceTask name="Step" choros:executorType="agent" choros:agentRef="${AGENT_ID}"/>`;
    const input = proc(noId);
    // No id → cannot be targeted/addressed → transform leaves it (the linter rejects it).
    expect(mapAgentTaskToExternal(input)).toBe(input);
  });
});

describe("mapAgentTaskToExternal — variable threading (FF-R5-2)", () => {
  it("stamps the EXACT dispatcher variable keys via flowable:field", () => {
    const out = mapAgentTaskToExternal(proc(agentTaskPaired()));
    // agentEmployeeId ← agentRef (identity). roleId, stepName, read/write field sets.
    expect(out).toContain('<flowable:field name="agentEmployeeId">');
    expect(out).toContain(`<flowable:string>${AGENT_ID}</flowable:string>`);
    expect(out).toContain('<flowable:field name="roleId">');
    expect(out).toContain(`<flowable:string>${ROLE_ID}</flowable:string>`);
    expect(out).toContain('<flowable:field name="stepName">');
    expect(out).toContain("<flowable:string>Триаж</flowable:string>");
    expect(out).toContain('<flowable:field name="agentReadsFields">');
    expect(out).toContain("<flowable:string>amount,vendor</flowable:string>");
    expect(out).toContain('<flowable:field name="agentWritesFields">');
  });

  it("agentRef → agentEmployeeId is the IDENTITY mapping (same value under both keys)", () => {
    const cfgs = extractAgentTaskConfigs(proc(agentTaskPaired()));
    expect(cfgs.length).toBe(1);
    expect(cfgs[0].agentRef).toBe(AGENT_ID);
    const out = mapAgentTaskToExternal(proc(agentTaskPaired()));
    // The agentEmployeeId field value equals the authored agentRef.
    const m = out.match(/name="agentEmployeeId"><flowable:string>([^<]+)</);
    expect(m?.[1]).toBe(AGENT_ID);
  });

  it("omits a field whose authored value is absent (no empty entries)", () => {
    const minimal =
      `<serviceTask id="t1" name="Step" choros:executorType="agent" ` +
      `choros:agentRef="${AGENT_ID}"/>`; // no roleId / reads / writes
    const out = mapAgentTaskToExternal(proc(minimal));
    expect(out).toContain('name="agentEmployeeId"');
    expect(out).toContain('name="stepName"');
    expect(out).not.toContain('name="roleId"');
    expect(out).not.toContain('name="agentReadsFields"');
  });

  it("XML-escapes a field value (defence against injection in the authored ref/name)", () => {
    const dodgy =
      `<serviceTask id="t1" name="A &amp; B &lt;x&gt;" choros:executorType="agent" ` +
      `choros:agentRef="${AGENT_ID}"/>`;
    const out = mapAgentTaskToExternal(proc(dodgy));
    // The injected stepName must be re-escaped (no raw < or unescaped & in the field).
    expect(out).toContain("A &amp; B &lt;x&gt;");
  });
});

describe("mapAgentTaskToExternal — cross-check with the linter (FF-R5-1/5)", () => {
  it("the published agent task PASSES lintBpmn (no agent_task_incoherent)", () => {
    const out = mapAgentTaskToExternal(proc(agentTaskPaired()));
    const result = lintBpmn(out);
    expect(result.ok).toBe(true);
  });

  it("an unwired agent task (transform NOT applied) FAILS lintBpmn", () => {
    const result = lintBpmn(proc(agentTaskPaired()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.type === "agent_task_incoherent")).toBe(true);
    }
  });

  it("PURE — no IO: the function only reads its string argument (smoke: deterministic)", () => {
    const a = mapAgentTaskToExternal(proc(agentTaskPaired()));
    const b = mapAgentTaskToExternal(proc(agentTaskPaired()));
    expect(a).toBe(b);
  });
});
