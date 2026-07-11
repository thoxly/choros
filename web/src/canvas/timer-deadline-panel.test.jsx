/**
 * T-0458 [D8-R3] — timer-deadline-panel.jsx pure-helper + moddle contract tests.
 *
 * Covers:
 *   1. validateDeadline — duration/date/field shapes (valid + malformed).
 *   2. read/writeTimerAttr — dual-write (registered moddle prop + $attrs) round-trip.
 *   3. deadlinePlaceholder / deadlineHint — per-kind copy present.
 *   4. choros-moddle-extension — TimerDeadlineExtension descriptor shape (round-trip contract).
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import {
  validateDeadline,
  readTimerAttr,
  writeTimerAttr,
  deadlinePlaceholder,
  deadlineHint,
  DEADLINE_KINDS,
  ESCALATION_TARGETS,
  TimerDeadlinePanel,
} from './timer-deadline-panel.jsx';
import descriptor from './choros-moddle-extension.js';

/* --------------------------------------------------------------------------
   Minimal hooks-dispatcher render (node env, no DOM) — mirrors
   message-correlation-panel.test.jsx. Settles once with initial state.
   -------------------------------------------------------------------------- */
function renderOnce(Component, props) {
  const ReactInternals =
    React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED ||
    React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const prev = ReactInternals.ReactCurrentDispatcher.current;
  ReactInternals.ReactCurrentDispatcher.current = {
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useReducer: (reducer, init) => [init, () => {}],
    useEffect: (fn) => { try { fn(); } catch (_) { /* ignore */ } },
    useLayoutEffect: (fn) => { try { fn(); } catch (_) { /* ignore */ } },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
    useContext: () => undefined,
    useId: () => 'id',
  };
  try {
    return Component(props);
  } finally {
    ReactInternals.ReactCurrentDispatcher.current = prev;
  }
}

/** Collect string props (value/placeholder/label/aria-label/title) + string children. */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { for (const c of node) collectText(c, out); return out; }
  if (typeof node !== 'object') { if (typeof node === 'string') out.push(node); return out; }
  const p = node.props || {};
  for (const k of ['value', 'placeholder', 'label', 'aria-label', 'title']) {
    if (typeof p[k] === 'string') out.push(p[k]);
  }
  if (p.children !== undefined) collectText(p.children, out);
  return out;
}

/** Like collectText but EXCLUDES the machine `value` prop — only user-visible copy. */
function collectVisibleText(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { for (const c of node) collectVisibleText(c, out); return out; }
  if (typeof node !== 'object') { if (typeof node === 'string') out.push(node); return out; }
  const p = node.props || {};
  for (const k of ['placeholder', 'label', 'aria-label', 'title']) {
    if (typeof p[k] === 'string') out.push(p[k]);
  }
  if (p.children !== undefined) collectVisibleText(p.children, out);
  return out;
}

/** Find the first element node whose props satisfy `pred` (depth-first). */
function findElement(node, pred) {
  if (node === null || node === undefined) return null;
  if (Array.isArray(node)) {
    for (const c of node) { const r = findElement(c, pred); if (r) return r; }
    return null;
  }
  if (typeof node !== 'object') return null;
  if (pred(node)) return node;
  return findElement((node.props || {}).children, pred);
}

// Dummy chrome components — never invoked (collectText walks props.children).
const PanelGroup = ({ children }) => children;
const PPEntry = ({ children }) => children;

/** A boundary timer shape attached to a step that has exactly one outgoing. */
function makeBoundaryElement() {
  const next = { id: 'End_1', businessObject: { $type: 'bpmn:EndEvent' }, outgoing: [] };
  const host = { id: 'Task_1', businessObject: { $type: 'bpmn:UserTask' }, outgoing: [] };
  host.outgoing = [{ id: 'Flow_1', type: 'bpmn:SequenceFlow', source: host, target: next }];
  const bo = { $type: 'bpmn:BoundaryEvent', id: 'Boundary_1' };
  return { bo, element: { id: 'Boundary_1', businessObject: bo, host, outgoing: [] } };
}

describe('validateDeadline', () => {
  it('accepts a valid ISO-8601 duration', () => {
    expect(validateDeadline('duration', 'PT24H')).toBeNull();
    expect(validateDeadline('duration', 'P1D')).toBeNull();
    expect(validateDeadline('duration', 'P1DT12H')).toBeNull();
    expect(validateDeadline('duration', 'PT30M')).toBeNull();
  });
  it('rejects a non-ISO duration', () => {
    expect(validateDeadline('duration', '24 hours')).not.toBeNull();
    expect(validateDeadline('duration', 'soon')).not.toBeNull();
  });
  it('accepts an EL expression for duration', () => {
    expect(validateDeadline('duration', '${record.sla}')).toBeNull();
  });
  it('accepts a valid ISO-8601 date', () => {
    expect(validateDeadline('date', '2026-07-01')).toBeNull();
    expect(validateDeadline('date', '2026-07-01T14:00:00Z')).toBeNull();
  });
  it('rejects a non-ISO date', () => {
    expect(validateDeadline('date', 'next tuesday')).not.toBeNull();
  });
  it('accepts any non-empty field key', () => {
    expect(validateDeadline('field', 'dueDate')).toBeNull();
  });
  it('flags an empty deadline regardless of kind', () => {
    expect(validateDeadline('duration', '')).not.toBeNull();
    expect(validateDeadline('field', '   ')).not.toBeNull();
  });
});

describe('read/writeTimerAttr — dual-write round-trip', () => {
  it('writes both the registered property and the $attrs fallback', () => {
    const bo = {};
    writeTimerAttr(bo, 'timerDeadlineKind', 'choros:timerDeadlineKind', 'date');
    expect(bo.timerDeadlineKind).toBe('date');
    expect(bo.$attrs['choros:timerDeadlineKind']).toBe('date');
    expect(readTimerAttr(bo, 'timerDeadlineKind', 'choros:timerDeadlineKind')).toBe('date');
  });
  it('clearing removes both', () => {
    const bo = { timerDeadline: 'PT1H', $attrs: { 'choros:timerDeadline': 'PT1H' } };
    writeTimerAttr(bo, 'timerDeadline', 'choros:timerDeadline', '');
    expect(bo.timerDeadline).toBeUndefined();
    expect(bo.$attrs['choros:timerDeadline']).toBeUndefined();
  });
  it('read falls back to $attrs when the registered prop is absent (imported XML)', () => {
    const bo = { $attrs: { 'choros:escalateTo': 'manager' } };
    expect(readTimerAttr(bo, 'escalateTo', 'choros:escalateTo')).toBe('manager');
  });
  it('read returns the fallback when neither is set', () => {
    expect(readTimerAttr({}, 'escalateTo', 'choros:escalateTo', 'manager')).toBe('manager');
  });
});

describe('per-kind copy', () => {
  it('has a placeholder + hint for each deadline kind', () => {
    for (const k of DEADLINE_KINDS) {
      expect(deadlinePlaceholder(k.value)).toBeTruthy();
      expect(deadlineHint(k.value).length).toBeGreaterThan(0);
    }
  });
  it('exposes the three escalation targets', () => {
    expect(ESCALATION_TARGETS.map((t) => t.value)).toEqual(['manager', 'owner', 'role']);
  });
});

describe('TimerDeadlineExtension moddle descriptor', () => {
  it('declares the timer deadline + escalation attributes as isAttr on bpmn:CatchEvent', () => {
    const ext = descriptor.types.find((t) => t.name === 'TimerDeadlineExtension');
    expect(ext).toBeDefined();
    expect(ext.extends).toContain('bpmn:CatchEvent');
    const names = ext.properties.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining(['timerDeadlineKind', 'timerDeadline', 'escalateTo']),
    );
    for (const p of ext.properties) {
      expect(p.isAttr).toBe(true);
      expect(p.type).toBe('String');
    }
  });
});

/* --------------------------------------------------------------------------
   T-0660 — panel render: interrupt-mode control + escalation-branch affordance.
   -------------------------------------------------------------------------- */
describe('T-0660 — TimerDeadlinePanel renders the interrupt + escalation-branch controls', () => {
  it('shows the "останавливает шаг / работает параллельно" control for a BOUNDARY timer', () => {
    const { bo, element } = makeBoundaryElement();
    const tree = renderOnce(TimerDeadlinePanel, {
      bo, modeler: null, element, PanelGroup, PPEntry, roles: [], rolesLoading: false,
    });
    const joined = collectText(tree).join(' | ');
    // Human copy — NO jargon like cancelActivity / non-interrupting on screen.
    expect(joined).toMatch(/останавливает текущий шаг/i);
    expect(joined).toMatch(/работает параллельно/i);
    // Jargon must not appear in ANY user-visible copy (labels/children/aria).
    expect(collectVisibleText(tree).join(' | ')).not.toMatch(/cancelActivity|non-interrupting|boundary/i);
    // The one-click affordance is offered.
    expect(joined).toMatch(/собрать напоминание с эскалацией/i);
  });

  it('HIDES the interrupt control + build button for a free intermediate timer', () => {
    const bo = { $type: 'bpmn:IntermediateCatchEvent', id: 'Timer_free' };
    const tree = renderOnce(TimerDeadlinePanel, {
      bo, modeler: null, element: { businessObject: bo }, PanelGroup, PPEntry, roles: [], rolesLoading: false,
    });
    const joined = collectText(tree).join(' | ');
    expect(joined).not.toMatch(/останавливает текущий шаг/i);
    expect(joined).not.toMatch(/собрать напоминание/i);
    // The deadline + escalation-target controls still render.
    expect(joined).toMatch(/тип срока/i);
  });

  it('reflects a non-interrupting timer (cancelActivity=false) as "работает параллельно"', () => {
    const { element } = makeBoundaryElement();
    const bo = { $type: 'bpmn:BoundaryEvent', id: 'Boundary_1', cancelActivity: false };
    element.businessObject = bo;
    const tree = renderOnce(TimerDeadlinePanel, {
      bo, modeler: null, element, PanelGroup, PPEntry, roles: [], rolesLoading: false,
    });
    const sel = findElement(
      tree,
      (n) => n.type === 'select' && (n.props || {})['aria-label'] === 'Что делать с текущим шагом при срабатывании таймера',
    );
    expect(sel).toBeTruthy();
    expect(sel.props.value).toBe('non-interrupting');
  });

  it('enables the build button when preconditions hold, disables with a reason when not', () => {
    // Build-ready boundary (host with one outgoing).
    const ready = makeBoundaryElement();
    const okTree = renderOnce(TimerDeadlinePanel, {
      bo: ready.bo, modeler: null, element: ready.element, PanelGroup, PPEntry, roles: [], rolesLoading: false,
    });
    const okBtn = findElement(okTree, (n) => n.type === 'button');
    expect(okBtn).toBeTruthy();
    expect(okBtn.props.disabled).toBe(false);

    // Boundary already escalated (has an outgoing) → button disabled + reason surfaced.
    const built = makeBoundaryElement();
    built.element.outgoing = [{ id: 'Flow_out', type: 'bpmn:SequenceFlow', source: built.element, target: {} }];
    const noTree = renderOnce(TimerDeadlinePanel, {
      bo: built.bo, modeler: null, element: built.element, PanelGroup, PPEntry, roles: [], rolesLoading: false,
    });
    const noBtn = findElement(noTree, (n) => n.type === 'button');
    expect(noBtn.props.disabled).toBe(true);
    expect(collectText(noTree).join(' | ')).toMatch(/уже собрана/i);
  });
});
