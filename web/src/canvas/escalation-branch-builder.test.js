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
  // T-0776: a `prev` element feeding the host (e.g. the process Start) — the
  // fixture the adversarial review used to empirically prove the reparent bug
  // (bpmn-js silently drops this flow during moveElements if the builder
  // doesn't handle it).
  const prev = {
    id: 'Start_1', businessObject: { $type: 'bpmn:StartEvent' },
    x: 20, y: 100, width: 36, height: 36, parent, outgoing: [], incoming: [],
  };
  const next = {
    id: 'End_1', businessObject: { $type: 'bpmn:EndEvent' },
    x: 400, y: 100, width: 36, height: 36, parent, outgoing: [], incoming: [],
  };
  const host = {
    id: 'Task_1', businessObject: { $type: 'bpmn:UserTask' },
    x: 100, y: 80, width: 100, height: 80, parent, outgoing: [], incoming: [],
  };
  const prevFlow = seqFlow('Flow_prev_host', prev, host);
  prev.outgoing = [prevFlow];
  host.incoming = [prevFlow];
  const hostFlow = seqFlow('Flow_host_next', host, next);
  host.outgoing = [hostFlow];
  next.incoming = [hostFlow];
  const boundary = {
    id: 'Boundary_1', businessObject: { $type: 'bpmn:BoundaryEvent' },
    host, parent, outgoing: [], incoming: [], x: 150, y: 150, width: 36, height: 36,
  };
  return { parent, prev, prevFlow, next, host, hostFlow, boundary };
}

/**
 * A recording mock of the bpmn-js modeling service. Returns real-ish shapes.
 *
 * T-0776: connect/removeConnection/moveElements now actually mutate the graph
 * (push/splice source.outgoing + target.incoming) instead of only logging —
 * this is what lets moveElements mirror bpmn-js's real, otherwise-invisible
 * behaviour of SILENTLY DROPPING any connection that would cross the new
 * parent's boundary. Previously this mock kept every connection alive across
 * a move (just flipping `.parent`), which is why the missing-incoming-flow
 * reparent bug shipped undetected at the mock-test level — only the real-
 * bpmn-js test (escalation-branch-undo.test.js) caught it.
 */
function makeMockModeler() {
  const calls = [];
  let seq = 0;
  const elements = new Map();
  const modeling = {
    updateProperties(element, properties) {
      calls.push({ op: 'updateProperties', id: element.id, properties });
    },
    createShape(shape, position, parent) {
      seq += 1;
      const local = shape.type.split(':')[1];
      const el = {
        id: `${local}_${seq}`, type: shape.type,
        businessObject: { $type: shape.type, eventDefinitions: shape.eventDefinitionType ? [{ $type: shape.eventDefinitionType }] : [] },
        x: (position && position.x) || 0, y: (position && position.y) || 0,
        width: 100, height: 80, parent, outgoing: [], incoming: [],
      };
      calls.push({
        op: 'createShape', type: shape.type, newId: el.id,
        parent: parent && parent.id, position,
        eventDefinitionType: shape.eventDefinitionType,
      });
      elements.set(el.id, el);
      return el;
    },
    appendShape(source, shape, position, parent) {
      seq += 1;
      const local = shape.type.split(':')[1];
      const el = {
        id: `${local}_${seq}`, type: shape.type,
        businessObject: { $type: shape.type, eventDefinitions: shape.eventDefinitionType ? [{ $type: shape.eventDefinitionType }] : [] },
        x: (position && position.x) || 0, y: (position && position.y) || 0,
        width: 100, height: 80, parent, outgoing: [], incoming: [],
      };
      calls.push({
        op: 'appendShape', source: source.id, type: shape.type, newId: el.id, position,
        eventDefinitionType: shape.eventDefinitionType,
      });
      elements.set(el.id, el);
      return el;
    },
    connect(source, target, attrs) {
      seq += 1;
      const c = { id: `Flow_${seq}`, type: attrs.type, source, target };
      calls.push({ op: 'connect', source: source.id, target: target.id, type: attrs.type });
      (source.outgoing = source.outgoing || []).push(c);
      (target.incoming = target.incoming || []).push(c);
      return c;
    },
    removeConnection(connection) {
      calls.push({ op: 'removeConnection', id: connection.id });
      const { source, target } = connection;
      if (source && Array.isArray(source.outgoing)) {
        const i = source.outgoing.indexOf(connection);
        if (i >= 0) source.outgoing.splice(i, 1);
      }
      if (target && Array.isArray(target.incoming)) {
        const i = target.incoming.indexOf(connection);
        if (i >= 0) target.incoming.splice(i, 1);
      }
    },
    moveElements(shapes, delta, target) {
      calls.push({ op: 'moveElements', ids: shapes.map((s) => s.id), target: target.id, delta });
      const movedIds = new Set(shapes.map((s) => s.id));
      shapes.forEach((s) => {
        s.parent = target;
        // Mirror bpmn-js: a connection with exactly one endpoint inside the
        // moved set and the other endpoint OUTSIDE it (and not the new parent
        // itself) crosses the new subProcess boundary — a real move SILENTLY
        // DROPS it. If the builder forgot to explicitly remove+reconnect a
        // boundary-crossing flow before calling moveElements, this reproduces
        // that loss so the regression is caught here, at the mock level too.
        ['incoming', 'outgoing'].forEach((dir) => {
          const list = s[dir] || [];
          for (let i = list.length - 1; i >= 0; i -= 1) {
            const c = list[i];
            const other = dir === 'incoming' ? c.source : c.target;
            if (other && other.id !== target.id && !movedIds.has(other.id)) {
              list.splice(i, 1);
              const otherList = dir === 'incoming' ? other.outgoing : other.incoming;
              if (Array.isArray(otherList)) {
                const j = otherList.indexOf(c);
                if (j >= 0) otherList.splice(j, 1);
              }
            }
          }
        });
      });
    },
  };
  // Minimal commandStack mimicking diagram-js semantics: registerHandler
  // instantiates the handler class ($inject: ['modeling']) and execute() runs
  // its phases. Every execute is RECORDED — the atomicity pin asserts the whole
  // build issues exactly ONE commandStack.execute (the composite command);
  // grouping of the nested modeling ops into that one undo entry is proven
  // against the REAL CommandStack in escalation-branch-undo.test.jsx.
  const handlers = {};
  const commandStack = {
    registerHandler(command, HandlerCls) {
      calls.push({ op: 'registerHandler', command });
      handlers[command] = new HandlerCls(modeling);
    },
    execute(command, context) {
      calls.push({ op: 'commandStack.execute', command });
      const h = handlers[command];
      if (!h) throw new Error(`no handler for ${command}`);
      if (h.preExecute) h.preExecute(context);
      if (h.execute) h.execute(context);
      if (h.postExecute) h.postExecute(context);
    },
  };
  return {
    get: (name) => (name === 'modeling' ? modeling : name === 'commandStack' ? commandStack : undefined),
    calls,
    getElement: (id) => elements.get(id),
  };
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
   4. applyEscalationBranch — exact modeling ops + D5 (subProcess + scope-local
      terminate) topology, per ADR-T0612 §8 / T-0661.
   -------------------------------------------------------------------------- */
describe('applyEscalationBranch — builds the D5 shape (subProcess + scope-local terminate)', () => {
  it('encloses the race in a subProcess converging into a terminateEndEvent', () => {
    const { boundary, host, next, hostFlow, parent, prev, prevFlow } = makeGraph();
    const modeler = makeMockModeler();
    const res = applyEscalationBranch({ modeler, boundaryElement: boundary });

    expect(res.applied).toBe(true);
    const { calls } = modeler;

    // U-1 ATOMICITY: the entire build is issued as exactly ONE composite
    // commandStack.execute — all modeling ops are NESTED inside it (one undo
    // entry; single-undo behaviour is pinned against the real CommandStack in
    // escalation-branch-undo.test.jsx).
    const executes = calls.filter((c) => c.op === 'commandStack.execute');
    expect(executes).toHaveLength(1);
    expect(executes[0].command).toBe('choros.escalationBranch.build');
    // No modeling op happened OUTSIDE the composite execute.
    const executeIdx = calls.findIndex((c) => c.op === 'commandStack.execute');
    const modelingOps = [
      'updateProperties', 'appendShape', 'createShape', 'connect', 'removeConnection', 'moveElements',
    ];
    expect(calls.findIndex((c) => modelingOps.includes(c.op))).toBeGreaterThan(executeIdx);

    // 1. timer → non-interrupting
    expect(calls).toContainEqual({
      op: 'updateProperties', id: 'Boundary_1', properties: { cancelActivity: false },
    });

    // 2. the host's OLD top-level flow is removed (the subProcess carries the
    //    resolved race onward instead — see assertion 8 below).
    expect(calls).toContainEqual({ op: 'removeConnection', id: hostFlow.id });

    // 3. the embedded subProcess is created at the top level (host's old parent).
    const subCreate = calls.find((c) => c.op === 'createShape' && c.type === 'bpmn:SubProcess');
    expect(subCreate).toBeDefined();
    expect(subCreate.parent).toBe(parent.id);
    const subId = subCreate.newId;
    expect(res.subProcessId).toBe(subId);

    // 4. host + its boundary timer are MOVED into the subProcess (host keeps
    //    its id/config — only containment changes).
    expect(calls).toContainEqual(
      expect.objectContaining({ op: 'moveElements', ids: [host.id, boundary.id], target: subId }),
    );

    // 5. embedded sub-processes require exactly one none-start, wired to host.
    const subStartCreate = calls.find((c) => c.op === 'createShape' && c.type === 'bpmn:StartEvent');
    expect(subStartCreate).toBeDefined();
    expect(subStartCreate.parent).toBe(subId);
    const subStartId = subStartCreate.newId;
    expect(calls).toContainEqual(
      expect.objectContaining({ op: 'connect', source: subStartId, target: host.id }),
    );

    // 6. escalation userTask appended FROM the boundary timer, INSIDE the subProcess.
    const escAppend = calls.find((c) => c.op === 'appendShape' && c.source === 'Boundary_1');
    expect(escAppend).toBeDefined();
    expect(escAppend.type).toBe('bpmn:UserTask');
    const escId = escAppend.newId;
    expect(res.escalationTaskId).toBe(escId);
    expect(calls).toContainEqual(
      expect.objectContaining({ op: 'updateProperties', id: escId, properties: { name: 'Эскалация' } }),
    );

    // 7. converging exclusiveGateway appended FROM the host step, INSIDE the subProcess.
    const gwAppend = calls.find((c) => c.op === 'appendShape' && c.source === host.id);
    expect(gwAppend).toBeDefined();
    expect(gwAppend.type).toBe('bpmn:ExclusiveGateway');
    const gwId = gwAppend.newId;
    expect(res.gatewayId).toBe(gwId);
    expect(calls).toContainEqual(
      expect.objectContaining({ op: 'updateProperties', id: gwId, properties: { name: 'Продолжить' } }),
    );

    // escalation step converges into the SAME gateway.
    expect(calls).toContainEqual(
      expect.objectContaining({ op: 'connect', source: escId, target: gwId }),
    );

    // 8. THE FIX (D5): the gateway flows to a SCOPE-LOCAL terminateEndEvent —
    //    NOT a plain end. Appended from the gateway, inside the subProcess.
    const termAppend = calls.find(
      (c) => c.op === 'appendShape' && c.source === gwId && c.type === 'bpmn:EndEvent',
    );
    expect(termAppend).toBeDefined();
    expect(termAppend.eventDefinitionType).toBe('bpmn:TerminateEventDefinition');
    const termId = termAppend.newId;
    expect(res.terminateEndId).toBe(termId);

    // 9. the subProcess (not the bare host) now carries the race's outcome to
    //    wherever the host used to flow — the ONLY top-level reconnection.
    expect(calls).toContainEqual(
      expect.objectContaining({ op: 'connect', source: subId, target: next.id }),
    );

    // 10. THE FIX (T-0776, adversarial review — empirically proven): the
    //     host's OLD INCOMING flow (prev → host) is explicitly removed and
    //     reconnected to the subProcess — NOT silently lost when host moves.
    //     Without this, prev.outgoing/subProcess.incoming both end up empty
    //     and the built branch can never be entered.
    expect(calls).toContainEqual({ op: 'removeConnection', id: prevFlow.id });
    expect(calls).toContainEqual(
      expect.objectContaining({ op: 'connect', source: prev.id, target: subId }),
    );
    const subEl = modeler.getElement(subId);
    expect(prev.outgoing.map((c) => c.target.id)).toEqual([subId]);
    expect(subEl.incoming.map((c) => c.source.id)).toEqual([prev.id]);
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
