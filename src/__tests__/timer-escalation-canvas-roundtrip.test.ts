/**
 * src/__tests__/timer-escalation-canvas-roundtrip.test.ts — T-0660.
 *
 * The UI-modeler task (web/src/canvas/*) adds a one-click affordance that builds a
 * NON-INTERRUPTING boundary timer + a CONVERGING escalation branch on the canvas
 * (see web/src/canvas/escalation-branch-builder.js). This test proves the shape
 * that affordance produces is actually PUBLISHABLE — it survives the SAME pure
 * publish pipeline the server runs (process-defs.ts publishProcessByKey), driven
 * here on fixtures so no DB / stand is needed:
 *
 *     mapLanesToCandidateGroups → mapTimerEscalation → lintBpmn → normalizeBpmnForDeploy
 *
 * BOUNDARY WITH T-0641: this test only READS the server pure functions
 * (timer-escalation-mapper.ts, bpmn-linter.ts, bpmn-deploy-normalizer.ts). It does
 * NOT modify them — the UI task owns web/, the sister T-0641 owns those server
 * files. The fixtures are the canvas builder's OUTPUT shapes; the anti-case rule
 * permits case-flavoured names in tests/fixtures (kept generic here regardless).
 */

import { describe, it, expect } from "vitest";
import { mapLanesToCandidateGroups } from "../core/lane-role-mapper.js";
import { mapTimerEscalation } from "../core/timer-escalation-mapper.js";
import { lintBpmn } from "../core/bpmn-linter.js";
import { normalizeBpmnForDeploy } from "../core/bpmn-deploy-normalizer.js";

/**
 * The CONVERGING shape the canvas affordance builds:
 *   step  → gateway → next        (host's single path, rerouted THROUGH the gateway)
 *   timer → escTask → gateway     (escalation branch converging into the same gateway)
 * The boundary timer is non-interrupting (cancelActivity="false"). The typed timer
 * config (choros:*) is present but the body is not yet materialised — exactly the
 * draft state the modeler emits before publish.
 */
function builtConvergingShape(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:choros="http://choros.io/bpmn"
             xmlns:flowable="http://flowable.org/bpmn"
             targetNamespace="http://choros.io/proc">
  <process id="reminder_proc" isExecutable="true">
    <startEvent id="Start_1"/>
    <userTask id="Task_step" name="Шаг" flowable:candidateGroups="role-staff"/>
    <boundaryEvent id="Boundary_1" attachedToRef="Task_step" cancelActivity="false"
                   choros:timerDeadlineKind="duration" choros:timerDeadline="PT2H" choros:escalateTo="manager">
      <timerEventDefinition></timerEventDefinition>
    </boundaryEvent>
    <userTask id="Task_esc" name="Эскалация"/>
    <exclusiveGateway id="Gateway_conv" name="Продолжить"/>
    <endEvent id="End_1"/>
    <sequenceFlow id="f_start" sourceRef="Start_1" targetRef="Task_step"/>
    <sequenceFlow id="f_host_gw" sourceRef="Task_step" targetRef="Gateway_conv"/>
    <sequenceFlow id="f_gw_end" sourceRef="Gateway_conv" targetRef="End_1"/>
    <sequenceFlow id="f_timer_esc" sourceRef="Boundary_1" targetRef="Task_esc"/>
    <sequenceFlow id="f_esc_gw" sourceRef="Task_esc" targetRef="Gateway_conv"/>
  </process>
</definitions>`;
}

/**
 * The BROKEN shape a naive hand-build (or raw-XML upload) produces: non-interrupting
 * timer whose escalation branch flows to its OWN separate end, with NO convergence.
 * This is the T-0612 zombie shape. Used to prove the publish gate is REAL — the
 * canvas affordance must build the converging shape precisely to avoid this.
 */
function disconnectedEscalationShape(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:choros="http://choros.io/bpmn"
             xmlns:flowable="http://flowable.org/bpmn"
             targetNamespace="http://choros.io/proc">
  <process id="reminder_proc" isExecutable="true">
    <startEvent id="Start_1"/>
    <userTask id="Task_step" name="Шаг" flowable:candidateGroups="role-staff"/>
    <boundaryEvent id="Boundary_1" attachedToRef="Task_step" cancelActivity="false"
                   choros:timerDeadlineKind="duration" choros:timerDeadline="PT2H" choros:escalateTo="manager">
      <timerEventDefinition></timerEventDefinition>
    </boundaryEvent>
    <userTask id="Task_esc" name="Эскалация"/>
    <endEvent id="End_main"/>
    <endEvent id="End_esc"/>
    <sequenceFlow id="f_start" sourceRef="Start_1" targetRef="Task_step"/>
    <sequenceFlow id="f_host_end" sourceRef="Task_step" targetRef="End_main"/>
    <sequenceFlow id="f_timer_esc" sourceRef="Boundary_1" targetRef="Task_esc"/>
    <sequenceFlow id="f_esc_end" sourceRef="Task_esc" targetRef="End_esc"/>
  </process>
</definitions>`;
}

/** Run the save-time transforms (what the persisted draft carries). */
function saved(raw: string): string {
  return mapTimerEscalation(mapLanesToCandidateGroups(raw));
}

describe("T-0660 — canvas-built converging escalation branch is publishable", () => {
  it("passes lintBpmn with NO timer_escalation_no_convergence violation", () => {
    const publishXml = saved(builtConvergingShape());
    const result = lintBpmn(publishXml);
    // Surface any violations for debugging before the ok assertion (ok:true has no
    // violations array — the converging shape must be clean).
    if (!result.ok) expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("materialises the timer body + wires escalation candidateGroups onto «Эскалация»", () => {
    const publishXml = saved(builtConvergingShape());
    // The non-interrupting flag is preserved through the pipeline.
    expect(publishXml).toContain('cancelActivity="false"');
    // The native timer body is materialised so Flowable actually schedules it.
    expect(publishXml).toContain("<timeDuration>PT2H</timeDuration>");
    // The escalation node (the timer's target) gets the manager pool wired on.
    expect(publishXml).toMatch(/<userTask id="Task_esc"[^>]*flowable:candidateGroups="role-manager"/);
  });

  it("normalizeBpmnForDeploy accepts it and keeps cancelActivity=false in the deploy XML", () => {
    const publishXml = saved(builtConvergingShape());
    const deployXml = normalizeBpmnForDeploy(publishXml, "reminder_proc");
    expect(deployXml).toContain('cancelActivity="false"');
    expect(deployXml).toContain('isExecutable="true"');
    expect(deployXml).toContain('<process id="reminder_proc"');
  });
});

describe("T-0660 — the publish gate is real (negative control)", () => {
  it("the disconnected (non-converging) escalation shape FAILS lint", () => {
    const publishXml = saved(disconnectedEscalationShape());
    const result = lintBpmn(publishXml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected lint to fail");
    const convergence = result.violations.filter(
      (v) => v.type === "timer_escalation_no_convergence",
    );
    expect(convergence).toHaveLength(1);
    expect(convergence[0].elementId).toBe("Boundary_1");
  });
});
