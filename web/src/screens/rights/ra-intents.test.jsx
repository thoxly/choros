/**
 * web/src/screens/rights/ra-intents.test.jsx  (T-0639)
 *
 * Source-presence + pure-function tests (project convention — see
 * screen-rights.test.jsx: vitest "node" environment, no React mount; the
 * screen renders declaratively so string-presence assertions on the .jsx
 * source plus unit tests on the extracted pure helpers give real coverage
 * without a DOM harness).
 *
 * Spec: T-0639.spec.md (this worktree). Base spec:
 * docs/specs/T-0588-substitution-escalation.spec.md §1.3/FR-6.
 *
 * Covers:
 *  - AC-1: «Объявить подмену» stays honestly disabled until all 5 required
 *    fields are filled, AND a visible explanation names the missing ones
 *    (previously: silent disabled, no asterisk on «Орг-узел (отдел)»).
 *  - AC-2: post-submit feedback distinguishes tier 1 (rule created, nothing
 *    changes right now — role still covered by another holder) from tier 2
 *    (grant issued, substitute sees tasks now) — server already returns
 *    `tier` in the POST /api/rights/intents/substitute response body
 *    (src/http/rights-intents.ts, unchanged by this task).
 *  - AC-3: no raw "Tier-1"/"Tier-2" jargon leaks into user-visible text —
 *    tier stays a data-tier attribute / plain number, never the string
 *    "Tier" in prose.
 */

import { describe, it, expect } from 'vitest';
import { missingSubstituteFields, substituteResultMessage } from './ra-intents.jsx';

const fs = await import('fs');
const path = await import('path');
const srcPath = path.default.resolve(new URL(import.meta.url).pathname, '../ra-intents.jsx');
const src = fs.default.readFileSync(srcPath, 'utf-8');

// ---------------------------------------------------------------------------
// AC-1 — explicit required-ness + honest explanation while disabled
// ---------------------------------------------------------------------------

describe('missingSubstituteFields — pure helper drives the disabled-explanation', () => {
  const full = {
    absentId: 'e-1', substituteId: 'e-2', roleId: 'r-1',
    until: '2026-08-01T10:00', orgNodeId: 'dept-1',
  };

  it('all 5 fields filled → nothing missing', () => {
    expect(missingSubstituteFields(full)).toEqual([]);
  });

  it('org-node alone missing → names ONLY "Орг-узел (отдел)" (the field that used to fail silently)', () => {
    const missing = missingSubstituteFields({ ...full, orgNodeId: '' });
    expect(missing).toEqual(['Орг-узел (отдел)']);
  });

  it('every other field missing individually is also named', () => {
    expect(missingSubstituteFields({ ...full, absentId: '' })).toContain('Отсутствует');
    expect(missingSubstituteFields({ ...full, substituteId: '' })).toContain('Замещает');
    expect(missingSubstituteFields({ ...full, roleId: '' })).toContain('Роль');
    expect(missingSubstituteFields({ ...full, until: '' })).toContain('До (дата/время)');
  });

  it('all fields empty → all 5 named', () => {
    const missing = missingSubstituteFields({ absentId: '', substituteId: '', roleId: '', until: '', orgNodeId: '' });
    expect(missing.length).toBe(5);
  });
});

describe('SubstituteForm source — required fields are visibly marked, disabled state explains itself', () => {
  it('every required OrgPicker/Field label in SubstituteForm carries the "*" marker', () => {
    const start = src.indexOf('export function SubstituteForm');
    const end = src.indexOf('/* ---- Я в отпуске');
    const body = src.slice(start, end);
    expect(body).toMatch(/label="Отсутствует \*"/);
    expect(body).toMatch(/label="Замещает \*"/);
    expect(body).toMatch(/label="Роль \*"/);
    expect(body).toMatch(/label="Орг-узел \(отдел\) \*"/);
    expect(body).toMatch(/label="До \(дата\/время\) \*"/);
  });

  it('a legend explains what "*" means', () => {
    const start = src.indexOf('export function SubstituteForm');
    const end = src.indexOf('/* ---- Я в отпуске');
    const body = src.slice(start, end);
    expect(body).toContain('обязательны для заполнения');
  });

  it('the disabled button state renders a visible aria-live explanation naming missing fields', () => {
    const start = src.indexOf('export function SubstituteForm');
    const end = src.indexOf('/* ---- Я в отпуске');
    const body = src.slice(start, end);
    expect(body).toContain('!canSubmit && result !== \'loading\'');
    expect(body).toContain('aria-live="polite"');
    expect(body).toContain('Заполните обязательные поля');
    expect(body).toContain('missing.join');
  });

  it('the button disabled condition is driven by the missing-fields helper (canSubmit), not a silent inline check', () => {
    const start = src.indexOf('export function SubstituteForm');
    const end = src.indexOf('/* ---- Я в отпуске');
    const body = src.slice(start, end);
    expect(body).toMatch(/disabled=\{result === 'loading' \|\| !canSubmit\}/);
  });
});

// ---------------------------------------------------------------------------
// AC-2/AC-3 — honest tier feedback, no raw jargon in visible text
// ---------------------------------------------------------------------------

describe('substituteResultMessage — honest tier-aware feedback (T-0588 §1.3/FR-6)', () => {
  it('tier 1 (role already covered) → says nothing changes right now, no false "получил доступ" claim', () => {
    const msg = substituteResultMessage({ tier: 1, rule_id: 'rule-1', ttl_grant_id: null, valid_until: 123 });
    expect(msg).toMatch(/ничего не меняется/);
    expect(msg).toMatch(/вступит в силу/);
    expect(msg).not.toMatch(/получил временный доступ/);
  });

  it('tier 2 (sole holder → grant minted) → says the substitute has access now', () => {
    const msg = substituteResultMessage({ tier: 2, rule_id: 'rule-2', ttl_grant_id: 'g-1', valid_until: 123 });
    expect(msg).toMatch(/получил временный доступ/);
    expect(msg).toMatch(/увидит задачи/);
    expect(msg).not.toMatch(/ничего не меняется/);
  });

  it('the two messages are textually distinct (not the same string twice)', () => {
    const m1 = substituteResultMessage({ tier: 1 });
    const m2 = substituteResultMessage({ tier: 2, ttl_grant_id: 'g-1' });
    expect(m1).not.toBe(m2);
  });

  it('defensive fallback when tier is absent from an old/foreign response shape (contract not broken)', () => {
    const withGrant = substituteResultMessage({ ttl_grant_id: 'g-9' });
    const withoutGrant = substituteResultMessage({});
    expect(withGrant).toContain('Подмена объявлена');
    expect(withoutGrant).toContain('Подмена объявлена');
  });

  it('neither message leaks the internal "Tier" jargon word', () => {
    const m1 = substituteResultMessage({ tier: 1 });
    const m2 = substituteResultMessage({ tier: 2, ttl_grant_id: 'g-1' });
    expect(m1).not.toMatch(/Tier/i);
    expect(m2).not.toMatch(/Tier/i);
  });
});

describe('SubstituteForm source — server tier consumed additively, tier stays out of prose (data-tier only)', () => {
  it('submit reads r.data?.tier and stores it alongside the result for the banner', () => {
    const start = src.indexOf('export function SubstituteForm');
    const end = src.indexOf('/* ---- Я в отпуске');
    const body = src.slice(start, end);
    expect(body).toContain('substituteResultMessage(r.data)');
    expect(body).toContain('tier: r.data?.tier');
  });

  it('ResultBanner receives tier and renders it as data-tier (never as visible "Tier-N" text)', () => {
    expect(src).toContain('function ResultBanner({ result, tier })');
    expect(src).toMatch(/'data-tier':\s*String\(tier\)/);
  });

  it('SubstituteForm itself (this task\'s scope) carries no raw "Tier-N" jargon in its own body', () => {
    // NOTE: at the time of T-0639, SelfAbsenceForm (a DIFFERENT form, out of
    // scope per T-0639.spec.md §3 — only SubstituteForm was named in that
    // task) still said "Tier-1"/"Tier-2" in its pre-existing static note.
    // That follow-up shipped as T-0697 (below) — see the
    // "SelfAbsenceForm source" describe block for the equivalent assertion.
    const start = src.indexOf('export function SubstituteForm');
    const end = src.indexOf('/* ---- Я в отпуске');
    const body = src.slice(start, end);
    expect(body).not.toMatch(/Tier-1|Tier-2/);
  });

  it('SubstituteForm passes tier={result?.tier} into its ResultBanner', () => {
    const start = src.indexOf('export function SubstituteForm');
    const end = src.indexOf('/* ---- Я в отпуске');
    const body = src.slice(start, end);
    expect(body).toMatch(/<ResultBanner result=\{result\} tier=\{result\?\.tier\}\s*\/>/);
  });
});

// ---------------------------------------------------------------------------
// Regression — the write endpoint / contract itself is untouched by this task
// (server already returned `tier`; T-0639 only consumes it additively).
// ---------------------------------------------------------------------------

describe('T-0639 — write path unchanged (still exactly one POST to the existing endpoint)', () => {
  it('SubstituteForm still posts to /api/rights/intents/substitute (no new/renamed route)', () => {
    const start = src.indexOf('export function SubstituteForm');
    const end = src.indexOf('/* ---- Я в отпуске');
    const body = src.slice(start, end);
    expect(body).toContain("'/api/rights/intents/substitute'");
  });
});

// ---------------------------------------------------------------------------
// T-0697 (эпик T-0585, follow-up из T-0639) — SelfAbsenceForm's static hint
// carried the same "Tier-1"/"Tier-2" jargon the T-0639 spec had explicitly
// scoped OUT (only SubstituteForm was named). Same human-Russian translation
// applied here, same terms as SubstituteForm's note ("покрывается пулом",
// "временный грант не выпускается", "расширение прав невозможно и
// отклоняется сервером") for consistency.
// ---------------------------------------------------------------------------

describe('SelfAbsenceForm source — static hint no longer leaks "Tier-N" jargon (T-0697)', () => {
  const selfAbsenceBody = () => {
    const start = src.indexOf('function SelfAbsenceForm');
    const end = src.indexOf('/* ---- Срочно отозвать');
    return src.slice(start, end);
  };

  it('carries no raw "Tier-1"/"Tier-2" jargon in its visible JSX body (only pre-existing dev comments may still name it)', () => {
    const body = selfAbsenceBody();
    // Strip JSX block comments ({/* ... */}) before asserting — comments are
    // developer-facing, not user-visible, and the file convention (see line
    // ~263, substituteResultMessage's docblock) already names "Tier-N" there.
    const withoutComments = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(withoutComments).not.toMatch(/Tier-1|Tier-2/);
  });

  it('the static note still explains both branches in human Russian, matching SubstituteForm\'s established terms', () => {
    const body = selfAbsenceBody();
    expect(body).toMatch(/покрывается пулом/);
    expect(body).toMatch(/временный грант не выпускается/);
    expect(body).toMatch(/выпускается ограниченный временный грант/);
    expect(body).toMatch(/расширение прав невозможно и отклоняется сервером/);
  });

  it('SubstituteForm and SelfAbsenceForm now use textually consistent phrasing for the same rule (no jargon divergence)', () => {
    const subStart = src.indexOf('export function SubstituteForm');
    const subEnd = src.indexOf('/* ---- Я в отпуске');
    const subBody = src.slice(subStart, subEnd);
    const selfBody = selfAbsenceBody();
    for (const term of ['покрывается пулом', 'временный грант не выпускается', 'расширение прав невозможно и отклоняется сервером']) {
      expect(subBody).toMatch(new RegExp(term));
      expect(selfBody).toMatch(new RegExp(term));
    }
  });
});
