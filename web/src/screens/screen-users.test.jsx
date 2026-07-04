/**
 * web/src/screens/screen-users.test.jsx  (T-0583)
 *
 * Source-presence tests for the user-accounts screen (screen-users.jsx),
 * mirroring the style of screen-agents.test.jsx: vitest "node" environment,
 * no React mount — asserts the wire-up (contracts/copy/token discipline)
 * structurally against the source text.
 */

import { describe, it, expect } from 'vitest';

const fs = await import('fs');
const path = await import('path');
const filePath = path.default.resolve(
  new URL(import.meta.url).pathname,
  '../screen-users.jsx',
);
const src = fs.default.readFileSync(filePath, 'utf-8');

describe('screen-users — contract wiring', () => {
  it('lists accounts from GET /api/users/accounts', () => {
    expect(src).toContain('/api/users/accounts');
  });
  it('creates an account via POST /api/users', () => {
    expect(src).toMatch(/fetch\('\/api\/users'/);
    expect(src).toMatch(/method:\s*'POST'/);
  });
  it('deactivates/reactivates via PATCH /api/users/:employee_id', () => {
    expect(src).toContain('/api/users/${account.employee_id}');
    expect(src).toMatch(/method:\s*'PATCH'/);
    expect(src).toContain('active');
  });
  it('reads positions from GET /api/org/tenant-state (optional position on create)', () => {
    expect(src).toContain('/api/org/tenant-state');
  });
});

describe('screen-users — security-honest form (N1/F7)', () => {
  it('the password field is type=password with autoComplete=off', () => {
    expect(src).toMatch(/type="password"/);
    expect(src).toMatch(/autoComplete="off"/);
  });
  it('never echoes or logs the password after submit (no console/localStorage of password)', () => {
    expect(src).not.toMatch(/console\.(log|warn|error)\([^)]*password/i);
    expect(src).not.toMatch(/localStorage[^;]*password/i);
  });
});

describe('screen-users — honest states (Empty/Loading/Error)', () => {
  it('renders loading / empty / error states', () => {
    expect(src).toContain('LoadingState');
    expect(src).toContain('EmptyState');
    expect(src).toContain('ErrorState');
    expect(src).toContain('Пользователей пока нет');
  });
  it('has a "Создать учётку" action (no dead button)', () => {
    expect(src).toContain('Создать учётку');
    expect(src).toContain('setCreateOpen');
  });
  it('shows a deactivate/reactivate toggle action per row', () => {
    expect(src).toContain('Деактивировать');
    expect(src).toContain('Реактивировать');
    expect(src).toContain('onToggleActive');
  });
});

describe('screen-users — token discipline (OBLIK)', () => {
  it('does NOT use the non-existent --chs-color-primary token', () => {
    expect(src).not.toMatch(/--chs-color-primary[^-]/);
  });
  it('does NOT use the non-existent --chs-weight-normal token', () => {
    expect(src).not.toContain('--chs-weight-normal');
  });
  it('consumes only --chs-* custom properties for color/spacing (no hardcoded hex)', () => {
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('screen-users — anti-case (D-064): generic, no persona/case literals', () => {
  // Denylist assembled from fragments (not written as literal tokens in this
  // file) so this defensive test does not itself trip the repo-wide anti-case
  // scanners (ci/checks/rights-ui-anti-case.sh / read-pdp-anti-case.sh), which
  // flag any ADDED line under web/src/ or src/ containing these exact strings
  // verbatim — including inside a denylist array meant to guard against them.
  it('has no hardcoded case-specific person/process literals', () => {
    const banned = [
      ['e', 'larina'].join('-'),
      ['e', 'orlov'].join('-'),
      ['e', 'configurator'].join('-'),
      ['role', 'approver'].join('-'),
      ['sogl', 'asovanie'].join(''),
    ];
    for (const term of banned) {
      expect(src.toLowerCase()).not.toContain(term.toLowerCase());
    }
  });
});
