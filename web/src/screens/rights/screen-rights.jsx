/* ============================================================================
   CHOROS — screen-rights.jsx
   ЭКРАН П1R: «Права и доступ». Read-first.
   Модель: право = ГРАНТ {роль · ресурс · операция · охват(scope)}.
   ============================================================================ */

import React, { useState } from 'react';
import { ExecutorBadge, ExecGlyph, MonoId, Mono, Button, OpChip, DerivedChip } from '../../components/components.jsx';
import { Icon } from '../../app-shell/icon.jsx';

const ROLES = [
  {
    id: "role-fin-control", name: "Контролёр расчётов", dept: "Финансы", scope: "Финансы",
    holders: [{ type: "human", name: "А. Кравцова" }],
    grants: [
      { res: "Реестр счетов", uri: "mcp://ledger.invoices", ops: ["read", "write"], scope: "Финансы" },
      { res: "Сверка платежей", uri: "mcp://ledger.recon", ops: ["read", "write"], scope: "Финансы" },
      { res: "Контрагенты (KYC)", uri: "mcp://counterparty.kyc", ops: ["read", "write"], scope: "Финансы" },
      { res: "Платёжный шлюз", uri: "mcp://payments.initiate", ops: ["exec"], scope: "≤ ₽250 000" },
    ],
    fields: [
      { name: "Сумма счёта", a: "read" }, { name: "Контрагент", a: "write" },
      { name: "Реквизиты", a: "write" }, { name: "Лимит платежа", a: "read" },
    ],
  },
  {
    id: "role-fin-approve-250", name: "Согласование ≤ ₽250 000", dept: "Финансы", scope: "Финансы · Согласование счёта",
    holders: [{ type: "human", name: "А. Кравцова" }, { type: "human", name: "Е. Ларина" }],
    grants: [
      { res: "Реестр счетов", uri: "mcp://ledger.invoices", ops: ["read"], scope: "Финансы · Согласование счёта" },
      { res: "Платёжный шлюз", uri: "mcp://payments.initiate", ops: ["exec"], scope: "≤ ₽250 000" },
    ],
    fields: [
      { name: "Сумма счёта", a: "read" }, { name: "Решение", a: "write" }, { name: "Возврат средств", a: "hidden" },
    ],
  },
  {
    id: "role-fin-approve-50", name: "Согласующий счетов ≤ ₽50 000", dept: "Финансы", scope: "Финансы · Согласование счёта",
    holders: [{ type: "agent", name: "Счёт-агент" }],
    grants: [
      { res: "Реестр счетов", uri: "mcp://ledger.invoices", ops: ["read", "write"], scope: "Финансы · Согласование счёта" },
      { res: "Справочник договоров", uri: "mcp://contracts.lookup", ops: ["read"], scope: "Финансы" },
      { res: "OCR-распознавание", uri: "mcp://ocr.extract", ops: ["exec"], scope: "Финансы · Согласование счёта" },
      { res: "Платёжный шлюз", uri: "mcp://payments.initiate", ops: ["exec"], scope: "≤ ₽50 000" },
    ],
    fields: [
      { name: "Сумма счёта", a: "read" }, { name: "Контрагент", a: "read" }, { name: "Договор", a: "read" },
      { name: "Реквизиты", a: "write" }, { name: "Возврат средств", a: "hidden" },
    ],
  },
  {
    id: "role-fin-recon", name: "Сверка платежей", dept: "Финансы", scope: "Финансы · Закрытие месяца",
    holders: [{ type: "agent", name: "Счёт-агент" }, { type: "human", name: "А. Кравцова" }],
    grants: [
      { res: "Реестр счетов", uri: "mcp://ledger.invoices", ops: ["read"], scope: "Финансы" },
      { res: "Сверка платежей", uri: "mcp://ledger.recon", ops: ["read", "write"], scope: "Финансы · Закрытие месяца" },
      { res: "Шина событий", uri: "mcp://bus.publish", ops: ["exec"], scope: "Финансы" },
    ],
    fields: [
      { name: "Период", a: "read" }, { name: "Расхождение", a: "write" }, { name: "Комментарий", a: "write" },
    ],
  },
  {
    id: "role-fin-escrcv", name: "Приёмник эскалаций агентов", dept: "Финансы", scope: "Финансы",
    holders: [{ type: "human", name: "А. Кравцова" }],
    grants: [
      { res: "Очередь эскалаций", uri: "mcp://escalations.queue", ops: ["read", "write"], scope: "Финансы" },
      { res: "Журнал агентов", uri: "mcp://agents.audit", ops: ["read"], scope: "Финансы" },
    ],
    fields: [
      { name: "Инцидент", a: "read" }, { name: "Резолюция", a: "write" },
    ],
  },
  {
    id: "role-cs-l1", name: "Линия поддержки L1", dept: "Клиентский сервис", scope: "Клиентский сервис · Поддержка",
    holders: [{ type: "agent", name: "Триаж-агент" }, { type: "human", name: "К. Орлов" }, { type: "human", name: "Н. Савина" }],
    grants: [
      { res: "Очередь обращений", uri: "mcp://support.queue", ops: ["read", "write"], scope: "Поддержка" },
      { res: "База знаний", uri: "mcp://kb.search", ops: ["read"], scope: "—" },
      { res: "CRM клиента", uri: "mcp://crm.customer", ops: ["read"], scope: "Поддержка" },
    ],
    fields: [
      { name: "Тема", a: "read" }, { name: "Категория", a: "write" }, { name: "Ответ", a: "write" },
      { name: "Возврат средств", a: "hidden" },
    ],
  },
  {
    id: "role-cs-l2", name: "Эскалации L2", dept: "Клиентский сервис", scope: "Клиентский сервис · Поддержка",
    holders: [{ type: "human", name: "И. Петров" }],
    grants: [
      { res: "Очередь обращений", uri: "mcp://support.queue", ops: ["read", "write"], scope: "Поддержка" },
      { res: "CRM клиента", uri: "mcp://crm.customer", ops: ["read", "write"], scope: "Поддержка" },
      { res: "Возвраты средств", uri: "mcp://payments.refund", ops: ["exec"], scope: "≤ ₽30 000" },
    ],
    fields: [
      { name: "Спор", a: "read" }, { name: "Возврат средств", a: "write" }, { name: "Решение", a: "write" },
    ],
  },
  {
    id: "role-plat-ledger", name: "Коннектор реестра", dept: "Платформа", scope: "Платформа",
    holders: [{ type: "service", name: "ledger-sync" }],
    grants: [
      { res: "Реестр счетов", uri: "mcp://ledger.invoices", ops: ["read", "write"], scope: "Платформа" },
      { res: "Шина событий", uri: "mcp://bus.publish", ops: ["exec"], scope: "Платформа" },
    ],
    fields: [],
  },
];

const ROLE_GROUPS = [
  { dept: "Финансы", ids: ["role-fin-control", "role-fin-approve-250", "role-fin-approve-50", "role-fin-recon", "role-fin-escrcv"] },
  { dept: "Клиентский сервис", ids: ["role-cs-l1", "role-cs-l2"] },
  { dept: "Платформа", ids: ["role-plat-ledger"] },
];

const byId = (id) => ROLES.find((r) => r.id === id);
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
  const [sel, setSel] = useState(() => (byId(initialRole) ? initialRole : ROLES[0].id));
  // переключение карточки исполнителя → роль
  React.useEffect(() => { if (byId(initialRole)) setSel(initialRole); }, [initialRole]);
  const role = byId(sel) || ROLES[0];
  const tools = [...new Set(role.grants.map((g) => g.uri))];

  return (
    <div className="chs-rights">
      {/* Левый рейл — роли */}
      <div className="chs-rights__rail">
        <div className="chs-rights__railhead">
          <span>Роли</span>
          <span className="chs-rights__railcount">{ROLES.length}</span>
        </div>
        <div className="chs-rights__search"><Icon name="search" /><span>Поиск роли</span></div>
        <div className="chs-rights__roles">
          {ROLE_GROUPS.map((grp) => (
            <div className="chs-rights__rgroup" key={grp.dept}>
              <div className="chs-rights__rgrouplabel">{grp.dept}</div>
              {grp.ids.map((id) => (
                <RoleRailItem key={id} role={byId(id)} active={sel === id} onSelect={setSel} />
              ))}
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
