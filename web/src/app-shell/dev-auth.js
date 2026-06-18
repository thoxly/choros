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
import { getToken } from './keycloak-auth.js';

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
