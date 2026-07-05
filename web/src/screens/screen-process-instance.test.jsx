/**
 * web/src/screens/screen-process-instance.test.jsx  (T-0609)
 *
 * Source-presence tests (project convention — see screen-rights.test.jsx,
 * screen-agents.test.jsx): vitest "node" environment, no React mount. The screen
 * fetches JSON and renders declaratively; here we assert the wiring structurally.
 *
 * Live acceptance finding (2026-07-03): the process-instance detail page showed
 * NEITHER process variables NOR detailed transition history — a P0 gateway-branch
 * diagnosis previously required raw SQL against the Flowable tables. This task adds
 * both, sourced from two new GET /api/processes/:id response fields (`variables`,
 * `history` + `historyAvailable`), under the SAME existing tenant-membership gate
 * this page already used (no widened visibility).
 */

import { describe, it, expect } from 'vitest';

const fs = await import('fs');
const path = await import('path');
const screenPath = path.default.resolve(new URL(import.meta.url).pathname, '../screen-process-instance.jsx');
const screenSrc = fs.default.readFileSync(screenPath, 'utf-8');

describe('screen-process-instance — process variables section (T-0609, superseded by T-0684)', () => {
  // T-0684 [capstone T-0647 P1]: the variables section now goes through the
  // phantom-dropping / honest-value helpers (hasRenderableVariables /
  // renderableVariables / formatVariableValue) instead of the pre-fix
  // hasVariables + raw instance.variables.map + String(value) path that printed the
  // literal "undefined". These assertions lock the CORRECTED wiring.
  it('imports the honest variable helpers from the pure logic module', () => {
    expect(screenSrc).toContain('hasRenderableVariables');
    expect(screenSrc).toContain('formatVariableValue');
  });
  it('renders a "Переменные процесса" heading gated on hasRenderableVariables(instance)', () => {
    expect(screenSrc).toContain('Переменные процесса');
    expect(screenSrc).toMatch(/hasRenderableVariables\(instance\)\s*&&/);
  });
  it('maps the FILTERED variables to rows (renderableVariables → VariableRow)', () => {
    expect(screenSrc).toMatch(/renderableVariables\(instance\)\.map/);
  });
});

describe('screen-process-instance — detailed transition history (T-0609)', () => {
  it('imports hasDetailedHistory from the pure logic module', () => {
    expect(screenSrc).toContain('hasDetailedHistory');
  });
  it('branches history rendering on hasDetailedHistory(instance)', () => {
    expect(screenSrc).toMatch(/hasDetailedHistory\(instance\)\s*\?/);
  });
  it('maps instance.history to detailed step rows (HistoryStepRow)', () => {
    expect(screenSrc).toMatch(/instance\.history\.map/);
    expect(screenSrc).toContain('HistoryStepRow');
  });
  it('regression: the OLD best-effort audit-projection note text is still present (fallback path unchanged)', () => {
    expect(screenSrc).toContain('Детальная история переходов по этому экземпляру пока недоступна.');
  });
  it('regression: still uses HistoryRow (the pre-T-0609 audit-filter row) in the fallback branch', () => {
    expect(screenSrc).toContain('HistoryRow');
  });
  it('skips the /api/audit best-effort fetch when historyAvailable is already true', () => {
    const idx = screenSrc.indexOf("fetch('/api/audit'");
    expect(idx).toBeGreaterThan(-1);
    const before = screenSrc.slice(Math.max(0, idx - 400), idx);
    expect(before).toMatch(/if \(hasDetailedHistory\(instance\)\) return;/);
  });
});

describe('screen-process-instance — read-only invariant unchanged (T-0556 §3, regression)', () => {
  it('never POSTs/PUTs/PATCHes — GET-only fetches', () => {
    expect(screenSrc).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/);
  });
});

// T-0684 [capstone T-0647 P1]: title = human name (machine key demoted) + variables
// never render the literal "undefined". Structural source-presence locks; the pure
// behaviour is pin-tested in process-instance.logic.test.js.
describe('screen-process-instance — human title + honest variables (T-0684)', () => {
  it('derives the title via deriveInstanceTitle (never the raw machine key)', () => {
    expect(screenSrc).toContain('deriveInstanceTitle');
    // The raw name is no longer rendered directly as the <h1> title.
    expect(screenSrc).not.toMatch(/<h1[^>]*>\s*\{instance\.name\}/);
  });

  it('gates + maps variables through the phantom-dropping / honest-value helpers', () => {
    expect(screenSrc).toContain('hasRenderableVariables');
    expect(screenSrc).toContain('renderableVariables');
    expect(screenSrc).toContain('formatVariableValue');
    // Regression: no longer coerces a raw value with String(...) (which printed "undefined").
    expect(screenSrc).not.toMatch(/String\(variable\.value\)/);
  });
});
