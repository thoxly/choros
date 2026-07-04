/**
 * web/src/lib/authed-file.test.js  (T-0622)
 *
 * fetchFileBlob / downloadFile: the shared Bearer-authed fetch→blob helper
 * that replaces native `<img src>` / `<a href>` loads to
 * /api/files/:versionId/download (which do not carry the SPA's auth headers
 * — the P0 root cause, see ADR-T0622). No jsdom in this test tier (node
 * environment, web/vitest.config.js) — `document`/`URL.createObjectURL` are
 * stubbed manually, mirroring the existing pattern in
 * fetch-with-auth-retry.test.js (stub browser globals, no full DOM).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchFileBlob, downloadFile } from './authed-file.js';

function fakeBlob(mime) {
  return { type: mime, size: 3 };
}

function fakeResponse({ ok, status, contentType, blob }) {
  return {
    ok,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType ?? null : null) },
    blob: async () => blob,
  };
}

describe('fetchFileBlob (T-0622)', () => {
  it('calls the injected fetcher with the given URL (no second URL/token surface)', async () => {
    const calls = [];
    const fetcher = vi.fn(async (url) => {
      calls.push(url);
      return fakeResponse({ ok: true, status: 200, contentType: 'image/png', blob: fakeBlob('image/png') });
    });
    const result = await fetchFileBlob('/api/files/v1/download', fetcher);
    expect(calls).toEqual(['/api/files/v1/download']);
    expect(result.ok).toBe(true);
    expect(result.mime).toBe('image/png');
    expect(result.blob.type).toBe('image/png');
  });

  it('does not append any auth token to the URL itself — the fetcher owns header attachment', async () => {
    const fetcher = vi.fn(async () => fakeResponse({ ok: true, status: 200, contentType: 'image/png', blob: fakeBlob('image/png') }));
    await fetchFileBlob('/api/files/v1/download?disposition=inline', fetcher);
    const [url] = fetcher.mock.calls[0];
    expect(url).not.toMatch(/token|bearer|auth/i);
  });

  it('honest 401 → "Сессия истекла" (not a silently broken image)', async () => {
    const fetcher = vi.fn(async () => fakeResponse({ ok: false, status: 401 }));
    const result = await fetchFileBlob('/api/files/v1/download', fetcher);
    expect(result).toEqual({ ok: false, status: 401, message: 'Сессия истекла — войдите снова' });
  });

  it('honest 403 → "Нет доступа"', async () => {
    const fetcher = vi.fn(async () => fakeResponse({ ok: false, status: 403 }));
    const result = await fetchFileBlob('/api/files/v1/download', fetcher);
    expect(result).toEqual({ ok: false, status: 403, message: 'Нет доступа' });
  });

  it('honest 404 → "Файл не найден"', async () => {
    const fetcher = vi.fn(async () => fakeResponse({ ok: false, status: 404 }));
    const result = await fetchFileBlob('/api/files/v1/download', fetcher);
    expect(result).toEqual({ ok: false, status: 404, message: 'Файл не найден' });
  });

  it('honest 5xx → generic HTTP-coded message', async () => {
    const fetcher = vi.fn(async () => fakeResponse({ ok: false, status: 500 }));
    const result = await fetchFileBlob('/api/files/v1/download', fetcher);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.message).toContain('500');
  });

  it('network error (fetch throws) → honest offline message, never throws', async () => {
    const fetcher = vi.fn(async () => { throw new Error('network down'); });
    const result = await fetchFileBlob('/api/files/v1/download', fetcher);
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.message).toMatch(/сетев/i);
  });

  it('res.blob() rejecting → honest message, never throws', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      blob: async () => { throw new Error('stream broken'); },
    }));
    const result = await fetchFileBlob('/api/files/v1/download', fetcher);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/не удалось/i);
  });

  it('falls back to blob.type when the response has no content-type header', async () => {
    const fetcher = vi.fn(async () => fakeResponse({ ok: true, status: 200, contentType: null, blob: fakeBlob('image/gif') }));
    const result = await fetchFileBlob('/api/files/v1/download', fetcher);
    expect(result.mime).toBe('image/gif');
  });
});

describe('downloadFile (T-0622) — programmatic <a download> click on a blob object URL', () => {
  let createObjectURLCalls;
  let revokeObjectURLCalls;
  let appendedAnchors;

  beforeEach(() => {
    createObjectURLCalls = [];
    revokeObjectURLCalls = [];
    appendedAnchors = [];
    globalThis.URL.createObjectURL = vi.fn((blob) => {
      createObjectURLCalls.push(blob);
      return 'blob:fake-object-url';
    });
    globalThis.URL.revokeObjectURL = vi.fn((url) => revokeObjectURLCalls.push(url));
    globalThis.document = {
      createElement: vi.fn(() => {
        const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
        appendedAnchors.push(anchor);
        return anchor;
      }),
      body: { appendChild: vi.fn() },
    };
    vi.useFakeTimers();
  });

  afterEach(() => {
    delete globalThis.document;
    delete globalThis.URL.createObjectURL;
    delete globalThis.URL.revokeObjectURL;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('on success: builds an object URL, clicks a download anchor with the given filename, then revokes it', async () => {
    const fetcher = vi.fn(async () => fakeResponse({ ok: true, status: 200, contentType: 'application/pdf', blob: fakeBlob('application/pdf') }));

    const result = await downloadFile('/api/files/v1/download', 'contract.pdf', fetcher);

    expect(result).toEqual({ ok: true });
    expect(createObjectURLCalls).toHaveLength(1);
    expect(appendedAnchors).toHaveLength(1);
    expect(appendedAnchors[0].download).toBe('contract.pdf');
    expect(appendedAnchors[0].href).toBe('blob:fake-object-url');
    expect(appendedAnchors[0].click).toHaveBeenCalledTimes(1);
    expect(appendedAnchors[0].remove).toHaveBeenCalledTimes(1);

    // revoke happens on the next tick (Safari-safe), not synchronously.
    expect(revokeObjectURLCalls).toHaveLength(0);
    await vi.runAllTimersAsync();
    expect(revokeObjectURLCalls).toEqual(['blob:fake-object-url']);
  });

  it('svg/html blobs are downloaded the SAME way (download=, never rendered) — anti-XSS unaffected by this path', async () => {
    const fetcher = vi.fn(async () => fakeResponse({ ok: true, status: 200, contentType: 'image/svg+xml', blob: fakeBlob('image/svg+xml') }));
    const result = await downloadFile('/api/files/v1/download', 'evil.svg', fetcher);
    expect(result.ok).toBe(true);
    // The anchor always carries `download` — the browser saves the file, it
    // never navigates to/renders the blob: URL as a document.
    expect(appendedAnchors[0].download).toBe('evil.svg');
  });

  it('on 401/403/404/network error: does NOT touch the DOM (no anchor created), returns the honest error', async () => {
    const fetcher = vi.fn(async () => fakeResponse({ ok: false, status: 403 }));
    const result = await downloadFile('/api/files/v1/download', 'secret.docx', fetcher);
    expect(result).toEqual({ ok: false, status: 403, message: 'Нет доступа' });
    expect(createObjectURLCalls).toHaveLength(0);
    expect(appendedAnchors).toHaveLength(0);
  });

  it('defaults the filename to "download" when none is given', async () => {
    const fetcher = vi.fn(async () => fakeResponse({ ok: true, status: 200, contentType: 'application/octet-stream', blob: fakeBlob('application/octet-stream') }));
    await downloadFile('/api/files/v1/download', undefined, fetcher);
    expect(appendedAnchors[0].download).toBe('download');
  });
});
