/**
 * web/src/app-shell/dev-auth.js
 *
 * Session management for the browser SPA. Plain JS, no JSX.
 *
 * Two auth modes (T-0258), selected at runtime by GET /api/auth-config:
 *   - dev      → fake identity in localStorage, sent as the X-Dev-User header
 *                (unchanged legacy behaviour; the dev-user picker uses these).
 *   - keycloak → real OIDC session (see keycloak-auth.js), sent as
 *                Authorization: Bearer <token>.
 *
 * The CRITICAL contract here is the shared request-header helper. Every screen
 * imports it (historically as `devHeaders`); we keep that name as a back-compat
 * alias of the new mode-aware `authHeaders()` so NO per-screen change is needed
 * — the switch happens centrally based on the active auth mode.
 */

import { getAuthConfig, isKeycloakMode } from './auth-mode.js';
import { getToken, tryRefresh, login } from './keycloak-auth.js';

const KEY = 'chs-dev-user';

// ---------------------------------------------------------------------------
// Dev-mode identity (localStorage-backed fake user) — unchanged behaviour.
// ---------------------------------------------------------------------------

/**
 * Retrieve the currently logged-in dev user from localStorage.
 * Returns null if not logged in or on parse error.
 */
export function getDevUser() {
  try {
    const stored = localStorage.getItem(KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

/**
 * Store a dev user to localStorage.
 */
export function setDevUser(user) {
  localStorage.setItem(KEY, JSON.stringify(user));
}

/**
 * Clear the stored dev user.
 */
export function clearDevUser() {
  localStorage.removeItem(KEY);
}

// ---------------------------------------------------------------------------
// Mode-aware request headers (the shared helper every screen uses).
// ---------------------------------------------------------------------------

/**
 * Pure header builder — given the active mode + identities, returns the auth
 * headers a screen should attach to an API call. Exported for unit testing the
 * mode switch without a browser.
 *
 * @param {('dev'|'keycloak')} mode
 * @param {{id?: string}|null} devUser   dev-mode identity (X-Dev-User)
 * @param {string|null} token            keycloak access token (Bearer)
 * @returns {Record<string,string>}
 */
export function buildAuthHeaders(mode, devUser, token) {
  if (mode === 'keycloak') {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  // dev mode (default): X-Dev-User header from the picked dev identity.
  if (devUser && devUser.id) {
    return { 'X-Dev-User': devUser.id };
  }
  return {};
}

/**
 * Return request headers for authenticated API calls, selected by the active
 * auth mode:
 *   - keycloak → Authorization: Bearer <access token>
 *   - dev      → X-Dev-User: <dev-user id>   (legacy; unchanged)
 *
 * This is the canonical name. `devHeaders` below is a back-compat alias so the
 * existing screens that import `devHeaders` keep working in BOTH modes with no
 * change — the mode switch is centralized here.
 */
export function authHeaders() {
  const config = getAuthConfig();
  if (isKeycloakMode(config)) {
    return buildAuthHeaders('keycloak', null, getToken());
  }
  return buildAuthHeaders('dev', getDevUser(), null);
}

/**
 * @deprecated Use authHeaders(). Kept as a mode-aware back-compat alias so the
 * existing screens (apps, app-schema, app-records, inbox, processes, org,
 * audit, notifications, rights) need no change: in dev mode this still returns
 * X-Dev-User; in keycloak mode it returns Authorization: Bearer.
 */
export function devHeaders() {
  return authHeaders();
}

// ---------------------------------------------------------------------------
// T-0608 (пункт е) — mid-session 401 self-heal: refresh-once → retry-once →
// logout-redirect.
//
// Живой факт приёмки: an access token that expires WHILE the app is open (not
// at boot — shell.jsx's one-shot bootstrap already handles THAT case, see
// shell.jsx's kc.tryRefresh() call) makes every subsequent fetch 401. Screens
// showed a bare «Не удалось загрузить: HTTP 401» ErrorState whose «Повторить»
// button just re-sent the SAME dead token — a dead end only F5 could clear
// (F5 re-runs the shell bootstrap, which DOES refresh/redirect correctly).
//
// fetchWithAuthRetry wraps fetch with the SAME headers convention every screen
// already uses (authHeaders()) and, on a 401 in keycloak mode ONLY:
//   1. attempts ONE silent refresh (kc.tryRefresh — already used at boot);
//   2. on success, retries the ORIGINAL request ONCE with the refreshed token;
//   3. on refresh failure (or a second 401 after a successful refresh), redirects
//      to login (kc.login) instead of returning a dead 401 for the screen to
//      render as a stuck error state.
// Dev mode has no token/expiry concept (X-Dev-User is not time-limited) — the
// wrapper is a pure passthrough there, matching authHeaders()'s existing mode
// switch (NO behaviour change for dev-mode screens/tests).
//
// Scope (T-0608, kept minimal): this is a NEW opt-in helper, not a forced
// global fetch monkey-patch — existing screens keep working unchanged via
// plain fetch()+authHeaders(); callers that want the self-heal (starting with
// screen-inbox.jsx, where the live-факт was observed) opt in by calling this
// instead of fetch() directly.
// ---------------------------------------------------------------------------

/**
 * Fetch wrapper with automatic mid-session 401 recovery (keycloak mode only).
 *
 * @param {string} url
 * @param {RequestInit} [init] - same shape as fetch()'s init; `headers` (if
 *   any) are MERGED with authHeaders() (init.headers wins on key conflicts —
 *   e.g. a caller-supplied Content-Type).
 * @returns {Promise<Response>} the final Response — either the original
 *   success/non-401 response, or the retried response after a successful
 *   silent refresh. On an unrecoverable 401 this redirects to login (via
 *   kc.login, which navigates away) and the returned promise resolves to the
 *   original 401 Response so a caller already `await`-ing it does not hang
 *   (the navigation is already underway).
 */
export async function fetchWithAuthRetry(url, init = {}) {
  const buildInit = () => ({
    ...init,
    headers: { ...authHeaders(), ...(init.headers || {}) },
  });

  const res = await fetch(url, buildInit());
  if (res.status !== 401) return res;

  const config = getAuthConfig();
  if (!isKeycloakMode(config)) return res; // dev mode: no refresh concept, no-op.

  // Attempt exactly ONE silent refresh, then retry the request exactly ONCE.
  const refreshed = await tryRefresh(config.keycloak);
  if (!refreshed) {
    // No usable refresh token / refresh failed — tryRefresh already cleared
    // the stale session. Redirect to login rather than returning a dead 401
    // for the screen to render as a stuck "Повторить"-that-never-works error.
    await login(config.keycloak);
    return res;
  }

  const retryRes = await fetch(url, buildInit());
  if (retryRes.status === 401) {
    // Refreshed token STILL 401s (e.g. revoked session, not just expired) —
    // do not loop forever; redirect to login instead of retrying again.
    await login(config.keycloak);
  }
  return retryRes;
}
