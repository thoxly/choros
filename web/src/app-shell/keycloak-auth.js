/**
 * web/src/app-shell/keycloak-auth.js
 *
 * Browser-side OIDC login against Keycloak (T-0258), keycloak mode only.
 *
 * Flow: Authorization Code + PKCE (the OAuth2 best practice for SPAs — no
 * client secret ever lives in the browser). We implement it directly against
 * the standard Keycloak OIDC endpoints using the browser's native WebCrypto +
 * fetch (no keycloak-js dependency — keeps the zero-extra-dep convention, and
 * keycloak-js is not in deps).
 *
 *   1. login(config):  generate PKCE verifier/challenge + state, stash them in
 *      sessionStorage, redirect the browser to the realm authorization endpoint.
 *   2. handleRedirectCallback(config): on return (?code=&state=), validate
 *      state, exchange code+verifier at the token endpoint for tokens, persist
 *      the session, clean the URL.
 *   3. getToken(): the current access token (for Authorization: Bearer ...).
 *   4. isAuthenticated() / getKeycloakUser() / logout(config).
 *
 * The PURE helpers (endpoints, buildAuthorizeUrl, buildTokenRequestBody,
 * parseCallbackParams, decodeJwtPayload, kcUserFromClaims) are unit-tested
 * without a browser. The impure functions touch window/location/sessionStorage.
 */

const SESSION_KEY = 'chs-kc-session';
const PKCE_VERIFIER_KEY = 'chs-kc-pkce-verifier';
const STATE_KEY = 'chs-kc-state';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** OIDC endpoint URLs for a realm. Pure. */
export function endpoints(config) {
  const base = `${config.url}/realms/${encodeURIComponent(config.realm)}/protocol/openid-connect`;
  return {
    authorization: `${base}/auth`,
    token: `${base}/token`,
    logout: `${base}/logout`,
  };
}

/** The redirect URI we register with Keycloak — the app origin root. Pure given origin. */
export function redirectUri(origin) {
  return `${origin}/`;
}

/** base64url-encode a Uint8Array (no padding). Pure. */
export function base64UrlEncode(bytes) {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build the authorization redirect URL (PKCE, S256). Pure.
 * @param {object} config  { url, realm, clientId }
 * @param {object} p       { redirectUri, state, codeChallenge }
 */
export function buildAuthorizeUrl(config, p) {
  const url = new URL(endpoints(config).authorization);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile');
  url.searchParams.set('state', p.state);
  url.searchParams.set('code_challenge', p.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Build the token-endpoint POST body for the code→token exchange. Pure. */
export function buildTokenRequestBody(config, p) {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.codeVerifier,
  }).toString();
}

/** Build the logout URL (front-channel). Pure. */
export function buildLogoutUrl(config, p) {
  const url = new URL(endpoints(config).logout);
  url.searchParams.set('client_id', config.clientId);
  if (p && p.postLogoutRedirectUri) {
    url.searchParams.set('post_logout_redirect_uri', p.postLogoutRedirectUri);
  }
  if (p && p.idToken) {
    url.searchParams.set('id_token_hint', p.idToken);
  }
  return url.toString();
}

/**
 * Parse OIDC redirect-callback params from a query string. Pure.
 * Returns { code, state } | { error, errorDescription } | null (no callback).
 */
export function parseCallbackParams(search) {
  const params = new URLSearchParams(search || '');
  if (params.has('error')) {
    return {
      error: params.get('error'),
      errorDescription: params.get('error_description') || '',
    };
  }
  const code = params.get('code');
  const state = params.get('state');
  if (code && state) return { code, state };
  return null;
}

/** Decode a JWT payload (no signature check — server validates). Pure. Returns {} on garbage. */
export function decodeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return {};
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    // handle UTF-8
    const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Map JWT claims → a shell-friendly user object (mirrors the dev-user shape so
 * shell.jsx renders the same way: { id, name, position }). Pure.
 */
export function kcUserFromClaims(claims) {
  const c = claims || {};
  const username = c.preferred_username || c.sub || '';
  return {
    id: c.sub || username,
    sub: c.sub || '',
    preferredUsername: username,
    name: c.name || username,
    position: c.actor_type === 'agent' ? 'agent' : 'human',
    actorType: c.actor_type === 'agent' ? 'agent' : 'human',
  };
}

// ---------------------------------------------------------------------------
// Impure: PKCE generation (WebCrypto)
// ---------------------------------------------------------------------------

/** Random base64url string of `bytes` entropy. */
export function randomString(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

/** Generate a PKCE { codeVerifier, codeChallenge } pair (S256). */
export async function generatePkcePair() {
  const codeVerifier = randomString(32);
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));
  return { codeVerifier, codeChallenge };
}

// ---------------------------------------------------------------------------
// Impure: session persistence
// ---------------------------------------------------------------------------

/** Persist the token session. session = { accessToken, idToken, refreshToken, expiresAt, user } */
export function persistSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

/** Current access token, or null. */
export function getToken() {
  const s = getSession();
  return s && s.accessToken ? s.accessToken : null;
}

/** Logged-in user object (dev-user-shaped), or null. */
export function getKeycloakUser() {
  const s = getSession();
  return s && s.user ? s.user : null;
}

/** True iff a session exists and the access token has not expired. */
export function isAuthenticated() {
  const s = getSession();
  if (!s || !s.accessToken) return false;
  if (typeof s.expiresAt === 'number' && s.expiresAt <= Date.now()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Impure: flow orchestration
// ---------------------------------------------------------------------------

/**
 * Start the login flow: generate PKCE + state, stash them, redirect to Keycloak.
 * Resolves only after the redirect is issued (the page then navigates away).
 */
export async function login(config, origin = window.location.origin) {
  const { codeVerifier, codeChallenge } = await generatePkcePair();
  const state = randomString(16);
  sessionStorage.setItem(PKCE_VERIFIER_KEY, codeVerifier);
  sessionStorage.setItem(STATE_KEY, state);
  const url = buildAuthorizeUrl(config, {
    redirectUri: redirectUri(origin),
    state,
    codeChallenge,
  });
  window.location.assign(url);
}

/**
 * Handle the OIDC redirect callback if present on the current URL.
 * Returns the logged-in user on success, null if there was no callback to
 * process. Throws on auth error / state mismatch / token-exchange failure.
 * On success the URL query is cleaned (history.replaceState) so a reload does
 * not re-trigger the exchange.
 */
export async function handleRedirectCallback(config, loc = window.location) {
  const parsed = parseCallbackParams(loc.search);
  if (!parsed) return null;

  // Always clear the one-shot PKCE artifacts and clean the URL afterward.
  const cleanUrl = () => {
    try {
      window.history.replaceState({}, document.title, loc.pathname);
    } catch {
      /* non-browser / restricted history — ignore */
    }
  };

  if (parsed.error) {
    sessionStorage.removeItem(PKCE_VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
    cleanUrl();
    throw new Error(parsed.errorDescription || parsed.error || 'auth error');
  }

  const expectedState = sessionStorage.getItem(STATE_KEY);
  const codeVerifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);

  if (!expectedState || parsed.state !== expectedState) {
    cleanUrl();
    throw new Error('OIDC state mismatch — possible CSRF, login aborted');
  }
  if (!codeVerifier) {
    cleanUrl();
    throw new Error('missing PKCE verifier — restart login');
  }

  const body = buildTokenRequestBody(config, {
    code: parsed.code,
    redirectUri: redirectUri(loc.origin),
    codeVerifier,
  });

  const res = await fetch(endpoints(config).token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    cleanUrl();
    throw new Error(`token exchange failed: HTTP ${res.status}`);
  }
  const tokens = await res.json();
  const accessToken = tokens.access_token;
  if (!accessToken) {
    cleanUrl();
    throw new Error('token exchange returned no access_token');
  }
  const claims = decodeJwtPayload(accessToken);
  const expiresIn = Number(tokens.expires_in) || 0;
  const session = {
    accessToken,
    idToken: tokens.id_token || null,
    refreshToken: tokens.refresh_token || null,
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    user: kcUserFromClaims(claims),
  };
  persistSession(session);
  cleanUrl();
  return session.user;
}

/** Clear the local session and redirect to Keycloak's logout endpoint. */
export function logout(config, origin = window.location.origin) {
  const session = getSession();
  clearSession();
  const url = buildLogoutUrl(config, {
    postLogoutRedirectUri: redirectUri(origin),
    idToken: session && session.idToken ? session.idToken : undefined,
  });
  window.location.assign(url);
}

// Storage-key exports for tests / introspection.
export const _KEYS = { SESSION_KEY, PKCE_VERIFIER_KEY, STATE_KEY };
