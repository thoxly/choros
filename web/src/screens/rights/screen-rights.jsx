/* ============================================================================
   CHOROS — screen-rights.jsx  (T-0572: живой источник + «кто что может» + формы)
   ЭКРАН П1R: «Доступ». Обзор ролей тенанта + выдача/отзыв роли и гранта.
   Модель: право = ГРАНТ {роль · ресурс · операция · охват(scope)}.

   FR-1 (AC-1/AC-2/AC-3): источник — GET /api/rights/tenant-state (честное
   tenant-состояние из choros.role/role_assignment/"grant"), НЕ /api/rights
   (demo-pack/RIGHTS_SEED). Пустой тенант — честный EmptyState, не demo.

   FR-6 (AC-8): «Кто что может» — секция роль-детали. Админ-взгляд видит
   действующие assignments/grants роли; self-взгляд (can_manage:false) видит
   только свои роли, read-only, без форм записи.

   FR-2/FR-3/FR-7 (AC-4/5/6/9): формы выдачи/отзыва роли+гранта монтируются
   ТОЛЬКО когда can_manage===true — отсутствуют в DOM иначе (не disabled).

   FR-5 (AC-7/AC-8): pending (semi-confirmed) — ОТДЕЛЬНАЯ секция роли,
   никогда не смешивается с действующими assignments/grants.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { ExecutorBadge, Button, OpChip, DerivedChip, LoadingState, ErrorState, EmptyState } from '../../components/components.jsx';
import { authHeaders } from '../../app-shell/dev-auth.js';
import { getActiveTenantId } from '../../app-shell/active-tenant.js';
import { useNavigate } from 'react-router-dom';
import { ScopeToken } from './ra-data.jsx';
import {
  AssignRoleForm, GrantRightForm, RevokeAssignmentButton, RevokeGrantButton, PendingBadge,
} from './ra-overview-forms.jsx';

// T-0608 (пункт д, живой факт приёмки): the rail showed grantCount() (число
// ГРАНТОВ роли) in the position a user reads as "сколько держателей" — «4» у
// Конфигуратора (4 гранта, 2 держателя) и «0» у Снабженца (0 грантов — грант
// живёт на роли отдельно от holder-состава — при 3 держателях). Renamed +
// re-pointed at the HONEST count of DISTINCT PEOPLE holding the role (see
// holderCount / dedupAssignments split below), not grant rows.
//
// holderCount answers "сколько ЧЕЛОВЕК держит роль" → distinct employee_id
// (a person with two differently-scoped assignments is ONE person). This is a
// DIFFERENT question from "сколько НАЗНАЧЕНИЙ" and correctly dedups by person.
export const holderCount = (r) =>
  new Set((r.assignments || []).map((a) => a.employee_id)).size;

// T-0608 (F-1 fix, review+ux blocking): the holders SECTION and Revoke key on
// the FULL assignment identity, NOT employee_id alone.
//
// migrations/020_role_assignment.sql:29-32 documents NO UNIQUE(employee_id,
// role_id): the same (employee, role) LEGITIMATELY coexists across different
// org_scope/window ("approver in fin until Q3, in cs from Q4"). Those are
// SEPARATE grants — collapsing them by employee_id would (1) hide the scopes
// and (2) make one "Отозвать" click revoke MORE than the admin intends. Only
// a TRUE duplicate — identical employee + org_scope + validity window — is
// collapsed (and revoked together, correctly). Different scopes render as
// SEPARATE holder rows, each with its OWN Revoke targeting only its ids.
function assignmentIdentityKey(a) {
  // Stable, order-independent serialization of org_scope + window. JSON.stringify
  // of the raw scope object is used verbatim — two assignments are "the same
  // scope" only when the server returned byte-identical scope jsonb (it does not
  // reorder object keys within a single response, so equal scopes serialize
  // equally); a false NEGATIVE (treating equal-but-reordered scopes as distinct)
  // only shows an extra row — it NEVER over-collapses, so it never causes the
  // blocking over-revoke. window: valid_from/valid_until (null = open-ended).
  let scopeStr;
  try {
    scopeStr = JSON.stringify(a.org_scope ?? null);
  } catch {
    scopeStr = String(a.org_scope);
  }
  return `${a.employee_id}::${scopeStr}::${a.valid_from ?? ''}::${a.valid_until ?? ''}`;
}

// Collapse ONLY true duplicates (identical employee + scope + window); keep
// differently-scoped assignments of the same person as separate entries. Each
// returned entry carries its own `ids` (the assignment ids of the collapsed
// TRUE duplicates only) so Revoke clears exactly that scope, never others.
export function dedupAssignments(assignments) {
  const byIdentity = new Map();
  for (const a of (assignments || [])) {
    const key = assignmentIdentityKey(a);
    const existing = byIdentity.get(key);
    if (existing) {
      existing.ids.push(a.id);
    } else {
      byIdentity.set(key, { ...a, ids: [a.id] });
    }
  }
  return [...byIdentity.values()];
}

function RoleRailItem({ role, active, onSelect }) {
  // Rail badges = distinct PEOPLE (one glyph per person, even with multiple
  // scopes) — the rail is a compact "who holds this" glance, not the authoritative
  // per-scope list (that lives in the «Кто что может» section below).
  const seen = new Set();
  const people = [];
  for (const a of (role.assignments || [])) {
    if (seen.has(a.employee_id)) continue;
    seen.add(a.employee_id);
    people.push(a);
  }
  return (
    <button className="chs-rolerow" aria-current={active ? "true" : undefined} onClick={() => onSelect(role.id)}>
      <span className="chs-rolerow__main">
        <span className="chs-rolerow__name">{role.name || role.slug}</span>
        <span className="chs-rolerow__scope">{role.slug}</span>
      </span>
      <span className="chs-rolerow__holders">
        {people.slice(0, 3).map((a) => (
          <span key={a.employee_id} className={`chs-rolerow__h chs-rolerow__h--${a.employee_kind}`} title={a.employee_display || a.employee_slug}>
            <ExecutorBadge type={a.employee_kind} name="" bare showLabel={false} />
          </span>
        ))}
      </span>
      <span className="chs-rolerow__count">{holderCount(role)}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Data fetching — GET /api/rights/tenant-state (FR-1). Tenant is resolved from
// the caller's identity server-side — this fetch takes no tenant/employee
// parameter (AC-10: nothing here to spoof).
// ---------------------------------------------------------------------------

async function fetchTenantState() {
  const res = await fetch('/api/rights/tenant-state', { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchDictionaries() {
  const res = await fetch('/api/rights/dictionaries', { headers: authHeaders() });
  if (!res.ok) return null;
  return res.json();
}

async function fetchEmployees() {
  try {
    const res = await fetch(`/api/org/tenant-state?tenant_id=${getActiveTenantId()}`, { headers: authHeaders() });
    if (!res.ok) return [];
    const data = await res.json();
    return data.employees ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// ScopeSummary — человекочитаемый охват гранта (UX_REVIEW F-2, principles §3:
// пользователь видит продукт, не разработку — сырой JSON недопустим).
//   node → «Узел: <label из dictionaries.orgTree>» (fallback «Узел оргструктуры»)
//   node-сентинел default-open гранта (READ-PDP) → «Весь тенант»
//   tags → чипы тегов (label из dictionaries.scopeTags, fallback — сам тег)
//   set → перечисление членов; пустой set / отсутствие охвата → «Весь тенант»
// self-взгляд (dictionaries не загружены) деградирует в человеческую форму
// kind без резолва label — но никогда не в raw JSON.
// ---------------------------------------------------------------------------

// Платформенный сентинел-узел default-open READ-гранта (display-копия литерала
// RESOURCE_ROOT_NODE_ID из src/core/read-visibility.ts; дрейф безопасен —
// несовпадение деградирует в «Узел оргструктуры», не в ложь).
const RESOURCE_ROOT_SENTINEL = '00000000-0000-0000-0000-0000000000r0';

function ScopeSummary({ scope, dictionaries }) {
  if (!scope || typeof scope !== 'object') {
    return <span>Весь тенант</span>;
  }
  if (scope.kind === 'node') {
    if (scope.nodeId === RESOURCE_ROOT_SENTINEL) {
      return <span>Весь тенант</span>;
    }
    const node = (dictionaries?.orgTree || []).find((n) => n.id === scope.nodeId);
    return <span>{node ? `Узел: ${node.label}` : 'Узел оргструктуры'}</span>;
  }
  if (scope.kind === 'tags') {
    const tags = scope.tags || [];
    if (tags.length === 0) {
      return <span>Весь тенант</span>;
    }
    const labelById = Object.fromEntries((dictionaries?.scopeTags || []).map((t) => [t.id, t.label]));
    return (
      <span className="chs-ov-scopesum">
        {tags.map((t) => <ScopeToken key={t} kind="tag">{labelById[t] || t}</ScopeToken>)}
      </span>
    );
  }
  if (scope.kind === 'interval') {
    return <span>{`Диапазон: ${scope.axis} ${scope.lo}–${scope.hi}`}</span>;
  }
  if (scope.kind === 'set') {
    const members = scope.members || [];
    if (members.length === 0) {
      return <span>Весь тенант</span>;
    }
    return (
      <span className="chs-ov-scopesum">
        {members.map((m, i) => <ScopeSummary key={i} scope={m} dictionaries={dictionaries} />)}
      </span>
    );
  }
  return <span>Особый охват</span>;
}

// T-0608 (F-1 fix): plain-STRING mirror of ScopeSummary — for the ConfirmDialog
// message (a string prop, not JSX). So «Отозвать» names the exact scope the
// admin is revoking, never a bare name that hides which of several scopes goes.
// Kept in lockstep with ScopeSummary's branches; degrades to «особый охват»,
// never to raw JSON.
export function scopeText(scope, dictionaries) {
  if (!scope || typeof scope !== 'object') return 'весь тенант';
  if (scope.kind === 'node') {
    if (scope.nodeId === RESOURCE_ROOT_SENTINEL) return 'весь тенант';
    const node = (dictionaries?.orgTree || []).find((n) => n.id === scope.nodeId);
    return node ? `узел: ${node.label}` : 'узел оргструктуры';
  }
  if (scope.kind === 'tags') {
    const tags = scope.tags || [];
    if (tags.length === 0) return 'весь тенант';
    const labelById = Object.fromEntries((dictionaries?.scopeTags || []).map((t) => [t.id, t.label]));
    return tags.map((t) => labelById[t] || t).join(', ');
  }
  if (scope.kind === 'interval') return `диапазон ${scope.axis} ${scope.lo}–${scope.hi}`;
  if (scope.kind === 'set') {
    const members = scope.members || [];
    if (members.length === 0) return 'весь тенант';
    return members.map((m) => scopeText(m, dictionaries)).join('; ');
  }
  return 'особый охват';
}

// ---------------------------------------------------------------------------
// "Кто что может" — секция роль-детали (FR-6). Показывает ДЕЙСТВУЮЩИЕ
// assignments/grants (никогда pending — FR-5/AC-8) + отдельный pending-блок.
// ---------------------------------------------------------------------------

function WhoCanDoWhat({ role, canManage, dictionaries, onChanged }) {
  // T-0608 (F-1 fix): ONE holder row per DISTINCT ASSIGNMENT (employee + scope
  // + window), NOT per employee. dedupAssignments collapses only TRUE duplicates
  // (identical scope+window) — a person назначенный на роль с ДВУМЯ разными
  // охватами (отдел А / отдел Б) shows as TWO rows, each with its OWN scope
  // label and its OWN «Отозвать» (targeting only that scope's ids). Revoking
  // отдел-А never silently touches отдел-Б. Rows carry .ids = the ids of the
  // TRUE duplicates only (identical scope), so «Отозвать» clears exactly one
  // scope and, if the same scope was accidentally assigned twice, both those
  // identical rows together (correct).
  const holderAssignments = dedupAssignments(role.assignments);
  return (
    <section className="chs-section2">
      <div className="chs-section2__head">
        <h3 className="chs-section2__title">Кто что может</h3>
        <span className="chs-section2__aux">держатели роли · выданные права</span>
      </div>

      <div className="chs-ov-holders">
        {holderAssignments.length === 0 ? (
          <span className="chs-derivedcol__empty">Роль пока никому не назначена</span>
        ) : (
          holderAssignments.map((a) => {
            const name = a.employee_display || a.employee_slug || a.employee_id;
            const scopeLabel = scopeText(a.org_scope, dictionaries);
            return (
              <div className="chs-ov-holder" key={assignmentIdentityKey(a)}>
                <ExecutorBadge type={a.employee_kind} name={name} />
                {/* T-0608 (F-1): show the assignment's OWN scope next to the
                    holder so different scopes are visibly distinct, not hidden. */}
                <span className="chs-ov-holder__scope"><ScopeSummary scope={a.org_scope} dictionaries={dictionaries} /></span>
                {canManage && (
                  <RevokeAssignmentButton
                    ids={a.ids}
                    subjectLabel={a.employee_display || a.employee_slug || ''}
                    scopeLabel={scopeLabel}
                    onDone={onChanged}
                  />
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="chs-grants">
        <div className={`chs-grants__colhead ${canManage ? 'chs-grants__colhead--actions' : ''}`}>
          <span>Ресурс</span><span>Операция</span><span>Охват</span>{canManage && <span>Действие</span>}
        </div>
        {role.grants.length === 0 ? (
          <span className="chs-derivedcol__empty">Роль пока не держит ни одного гранта</span>
        ) : (
          role.grants.map((g) => (
            <div className={`chs-grant ${canManage ? 'chs-grant--actions' : ''}`} key={g.id}>
              <div className="chs-grant__res"><span className="chs-grant__resname">{g.resource_type}</span></div>
              <div className="chs-grant__ops"><OpChip op={g.operation} /></div>
              <div className="chs-grant__scope"><ScopeSummary scope={g.scope} dictionaries={dictionaries} /></div>
              {canManage && (
                <RevokeGrantButton
                  id={g.id}
                  subjectLabel={`${g.resource_type} · ${g.operation}`}
                  onDone={onChanged}
                />
              )}
            </div>
          ))
        )}
      </div>

      {(role.pending.assignments.length > 0 || role.pending.grants.length > 0) && (
        <div className="chs-ov-pending">
          <div className="chs-section2__aux">Ждут второго подтверждения</div>
          {role.pending.assignments.map((a) => (
            <div className="chs-ov-pending__row" key={a.id}>
              <PendingBadge />
              <span>{a.employee_display || 'Назначение'}</span>
            </div>
          ))}
          {role.pending.grants.map((g) => (
            <div className="chs-ov-pending__row" key={g.id}>
              <PendingBadge />
              <span>{g.description}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

function RightsScreen({ initialRole }) {
  const [state, setState] = useState(null); // TenantStateResponse | null
  const [error, setError] = useState(null);
  const [sel, setSel] = useState(initialRole || null);
  const [dictionaries, setDictionaries] = useState(null);
  const [employees, setEmployees] = useState([]);
  // UX_REVIEW F-4: пока справочники грузятся, формы показывают LoadingState —
  // «ещё грузится» отличимо от «справочник пуст/недоступен».
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const data = await fetchTenantState();
      setState(data);
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load roles');
      setState(null);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (state?.can_manage) {
      setSourcesLoading(true);
      Promise.all([
        fetchDictionaries().then(setDictionaries),
        fetchEmployees().then(setEmployees),
      ]).finally(() => setSourcesLoading(false));
    }
  }, [state?.can_manage]);

  const roles = state?.roles ?? null;

  useEffect(() => {
    if (roles) {
      if (!sel || !roles.find(r => r.id === sel)) {
        setSel(roles[0]?.id ?? null);
      }
    }
  }, [roles]);

  // Render: error → loading → empty → content
  if (error) {
    return (
      <div className="chs-rights">
        <ErrorState message={`Не удалось загрузить роли: ${error}`} onRetry={load} />
      </div>
    );
  }

  if (state === null) {
    return (
      <div className="chs-rights">
        <LoadingState label="Загрузка ролей…" />
      </div>
    );
  }

  const canManage = Boolean(state.can_manage);

  if (roles.length === 0) {
    // UX_REVIEW F-1: пустой тенант различает can_manage. Админ получает
    // Primary action (first-use anatomy) — путь к созданию первой роли на
    // /rights/editor; обычный пользователь — честное разъяснение без CTA.
    return (
      <div className="chs-rights">
        {canManage ? (
          <EmptyState
            title="Пока нет ролей"
            description="Создайте первую роль доступа, чтобы назначать её сотрудникам."
            action={
              <Button variant="primary" size="sm" onClick={() => navigate('/rights/editor')}>
                Открыть «Каталог ролей»
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="Нет ролей"
            description="У вас пока нет ни одной назначенной роли."
          />
        )}
      </div>
    );
  }

  const role = roles.find(r => r.id === sel) || roles[0];
  const tools = [...new Set(role.grants.map((g) => g.resource_type))];
  // UX_REVIEW F-5: pending виден и в self-взгляде (свои «ждёт подтверждения»)
  // — одноклик-путь к инбоксу /rights/criticality не должен зависеть от
  // canManage, когда есть pending.
  const rolePendingCount = role.pending.assignments.length + role.pending.grants.length;

  return (
    <div className="chs-rights">
      {/* Левый рейл — роли */}
      <div className="chs-rights__rail">
        <div className="chs-rights__railhead">
          <span>{state.scope === 'self' ? 'Мои роли' : 'Роли'}</span>
          <span className="chs-rights__railcount">{roles.length}</span>
        </div>
        <div className="chs-rights__roles">
          {roles.map((r) => (
            <RoleRailItem key={r.id} role={r} active={sel === r.id} onSelect={setSel} />
          ))}
        </div>
      </div>

      {/* Правая часть — детали роли */}
      <div className="chs-rights__main">
        <div className="chs-roledetail">
          {/* Заголовок роли */}
          <div className="chs-roledetail__head">
            <div className="chs-roledetail__titlewrap">
              <h2 className="chs-roledetail__title">{role.name || role.slug}</h2>
              <div className="chs-roledetail__sub">
                <span className="chs-scopepill"><span className="chs-scopepill__glyph" />{role.slug}</span>
              </div>
            </div>
            <div className="chs-roledetail__actions">
              <span className="chs-readmode"><span className="chs-readmode__dot" />{canManage ? 'управление' : 'только чтение'}</span>
              {!canManage && (
                <Button variant="secondary" size="sm" disabled title="Запрос изменения роли — доступно только владельцу/админу">Запросить изменение</Button>
              )}
            </div>
          </div>

          {/* «Кто что может» — FR-6 */}
          <WhoCanDoWhat role={role} canManage={canManage} dictionaries={dictionaries} onChanged={load} />

          {/* Производное от грантов */}
          <section className="chs-section2">
            <div className="chs-section2__head">
              <h3 className="chs-section2__title">Производное от грантов</h3>
              <span className="chs-section2__aux">вычисляется автоматически · не редактируется</span>
            </div>
            <div className="chs-derivedwrap">
              <div className="chs-derivedcol">
                <div className="chs-derivedcol__label">Ресурсы</div>
                <div className="chs-derivedcol__items">
                  {tools.length === 0
                    ? <span className="chs-derivedcol__empty">Гранты роли отсутствуют</span>
                    : tools.map((uri) => <DerivedChip key={uri} kind="tool">{uri}</DerivedChip>)}
                </div>
                <div className="chs-derivedcol__note">↳ из действующих грантов роли</div>
              </div>
            </div>
          </section>

          {/* Формы выдачи — FR-2/FR-3/FR-7: монтируются ТОЛЬКО при canManage.
              При canManage===false компонент отсутствует в DOM (не disabled). */}
          {canManage && (
            <section className="chs-section2">
              <div className="chs-section2__head">
                <h3 className="chs-section2__title">Назначить роль сотруднику</h3>
              </div>
              <AssignRoleForm
                roles={roles}
                employees={employees}
                dictionaries={dictionaries}
                sourcesLoading={sourcesLoading}
                onDone={load}
              />
            </section>
          )}

          {canManage && (
            <section className="chs-section2">
              <div className="chs-section2__head">
                <h3 className="chs-section2__title">Дать роли право</h3>
              </div>
              <GrantRightForm
                roles={roles}
                dictionaries={dictionaries}
                sourcesLoading={sourcesLoading}
                onDone={load}
              />
            </section>
          )}

          {/* UX_REVIEW F-5: подсказка-путь к инбоксу подтверждений видна и
              не-admin наблюдателю СВОЕГО pending (rolePendingCount > 0) —
              не только под canManage. */}
          {(canManage || rolePendingCount > 0) && (
            <div className="chs-ov-inbox-hint">
              <span className="chs-section2__aux">Критичные изменения требуют второго подтверждения.</span>
              <Button variant="ghost" size="sm" onClick={() => navigate('/rights/criticality')}>
                Открыть инбокс «Критичность»
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default RightsScreen;
