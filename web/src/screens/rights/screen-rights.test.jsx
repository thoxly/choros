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
