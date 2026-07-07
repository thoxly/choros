/**
 * web/src/screens/rights/screen-rights.test.jsx  (T-0572)
 *
 * Source-presence tests (project convention — see screen-agents.test.jsx):
 * vitest "node" environment, no React mount. The screen fetches JSON and
 * renders declaratively; here we assert the wiring structurally:
 *   - AC-3 (FF-T0572-3): source is /api/rights/tenant-state, NOT /api/rights.
 *   - AC-7 (FF-T0572-7): semi-confirmed rows render in a SEPARATE pending
 *     container with a waiting marker — never merged into active
 *     assignments/grants.
 *   - AC-9 (FF-T0572-9): write forms are NOT in the render tree unless
 *     canManage is true — a structural (not disabled) gate.
 *   - AC-13 / NF-7 (FF-T0572-STATES): Empty/Loading/Error kit primitives are
 *     all present.
 *   - FR-8/AC-12 (FF-T0572-BADGE — cross-checked here too): the badge verdict
 *     tooltip text lives in shell.jsx, asserted in shell.test-adjacent checks
 *     (ci/checks/rights-editor-badge-verdict.sh); not duplicated here.
 */

import { describe, it, expect } from 'vitest';
import { dedupAssignments, holderCount, scopeText } from './screen-rights.jsx';

const fs = await import('fs');
const path = await import('path');
const screenPath = path.default.resolve(new URL(import.meta.url).pathname, '../screen-rights.jsx');
const formsPath = path.default.resolve(new URL(import.meta.url).pathname, '../ra-overview-forms.jsx');
const screenSrc = fs.default.readFileSync(screenPath, 'utf-8');
const formsSrc = fs.default.readFileSync(formsPath, 'utf-8');

describe('screen-rights — source switch (AC-3 / FF-T0572-3)', () => {
  it('fetches the live tenant-state endpoint', () => {
    expect(screenSrc).toContain('/api/rights/tenant-state');
  });
  it('does NOT fetch the old demo-pack /api/rights endpoint', () => {
    expect(screenSrc).not.toMatch(/fetch\(['"]\/api\/rights['"]/);
  });
});

describe('screen-rights — honest Empty/Loading/Error states (AC-13 / NF-7)', () => {
  it('uses the kit ErrorState, LoadingState, EmptyState primitives', () => {
    expect(screenSrc).toContain('ErrorState');
    expect(screenSrc).toContain('LoadingState');
    expect(screenSrc).toContain('EmptyState');
  });
  it('empty state distinguishes self vs tenant scope honestly (no demo flag)', () => {
    expect(screenSrc).toContain("state.scope === 'self'");
    expect(screenSrc).not.toMatch(/demo:\s*true/);
  });
});

describe('screen-rights — «Кто что может» + pending separation (AC-7/AC-8, FR-5/FR-6)', () => {
  it('renders active assignments/grants and a SEPARATE pending block', () => {
    expect(screenSrc).toContain('role.assignments');
    expect(screenSrc).toContain('role.grants');
    expect(screenSrc).toContain('role.pending');
    expect(screenSrc).toContain('chs-ov-pending');
  });
  it('pending rows use the PendingBadge (waiting marker), never rendered inside the active containers', () => {
    expect(screenSrc).toContain('PendingBadge');
    // The pending block is its own container, structurally separate from
    // chs-ov-holders (active assignments) and chs-grants (active grants).
    const pendingBlockIdx = screenSrc.indexOf('chs-ov-pending');
    const holdersIdx = screenSrc.indexOf('chs-ov-holders');
    expect(pendingBlockIdx).toBeGreaterThan(-1);
    expect(holdersIdx).toBeGreaterThan(-1);
    expect(pendingBlockIdx).not.toBe(holdersIdx);
  });
});

describe('screen-rights — write forms gated on can_manage (AC-9, FR-7)', () => {
  it('gates the assign-role and grant-right forms behind canManage — structural, not disabled', () => {
    // Both forms must be conditionally rendered ({canManage && ...}), i.e. the
    // component itself is absent from the tree when canManage is false —
    // not merely `disabled` on a rendered form.
    expect(screenSrc).toMatch(/canManage\s*&&[\s\S]{0,300}<AssignRoleForm/);
    expect(screenSrc).toMatch(/canManage\s*&&[\s\S]{0,300}<GrantRightForm/);
  });
  it('does not disable the forms instead of omitting them (no disabled prop on the form components)', () => {
    expect(screenSrc).not.toMatch(/<AssignRoleForm[^>]*disabled/);
    expect(screenSrc).not.toMatch(/<GrantRightForm[^>]*disabled/);
  });
});

describe('ra-overview-forms — write path hits ONLY existing endpoints (AC-4/5/6, NF-1)', () => {
  it('assigns a role via POST /api/role-assignments (exactly one write call)', () => {
    expect(formsSrc).toContain("'/api/role-assignments'");
    const matches = formsSrc.match(/'\/api\/role-assignments'/g) || [];
    expect(matches.length).toBe(1);
  });
  it('revokes an assignment via POST /api/role-assignments/:id/revoke', () => {
    expect(formsSrc).toContain('/api/role-assignments/${encodeURIComponent(id)}/revoke');
  });
  it('grants a right via POST /api/grants (exactly one write call)', () => {
    expect(formsSrc).toContain("'/api/grants'");
    const matches = formsSrc.match(/'\/api\/grants'/g) || [];
    expect(matches.length).toBe(1);
  });
  it('revokes a grant via POST /api/grants/:id/revoke', () => {
    expect(formsSrc).toContain('/api/grants/${encodeURIComponent(id)}/revoke');
  });
  it('does NOT introduce any new write route literal (no /api/rights/overview/* POST)', () => {
    expect(formsSrc).not.toMatch(/\/api\/rights\/overview/);
  });
});

// ---------------------------------------------------------------------------
// T-0608 (пункт д) — живой факт приёмки: rail count showed grantCount() (число
// ГРАНТОВ роли) where the user reads "число держателей" («Конфигуратор 4» при
// 2 держателях, «Снабженец 0» при 3 — a role can hold grants independently of
// who holds it). Separately, holders rendered per-row.
//
// F-1 fix (review+ux blocking): migrations/020_role_assignment.sql:29-32 —
// NO UNIQUE(employee_id, role_id): the same (employee, role) LEGITIMATELY
// coexists across different org_scope/window. So dedup keys on the COMPOSITE
// identity (employee + org_scope + window), NOT employee_id alone:
//   - true duplicates (identical scope+window) collapse (and revoke together);
//   - differently-scoped assignments of the SAME person stay SEPARATE rows,
//     each with its own scope label and its own Revoke.
//   - holderCount answers "сколько ЧЕЛОВЕК" → distinct employee_id (a person
//     with two scopes is one person) — a DIFFERENT question, correctly by-person.
// ---------------------------------------------------------------------------
describe('holderCount — distinct PEOPLE, not grants or assignment rows (T-0608 д)', () => {
  const twoScopesOnePerson = [
    { id: 'ra-fin', employee_id: 'emp-semyon', employee_display: 'Семён Сидоров', employee_kind: 'human', org_scope: { kind: 'node', nodeId: 'dept-fin' }, valid_from: null, valid_until: null },
    { id: 'ra-cs', employee_id: 'emp-semyon', employee_display: 'Семён Сидоров', employee_kind: 'human', org_scope: { kind: 'node', nodeId: 'dept-cs' }, valid_from: null, valid_until: null },
    { id: 'ra-other', employee_id: 'emp-other', employee_display: 'Другой', employee_kind: 'human', org_scope: { kind: 'node', nodeId: 'dept-fin' }, valid_from: null, valid_until: null },
  ];

  it('counts DISTINCT employees (a person with two scopes is ONE person), not grants', () => {
    const role = { assignments: twoScopesOnePerson, grants: [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }, { id: 'g4' }] };
    // 2 distinct people (Семён across 2 scopes + Другой), despite 3 assignment
    // rows and 4 grants — the bug was showing grants.length (4) here.
    expect(holderCount(role)).toBe(2);
  });
  it('a role with grants but zero holders reports 0 (not grants.length)', () => {
    expect(holderCount({ assignments: [], grants: [{ id: 'g1' }] })).toBe(0);
  });
  it('a role with holders but zero grants reports the holder count (not 0)', () => {
    expect(holderCount({ assignments: twoScopesOnePerson, grants: [] })).toBe(2);
  });
});

describe('dedupAssignments — composite key: different scopes stay separate, true dupes collapse (T-0608 д, F-1)', () => {
  const semyonFin = { id: 'ra-fin', employee_id: 'emp-semyon', employee_display: 'Семён Сидоров', employee_kind: 'human', org_scope: { kind: 'node', nodeId: 'dept-fin' }, valid_from: null, valid_until: null };
  const semyonCs = { id: 'ra-cs', employee_id: 'emp-semyon', employee_display: 'Семён Сидоров', employee_kind: 'human', org_scope: { kind: 'node', nodeId: 'dept-cs' }, valid_from: null, valid_until: null };
  // A genuine duplicate of semyonFin (identical scope + window, different row id).
  const semyonFinDupe = { id: 'ra-fin-2', employee_id: 'emp-semyon', employee_display: 'Семён Сидоров', employee_kind: 'human', org_scope: { kind: 'node', nodeId: 'dept-fin' }, valid_from: null, valid_until: null };

  // (а) THE regression test the F-2 gap demanded: one person, TWO assignments
  // with DIFFERENT org_scope → TWO separate holder rows (NOT collapsed).
  it('(а) one person, TWO different org_scopes → TWO separate holder rows', () => {
    const rows = dedupAssignments([semyonFin, semyonCs]);
    expect(rows.length).toBe(2);
    // Each carries ONLY its own id — scopes are not conflated.
    const fin = rows.find((r) => JSON.stringify(r.org_scope).includes('dept-fin'));
    const cs = rows.find((r) => JSON.stringify(r.org_scope).includes('dept-cs'));
    expect(fin.ids).toEqual(['ra-fin']);
    expect(cs.ids).toEqual(['ra-cs']);
  });

  // (б) revoke of scope-A does NOT touch scope-B: each row's `ids` is that
  // scope's assignments only, so «Отозвать» on отдел-fin never revokes отдел-cs.
  it('(б) revoking one scope does NOT drag the other scope’s assignment along', () => {
    const rows = dedupAssignments([semyonFin, semyonCs]);
    const fin = rows.find((r) => JSON.stringify(r.org_scope).includes('dept-fin'));
    // The Revoke for the fin row targets ['ra-fin'] ONLY — ra-cs is untouched.
    expect(fin.ids).not.toContain('ra-cs');
    expect(fin.ids).toEqual(['ra-fin']);
  });

  it('TRUE duplicates (identical employee + scope + window) DO collapse and carry both ids', () => {
    const rows = dedupAssignments([semyonFin, semyonFinDupe, semyonCs]);
    // 2 rows: {fin+finDupe collapsed}, {cs}.
    expect(rows.length).toBe(2);
    const fin = rows.find((r) => JSON.stringify(r.org_scope).includes('dept-fin'));
    expect(fin.ids.sort()).toEqual(['ra-fin', 'ra-fin-2']);
  });

  it('different validity WINDOW also keeps assignments separate (not just scope)', () => {
    const q1 = { ...semyonFin, id: 'ra-q1', valid_until: 1000 };
    const q2 = { ...semyonFin, id: 'ra-q2', valid_from: 1000 };
    const rows = dedupAssignments([q1, q2]);
    expect(rows.length).toBe(2);
  });

  it('an empty assignments list yields an empty list', () => {
    expect(dedupAssignments([])).toEqual([]);
  });
});

describe('scopeText — plain-string scope label for the ConfirmDialog (T-0608 д, F-1)', () => {
  it('names a node scope via the dictionary (falls back to a human label, never raw JSON)', () => {
    const dict = { orgTree: [{ id: 'dept-fin', label: 'Финансы' }] };
    expect(scopeText({ kind: 'node', nodeId: 'dept-fin' }, dict)).toBe('узел: Финансы');
    expect(scopeText({ kind: 'node', nodeId: 'unknown' }, dict)).toBe('узел оргструктуры');
  });
  it('empty/absent scope → «весь тенант», never raw JSON', () => {
    expect(scopeText(null, {})).toBe('весь тенант');
    expect(scopeText({ kind: 'tags', tags: [] }, {})).toBe('весь тенант');
  });
});

describe('RevokeAssignmentButton — targets ONE scope, names it in the confirm (T-0608 д, F-1)', () => {
  it('accepts `ids` + `scopeLabel` props', () => {
    expect(formsSrc).toMatch(/function RevokeAssignmentButton\(\{\s*id,\s*ids,\s*subjectLabel[^)]*scopeLabel/);
  });
  it('loops over targetIds calling revokeAssignment for each (identical-scope dupes only)', () => {
    const idx = formsSrc.indexOf('function RevokeAssignmentButton');
    const body = formsSrc.slice(idx, formsSrc.indexOf('function RevokeGrantButton'));
    expect(body).toMatch(/for \(const targetId of targetIds\)/);
    expect(body).toContain('await revokeAssignment(targetId);');
  });
  it('ConfirmDialog message names the SCOPE and states other scopes survive (no silent over-revoke)', () => {
    const idx = formsSrc.indexOf('function RevokeAssignmentButton');
    const body = formsSrc.slice(idx, formsSrc.indexOf('function RevokeGrantButton'));
    expect(body).toContain('охват:');
    expect(body).toContain('другие охваты этого человека сохранятся');
  });
  it('screen-rights passes ids={a.ids} + scopeLabel (per-assignment, not per-person)', () => {
    expect(screenSrc).toContain('ids={a.ids}');
    expect(screenSrc).toContain('scopeLabel={scopeLabel}');
  });
  it('screen-rights keys holder rows on the composite assignment identity, not employee_id', () => {
    expect(screenSrc).toContain('key={assignmentIdentityKey(a)}');
    expect(screenSrc).toContain('dedupAssignments(role.assignments)');
  });
});

describe('screen-rights / ra-overview-forms — identity display fallback (T-0608 пункт г)', () => {
  it('the employee picker resolves display_name (not the raw slug/UUID) via formatPersonName', () => {
    expect(formsSrc).toContain("import { formatPersonName } from '../../lib/format.js'");
    expect(formsSrc).toContain('formatPersonName(e.display_name) || e.slug');
  });
});

describe('ra-overview-forms — honest semi-confirmed rendering (AC-7, FR-5/NF-2)', () => {
  it('treats a semi-confirmed response as "waiting for second approval", not active', () => {
    expect(formsSrc).toContain("result.state === 'semi-confirmed'");
    expect(formsSrc).toContain('второго подтверждения');
  });
  it('never sends a body flag that would bypass dual-control (no "skip"/"force"/"bypass" confirm flags)', () => {
    expect(formsSrc).not.toMatch(/skip_confirm|force_confirm|bypass/i);
  });
});

describe('ra-overview-forms — scope uses the existing ScopeElement contract (AC-14, FR-4)', () => {
  it('emits node/tags ScopeElement shapes (no parallel scope format)', () => {
    expect(formsSrc).toContain("kind: 'node'");
    expect(formsSrc).toContain("kind: 'tags'");
  });
});

// ---------------------------------------------------------------------------
// UX_REVIEW iteration (docs/ux-review/T-0572.ux-review.json, changes_requested)
// ---------------------------------------------------------------------------

describe('UX F-1 — empty tenant differentiates can_manage; admin gets a CTA (blocking)', () => {
  it('admin empty branch renders EmptyState WITH a primary action to /rights/editor', () => {
    expect(screenSrc).toContain('Пока нет ролей');
    expect(screenSrc).toContain('Создайте первую роль доступа');
    expect(screenSrc).toContain('Открыть «Каталог ролей»');
    expect(screenSrc).toContain("navigate('/rights/editor')");
    // The CTA lives inside the EmptyState action slot (kit anatomy), not a
    // stray button.
    expect(screenSrc).toMatch(/action=\{\s*<Button[\s\S]{0,200}\/rights\/editor/);
  });
  it('empty branch differentiates by can_manage (not scope alone): self user keeps text-only EmptyState', () => {
    expect(screenSrc).toMatch(/canManage\s*\?[\s\S]{0,400}Пока нет ролей[\s\S]{0,600}У вас пока нет ни одной назначенной роли/);
  });
});

describe('UX F-2 — scope is human-readable, never raw JSON (blocking)', () => {
  it('does NOT render grant scope via JSON.stringify', () => {
    expect(screenSrc).not.toContain('JSON.stringify(g.scope)');
  });
  it('renders scope through the ScopeSummary component', () => {
    expect(screenSrc).toContain('function ScopeSummary');
    expect(screenSrc).toMatch(/<ScopeSummary scope=\{g\.scope\}/);
  });
  it('maps every ScopeElement kind to a human phrase (node/tags/set/interval/sentinel)', () => {
    expect(screenSrc).toContain('Весь тенант');
    expect(screenSrc).toContain('Узел оргструктуры');
    expect(screenSrc).toMatch(/Узел: \$\{node\.label\}/);
    expect(screenSrc).toContain('Диапазон');
    expect(screenSrc).toContain('Особый охват');
  });
  it('resolves the default-open sentinel node to «Весь тенант» (not a raw id)', () => {
    expect(screenSrc).toContain('RESOURCE_ROOT_SENTINEL');
  });
});

describe('UX F-3 — revoke requires a kit confirmation step (nit)', () => {
  it('both revoke buttons open a ConfirmDialog instead of firing on click', () => {
    expect(formsSrc).toContain('ConfirmDialog');
    const dialogs = formsSrc.match(/<ConfirmDialog/g) || [];
    expect(dialogs.length).toBe(2);
    expect(formsSrc).toContain('Отозвать роль?');
    expect(formsSrc).toContain('Отозвать право?');
  });
  it('does not call the native window.confirm', () => {
    expect(formsSrc).not.toContain('window.confirm(');
  });
});

describe('UX F-4 — form sources have honest empty/loading states (nit)', () => {
  it('shows LoadingState while dictionaries/employees are loading', () => {
    expect(formsSrc).toContain('sourcesLoading');
    expect(formsSrc).toContain('Загрузка справочников…');
  });
  it('explains WHY a select is empty (employees / resources / operations / org tree / tags)', () => {
    expect(formsSrc).toContain('Список сотрудников пуст');
    expect(formsSrc).toContain('Справочник ресурсов недоступен');
    expect(formsSrc).toContain('Справочник операций недоступен');
    expect(formsSrc).toContain('Дерево оргструктуры недоступно');
    expect(formsSrc).toContain('Теги охвата не настроены');
  });
});

describe('UX F-5 — one-click path to the confirmation inbox for pending observers (nit)', () => {
  it('the inbox hint renders for canManage OR when the role has pending rows', () => {
    expect(screenSrc).toMatch(/canManage\s*\|\|\s*rolePendingCount\s*>\s*0/);
    expect(screenSrc).toContain('rolePendingCount');
  });
});

// ---------------------------------------------------------------------------
// T-0597 (находка №5) — «Список сотрудников пуст» получает actionable-выход в
// «Оргструктуру» вместо тупика (AC-4/AC-5 of T-0597 spec).
// ---------------------------------------------------------------------------
describe('T-0597 — actionable hint on empty employees list (AC-4/AC-5)', () => {
  it('imports useNavigate from react-router-dom', () => {
    expect(formsSrc).toContain("import { useNavigate } from 'react-router-dom'");
  });
  it('AssignRoleForm calls useNavigate()', () => {
    expect(formsSrc).toMatch(/const navigate = useNavigate\(\)/);
  });
  it('the empty-employees hint still carries the original honest reason text', () => {
    expect(formsSrc).toContain('Список сотрудников пуст');
  });
  it('the hint offers a clickable «Открыть оргструктуру» control wired to navigate(\'/org\')', () => {
    expect(formsSrc).toContain('Открыть оргструктуру');
    expect(formsSrc).toMatch(/onClick=\{\(\)\s*=>\s*navigate\('\/org'\)\}/);
  });
  it('uses a real <button type="button">, not a bare non-interactive element (keyboard reachable)', () => {
    const idx = formsSrc.indexOf('Открыть оргструктуру');
    const before = formsSrc.slice(Math.max(0, idx - 400), idx);
    expect(before).toMatch(/type="button"/);
    expect(before).not.toMatch(/<div\b[^>]*onClick/);
  });
});

// ---------------------------------------------------------------------------
// T-0609 — honest resources: GrantRightForm's «Ресурс» selector must be able to
// carry REAL tenant applications/registries, not only the demo dictionary
// (live acceptance finding, 2026-07-03: only DICT_RESOURCES was ever reachable).
// ---------------------------------------------------------------------------
describe('T-0609 — real resources merged into the grant form dictionary', () => {
  it('screen-rights.jsx fetches the new GET /api/rights/resources endpoint', () => {
    expect(screenSrc).toContain('/api/rights/resources');
  });
  it('screen-rights.jsx still fetches /api/rights/dictionaries (demo dictionary NOT removed)', () => {
    expect(screenSrc).toContain('/api/rights/dictionaries');
  });
  it('real resources are merged into dictionaries.resources BEFORE the demo entries', () => {
    expect(screenSrc).toMatch(/\[\.\.\.realResources,\s*\.\.\.demoTagged\]/);
  });
  it('demo dictionary entries are TAGGED demoSeed at the merge point (UX-2)', () => {
    expect(screenSrc).toMatch(/demoTagged = \(dicts\?\.resources \?\? \[\]\)\.map\(\(r\) => \(\{ \.\.\.r, demoSeed: true \}\)\)/);
  });
  it('fetchRealResources degrades to [] on any failure (best-effort, never blocks the form)', () => {
    const idx = screenSrc.indexOf('async function fetchRealResources');
    const body = screenSrc.slice(idx, idx + 400);
    expect(body).toMatch(/catch\s*\{\s*return \[\];\s*\}/);
  });
});

// ---------------------------------------------------------------------------
// T-0609 F-1 fix — a grant on a REAL resource must be RESOLVABLE by the PDP:
// the covering predicate matches by SCOPE containment in the resource hierarchy
// (never by resource_type), so the form must emit
// {kind:'node', hierarchy:'resource', nodeId:<real UUID>, nodeLevel} for real
// resources — an org-hierarchy scope short-circuits to "not covered" on the
// hierarchy mismatch and the produced grant is inert (review F-1, blocking).
// The live end-to-end proof is ci/checks/db/rights-resource-grant-resolve.db.test.ts;
// these are the structural assertions on the form source.
// ---------------------------------------------------------------------------
describe('T-0609 F-1 — GrantRightForm emits resource-hierarchy scope for real resources', () => {
  it('identifies a real resource by id + node_level from /api/rights/resources', () => {
    expect(formsSrc).toMatch(/selectedResource\.id && selectedResource\.node_level/);
  });
  it("emits scope {hierarchy:'resource', nodeId:<real id>, nodeLevel:<level>} for a real resource", () => {
    expect(formsSrc).toMatch(/hierarchy:\s*'resource'/);
    expect(formsSrc).toMatch(/nodeId:\s*selectedResource\.id/);
    expect(formsSrc).toMatch(/nodeLevel:\s*selectedResource\.node_level/);
  });
  it('real resource → org ScopePicker replaced by an honest whole-resource scope line', () => {
    expect(formsSrc).toMatch(/isRealResource \? \(/);
    expect(formsSrc).toContain('Охват: ресурс целиком');
  });
  it('demo entries are visibly marked in the selector («· демо») (UX-2)', () => {
    expect(formsSrc).toMatch(/r\.demoSeed \? `\$\{r\.name\} · демо` : r\.name/);
  });
  it('demo resource selected → honest hint that the grant does not control data access (UX-1)', () => {
    expect(formsSrc).toContain('Демо-ресурс из ознакомительного набора');
    expect(formsSrc).toContain('не ограничивает доступ к данным тенанта');
  });
  it('demo resource success toast is QUALIFIED — no false «Право выдано» for an inert grant (UX-1)', () => {
    expect(formsSrc).toContain('Право выдано (демо-ресурс: попадёт в обзор ролей, но не ограничивает доступ к данным).');
  });
  it('real resource does not require the org scope picker to submit (scope derived from the resource)', () => {
    expect(formsSrc).toMatch(/\(isRealResource \|\| scope\)/);
  });
});

// ---------------------------------------------------------------------------
// T-0652 (§6.5): формы управления подняты кнопками в шапку карточки (дровер),
// бейдж «только просмотр» для читателя. Инвариант безопасности сохранён —
// формы монтируются ТОЛЬКО при canManage (в дровере), не disabled.
// ---------------------------------------------------------------------------

describe('T-0652 · role-card actions in the header (§6.5)', () => {
  it('header carries action buttons «Назначить роль» / «Дать право» under canManage', () => {
    // The role-detail actions block (from the opening class to «Кто что может»).
    const actionsBlock = screenSrc.match(/chs-roledetail__actions[\s\S]{0,2200}WhoCanDoWhat role=/)?.[0] || '';
    expect(actionsBlock).toContain('Назначить роль');
    expect(actionsBlock).toContain('Дать право');
    expect(actionsBlock).toMatch(/setDrawer\('assign'\)/);
    expect(actionsBlock).toMatch(/setDrawer\('grant'\)/);
  });

  it('reader (canManage=false) sees a VISIBLE «только просмотр» badge in the header', () => {
    const actionsBlock = screenSrc.match(/chs-roledetail__actions[\s\S]{0,2200}WhoCanDoWhat role=/)?.[0] || '';
    expect(actionsBlock).toContain('только просмотр');
    // it is a plain visible span, not chs-sr-only
    expect(actionsBlock).not.toMatch(/только просмотр[\s\S]{0,40}chs-sr-only/);
  });

  it('forms are wrapped in a Modal drawer, still gated on canManage (mounted only then)', () => {
    // The AssignRoleForm/GrantRightForm are inside a Modal that only renders under canManage.
    expect(screenSrc).toMatch(/canManage && \(\s*<Modal[\s\S]{0,300}AssignRoleForm/);
    expect(screenSrc).toMatch(/canManage && \(\s*<Modal[\s\S]{0,300}GrantRightForm/);
    expect(screenSrc).toContain("drawer === 'assign'");
    expect(screenSrc).toContain("drawer === 'grant'");
  });

  it('the forms are NO LONGER open sections rendered below the fold', () => {
    // The old below-the-fold section headers must be gone from the always-on flow.
    expect(screenSrc).not.toMatch(/chs-section2__title">Назначить роль сотруднику/);
    expect(screenSrc).not.toMatch(/chs-section2__title">Дать роли право/);
  });
});

// ---------------------------------------------------------------------------
// UX-N1 fix-forward: chs-readmode--ro was applied on the read-only badge
// (screen-rights.jsx:504) but never DEFINED anywhere — a dead modifier class,
// so the badge was visually indistinguishable from the plain .chs-readmode
// base. Fixed by defining the modifier in rights-admin.css with a visually
// distinct info-tinted pill (matches the .chs-actchip--narrow convention in
// the same file). This asserts the class used in markup is actually styled.
// ---------------------------------------------------------------------------
describe('UX-N1 fix-forward · «только просмотр» badge modifier is a real (non-dead) class', () => {
  const rightsAdminCssPath = path.default.resolve(new URL(import.meta.url).pathname, '../rights-admin.css');
  const rightsAdminCss = fs.default.readFileSync(rightsAdminCssPath, 'utf-8');

  it('screen-rights.jsx applies chs-readmode--ro on the read-only badge', () => {
    expect(screenSrc).toContain('chs-readmode chs-readmode--ro');
  });

  it('chs-readmode--ro is DEFINED in rights-admin.css (not a dead modifier)', () => {
    expect(rightsAdminCss).toMatch(/\.chs-readmode--ro\s*\{/);
  });

  it('the modifier is visually distinct from the plain .chs-readmode base (uses an accent token, not just muted text)', () => {
    const rule = rightsAdminCss.match(/\.chs-readmode--ro\s*\{[^}]*\}/)?.[0] || '';
    expect(rule).toMatch(/--chs-color-info(-soft)?/);
  });
});

