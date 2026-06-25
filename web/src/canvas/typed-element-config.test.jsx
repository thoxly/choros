/**
 * T-0461 [D8-R6] — typed per-element dispatch render test.
 *
 * Asserts the KEYSTONE: <TypedElementConfig> mounts the RIGHT typed sub-panel for
 * each element-config kind — one framework, no parallel ad-hoc paths. React
 * elements are plain objects, so (per the project's node-env test philosophy) we
 * call TypedElementConfig as a function and inspect the returned element tree's
 * component types WITHOUT a DOM. This deliberately does not render the hook-bearing
 * sub-panels (AgentTaskPanel/GatewayConditionPanel/TimerDeadlinePanel) — it checks
 * the DISPATCH picks them, which is the integration contract under test.
 */

import { describe, it, expect } from 'vitest';
import {
  TypedElementConfig,
  OutcomesPanel,
  UserTaskFormBindingPanel,
  MessageCorrelationPanel,
} from './bpmn-properties-panel.jsx';
import { AgentTaskPanel } from './agent-task-panel.jsx';
import { GatewayConditionPanel } from './gateway-condition-panel.jsx';
import { TimerDeadlinePanel } from './timer-deadline-panel.jsx';

// Collect React elements whose `type` is one of the given component functions.
function collectComponents(node, results = []) {
  if (node === null || node === undefined) return results;
  if (Array.isArray(node)) {
    for (const c of node) collectComponents(c, results);
    return results;
  }
  if (typeof node !== 'object' || !node.type) return results;
  if (typeof node.type === 'function') results.push(node.type);
  const { children } = node.props || {};
  if (children !== undefined) collectComponents(children, results);
  return results;
}

// Render TypedElementConfig (a plain switch — no hooks of its own) and collect the
// component types it emitted.
function dispatchTypes(props) {
  const tree = TypedElementConfig({
    bo: props.bo,
    modeler: null,
    element: null,
    kind: props.kind,
    roles: [],
    rolesLoading: false,
  });
  return collectComponents(tree);
}

const userTaskBo = { $type: 'bpmn:UserTask', id: 'Task_1' };
const serviceTaskBo = { $type: 'bpmn:ServiceTask', id: 'Task_svc' };
const agentTaskBo = { $type: 'bpmn:ServiceTask', id: 'Task_ag', executorType: 'agent' };
const gatewayBo = { $type: 'bpmn:ExclusiveGateway', id: 'Gw_1', outgoing: [] };
const timerBo = { $type: 'bpmn:BoundaryEvent', id: 'Ev_1', eventDefinitions: [{ $type: 'bpmn:TimerEventDefinition' }] };
const messageBo = { $type: 'bpmn:ReceiveTask', id: 'Rcv_1' };

describe('TypedElementConfig dispatch — right config per element-config kind', () => {
  it('userTask → OutcomesPanel + UserTaskFormBindingPanel', () => {
    const types = dispatchTypes({ bo: userTaskBo, kind: 'userTask' });
    expect(types).toContain(OutcomesPanel);
    expect(types).toContain(UserTaskFormBindingPanel);
  });

  it('userTask kind on a plain serviceTask → renders nothing extra (no human-task groups)', () => {
    // A non-human task in the userTask family keeps its prior (no extra group)
    // behavior — the role «Назначение» group lives in General, not here.
    const tree = TypedElementConfig({
      bo: serviceTaskBo, modeler: null, element: null, kind: 'userTask', roles: [], rolesLoading: false,
    });
    expect(tree).toBeNull();
  });

  it('agentTask → AgentTaskPanel', () => {
    const types = dispatchTypes({ bo: agentTaskBo, kind: 'agentTask' });
    expect(types).toContain(AgentTaskPanel);
    // and NOT the human-task panels
    expect(types).not.toContain(OutcomesPanel);
    expect(types).not.toContain(UserTaskFormBindingPanel);
  });

  it('gateway → GatewayConditionPanel', () => {
    const types = dispatchTypes({ bo: gatewayBo, kind: 'gateway' });
    expect(types).toContain(GatewayConditionPanel);
  });

  it('timer → TimerDeadlinePanel', () => {
    const types = dispatchTypes({ bo: timerBo, kind: 'timer' });
    expect(types).toContain(TimerDeadlinePanel);
  });

  it('message → MessageCorrelationPanel (T-0459 — real correlation config replaces the seam)', () => {
    const types = dispatchTypes({ bo: messageBo, kind: 'message' });
    expect(types).toContain(MessageCorrelationPanel);
    // The message arm mounts ONLY the message panel — no other typed panel leaks in.
    expect(types).not.toContain(AgentTaskPanel);
  });

  it('parallel / start / end / none → no typed config (returns null)', () => {
    for (const kind of ['parallel', 'start', 'end', 'none']) {
      const tree = TypedElementConfig({
        bo: { $type: 'bpmn:ParallelGateway' }, modeler: null, element: null, kind, roles: [], rolesLoading: false,
      });
      expect(tree, `kind ${kind} should render nothing`).toBeNull();
    }
  });
});
