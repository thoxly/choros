// @vitest-environment jsdom
/**
 * web/src/app-shell/shell.account-card.mount.test.jsx — T-0772
 *
 * REAL DOM mount test — @testing-library/react + jsdom (see
 * web/src/forms/FormDesigner.mount.test.jsx / screen-users.mount.test.jsx for
 * the full D-064 rationale: shell.jsx's OWN sibling tests
 * (shell.sidebar.test.jsx, shell.honest-buttons.test.jsx) are source-presence
 * regex checks — they lock WIRING but cannot observe what actually ends up in
 * the DOM for a given boot sequence. That gap is exactly where T-0772's bug
 * lived: the sidebar account card read the KC token's `preferred_username`
 * (== raw email for a self-registered owner, since Keycloak never sets a
 * `name` claim) and nothing on the client ever looked at
 * choros.employee.display_name for the CURRENT actor's own identity — only
 * GET /api/me/nav-capabilities (T-0539) already resolves that actor server-
 * side on every boot, so T-0772 piggy-backs `displayName` onto its existing
 * response (src/http/org.ts) and shell.jsx now folds it into `currentUser`
 * once it resolves.
 *
 * This mounts the REAL <AppShell/> (default export of shell.jsx, wrapped in
 * MemoryRouter exactly as main.jsx wraps it in BrowserRouter), seeds a
 * dev-user whose STORED name looks like the pre-fix bug (an email-shaped
 * string — the same shape kcUserFromClaims falls back to), mocks
 * GET /api/me/nav-capabilities to return a DIFFERENT humanized displayName
 * (mirroring T-0770's registerTenant humanization), and asserts the rendered
 * sidebar account-card text becomes the humanized name — not the raw email —
 * once the nav-capabilities response lands.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, waitFor, screen, cleanup } from '@testing-library/react';
import AppShell from './shell.jsx';
import { _resetAuthConfig } from './auth-mode.js';
import { clearActiveTenant, clearNavCapabilities } from './active-tenant.js';

const DEV_USER_KEY = 'chs-dev-user';
const EMAIL_LOOKING_NAME = 'lp-w8-owner@example.com'; // pre-fix shape (T-0770's own example)
const HUMANIZED_DISPLAY_NAME = 'Lp W8 Owner'; // T-0770's humanizeEmailLocalPart output for the above

function jsonOk(body) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

function mockFetch(url) {
  const u = String(url);
  if (u.startsWith('/api/auth-config')) return jsonOk({ mode: 'dev' });
  if (u.startsWith('/api/my-tenant')) {
    return jsonOk({ tenantId: 'tenant-1', tenant: { displayName: 'Acme', memberCount: 1 } });
  }
  if (u.startsWith('/api/me/nav-capabilities')) {
    return jsonOk({
      isGenesisOwner: true,
      capabilities: [],
      zones: ['work'],
      displayName: HUMANIZED_DISPLAY_NAME,
    });
  }
  if (u.startsWith('/api/applications')) return jsonOk({ applications: [] });
  if (u.startsWith('/api/sections')) return jsonOk({ sections: [] });
  if (u.startsWith('/api/user-prefs')) return jsonOk({ prefs: {} });
  if (u.startsWith('/api/inbox')) return jsonOk({ items: [], counts: { all: 0, mine: 0, pool: 0, esc: 0 } });
  if (u.startsWith('/api/processes')) return jsonOk({ instances: [] });
  if (u.startsWith('/api/agents')) return jsonOk({ agents: [] });
  if (u.startsWith('/api/assistant/threads')) return jsonOk({ threads: [] });
  if (u.startsWith('/api/rights/tenant-state')) return jsonOk({ can_manage: true });
  return jsonOk({});
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/overview']}>
      <AppShell />
    </MemoryRouter>,
  );
}

describe('AppShell sidebar account card — humanized name (T-0772)', () => {
  beforeEach(() => {
    _resetAuthConfig();
    clearActiveTenant();
    clearNavCapabilities();
    // Seed the dev-user with the PRE-FIX bug shape: name stored as the raw
    // email (exactly what kcUserFromClaims falls back to in keycloak mode
    // when the JWT carries no `name` claim — see keycloak-auth.js). The fix
    // must override this once GET /api/me/nav-capabilities resolves.
    localStorage.setItem(
      DEV_USER_KEY,
      JSON.stringify({ id: 'e-owner', name: EMAIL_LOOKING_NAME, position: 'human' }),
    );
    global.fetch = vi.fn(mockFetch);
  });

  afterEach(() => {
    cleanup();
    localStorage.removeItem(DEV_USER_KEY);
    vi.restoreAllMocks();
  });

  it('replaces the email-shaped stored name with employee.display_name once nav-capabilities resolves', async () => {
    renderShell();

    // The account-card trigger renders <span className="chs-nav__username">
    // unconditionally (no popover click needed) — assert the FINAL state.
    await waitFor(() => {
      expect(screen.getByText(HUMANIZED_DISPLAY_NAME)).toBeTruthy();
    });

    // The raw email must NOT be the visible identity anywhere in the card.
    expect(screen.queryByText(EMAIL_LOOKING_NAME)).toBeNull();
  });

  it('falls back to the pre-existing name when nav-capabilities is degraded (no displayName)', async () => {
    global.fetch = vi.fn((url) => {
      const u = String(url);
      if (u.startsWith('/api/me/nav-capabilities')) {
        return jsonOk({ isGenesisOwner: false, capabilities: [], zones: ['work'], degraded: true, displayName: null });
      }
      return mockFetch(url);
    });

    renderShell();

    // No displayName to fold in → account card keeps showing whatever
    // currentUser already had (honest-degrade, never worse than before).
    await waitFor(() => {
      expect(screen.getByText(EMAIL_LOOKING_NAME)).toBeTruthy();
    });
  });
});
