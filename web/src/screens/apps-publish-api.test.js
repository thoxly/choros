/**
 * web/src/screens/apps-publish-api.test.js  (T-0563)
 *
 * Unit tests for apps-publish-api.js — the thin client + pure helpers behind
 * «Опубликовать решение» (ADR T-0561, PD-26).
 *
 * Focus (per the task's frozen HTTP contract):
 *   - fetchPublishPreview: GET → normalized { items, counts }; error surfaces
 *     the honest server message.
 *   - publishSolution: POST → per-item results (all-ok AND partial-fail); a
 *     transport/5xx error throws with a readable message.
 *   - hasUnpublishedChanges: badge shows only for a PUBLISHED app whose preview
 *     has will_publish>0.
 *   - previewItemLabel / summarizeResults: the strings the dialog renders.
 *
 * Pattern mirrors process-editor-api.test.js (pure vitest, no DOM; fetch +
 * auth stubbed via globalThis / vi.mock).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub auth so the module import resolves outside the browser.
vi.mock('../app-shell/dev-auth.js', () => ({
  authHeaders: () => ({ 'x-dev-user': 'e-orlov' }),
}));

let _mockResponse = null;
function setMockResponse(status, body) {
  _mockResponse = { status, body };
}

beforeEach(() => {
  _mockResponse = { status: 200, body: {} };
  globalThis.fetch = vi.fn(async () => {
    const { status, body } = _mockResponse;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  });
});

afterEach(() => {
  delete globalThis.fetch;
  vi.restoreAllMocks();
});

import {
  fetchPublishPreview, publishSolution,
  normalizePreview, normalizeResults,
  previewItemLabel, hasUnpublishedChanges, summarizeResults,
  KIND_LABEL,
} from './apps-publish-api.js';

const PREVIEW_BODY = {
  app_id: 'app-1',
  items: [
    { kind: 'application', id: 'app-1', name: 'Закупки', tier: 'draft', will_publish: true },
    { kind: 'application', id: 'reg-1', name: 'Поставщики', tier: 'published', will_publish: false },
    { kind: 'process', id: 'proc-1', name: 'Согласование', tier: 'draft', will_publish: true },
    { kind: 'form', id: 'form-1', name: 'Шаг «Проверка»', tier: 'draft', will_publish: true },
  ],
  counts: { total: 4, to_publish: 3 },
};

describe('fetchPublishPreview → dialog list', () => {
  it('GETs the correct URL and returns normalized preview', async () => {
    setMockResponse(200, PREVIEW_BODY);
    const p = await fetchPublishPreview('app-1');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/applications/app-1/publish-preview',
      expect.objectContaining({ headers: { 'x-dev-user': 'e-orlov' } }),
    );
    expect(p.counts).toEqual({ total: 4, to_publish: 3 });
    expect(p.items).toHaveLength(4);
    // The confirm-list strings the dialog renders.
    expect(previewItemLabel(p.items[0])).toBe('приложение «Закупки»');
    expect(previewItemLabel(p.items[2])).toBe('процесс «Согласование»');
    expect(previewItemLabel(p.items[3])).toBe('форма шага «Шаг «Проверка»»');
  });

  it('surfaces the honest server error message on non-2xx', async () => {
    setMockResponse(500, { message: 'derive failed' });
    await expect(fetchPublishPreview('app-1')).rejects.toThrow('derive failed');
  });

  it('encodes the app id in the URL', async () => {
    setMockResponse(200, PREVIEW_BODY);
    await fetchPublishPreview('a/b');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/applications/a%2Fb/publish-preview',
      expect.anything(),
    );
  });
});

describe('publishSolution → per-item results', () => {
  it('all-ok: every result ok, all_ok true', async () => {
    setMockResponse(200, {
      app_id: 'app-1',
      results: [
        { kind: 'application', id: 'app-1', name: 'Закупки', ok: true, error: null },
        { kind: 'process', id: 'proc-1', name: 'Согласование', ok: true, error: null },
      ],
      all_ok: true,
    });
    const r = await publishSolution('app-1');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/applications/app-1/publish-solution',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(r.all_ok).toBe(true);
    const s = summarizeResults(r.results);
    expect(s).toEqual({ ok: 2, failed: 0, total: 2, allOk: true });
  });

  it('partial-fail: keeps every item, exposes the failing reason', async () => {
    setMockResponse(200, {
      app_id: 'app-1',
      results: [
        { kind: 'application', id: 'app-1', name: 'Закупки', ok: true, error: null },
        { kind: 'process', id: 'proc-1', name: 'Согласование', ok: false, error: 'BPMN невалиден' },
      ],
      all_ok: false,
    });
    const r = await publishSolution('app-1');

    expect(r.all_ok).toBe(false);
    const failing = r.results.filter((x) => !x.ok);
    expect(failing).toHaveLength(1);
    expect(failing[0].error).toBe('BPMN невалиден');
    expect(summarizeResults(r.results)).toEqual({ ok: 1, failed: 1, total: 2, allOk: false });
  });

  it('throws a readable message on a 5xx transport error (nothing published)', async () => {
    setMockResponse(503, { error: { message: 'движок недоступен' } });
    await expect(publishSolution('app-1')).rejects.toThrow('движок недоступен');
  });
});

describe('hasUnpublishedChanges → badge gating', () => {
  it('true only for a PUBLISHED app whose preview has to_publish > 0', () => {
    const preview = normalizePreview(PREVIEW_BODY); // to_publish: 3
    expect(hasUnpublishedChanges({ tier: 'published' }, preview)).toBe(true);
  });

  it('false for a draft app (it publishes wholesale, no "changes" badge)', () => {
    const preview = normalizePreview(PREVIEW_BODY);
    expect(hasUnpublishedChanges({ tier: 'draft' }, preview)).toBe(false);
  });

  it('false for a published app with nothing to publish', () => {
    const preview = normalizePreview({
      app_id: 'app-1',
      items: [{ kind: 'application', id: 'app-1', name: 'X', tier: 'published', will_publish: false }],
      counts: { total: 1, to_publish: 0 },
    });
    expect(hasUnpublishedChanges({ tier: 'published' }, preview)).toBe(false);
  });

  it('false on missing app or preview (tolerant)', () => {
    expect(hasUnpublishedChanges(null, normalizePreview(PREVIEW_BODY))).toBe(false);
    expect(hasUnpublishedChanges({ tier: 'published' }, null)).toBe(false);
  });
});

describe('normalizers are defensive against malformed payloads', () => {
  it('normalizePreview derives counts when the server omits them', () => {
    const p = normalizePreview({
      app_id: 'app-1',
      items: [
        { kind: 'application', id: 'a', name: 'A', tier: 'draft', will_publish: true },
        { kind: 'process', id: 'b', name: 'B', tier: 'published', will_publish: false },
      ],
    });
    expect(p.counts).toEqual({ total: 2, to_publish: 1 });
  });

  it('normalizePreview tolerates a non-array items field', () => {
    const p = normalizePreview({ app_id: 'x', items: null });
    expect(p.items).toEqual([]);
    expect(p.counts).toEqual({ total: 0, to_publish: 0 });
  });

  it('normalizeResults derives all_ok when the server omits it', () => {
    expect(normalizeResults({ results: [{ ok: true }, { ok: true }] }).all_ok).toBe(true);
    expect(normalizeResults({ results: [{ ok: true }, { ok: false }] }).all_ok).toBe(false);
    expect(normalizeResults({ results: [] }).all_ok).toBe(false);
  });
});

describe('KIND_LABEL covers the frozen contract kinds', () => {
  it('maps application/process/form to Russian labels', () => {
    expect(KIND_LABEL.application).toBe('приложение');
    expect(KIND_LABEL.process).toBe('процесс');
    expect(KIND_LABEL.form).toBe('форма шага');
  });
});
