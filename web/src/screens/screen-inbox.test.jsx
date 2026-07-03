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
  it('preserves the ALREADY_CLAIMED human-readable message (now in CLAIM_ERROR_MESSAGE)', () => {
    // T-0605: the inline `code === 'ALREADY_CLAIMED' ? ...` ternary was refactored
    // into the CLAIM_ERROR_MESSAGE map; the human sentence is unchanged.
    expect(src).toContain('ALREADY_CLAIMED: "Задача уже взята другим пользователем"');
  });
  it('preserves the NOT_ELIGIBLE fallback used elsewhere on the screen', () => {
    expect(src).toContain("'Нет права на выполнение этого шага'");
  });
});

// ---------------------------------------------------------------------------
// T-0605 — claim errors ALWAYS surface with a human sentence (никогда сырой код,
// никогда молчаливый провал). The live-факт приёмки: claim → 403 NOT_ELIGIBLE
// shown as a bare code, then a repeat 403 shown as nothing.
// ---------------------------------------------------------------------------
describe('screen-inbox — T-0605 claim errors are human-readable, never silent', () => {
  it('defines a CLAIM_ERROR_MESSAGE map with a NOT_ELIGIBLE human sentence', () => {
    expect(src).toContain('CLAIM_ERROR_MESSAGE');
    // The exact human wording the task requires (owner is told to ask an admin).
    expect(src).toContain('Нет роли для этой задачи — попросите администратора назначить роль');
  });
  it('claimTask maps EVERY error code via claimErrorMessage (no raw `Ошибка: ${code}`)', () => {
    const idx = src.indexOf('const claimTask');
    const claimBody = src.slice(idx, src.indexOf('const approveTask'));
    expect(claimBody).toContain('claimErrorMessage(code)');
    // The bare-code path that showed `Ошибка: NOT_ELIGIBLE` on the stand is gone.
    expect(claimBody).not.toMatch(/`Ошибка: \$\{code\}`/);
  });
  it('claimErrorMessage falls back to a human sentence (still surfaces, not silent)', () => {
    // Even an unmapped code yields a sentence, never an empty/silent toast.
    expect(src).toContain('Не удалось взять задачу:');
  });
});

/**
 * T-0598 (находка №7) — honest CTA on the tenant-wide-empty inbox path
 * (AC-9/AC-10/AC-11). Same source-presence convention as above.
 */
describe('screen-inbox — honest action-CTA on empty state (AC-9/AC-10/AC-11)', () => {
  it('imports useNavigate from react-router-dom', () => {
    expect(src).toContain("import { useNavigate } from 'react-router-dom'");
  });
  it('InboxScreen invokes useNavigate()', () => {
    expect(src).toMatch(/const\s+navigate\s*=\s*useNavigate\(\)/);
  });
  it('the tenant-wide-empty branch (tab==="all" && !exec && counts.all===0) renders an action CTA to /processes', () => {
    const idx = src.indexOf('items.length === 0');
    expect(idx).toBeGreaterThan(-1);
    const emptyBlock = src.slice(idx, idx + 1800);
    expect(emptyBlock).toMatch(/tab === "all" && !exec && counts\.all === 0/);
    expect(emptyBlock).toContain("navigate('/processes')");
    expect(emptyBlock).toContain('Открыть процессы');
  });
  it('the honest tenant-wide-empty description does not claim a filter-specific reason', () => {
    const idx = src.indexOf('items.length === 0');
    const emptyBlock = src.slice(idx, idx + 1800);
    expect(emptyBlock).toContain('Задачи появляются, когда запускаются процессы.');
  });
  it('the fallback branch (other tabs / active exec filter) does NOT render the /processes action', () => {
    const idx = src.indexOf('items.length === 0');
    const emptyBlock = src.slice(idx, idx + 1800);
    // the fallback EmptyState (second branch) must not itself carry an action prop —
    // only the tenant-wide branch does. Assert the fallback title differs and has no action=.
    expect(emptyBlock).toContain('Нет задач в этой вкладке');
    const fallbackIdx = emptyBlock.indexOf('Нет задач в этой вкладке');
    const fallbackSnippet = emptyBlock.slice(Math.max(0, fallbackIdx - 200), fallbackIdx + 200);
    expect(fallbackSnippet).not.toContain('action=');
  });
  it('route /processes used by the CTA is a pre-existing app route (shell.jsx), not invented here', () => {
    const shellFs = fs.default.readFileSync(
      path.default.resolve(new URL(import.meta.url).pathname, '../../app-shell/shell.jsx'),
      'utf-8',
    );
    expect(shellFs).toContain('path="/processes"');
  });
});
