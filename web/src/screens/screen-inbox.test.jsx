/**
 * web/src/screens/screen-inbox.test.jsx  (T-0597, находка №6)
 *
 * Source-presence tests (project convention — see screen-agents.test.jsx,
 * screen-rights.test.jsx): vitest "node" environment, no React mount.
 *
 *   - claimTask/approveTask no longer call the blocking native alert() on
 *     error — both surface via the existing toast provider (pushToast),
 *     consistent with the tone already used on rights/assistant screens.
 *   - the human-readable error text (ENGINE_DRIVE_ERROR_MESSAGE mapping,
 *     ALREADY_CLAIMED branch, NOT_ELIGIBLE fallback) is preserved unchanged —
 *     only the delivery channel changed.
 *   - useToastContext is imported and invoked from the existing toast-context
 *     module (no new/parallel toast mechanism introduced).
 */

import { describe, it, expect } from 'vitest';

const fs = await import('fs');
const path = await import('path');
const filePath = path.default.resolve(
  new URL(import.meta.url).pathname,
  '../screen-inbox.jsx',
);
const src = fs.default.readFileSync(filePath, 'utf-8');

describe('screen-inbox — alert() replaced by pushToast (AC-1/AC-2)', () => {
  it('does not call the native blocking alert() anywhere in the file', () => {
    expect(src).not.toMatch(/[^.]\balert\(/);
  });
  it('imports useToastContext from the existing toast-context module', () => {
    expect(src).toContain("import { useToastContext } from '../app-shell/toast-context.jsx'");
  });
  it('InboxScreen invokes useToastContext() (single provider, not a new mechanism)', () => {
    expect(src).toMatch(/const\s*\{\s*push:\s*pushToast\s*\}\s*=\s*useToastContext\(\)/);
  });
  it('claimTask surfaces its catch via pushToast with tone error', () => {
    const idx = src.indexOf('const claimTask');
    expect(idx).toBeGreaterThan(-1);
    const claimBody = src.slice(idx, src.indexOf('const approveTask'));
    expect(claimBody).toMatch(/pushToast\(\{\s*tone:\s*'error'/);
    expect(claimBody).not.toMatch(/\balert\(/);
  });
  it('approveTask surfaces its catch via pushToast with tone error', () => {
    const idx = src.indexOf('const approveTask');
    expect(idx).toBeGreaterThan(-1);
    const approveBody = src.slice(idx, idx + 1500);
    expect(approveBody).toMatch(/pushToast\(\{\s*tone:\s*'error'/);
    expect(approveBody).not.toMatch(/\balert\(/);
  });
  it('preserves the ENGINE_DRIVE_ERROR_MESSAGE mapping (human-readable text unchanged)', () => {
    expect(src).toContain('ENGINE_DRIVE_ERROR_MESSAGE[code]');
  });
  it('preserves the ALREADY_CLAIMED human-readable branch in claimTask', () => {
    expect(src).toContain("code === 'ALREADY_CLAIMED' ? 'Задача уже взята другим пользователем'");
  });
  it('preserves the NOT_ELIGIBLE fallback used elsewhere on the screen', () => {
    expect(src).toContain("'Нет права на выполнение этого шага'");
  });
});
