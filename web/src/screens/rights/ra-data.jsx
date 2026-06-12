/* ============================================================================
   CHOROS — ra-data.jsx
   Раздел «Права и доступ» — управление ролями/грантами под аудит.
   Общие данные + общие примитивы для четырёх экранов раздела.
   Всё на токенах --chs-*; форма исполнителя дублирует цвет (круг/ромб/квадрат).
   ============================================================================ */

import React from 'react';
import { ExecGlyph, ExecutorBadge, Mono, Button, OpChip } from '../../components/components.jsx';
import { Icon } from '../../app-shell/icon.jsx';

/* ---------------------------------------------------------------------------
   ОПЕРАЦИИ ГРАНТА — машинные коды
   --------------------------------------------------------------------------- */
const OP_LABEL = { read: "read", write: "write", exec: "exec", approve: "approve" };
const OP_RU = { read: "чтение", write: "запись", exec: "вызов", approve: "утвердить" };

/* ---------------------------------------------------------------------------
   ОРГСТРУКТУРА — закрытая решётка для scope-пикера (узлы дерева)
   Охват можно только СУЖАТЬ относительно потолка роли (монотонное сужение).
   --------------------------------------------------------------------------- */
const ORG_TREE = [
  { id: "org", label: "Компания", depth: 0, children: ["fin", "cs", "plat", "sales"] },
  { id: "fin", label: "Финансы", depth: 1, children: ["fin-calc", "fin-approve", "fin-treasury"] },
  { id: "fin-calc", label: "Расчёты", depth: 2 },
  { id: "fin-approve", label: "Согласование", depth: 2 },
  { id: "fin-treasury", label: "Казначейство", depth: 2 },
  { id: "cs", label: "Клиентский сервис", depth: 1, children: ["cs-l1", "cs-l2"] },
  { id: "cs-l1", label: "Поддержка L1", depth: 2 },
  { id: "cs-l2", label: "Эскалации L2", depth: 2 },
  { id: "plat", label: "Платформа", depth: 1 },
  { id: "sales", label: "Продажи", depth: 1, children: ["sales-smb", "sales-ent"] },
  { id: "sales-smb", label: "SMB", depth: 2 },
  { id: "sales-ent", label: "Enterprise", depth: 2 },
];
const ORG_BY_ID = Object.fromEntries(ORG_TREE.map((n) => [n.id, n]));

/* теги охвата (мультивыбор) */
const SCOPE_TAGS = [
  { id: "pii", label: "ПДн" },
  { id: "payments", label: "платежи" },
  { id: "contracts", label: "договоры" },
  { id: "kyc", label: "KYC" },
  { id: "ext-api", label: "внешние-API" },
];

/* ---------------------------------------------------------------------------
   РЕСУРСЫ (MCP) — из чего собираются гранты
   --------------------------------------------------------------------------- */
const RESOURCES = [
  { uri: "mcp://ledger.invoices", name: "Реестр счетов", sensitive: true },
  { uri: "mcp://ledger.recon", name: "Сверка платежей", sensitive: true },
  { uri: "mcp://payments.initiate", name: "Платёжный шлюз", external: true, guarded: true },
  { uri: "mcp://payments.refund", name: "Возвраты средств", external: true, guarded: true },
  { uri: "mcp://counterparty.kyc", name: "Контрагенты (KYC)", sensitive: true },
  { uri: "mcp://contracts.lookup", name: "Справочник договоров" },
  { uri: "mcp://support.queue", name: "Очередь обращений" },
  { uri: "mcp://crm.customer", name: "CRM клиента", sensitive: true },
  { uri: "mcp://kb.search", name: "База знаний" },
  { uri: "mcp://escalations.queue", name: "Очередь эскалаций" },
];
const RES_BY_URI = Object.fromEntries(RESOURCES.map((r) => [r.uri, r]));

/* ---------------------------------------------------------------------------
   ПРЕСЕТЫ простого режима — высокоуровневое намерение → набор грантов
   (T-0135: 10 day-1 пресетов; синхронизированы с DICT_PRESETS в src/http/grants.ts)
   Шейп атома: { uri, ops, scopeOwn?, scopeOrg?, constraint? }
   Каждый пресет разворачивается в grant-атомы на стороне клиента перед POST /api/grants
   (AC-18 T-0030 — без preset-таблицы).
   --------------------------------------------------------------------------- */
const PRESETS = [
  // 1 — Согласующий бюджета в Финансах
  {
    id: "p-budget-approver",
    label: "Согласующий бюджета в Финансах",
    desc: "Просмотр и согласование счетов в Финансах без права инициировать платёж",
    grants: [
      { uri: "mcp://ledger.invoices", ops: ["read"],    scopeOrg: "fin" },
      { uri: "mcp://ledger.invoices", ops: ["approve"], scopeOrg: "fin" },
    ],
  },
  // 2 — Казначей-исполнитель
  {
    id: "p-treasury-exec",
    label: "Казначей-исполнитель",
    desc: "Чтение, сверка и инициация платежей до ₽500 000 в Казначействе",
    critical: true,
    grants: [
      { uri: "mcp://ledger.invoices",  ops: ["read"],   scopeOrg: "fin-treasury" },
      { uri: "mcp://ledger.recon",      ops: ["read"],   scopeOrg: "fin-treasury" },
      { uri: "mcp://ledger.recon",      ops: ["update"], scopeOrg: "fin-treasury" },
      { uri: "mcp://payments.initiate", ops: ["invoke"], scopeOrg: "fin-treasury",
        constraint: { amount_le: 500000 } },
    ],
  },
  // 3 — Наблюдатель аудита
  {
    id: "p-audit-observer",
    label: "Наблюдатель аудита",
    desc: "Чтение счетов, сверки и реестра договоров для аудиторских целей",
    grants: [
      { uri: "mcp://ledger.invoices",  ops: ["read"], scopeOrg: "fin" },
      { uri: "mcp://ledger.recon",      ops: ["read"], scopeOrg: "fin" },
      { uri: "mcp://contracts.lookup",  ops: ["read"], scopeOrg: "fin" },
    ],
  },
  // 4 — Инициатор договорной работы
  {
    id: "p-contract-initiator",
    label: "Инициатор договорной работы",
    desc: "Создание договоров и чтение справочника контрагентов в своём подразделении",
    grants: [
      { uri: "mcp://contracts.lookup",  ops: ["read", "create"], scopeOwn: true },
      { uri: "mcp://counterparty.kyc",   ops: ["read"],           scopeOwn: true },
    ],
  },
  // 5 — Согласующий договоров
  {
    id: "p-contract-approver",
    label: "Согласующий договоров",
    desc: "Просмотр и согласование договоров в своём подразделении",
    grants: [
      { uri: "mcp://contracts.lookup", ops: ["read", "approve"], scopeOwn: true },
      { uri: "mcp://counterparty.kyc",  ops: ["read"],            scopeOwn: true },
    ],
  },
  // 6 — Линия поддержки L1
  {
    id: "p-support-l1",
    label: "Линия поддержки L1",
    desc: "Обработка обращений L1: очередь, CRM и база знаний",
    grants: [
      { uri: "mcp://support.queue",  ops: ["read", "update"], scopeOrg: "cs-l1" },
      { uri: "mcp://crm.customer",   ops: ["read"],           scopeOrg: "cs-l1" },
      { uri: "mcp://kb.search",      ops: ["read"],           scopeOrg: "cs-l1" },
    ],
  },
  // 7 — Приёмник эскалаций агентов
  {
    id: "p-escalation-receiver",
    label: "Приёмник эскалаций агентов",
    desc: "Приём и обработка агентских эскалаций в Клиентском сервисе",
    grants: [
      { uri: "mcp://escalations.queue", ops: ["read", "update"], scopeOrg: "cs" },
      { uri: "mcp://crm.customer",      ops: ["read"],           scopeOrg: "cs" },
    ],
  },
  // 8 — Бухгалтер сверки
  {
    id: "p-recon-accountant",
    label: "Бухгалтер сверки",
    desc: "Чтение реестра счетов и ведение сверки платежей",
    grants: [
      { uri: "mcp://ledger.invoices", ops: ["read"],           scopeOrg: "fin" },
      { uri: "mcp://ledger.recon",    ops: ["read", "update"], scopeOrg: "fin" },
    ],
  },
  // 9 — Инициировать платёж до лимита
  {
    id: "p-pay-init-limited",
    label: "Инициировать платёж до лимита",
    desc: "Вызов платёжного шлюза до ₽250 000 в своём подразделении",
    critical: true,
    grants: [
      { uri: "mcp://ledger.invoices",  ops: ["read"],   scopeOwn: true },
      { uri: "mcp://payments.initiate", ops: ["invoke"], scopeOwn: true,
        constraint: { amount_le: 250000 } },
    ],
  },
  // 10 — Оператор возвратов
  {
    id: "p-refund-operator",
    label: "Оператор возвратов",
    desc: "Инициация возвратов до ₽30 000 и просмотр счетов в Финансах",
    critical: true,
    grants: [
      { uri: "mcp://ledger.invoices",  ops: ["read"],   scopeOrg: "fin" },
      { uri: "mcp://payments.refund",  ops: ["invoke"], scopeOrg: "fin",
        constraint: { amount_le: 30000 } },
    ],
  },
];

/* ---------------------------------------------------------------------------
   КРИТИЧНОСТЬ — три оси. Роль критична, если активна хотя бы одна «тяжёлая» ось
   (guarded-переход или внешняя интеграция).
   --------------------------------------------------------------------------- */
const CRIT_AXES = [
  { id: "guarded", label: "Guarded-переход", short: "guarded", desc: "утверждает или исполняет защищённый переход процесса" },
  { id: "external", label: "Внешние интеграции", short: "external", desc: "вызывает внешние интеграции (платежи, отправка наружу)" },
  { id: "sensitive", label: "Чувствительные данные", short: "sensitive", desc: "читает персональные / финансово-чувствительные данные" },
];
function critLevel(axes) {
  return (axes.guarded || axes.external) ? "critical" : (axes.sensitive ? "elevated" : "standard");
}
const CRIT_META = {
  critical: { label: "критичная", ru: "Критичная роль" },
  elevated: { label: "повышенная", ru: "Повышенная" },
  standard: { label: "стандартная", ru: "Стандартная" },
};

/* вывести оси критичности из набора грантов */
function axesFromGrants(grants) {
  const axes = { guarded: false, external: false, sensitive: false };
  grants.forEach((g) => {
    const r = RES_BY_URI[g.uri];
    if (!r) return;
    if (r.guarded && (g.ops.includes("exec") || g.ops.includes("approve"))) axes.guarded = true;
    if (r.external && g.ops.includes("exec")) axes.external = true;
    if (r.sensitive && (g.ops.includes("read") || g.ops.includes("write"))) axes.sensitive = true;
  });
  return axes;
}

/* ---------------------------------------------------------------------------
   ПРАВИЛА SoD — несовместимые роли (кто запрашивает ≠ кто утверждает)
   --------------------------------------------------------------------------- */
const SOD_RULES = [
  {
    id: "SoD-01", title: "Инициатор ≠ Согласующий платежа",
    a: "Контролёр расчётов", b: "Согласование ≤ ₽250 000",
    rationale: "Тот, кто заводит платёж, не должен сам его утверждать.",
    severity: "block",
  },
  {
    id: "SoD-02", title: "Согласующий ≠ Приёмник эскалаций",
    a: "Согласование ≤ ₽250 000", b: "Приёмник эскалаций агентов",
    rationale: "Утверждающий не разбирает собственные эскалации.",
    severity: "block",
  },
  {
    id: "SoD-03", title: "Сверка ≠ Инициация платежа",
    a: "Сверка платежей", b: "Инициировать платёж",
    rationale: "Сверяющий счёт не должен инициировать по нему платёж.",
    severity: "warn",
  },
  {
    id: "SoD-04", title: "L1 ≠ Возвраты средств",
    a: "Линия поддержки L1", b: "Эскалации L2",
    rationale: "Первая линия не санкционирует возвраты, которые сама и приняла.",
    severity: "warn",
  },
];

/* ---------------------------------------------------------------------------
   ЖУРНАЛ ВЫДАЧИ ПРАВ — append-only grant trail
   --------------------------------------------------------------------------- */
const TRAIL = [
  { ts: "2026-06-08 14:21:06.318", id: "grt-9f4a2c", action: "grant", actor: { type: "human", name: "М. Соколов" }, subject: { type: "human", name: "Е. Ларина" }, role: "Согласование ≤ ₽250 000", res: "mcp://payments.initiate", op: "exec", scope: "≤ ₽250 000", proposed: "human", confirmed: ["М. Соколов", "Д. Гаврилов"], crit: true },
  { ts: "2026-06-08 13:58:44.901", id: "grt-9f49b1", action: "grant", actor: { type: "human", name: "М. Соколов" }, subject: { type: "agent", name: "Счёт-агент" }, role: "Согласующий счетов ≤ ₽50 000", res: "mcp://ledger.invoices", op: "write", scope: "Финансы · Согласование", proposed: "llm", confirmed: ["М. Соколов"], crit: false },
  { ts: "2026-06-08 13:58:44.901", id: "grt-9f49b0", action: "grant", actor: { type: "human", name: "М. Соколов" }, subject: { type: "agent", name: "Счёт-агент" }, role: "Согласующий счетов ≤ ₽50 000", res: "mcp://ocr.extract", op: "exec", scope: "Финансы · Согласование", proposed: "llm", confirmed: ["М. Соколов"], crit: false },
  { ts: "2026-06-08 11:42:19.044", id: "grt-9f3d77", action: "revoke", actor: { type: "human", name: "А. Кравцова" }, subject: { type: "human", name: "К. Орлов" }, role: "Эскалации L2", res: "mcp://payments.refund", op: "exec", scope: "≤ ₽30 000", proposed: "human", confirmed: ["А. Кравцова", "И. Петров"], crit: true },
  { ts: "2026-06-08 10:15:02.560", id: "grt-9f2a10", action: "narrow", actor: { type: "service", name: "policy-sync" }, subject: { type: "agent", name: "Триаж-агент" }, role: "Линия поддержки L1", res: "mcp://crm.customer", op: "read", scope: "Поддержка → Поддержка L1", proposed: "human", confirmed: ["М. Соколов"], crit: false },
  { ts: "2026-06-07 18:33:51.222", id: "grt-9e88c3", action: "grant", actor: { type: "human", name: "М. Соколов" }, subject: { type: "human", name: "Н. Савина" }, role: "Линия поддержки L1", res: "mcp://support.queue", op: "write", scope: "Поддержка", proposed: "llm", confirmed: ["М. Соколов"], crit: false },
  { ts: "2026-06-07 16:09:12.700", id: "grt-9e71fa", action: "grant", actor: { type: "human", name: "А. Кравцова" }, subject: { type: "human", name: "А. Кравцова" }, role: "Приёмник эскалаций агентов", res: "mcp://escalations.queue", op: "write", scope: "Финансы", proposed: "human", confirmed: ["А. Кравцова", "М. Соколов"], crit: false },
  { ts: "2026-06-07 15:47:30.119", id: "grt-9e6d05", action: "grant", actor: { type: "human", name: "М. Соколов" }, subject: { type: "service", name: "ledger-sync" }, role: "Коннектор реестра", res: "mcp://bus.publish", op: "exec", scope: "Платформа", proposed: "human", confirmed: ["М. Соколов"], crit: false },
  { ts: "2026-06-07 09:21:48.005", id: "grt-9e2b88", action: "grant", actor: { type: "human", name: "Д. Гаврилов" }, subject: { type: "human", name: "Е. Ларина" }, role: "Сверка платежей", res: "mcp://ledger.recon", op: "write", scope: "Финансы · Закрытие месяца", proposed: "llm", confirmed: ["Д. Гаврилов", "М. Соколов"], crit: false },
  { ts: "2026-06-06 17:55:13.840", id: "grt-9d04f1", action: "grant", actor: { type: "human", name: "М. Соколов" }, subject: { type: "human", name: "И. Петров" }, role: "Эскалации L2", res: "mcp://crm.customer", op: "write", scope: "Поддержка", proposed: "human", confirmed: ["М. Соколов"], crit: false },
];

/* ===========================================================================
   ОБЩИЕ ПРИМИТИВЫ РАЗДЕЛА
   =========================================================================== */

/* CriticalityBadge — компактный бейдж критичности + три оси (форма + цвет) */
function CriticalityBadge({ axes, size = "md" }) {
  const level = critLevel(axes);
  return (
    <span className={`chs-critbadge chs-critbadge--${level} ${size === "sm" ? "chs-critbadge--sm" : ""}`} title={CRIT_META[level].ru}>
      <span className="chs-critbadge__label">{CRIT_META[level].label}</span>
      <span className="chs-critbadge__axes">
        {CRIT_AXES.map((ax) => (
          <span key={ax.id} className={`chs-critaxis ${axes[ax.id] ? "chs-critaxis--on" : ""}`} title={ax.desc}>{ax.short[0].toUpperCase()}</span>
        ))}
      </span>
    </span>
  );
}

/* AxisList — развёрнутые три оси критичности с состоянием */
function AxisList({ axes, onToggle }) {
  return (
    <div className="chs-axislist">
      {CRIT_AXES.map((ax) => {
        const on = axes[ax.id];
        const heavy = ax.id !== "sensitive";
        return (
          <button
            key={ax.id}
            className={`chs-axisrow ${on ? "chs-axisrow--on" : ""} ${on && heavy ? "chs-axisrow--heavy" : ""}`}
            onClick={onToggle ? () => onToggle(ax.id) : undefined}
            disabled={!onToggle}
            type="button"
          >
            <span className={`chs-axisrow__mark ${on ? "chs-axisrow__mark--on" : ""}`} />
            <span className="chs-axisrow__main">
              <span className="chs-axisrow__label">{ax.label}</span>
              <span className="chs-axisrow__desc">{ax.desc}</span>
            </span>
            <span className="chs-axisrow__flag">{on ? (heavy ? "повышает критичность" : "активна") : "—"}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ScopeToken — отображение одного элемента охвата (узел / тег / интервал) */
function ScopeToken({ kind = "node", children, ceiling = false }) {
  const glyph = kind === "tag" ? "#" : kind === "range" ? "≤" : null;
  return (
    <span className={`chs-scopetok chs-scopetok--${kind} ${ceiling ? "chs-scopetok--ceiling" : ""}`}>
      {kind === "node" && <span className="chs-scopetok__glyph" />}
      {glyph && <span className="chs-scopetok__op">{glyph}</span>}
      {children}
    </span>
  );
}

/* ProvenanceTag — происхождение гранта: предложено LLM / заведено человеком */
function ProvenanceTag({ by }) {
  if (by === "llm") return <span className="chs-prov chs-prov--llm"><span className="chs-prov__glyph" />предложено&nbsp;LLM</span>;
  return <span className="chs-prov chs-prov--human"><span className="chs-prov__glyph" />заведено&nbsp;человеком</span>;
}

/* SectionHead — заголовок секции в стиле DS */
function SectionHead({ title, aux, right }) {
  return (
    <div className="chs-section2__head">
      <h3 className="chs-section2__title">{title}</h3>
      {aux && <span className="chs-section2__aux">{aux}</span>}
      {right}
    </div>
  );
}

/* Segmented — сегментный переключатель (режимы) */
function Segmented({ value, onChange, options }) {
  return (
    <div className="chs-seg" role="group">
      {options.map((o) => (
        <button key={o.value} type="button" className="chs-seg__btn" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}{o.hint && <span className="chs-seg__hint">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

export {
  OP_LABEL, OP_RU, ORG_TREE, ORG_BY_ID, SCOPE_TAGS, RESOURCES, RES_BY_URI,
  PRESETS, CRIT_AXES, critLevel, CRIT_META, axesFromGrants, SOD_RULES, TRAIL,
  CriticalityBadge, AxisList, ScopeToken, ProvenanceTag, SectionHead, Segmented,
};
