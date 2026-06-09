/* ============================================================================
   CHOROS — screen-org.jsx
   ЭКРАН 1: дерево «подразделение → должность → сотрудник».
   Сотрудник = человек ИЛИ агент (одна сущность employee + маркер типа).
   Справа — КАРТОЧКА ИСПОЛНИТЕЛЯ (read):
     • роли как НАЗНАЧЕНИЯ (роль · орг-охват · срок) — не тумблеры инструментов;
     • агент: своя LLM (BYO — клиент хостит) + бюджет с РЕЗЕРВИРОВАНИЕМ
       (две крыши: на инстанс процесса и на агента) + порог автономии/эскалация;
     • гранты здесь НЕ редактируются — кнопка «Права и доступ» ведёт в П1R.
   ============================================================================ */

import React, { useState } from 'react';
import { ExecutorBadge, ExecGlyph, MonoId, Mono, Button, RoleAssignment, ReservationMeter, BudgetMeter, EXEC_META } from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';

/* ---- Данные оргструктуры ---- */
const ORG = [
  {
    id: "fin", name: "Финансы", positions: [
      {
        id: "fin-ctrl", title: "Контролёр расчётов", people: [
          { id: "e-kravtsova", type: "human", name: "А. Кравцова" },
          { id: "a-recon", type: "agent", name: "Сверка-агент", model: "recon-v3" },
        ],
      },
      {
        id: "fin-appr", title: "Согласующий счетов", people: [
          { id: "a-invoice", type: "agent", name: "Счёт-агент", model: "invoice-v4" },
          { id: "e-mironov", type: "human", name: "Д. Миронов" },
        ],
      },
      { id: "fin-cfo", title: "Финансовый директор", people: [{ id: "e-larina", type: "human", name: "Е. Ларина" }] },
    ],
  },
  {
    id: "cs", name: "Клиентский сервис", positions: [
      {
        id: "cs-l1", title: "Линия поддержки L1", people: [
          { id: "a-triage", type: "agent", name: "Триаж-агент", model: "triage-v2" },
          { id: "e-orlov", type: "human", name: "К. Орлов" },
          { id: "e-savina", type: "human", name: "Н. Савина" },
        ],
      },
      { id: "cs-l2", title: "Эскалации L2", people: [{ id: "e-petrov", type: "human", name: "И. Петров" }], vacancy: 1 },
    ],
  },
  {
    id: "plat", name: "Платформа", positions: [
      { id: "plat-int", title: "Интеграции", people: [{ id: "e-belov", type: "human", name: "С. Белов" }] },
      { id: "plat-svc", title: "Сервисные коннекторы", people: [{ id: "s-ledger", type: "service", name: "ledger-sync" }, { id: "s-ocr", type: "service", name: "ocr-gateway" }] },
    ],
  },
];

/* ---- Карточки исполнителей ----
   roles → assignments (read); грант-атомы живут в П1R (screen-rights).        */
const EXEC_DETAIL = {
  "a-invoice": {
    type: "agent", name: "Счёт-агент", position: "Согласующий счетов", dept: "Финансы",
    id: "AG-0042", autonomyLevel: "L2 — частичная автономия",
    state: { "Статус": "Активен", "В очереди": "4 задачи", "Подчинён": "Е. Ларина · человек", "Активен с": "11.03.2026" },
    llm: {
      endpoint: "https://llm.fin.choros.internal/v1",
      model: "claude-sonnet-4", build: "invoice-v4",
      ctx: "200K токенов", region: "ru-central-1a", billing: "по токенам",
    },
    assignments: [
      { roleId: "role-fin-approve-50", role: "Согласующий счетов ≤ ₽50 000", scope: "Финансы · Согласование счёта", validity: "до 31.12.2026" },
      { roleId: "role-fin-recon", role: "Сверка платежей", scope: "Финансы · Закрытие месяца", validity: "бессрочно" },
    ],
    reservation: [
      { label: "Токены LLM", used: 148920, instanceCap: 250000, agentCap: 2000000, unit: "ткн" },
      { label: "Стоимость вывода", used: 11800, instanceCap: 12480, agentCap: 80000, unit: "₽", money: true },
      { label: "Вызовы инструментов", used: 142, instanceCap: 300, agentCap: 4000, unit: "" },
    ],
    autonomy: { auto: 50, review: 80, autoLabel: "Автономно", reviewLabel: "Соглас. человеком", blockLabel: "Блок", t1: "₽0", t2: "₽50 000", t3: "₽250 000", esc: "А. Кравцова → Е. Ларина", escType: "human" },
  },
  "e-kravtsova": {
    type: "human", name: "А. Кравцова", position: "Контролёр расчётов", dept: "Финансы",
    id: "HU-0118", autonomyLevel: "Полные права в роли",
    state: { "Статус": "На смене", "В работе": "3 задачи", "Руководитель": "Е. Ларина", "Часовой пояс": "MSK (UTC+3)" },
    assignments: [
      { roleId: "role-fin-control", role: "Контролёр расчётов", scope: "Финансы", validity: "бессрочно" },
      { roleId: "role-fin-approve-250", role: "Согласование ≤ ₽250 000", scope: "Финансы · Согласование счёта", validity: "до 30.06.2026", expiring: true },
      { roleId: "role-fin-escrcv", role: "Приёмник эскалаций агентов", scope: "Финансы", validity: "бессрочно" },
    ],
    limits: [
      { label: "Согласований / сутки", used: 23, total: 60, unit: "" },
      { label: "Лимит согласования", used: 184000, total: 250000, unit: "₽", money: true },
    ],
    autonomy: { auto: 70, review: 100, autoLabel: "Утверждает сама", reviewLabel: "Совет директоров", blockLabel: "", t1: "₽0", t2: "₽250 000", t3: "₽1 000 000", esc: "Совет директоров", escType: "human" },
  },
  "a-triage": {
    type: "agent", name: "Триаж-агент", position: "Линия поддержки L1", dept: "Клиентский сервис",
    id: "AG-0017", autonomyLevel: "L1 — узкая автономия",
    state: { "Статус": "Активен", "В очереди": "12 обращений", "Подчинён": "И. Петров · человек", "Активен с": "02.01.2026" },
    llm: {
      endpoint: "https://llm.cs.choros.internal/v1",
      model: "claude-haiku-4", build: "triage-v2",
      ctx: "100K токенов", region: "ru-central-1a", billing: "по токенам",
    },
    assignments: [
      { roleId: "role-cs-l1", role: "Линия поддержки L1", scope: "Клиентский сервис · Поддержка", validity: "бессрочно" },
    ],
    reservation: [
      { label: "Токены LLM", used: 38400, instanceCap: 60000, agentCap: 1500000, unit: "ткн" },
      { label: "Стоимость вывода", used: 640, instanceCap: 1200, agentCap: 24000, unit: "₽", money: true },
      { label: "Авто-ответы", used: 7, instanceCap: 12, agentCap: 900, unit: "" },
    ],
    autonomy: { auto: 60, review: 100, autoLabel: "Авто-ответ", reviewLabel: "Эскалация L2", blockLabel: "", t1: "FAQ", t2: "Стандарт", t3: "Спор / возврат", esc: "И. Петров (L2)", escType: "human" },
  },
  "s-ledger": {
    type: "service", name: "ledger-sync", position: "Сервисный коннектор", dept: "Платформа",
    id: "SV-0003", autonomyLevel: "Детерминированный — без автономии",
    state: { "Статус": "Здоров", "Аптайм": "99.98%", "Владелец": "С. Белов", "Регион": "ru-central-1" },
    assignments: [
      { roleId: "role-plat-ledger", role: "Коннектор реестра", scope: "Платформа", validity: "бессрочно" },
    ],
    limits: [
      { label: "RPS, средний", used: 42, total: 200, unit: "rps" },
      { label: "Бюджет ошибок / сутки", used: 3, total: 50, unit: "" },
    ],
    autonomy: { auto: 100, review: 100, autoLabel: "Детерминированный — порог не применяется", reviewLabel: "", blockLabel: "", t1: "", t2: "", t3: "", esc: "Дежурный платформы (при сбое)", escType: "human" },
  },
};

function TreeRow({ depth, type, kind, label, count, vacancy, open, selected, onToggle, onSelect, hasChildren }) {
  return (
    <button
      className={`chs-trow chs-trow--${kind}`}
      style={{ paddingLeft: `calc(${depth} * var(--chs-space-7) + var(--chs-space-3))` }}
      aria-selected={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span
        className={`chs-trow__twist ${open ? "chs-trow__twist--open" : ""} ${hasChildren ? "" : "chs-trow__twist--leaf"}`}
        onClick={(e) => { if (hasChildren) { e.stopPropagation(); onToggle(); } }}
      >
        <Icon name="chevron" />
      </span>
      {kind === "dept" && <span className="chs-trow__deptglyph" />}
      {kind === "emp" && <ExecGlyph type={type} size={9} />}
      <span className="chs-trow__label">{label}</span>
      {vacancy ? <span className="chs-trow__vac">вакансия</span> : null}
      {count != null && <span className="chs-trow__count">{count}</span>}
    </button>
  );
}

function OrgTree({ selectedId, onSelect }) {
  const [open, setOpen] = useState(() => ({ fin: true, "fin-appr": true, cs: true, "cs-l1": true, plat: false }));
  const toggle = (id) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  const rows = [];
  ORG.forEach((dept) => {
    const headcount = dept.positions.reduce((n, p) => n + p.people.length, 0);
    rows.push(
      <TreeRow key={dept.id} depth={0} kind="dept" label={dept.name} count={headcount}
        open={open[dept.id]} hasChildren onToggle={() => toggle(dept.id)} onSelect={() => toggle(dept.id)} />
    );
    if (!open[dept.id]) return;
    dept.positions.forEach((pos) => {
      rows.push(
        <TreeRow key={pos.id} depth={1} kind="pos" label={pos.title} count={pos.people.length} vacancy={pos.vacancy}
          open={open[pos.id]} hasChildren onToggle={() => toggle(pos.id)} onSelect={() => toggle(pos.id)} />
      );
      if (!open[pos.id]) return;
      pos.people.forEach((person) => {
        rows.push(
          <TreeRow key={person.id} depth={2} kind="emp" type={person.type} label={person.name}
            selected={selectedId === person.id} hasChildren={false}
            onSelect={() => EXEC_DETAIL[person.id] && onSelect(person.id)} />
        );
      });
    });
  });

  return (
    <div className="chs-org__tree">
      <div className="chs-org__treehead">
        <span>Оргструктура</span>
        <button className="chs-iconbtn" title="Добавить"><Icon name="plus" /></button>
      </div>
      <div className="chs-tree">{rows}</div>
    </div>
  );
}

function fmtRu(n) { return n.toLocaleString("ru-RU"); }
const moneyFmt = (n) => "₽" + fmtRu(n);

function ExecutorDetail({ data, onOpenRights }) {
  const isAgent = data.type === "agent";
  const isService = data.type === "service";
  const primaryRole = data.assignments[0]?.roleId;
  return (
    <div className="chs-org__detail">
      <div className="chs-detail">
        <div className="chs-detail__head">
          <div className={`chs-detail__avatar chs-detail__avatar--${data.type}`}>
            <ExecGlyph type={data.type} size={22} />
          </div>
          <div className="chs-detail__headmain">
            <h2 className="chs-detail__name">
              {data.name}
              <ExecutorBadge type={data.type} />
            </h2>
            <div className="chs-detail__meta">
              <span>{data.position}</span>
              <span className="chs-crumbs__sep">/</span>
              <span>{data.dept}</span>
              <span className="chs-crumbs__sep">/</span>
              <MonoId>{data.id}</MonoId>
            </div>
          </div>
          <div className="chs-detail__headactions">
            <Button variant="ghost" size="sm">Журнал</Button>
            <Button variant="secondary" size="sm" onClick={() => onOpenRights && onOpenRights(primaryRole)}
              glyph={<Icon name="rights" className="chs-btn__glyph" />}>Права и доступ</Button>
          </div>
        </div>

        {/* Состояние */}
        <div className="chs-detail__statline">
          {Object.entries(data.state).map(([k, v]) => (
            <div className="chs-statcell" key={k}>
              <span className="chs-statcell__k">{k}</span>
              <span className="chs-statcell__v">{v}</span>
            </div>
          ))}
        </div>

        {/* Назначения ролей (read) */}
        <section className="chs-section2">
          <div className="chs-section2__head">
            <h3 className="chs-section2__title">Назначенные роли</h3>
            <span className="chs-section2__aux">{data.assignments.length} назначено · права от роли</span>
          </div>
          <div className="chs-asgns">
            <div className="chs-asgns__colhead">
              <span>Роль</span><span>Орг-охват</span><span>Срок действия</span>
            </div>
            {data.assignments.map((a) => (
              <RoleAssignment key={a.roleId} role={a.role} scope={a.scope} validity={a.validity}
                expiring={a.expiring} onOpen={() => onOpenRights && onOpenRights(a.roleId)} />
            ))}
          </div>
          <p className="chs-section2__note">
            Доступные инструменты и видимые поля форм — <b>производные от грантов роли</b>.
            Гранты не редактируются здесь:&nbsp;
            <button className="chs-inlinelink" onClick={() => onOpenRights && onOpenRights(primaryRole)}>открыть «Права и доступ» →</button>
          </p>
        </section>

        {/* Своя модель (BYO) — только агент */}
        {isAgent && data.llm && (
          <section className="chs-section2">
            <div className="chs-section2__head">
              <h3 className="chs-section2__title">Своя модель (LLM)</h3>
              <span className="chs-byo">BYO · клиент хостит</span>
            </div>
            <div className="chs-llm">
              <div className="chs-llm__endpointrow">
                <span className="chs-llm__k">Эндпойнт</span>
                <Mono className="chs-llm__endpoint">{data.llm.endpoint}</Mono>
              </div>
              <div className="chs-llm__grid">
                <div className="chs-statcell"><span className="chs-statcell__k">Модель</span><span className="chs-statcell__v"><Mono>{data.llm.model}</Mono></span></div>
                <div className="chs-statcell"><span className="chs-statcell__k">Сборка</span><span className="chs-statcell__v"><Mono>{data.llm.build}</Mono></span></div>
                <div className="chs-statcell"><span className="chs-statcell__k">Контекст</span><span className="chs-statcell__v"><Mono>{data.llm.ctx}</Mono></span></div>
                <div className="chs-statcell"><span className="chs-statcell__k">Регион / тариф</span><span className="chs-statcell__v"><Mono>{data.llm.region}</Mono> · {data.llm.billing}</span></div>
              </div>
            </div>
          </section>
        )}

        {/* Бюджет с резервированием (агент) / Лимиты (человек, сервис) */}
        {isAgent ? (
          <section className="chs-section2">
            <div className="chs-section2__head">
              <h3 className="chs-section2__title">Бюджет и резервирование</h3>
              <span className="chs-section2__aux">две крыши: на инстанс · на агента</span>
            </div>
            <div className="chs-resvs">
              {data.reservation.map((b) => (
                <ReservationMeter key={b.label} label={b.label} used={b.used} instanceCap={b.instanceCap}
                  agentCap={b.agentCap} unit={b.unit} fmt={b.money ? moneyFmt : fmtRu} />
              ))}
            </div>
          </section>
        ) : (
          <section className="chs-section2">
            <div className="chs-section2__head">
              <h3 className="chs-section2__title">{isService ? "Сервисные лимиты" : "Лимиты в роли"}</h3>
              <span className="chs-section2__aux">сброс в 00:00 MSK</span>
            </div>
            <div className="chs-budgets">
              {data.limits.map((b) => (
                <BudgetMeter key={b.label} label={b.label} used={b.used} total={b.total} unit={b.unit}
                  fmt={b.money ? moneyFmt : fmtRu} />
              ))}
            </div>
          </section>
        )}

        {/* Автономия / эскалация */}
        <section className="chs-section2">
          <div className="chs-section2__head">
            <h3 className="chs-section2__title">Порог автономии и эскалации</h3>
            <span className="chs-section2__aux">{data.autonomyLevel}</span>
          </div>
          <div className="chs-autonomy">
            {isService ? (
              <div className="chs-autonomy__track">
                <div className="chs-autonomy__zone chs-autonomy__zone--auto" style={{ flex: 1 }}>{data.autonomy.autoLabel}</div>
              </div>
            ) : (
              <>
                <div className="chs-autonomy__track">
                  <div className="chs-autonomy__zone chs-autonomy__zone--auto" style={{ flex: data.autonomy.auto }}>{data.autonomy.autoLabel}</div>
                  <div className="chs-autonomy__zone chs-autonomy__zone--review" style={{ flex: data.autonomy.review - data.autonomy.auto }}>{data.autonomy.reviewLabel}</div>
                  {data.autonomy.blockLabel && (
                    <div className="chs-autonomy__zone chs-autonomy__zone--block" style={{ flex: Math.max(12, 100 - data.autonomy.review) }}>{data.autonomy.blockLabel}</div>
                  )}
                </div>
                <div className="chs-autonomy__ticks">
                  <span>{data.autonomy.t1}</span>
                  <span>{data.autonomy.t2}</span>
                  <span>{data.autonomy.t3}</span>
                </div>
              </>
            )}
            <div className="chs-autonomy__esc">
              <span>Эскалация:</span>
              <span className="chs-autonomy__arrow">→</span>
              <ExecutorBadge type={data.autonomy.escType} name={data.autonomy.esc} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function OrgScreen({ onOpenRights }) {
  const [selected, setSelected] = useState("a-invoice");
  const data = EXEC_DETAIL[selected] || EXEC_DETAIL["a-invoice"];
  return (
    <div className="chs-org">
      <OrgTree selectedId={selected} onSelect={setSelected} />
      <ExecutorDetail data={data} onOpenRights={onOpenRights} />
    </div>
  );
}

export default OrgScreen;
