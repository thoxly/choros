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
import {
  AssignRoleForm, GrantRightForm, RevokeAssignmentButton, RevokeGrantButton, PendingBadge,
} from './ra-overview-forms.jsx';

const grantCount = (r) => r.grants.length;

function RoleRailItem({ role, active, onSelect }) {
  return (
    <button className="chs-rolerow" aria-current={active ? "true" : undefined} onClick={() => onSelect(role.id)}>
      <span className="chs-rolerow__main">
        <span className="chs-rolerow__name">{role.name || role.slug}</span>
        <span className="chs-rolerow__scope">{role.slug}</span>
      </span>
      <span className="chs-rolerow__holders">
        {role.assignments.slice(0, 3).map((a) => (
          <span key={a.id} className={`chs-rolerow__h chs-rolerow__h--${a.employee_kind}`} title={a.employee_display || a.employee_slug}>
            <ExecutorBadge type={a.employee_kind} name="" bare showLabel={false} />
          </span>
        ))}
      </span>
      <span className="chs-rolerow__count">{grantCount(role)}</span>
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
// "Кто что может" — секция роль-детали (FR-6). Показывает ДЕЙСТВУЮЩИЕ
// assignments/grants (никогда pending — FR-5/AC-8) + отдельный pending-блок.
// ---------------------------------------------------------------------------

function WhoCanDoWhat({ role, canManage, onChanged }) {
  return (
    <section className="chs-section2">
      <div className="chs-section2__head">
        <h3 className="chs-section2__title">Кто что может</h3>
        <span className="chs-section2__aux">держатели роли · выданные права</span>
      </div>

      <div className="chs-ov-holders">
        {role.assignments.length === 0 ? (
          <span className="chs-derivedcol__empty">Роль пока никому не назначена</span>
        ) : (
          role.assignments.map((a) => (
            <div className="chs-ov-holder" key={a.id}>
              <ExecutorBadge type={a.employee_kind} name={a.employee_display || a.employee_slug || a.employee_id} />
              {canManage && <RevokeAssignmentButton id={a.id} onDone={onChanged} />}
            </div>
          ))
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
              <div className="chs-grant__scope">{JSON.stringify(g.scope)}</div>
              {canManage && <RevokeGrantButton id={g.id} onDone={onChanged} />}
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
      fetchDictionaries().then(setDictionaries);
      fetchEmployees().then(setEmployees);
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

  if (roles.length === 0) {
    return (
      <div className="chs-rights">
        <EmptyState
          title="Нет ролей"
          description={
            state.scope === 'self'
              ? 'У вас пока нет ни одной назначенной роли.'
              : 'В этом тенанте ещё не определено ни одной роли доступа.'
          }
        />
      </div>
    );
  }

  const role = roles.find(r => r.id === sel) || roles[0];
  const tools = [...new Set(role.grants.map((g) => g.resource_type))];
  const canManage = Boolean(state.can_manage);

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
          <WhoCanDoWhat role={role} canManage={canManage} onChanged={load} />

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
                onDone={load}
              />
            </section>
          )}

          {canManage && (
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
