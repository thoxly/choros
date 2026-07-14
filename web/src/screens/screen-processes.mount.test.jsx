// @vitest-environment jsdom
/**
 * web/src/screens/screen-processes.mount.test.jsx  (T-0715)
 *
 * REAL DOM mount test — @testing-library/react + jsdom. See
 * web/src/forms/FormDesigner.mount.test.jsx for the full rationale (D-064: a
 * null-crash on the REAL mount path can pass an entire "node env,
 * source-presence" suite green — T-0706 proved it, 2641 vitest tests stayed
 * green, only browser live-proof caught it).
 *
 * screen-processes.test.jsx (sibling file, existing convention) asserts the
 * grid's wiring against the raw .jsx source text — it never actually renders
 * the component, so a null-crash on the initial /api/processes response shape
 * (e.g. `data.instances.map` before the `Array.isArray` guard, or a missing
 * PROCESSES_COLUMNS import) would pass that file green while a real /processes
 * visit shows a blank screen. This file closes that gap: mounts
 * `<ProcessesScreen />` with NO props (its actual usage — screen-processes.jsx
 * has no props at all, it is a route component) inside a MemoryRouter, mocks
 * the boot-time GETs, and asserts the mount reaches the loaded grid without
 * throwing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, waitFor, screen, cleanup } from '@testing-library/react';
import ProcessesScreen from './screen-processes.jsx';

const GENERIC_INSTANCE = {
  id: 'inst-generic-1',
  name: 'Generic Process',
  status: 'running',
  started: '2026-01-01 00:00',
  recordId: null,
  starterType: 'human',
  starterId: 'e-generic',
  starterName: 'Generic Starter',
};

function jsonOk(body) {
  return { ok: true, status: 200, json: async () => body };
}

function routeFetch(url) {
  const u = String(url);
  if (u.startsWith('/api/processes')) {
    return jsonOk({ instances: [GENERIC_INSTANCE], total: 1, limit: 50, offset: 0 });
  }
  if (u.startsWith('/api/process-catalog')) return jsonOk({ definitions: [] });
  if (u.startsWith('/api/user-prefs')) return jsonOk({ prefs: {} });
  return jsonOk({});
}

describe('ProcessesScreen — REAL mount (no props, actual route shape) (T-0715)', () => {
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

  it('shows the loading gate on first paint (instances === null)', () => {
    render(<MemoryRouter><ProcessesScreen /></MemoryRouter>);
    expect(screen.getByText('Загрузка процессов…')).toBeTruthy();
  });

  it('reaches the loaded grid after /api/processes resolves, without throwing', async () => {
    render(<MemoryRouter><ProcessesScreen /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.queryByText('Загрузка процессов…')).toBeNull();
    });
    // The row for the generic instance rendered (real DOM, not a source pin).
    expect(screen.getByText('Generic Process')).toBeTruthy();
    expect(document.querySelector('table.chs-itable')).toBeTruthy();
    expect(screen.getByText(/Показано 1 из 1/)).toBeTruthy();
  });

  it('reaches the honest empty grid when the tenant genuinely has zero instances, without throwing', async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith('/api/processes')) return jsonOk({ instances: [], total: 0, limit: 50, offset: 0 });
      return routeFetch(url);
    };
    render(<MemoryRouter><ProcessesScreen /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.queryByText('Загрузка процессов…')).toBeNull();
    });
    expect(screen.getByText('Нет активных процессов')).toBeTruthy();
  });
});
