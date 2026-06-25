/**
 * web/src/canvas/process-editor-api.test.js  (T-0483)
 *
 * Unit tests for process-editor-api.js — the API client behind the BPMN process
 * editor (screen-process-editor.jsx).
 *
 * Focus: publishProcessDef() must surface a CLEAR, TYPED engine-unavailable state
 * so the modeler can show an honest "движок недоступен" message and keep the
 * diagram a ЧЕРНОВИК (never a green "опубликовано"). Also covers the 422 lint path
 * and the generic error fallback.
 *
 * Pattern mirrors dmn-editor-api.test.js (pure vitest, no DOM; fetch + auth/tenant
 * modules stubbed via globalThis / vi.mock).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub auth + active-tenant modules so the imports resolve outside the browser.
vi.mock('../app-shell/dev-auth.js', () => ({
  authHeaders: () => ({ 'x-dev-user': 'e-orlov' }),
}));
vi.mock('../app-shell/active-tenant.js', () => ({
  getActiveTenantId: () => 'tenant-1',
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

import { publishProcessDef } from './process-editor-api.js';

describe('publishProcessDef — engine unavailable (T-0483)', () => {
  it('throws a typed ENGINE_UNAVAILABLE error with the honest backend message', async () => {
    setMockResponse(503, {
      error: {
        code: 'ENGINE_UNAVAILABLE',
        message:
          'Движок процессов недоступен. Изменения сохранены как черновик — повторите публикацию позже.',
      },
    });

    await expect(publishProcessDef('my-proc')).rejects.toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
    });

    // The thrown message must be the honest one — NOT an opaque "HTTP 503".
    try {
      await publishProcessDef('my-proc');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('ENGINE_UNAVAILABLE');
      expect(err.message).toContain('Движок процессов недоступен');
      expect(err.message).not.toMatch(/HTTP 503/);
    }
  });

  it('falls back to a sane Russian message if the body has no message', async () => {
    setMockResponse(503, { error: { code: 'ENGINE_UNAVAILABLE' } });
    try {
      await publishProcessDef('my-proc');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('ENGINE_UNAVAILABLE');
      expect(err.message).toContain('Движок процессов недоступен');
    }
  });
});

describe('publishProcessDef — lint failure (422)', () => {
  it('throws with violations attached and code BPMN_LINT_FAILED', async () => {
    setMockResponse(422, {
      error: { code: 'BPMN_LINT_FAILED', violations: ['нет стартового события'] },
    });
    try {
      await publishProcessDef('my-proc');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('BPMN_LINT_FAILED');
      expect(err.violations).toEqual(['нет стартового события']);
      expect(err.message).toContain('не прошла проверку');
    }
  });
});

describe('publishProcessDef — success + generic error', () => {
  it('returns the JSON body on 200', async () => {
    setMockResponse(200, { id: 'p1', processKey: 'my-proc', version: 2, status: 'published' });
    const res = await publishProcessDef('my-proc');
    expect(res.status).toBe('published');
    expect(res.version).toBe(2);
  });

  it('surfaces a generic publish error for other non-2xx codes', async () => {
    setMockResponse(500, { error: { code: 'INTERNAL', message: 'boom' } });
    await expect(publishProcessDef('my-proc')).rejects.toThrow(/Ошибка публикации/);
  });
});
