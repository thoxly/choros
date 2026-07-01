/**
 * web/src/screens/apps-manage-api.test.js  (T-0567)
 *
 * Unit tests for apps-manage-api.js — the fetch helpers behind the «управление
 * приложением» row menu (Переименовать / Удалить приложение).
 *
 * Frozen HTTP contract (src/http/applications.ts):
 *   PATCH  /api/applications/:id { display_name } → 200 { …app } · 400 · 404
 *   DELETE /api/applications/:id                  → 204 · 404 · 409
 *
 * Pattern mirrors apps-publish-api.test.js (pure vitest node env, no DOM;
 * fetch + auth stubbed via globalThis / vi.mock).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub auth so the module import resolves outside the browser.
vi.mock('../app-shell/dev-auth.js', () => ({
  devHeaders: () => ({ 'x-dev-user': 'e-orlov' }),
}));

let _mockResponse = null;
let _lastCall = null;
function setMockResponse(status, body) {
  _mockResponse = { status, body };
}

beforeEach(() => {
  _mockResponse = { status: 200, body: {} };
  _lastCall = null;
  globalThis.fetch = vi.fn(async (url, init) => {
    _lastCall = { url, init };
    const { status, body } = _mockResponse;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new Error('no body');
        return body;
      },
    };
  });
});

afterEach(() => {
  delete globalThis.fetch;
  vi.restoreAllMocks();
});

import { renameApplication, deleteApplication } from './apps-manage-api.js';

const APP_ID = '11111111-1111-1111-1111-111111111111';

describe('renameApplication — PATCH display_name', () => {
  it('PATCHes the id with the new display_name and returns the updated app', async () => {
    setMockResponse(200, { id: APP_ID, slug: 'zakupka', display_name: 'Закупки 2' });
    const result = await renameApplication(APP_ID, 'Закупки 2');

    expect(result.ok).toBe(true);
    expect(result.app.display_name).toBe('Закупки 2');

    // Verify the wire call: correct method, URL, and body.
    expect(_lastCall.url).toBe(`/api/applications/${APP_ID}`);
    expect(_lastCall.init.method).toBe('PATCH');
    expect(JSON.parse(_lastCall.init.body)).toEqual({ display_name: 'Закупки 2' });
    expect(_lastCall.init.headers['x-dev-user']).toBe('e-orlov');
  });

  it('surfaces the honest server message on 400 VALIDATION', async () => {
    setMockResponse(400, { message: 'display_name must be a non-empty string' });
    const result = await renameApplication(APP_ID, 'x');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.message).toBe('display_name must be a non-empty string');
  });

  it('returns ok:false on transport error', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('network down'); });
    const result = await renameApplication(APP_ID, 'x');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('network down');
  });
});

describe('deleteApplication — DELETE (204/404/409)', () => {
  it('DELETEs the id and returns ok on 204', async () => {
    setMockResponse(204, undefined); // 204 has no body
    const result = await deleteApplication(APP_ID);

    expect(result.ok).toBe(true);
    expect(_lastCall.url).toBe(`/api/applications/${APP_ID}`);
    expect(_lastCall.init.method).toBe('DELETE');
    expect(_lastCall.init.headers['x-dev-user']).toBe('e-orlov');
  });

  it('surfaces the honest server message on 409 CONFLICT', async () => {
    setMockResponse(409, { message: 'приложение используется другими объектами (отчёты, документы, связи)' });
    const result = await deleteApplication(APP_ID);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.message).toContain('используется другими объектами');
  });

  it('falls back to an honest 409 message when the body has none', async () => {
    setMockResponse(409, undefined);
    const result = await deleteApplication(APP_ID);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.message).toBe('Приложение используется другими объектами и не может быть удалено');
  });

  it('reports 404 NOT_FOUND', async () => {
    setMockResponse(404, { message: 'application not found' });
    const result = await deleteApplication(APP_ID);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.message).toBe('application not found');
  });
});
