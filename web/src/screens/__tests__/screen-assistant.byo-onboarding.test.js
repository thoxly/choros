/**
 * web/src/screens/__tests__/screen-assistant.byo-onboarding.test.js
 * (T-0679 — BYO-онбординг немого ассистента; решение фаундера 2026-07-07,
 * строгий BYO-LLM)
 *
 * Same convention as screen-assistant.llm-banner.test.js (T-0599) and
 * screen-assistant.error-envelope.test.js (T-0573/T-0595): vitest "node"
 * environment, no jsdom/mount — source-presence assertions on the real screen
 * file (regex over the exact code that ships), because a full DOM-mount harness
 * does not exist for this screen (project convention, see
 * screen-llm-connections.states.test.jsx).
 *
 * WHAT THIS PROVES (spec T-0679.spec.md AC-1..AC-6):
 *   - AC-1: an explicit BYO onboarding component exists and is rendered IN PLACE
 *     of the mute "Выберите разговор" empty pane when the assistant has no key
 *     (llmBound===false) and no thread is selected.
 *   - AC-2: admin/owner gets a primary CTA to /llm-connections (existing key-entry
 *     screen) — same client navigation as T-0599, no new endpoint.
 *   - AC-3: a non-admin gets an honest "ask your admin" text and NO button to the
 *     admin-only screen (no dead door).
 *   - AC-1/value-frame: the copy carries the value framing ("собир…форм") and the
 *     BYO explanation ("ключ — ваш" / платите провайдеру напрямую) — not a bare
 *     "no key connected" error.
 *   - AC-4 (no jargon): the panel text contains no dev-jargon tokens.
 *   - AC-5 (loading-honesty regression): the onboarding is still gated on
 *     showLlmBanner (llmBound===false, not loading) — the T-0599 loading-honesty
 *     guard is untouched.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREEN_PATH = path.resolve(HERE, '../screen-assistant.jsx');
const src = fs.readFileSync(SCREEN_PATH, 'utf-8');

// Extract the AssistantByoOnboarding component body for scoped assertions.
function byoBody() {
  const start = src.indexOf('function AssistantByoOnboarding(');
  expect(start).toBeGreaterThan(-1);
  // Cut a generous window (the component is small) up to the next top-level
  // `function ` declaration after it.
  const rest = src.slice(start + 'function AssistantByoOnboarding('.length);
  const nextFn = rest.indexOf('\nfunction ');
  return rest.slice(0, nextFn === -1 ? rest.length : nextFn);
}

describe('T-0679 — AC-1: BYO onboarding replaces the mute empty pane', () => {
  it('an AssistantByoOnboarding component exists', () => {
    expect(src).toMatch(/function AssistantByoOnboarding\s*\(/);
  });

  it('renders the onboarding instead of NothingSelected when the assistant is mute and no thread is selected', () => {
    // The render branch: activeThread ? ThreadView : showLlmBanner ?
    // AssistantByoOnboarding : NothingSelected
    expect(src).toMatch(/showLlmBanner\s*\?\s*\(?[\s\S]{0,400}<AssistantByoOnboarding\s*\/>/);
    // NothingSelected is now the FALLBACK (assistant has a key) — still present.
    expect(src).toMatch(/<NothingSelected\s+onCreate=\{handleCreate\}\s*\/>/);
  });

  it('AC-1 value-frame: the copy says the assistant BUILDS FORMS (собир…форм), not a bare "no key" error', () => {
    const body = byoBody();
    expect(body).toMatch(/собира[а-я]*\s+форм/i);
  });

  it('AC-1 BYO explanation: the copy states the key is YOURS and you pay the provider directly', () => {
    const body = byoBody();
    expect(body).toMatch(/Ключ\s*—\s*ваш/);
    expect(body).toMatch(/платите провайдеру напрямую/);
  });

  it('AC-1 title is an invitation ("Подключите свой LLM-ключ"), not an error headline', () => {
    const body = byoBody();
    expect(body).toMatch(/Подключите свой LLM-ключ/);
  });
});

describe('T-0679 — AC-2/AC-3: admin CTA vs honest non-admin dead-end', () => {
  it('resolves admin status from the ALREADY-cached getNavCapabilities() (no new fetch)', () => {
    const body = byoBody();
    expect(body).toMatch(/getNavCapabilities\(\)/);
    expect(body).toMatch(/isGenesisOwner/);
    expect(body).toMatch(/zones[\s\S]{0,40}includes\('admin'\)/);
  });

  it('AC-2: admin branch renders a primary CTA navigating to the EXISTING /llm-connections screen', () => {
    const body = byoBody();
    expect(body).toMatch(/navigate\('\/llm-connections'\)/);
    expect(body).toMatch(/Подключить ключ/);
  });

  it('AC-3: non-admin branch honestly directs to the org admin and gets NO action button (action is admin-only)', () => {
    const body = byoBody();
    expect(body).toMatch(/администратору вашей организации/);
    // The action prop is gated on isAdmin — non-admin gets undefined (no dead door).
    expect(body).toMatch(/action=\{isAdmin\s*\?/);
  });
});

describe('T-0679 — AC-5: loading-honesty regression (T-0599 gate untouched)', () => {
  it('showLlmBanner is still derived from llmBound===false AND not loading', () => {
    expect(src).toMatch(/const showLlmBanner = !llmStatusLoading && llmBound === false/);
  });

  it('the onboarding renders only inside the showLlmBanner branch (never on unknown/loading)', () => {
    // No unconditional <AssistantByoOnboarding /> — it is always behind showLlmBanner.
    const occurrences = src.match(/<AssistantByoOnboarding\s*\/>/g) || [];
    expect(occurrences.length).toBe(1);
  });
});

describe('T-0679 — AC-4: no dev-jargon in the onboarding copy', () => {
  it('the panel text carries no developer jargon tokens', () => {
    const body = byoBody();
    const JARGON = [
      'LLM_NOT_CONFIGURED', 'secret_handle', 'secretHandle', 'endpoint', 'base URL',
      'APP_SECRET_MASTER_KEY', 'app://', 'env://', 'AES', 'GCM', '503',
      'llm_connection', 'agent_card',
    ];
    for (const tok of JARGON) {
      expect(body.includes(tok)).toBe(false);
    }
    // No task-id leak in visible product strings (ux-g5-jargon-denylist). The
    // component's COMMENTS legitimately carry T-ids; assert only the JSX text
    // nodes / string literals are clean by checking the two description strings.
    const descMatches = body.match(/description=\{[\s\S]*?\}/);
    if (descMatches) {
      expect(descMatches[0]).not.toMatch(/T-\d{3,}/);
    }
  });
});
