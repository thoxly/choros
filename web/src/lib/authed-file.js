/**
 * web/src/lib/authed-file.js  (T-0622)
 *
 * Shared Bearer-authed file fetch → blob helper, used by every screen that
 * previews or downloads a file attachment.
 *
 * Root cause fixed (re-LIVE_PROOF T-0579, real browser): the preview `<img
 * src="/api/files/:vid/download?disposition=inline">` and the download
 * `<a href="/api/files/:vid/download">` are NATIVE browser loads — the
 * browser does not attach the SPA's auth headers (X-Dev-User / Authorization:
 * Bearer) to them; only fetch()/XHR calls carry headers we set in JS. In
 * keycloak mode `withAuth` requires `Authorization: Bearer <token>`, so every
 * native `<img src>`/`<a href>` load 401s (dev mode's `X-Dev-User` header is
 * equally absent from native loads, but the dev-mode server path currently
 * tolerates the missing header for these routes — the bug is keycloak-mode
 * specific, per the ADR's live diagnosis).
 *
 * Fix (ADR T-0622, option b — single auth path, no new token surface): route
 * BOTH preview and download through fetch() with the SAME auth machinery
 * every other screen already uses — fetchWithAuthRetry (dev-auth.js, T-0608),
 * which attaches authHeaders() (Bearer in keycloak mode / X-Dev-User in dev
 * mode) and, in keycloak mode, self-heals a single mid-session token expiry
 * (silent refresh + one retry) instead of handing back a dead 401 — turn the
 * response into a blob, and hand the browser a same-origin `blob:` object URL
 * instead of the bare API path. No new token surface (no query-string token,
 * no cookie): the SAME header-building call every other fetch in this app
 * uses is reused verbatim.
 *
 * Anti-XSS (B1, preserved): this module does NOT decide what is "safe to
 * render inline" — that is the caller's job (mirroring the existing
 * PREVIEW_SAFE_IMAGE_SUBTYPES allowlist in screen-record-detail.jsx, which
 * mirrors the server's positive INLINE_SAFE_IMAGE_SUBTYPES allowlist in
 * src/http/files.ts). fetchFileBlob just fetches bytes; it is the caller's
 * responsibility to only build an <img> from a blob whose mime it already
 * allowlisted BEFORE calling this. downloadFile never renders anything inline
 * — it always sets `download` on the anchor, so the browser never executes
 * the blob's content regardless of mime (svg included).
 */

/**
 * Fetch a file-download URL with the current auth headers (+ mid-session
 * self-heal) and return the response as a Blob, or an honest error
 * descriptor — never throws.
 *
 * @param {string} url  the /api/files/:versionId/download[?disposition=inline] URL
 * @param {(url: string, init?: RequestInit) => Promise<Response>} fetcher
 *   defaults to fetchWithAuthRetry (dev-auth.js) — injectable for tests.
 * @returns {Promise<{ ok: true, blob: Blob, mime: string } | { ok: false, status: number|null, message: string }>}
 */
export async function fetchFileBlob(url, fetcher) {
  let res;
  try {
    res = await fetcher(url);
  } catch {
    return { ok: false, status: null, message: 'Сетевая ошибка — проверьте соединение' };
  }
  if (res.status === 401) {
    return { ok: false, status: 401, message: 'Сессия истекла — войдите снова' };
  }
  if (res.status === 403) {
    return { ok: false, status: 403, message: 'Нет доступа' };
  }
  if (res.status === 404) {
    return { ok: false, status: 404, message: 'Файл не найден' };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, message: `Не удалось загрузить файл (HTTP ${res.status})` };
  }
  let blob;
  try {
    blob = await res.blob();
  } catch {
    return { ok: false, status: res.status, message: 'Не удалось прочитать файл' };
  }
  const mime = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || blob.type || '';
  return { ok: true, blob, mime };
}

/**
 * Fetch `url` with auth headers and trigger a real browser download (a
 * programmatic `<a download>` click on a same-origin blob object URL — the
 * SAME pattern already used by downloadReportExport (screen-reports.jsx,
 * T-0492), bpmn-save-load.js, and shell.jsx). Ends every blob's object URL
 * lifetime after the click (revokeObjectURL) so it never leaks memory.
 *
 * Because `download` is always set, the browser NEVER renders the blob's
 * content inline, regardless of mime — this is the honest, safe download
 * path for every file including svg/html (server already forces
 * `attachment` for those; this is client-side belt-and-suspenders, not the
 * only guard).
 *
 * @param {string} url
 * @param {string} filename  suggested filename for the saved file
 * @param {(url: string, init?: RequestInit) => Promise<Response>} fetcher
 * @returns {Promise<{ ok: true } | { ok: false, status: number|null, message: string }>}
 */
export async function downloadFile(url, filename, fetcher) {
  const result = await fetchFileBlob(url, fetcher);
  if (!result.ok) return result;

  const objectUrl = URL.createObjectURL(result.blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Освобождаем object URL на следующем тике (Safari ломается при синхронном revoke).
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  return { ok: true };
}
