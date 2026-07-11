// @vitest-environment jsdom
/**
 * web/src/screens/screen-record-detail.mount.test.jsx  (T-0715)
 *
 * REAL DOM mount test — @testing-library/react + jsdom. See
 * web/src/forms/FormDesigner.mount.test.jsx for the full D-064 rationale.
 *
 * screen-record-detail.test.jsx (sibling file, existing convention) asserts
 * wiring against the raw .jsx source text — it never renders RecordDetailScreen.
 * This mounts the REAL default export via its real route
 * (`/apps/:appId/records/:id`, useParams-driven — RecordDetailScreen reads
 * BOTH appId and id from the URL, so a bare <RecordDetailScreen/> with no
 * router match would silently exercise a degenerate id=undefined path
 * instead of the real one), inside ToastProvider + a matching <Route>, mocks
 * the boot-time GETs, and asserts the mount reaches the loaded record without
 * throwing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { render, waitFor, screen, cleanup } from '@testing-library/react';
import { ToastProvider } from '../app-shell/toast-context.jsx';
import RecordDetailScreen from './screen-record-detail.jsx';

const GENERIC_RECORD = {
  id: 'rec-generic-1',
  application_id: 'app-generic-1',
  registry_def_id: 'def-generic-1',
  record_schema_version: 1,
  record_schema: {
    type: 'object',
    properties: { title: { type: 'string', title: 'Title' } },
    'x-field-order': ['title'],
  },
  data: { title: 'Generic Title' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by: 'e-generic',
};

function jsonOk(body) {
  return { ok: true, status: 200, json: async () => body };
}

function routeFetch(url) {
  const u = String(url);
  if (u.startsWith('/api/records/rec-generic-1') && !u.includes('/links') && !u.includes('/files')) {
    return jsonOk(GENERIC_RECORD);
  }
  if (u.startsWith('/api/org')) return jsonOk({ departments: [] });
  if (u.includes('/api/processes?record=')) return jsonOk({ instances: [] });
  return jsonOk({});
}

function renderRecordDetail() {
  return render(
    <MemoryRouter initialEntries={['/apps/app-generic-1/records/rec-generic-1']}>
      <ToastProvider>
        <Routes>
          <Route path="/apps/:appId/records/:id" element={<RecordDetailScreen />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('RecordDetailScreen — REAL mount (real /apps/:appId/records/:id route) (T-0715)', () => {
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

  it('shows the loading gate on first paint (record === null)', () => {
    renderRecordDetail();
    expect(screen.getByText('Загрузка записи…')).toBeTruthy();
  });

  it('reaches the loaded record detail after GET /api/records/:id resolves, without throwing', async () => {
    renderRecordDetail();
    await waitFor(() => {
      expect(screen.queryByText('Загрузка записи…')).toBeNull();
    });
    expect(screen.getByText('Generic Title')).toBeTruthy();
    expect(screen.getByText('Редактировать')).toBeTruthy();
  });

  it('reaches the honest 404 EmptyState for a missing record, without throwing', async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith('/api/records/rec-generic-1') && !u.includes('/links') && !u.includes('/files')) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return routeFetch(url);
    };
    renderRecordDetail();
    await waitFor(() => {
      expect(screen.queryByText('Загрузка записи…')).toBeNull();
    });
    expect(screen.getByText('Запись не найдена')).toBeTruthy();
  });
});
