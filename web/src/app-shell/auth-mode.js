/**
 * web/src/app-shell/auth-mode.js
 *
 * Runtime auth-mode + config holder for the browser SPA (T-0258).
 *
 * The server tells the frontend, at runtime, which auth mode it runs in and —
 * in keycloak mode — the public OIDC parameters needed to start a login flow.
 * We fetch GET /api/auth-config once at boot and cache the result.
 *
 *   dev:      { mode: "dev" }
 *   keycloak: { mode: "keycloak",
 *               keycloak: { url, realm, clientId, audience } }
 *
 * Everything in this file is plain JS (no JSX). The pure helpers
 * (normalizeAuthConfig, isKeycloakMode) are unit-tested without a browser.
 */

/** Default config if /api/auth-config is unreachable: dev mode (safe fallback). */
export const DEFAULT_AUTH_CONFIG = { mode: 'dev' };

let cachedConfig = null;

/**
 * Coerce an arbitrary parsed JSON value into a well-formed PublicAuthConfig.
 * Pure — defensive against missing/garbage fields so the shell never crashes.
 */
export function normalizeAuthConfig(raw) {
  if (!raw || typeof raw !== 'object') return { mode: 'dev' };
  const mode = raw.mode === 'keycloak' ? 'keycloak' : 'dev';
  if (mode !== 'keycloak') return { mode: 'dev' };
  const kc = raw.keycloak && typeof raw.keycloak === 'object' ? raw.keycloak : {};
  return {
    mode: 'keycloak',
    keycloak: {
      url: typeof kc.url === 'string' ? kc.url.replace(/\/+$/, '') : '',
      realm: typeof kc.realm === 'string' ? kc.realm : 'choros',
      clientId: typeof kc.clientId === 'string' ? kc.clientId : 'choros-web',
      audience: typeof kc.audience === 'string' ? kc.audience : 'choros-api',
    },
  };
}

/** Pure predicate: is this config object in keycloak mode? */
export function isKeycloakMode(config) {
  return !!config && config.mode === 'keycloak';
}

/**
 * Fetch + cache the auth config from the server. Returns DEFAULT_AUTH_CONFIG
 * (dev) on any network/parse error — fail-safe to the dev picker rather than a
 * blank screen. Subsequent calls return the cached value unless force=true.
 */
export async function loadAuthConfig(force = false) {
  if (cachedConfig && !force) return cachedConfig;
  try {
    const res = await fetch('/api/auth-config');
    if (!res.ok) {
      cachedConfig = DEFAULT_AUTH_CONFIG;
      return cachedConfig;
    }
    const data = await res.json();
    cachedConfig = normalizeAuthConfig(data);
  } catch {
    cachedConfig = DEFAULT_AUTH_CONFIG;
  }
  return cachedConfig;
}

/**
 * Synchronous accessor for the already-loaded config. Returns the cached value
 * or DEFAULT_AUTH_CONFIG (dev) if loadAuthConfig() hasn't resolved yet. The
 * header helper and keycloak module use this so they never block on a fetch.
 */
export function getAuthConfig() {
  return cachedConfig ?? DEFAULT_AUTH_CONFIG;
}

/** Test-only: reset the module cache. */
export function _resetAuthConfig() {
  cachedConfig = null;
}
