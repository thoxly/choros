/* ============================================================================
   CHOROS — screen-audit.jsx
   ЭКРАН 3 (hero): таймлайн аудита одного инстанса процесса.
   Единый вертикальный поток событий человек/агент/сервис.
   Каждый вызов инструмента — отдельный AuditEvent с моноширинными ID и
   таймстампом; раскрывается payload (вход/выход, длительность, токены, ₽).
   ============================================================================ */

import React, { useState } from 'react';
import { ExecGlyph, MonoId, Mono, StatusChip, BudgetMeter, EXEC_META } from '../components/components.jsx';

const INSTANCE = {
  process: "Согласование счёта поставщика",
  procId: "PRC-INV-APPROVE",
  id: "INS-7731",
  status: "running",
  started: "07.06.2026 14:28:11",
  elapsed: "00:06:42",
  node: "n7 · Утверждение платежа",
  execs: ["service", "agent", "human"],
  budget: [
    { label: "Токены инстанса", used: 148920, total: 250000, unit: "ткн" },
    { label: "Стоимость", used: 11800, total: 12480, unit: "₽", money: true },
  ],
};

/* Группы = узлы BPMN; внутри — события (человек/агент/сервис) */
const TRACE = [
  {
    node: "n1", name: "Старт · поступление счёта", events: [
      { ts: "14:28:11.004", type: "service", actor: "ledger-sync", action: "зарегистрировал входящий счёт", target: "DOC-4471", tag: "ok" },
      { ts: "14:28:11.182", type: "service", actor: "ocr-gateway", action: "вызвал инструмент", target: "mcp://ocr.extract", tag: "mcp", tool: true,
        meta: { dur: "1 284 мс", tok: "— ткн", cost: "₽4.10" },
        payload: { call: "ocr.extract(file=invoice_4471.pdf, lang=ru)", out: "{ supplier: \"ООО Вектор\", amount: 184000, vat: 30667, date: \"2026-06-05\" }" } },
    ],
  },
  {
    node: "n3", name: "Проверка реквизитов", events: [
      { ts: "14:28:13.560", type: "agent", actor: "Счёт-агент", action: "начал задачу", target: "TSK-0091", tag: null },
      { ts: "14:28:14.902", type: "agent", actor: "Счёт-агент", action: "вызвал инструмент", target: "mcp://contracts.lookup", tag: "mcp", tool: true,
        meta: { dur: "612 мс", tok: "2 480 ткн", cost: "₽1.90" },
        payload: { call: "contracts.lookup(supplier=\"ООО Вектор\")", out: "{ contract: \"ДГ-2231\", limit: 250000, status: \"active\" }" } },
      { ts: "14:28:16.071", type: "agent", actor: "Счёт-агент", action: "вызвал инструмент", target: "mcp://ledger.invoices", tag: "mcp", tool: true,
        meta: { dur: "338 мс", tok: "1 120 ткн", cost: "₽0.80" },
        payload: { call: "ledger.invoices.match(amount=184000, contract=\"ДГ-2231\")", out: "{ match: true, duplicate: false }" } },
      { ts: "14:28:17.430", type: "agent", actor: "Счёт-агент", action: "вынес решение: реквизиты корректны, в пределах лимита договора", target: null, tag: "ok" },
    ],
  },
  {
    node: "n5", name: "Сверка с договором", events: [
      { ts: "14:30:02.118", type: "human", actor: "А. Кравцова", action: "приняла задачу из пула", target: "TSK-0092", tag: null },
      { ts: "14:31:48.640", type: "human", actor: "А. Кравцова", action: "подтвердила сверку, оставила комментарий", target: null, tag: "ok",
        meta: { dur: "1 м 46 с", tok: "—", cost: "—" },
        payload: { call: "комментарий оператора", out: "«Сумма НДС совпадает с актом. К оплате.»" } },
    ],
  },
  {
    node: "n7", name: "Утверждение платежа", events: [
      { ts: "14:31:50.002", type: "agent", actor: "Счёт-агент", action: "запросил инициацию платежа", target: "mcp://payments.initiate", tag: "mcp", tool: true,
        meta: { dur: "—", tok: "840 ткн", cost: "₽0.60" },
        payload: { call: "payments.initiate(amount=184000, ccy=RUB)", out: "{ error: \"AMOUNT_OVER_AUTONOMY\", limit: 50000 }" } },
      { ts: "14:31:50.214", type: "agent", actor: "Счёт-агент", action: "превысил порог автономии — эскалация", target: "₽184 000 > ₽50 000", tag: "esc" },
      { ts: "14:31:50.330", type: "service", actor: "control-plane", action: "создал задачу утверждения и назначил", target: "Е. Ларина", tag: "budget",
        meta: { dur: "—", tok: "—", cost: "—" },
        payload: { call: "escalate(to=\"Е. Ларина\", role=\"Финансовый директор\")", out: "{ task: \"TSK-0093\", sla_min: 480 }" } },
      { ts: "14:34:53.770", type: "human", actor: "Е. Ларина", action: "ожидает решения по утверждению платежа", target: "TSK-0093", tag: null, pending: true },
    ],
  },
];

function AuditEventRich({ ev }) {
  const [open, setOpen] = useState(false);
  const isTool = !!ev.tool;
  const expandable = !!ev.payload;
  return (
    <div className={`chs-ev ${isTool ? "chs-ev--toolcall" : ""}`} onClick={() => expandable && setOpen((o) => !o)}>
      <div className="chs-ev__time">{ev.ts}</div>
      <div className="chs-ev__rail">
        <div className={`chs-ev__node chs-ev__node--${ev.type}`}><ExecGlyph type={ev.type} size={8} /></div>
      </div>
      <div className="chs-ev__body">
        <div className="chs-ev__line">
          <span className={`chs-ev__actor chs-ev__actor--${ev.type}`}>{ev.actor}</span>
          <span>{ev.action}</span>
          {ev.target && <MonoId chip>{ev.target}</MonoId>}
          {ev.tag === "mcp" && <span className="chs-ev__tag chs-ev__tag--mcp">MCP</span>}
          {ev.tag === "esc" && <span className="chs-ev__tag chs-ev__tag--esc">эскалация</span>}
          {ev.tag === "ok" && <span className="chs-ev__tag chs-ev__tag--ok">ok</span>}
          {ev.tag === "budget" && <span className="chs-ev__tag chs-ev__tag--budget">control-plane</span>}
          {expandable && <span className="chs-ev__caret">{open ? "▾ свернуть" : "▸ payload"}</span>}
        </div>
        {ev.meta && (
          <div className="chs-ev__meta">
            <span><b>{ev.meta.dur}</b> длит.</span>
            <span><b>{ev.meta.tok}</b></span>
            <span><b>{ev.meta.cost}</b></span>
          </div>
        )}
        {expandable && open && (
          <div className="chs-ev__payload">
            <div className="chs-ev__payrow"><span className="chs-ev__payk">вход</span><span className="chs-ev__payv">{ev.payload.call}</span></div>
            <div className="chs-ev__payrow"><span className="chs-ev__payk">выход</span><span className="chs-ev__payv">{ev.payload.out}</span></div>
          </div>
        )}
      </div>
    </div>
  );
}

function AuditScreen() {
  const flat = [];
  return (
    <div className="chs-audit-screen">
      {/* Заголовок инстанса */}
      <div className="chs-inst">
        <div className="chs-inst__top">
          <div>
            <h1 className="chs-inst__title">
              {INSTANCE.process}
              <StatusChip status={INSTANCE.status} />
            </h1>
            <div className="chs-inst__sub">
              <MonoId chip>{INSTANCE.id}</MonoId>
              <span className="chs-crumbs__sep">/</span>
              <MonoId>{INSTANCE.procId}</MonoId>
              <span className="chs-crumbs__sep">/</span>
              <span>текущий узел: <Mono style={{ color: "var(--chs-color-text)" }}>{INSTANCE.node}</Mono></span>
            </div>
          </div>
          <div className="chs-inst__execs">
            {INSTANCE.execs.map((t) => (
              <span className={`chs-inst__execdot chs-inst__execdot--${t}`} key={t} title={EXEC_META[t].label}>
                <ExecGlyph type={t} size={11} />
              </span>
            ))}
          </div>
        </div>
        <div className="chs-inst__facts">
          <div className="chs-statcell"><span className="chs-statcell__k">Запущен</span><span className="chs-statcell__v"><Mono>{INSTANCE.started}</Mono></span></div>
          <div className="chs-statcell"><span className="chs-statcell__k">В работе</span><span className="chs-statcell__v"><Mono>{INSTANCE.elapsed}</Mono></span></div>
          {INSTANCE.budget.map((b) => (
            <div className="chs-statcell" key={b.label} style={{ minWidth: "180px" }}>
              <BudgetMeter label={b.label} used={b.used} total={b.total} unit={b.unit} fmt={b.money ? (n) => "₽" + n.toLocaleString("ru-RU") : (n) => n.toLocaleString("ru-RU")} />
            </div>
          ))}
        </div>
      </div>

      {/* Трасса */}
      <div className="chs-trace">
        {TRACE.map((step) => {
          flat.length = 0;
          return (
            <div className="chs-tracestep" key={step.node}>
              <div className="chs-tracestep__head">
                <span className="chs-tracestep__node">{step.node}</span>
                <span className="chs-tracestep__name">{step.name}</span>
                <span className="chs-tracestep__line" />
              </div>
              {step.events.map((ev, i) => (
                <AuditEventRich key={i} ev={ev} last={i === step.events.length - 1} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default AuditScreen;
