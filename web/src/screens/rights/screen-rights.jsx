/* ============================================================================
   CHOROS — screen-rights.jsx
   ЭКРАН П1R: «Права и доступ». Read-first.
   Модель: право = ГРАНТ {роль · ресурс · операция · охват(scope)}.
   ============================================================================ */

import React, { useState, useEffect } from 'react';
import { ExecutorBadge, ExecGlyph, MonoId, Mono, Button, OpChip, DerivedChip } from '../../components/components.jsx';
import { Icon } from '../../app-shell/icon.jsx';
import { devHeaders } from '../../app-shell/dev-auth.js';

const ROLE_GROUPS = [
  { dept: "Финансы", ids: ["role-fin-control", "role-fin-approve-250", "role-fin-approve-50", "role-fin-recon", "role-fin-escrcv"] },
  { dept: "Клиентский сервис", ids: ["role-cs-l1", "role-cs-l2"] },
  { dept: "Платформа", ids: ["role-plat-ledger"] },
];

const grantCount = (r) => r.grants.reduce((n, g) => n + g.ops.length, 0);
const toolName = (uri) => uri.replace(/^mcp:\/\//, "");

function RoleRailItem({ role, active, onSelect }) {
  return (
    <button className="chs-rolerow" aria-current={active ? "true" : undefined} onClick={() => onSelect(role.id)}>
      <span className="chs-rolerow__main">
        <span className="chs-rolerow__name">{role.name}</span>
        <span className="chs-rolerow__scope">{role.scope}</span>
      </span>
      <span className="chs-rolerow__holders">
        {role.holders.slice(0, 3).map((h, i) => (
          <span key={i} className={`chs-rolerow__h chs-rolerow__h--${h.type}`} title={h.name}><ExecGlyph type={h.type} size={8} /></span>
        ))}
      </span>
      <span className="chs-rolerow__count">{grantCount(role)}</span>
    </button>
  );
}

function RightsScreen({ initialRole }) {
  const [roles, setRoles] = useState(null);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState(initialRole || null);

  const load = async () => {
    try {
      const res = await fetch('/api/rights', {
        headers: devHeaders(),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setRoles(data.roles);
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load roles');
      setRoles(null);
    }
  };

  // Load roles on mount
  useEffect(() => {
    load();
  }, []);

  // Update selected role when roles load or change
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
      <div className="chs-rights" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <div style={{ textAlign: 'center' }}>
          <p style={{ marginBottom: '1rem', color: 'var(--chs-color-text-error, #d32f2f)' }}>
            Ошибка загрузки ролей: {error}
          </p>
          <Button onClick={load}>Повторить</Button>
        </div>
      </div>
    );
  }

  if (roles === null) {
    return (
      <div className="chs-rights" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <p>Загрузка ролей…</p>
      </div>
    );
  }

  if (roles.length === 0) {
    return (
      <div className="chs-rights" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <p>Нет ролей</p>
      </div>
    );
  }

  const role = roles.find(r => r.id === sel) || roles[0];
  const tools = [...new Set(role.grants.map((g) => g.uri))];

  return (
    <div className="chs-rights">
      {/* Левый рейл — роли */}
      <div className="chs-rights__rail">
        <div className="chs-rights__railhead">
          <span>Роли</span>
          <span className="chs-rights__railcount">{roles.length}</span>
        </div>
        <div className="chs-rights__search"><Icon name="search" /><span>Поиск роли</span></div>
        <div className="chs-rights__roles">
          {ROLE_GROUPS.map((grp) => (
            <div className="chs-rights__rgroup" key={grp.dept}>
              <div className="chs-rights__rgrouplabel">{grp.dept}</div>
              {grp.ids.map((id) => {
                const roleItem = roles.find(r => r.id === id);
                return roleItem ? (
                  <RoleRailItem key={id} role={roleItem} active={sel === id} onSelect={setSel} />
                ) : null;
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Правая часть — матрица грантов роли */}
      <div className="chs-rights__main">
        <div className="chs-roledetail">
          {/* Заголовок роли */}
          <div className="chs-roledetail__head">
            <div className="chs-roledetail__titlewrap">
              <h2 className="chs-roledetail__title">{role.name}</h2>
              <div className="chs-roledetail__sub">
                <span className="chs-scopepill"><span className="chs-scopepill__glyph" />{role.scope}</span>
                <span className="chs-crumbs__sep">/</span>
                <Mono style={{ color: "var(--chs-color-text-faint)" }}>{role.id}</Mono>
              </div>
            </div>
            <div className="chs-roledetail__actions">
              <span className="chs-readmode"><span className="chs-readmode__dot" />только чтение</span>
              <Button variant="secondary" size="sm">Запросить изменение</Button>
            </div>
          </div>

          {/* Носители роли */}
          <div className="chs-roledetail__holders">
            <span className="chs-roledetail__hk">Назначена</span>
            <div className="chs-roledetail__hlist">
              {role.holders.map((h, i) => <ExecutorBadge key={i} type={h.type} name={h.name} />)}
            </div>
            <span className="chs-roledetail__hmeta">
              <Mono>{grantCount(role)}</Mono> грантов · <Mono>{role.grants.length}</Mono> ресурсов · <Mono>{tools.length}</Mono> инструментов
            </span>
          </div>

          {/* Матрица грантов — атом {ресурс · операция · охват} */}
          <section className="chs-section2">
            <div className="chs-section2__head">
              <h3 className="chs-section2__title">Гранты роли</h3>
              <span className="chs-section2__aux">атом: {"{"} роль · ресурс · операция · охват {"}"}</span>
            </div>
            <div className="chs-grants">
              <div className="chs-grants__colhead">
                <span>Ресурс</span><span>Операции</span><span>Охват (scope)</span>
              </div>
              {role.grants.map((g) => (
                <div className="chs-grant" key={g.uri}>
                  <div className="chs-grant__res">
                    <span className="chs-grant__resname">{g.res}</span>
                    <span className="chs-grant__uri">{g.uri}</span>
                  </div>
                  <div className="chs-grant__ops">
                    {g.ops.map((op) => <OpChip key={op} op={op} />)}
                  </div>
                  <div className="chs-grant__scope">{g.scope}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Производное от грантов */}
          <section className="chs-section2">
            <div className="chs-section2__head">
              <h3 className="chs-section2__title">Производное от грантов</h3>
              <span className="chs-section2__aux">вычисляется автоматически · не редактируется</span>
            </div>
            <div className="chs-derivedwrap">
              <div className="chs-derivedcol">
                <div className="chs-derivedcol__label">Инструменты (MCP)</div>
                <div className="chs-derivedcol__items">
                  {tools.map((uri) => <DerivedChip key={uri} kind="tool">{toolName(uri)}</DerivedChip>)}
                </div>
                <div className="chs-derivedcol__note">↳ из грантов с операцией read / write / exec</div>
              </div>
              <div className="chs-derivedcol">
                <div className="chs-derivedcol__label">Видимые поля форм</div>
                <div className="chs-derivedcol__items">
                  {role.fields.length === 0
                    ? <span className="chs-derivedcol__empty">Поля форм не применяются — детерминированный сервис</span>
                    : role.fields.map((f) => (
                        <DerivedChip key={f.name} kind="field" state={f.a}>
                          {f.name}<span className="chs-derived__a">{f.a === "hidden" ? "скрыто" : f.a}</span>
                        </DerivedChip>
                      ))}
                </div>
                <div className="chs-derivedcol__note">↳ поле без гранта скрывается из формы</div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export default RightsScreen;
