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
import { missingSubstituteFields, substituteResultMessage, selfAbsenceResultMessage } from './ra-intents.jsx';

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
