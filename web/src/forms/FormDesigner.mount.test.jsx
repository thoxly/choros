// @vitest-environment jsdom
/**
 * web/src/forms/FormDesigner.mount.test.jsx  (T-0715)
 *
 * REAL DOM mount test — @testing-library/react + jsdom, NOT the "source-
 * presence / renderToStaticMarkup" convention the sibling FormDesigner.test.jsx
 * uses (see that file's header for why: web/vitest.config.js is deliberately
 * "node" env, no jsdom/@testing-library anywhere in the repo — until now).
 *
 * WHY THIS FILE EXISTS (D-064 — green gates over a dead circuit):
 *
 * T-0706 shipped a real /forms screen crash: `registryDefs.map` on a null
 * state. 2641 vitest tests stayed green. Only a browser live-proof caught it.
 * The reason NO existing test caught it is structural, not an oversight:
 *
 *   1. FormDesigner.jsx's `{registryDefs && (...)}` picker block (the block
 *      that crashed) is nested inside `{!initialFields && (...)}` (line 1276)
 *      — it ONLY renders when the `initialFields` prop is ABSENT.
 *   2. Every existing FormDesigner.test.jsx render call passes
 *      `initialFields={FIELDS}` (the file's own documented "embedding/test
 *      mode" convention, chosen specifically to dodge the network + jsdom gap)
 *      — so the crashing block was NEVER reached by ANY existing test, not
 *      even as a static-markup mirror.
 *   3. The REAL /forms route mounts `<FormDesigner />` with NO props at all —
 *      exactly the one shape no test exercised.
 *
 * This file closes that gap: it mounts `<FormDesigner />` with NO props (the
 * real route shape), mocks fetch for the three boot-time GETs
 * (/api/applications, /api/process-catalog, /api/process-app-bindings), lets
 * the effects flush via `waitFor`, and asserts the mount reaches the picker
 * (registryDefs still null, no app picked — the EXACT state that crashed
 * T-0706) without throwing.
 *
 * RED→GREEN evidence (T-0715, recorded in T-0715.pr-handoff.json):
 *   - Reintroducing the pre-fix line — replacing the current
 *       `{registryDefs && (`
 *     wrapper with the old crashing form
 *       `{registryDefs && boundRegistryDef ? (`
 *     (i.e. dropping the outer `registryDefs &&` guard so the ternary chain's
 *     last arm calls `registryDefs.map` unconditionally) turns the
 *     "reaches the picker without throwing" test below RED (a real thrown
 *     TypeError inside React's render, caught by @testing-library/react and
 *     surfaced as a rejected act()/render() call) while EVERY pre-existing
 *     FormDesigner.test.jsx assertion (renderToStaticMarkup, initialFields set)
 *     stays GREEN — reproducing T-0706's exact "green CI, dead screen" failure
 *     mode. Reverting the break returns this file to GREEN.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, waitFor, screen, cleanup } from '@testing-library/react';
import FormDesigner from './FormDesigner.jsx';

const GENERIC_APPLICATION = { id: 'app-generic-1', slug: 'orders', display_name: 'Заказы' };

function jsonOk(body) {
  return { ok: true, status: 200, json: async () => body };
}

function routeFetch(url) {
  const u = String(url);
  if (u.startsWith('/api/applications')) return jsonOk({ applications: [GENERIC_APPLICATION] });
  if (u.startsWith('/api/process-catalog')) return jsonOk({ definitions: [] });
  if (u.startsWith('/api/process-app-bindings')) return jsonOk({ bindings: [] });
  // Honest default for any endpoint this mount does not need (registry-defs,
  // forms/binding, process def XML) — none of these fire before an app/process
  // is picked, but a generic empty 200 keeps an unexpected call from hanging.
  return jsonOk({});
}

describe('FormDesigner — REAL mount (no props, the actual /forms route shape) (T-0715)', () => {
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

  it('shows the loading gate on first paint (applications === null, no initialFields)', () => {
    render(<FormDesigner />);
    expect(screen.getByText('Загрузка приложений…')).toBeTruthy();
  });

  it('reaches the picker (registryDefs still null, no app picked) without throwing — the exact T-0706 crash state', async () => {
    render(<FormDesigner />);
    // Let /api/applications + /api/process-catalog + /api/process-app-bindings
    // resolve and the loading gate open. This is the async, multi-render-pass
    // sequence renderToStaticMarkup cannot drive (no effects, single pass) —
    // the MOUNT-GAP the sibling .test.jsx file documented but could not close.
    await waitFor(() => {
      expect(screen.queryByText('Загрузка приложений…')).toBeNull();
    });
    // The designer workspace (palette/canvas/inspector) is up.
    expect(document.querySelector('.chs-designer-palette')).toBeTruthy();
    expect(document.querySelector('.chs-designer-canvas')).toBeTruthy();
    expect(document.querySelector('.chs-designer-inspector')).toBeTruthy();
    // The picker section itself (only reachable without initialFields) rendered
    // — "Приложение" label — proving the {registryDefs && (...)} branch below
    // it was evaluated with registryDefs === null and did NOT throw.
    expect(screen.getByText('Приложение')).toBeTruthy();
  });
});
