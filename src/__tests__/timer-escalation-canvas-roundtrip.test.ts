/**
 * src/__tests__/timer-escalation-canvas-roundtrip.test.ts — T-0660 / T-0776.
 *
 * The UI-modeler task (web/src/canvas/*) adds a one-click affordance that builds a
 * NON-INTERRUPTING boundary timer + a converging escalation branch on the canvas
 * (see web/src/canvas/escalation-branch-builder.js). This test proves the shape
 * that affordance produces is actually PUBLISHABLE — it survives the SAME pure
 * publish pipeline the server runs (process-defs.ts publishProcessByKey), driven
 * here on fixtures so no DB / stand is needed:
 *
 *     mapLanesToCandidateGroups → mapTimerEscalation → lintBpmn → normalizeBpmnForDeploy
 *
 * T-0776 CORRECTION: T-0660 originally built the D2 shape (converging
 * exclusiveGateway → plain endEvent). T-0661 PROVED (live Flowable) that shape
 * HANGS once the timer fires — a converging exclusiveGateway is an uncontrolled
 * merge, so the second concurrent token a fired non-interrupting boundary timer
 * spawns is never extinguished — and added the `timer_escalation_unresolved_
 * concurrency` linter rule that now BLOCKS publishing it. T-0776 fixed the
 * builder (ADR-T0612 §8, decision D5) to instead enclose the race in an embedded
 * subProcess converging into a SCOPE-LOCAL terminateEndEvent — the first racer to
 * resolve ends the sub-process scope, cancelling the other, still-parked racer's
 * token. This file's fixture is updated to that D5 output; the assertions below
 * are otherwise unchanged (same pipeline, same "must lint clean" contract).
 *
 * BOUNDARY WITH T-0641: this test only READS the server pure functions
 * (timer-escalation-mapper.ts, bpmn-linter.ts, bpmn-deploy-normalizer.ts). It does
 * NOT modify them — the UI task owns web/, the sister T-0641/T-0661 own those
 * server files. The fixtures are the canvas builder's OUTPUT shapes; the
 * anti-case rule permits case-flavoured names in tests/fixtures (kept generic
 * here regardless).
 */

import { describe, it, expect } from "vitest";
import { mapLanesToCandidateGroups } from "../core/lane-role-mapper.js";
import { mapTimerEscalation } from "../core/timer-escalation-mapper.js";
import { lintBpmn } from "../core/bpmn-linter.js";
import { normalizeBpmnForDeploy } from "../core/bpmn-deploy-normalizer.js";

/**
 * The D5 shape the canvas affordance builds (ADR-T0612 §8 / T-0661, mirrors
 * docs/design/T-0612-purchaseApproval-fixed.bpmn20.xml.txt):
 *   subProcess (encloses the race):
 *     subStart → step ─┐
 *     timer → escTask ─┼→ gateway → terminateEnd (scope-local terminate)
 *   subProcess → next   (top level; the ONLY top-level flow change)
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
    <subProcess id="Sub_race" name="Шаг (гонка + эскалация)">
      <startEvent id="SubStart_1"/>
      <userTask id="Task_step" name="Шаг" flowable:candidateGroups="role-staff"/>
      <boundaryEvent id="Boundary_1" attachedToRef="Task_step" cancelActivity="false"
                     choros:timerDeadlineKind="duration" choros:timerDeadline="PT2H" choros:escalateTo="manager">
        <timerEventDefinition></timerEventDefinition>
      </boundaryEvent>
      <userTask id="Task_esc" name="Эскалация"/>
      <exclusiveGateway id="Gateway_conv" name="Продолжить"/>
      <endEvent id="Term_1" name="Решение принято">
        <terminateEventDefinition/>
      </endEvent>
      <sequenceFlow id="f_substart_step" sourceRef="SubStart_1" targetRef="Task_step"/>
      <sequenceFlow id="f_host_gw" sourceRef="Task_step" targetRef="Gateway_conv"/>
      <sequenceFlow id="f_gw_term" sourceRef="Gateway_conv" targetRef="Term_1"/>
      <sequenceFlow id="f_timer_esc" sourceRef="Boundary_1" targetRef="Task_esc"/>
      <sequenceFlow id="f_esc_gw" sourceRef="Task_esc" targetRef="Gateway_conv"/>
    </subProcess>
    <endEvent id="End_1"/>
    <sequenceFlow id="f_start" sourceRef="Start_1" targetRef="Sub_race"/>
    <sequenceFlow id="f_sub_end" sourceRef="Sub_race" targetRef="End_1"/>
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

/**
 * T-0776 negative control: the OLD D2 shape (T-0660's original build) — a
 * converging exclusiveGateway flowing to a PLAIN endEvent, no subProcess, no
 * terminate. T-0661 proved THIS EXACT SHAPE hangs once the timer fires (both
 * tasks open concurrently; the converging gateway is an uncontrolled merge
 * that cannot extinguish the second token). Kept here so a future regression
 * that reverts the builder to D2 is caught by THIS suite, not just
 * bpmn-linter.test.ts.
 */
function d2ConvergingNoTerminateShape(): string {
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

/** Run the save-time transforms (what the persisted draft carries). */
function saved(raw: string): string {
  return mapTimerEscalation(mapLanesToCandidateGroups(raw));
}

describe("T-0660/T-0776 — canvas-built D5 escalation branch is publishable", () => {
  it("passes lintBpmn with NO timer_escalation_no_convergence / timer_escalation_unresolved_concurrency violation", () => {
    const publishXml = saved(builtConvergingShape());
    const result = lintBpmn(publishXml);
    // Surface any violations for debugging before the ok assertion (ok:true has no
    // violations array — the D5 shape must be clean).
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

describe("T-0660/T-0776 — the publish gate is real (negative controls)", () => {
  it("the disconnected (non-converging) escalation shape FAILS lint with timer_escalation_no_convergence", () => {
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

  it("the OLD D2 shape (converging gateway → plain end, no terminate) FAILS lint with timer_escalation_unresolved_concurrency", () => {
    const publishXml = saved(d2ConvergingNoTerminateShape());
    const result = lintBpmn(publishXml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected lint to fail");
    const unresolved = result.violations.filter(
      (v) => v.type === "timer_escalation_unresolved_concurrency",
    );
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].elementId).toBe("Boundary_1");
    // And the OLD (already-fixed-by-T-0612) convergence check does NOT also fire —
    // the two violation types are mutually exclusive per timer (ADR §8 D6).
    const convergence = result.violations.filter(
      (v) => v.type === "timer_escalation_no_convergence",
    );
    expect(convergence).toHaveLength(0);
  });
});
