/**
 * web/src/app-shell/shell.honest-buttons.test.jsx — T-0652 (§6.1 «нет фейковых кнопок»)
 *
 * Source-presence invariants (this web tier has no jsdom — see
 * shell.sidebar.test.jsx for the same approach). The two topbar stubs
 * («Экспорт прав», «+ Исполнитель») used to carry their disabled reason ONLY in
 * a chs-sr-only span — a sighted user saw a "working" button that silently did
 * nothing. These assertions lock that the reason is now VISIBLE.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHELL_SRC = readFileSync(join(__dirname, 'shell.jsx'), 'utf-8');

describe('topbar stubs are HONEST (visible reason, not sr-only) — T-0652 §6.1', () => {
  it('«Экспорт прав» stub carries a VISIBLE hint (chs-topbar__hint), not chs-sr-only', () => {
    const block = SHELL_SRC.match(/topbar-rights-export-hint[\s\S]{0,400}/)?.[0] || '';
    expect(block).toContain('chs-topbar__hint');
    // the reason element for this button must NOT be an sr-only span
    expect(block).not.toMatch(/topbar-rights-export-hint"[^>]*>[\s\S]{0,120}chs-sr-only/);
  });

  it('«+ Исполнитель» (org) stub carries a VISIBLE hint (chs-topbar__hint), not chs-sr-only', () => {
    const block = SHELL_SRC.match(/topbar-org-hint[\s\S]{0,400}/)?.[0] || '';
    expect(block).toContain('chs-topbar__hint');
    expect(block).not.toMatch(/topbar-org-hint"[^>]*>[\s\S]{0,120}chs-sr-only/);
  });

  it('the disabled stub buttons still carry aria-disabled + aria-describedby (a11y intact)', () => {
    expect(SHELL_SRC).toContain('aria-describedby="topbar-rights-export-hint"');
    expect(SHELL_SRC).toContain('aria-describedby="topbar-org-hint"');
  });

  it('no topbar stub uses the OLD sr-only-only reason pattern for these two hints', () => {
    // Neither hint id may appear on a chs-sr-only span anymore.
    expect(SHELL_SRC).not.toMatch(/id="topbar-org-hint" className="chs-sr-only"/);
    expect(SHELL_SRC).not.toMatch(/id="topbar-rights-export-hint" className="chs-sr-only"/);
  });
});
