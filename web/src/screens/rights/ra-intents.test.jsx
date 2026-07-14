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
 *
 * T-0720 (follow-up из ревью T-0697, эпик T-0585) adds:
 *  - SelfAbsenceForm now consumes the server's `tier` ("tier1"/"tier2",
 *    src/http/rights-intents.ts registerSelfAbsence, unchanged by this task —
 *    it already returned tier) in its post-submit ResultBanner, via the new
 *    selfAbsenceResultMessage helper — mirrors substituteResultMessage's
 *    honest tier-branch feedback (closes review R-3).
 *  - Both static hints (SubstituteForm + SelfAbsenceForm) got the R-1/R-2
 *    wording polish from the T-0697 review: "не шире / попытка расширить
 *    будет отклонена" (R-1) and an explicit "не считая ... и самого
 *    замещающего" pool-exclusion clause (R-2) — kept textually IDENTICAL
 *    between the two forms except for the necessarily-different pronoun.
 */

import { describe, it, expect } from 'vitest';
import { missingSubstituteFields, substituteResultMessage, selfAbsenceResultMessage, substituteCoverageWarning } from './ra-intents.jsx';

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
  it('tier 1 (role already covered) → says no temporary access was issued, substitute acts within THEIR OWN rights, no false "получил доступ" claim', () => {
    const msg = substituteResultMessage({ tier: 1, rule_id: 'rule-1', ttl_grant_id: null, valid_until: 123 });
    expect(msg).toMatch(/не выпускался/);
    expect(msg).toMatch(/в рамках его собственных прав/);
    expect(msg).not.toMatch(/получил временный доступ/);
  });

  it('T-0731 regression lock (mirrors T-0720 B1): tier1 message promises NO auto-escalation — the system has no tier1→tier2 re-mint mechanism', () => {
    // Судейский блок T-0720 B1 нашёл этот же overpromise в selfAbsenceResultMessage
    // и заблокировал его: «...вступит в силу автоматически, если этот держатель
    // станет недоступен» — механизма авто-эскалации/ре-минта гранта при
    // опустошении пула НЕТ (tier1 ttl_grant_id остаётся NULL навсегда; claim-гейт
    // inbox.ts resolveTier2SubstitutionClaim даёт tier1-заместителю без
    // собственной роли 403 NOT_ELIGIBLE). Тот же overpromise жил нетронутым в
    // substituteResultMessage (T-0639) — T-0731 закрывает его тем же способом.
    const msg = substituteResultMessage({ tier: 1, rule_id: 'rule-1', ttl_grant_id: null, valid_until: 123 });
    expect(msg).not.toMatch(/автоматически/);
    expect(msg).not.toMatch(/вступит в силу/);
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
  });

  it('SubstituteForm and SelfAbsenceForm now use textually consistent phrasing for the same rule (no jargon divergence)', () => {
    const subStart = src.indexOf('export function SubstituteForm');
    const subEnd = src.indexOf('/* ---- Я в отпуске');
    const subBody = src.slice(subStart, subEnd);
    const selfBody = selfAbsenceBody();
    for (const term of ['покрывается пулом', 'временный грант не выпускается', 'выпускается ограниченный временный грант', 'не шире', 'попытка расширить будет отклонена сервером']) {
      expect(subBody).toMatch(new RegExp(term));
      expect(selfBody).toMatch(new RegExp(term));
    }
  });
});

// ---------------------------------------------------------------------------
// T-0720 (эпик T-0585, follow-up из ревью T-0697 R-1/R-2/R-3) —
//   R-1: "строго ограничены подмножеством X прав — расширение прав
//        невозможно и отклоняется сервером" was slightly technical (P3 nit) →
//        reworded to "не шире X прав — попытка расширить будет отклонена
//        сервером" in BOTH forms.
//   R-2: "(есть другие активные держатели)" undersold that the pool-probe
//        also excludes the substitute themself, not just the absentee — the
//        note now names BOTH excluded parties explicitly.
//   R-3: SelfAbsenceForm's ResultBanner did not consume the server's `tier`
//        for post-submit feedback (SubstituteForm already did, T-0639) —
//        closed via the new selfAbsenceResultMessage helper below.
// ---------------------------------------------------------------------------

describe('R-1/R-2 wording polish — both static hints reworded, consistently (T-0720)', () => {
  const subBody = () => {
    const start = src.indexOf('export function SubstituteForm');
    const end = src.indexOf('/* ---- Я в отпуске');
    return src.slice(start, end);
  };
  const selfBody = () => {
    const start = src.indexOf('function SelfAbsenceForm');
    const end = src.indexOf('/* ---- Срочно отозвать');
    return src.slice(start, end);
  };

  it('the old, slightly-technical R-1 phrasing is gone from both forms\' visible notes', () => {
    for (const body of [subBody(), selfBody()]) {
      const withoutComments = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      expect(withoutComments).not.toMatch(/строго ограничены подмножеством/);
      expect(withoutComments).not.toMatch(/расширение прав невозможно и отклоняется сервером/);
    }
  });

  it('R-1: both forms now say "не шире ... — попытка расширить будет отклонена сервером"', () => {
    expect(subBody()).toMatch(/не шире прав замещаемой роли — попытка расширить будет отклонена сервером/);
    expect(selfBody()).toMatch(/не шире ваших прав — попытка расширить будет отклонена сервером/);
  });

  it('R-2: SubstituteForm names BOTH excluded parties (замещаемый AND замещающий), not just "other holders"', () => {
    expect(subBody()).toMatch(/есть держатель, отличный от замещаемого и от самого замещающего/);
  });

  it('R-2: SelfAbsenceForm names BOTH excluded parties (вы AND замещающий), not just "other active holders"', () => {
    expect(selfBody()).toMatch(/есть держатель, отличный от вас и от самого замещающего/);
  });

  it('the old, imprecise R-2 phrasing ("есть другие активные держатели") is gone', () => {
    const withoutComments = selfBody().replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(withoutComments).not.toMatch(/есть другие активные держатели/);
  });
});

describe('selfAbsenceResultMessage — honest tier-aware feedback (T-0720, closes review R-3)', () => {
  it('tier1 (role covered by another holder) → says the substitute got NO temporary access, acts within THEIR OWN rights', () => {
    const msg = selfAbsenceResultMessage({ tier: 'tier1', rule_id: 'rule-1', ttl_grant_id: null, valid_until: 123 });
    expect(msg).toMatch(/не выпускался/);
    expect(msg).toMatch(/в рамках его собственных прав/);
    expect(msg).not.toMatch(/выпущен ограниченный временный/);
  });

  it('B1 regression lock: tier1 message promises NO auto-escalation — the system has no tier1→tier2 re-mint mechanism', () => {
    // Судейский блок T-0720 B1: первая редакция tier1-сообщения обещала
    // «замещение вступит в силу автоматически», но механизма авто-эскалации
    // при опустошении пула НЕТ (в tier1 ttl_grant_id остаётся NULL навсегда —
    // серверный тест s5 в rights-intents.self-absence.authz.test.ts; claim-гейт
    // inbox.ts даёт tier1-замещающему без собственной роли 403 NOT_ELIGIBLE).
    // Лочим отсутствие этого обещания в tier1-тексте.
    const msg = selfAbsenceResultMessage({ tier: 'tier1', rule_id: 'rule-1', ttl_grant_id: null, valid_until: 123 });
    expect(msg).not.toMatch(/автоматически/);
    expect(msg).not.toMatch(/вступит в силу/);
  });

  it('tier2 (sole holder → grant minted) → says the substitute got a scoped temporary access, "до <date>"', () => {
    // A fixed epoch ms so the formatted date is deterministic across timezones
    // that all resolve the same calendar day in Moscow-adjacent test runners
    // is out of scope here — we only assert the STRUCTURE (tier2 message
    // names the access as scoped ("не шире ваших прав") and includes "до ").
    const msg = selfAbsenceResultMessage({ tier: 'tier2', rule_id: 'rule-2', ttl_grant_id: 'g-1', valid_until: Date.UTC(2026, 7, 1, 10, 0) });
    expect(msg).toMatch(/выпущен ограниченный временный доступ/);
    expect(msg).toMatch(/не шире ваших прав/);
    expect(msg).toMatch(/ до /);
    expect(msg).not.toMatch(/не выпускался/);
  });

  it('tier2 without a valid_until still produces a coherent message (no dangling "до" / no crash)', () => {
    const msg = selfAbsenceResultMessage({ tier: 'tier2', ttl_grant_id: 'g-1' });
    expect(msg).toMatch(/выпущен ограниченный временный доступ/);
    expect(msg).not.toMatch(/ до $/);
  });

  it('the two tier messages are textually distinct', () => {
    const m1 = selfAbsenceResultMessage({ tier: 'tier1' });
    const m2 = selfAbsenceResultMessage({ tier: 'tier2', ttl_grant_id: 'g-1' });
    expect(m1).not.toBe(m2);
  });

  it('defensive fallback when tier is absent (contract not broken)', () => {
    const withGrant = selfAbsenceResultMessage({ ttl_grant_id: 'g-9' });
    const withoutGrant = selfAbsenceResultMessage({});
    expect(withGrant).toContain('Отсутствие объявлено');
    expect(withoutGrant).toContain('Отсутствие объявлено');
  });

  it('neither tier message leaks the internal "Tier" jargon word', () => {
    const m1 = selfAbsenceResultMessage({ tier: 'tier1' });
    const m2 = selfAbsenceResultMessage({ tier: 'tier2', ttl_grant_id: 'g-1' });
    const mFallback = selfAbsenceResultMessage({});
    expect(m1).not.toMatch(/Tier/i);
    expect(m2).not.toMatch(/Tier/i);
    expect(mFallback).not.toMatch(/Tier/i);
  });

  it('selfAbsenceResultMessage and substituteResultMessage use consistent vocabulary for the same concepts (не выпускался / ограниченный ... доступ, не шире)', () => {
    // Cross-check against SubstituteForm's own message (imported above) — both
    // helpers describe the identical server-side tier split, so the honest
    // "nothing changed" vs "scoped temporary access" framing should read the
    // same way to an admin who has already seen the other form.
    const subTier1 = substituteResultMessage({ tier: 1 });
    const selfTier1 = selfAbsenceResultMessage({ tier: 'tier1' });
    // Both must communicate "no access was minted" without claiming the
    // opposite outcome.
    expect(subTier1).not.toMatch(/получил временный доступ/);
    expect(selfTier1).not.toMatch(/выпущен ограниченный временный/);
  });

  it('T-0731: tier1 messages of both forms now share the SAME honest vocabulary word-for-word (не выпускался / в рамках ... собственных прав), stricter than "not the opposite claim"', () => {
    // T-0731 mirrored T-0720's B1 fix into substituteResultMessage using the
    // exact same phrasing selfAbsenceResultMessage already shipped — a reader
    // who has seen one tier1 banner should not notice the two forms were
    // fixed in different tasks.
    const subTier1 = substituteResultMessage({ tier: 1 });
    const selfTier1 = selfAbsenceResultMessage({ tier: 'tier1' });
    for (const phrase of ['временный доступ', 'не выпускался', 'в рамках', 'собственных прав']) {
      expect(subTier1).toContain(phrase);
      expect(selfTier1).toContain(phrase);
    }
  });

  it('T-0731 cross-form regression lock: NEITHER tier1 message promises auto-escalation (mirrors T-0720 B1 for both forms)', () => {
    const subTier1 = substituteResultMessage({ tier: 1 });
    const selfTier1 = selfAbsenceResultMessage({ tier: 'tier1' });
    for (const msg of [subTier1, selfTier1]) {
      expect(msg).not.toMatch(/автоматически/);
      expect(msg).not.toMatch(/вступит в силу/);
    }
  });
});

describe('SelfAbsenceForm source — server tier consumed additively, tier stays out of prose (data-tier only) (T-0720)', () => {
  const selfAbsenceBody = () => {
    const start = src.indexOf('function SelfAbsenceForm');
    const end = src.indexOf('/* ---- Срочно отозвать');
    return src.slice(start, end);
  };

  it('submit reads r.data?.tier and stores it alongside the result for the banner', () => {
    const body = selfAbsenceBody();
    expect(body).toContain('selfAbsenceResultMessage(r.data)');
    expect(body).toContain('tier: r.data?.tier');
  });

  it('SelfAbsenceForm passes tier={result?.tier} into its ResultBanner (same pattern as SubstituteForm)', () => {
    const body = selfAbsenceBody();
    expect(body).toMatch(/<ResultBanner result=\{result\} tier=\{result\?\.tier\}\s*\/>/);
  });

  it('the old, tier-blind post-submit message ("Отсутствие объявлено" with only a ttl_grant_id check inline in JSX) is gone', () => {
    const body = selfAbsenceBody();
    expect(body).not.toMatch(/message:\s*`Отсутствие объявлено\$\{r\.data/);
  });

  it('SelfAbsenceForm still posts to /api/rights/intents/self-absence (no new/renamed route)', () => {
    const body = selfAbsenceBody();
    expect(body).toContain("'/api/rights/intents/self-absence'");
  });
});

// ---------------------------------------------------------------------------
// T-0745 (эпик T-0585, design: docs/tasks/T-0729.assessment.md §3 variant б +
// docs/tasks/T-0745.spec.md) — предупреждение о не-держателе роли + вывод
// уже существующего API-параметра force_tier2 в обе формы.
// ---------------------------------------------------------------------------

describe('substituteCoverageWarning — pure (T-0745, design §4)', () => {
  it('providesCoverage: false → returns a warning naming the role', () => {
    const msg = substituteCoverageWarning({ providesCoverage: false, roleLabel: 'бюджет-approver' });
    expect(msg).toMatch(/не держит «бюджет-approver»/);
  });

  it('providesCoverage: false with no roleLabel → falls back to a generic phrase, no crash', () => {
    const msg = substituteCoverageWarning({ providesCoverage: false, roleLabel: null });
    expect(msg).toMatch(/не держит выбранную роль/);
  });

  it('providesCoverage: true → no warning (null)', () => {
    expect(substituteCoverageWarning({ providesCoverage: true, roleLabel: 'x' })).toBeNull();
  });

  it('providesCoverage: null (unknown/loading/incomplete selection) → no warning (never a false negative)', () => {
    expect(substituteCoverageWarning({ providesCoverage: null, roleLabel: 'x' })).toBeNull();
  });

  it('honest post-T-0744 mechanic: names the tenant OWNER as the fallback recipient, not the stand-in', () => {
    const msg = substituteCoverageWarning({ providesCoverage: false, roleLabel: 'x' });
    expect(msg).toMatch(/владельцу тенанта/);
  });

  it('names the force_tier2 checkbox by its human label, not "force_tier2" or "Tier-2"', () => {
    const msg = substituteCoverageWarning({ providesCoverage: false, roleLabel: 'x' });
    expect(msg).toMatch(/выдать собственный временный доступ/);
    expect(msg).not.toMatch(/force_tier2/);
    expect(msg).not.toMatch(/Tier-2|Tier-1/);
  });

  it('never claims the stand-in loses ability to act at all — only that access does not land on them automatically (honest, not alarmist)', () => {
    const msg = substituteCoverageWarning({ providesCoverage: false, roleLabel: 'x' });
    expect(msg).not.toMatch(/не сможет ничего/);
  });
});

describe('useSubstitutionCoverage — source presence (T-0745): pre-submit read wired to the new endpoint', () => {
  it('calls GET /api/rights/intents/substitution-coverage with role_id + substitute_employee_id', () => {
    const start = src.indexOf('function useSubstitutionCoverage');
    const end = src.indexOf('substituteCoverageWarning — T-0745, pure');
    const body = src.slice(start, end);
    expect(body).toContain('/api/rights/intents/substitution-coverage');
    expect(body).toContain('role_id');
    expect(body).toContain('substitute_employee_id');
  });

  it('only fetches once BOTH roleId and substituteId are chosen (no premature/партиал query)', () => {
    const start = src.indexOf('function useSubstitutionCoverage');
    const end = src.indexOf('substituteCoverageWarning — T-0745, pure');
    const body = src.slice(start, end);
    expect(body).toMatch(/if \(!roleId \|\| !substituteId\)/);
  });

  it('a failed/errored read resolves to null (unknown), never to false (advisory-only, no false negative)', () => {
    const start = src.indexOf('function useSubstitutionCoverage');
    const end = src.indexOf('substituteCoverageWarning — T-0745, pure');
    const body = src.slice(start, end);
    expect(body).toMatch(/\.catch\(\(\) => \{ if \(alive\) setProvidesCoverage\(null\); \}\)/);
  });
});

describe('SubstitutionCoverageHint — shared block used by BOTH forms (T-0745)', () => {
  const hintBody = () => {
    const start = src.indexOf('function SubstitutionCoverageHint');
    const end = src.indexOf('export function SubstituteForm');
    return src.slice(start, end);
  };

  it('renders the force_tier2 checkbox with an honest human label (no "force_tier2"/"Tier-2" jargon)', () => {
    const body = hintBody();
    expect(body).toMatch(/type="checkbox"/);
    expect(body).toContain('Выдать замещающему собственный временный доступ сразу');
    expect(body).not.toMatch(/force_tier2/);
    expect(body).not.toMatch(/Tier-1|Tier-2/);
  });

  it('the checkbox hint is textually consistent with both forms\' existing static notes ("ограниченный временный грант", "не шире")', () => {
    const body = hintBody();
    expect(body).toMatch(/ограниченный временный грант/);
    expect(body).toMatch(/не шире прав замещаемой роли/);
  });

  it('the warning banner renders ONLY when `warning` is truthy (never blocks submit — no disabled= wiring here)', () => {
    const body = hintBody();
    expect(body).toMatch(/\{warning && \(/);
    expect(body).not.toMatch(/disabled=/);
  });
});

describe('SubstituteForm — force_tier2 + coverage warning wired into the write body (T-0745)', () => {
  const subBody = () => {
    const start = src.indexOf('export function SubstituteForm');
    const end = src.indexOf('/* ---- Я в отпуске');
    return src.slice(start, end);
  };

  it('posts force_tier2 (the state driven by the new checkbox) to the EXISTING /api/rights/intents/substitute endpoint — no new/second write route', () => {
    const body = subBody();
    expect(body).toContain('force_tier2: forceTier2');
    expect(body).toContain("'/api/rights/intents/substitute'");
  });

  it('renders SubstitutionCoverageHint once a substitute is picked, wired to useSubstitutionCoverage(roleId, substituteId)', () => {
    const body = subBody();
    expect(body).toContain('useSubstitutionCoverage(roleId, substituteId)');
    expect(body).toMatch(/\{substituteId && \(\s*<SubstitutionCoverageHint/);
  });

  it('still carries no raw "Tier-1"/"Tier-2" jargon after the T-0745 additions (regression lock over the T-0639 guarantee)', () => {
    const body = subBody();
    expect(body).not.toMatch(/Tier-1|Tier-2/);
  });
});

describe('SelfAbsenceForm — force_tier2 + coverage warning wired into the write body (T-0745)', () => {
  const selfBody = () => {
    const start = src.indexOf('function SelfAbsenceForm');
    const end = src.indexOf('/* ---- Срочно отозвать');
    return src.slice(start, end);
  };

  it('posts force_tier2 to the EXISTING /api/rights/intents/self-absence endpoint — no new/second write route', () => {
    const body = selfBody();
    expect(body).toContain('force_tier2: forceTier2');
    expect(body).toContain("'/api/rights/intents/self-absence'");
  });

  it('renders SubstitutionCoverageHint once a substitute is picked, wired to useSubstitutionCoverage(roleId, substituteId)', () => {
    const body = selfBody();
    expect(body).toContain('useSubstitutionCoverage(roleId, substituteId)');
    expect(body).toMatch(/\{substituteId && \(\s*<SubstitutionCoverageHint/);
  });

  it('still carries no raw "Tier-1"/"Tier-2" jargon after the T-0745 additions (regression lock over the T-0697/T-0720 guarantee)', () => {
    const withoutComments = selfBody().replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(withoutComments).not.toMatch(/Tier-1|Tier-2/);
  });
});

// T-0745 anti-case: NOT re-implemented as a source-string test here — this
// worktree's ci/checks/rights-ui-anti-case.sh / anti-case-lock.sh ALREADY
// scan every added web/src/ line (git-diff scoped) for the banned literals.
// A parallel unit test would have to spell out the SAME denylist as string
// literals, which the case-content scanner then flags as an anti-case hit
// in the test file itself (self-defeating duplication) — the CI gate is the
// single source of truth for this invariant.

// ---------------------------------------------------------------------------
// T-0774 (anti-UUID, E-UX-HUMAN, live-audit T-0693): the hire/fire/substitute
// employee pickers (useOrgDirectory) used to build their option label as
// `x.slug || x.id` ONLY — for a Keycloak-registered human, slug === the KC
// user UUID, so every one of these dropdowns (Уволить, Подмена «кого
// замещают»/«кто замещает», Срочно отозвать «замещающий») showed a bare UUID
// string instead of a name. GET /api/org/tenant-state's employees rows carry
// display_name (T-0608, src/http/seed-write.ts) — employeeOptionLabel now
// resolves it via the SAME formatPersonName(...) || slug chain
// ra-overview-forms.jsx's "Назначить роль" picker already uses (single
// authority, not a bespoke second copy).
// ---------------------------------------------------------------------------

import { employeeOptionLabel } from './ra-intents.jsx';

describe('employeeOptionLabel — hire/fire/substitute picker option label (T-0774)', () => {
  it('a resolved display_name wins over slug/id', () => {
    expect(employeeOptionLabel({ id: 'e0000000-1111-2222-3333-444444444444', slug: 'e0000000-1111-2222-3333-444444444444', display_name: 'И. Орлова' }))
      .toBe('И. Орлова');
  });

  it('falls back to the slug when display_name is blank/whitespace-only (never a raw UUID when a human-legible slug exists)', () => {
    expect(employeeOptionLabel({ id: 'e0000000-1111-2222-3333-444444444444', slug: 'e-orlova', display_name: '' }))
      .toBe('e-orlova');
    expect(employeeOptionLabel({ id: 'e0000000-1111-2222-3333-444444444444', slug: 'e-orlova', display_name: '   ' }))
      .toBe('e-orlova');
  });

  it('the T-0693 live-audit case: slug === the KC UUID and display_name is absent — degrades to the id, but display_name (when present) is what actually renders in production for every KC-registered human', () => {
    const kcUuid = 'e0000000-1111-2222-3333-444444444444';
    // Absolute worst case (no display_name AND slug happens to equal the UUID,
    // e.g. a not-yet-backfilled legacy row): the option still resolves to
    // SOMETHING (never throws, never blank) — this is the pre-existing honest
    // last-resort degrade, unchanged. The FIX is that production rows always
    // carry display_name now (T-0608 backend), so this branch is not the
    // common case any more.
    expect(employeeOptionLabel({ id: kcUuid, slug: kcUuid, display_name: null })).toBe(kcUuid);
  });

  it('never throws on a missing/undefined row (defensive — mirrors PersonCell/PersonFieldValue\'s own Map-miss tolerance)', () => {
    expect(() => employeeOptionLabel(undefined)).not.toThrow();
    expect(employeeOptionLabel(undefined)).toBe('');
    expect(employeeOptionLabel(null)).toBe('');
  });
});

describe('useOrgDirectory wiring — employees resolve via employeeOptionLabel, roles/departments stay slug-based (T-0774)', () => {
  it('the OLD single `opt()` mapper applied to employees is gone (was `employees: opt(d.employees)`, slug/id only)', () => {
    const idx = src.indexOf('function useOrgDirectory');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 900);
    expect(block).not.toContain('employees: opt(d.employees)');
    expect(block).not.toContain('const opt = (rows)');
  });

  it('employees resolve via employeeOptionLabel; roles/departments keep the generic slug-based option (no display_name column on those tables)', () => {
    const idx = src.indexOf('function useOrgDirectory');
    const block = src.slice(idx, idx + 900);
    expect(block).toContain('employeeOpt(d.employees)');
    expect(block).toContain('genericOpt(d.roles)');
    expect(block).toContain('genericOpt(d.departments)');
    expect(block).toContain('label: employeeOptionLabel(x)');
  });
});
