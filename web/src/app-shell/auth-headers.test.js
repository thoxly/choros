/**
 * web/src/app-shell/auth-headers.test.js
 *
 * T-0258 — mode-aware auth-header switching + auth-config normalization.
 *
 * These are the CRITICAL guarantees for "do not break existing screens":
 *   - in dev mode the shared helper still emits X-Dev-User (legacy behaviour);
 *   - in keycloak mode it emits Authorization: Bearer instead;
 *   - the back-compat `devHeaders` alias behaves identically to `authHeaders`.
 *
 * Pure logic is tested directly. For the impure `authHeaders()`/`devHeaders()`
 * we install minimal localStorage + cache stubs so the switch is exercised
 * end-to-end without a browser.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildAuthHeaders,
  authHeaders,
  devHeaders,
  setDevUser,
  getDevUser,
  clearDevUser,
} from './dev-auth.js';
import {
  normalizeAuthConfig,
  isKeycloakMode,
  loadAuthConfig,
  getAuthConfig,
  _resetAuthConfig,
  DEFAULT_AUTH_CONFIG,
} from './auth-mode.js';
import { persistSession, clearSession } from './keycloak-auth.js';

// --- minimal localStorage stub (node env: no jsdom) -------------------------
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

describe('buildAuthHeaders (pure mode switch)', () => {
  it('dev mode → X-Dev-User from the dev-user id', () => {
    expect(buildAuthHeaders('dev', { id: 'e-petrov' }, null)).toEqual({
      'X-Dev-User': 'e-petrov',
    });
  });

  it('dev mode → {} when no dev user', () => {
    expect(buildAuthHeaders('dev', null, null)).toEqual({});
    expect(buildAuthHeaders('dev', {}, null)).toEqual({});
  });

  it('keycloak mode → Authorization: Bearer from the token', () => {
    expect(buildAuthHeaders('keycloak', null, 'tok123')).toEqual({
      Authorization: 'Bearer tok123',
    });
  });

  it('keycloak mode → {} when no token (never falls back to X-Dev-User)', () => {
    expect(buildAuthHeaders('keycloak', { id: 'e-petrov' }, null)).toEqual({});
  });

  it('keycloak mode NEVER emits X-Dev-User even with a dev user present', () => {
    const h = buildAuthHeaders('keycloak', { id: 'e-petrov' }, 'tok');
    expect(h).not.toHaveProperty('X-Dev-User');
    expect(h).toEqual({ Authorization: 'Bearer tok' });
  });
});

describe('normalizeAuthConfig + isKeycloakMode', () => {
  it('treats missing/garbage as dev', () => {
    expect(normalizeAuthConfig(null)).toEqual({ mode: 'dev' });
    expect(normalizeAuthConfig({})).toEqual({ mode: 'dev' });
    expect(normalizeAuthConfig({ mode: 'whatever' })).toEqual({ mode: 'dev' });
    expect(normalizeAuthConfig('nope')).toEqual({ mode: 'dev' });
  });

  it('normalizes keycloak config with defaults + trailing-slash trim', () => {
    const c = normalizeAuthConfig({
      mode: 'keycloak',
      keycloak: { url: 'https://auth.example.com/', realm: 'choros' },
    });
    expect(c.mode).toBe('keycloak');
    expect(c.keycloak.url).toBe('https://auth.example.com');
    expect(c.keycloak.realm).toBe('choros');
    expect(c.keycloak.clientId).toBe('choros-web'); // default
    expect(c.keycloak.audience).toBe('choros-api'); // default
  });

  it('isKeycloakMode predicate', () => {
    expect(isKeycloakMode({ mode: 'keycloak' })).toBe(true);
    expect(isKeycloakMode({ mode: 'dev' })).toBe(false);
    expect(isKeycloakMode(null)).toBe(false);
  });
});

describe('loadAuthConfig (cache + fail-safe)', () => {
  beforeEach(() => {
    _resetAuthConfig();
  });

  it('fail-safe to dev when fetch throws', async () => {
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    const c = await loadAuthConfig();
    expect(c).toEqual(DEFAULT_AUTH_CONFIG);
    expect(getAuthConfig()).toEqual(DEFAULT_AUTH_CONFIG);
  });

  it('parses + caches a keycloak config', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        mode: 'keycloak',
        keycloak: { url: 'http://localhost:8180', realm: 'choros', clientId: 'choros-web', audience: 'choros-api' },
      }),
    });
    const c = await loadAuthConfig(true);
    expect(c.mode).toBe('keycloak');
    expect(c.keycloak.clientId).toBe('choros-web');
    // cached: a subsequent call (no force) returns same without re-fetching
    globalThis.fetch = async () => {
      throw new Error('should not be called');
    };
    const again = await loadAuthConfig();
    expect(again).toBe(c);
  });
});

describe('authHeaders / devHeaders (impure, end-to-end mode switch)', () => {
  beforeEach(() => {
    installLocalStorage();
    _resetAuthConfig();
  });

  it('dev mode: authHeaders === devHeaders === X-Dev-User', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ mode: 'dev' }) });
    await loadAuthConfig(true);
    setDevUser({ id: 'e-larina', name: 'Larina' });
    expect(authHeaders()).toEqual({ 'X-Dev-User': 'e-larina' });
    expect(devHeaders()).toEqual({ 'X-Dev-User': 'e-larina' });
    expect(getDevUser().id).toBe('e-larina');
    clearDevUser();
    expect(authHeaders()).toEqual({});
  });

  it('keycloak mode: authHeaders/devHeaders emit Bearer from the session token', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        mode: 'keycloak',
        keycloak: { url: 'http://localhost:8180', realm: 'choros', clientId: 'choros-web', audience: 'choros-api' },
      }),
    });
    await loadAuthConfig(true);
    // Stale dev-user from a prior dev session must be ignored in keycloak mode.
    setDevUser({ id: 'e-petrov' });
    persistSession({ accessToken: 'jwt-abc', expiresAt: Date.now() + 60000, user: { id: 's' } });
    expect(authHeaders()).toEqual({ Authorization: 'Bearer jwt-abc' });
    expect(devHeaders()).toEqual({ Authorization: 'Bearer jwt-abc' });
    expect(authHeaders()).not.toHaveProperty('X-Dev-User');
    clearSession();
    expect(authHeaders()).toEqual({}); // no token → no header (never X-Dev-User)
  });
});
