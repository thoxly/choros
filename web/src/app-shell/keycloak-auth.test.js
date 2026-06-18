/**
 * web/src/app-shell/keycloak-auth.test.js
 *
 * T-0258 — pure OIDC/PKCE helper tests (no browser navigation).
 * Verifies the redirect-URL, token-request, callback-parse, JWT-decode and
 * user-mapping logic conform to the Keycloak OIDC contract the backend expects.
 */

import { describe, it, expect } from 'vitest';
import {
  endpoints,
  redirectUri,
  buildAuthorizeUrl,
  buildTokenRequestBody,
  buildLogoutUrl,
  parseCallbackParams,
  decodeJwtPayload,
  kcUserFromClaims,
  base64UrlEncode,
} from './keycloak-auth.js';

const CONFIG = {
  url: 'http://localhost:8180',
  realm: 'choros',
  clientId: 'choros-web',
  audience: 'choros-api',
};

describe('endpoints', () => {
  it('builds the standard KC OIDC endpoint URLs', () => {
    const e = endpoints(CONFIG);
    expect(e.authorization).toBe('http://localhost:8180/realms/choros/protocol/openid-connect/auth');
    expect(e.token).toBe('http://localhost:8180/realms/choros/protocol/openid-connect/token');
    expect(e.logout).toBe('http://localhost:8180/realms/choros/protocol/openid-connect/logout');
  });
});

describe('buildAuthorizeUrl', () => {
  it('emits an Authorization-Code + PKCE (S256) redirect with all required params', () => {
    const url = new URL(
      buildAuthorizeUrl(CONFIG, {
        redirectUri: 'http://localhost:3000/',
        state: 'st8',
        codeChallenge: 'chal',
      }),
    );
    expect(url.searchParams.get('client_id')).toBe('choros-web');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toContain('openid');
    expect(url.searchParams.get('state')).toBe('st8');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('buildTokenRequestBody', () => {
  it('builds the authorization_code grant with PKCE verifier (no secret)', () => {
    const body = buildTokenRequestBody(CONFIG, {
      code: 'authcode',
      redirectUri: 'http://localhost:3000/',
      codeVerifier: 'verifier',
    });
    const p = new URLSearchParams(body);
    expect(p.get('grant_type')).toBe('authorization_code');
    expect(p.get('client_id')).toBe('choros-web');
    expect(p.get('code')).toBe('authcode');
    expect(p.get('redirect_uri')).toBe('http://localhost:3000/');
    expect(p.get('code_verifier')).toBe('verifier');
    expect(p.get('client_secret')).toBeNull(); // public client — never a secret
  });
});

describe('buildLogoutUrl', () => {
  it('includes client_id + post_logout_redirect_uri + id_token_hint', () => {
    const url = new URL(
      buildLogoutUrl(CONFIG, { postLogoutRedirectUri: 'http://localhost:3000/', idToken: 'idtok' }),
    );
    expect(url.searchParams.get('client_id')).toBe('choros-web');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:3000/');
    expect(url.searchParams.get('id_token_hint')).toBe('idtok');
  });
});

describe('redirectUri', () => {
  it('is the app origin root', () => {
    expect(redirectUri('http://localhost:3000')).toBe('http://localhost:3000/');
  });
});

describe('parseCallbackParams', () => {
  it('returns code+state for a success callback', () => {
    expect(parseCallbackParams('?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
  });
  it('returns error for an error callback', () => {
    const r = parseCallbackParams('?error=access_denied&error_description=nope');
    expect(r.error).toBe('access_denied');
    expect(r.errorDescription).toBe('nope');
  });
  it('returns null when there is no callback', () => {
    expect(parseCallbackParams('')).toBeNull();
    expect(parseCallbackParams('?foo=bar')).toBeNull();
    expect(parseCallbackParams('?code=only')).toBeNull(); // state required
  });
});

describe('decodeJwtPayload + kcUserFromClaims', () => {
  function makeJwt(payload) {
    const enc = (o) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
    return `${enc({ alg: 'RS256' })}.${enc(payload)}.sig`;
  }

  it('decodes the payload of a well-formed JWT', () => {
    const tok = makeJwt({ sub: 's-1', preferred_username: 'e-belov', actor_type: 'human' });
    expect(decodeJwtPayload(tok)).toMatchObject({
      sub: 's-1',
      preferred_username: 'e-belov',
      actor_type: 'human',
    });
  });

  it('returns {} on garbage instead of throwing', () => {
    expect(decodeJwtPayload('not-a-jwt')).toEqual({});
    expect(decodeJwtPayload('')).toEqual({});
  });

  it('maps claims → a dev-user-shaped object (id/name/position/actorType)', () => {
    const u = kcUserFromClaims({ sub: 's-1', preferred_username: 'e-belov', name: 'Belov', actor_type: 'human' });
    expect(u).toMatchObject({
      id: 's-1',
      sub: 's-1',
      preferredUsername: 'e-belov',
      name: 'Belov',
      position: 'human',
      actorType: 'human',
    });
  });

  it('maps an agent actor_type', () => {
    const u = kcUserFromClaims({ sub: 'sa-1', preferred_username: 'service-account-x', actor_type: 'agent' });
    expect(u.actorType).toBe('agent');
    expect(u.position).toBe('agent');
  });
});
