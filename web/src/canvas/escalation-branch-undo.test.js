// @vitest-environment jsdom
/**
 * T-0660 U-1 — ATOMICITY pin against the REAL bpmn-js command stack.
 *
 * The «Собрать напоминание с эскалацией» affordance fires ~8 modeling operations.
 * Requirement: ONE click = ONE undo entry. applyEscalationBranch therefore runs
 * everything as a composite command (BUILD_ESCALATION_BRANCH_CMD, the canonical
 * AppendShapeHandler pattern — nested modeling in preExecute shares the base
 * action id; CommandStack.undo() pops entries while the id matches).
 *
 * This test proves it on a LIVE bpmn-js Modeler (real CommandStack, real
 * Modeling, real rules/behaviors — jsdom DOM):
 *   1. build → the converging topology exists on the canvas;
 *   2. ONE commandStack.undo() → canUndo()===false (there was exactly one
 *      entry) AND the original topology is fully restored;
 *   3. ONE commandStack.redo() → the whole branch is back (one entry both ways).
 *
 * jsdom has no SVG layout engine — getBBox is stubbed (measurement-only; the
 * command stack and model surgery under test do not depend on real geometry).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import BpmnModeler from 'bpmn-js/lib/Modeler';
import { applyEscalationBranch } from './escalation-branch-builder.js';

/** Minimal diagram WITH DI (bpmn-js refuses to import without it):
 *  Start_1 → Task_step → End_1, boundary timer Boundary_1 on Task_step. */
const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
    xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
    xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
    id="Definitions_t0660" targetNamespace="http://choros.io/test">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="Start_1"/>
    <bpmn:userTask id="Task_step" name="Шаг"/>
    <bpmn:boundaryEvent id="Boundary_1" attachedToRef="Task_step">
      <bpmn:timerEventDefinition/>
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="End_1"/>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_step"/>
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_step" targetRef="End_1"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Diagram_1">
    <bpmndi:BPMNPlane id="Plane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="Start_1_di" bpmnElement="Start_1">
        <dc:Bounds x="100" y="100" width="36" height="36"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_step_di" bpmnElement="Task_step">
        <dc:Bounds x="200" y="78" width="100" height="80"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Boundary_1_di" bpmnElement="Boundary_1">
        <dc:Bounds x="262" y="140" width="36" height="36"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="End_1_di" bpmnElement="End_1">
        <dc:Bounds x="400" y="100" width="36" height="36"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1">
        <di:waypoint x="136" y="118"/>
        <di:waypoint x="200" y="118"/>
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_2_di" bpmnElement="Flow_2">
        <di:waypoint x="300" y="118"/>
        <di:waypoint x="400" y="118"/>
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

/* --------------------------------------------------------------------------
   jsdom SVG-geometry polyfill (measurement/matrix only). jsdom implements SVG
   structurally but none of its geometry engine; bpmn-js/tiny-svg need:
     - SVGElement#getBBox                 (text measurement — zero box is fine)
     - SVGSVGElement#createSVGMatrix / createSVGTransform(FromMatrix)
     - SVGElement#transform.baseVal      (viewport transform list)
     - CSS.escape                         (diagram-js palette)
   None of these affect what is under test (the command stack + model surgery);
   they only keep the real Modeler from crashing while it renders headlessly.
   -------------------------------------------------------------------------- */
/** Real affine-matrix class — registered as the global SVGMatrix so tiny-svg's
 *  `transform instanceof SVGMatrix` branch (wrapMatrix) recognises our matrices. */
class FakeSVGMatrix {
  constructor(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
    this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
  }
  multiply(o) {
    return new FakeSVGMatrix(
      this.a * o.a + this.c * o.b, this.b * o.a + this.d * o.b,
      this.a * o.c + this.c * o.d, this.b * o.c + this.d * o.d,
      this.a * o.e + this.c * o.f + this.e, this.b * o.e + this.d * o.f + this.f,
    );
  }
  scale(s) { return this.multiply(new FakeSVGMatrix(s, 0, 0, s, 0, 0)); }
  translate(x, y) { return this.multiply(new FakeSVGMatrix(1, 0, 0, 1, x, y)); }
  inverse() {
    const det = this.a * this.d - this.b * this.c;
    return new FakeSVGMatrix(
      this.d / det, -this.b / det, -this.c / det, this.a / det,
      (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det,
    );
  }
}

function makeMatrix(a, b, c, d, e, f) {
  return new FakeSVGMatrix(a, b, c, d, e, f);
}

function makeSvgTransform(matrix = makeMatrix()) {
  return {
    matrix,
    setMatrix(mm) { this.matrix = mm; },
    setTranslate(x, y) { this.matrix = makeMatrix(1, 0, 0, 1, x, y); },
  };
}

const transformListByNode = new WeakMap();
function getTransformList(node) {
  let list = transformListByNode.get(node);
  if (!list) {
    const items = [];
    list = {
      get numberOfItems() { return items.length; },
      clear() { items.length = 0; },
      appendItem(t) { items.push(t); return t; },
      getItem(i) { return items[i]; },
      createSVGTransformFromMatrix(m) { return makeSvgTransform(m); },
      consolidate() {
        if (items.length === 0) return null;
        let m = makeMatrix();
        for (const t of items) m = m.multiply(t.matrix);
        const t = makeSvgTransform(m);
        items.length = 0;
        items.push(t);
        return t;
      },
    };
    transformListByNode.set(node, list);
  }
  return list;
}

beforeAll(() => {
  if (typeof SVGElement !== 'undefined') {
    if (!SVGElement.prototype.getBBox) {
      SVGElement.prototype.getBBox = function getBBox() {
        return { x: 0, y: 0, width: 0, height: 0 };
      };
    }
    if (!Object.getOwnPropertyDescriptor(SVGElement.prototype, 'transform')) {
      Object.defineProperty(SVGElement.prototype, 'transform', {
        configurable: true,
        get() { return { baseVal: getTransformList(this) }; },
      });
    }
  }
  if (typeof SVGSVGElement !== 'undefined') {
    if (!SVGSVGElement.prototype.createSVGMatrix) {
      SVGSVGElement.prototype.createSVGMatrix = () => makeMatrix();
    }
    if (!SVGSVGElement.prototype.createSVGTransform) {
      SVGSVGElement.prototype.createSVGTransform = () => makeSvgTransform();
    }
    if (!SVGSVGElement.prototype.createSVGTransformFromMatrix) {
      SVGSVGElement.prototype.createSVGTransformFromMatrix = (m) => makeSvgTransform(m);
    }
  }
  // tiny-svg checks `matrix instanceof SVGMatrix` — jsdom defines no such global.
  if (typeof globalThis.SVGMatrix === 'undefined') {
    globalThis.SVGMatrix = FakeSVGMatrix;
  }
  // jsdom has no CSS.escape (diagram-js palette uses it) — minimal spec-shaped stub.
  if (typeof globalThis.CSS === 'undefined' || !globalThis.CSS.escape) {
    globalThis.CSS = {
      ...(globalThis.CSS || {}),
      escape: (s) => String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1'),
    };
  }
});

async function makeLiveModeler() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const modeler = new BpmnModeler({ container });
  await modeler.importXML(FIXTURE);
  return modeler;
}

const isSeqFlow = (c) => c.type === 'bpmn:SequenceFlow';

// Instantiating a full bpmn-js Modeler + importXML takes ~3-5s alone and slower
// under a parallel suite — the vitest default 5s testTimeout flakes exactly like
// the known fitness:db class (concurrency amplifies). Explicit generous timeout.
const HEAVY_TIMEOUT_MS = 30000;

describe('T-0660 U-1 — one click = ONE undo entry (real bpmn-js CommandStack)', () => {
  it('a single commandStack.undo() removes the whole built branch and restores the original topology', async () => {
    const modeler = await makeLiveModeler();
    const registry = modeler.get('elementRegistry');
    const commandStack = modeler.get('commandStack');
    const boundary = registry.get('Boundary_1');
    const host = registry.get('Task_step');

    // Import is not a command — the stack starts empty.
    expect(commandStack.canUndo()).toBe(false);

    const res = applyEscalationBranch({ modeler, boundaryElement: boundary });
    expect(res.applied).toBe(true);

    // Built topology exists on the LIVE canvas.
    const escTask = registry.get(res.escalationTaskId);
    const gateway = registry.get(res.gatewayId);
    expect(escTask).toBeTruthy();
    expect(gateway).toBeTruthy();
    expect(boundary.businessObject.cancelActivity).toBe(false);
    // host → gateway → End_1; timer → escTask → gateway.
    expect(host.outgoing.filter(isSeqFlow).map((c) => c.target.id)).toEqual([res.gatewayId]);
    expect(gateway.outgoing.filter(isSeqFlow).map((c) => c.target.id)).toEqual(['End_1']);
    expect(boundary.outgoing.filter(isSeqFlow).map((c) => c.target.id)).toEqual([res.escalationTaskId]);
    expect(escTask.outgoing.filter(isSeqFlow).map((c) => c.target.id)).toEqual([res.gatewayId]);

    // ---- THE PIN: exactly ONE undo entry for the whole build. ----
    expect(commandStack.canUndo()).toBe(true);
    commandStack.undo(); // ONE undo — not ~8
    expect(commandStack.canUndo()).toBe(false); // stack empty ⇒ it was a single entry

    // Original topology fully restored.
    expect(registry.get(res.escalationTaskId)).toBeUndefined();
    expect(registry.get(res.gatewayId)).toBeUndefined();
    const hostOut = host.outgoing.filter(isSeqFlow);
    expect(hostOut).toHaveLength(1);
    expect(hostOut[0].target.id).toBe('End_1');
    expect(boundary.outgoing.filter(isSeqFlow)).toHaveLength(0);
    // cancelActivity restored to its pre-build value (absent/true = interrupting).
    expect(boundary.businessObject.cancelActivity).not.toBe(false);
  }, HEAVY_TIMEOUT_MS);

  it('a single commandStack.redo() replays the whole build (one entry both ways)', async () => {
    const modeler = await makeLiveModeler();
    const registry = modeler.get('elementRegistry');
    const commandStack = modeler.get('commandStack');
    const boundary = registry.get('Boundary_1');
    const host = registry.get('Task_step');

    const res = applyEscalationBranch({ modeler, boundaryElement: boundary });
    expect(res.applied).toBe(true);

    commandStack.undo();
    expect(registry.get(res.escalationTaskId)).toBeUndefined();

    commandStack.redo(); // ONE redo brings the ENTIRE branch back
    expect(registry.get(res.escalationTaskId)).toBeTruthy();
    expect(registry.get(res.gatewayId)).toBeTruthy();
    expect(boundary.businessObject.cancelActivity).toBe(false);
    expect(host.outgoing.filter(isSeqFlow).map((c) => c.target.id)).toEqual([res.gatewayId]);
    // And it is again a single entry: one undo clears it completely.
    commandStack.undo();
    expect(commandStack.canUndo()).toBe(false);
  }, HEAVY_TIMEOUT_MS);
});
