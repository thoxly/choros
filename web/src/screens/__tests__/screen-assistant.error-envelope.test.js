/**
 * web/src/screens/__tests__/screen-assistant.error-envelope.test.js
 * (T-0573, review R-1 fix — F6/AC-6 на реальной поверхности продукта)
 *
 * R-1 (blocking, review a2350a8): бэкенд T-0573 перевёл оба пути
 * LLM-недоступности на канонический envelope {error:{code,message}}, но
 * screen-assistant.jsx:169 читал плоское d.message (старый до-T-0573 шейп) —
 * пользователь ВСЕГДА видел локальный fallback без ссылки /llm-connections.
 *
 * Approach (project convention — vitest "node" environment, no jsdom/mount;
 * see screen-llm-connections.states.test.jsx): the envelope-reading logic is
 * a PURE module (assistant-error-text.js) exercised directly with the REAL
 * response shapes, plus source-text checks proving the screen's consumption
 * points actually route through it (a regression back to flat `d.message ??`
 * is caught).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantErrorText } from '../assistant-error-text.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREEN_PATH = path.resolve(HERE, '../screen-assistant.jsx');
const src = fs.readFileSync(SCREEN_PATH, 'utf-8');

// The EXACT canonical 503 body respondLlmUnavailable (src/http/assistant.ts)
// sends through sendErrorEnvelope (src/http/router.ts) — shape per ADR-T0573
// §4 AssistantErrorResponse. The message text mirrors
// ASSISTANT_LLM_UNAVAILABLE_MESSAGE (src/core/assistant-messages.ts); web/
// cannot import from src/ (separate package), so the fixture reproduces the
// wire contract — what matters here is the SHAPE (nested error.message) and
// the /llm-connections substring, both asserted below.
const CANONICAL_503_BODY = {
  error: {
    code: 'LLM_UNAVAILABLE',
    message:
      'Ассистент пока не может ответить — не подключён рабочий LLM-ключ. ' +
      'Подключите или проверьте ключ на странице «Подключения LLM» (/llm-connections), затем повторите.',
  },
};

describe('T-0573 R-1 — assistantErrorText reads the canonical envelope', () => {
  it('canonical {error:{code,message}} body → returns the nested server message (with /llm-connections)', () => {
    const text = assistantErrorText(CANONICAL_503_BODY, 'FALLBACK');
    expect(text).not.toBe('FALLBACK');
    expect(text).toContain('/llm-connections');
    expect(text).toContain('LLM-ключ');
  });

  it('legacy flat {error:"LLM_NOT_CONFIGURED", message} body → still returns the flat message (backward compat)', () => {
    const legacy = {
      error: 'LLM_NOT_CONFIGURED',
      message: 'LLM не настроен — настройте BYO-ключ для активации ассистента.',
    };
    expect(assistantErrorText(legacy, 'FALLBACK')).toBe(legacy.message);
  });

  it('canonical 500 INTERNAL envelope → returns its message (non-ok branch consumption)', () => {
    const internal = { error: { code: 'INTERNAL', message: 'internal server error' } };
    expect(assistantErrorText(internal, 'FALLBACK')).toBe('internal server error');
  });

  it('empty / unparseable / null bodies → falls back honestly', () => {
    expect(assistantErrorText({}, 'FALLBACK')).toBe('FALLBACK');
    expect(assistantErrorText(null, 'FALLBACK')).toBe('FALLBACK');
    expect(assistantErrorText(undefined, 'FALLBACK')).toBe('FALLBACK');
    expect(assistantErrorText('not an object', 'FALLBACK')).toBe('FALLBACK');
    // error present but message missing / blank → fallback, not "undefined".
    expect(assistantErrorText({ error: { code: 'X' } }, 'FALLBACK')).toBe('FALLBACK');
    expect(assistantErrorText({ error: { code: 'X', message: '  ' } }, 'FALLBACK')).toBe('FALLBACK');
  });

  it('nested error.message WINS over a flat message when both present (canonical first)', () => {
    const both = { error: { code: 'LLM_UNAVAILABLE', message: 'nested' }, message: 'flat' };
    expect(assistantErrorText(both, 'FALLBACK')).toBe('nested');
  });
});

describe('T-0573 R-1 — screen-assistant.jsx consumption points route through assistantErrorText', () => {
  it('imports assistantErrorText from the pure module', () => {
    expect(src).toMatch(/import\s+\{\s*assistantErrorText\s*\}\s+from\s+'\.\/assistant-error-text\.js'/);
  });

  it('503 branch uses assistantErrorText(d, …) — NOT the flat d.message read (the exact R-1 regression)', () => {
    // The 503 branch must contain the helper call… (window widened to 1200
    // by T-0595 — the branch grew a deepLinks-explaining comment block, ADR-T0595 §1.3).
    expect(src).toMatch(/r\.status === 503[\s\S]{0,1200}assistantErrorText\(d,/);
    // …and must NOT regress to the pre-fix flat read `text: d.message ?? '…'`.
    expect(src).not.toMatch(/text:\s*d\.message\s*\?\?/);
  });

  it('non-ok (4xx/5xx) branch also routes the parsed envelope through assistantErrorText', () => {
    expect(src).toMatch(/!r\.ok[\s\S]{0,600}assistantErrorText\(parsed,/);
  });
});

/**
 * T-0595 (ADR-T0595, UX_REVIEW T-0573 F-1/F-2) — additive coverage.
 *
 * respondLlmUnavailable now resolves the caller's admin status server-side
 * and — ONLY for admin callers — adds a structured error.deepLinks
 * descriptor to the SAME canonical envelope. assistantErrorText is a PURE
 * text-extraction function and must keep working unchanged when an unknown
 * extra field (deepLinks) is present (N1 — additive envelope, no consumer
 * regression). The 503 branch must separately thread `d.error.deepLinks`
 * into the rendered message object, using the SAME MessageBubble deep-link
 * render block that already exists for bundle-review (T-0465/D8-G4).
 */
describe('T-0595 — admin envelope carries error.deepLinks; assistantErrorText ignores unknown fields (AC-6, additive)', () => {
  // Fixture texts mirror the CURRENT constants (assistant-messages.ts) incl.
  // UX_REVIEW T-0595 F-1 (page named by its factual nav/h1 title
  // «LLM-соединения») and F-4 (non-admin tail says what happens next, not
  // «затем повторите» the caller cannot themselves satisfy).
  const ADMIN_503_BODY_WITH_DEEPLINKS = {
    error: {
      code: 'LLM_UNAVAILABLE',
      message:
        'Ассистент пока не может ответить — не подключён рабочий LLM-ключ. ' +
        'Подключите или проверьте ключ на странице «LLM-соединения», затем повторите.',
      deepLinks: [{ path: '/llm-connections', label: 'Открыть LLM-соединения' }],
    },
  };

  const NON_ADMIN_503_BODY_NO_DEEPLINKS = {
    error: {
      code: 'LLM_UNAVAILABLE',
      message:
        'Ассистент пока не может ответить — не подключён рабочий LLM-ключ. ' +
        'Обратитесь к администратору вашей организации, чтобы подключить ключ — ' +
        'когда ключ подключат, ассистент начнёт отвечать.',
      // deepLinks intentionally absent — non-admin caller, no dead door.
    },
  };

  it('AC-6: admin body WITH deepLinks — assistantErrorText still extracts the message unchanged (unknown field ignored)', () => {
    const text = assistantErrorText(ADMIN_503_BODY_WITH_DEEPLINKS, 'FALLBACK');
    expect(text).not.toBe('FALLBACK');
    expect(text).toContain('LLM-соединения');
    // F-2: admin prose no longer carries the bare path.
    expect(text).not.toContain('/llm-connections');
  });

  it('AC-3: non-admin body WITHOUT deepLinks — assistantErrorText extracts the honest "ask your admin" message', () => {
    const text = assistantErrorText(NON_ADMIN_503_BODY_NO_DEEPLINKS, 'FALLBACK');
    expect(text).not.toBe('FALLBACK');
    expect(text.toLowerCase()).toMatch(/администратор/);
    expect(text).not.toContain('/llm-connections');
  });

  it('AC-5: 503 branch threads d.error.deepLinks into the rendered assistantMsg (deepLinks field present in the built object)', () => {
    expect(src).toMatch(/r\.status === 503[\s\S]{0,1200}deepLinks:\s*\(d[\s\S]{0,80}Array\.isArray\(d\.error\.deepLinks\)/);
  });

  it('AC-5: MessageBubble deep-link render block is reused (no new component) — same navigate(dl.path) pattern', () => {
    // The existing bundle-review deep-link render (T-0465/D8-G4) is the ONE
    // block T-0595 relies on — prove it still exists and still drives
    // navigate() off dl.path (a regression here would silently break BOTH
    // bundle-review and the new honest-503 button).
    expect(src).toMatch(/deepLinks\.map\(\(dl, i\) => \(/);
    expect(src).toMatch(/onClick=\{\(\) => navigate\(dl\.path\)\}/);
  });
});
