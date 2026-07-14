/**
 * web/src/screens/list-view-panel.honest-loading.test.jsx — T-0581 UX-1
 * (blocking, fix-forward) regression test.
 *
 * THE DEFECT (UX-1, from the UX_REVIEW that blocked this task): the panel's
 * re-seed effect deps were [open, activeView && activeView.id] — NOT including
 * defaultViewConfig/sourceConfig. When the panel opened BEFORE GET
 * /api/list-views resolved (defaultViewConfig === null), draftFromConfig(null,
 * catalog) seeded a draft where EVERY column is visible:false (see
 * list-view-panel.js draftFromConfig — an unmentioned catalog field is pushed
 * with visible:false). The panel rendered an editable "all columns hidden"
 * form — the OPPOSITE of the server's real default (all columns visible) —
 * with no Loading state to explain why, and nothing forced a re-seed once the
 * real default arrived. A user could save that dishonest draft and produce a
 * saved view hiding all their data.
 *
 * THE FIX (variant "б" + "а" together, per the task brief):
 *   (б) useListViews now exposes a `loading` flag; the panel renders the kit
 *       <LoadingState> instead of an editable form while
 *       (!activeView && defaultViewConfig == null && viewsLoading !== false),
 *       and disables Save (canEdit) in that state — never showing or letting
 *       the user save the provisional "all hidden" seed.
 *   (а) the re-seed effect's deps now include sourceConfig (which changes
 *       identity once defaultViewConfig arrives) — so if the panel is left
 *       open across the resolve, the draft self-corrects to the honest
 *       default rather than staying stuck on the dishonest one, UNLESS the
 *       user already started editing (dirty guard).
 *
 * TEST APPROACH: this project's test tier runs in the vitest "node"
 * environment (no jsdom/react-dom — web/vitest.config.js). Following the
 * project's existing no-DOM render convention (see
 * web/src/canvas/message-correlation-panel.test.jsx), we install a minimal
 * React hooks dispatcher and call ListViewPanel as a plain function, then walk
 * the returned element tree. useState's setter is a no-op in this harness, so
 * what we assert is driven by the INITIAL render given a prop combination —
 * exactly the "panel just opened, defaultViewConfig may or may not have
 * arrived yet" moment the defect was about.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { ListViewPanel } from './list-view-panel.jsx';

const SCHEMA_COLUMNS = [
  { key: 'amount', label: 'Сумма', type: 'money' },
  { key: 'status', label: 'Статус', type: 'select' },
];

/** Minimal settle-once hooks dispatcher — mirrors message-correlation-panel.test.jsx. */
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

function isReactElementish(v) {
  return v !== null && typeof v === 'object' && ('type' in v || Array.isArray(v));
}

/**
 * Flatten a React element tree into a list of { type, props } nodes. Walks
 * EVERY prop that looks like an element/array of elements (not just
 * `children`) — Drawer receives its footer as a separate `footer` prop, not
 * as children, so a children-only walk would miss the Save/Cancel buttons.
 */
function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) { for (const c of node) flatten(c, out); return out; }
  if (typeof node !== 'object') return out;
  out.push(node);
  const props = node.props || {};
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (isReactElementish(value)) flatten(value, out);
  }
  return out;
}

function typeName(node) {
  if (typeof node.type === 'string') return node.type;
  if (typeof node.type === 'function') return node.type.name || 'AnonymousComponent';
  return String(node.type);
}

function findByTypeName(tree, name) {
  return flatten(tree).filter((n) => typeName(n) === name);
}

/** Collect visible string leaves (labels/placeholders/messages/children text). */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { for (const c of node) collectText(c, out); return out; }
  if (typeof node !== 'object') { if (typeof node === 'string') out.push(node); return out; }
  const p = node.props || {};
  for (const k of ['label', 'title', 'message', 'description', 'value', 'placeholder']) {
    if (typeof p[k] === 'string') out.push(p[k]);
  }
  if (p.children !== undefined) collectText(p.children, out);
  return out;
}

const baseProps = {
  open: true,
  onClose: () => {},
  schemaColumns: SCHEMA_COLUMNS,
  activeView: null,
  onApply: () => {},
  views: [],
  viewsError: null,
  saveView: async () => ({ ok: true, view: { id: 'v1' } }),
  deleteView: async () => ({ ok: true }),
};

describe('ListViewPanel — honest Loading state while the default view is in flight (UX-1)', () => {
  it('renders the kit LoadingState (not an editable form) when defaultViewConfig is null and viewsLoading is true', () => {
    const tree = renderOnce(ListViewPanel, {
      ...baseProps,
      defaultViewConfig: null,
      viewsLoading: true,
    });
    expect(findByTypeName(tree, 'LoadingState')).toHaveLength(1);
    // The columns editor must NOT be mounted while awaiting the default —
    // there is nothing honest to show yet.
    expect(findByTypeName(tree, 'ColumnsEditor')).toHaveLength(0);
  });

  it('renders LoadingState even when viewsLoading is omitted (undefined) — defaults to the SAFE (loading) reading, never a false "ready" state', () => {
    const tree = renderOnce(ListViewPanel, {
      ...baseProps,
      defaultViewConfig: null,
      // viewsLoading intentionally omitted
    });
    expect(findByTypeName(tree, 'LoadingState')).toHaveLength(1);
  });

  it('the Save button is disabled while awaiting the default (never lets the provisional "all hidden" draft be committed)', () => {
    const tree = renderOnce(ListViewPanel, {
      ...baseProps,
      defaultViewConfig: null,
      viewsLoading: true,
    });
    const saveButtons = findByTypeName(tree, 'Button').filter(
      (n) => collectText(n).some((t) => t.includes('Сохранить представление')),
    );
    expect(saveButtons.length).toBeGreaterThan(0);
    expect(saveButtons[0].props.disabled).toBe(true);
  });

  it('once the default resolves (defaultViewConfig present, viewsLoading false), the panel renders the editable columns editor — no LoadingState', () => {
    const tree = renderOnce(ListViewPanel, {
      ...baseProps,
      defaultViewConfig: {
        // A real synthetic default mentions EVERY catalog column (including
        // the created_at pseudo-column buildFieldCatalog appends) as visible
        // — an unmentioned catalog column is treated as "added after this
        // config was built" and defaults to hidden (see draftFromConfig),
        // which is a different, legitimate case from "still loading".
        columns: [
          { field_key: 'amount', visible: true },
          { field_key: 'status', visible: true },
          { field_key: 'created_at', visible: true },
        ],
        filters: [],
        sort: [],
      },
      viewsLoading: false,
    });
    expect(findByTypeName(tree, 'LoadingState')).toHaveLength(0);
    expect(findByTypeName(tree, 'ColumnsEditor')).toHaveLength(1);
    // The seeded draft's columns come from the REAL default — every one
    // visible, matching the server's synthetic default (ADR §3.3), never the
    // dishonest "all hidden" shape draftFromConfig(null, ...) would produce.
    const columnsEditor = findByTypeName(tree, 'ColumnsEditor')[0];
    const columns = columnsEditor.props.columns;
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.every((c) => c.visible === true)).toBe(true);
  });

  it('an ACTIVE saved view is editable immediately even if defaultViewConfig is still null (a real view is a resolved source of truth on its own)', () => {
    const tree = renderOnce(ListViewPanel, {
      ...baseProps,
      activeView: {
        id: 'v1',
        name: 'Мой список',
        is_default: false,
        config: { columns: [{ field_key: 'amount', visible: true }], filters: [], sort: [] },
      },
      defaultViewConfig: null,
      viewsLoading: false,
    });
    expect(findByTypeName(tree, 'LoadingState')).toHaveLength(0);
    expect(findByTypeName(tree, 'ColumnsEditor')).toHaveLength(1);
  });

  it('a viewsError takes priority over the loading state (an honest ErrorState, not an infinite spinner)', () => {
    const tree = renderOnce(ListViewPanel, {
      ...baseProps,
      defaultViewConfig: null,
      viewsLoading: true,
      viewsError: 'HTTP 500',
    });
    expect(findByTypeName(tree, 'ErrorState')).toHaveLength(1);
    expect(findByTypeName(tree, 'LoadingState')).toHaveLength(0);
  });
});

describe('ListViewPanel — UX-2: warns when a saved draft would hide every column', () => {
  it('shows a warning Notice when the default view config already has every column hidden', () => {
    const tree = renderOnce(ListViewPanel, {
      ...baseProps,
      defaultViewConfig: {
        columns: [
          { field_key: 'amount', visible: false },
          { field_key: 'status', visible: false },
        ],
        filters: [],
        sort: [],
      },
      viewsLoading: false,
    });
    const warningNotices = findByTypeName(tree, 'Notice').filter((n) => n.props.tone === 'warning');
    expect(warningNotices.length).toBeGreaterThan(0);
    const text = collectText(warningNotices[0]).join(' | ');
    expect(text).toMatch(/скрыт/i);
  });

  it('does NOT warn when at least one column is visible', () => {
    const tree = renderOnce(ListViewPanel, {
      ...baseProps,
      defaultViewConfig: {
        columns: [
          { field_key: 'amount', visible: true },
          { field_key: 'status', visible: false },
        ],
        filters: [],
        sort: [],
      },
      viewsLoading: false,
    });
    const warningNotices = findByTypeName(tree, 'Notice').filter((n) => n.props.tone === 'warning');
    expect(warningNotices).toHaveLength(0);
  });
});
