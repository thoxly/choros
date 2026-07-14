/**
 * T-0660/T-0776 — the mouse-built escalation branch is a WELL-FORMED,
 * RENDERABLE, PUBLISHABLE model (D5, ADR-T0612 §8 / T-0661).
 *
 * applyEscalationBranch builds the branch on a LIVE bpmn-js modeler, where
 * createShape/appendShape/connect generate diagram-interchange (DI)
 * automatically. Headless (node env, no DOM) we prove the resulting SHAPE is
 * sound two ways:
 *
 *   1. bpmn-auto-layout (the same DOM-free engine bpmn-ensure-layout uses for
 *      DI-less imports) places every node — the subProcess, its none-start,
 *      the new «Эскалация» userTask, the «Продолжить» gateway, and the
 *      scope-local terminate end — all get BPMNShape geometry → the branch is
 *      renderable on the canvas — while preserving cancelActivity="false" and
 *      the choros config.
 *   2. bpmn-moddle re-imports the model with zero warnings and reads
 *      cancelActivity=false back off the boundary event → the round-trip is
 *      clean.
 *
 * The FIXTURE below is exactly the D5 topology applyEscalationBranch produces
 * (see escalation-branch-builder.test.js for the ops that produce it):
 *   subProcess (encloses): subStart → step ─┐
 *                          timer → escTask ──┼→ gateway → terminateEnd (scope-local)
 *   subProcess → next   (top level; replaces the old step → next flow)
 */

import { describe, it, expect } from 'vitest';
import { layoutProcess } from 'bpmn-auto-layout';
import BpmnModdle from 'bpmn-moddle';
import descriptor from './choros-moddle-extension.js';

// The mouse-built D5 shape (no DI yet — DI is what we compute/verify).
const BUILT_SHAPE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:choros="http://choros.io/bpmn"
             xmlns:flowable="http://flowable.org/bpmn"
             targetNamespace="http://choros.io/proc">
  <process id="reminder_proc" isExecutable="true">
    <startEvent id="Start_1"/>
    <subProcess id="Sub_1" name="Шаг с напоминанием (гонка + эскалация)">
      <startEvent id="SubStart_1"/>
      <userTask id="Task_step" name="Шаг"/>
      <boundaryEvent id="Boundary_1" attachedToRef="Task_step" cancelActivity="false"
                     choros:timerDeadlineKind="duration" choros:timerDeadline="PT2H" choros:escalateTo="manager">
        <timerEventDefinition><timeDuration>PT2H</timeDuration></timerEventDefinition>
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
    <sequenceFlow id="f_start" sourceRef="Start_1" targetRef="Sub_1"/>
    <sequenceFlow id="f_sub_end" sourceRef="Sub_1" targetRef="End_1"/>
  </process>
</definitions>`;

describe('T-0660/T-0776 — built D5 escalation branch lays out with DI', () => {
  it('bpmn-auto-layout places the subProcess + its contents (renderable) and preserves config', async () => {
    const out = await layoutProcess(BUILT_SHAPE);
    // A diagram-interchange plane now exists (bpmn-js needs this to draw).
    expect(out).toMatch(/BPMNDiagram/);
    // The NEW nodes the mouse-build added get concrete geometry → they render.
    expect(out).toMatch(/bpmnElement="Sub_1"/);
    expect(out).toMatch(/bpmnElement="SubStart_1"/);
    expect(out).toMatch(/bpmnElement="Task_esc"/);
    expect(out).toMatch(/bpmnElement="Gateway_conv"/);
    expect(out).toMatch(/bpmnElement="Term_1"/);
    expect(out).toMatch(/<dc:Bounds[^>]*width="100"/); // the escalation userTask box
    // The non-interrupting flag + escalation config survive the layout transform.
    expect(out).toMatch(/cancelActivity="false"/);
    expect(out).toMatch(/choros:escalateTo="manager"/);
  });
});

describe('T-0660/T-0776 — built D5 escalation branch re-imports cleanly', () => {
  it('bpmn-moddle imports with zero warnings and reads cancelActivity=false + scope-local terminate', async () => {
    const moddle = new BpmnModdle({ choros: descriptor });
    const { rootElement, warnings } = await moddle.fromXML(BUILT_SHAPE);
    expect(warnings).toHaveLength(0);
    const proc = rootElement.rootElements[0];
    const subProcess = proc.flowElements.find((e) => e.id === 'Sub_1');
    expect(subProcess.$type).toBe('bpmn:SubProcess');
    const boundary = subProcess.flowElements.find((e) => e.id === 'Boundary_1');
    expect(boundary.$type).toBe('bpmn:BoundaryEvent');
    // Native BPMN attribute round-trips as a real boolean false (non-interrupting).
    expect(boundary.cancelActivity).toBe(false);
    // The scope-local terminate end carries a TerminateEventDefinition.
    const term = subProcess.flowElements.find((e) => e.id === 'Term_1');
    expect(term.$type).toBe('bpmn:EndEvent');
    expect(term.eventDefinitions).toHaveLength(1);
    expect(term.eventDefinitions[0].$type).toBe('bpmn:TerminateEventDefinition');
    // The escalation branch converges INSIDE the subProcess into a
    // scope-local terminate — NOT a plain end (that is the D2 shape T-0661
    // proved hangs): timer→esc, esc→gateway, host→gateway, gateway→terminate.
    const flows = subProcess.flowElements.filter((e) => e.$type === 'bpmn:SequenceFlow');
    const pair = (id) => { const f = flows.find((x) => x.id === id); return [f.sourceRef.id, f.targetRef.id]; };
    expect(pair('f_timer_esc')).toEqual(['Boundary_1', 'Task_esc']);
    expect(pair('f_esc_gw')).toEqual(['Task_esc', 'Gateway_conv']);
    expect(pair('f_host_gw')).toEqual(['Task_step', 'Gateway_conv']);
    expect(pair('f_gw_term')).toEqual(['Gateway_conv', 'Term_1']);
    // Top level: subProcess flows onward to the shared end.
    const topFlows = proc.flowElements.filter((e) => e.$type === 'bpmn:SequenceFlow');
    const topPair = (id) => { const f = topFlows.find((x) => x.id === id); return [f.sourceRef.id, f.targetRef.id]; };
    expect(topPair('f_sub_end')).toEqual(['Sub_1', 'End_1']);
  });
});
