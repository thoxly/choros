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

/** Build the token-endpoint POST body for a refresh_token grant. Pure. */
export function buildRefreshRequestBody(config, refreshToken) {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: refreshToken,
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

/**
 * Pure-JS SHA-256 fallback for insecure contexts (plain HTTP on a non-localhost
 * host) where `crypto.subtle` is undefined.  Operates on a Uint8Array of the
 * UTF-8 bytes of `msg` and returns a 32-byte Uint8Array digest.
 *
 * Algorithm: FIPS PUB 180-4, SHA-256.  Only arithmetic we rely on: 32-bit
 * unsigned right-shift (>>>) and bitwise ops — all safe in JavaScript.
 *
 * Reference: https://csrc.nist.gov/publications/detail/fips/180/4/final
 * @param {Uint8Array} msgBytes
 * @returns {Uint8Array}
 */
function sha256Fallback(msgBytes) {
  // Initial hash values (first 32 bits of fractional parts of sqrt of primes).
  let [h0, h1, h2, h3, h4, h5, h6, h7] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  // Round constants (first 32 bits of fractional parts of cbrt of first 64 primes).
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  // Pre-processing: padding.
  const L = msgBytes.length;
  // Message length in bits must fit in 64 bits (lower 32 for us — SHA-256
  // supports up to 2^64-1 bits; a PKCE verifier is ≤ 128 bytes so upper word
  // is always zero).
  const bitLenHi = Math.floor((L * 8) / 0x100000000) >>> 0;
  const bitLenLo = (L * 8) >>> 0;

  // Padded length: 1 byte for the 0x80 marker + 8 bytes for the length, all
  // rounded up to a multiple of 64 bytes.
  const paddedLen = Math.ceil((L + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(msgBytes);
  padded[L] = 0x80;
  // Append the 64-bit big-endian bit length at the last 8 bytes.
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, bitLenHi, false);
  view.setUint32(paddedLen - 4, bitLenLo, false);

  // Process each 512-bit (64-byte) chunk.
  const W = new Uint32Array(64);
  for (let chunkStart = 0; chunkStart < paddedLen; chunkStart += 64) {
    // Prepare message schedule.
    for (let i = 0; i < 16; i++) {
      W[i] = view.getUint32(chunkStart + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const w2 = W[i - 2];
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }

    // Compression.
    let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  // Produce the 32-byte digest.
  const digest = new Uint8Array(32);
  const dv = new DataView(digest.buffer);
  dv.setUint32(0,  h0, false); dv.setUint32(4,  h1, false);
  dv.setUint32(8,  h2, false); dv.setUint32(12, h3, false);
  dv.setUint32(16, h4, false); dv.setUint32(20, h5, false);
  dv.setUint32(24, h6, false); dv.setUint32(28, h7, false);
  return digest;
}

/** Generate a PKCE { codeVerifier, codeChallenge } pair (S256). */
export async function generatePkcePair() {
  const codeVerifier = randomString(32);
  const data = new TextEncoder().encode(codeVerifier);
  let digestBytes;
  if (globalThis.crypto?.subtle?.digest) {
    // Secure context (HTTPS or localhost): use native WebCrypto.
    const buf = await globalThis.crypto.subtle.digest('SHA-256', data);
    digestBytes = new Uint8Array(buf);
  } else {
    // Insecure context (plain HTTP on a non-localhost host — e.g. the dev
    // stack at http://100.121.76.86:3000): fall back to pure-JS SHA-256.
    digestBytes = sha256Fallback(data);
  }
  const codeChallenge = base64UrlEncode(digestBytes);
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

/**
 * Attempt a silent token refresh using the stored refresh token. Returns the
 * refreshed user on success, or null when there is no usable refresh token or
 * the refresh fails (in which case the stale session is CLEARED so the shell
 * falls through to the login screen instead of rendering with a dead token).
 * keycloak mode only.
 */
export async function tryRefresh(config) {
  const s = getSession();
  if (!s || !s.refreshToken) return null;
  try {
    const res = await fetch(endpoints(config).token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildRefreshRequestBody(config, s.refreshToken),
    });
    if (!res.ok) { clearSession(); return null; }
    const tokens = await res.json();
    const accessToken = tokens.access_token;
    if (!accessToken) { clearSession(); return null; }
    const claims = decodeJwtPayload(accessToken);
    const expiresIn = Number(tokens.expires_in) || 0;
    const session = {
      accessToken,
      idToken: tokens.id_token || s.idToken || null,
      refreshToken: tokens.refresh_token || s.refreshToken || null,
      expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
      user: kcUserFromClaims(claims),
    };
    persistSession(session);
    return session.user;
  } catch {
    clearSession();
    return null;
  }
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
