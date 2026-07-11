/**
 * T-0660 — the mouse-built escalation branch is a WELL-FORMED, RENDERABLE model.
 *
 * applyEscalationBranch builds the branch on a LIVE bpmn-js modeler, where
 * appendShape/connect generate diagram-interchange (DI) automatically. Headless
 * (node env, no DOM) we prove the resulting SHAPE is sound two ways:
 *
 *   1. bpmn-auto-layout (the same DOM-free engine bpmn-ensure-layout uses for
 *      DI-less imports) places every node — the new «Эскалация» userTask and
 *      «Продолжить» gateway get BPMNShape geometry → the branch is renderable on
 *      the canvas — while preserving cancelActivity="false" and the choros config.
 *   2. bpmn-moddle re-imports the model with zero warnings and reads
 *      cancelActivity=false back off the boundary event → the round-trip is clean.
 *
 * The FIXTURE below is exactly the converging topology applyEscalationBranch
 * produces (see escalation-branch-builder.test.js for the ops that produce it):
 *   step  → gateway → next          (host's single path, rerouted THROUGH gateway)
 *   timer → escTask → gateway       (escalation branch converging into gateway)
 */

import { describe, it, expect } from 'vitest';
import { layoutProcess } from 'bpmn-auto-layout';
import BpmnModdle from 'bpmn-moddle';
import descriptor from './choros-moddle-extension.js';

// The mouse-built converging shape (no DI yet — DI is what we compute/verify).
const BUILT_SHAPE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:choros="http://choros.io/bpmn"
             xmlns:flowable="http://flowable.org/bpmn"
             targetNamespace="http://choros.io/proc">
  <process id="reminder_proc" isExecutable="true">
    <startEvent id="Start_1"/>
    <userTask id="Task_step" name="Шаг"/>
    <boundaryEvent id="Boundary_1" attachedToRef="Task_step" cancelActivity="false"
                   choros:timerDeadlineKind="duration" choros:timerDeadline="PT2H" choros:escalateTo="manager">
      <timerEventDefinition><timeDuration>PT2H</timeDuration></timerEventDefinition>
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

describe('T-0660 — built escalation branch lays out with DI', () => {
  it('bpmn-auto-layout places the new escalation task + gateway (renderable) and preserves config', async () => {
    const out = await layoutProcess(BUILT_SHAPE);
    // A diagram-interchange plane now exists (bpmn-js needs this to draw).
    expect(out).toMatch(/BPMNDiagram/);
    // The NEW nodes the mouse-build added get concrete geometry → they render.
    expect(out).toMatch(/bpmnElement="Task_esc"/);
    expect(out).toMatch(/bpmnElement="Gateway_conv"/);
    expect(out).toMatch(/<dc:Bounds[^>]*width="100"/); // the escalation userTask box
    // The non-interrupting flag + escalation config survive the layout transform.
    expect(out).toMatch(/cancelActivity="false"/);
    expect(out).toMatch(/choros:escalateTo="manager"/);
  });
});

describe('T-0660 — built escalation branch re-imports cleanly', () => {
  it('bpmn-moddle imports with zero warnings and reads cancelActivity=false', async () => {
    const moddle = new BpmnModdle({ choros: descriptor });
    const { rootElement, warnings } = await moddle.fromXML(BUILT_SHAPE);
    expect(warnings).toHaveLength(0);
    const proc = rootElement.rootElements[0];
    const boundary = proc.flowElements.find((e) => e.id === 'Boundary_1');
    expect(boundary.$type).toBe('bpmn:BoundaryEvent');
    // Native BPMN attribute round-trips as a real boolean false (non-interrupting).
    expect(boundary.cancelActivity).toBe(false);
    // The escalation branch converges: timer→esc, esc→gateway, host→gateway, gateway→end.
    const flows = proc.flowElements.filter((e) => e.$type === 'bpmn:SequenceFlow');
    const pair = (id) => { const f = flows.find((x) => x.id === id); return [f.sourceRef.id, f.targetRef.id]; };
    expect(pair('f_timer_esc')).toEqual(['Boundary_1', 'Task_esc']);
    expect(pair('f_esc_gw')).toEqual(['Task_esc', 'Gateway_conv']);
    expect(pair('f_host_gw')).toEqual(['Task_step', 'Gateway_conv']);
    expect(pair('f_gw_end')).toEqual(['Gateway_conv', 'End_1']);
  });
});
