/* ============================================================================
   CHOROS — apps-manage-api.js  (T-0567)

   Fetch helpers for the «управление приложением» row menu on screen-apps.jsx.
   Logic lives here (a .js sibling) so it is unit-testable in the node vitest
   tier without DOM rendering — same doctrine as apps-publish-api.js /
   apps-validate.js (web/vitest.config.js).

   Frozen HTTP contract (src/http/applications.ts):
     PATCH  /api/applications/:id  { display_name }  → 200 { …updated app }
                                                     · 400 VALIDATION · 404
     DELETE /api/applications/:id                    → 204 (no body)
                                                     · 404 NOT_FOUND · 409 CONFLICT

   Both return a discriminated result object rather than throwing on non-2xx,
   so the caller renders honest inline / toast errors (server message preferred).
   ============================================================================ */

import { devHeaders } from '../app-shell/dev-auth.js';

/**
 * renameApplication — PATCH the display_name of one application.
 *
 * @param {string} id            application uuid
 * @param {string} displayName   new name (caller should trim/validate non-empty first)
 * @returns {Promise<{ ok: true, app: object } | { ok: false, status: number, message: string }>}
 */
export async function renameApplication(id, displayName) {
  let res;
  try {
    res = await fetch(`/api/applications/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...devHeaders() },
      body: JSON.stringify({ display_name: displayName }),
    });
  } catch (err) {
    return { ok: false, status: 0, message: String(err?.message || err) };
  }
  if (res.ok) {
    const app = await res.json();
    return { ok: true, app };
  }
  let parsed = null;
  try { parsed = await res.json(); } catch { /* non-JSON error body */ }
  return { ok: false, status: res.status, message: parsed?.message || `Ошибка ${res.status}` };
}

/**
 * deleteApplication — DELETE one application (frozen contract → 204/404/409).
 *
 * @param {string} id  application uuid
 * @returns {Promise<{ ok: true } | { ok: false, status: number, message: string }>}
 *   409 → honest "still referenced" message (server message preferred).
 */
export async function deleteApplication(id) {
  let res;
  try {
    res = await fetch(`/api/applications/${id}`, {
      method: 'DELETE',
      headers: devHeaders(),
    });
  } catch (err) {
    return { ok: false, status: 0, message: String(err?.message || err) };
  }
  if (res.status === 204) return { ok: true };
  let parsed = null;
  try { parsed = await res.json(); } catch { /* non-JSON / empty error body */ }
  const fallback = res.status === 409
    ? 'Приложение используется другими объектами и не может быть удалено'
    : `Не удалось удалить (${res.status})`;
  return { ok: false, status: res.status, message: parsed?.message || fallback };
}
