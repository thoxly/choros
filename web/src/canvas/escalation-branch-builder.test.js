/**
 * T-0660 — escalation-branch-builder unit tests (node env — no DOM).
 *
 * Covers:
 *   1. cancelActivity read/write (interrupting ↔ non-interrupting), direct + via modeler.
 *   2. isBoundaryEventBo — boundary vs free intermediate timer.
 *   3. canBuildEscalationBranch — every precondition + reason.
 *   4. applyEscalationBranch — the EXACT modeling ops + converging topology, via a
 *      recording mock modeler (proves the wiring, not a stub).
 *   5. idempotency (branch already built → no-op with a reason).
 */

import { describe, it, expect } from 'vitest';
import {
  INTERRUPT_MODES,
  isBoundaryEventBo,
  readInterruptMode,
  writeInterruptMode,
  normalOutgoing,
  canBuildEscalationBranch,
  applyEscalationBranch,
} from './escalation-branch-builder.js';

/* --------------------------------------------------------------------------
   Graph fixture helpers — plain diagram-shape shapes (no bpmn-js).
   -------------------------------------------------------------------------- */
function seqFlow(id, source, target) {
  return { id, type: 'bpmn:SequenceFlow', source, target };
}

function makeGraph() {
  const parent = { id: 'Process_1' };
  const next = {
    id: 'End_1', businessObject: { $type: 'bpmn:EndEvent' },
    x: 400, y: 100, width: 36, height: 36, parent, outgoing: [],
  };
  const host = {
    id: 'Task_1', businessObject: { $type: 'bpmn:UserTask' },
    x: 100, y: 80, width: 100, height: 80, parent, outgoing: [],
  };
  const hostFlow = seqFlow('Flow_host_next', host, next);
  host.outgoing = [hostFlow];
  const boundary = {
    id: 'Boundary_1', businessObject: { $type: 'bpmn:BoundaryEvent' },
    host, parent, outgoing: [], x: 150, y: 150, width: 36, height: 36,
  };
  return { parent, next, host, hostFlow, boundary };
}

/** A recording mock of the bpmn-js modeling service. Returns real-ish shapes. */
function makeMockModeler() {
  const calls = [];
  let seq = 0;
  const modeling = {
    updateProperties(element, properties) {
      calls.push({ op: 'updateProperties', id: element.id, properties });
    },
    appendShape(source, shape, position, parent) {
      seq += 1;
      const local = shape.type.split(':')[1];
      const el = {
        id: `${local}_${seq}`, type: shape.type,
        businessObject: { $type: shape.type },
        x: (position && position.x) || 0, y: (position && position.y) || 0,
        width: 100, height: 80, parent, outgoing: [], incoming: [],
      };
      calls.push({ op: 'appendShape', source: source.id, type: shape.type, newId: el.id, position });
      return el;
    },
    connect(source, target, attrs) {
      seq += 1;
      const c = { id: `Flow_${seq}`, type: attrs.type, source, target };
      calls.push({ op: 'connect', source: source.id, target: target.id, type: attrs.type });
      return c;
    },
    removeConnection(connection) {
      calls.push({ op: 'removeConnection', id: connection.id });
    },
  };
  return { get: (name) => (name === 'modeling' ? modeling : undefined), calls };
}

/* --------------------------------------------------------------------------
   1. cancelActivity read/write
   -------------------------------------------------------------------------- */
describe('interrupt mode (cancelActivity) read/write', () => {
  it('exposes exactly interrupting + non-interrupting modes', () => {
    expect(INTERRUPT_MODES.map((m) => m.value)).toEqual(['interrupting', 'non-interrupting']);
  });

  it('defaults to interrupting when cancelActivity is absent (BPMN default)', () => {
    expect(readInterruptMode({ $type: 'bpmn:BoundaryEvent' })).toBe('interrupting');
    expect(readInterruptMode(undefined)).toBe('interrupting');
  });

  it('reads cancelActivity===true as interrupting, ===false as non-interrupting', () => {
    expect(readInterruptMode({ cancelActivity: true })).toBe('interrupting');
    expect(readInterruptMode({ cancelActivity: false })).toBe('non-interrupting');
  });

  it('writes non-interrupting → cancelActivity=false directly on bo (no modeler)', () => {
    const bo = { $type: 'bpmn:BoundaryEvent', cancelActivity: true };
    writeInterruptMode({ bo }, 'non-interrupting');
    expect(bo.cancelActivity).toBe(false);
  });

  it('writes interrupting → cancelActivity=true directly on bo (no modeler)', () => {
    const bo = { $type: 'bpmn:BoundaryEvent', cancelActivity: false };
    writeInterruptMode({ bo }, 'interrupting');
    expect(bo.cancelActivity).toBe(true);
  });

  it('prefers modeling.updateProperties when a modeler is present', () => {
    const modeler = makeMockModeler();
    const element = { id: 'Boundary_1' };
    writeInterruptMode({ bo: {}, modeler, element }, 'non-interrupting');
    expect(modeler.calls).toEqual([
      { op: 'updateProperties', id: 'Boundary_1', properties: { cancelActivity: false } },
    ]);
  });
});

/* --------------------------------------------------------------------------
   2. isBoundaryEventBo
   -------------------------------------------------------------------------- */
describe('isBoundaryEventBo', () => {
  it('true only for a boundary event', () => {
    expect(isBoundaryEventBo({ $type: 'bpmn:BoundaryEvent' })).toBe(true);
    expect(isBoundaryEventBo({ $type: 'bpmn:IntermediateCatchEvent' })).toBe(false);
    expect(isBoundaryEventBo({ $type: 'bpmn:UserTask' })).toBe(false);
    expect(isBoundaryEventBo(null)).toBe(false);
  });
});

/* --------------------------------------------------------------------------
   3. canBuildEscalationBranch — preconditions
   -------------------------------------------------------------------------- */
describe('canBuildEscalationBranch', () => {
  it('ok for a boundary timer on a step with exactly one outgoing', () => {
    const { boundary } = makeGraph();
    expect(canBuildEscalationBranch(boundary)).toEqual({ ok: true });
  });

  it('rejects a non-boundary (free intermediate) timer', () => {
    const el = { businessObject: { $type: 'bpmn:IntermediateCatchEvent' } };
    const res = canBuildEscalationBranch(el);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/закрепите/i);
  });

  it('rejects a boundary without a host step', () => {
    const el = { businessObject: { $type: 'bpmn:BoundaryEvent' }, host: null };
    expect(canBuildEscalationBranch(el).ok).toBe(false);
  });

  it('rejects when the branch is already built (boundary already has an outgoing)', () => {
    const { boundary, next } = makeGraph();
    boundary.outgoing = [seqFlow('Flow_x', boundary, next)];
    const res = canBuildEscalationBranch(boundary);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/уже собрана/i);
  });

  it('rejects when the host has zero outgoing flows', () => {
    const { boundary, host } = makeGraph();
    host.outgoing = [];
    const res = canBuildEscalationBranch(boundary);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/одним следующим/i);
  });

  it('rejects when the host has more than one outgoing flow (ambiguous reroute)', () => {
    const { boundary, host, next } = makeGraph();
    host.outgoing = [...host.outgoing, seqFlow('Flow_b', host, next)];
    expect(canBuildEscalationBranch(boundary).ok).toBe(false);
  });

  it('ignores non-sequence-flow connections (e.g. associations) when counting', () => {
    const { boundary, host, next } = makeGraph();
    host.outgoing = [...host.outgoing, { id: 'Assoc_1', type: 'bpmn:Association', source: host, target: next }];
    expect(canBuildEscalationBranch(boundary)).toEqual({ ok: true });
  });
});

/* --------------------------------------------------------------------------
   4. applyEscalationBranch — exact modeling ops + converging topology
   -------------------------------------------------------------------------- */
describe('applyEscalationBranch — builds the converging shape', () => {
  it('sets non-interrupting, appends esc-task + gateway, reroutes, converges', () => {
    const { boundary, host, next, hostFlow } = makeGraph();
    const modeler = makeMockModeler();
    const res = applyEscalationBranch({ modeler, boundaryElement: boundary });

    expect(res.applied).toBe(true);
    const { calls } = modeler;

    // 1. timer → non-interrupting
    expect(calls).toContainEqual({
      op: 'updateProperties', id: 'Boundary_1', properties: { cancelActivity: false },
    });

    // 2. escalation userTask appended FROM the boundary timer
    const escAppend = calls.find((c) => c.op === 'appendShape' && c.source === 'Boundary_1');
    expect(escAppend).toBeDefined();
    expect(escAppend.type).toBe('bpmn:UserTask');
    const escId = escAppend.newId;
    expect(res.escalationTaskId).toBe(escId);
    expect(calls).toContainEqual(
      expect.objectContaining({ op: 'updateProperties', id: escId, properties: { name: 'Эскалация' } }),
    );

    // 3. converging exclusiveGateway appended FROM the host step
    const gwAppend = calls.find((c) => c.op === 'appendShape' && c.source === host.id);
    expect(gwAppend).toBeDefined();
    expect(gwAppend.type).toBe('bpmn:ExclusiveGateway');
    const gwId = gwAppend.newId;
    expect(res.gatewayId).toBe(gwId);
    expect(calls).toContainEqual(
      expect.objectContaining({ op: 'updateProperties', id: gwId, properties: { name: 'Продолжить' } }),
    );

    // 4. old host→next removed, new gateway→next added (gateway sits between them)
    expect(calls).toContainEqual({ op: 'removeConnection', id: hostFlow.id });
    expect(calls).toContainEqual(
      expect.objectContaining({ op: 'connect', source: gwId, target: next.id }),
    );

    // 5. escalation step converges into the SAME gateway
    expect(calls).toContainEqual(
      expect.objectContaining({ op: 'connect', source: escId, target: gwId }),
    );
  });

  it('is a no-op with a reason when preconditions fail (idempotent)', () => {
    const { boundary, next } = makeGraph();
    boundary.outgoing = [seqFlow('Flow_x', boundary, next)]; // already built
    const modeler = makeMockModeler();
    const res = applyEscalationBranch({ modeler, boundaryElement: boundary });
    expect(res.applied).toBe(false);
    expect(res.reason).toMatch(/уже собрана/i);
    expect(modeler.calls).toHaveLength(0); // nothing mutated
  });

  it('fails cleanly when no modeler is available', () => {
    const { boundary } = makeGraph();
    const res = applyEscalationBranch({ modeler: null, boundaryElement: boundary });
    expect(res.applied).toBe(false);
    expect(res.reason).toMatch(/модельер/i);
  });
});

/* --------------------------------------------------------------------------
   normalOutgoing helper
   -------------------------------------------------------------------------- */
describe('normalOutgoing', () => {
  it('returns only sequence-flow connections', () => {
    const { host } = makeGraph();
    host.outgoing.push({ id: 'A', type: 'bpmn:Association' });
    expect(normalOutgoing(host).map((c) => c.id)).toEqual(['Flow_host_next']);
  });
  it('tolerates a missing outgoing array', () => {
    expect(normalOutgoing({})).toEqual([]);
    expect(normalOutgoing(null)).toEqual([]);
  });
});
