/**
 * T-0459 [D8-R4] — MessageCorrelationPanel render test.
 *
 * The web test tier runs in the `node` environment (no jsdom / react-dom — see
 * web/vitest.config.js). So, like the rest of the canvas tests, we exercise the
 * component WITHOUT a DOM: a minimal React-hooks dispatcher lets the function
 * component actually run its useState/useEffect/useCallback hooks and produce an
 * element tree. We then assert the tree CONTAINS the expected fields (message name +
 * correlation record-field + the throw channel) — proving the panel renders and is
 * wired to the config contract, not a stub.
 *
 * This is the real-render counterpart to typed-element-config.test.jsx, which proves
 * the DISPATCH mounts MessageCorrelationPanel for kind:'message'.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessageCorrelationPanel } from './bpmn-properties-panel.jsx';
import { readMessageConfig } from './element-config-contract.js';

/**
 * Render a hook-bearing function component once in the node env by installing a
 * minimal hooks dispatcher onto React's internals. Supports useState (initial only),
 * useEffect/useLayoutEffect (run synchronously), useCallback/useMemo, useRef.
 * Sufficient for a settle-once render of a simple controlled panel.
 */
function renderOnce(Component, props) {
  const ReactInternals =
    React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED ||
    React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const prev = ReactInternals.ReactCurrentDispatcher.current;
  const dispatcher = {
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useReducer: (reducer, init) => [init, () => {}],
    useEffect: (fn) => { try { fn(); } catch (_) { /* effect cleanup ignored */ } },
    useLayoutEffect: (fn) => { try { fn(); } catch (_) { /* ignore */ } },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
    useContext: () => undefined,
    useId: () => 'id',
  };
  ReactInternals.ReactCurrentDispatcher.current = dispatcher;
  try {
    return Component(props);
  } finally {
    ReactInternals.ReactCurrentDispatcher.current = prev;
  }
}

/** Collect all string values of `value`/`placeholder`/`label`/`aria-label` props. */
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

describe('T-0459 — MessageCorrelationPanel renders the correlation config', () => {
  it('renders message-name, correlation record-field, and throw channel inputs from the bo', () => {
    const bo = {
      $type: 'bpmn:IntermediateCatchEvent',
      id: 'wait-1',
      $attrs: {
        'choros:messageName': 'contract-signed',
        'choros:correlationField': 'contract_number',
        'choros:throwChannelResourceId': 'chan-xyz',
      },
    };
    const tree = renderOnce(MessageCorrelationPanel, { bo, modeler: null, element: null });
    expect(tree).toBeTruthy();
    const text = collectText(tree);
    // The configured values surface as controlled input values.
    expect(text).toContain('contract-signed');
    expect(text).toContain('contract_number');
    expect(text).toContain('chan-xyz');
    // The panel labels the correlation-by-record-field control + the throw section.
    const joined = text.join(' | ');
    expect(joined).toMatch(/корреляц/i); // correlation field control present
    expect(joined).toMatch(/таймер|таймаут|ожидание/i); // the timeout reminder is rendered
  });

  it('renders cleanly for an empty bo (no config yet)', () => {
    const bo = { $type: 'bpmn:ReceiveTask', id: 'rt-1' };
    const tree = renderOnce(MessageCorrelationPanel, { bo, modeler: null, element: null });
    expect(tree).toBeTruthy();
    // readMessageConfig on an empty bo yields empty strings — no throw.
    expect(readMessageConfig(bo).messageName).toBe('');
  });
});

beforeEach(() => { /* no globals to stub */ });
afterEach(() => { vi.restoreAllMocks(); });
