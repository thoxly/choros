/**
 * web/src/screens/screen-overview.test.jsx  (T-0598, находка №1)
 *
 * Source-presence tests (project convention — see screen-inbox.test.jsx,
 * screen-llm-connections.test.jsx): vitest "node" environment, no React mount.
 *
 * Covers the «Первые шаги» non-blocking checklist-stepper:
 *   - AC-1: three mandatory steps + one optional step, each a CTA link.
 *   - AC-2: step 1 reuses the screen's own already-fetched `apps` state
 *     (GET /api/applications) — not a second fetch.
 *   - AC-3: step 2 uses GET /api/agents + the imported pure function
 *     resolveAssistantBinding from screen-llm-connections.jsx (not a copy).
 *   - AC-4: step 3 uses GET /api/assistant/threads, done via message_count>0.
 *   - AC-5: step 4 (rights) is rendered only when can_manage===true —
 *     structurally absent otherwise (not merely "unchecked").
 *   - AC-6: any signal failure degrades honestly (step stays visible, no
 *     crash, link remains functional) — verified via fetchCount-style
 *     try/catch shape in the new signal-loading hook.
 *   - AC-7: the whole strip returns null once all three mandatory signals
 *     are confirmed true.
 *   - AC-8: loading state renders a compact LoadingState, not a premature
 *     false→true flicker.
 */

import { describe, it, expect } from 'vitest';

const fs = await import('fs');
const path = await import('path');
const filePath = path.default.resolve(
  new URL(import.meta.url).pathname,
  '../screen-overview.jsx',
);
const src = fs.default.readFileSync(filePath, 'utf-8');

describe('screen-overview — «Первые шаги» import wiring (AC-3)', () => {
  it('imports resolveAssistantBinding from the existing screen-llm-connections module (no logic duplication)', () => {
    expect(src).toContain("import { resolveAssistantBinding } from './screen-llm-connections.jsx'");
  });
  it('does not redefine a parallel binding-resolution function', () => {
    // Only ONE definition of resolveAssistantBinding may exist project-wide;
    // this file must not declare its own local copy.
    expect(src).not.toMatch(/function\s+resolveAssistantBinding/);
  });
});

describe('screen-overview — no new server endpoints introduced (NF-1)', () => {
  it('reads GET /api/agents (existing endpoint, gated only by withAuth — not /api/llm-connections)', () => {
    expect(src).toContain("fetch('/api/agents'");
  });
  it('reads GET /api/assistant/threads (existing endpoint)', () => {
    expect(src).toContain("fetch('/api/assistant/threads'");
  });
  it('reads GET /api/rights/tenant-state (existing endpoint) for the optional step', () => {
    expect(src).toContain("fetch('/api/rights/tenant-state'");
  });
  it('does not introduce a new aggregate onboarding-status endpoint', () => {
    expect(src).not.toMatch(/\/api\/onboarding/);
  });
});

describe('screen-overview — FirstStepsStrip renders three mandatory + one optional step (AC-1)', () => {
  const stripIdx = src.indexOf('function FirstStepsStrip');
  const stripBody = src.slice(stripIdx, stripIdx + 3000);

  it('FirstStepsStrip component exists', () => {
    expect(stripIdx).toBeGreaterThan(-1);
  });
  it('step 1 links to /apps ("Создайте приложение")', () => {
    expect(stripBody).toContain('Создайте приложение');
    expect(stripBody).toContain("navigate('/apps')");
  });
  it('step 2 links to /llm-connections ("Подключите LLM-ключ")', () => {
    expect(stripBody).toContain('Подключите LLM-ключ');
    expect(stripBody).toContain("navigate('/llm-connections')");
  });
  it('step 3 links to /assistant ("Спросите ассистента")', () => {
    expect(stripBody).toContain('Спросите ассистента');
    expect(stripBody).toContain("navigate('/assistant')");
  });
  it('optional step 4 links to /rights ("Настройте права") and is gated on canManage === true', () => {
    expect(stripBody).toContain('Настройте права');
    expect(stripBody).toContain("navigate('/rights')");
    expect(stripBody).toMatch(/canManage === true &&/);
  });
  it('is wired into OverviewScreen render (not orphaned)', () => {
    expect(src).toContain('<FirstStepsStrip apps={apps} appsLoading={loading} navigate={navigate} />');
  });
});

describe('screen-overview — step 1 reuses the existing apps counter, not a second fetch (AC-2)', () => {
  it('FirstStepsStrip receives apps/appsLoading as props rather than fetching applications itself', () => {
    const stripIdx = src.indexOf('function FirstStepsStrip({ apps, appsLoading, navigate })');
    expect(stripIdx).toBeGreaterThan(-1);
    const stripBody = src.slice(stripIdx, stripIdx + 3000);
    expect(stripBody).not.toContain("fetch('/api/applications'");
  });
  it('step1Done derives from the apps prop (apps > 0)', () => {
    expect(src).toMatch(/step1Done\s*=\s*typeof apps === 'number' && apps > 0/);
  });
});

describe('screen-overview — step 3 checks message_count > 0 (AC-4)', () => {
  it('assistant-used signal checks threads.some(...message_count > 0)', () => {
    const idx = src.indexOf('/api/assistant/threads');
    const body = src.slice(idx, idx + 500);
    expect(body).toMatch(/message_count > 0/);
  });
});

describe('screen-overview — honest degradation on signal failure (AC-6)', () => {
  const hookIdx = src.indexOf('function useFirstStepsSignals');
  const hookBody = src.slice(hookIdx, hookIdx + 2500);

  it('useFirstStepsSignals hook exists', () => {
    expect(hookIdx).toBeGreaterThan(-1);
  });
  it('each of the three fetches is wrapped in try/catch degrading to null (fetchCount-style, never throws)', () => {
    const catchCount = (hookBody.match(/catch\s*\{\s*return null;\s*\}/g) || []).length;
    expect(catchCount).toBeGreaterThanOrEqual(3);
  });
  it('non-ok HTTP responses also degrade to null rather than throwing', () => {
    expect(hookBody).toMatch(/if \(!res\.ok\) return null;/);
  });
});

describe('screen-overview — strip auto-hides only when all three mandatory steps are confirmed true (AC-7)', () => {
  const stripIdx = src.indexOf('function FirstStepsStrip');
  const stripBody = src.slice(stripIdx, stripIdx + 1500);

  it('computes allMandatoryDone from step1Done && step2Done && step3Done', () => {
    expect(stripBody).toMatch(/allMandatoryDone\s*=\s*step1Done\s*&&\s*step2Done\s*&&\s*step3Done/);
  });
  it('returns null (renders nothing) when allMandatoryDone is true', () => {
    expect(stripBody).toMatch(/if \(allMandatoryDone\) return null;/);
  });
  it('does not use localStorage/dismiss persistence (OOS-3 — pure data-derived visibility)', () => {
    expect(stripBody).not.toMatch(/localStorage/);
  });
});

describe('screen-overview — loading state does not flicker (AC-8)', () => {
  const rowIdx = src.indexOf('function StepRow');
  const rowBody = src.slice(rowIdx, rowIdx + 800);

  it('StepRow shows a compact LoadingState while its signal is loading, before the done/todo marker', () => {
    expect(rowBody).toMatch(/loading \? \(\s*<LoadingState compact/);
  });
});

describe('screen-overview — kit primitives + token-only styles (ux-g4/g6)', () => {
  it('uses KitIcon "check" for the done marker (kit primitive, not a hand-rolled glyph)', () => {
    expect(src).toContain('<KitIcon name="check" />');
  });
  it('new step-marker styles reference only --chs-* tokens', () => {
    const idx = src.indexOf('stepMarkerDoneStyle');
    const body = src.slice(idx, idx + 400);
    expect(body).toMatch(/var\(--chs-color-success/);
  });
});

/* ============================================================================
   T-0306 — honest-degrade маркеров «Первых шагов» (unit, чистая функция).
   «не знаем» (сигнал недоступен) ≠ «не сделано» (подтверждённый todo):
   сбой фетча НЕ должен рендерить шаг как несделанный, а первый запуск
   (apps===0, загружено без ошибки) — честный todo с CTA.
   ============================================================================ */

import { stepMarkerState } from './screen-overview.jsx';

describe('stepMarkerState — decision-таблица маркера шага (T-0306)', () => {
  it('loading → "loading" (независимо от остальных флагов)', () => {
    expect(stepMarkerState({ loading: true })).toBe('loading');
    expect(stepMarkerState({ loading: true, done: true })).toBe('loading');
    expect(stepMarkerState({ loading: true, unknown: true })).toBe('loading');
  });

  it('done → "done" (побеждает unknown: подтверждённый чек не гасится сбоем другого сигнала)', () => {
    expect(stepMarkerState({ loading: false, done: true })).toBe('done');
    expect(stepMarkerState({ loading: false, done: true, unknown: true })).toBe('done');
  });

  it('unknown (загружено, сигнал недоступен) → "unknown", НЕ "todo"', () => {
    expect(stepMarkerState({ loading: false, done: false, unknown: true })).toBe('unknown');
  });

  it('подтверждённый первый запуск (не loading, не unknown, не done) → "todo"', () => {
    expect(stepMarkerState({ loading: false, done: false, unknown: false })).toBe('todo');
  });

  it('пустой/отсутствующий аргумент → "todo" (fail-safe, не рушится)', () => {
    expect(stepMarkerState()).toBe('todo');
    expect(stepMarkerState({})).toBe('todo');
  });
});

describe('screen-overview — unknown-маркер честной деградации (T-0306, source-wiring)', () => {
  it('FirstStepsStrip вычисляет unknown-флаги «загружено и null» для трёх шагов', () => {
    expect(src).toMatch(/step1Unknown\s*=\s*!appsLoading && apps === null/);
    expect(src).toMatch(/step2Unknown\s*=\s*!loadingExtra && llmConnected === null/);
    expect(src).toMatch(/step3Unknown\s*=\s*!loadingExtra && assistantUsed === null/);
  });
  it('StepRow рендерит доступный текст «Статус шага недоступен» для unknown', () => {
    expect(src).toContain('Статус шага недоступен');
  });
  it('unknown-маркер стилизован только --chs-* токенами (G6)', () => {
    const idx = src.indexOf('stepMarkerUnknownStyle');
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 400);
    expect(body).toMatch(/var\(--chs-color-text-muted\)/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(/);
  });
});
