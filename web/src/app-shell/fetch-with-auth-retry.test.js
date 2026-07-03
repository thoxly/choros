/**
 * web/src/app-shell/fetch-with-auth-retry.test.js  (T-0608, пункт е)
 *
 * Живой факт приёмки: a mid-session-expired Keycloak access token made every
 * subsequent screen fetch 401 — screens rendered a dead "Не удалось загрузить:
 * HTTP 401" whose «Повторить» just resent the SAME expired token (only F5
 * fixed it, because F5 re-runs the shell's one-shot boot-time refresh).
 *
 * fetchWithAuthRetry (dev-auth.js) closes that gap for any screen that opts
 * in: on a 401 in keycloak mode it attempts ONE silent refresh (reusing
 * keycloak-auth.js's existing tryRefresh — already used at boot in
 * shell.jsx), retries ONCE with the refreshed token, and redirects to login
 * (rather than returning a dead 401) if the refresh fails or the retry still
 * 401s. In dev mode it is a pure passthrough (no token/expiry concept there).
 *
 * Same node-env stubbing convention as auth-headers.test.js (no jsdom): a
 * minimal localStorage stub + globalThis.fetch swapped per test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fetchWithAuthRetry, setDevUser, clearDevUser } from './dev-auth.js';
import { loadAuthConfig, _resetAuthConfig } from './auth-mode.js';
import { persistSession, clearSession } from './keycloak-auth.js';

function installLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  return store;
}

function installSessionStorage() {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

async function installKeycloakMode() {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      mode: 'keycloak',
      keycloak: { url: 'http://localhost:8180', realm: 'choros', clientId: 'choros-web', audience: 'choros-api' },
    }),
  });
  await loadAuthConfig(true);
}

function stubLocationAssign() {
  const assigns = [];
  // window.location.assign is called by kc.login(); jsdom-less node has no
  // `window`, so keycloak-auth.js's login() reads `window.location.origin`
  // via a default arg — we provide a minimal fake `window` global instead.
  globalThis.window = {
    location: { origin: 'http://localhost:5173', assign: (url) => assigns.push(url) },
  };
  return assigns;
}

describe('fetchWithAuthRetry (T-0608 пункт е)', () => {
  beforeEach(() => {
    installLocalStorage();
    installSessionStorage();
    _resetAuthConfig();
    clearSession();
    clearDevUser();
  });
  afterEach(() => {
    delete globalThis.window;
  });

  it('dev mode: passes through unchanged on a non-401 response (no refresh concept in dev mode)', async () => {
    setDevUser({ id: 'e-test-dev-user' });
    globalThis.fetch = async (url, init) => {
      expect(init.headers['X-Dev-User']).toBe('e-test-dev-user');
      return { ok: true, status: 200, json: async () => ({ hello: 'world' }) };
    };
    // dev mode is the DEFAULT_AUTH_CONFIG (no explicit fetch of /api/auth-config needed).
    const res = await fetchWithAuthRetry('/api/inbox');
    expect(res.ok).toBe(true);
  });

  it('dev mode: a 401 is returned as-is — no refresh/login attempted (dev mode has no token expiry)', async () => {
    setDevUser({ id: 'e-test-dev-user' });
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: false, status: 401, json: async () => ({}) };
    };
    const res = await fetchWithAuthRetry('/api/inbox');
    expect(res.status).toBe(401);
    expect(calls).toBe(1); // no retry attempted in dev mode
  });

  it('keycloak mode: a non-401 response passes through with Bearer headers, no refresh attempted', async () => {
    await installKeycloakMode();
    persistSession({ accessToken: 'tok-live', refreshToken: 'refresh-1', expiresAt: Date.now() + 60000, user: { id: 's' } });
    globalThis.fetch = async (url, init) => {
      expect(init.headers.Authorization).toBe('Bearer tok-live');
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const res = await fetchWithAuthRetry('/api/inbox');
    expect(res.ok).toBe(true);
  });

  it('keycloak mode: a 401 triggers ONE silent refresh, then ONE retry with the refreshed token — succeeds', async () => {
    await installKeycloakMode();
    persistSession({ accessToken: 'tok-dead', refreshToken: 'refresh-1', expiresAt: Date.now() - 1000, user: { id: 's' } });

    let fetchCallCount = 0;
    globalThis.fetch = async (url, init) => {
      fetchCallCount++;
      // Call 1 (original, dead token) → 401.
      if (fetchCallCount === 1) {
        expect(init.headers.Authorization).toBe('Bearer tok-dead');
        return { ok: false, status: 401, json: async () => ({}) };
      }
      // Call 2 (tryRefresh's own token-endpoint POST) → fresh tokens.
      if (fetchCallCount === 2) {
        return { ok: true, json: async () => ({ access_token: 'tok-fresh', refresh_token: 'refresh-2', expires_in: 300 }) };
      }
      // Call 3 (the RETRY, with the refreshed token) → success.
      expect(init.headers.Authorization).toBe('Bearer tok-fresh');
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    };

    const res = await fetchWithAuthRetry('/api/inbox');
    expect(res.ok).toBe(true);
    expect(fetchCallCount).toBe(3);
  });

  it('keycloak mode: refresh fails (no usable refresh token) → redirects to login instead of returning a dead retry loop', async () => {
    await installKeycloakMode();
    persistSession({ accessToken: 'tok-dead', refreshToken: null, expiresAt: Date.now() - 1000, user: { id: 's' } });
    const assigns = stubLocationAssign();

    let fetchCallCount = 0;
    globalThis.fetch = async () => {
      fetchCallCount++;
      return { ok: false, status: 401, json: async () => ({}) };
    };

    const res = await fetchWithAuthRetry('/api/inbox');
    expect(res.status).toBe(401);
    // Only the original call — tryRefresh short-circuits on no refresh token
    // (no token-endpoint POST attempted), then login() redirects.
    expect(fetchCallCount).toBe(1);
    expect(assigns.length).toBe(1); // redirected to the KC authorize endpoint
    expect(assigns[0]).toContain('/protocol/openid-connect/auth');
  });

  it('keycloak mode: refresh succeeds but the retry STILL 401s (revoked session) → redirects to login (never loops)', async () => {
    await installKeycloakMode();
    persistSession({ accessToken: 'tok-dead', refreshToken: 'refresh-1', expiresAt: Date.now() - 1000, user: { id: 's' } });
    const assigns = stubLocationAssign();

    let fetchCallCount = 0;
    globalThis.fetch = async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) return { ok: false, status: 401, json: async () => ({}) };
      if (fetchCallCount === 2) return { ok: true, json: async () => ({ access_token: 'tok-fresh-2', refresh_token: 'refresh-3', expires_in: 300 }) };
      return { ok: false, status: 401, json: async () => ({}) }; // retry STILL 401s
    };

    const res = await fetchWithAuthRetry('/api/inbox');
    expect(res.status).toBe(401);
    expect(fetchCallCount).toBe(3); // original + refresh + ONE retry — never a second retry loop
    expect(assigns.length).toBe(1);
  });

  it('merges caller-supplied headers (e.g. Content-Type) with auth headers, caller wins on conflict', async () => {
    setDevUser({ id: 'e-test-dev-user' });
    globalThis.fetch = async (url, init) => {
      expect(init.headers['content-type']).toBe('application/json');
      expect(init.headers['X-Dev-User']).toBe('e-test-dev-user');
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const res = await fetchWithAuthRetry('/api/inbox/x/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.ok).toBe(true);
  });
});
