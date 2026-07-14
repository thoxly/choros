// @vitest-environment jsdom
/**
 * web/src/screens/screen-inbox.mount.test.jsx  (T-0715)
 *
 * REAL DOM mount test — @testing-library/react + jsdom. See
 * web/src/forms/FormDesigner.mount.test.jsx for the full D-064 rationale (a
 * null-crash on the real mount path passed the whole node-env source-presence
 * suite for T-0706, only browser live-proof caught it).
 *
 * screen-inbox.test.jsx (sibling file, existing convention) asserts wiring
 * against the raw .jsx source text — it never renders InboxScreen, so a crash
 * anywhere in the real render/effect sequence (e.g. `items.map` before items
 * resolves, a provider missing from the tree, a bad GET /api/inbox response
 * shape) would stay invisible to that file. This closes the gap: mounts the
 * REAL default export `<InboxScreen />` (no props — it is a route component)
 * inside the SAME provider shape shell.jsx wraps it in (ToastProvider +
 * Router — InboxScreen calls useToastContext()/useNavigate()/useSearchParams()
 * directly, so both are load-bearing, not decorative), mocks the boot-time
 * GETs, and asserts the mount reaches the loaded list without throwing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, waitFor, screen, cleanup } from '@testing-library/react';
import { ToastProvider } from '../app-shell/toast-context.jsx';
import InboxScreen from './screen-inbox.jsx';

const GENERIC_TASK = {
  id: 'task-generic-1',
  name: 'Generic task',
  inst: 'inst-generic-1',
  processName: 'Generic Process',
  procKey: 'genericProc',
  step: 'genericStep',
  status: 'running',
  execType: 'human',
  execName: 'Generic Executor',
  claimedBy: null,
  claimedAt: null,
  pool: false,
  recordId: null,
  mine: true,
  canApprove: false,
  // SLACell (no fallback for a missing sla/deadline — real API contract
  // field, see screen-inbox.jsx SLACell) — a static (non-live) snapshot.
  sla: { left: 30, min: 60 },
  deadline: null,
  due: null,
};

function jsonOk(body) {
  return { ok: true, status: 200, json: async () => body };
}

function routeFetch(url) {
  const u = String(url);
  if (u.startsWith('/api/inbox?')) {
    return jsonOk({
      items: [GENERIC_TASK],
      groups: null,
      groupTruncated: false,
      page: 1,
      totalPages: 1,
      counts: { all: 1, mine: 1, pool: 0, esc: 0 },
    });
  }
  if (u.startsWith('/api/user-prefs')) return jsonOk({ prefs: {} });
  return jsonOk({});
}

function renderInbox() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <InboxScreen />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('InboxScreen — REAL mount (no props, actual route shape, real ToastProvider+Router) (T-0715)', () => {
  let originalFetch;
  let originalLocalStorage;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLocalStorage = globalThis.localStorage;
    globalThis.fetch = async (url) => routeFetch(url);
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });

  it('shows the loading gate on first paint (items === null)', () => {
    renderInbox();
    expect(screen.getByText('Загрузка задач…')).toBeTruthy();
  });

  it('reaches the loaded task list after /api/inbox resolves, without throwing', async () => {
    renderInbox();
    await waitFor(() => {
      expect(screen.queryByText('Загрузка задач…')).toBeNull();
    });
    expect(document.querySelector('.chs-task__name')).toBeTruthy();
  });

  it('reaches the honest tenant-wide-empty CTA when counts.all===0, without throwing', async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith('/api/inbox?')) {
        return jsonOk({
          items: [], groups: null, groupTruncated: false, page: 1, totalPages: 1,
          counts: { all: 0, mine: 0, pool: 0, esc: 0 },
        });
      }
      return routeFetch(url);
    };
    renderInbox();
    await waitFor(() => {
      expect(screen.queryByText('Загрузка задач…')).toBeNull();
    });
    expect(screen.getByText('Задач нет')).toBeTruthy();
  });
});
