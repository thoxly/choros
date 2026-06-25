/**
 * Unit tests for src/core/process-gen-validator.ts — T-0464 [D8-G3].
 *
 * Spec: docs/specs/text-first-solution-builder.spec.md §3.4.
 *
 * Contract under test:
 *   - validateGeneratedProcess REUSES lintBpmn (parallel/timer) — a draft that
 *     fails the deploy linter fails here too.
 *   - The NEW dead-branch / reachability guard catches unreachable nodes and
 *     dead-end (no-outgoing) non-terminal nodes that lintBpmn does not.
 *   - groundProcess surfaces gateway-condition fields and lane roles that do NOT
 *     exist in the supplied grounding context (cascade/ask markers, NOT lint).
 *   - A fully connected, grounded, lint-clean draft validates ok.
 *
 * ZERO NETWORK / ZERO DB / ZERO COST. Pure string-in / struct-out.
 */

import { describe, it, expect } from "vitest";
import {
  validateGeneratedProcess,
  groundProcess,
  formatLintFeedback,
  formatGroundingFeedback,
  type GroundingContext,
} from "../process-gen-validator.js";

// ---------------------------------------------------------------------------
// Fixtures — all CONNECTED unless the test is exercising the dead-branch guard.
// ---------------------------------------------------------------------------

/**
 * A well-formed linear process: start → task → exclusiveGateway → (big | small)
 * → end. The gateway branches on ${amount}. One lane «Бухгалтер» owns the task.
 * Fully reachable, no dead ends. Conditions reference field "amount".
 */
const GOOD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowable="http://flowable.org/bpmn"
             id="Definitions_ok" targetNamespace="http://choros.io/bpmn">
  <process id="Process_ok" isExecutable="true">
    <laneSet id="LaneSet_1">
      <lane id="Lane_buh" name="Бухгалтер">
        <flowNodeRef>Task_review</flowNodeRef>
      </lane>
    </laneSet>
    <startEvent id="Start_1"/>
    <userTask id="Task_review" name="Проверить заявку"/>
    <exclusiveGateway id="GW_amount"/>
    <userTask id="Task_extra" name="Доп. согласование"/>
    <endEvent id="End_ok"/>
    <endEvent id="End_small"/>
    <sequenceFlow id="f1" sourceRef="Start_1" targetRef="Task_review"/>
    <sequenceFlow id="f2" sourceRef="Task_review" targetRef="GW_amount"/>
    <sequenceFlow id="f3" sourceRef="GW_amount" targetRef="Task_extra">
      <conditionExpression>\${amount > 100000}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f4" sourceRef="GW_amount" targetRef="End_small">
      <conditionExpression>\${amount &lt;= 100000}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f5" sourceRef="Task_extra" targetRef="End_ok"/>
  </process>
</definitions>`;

/** The grounding world for GOOD_XML: field "amount" exists, role "buhgalter" exists. */
const GOOD_GROUNDING: GroundingContext = {
  fieldKeys: ["amount", "title"],
  roleSlugs: ["buhgalter", "director"],
};

/**
 * A process with an UNREACHABLE task (Task_orphan has no incoming flow) and a
 * DEAD-END task (Task_dead has no outgoing flow, is not an end event).
 */
const DEAD_BRANCH_XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             id="Definitions_dead" targetNamespace="http://choros.io/bpmn">
  <process id="Process_dead" isExecutable="true">
    <startEvent id="Start_1"/>
    <userTask id="Task_dead" name="Тупик"/>
    <userTask id="Task_orphan" name="Сирота"/>
    <endEvent id="End_1"/>
    <sequenceFlow id="f1" sourceRef="Start_1" targetRef="Task_dead"/>
  </process>
</definitions>`;

/** A process with no startEvent at all — no entry point. */
const NO_START_XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             id="Definitions_nostart" targetNamespace="http://choros.io/bpmn">
  <process id="Process_nostart" isExecutable="true">
    <userTask id="Task_a" name="A"/>
    <endEvent id="End_1"/>
    <sequenceFlow id="f1" sourceRef="Task_a" targetRef="End_1"/>
  </process>
</definitions>`;

/**
 * A process that fails the EXISTING parallel-gateway linter (T-0456): a parallel
 * gateway with 1 incoming and 0 outgoing (dangling). Proves we REUSE lintBpmn.
 */
const PARALLEL_FAIL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             id="Definitions_par" targetNamespace="http://choros.io/bpmn">
  <process id="Process_par" isExecutable="true">
    <startEvent id="Start_1"/>
    <parallelGateway id="PG_1"/>
    <endEvent id="End_1"/>
    <sequenceFlow id="f1" sourceRef="Start_1" targetRef="PG_1"/>
  </process>
</definitions>`;

// ---------------------------------------------------------------------------
// REUSE: a draft failing the deploy linter fails here too.
// ---------------------------------------------------------------------------

describe("validateGeneratedProcess REUSES lintBpmn (parallel gateway T-0456)", () => {
  it("flags a dangling parallel gateway via the existing linter", () => {
    const res = validateGeneratedProcess(PARALLEL_FAIL_XML, GOOD_GROUNDING);
    expect(res.ok).toBe(false);
    expect(res.lintViolations.some((v) => v.type === "parallel_gateway_imbalance")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEW dead-branch / reachability guard.
// ---------------------------------------------------------------------------

describe("dead-branch / reachability guard (NEW gen-specific check)", () => {
  it("flags an unreachable node and a dead-end node", () => {
    const res = validateGeneratedProcess(DEAD_BRANCH_XML, GOOD_GROUNDING);
    expect(res.ok).toBe(false);
    const msgs = res.lintViolations.map((v) => v.message).join("\n");
    // Task_orphan is unreachable from Start_1.
    expect(res.lintViolations.some((v) => v.elementId === "Task_orphan")).toBe(true);
    expect(msgs).toContain("unreachable");
    // Task_dead is reachable but a dead end (no outgoing).
    expect(res.lintViolations.some((v) => v.elementId === "Task_dead")).toBe(true);
    expect(msgs).toContain("dead end");
  });

  it("flags a process with no start event (no entry point)", () => {
    const res = validateGeneratedProcess(NO_START_XML, GOOD_GROUNDING);
    expect(res.ok).toBe(false);
    expect(res.lintViolations.some((v) => v.message.includes("no <startEvent>"))).toBe(true);
  });

  it("passes a fully connected process (no dead branches)", () => {
    const res = validateGeneratedProcess(GOOD_XML, GOOD_GROUNDING);
    // The only way this is ok is if reachability + grounding both pass.
    expect(res.lintViolations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GROUNDING: fields + roles vs the real world.
// ---------------------------------------------------------------------------

describe("groundProcess — gateway conditions and lane roles must be grounded", () => {
  it("returns NO gaps when fields and roles all exist", () => {
    const gaps = groundProcess(GOOD_XML, GOOD_GROUNDING);
    expect(gaps).toEqual([]);
  });

  it("flags a condition referencing a missing field (cascade/ask, not lint)", () => {
    const gaps = groundProcess(GOOD_XML, { fieldKeys: ["title"], roleSlugs: ["buhgalter"] });
    // "amount" is referenced by the gateway but not in fieldKeys → missing_field.
    const fieldGap = gaps.find((g) => g.kind === "missing_field");
    expect(fieldGap).toBeDefined();
    expect(fieldGap && fieldGap.kind === "missing_field" && fieldGap.fieldKey).toBe("amount");
  });

  it("flags a lane role that does not exist in the tenant", () => {
    const gaps = groundProcess(GOOD_XML, { fieldKeys: ["amount"], roleSlugs: ["director"] });
    // Lane «Бухгалтер» → slug "buhgalter", not in roleSlugs → missing_role.
    const roleGap = gaps.find((g) => g.kind === "missing_role");
    expect(roleGap).toBeDefined();
    expect(roleGap && roleGap.kind === "missing_role" && roleGap.roleSlug).toBe("buhgalter");
  });

  it("full validate surfaces the grounding gap (ok=false) when a field is missing", () => {
    const res = validateGeneratedProcess(GOOD_XML, { fieldKeys: ["title"], roleSlugs: ["buhgalter"] });
    expect(res.ok).toBe(false);
    expect(res.groundingGaps.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Feedback formatting — fed back to the bot.
// ---------------------------------------------------------------------------

describe("feedback formatting", () => {
  it("formatLintFeedback renders the element ids the bot must fix", () => {
    const res = validateGeneratedProcess(DEAD_BRANCH_XML, GOOD_GROUNDING);
    const text = formatLintFeedback(res.lintViolations);
    expect(text).toContain("Task_orphan");
    expect(text).toContain("Task_dead");
  });

  it("formatGroundingFeedback frames cascade-or-ask for missing field/role", () => {
    const gaps = groundProcess(GOOD_XML, { fieldKeys: [], roleSlugs: [] });
    const text = formatGroundingFeedback(gaps);
    expect(text).toContain("amount");
    expect(text.toLowerCase()).toContain("поле");
  });
});
