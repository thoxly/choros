/**
 * web/src/screens/web-fetch-auth-remediation.test.js  (T-0668)
 *
 * Regression guard for the "bare fetch" auth-bypass class (whack-a-mole, caught
 * live twice: ra-grant-trail.jsx / T-0648 and fetchEmployees /api/org / T-0649).
 *
 * THE BUG: a `fetch('/api/…')` with NO auth header. In keycloak mode the
 * Bearer-only gateway rejects it 401 "missing Authorization" BEFORE identity
 * resolves, so the screen silently falls to seed data. Unit tests that MOCK
 * fetch never see it — hence the structural ci/checks/web-fetch-auth-coverage.sh
 * gate (scans ALL of web/src) plus these two focused source-text guards on the
 * sites T-0668 remediated.
 *
 * This repo's vitest runs in the node environment (no jsdom / DOM mount — see
 * screen-llm-connections.states.test.jsx), so the durable behavioural proof is
 * COMPOSED: (a) buildAuthHeaders/authHeaders is unit-tested to emit the correct
 * mode-aware header (app-shell/auth-headers.test.js — dev→X-Dev-User,
 * keycloak→Authorization: Bearer); (b) these guards + the gate prove the call
 * sites route through authHeaders(); therefore the header flows on every /api
 * call. The end-to-end browser render (screen shows LIVE data, not seed) is the
 * deferred live-proof (dev stand OFFLINE this run).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), 'utf-8');

// NOTE on scope: the ROBUST, whole-tree "no bare /api fetch" invariant is
// enforced by ci/checks/web-fetch-auth-coverage.sh (balanced-paren aware). These
// vitest guards intentionally stay narrow and precise: they lock the exact
// remediated call strings and assert the exact pre-fix bare forms are gone — no
// crude regex balancing that nested parens like encodeURIComponent()/getActiveTenantId()
// would fool.

describe('T-0668 · screen-login.jsx — dev user picker fetch carries mode-aware auth', () => {
  const src = read('./screen-login.jsx');

  it('imports authHeaders from the shared dev-auth helper', () => {
    expect(src).toContain("import { authHeaders } from '../app-shell/dev-auth.js'");
  });

  it('every /api/users fetch carries { headers: { ...authHeaders() } } (initial + retry)', () => {
    const remediated = src.match(/fetch\('\/api\/users', \{ headers: \{ \.\.\.authHeaders\(\) \} \}\)/g) || [];
    expect(remediated.length).toBe(2);
  });

  it('the exact pre-fix bare form fetch(\'/api/users\') is gone', () => {
    expect(src).not.toMatch(/fetch\('\/api\/users'\s*\)/);
  });
});

describe('T-0668 · ra-intents.jsx — dictionaries fetch carries mode-aware auth', () => {
  const src = read('./rights/ra-intents.jsx');

  it('GET /api/rights/dictionaries carries authHeaders() (was bare → empty presets on 401)', () => {
    expect(src).toMatch(
      /fetch\('\/api\/rights\/dictionaries', \{ headers: \{ \.\.\.authHeaders\(\) \} \}\)/,
    );
  });

  it('the exact pre-fix bare form fetch(\'/api/rights/dictionaries\') is gone', () => {
    expect(src).not.toMatch(/fetch\('\/api\/rights\/dictionaries'\s*\)/);
  });
});
