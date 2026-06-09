/* ============================================================================
   CHOROS — screen-inbox.jsx
   ЭКРАН 2: плотная таблица инбокса задач.
   Колонки: задача · процесс (MonoId) · тип исполнителя · SLA · дедлайн ·
   действие «взять из пула».
   ============================================================================ */

import React, { useState, useMemo } from 'react';
import { Button, MonoId, Mono, ExecutorBadge } from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';

const TASKS = [
  { id: "t1", status: "running", name: "Проверить реквизиты счёта №4471", step: "Согласование счёта · узел Проверка", inst: "INS-7731", execType: "agent", execName: "Счёт-агент", sla: { min: 120, left: 88 }, due: "07.06 16:40" },
  { id: "t2", status: "waiting", name: "Подтвердить возврат средств клиенту", step: "Возврат · узел Утверждение", inst: "INS-7702", execType: "human", execName: "А. Кравцова", sla: { min: 240, left: 42 }, due: "07.06 15:12" },
  { id: "t3", status: "waiting", name: "Сверить платёж с договором ДГ-2231", step: "Закрытие месяца · узел Сверка", inst: "INS-7698", pool: true, sla: { min: 180, left: 175 }, due: "07.06 19:55" },
  { id: "t4", status: "running", name: "Распознать вложение invoice_4480.pdf", step: "Согласование счёта · узел OCR", inst: "INS-7731", execType: "service", execName: "ocr-gateway", sla: { min: 5, left: 2 }, due: "07.06 14:33" },
  { id: "t5", status: "waiting", name: "Классифицировать обращение #88214", step: "Поддержка · узел Триаж", inst: "INS-7740", execType: "agent", execName: "Триаж-агент", sla: { min: 30, left: 7 }, due: "07.06 14:38" },
  { id: "t6", status: "failed", name: "Эскалация: спор по возврату #88190", step: "Поддержка · узел L2", inst: "INS-7733", pool: true, sla: { min: 60, left: -14 }, due: "07.06 14:05" },
  { id: "t7", status: "waiting", name: "Утвердить платёж поставщику > ₽50 000", step: "Согласование счёта · эскалация", inst: "INS-7731", execType: "human", execName: "Е. Ларина", sla: { min: 480, left: 360 }, due: "07.06 22:30" },
  { id: "t8", status: "running", name: "Синхронизировать проводки за 06.06", step: "Закрытие месяца · узел Синк", inst: "INS-7690", execType: "service", execName: "ledger-sync", sla: { min: 15, left: 11 }, due: "07.06 14:48" },
  { id: "t9", status: "waiting", name: "Проверить контрагента (KYC) ООО «Вектор»", step: "Онбординг · узел Комплаенс", inst: "INS-7755", pool: true, sla: { min: 720, left: 540 }, due: "08.06 01:10" },
  { id: "t10", status: "waiting", name: "Ответить на запрос статуса возврата", step: "Поддержка · узел Ответ", inst: "INS-7733", execType: "agent", execName: "Триаж-агент", sla: { min: 30, left: 24 }, due: "07.06 14:55" },
  { id: "t11", status: "waiting", name: "Согласовать акт сверки за май", step: "Закрытие месяца · узел Утверждение", inst: "INS-7698", pool: true, sla: { min: 1440, left: 980 }, due: "08.06 09:00" },
  { id: "t12", status: "running", name: "Инициировать платёж по счёту №4468", step: "Согласование счёта · узел Платёж", inst: "INS-7729", execType: "agent", execName: "Счёт-агент", sla: { min: 60, left: 31 }, due: "07.06 15:08" },
];

const TABS = [
  { id: "all", label: "Все" },
  { id: "mine", label: "Мне" },
  { id: "pool", label: "Из пула" },
  { id: "esc", label: "Эскалации" },
];

const MARKER_COLOR = {
  running: "var(--chs-color-info)", done: "var(--chs-color-success)",
  failed: "var(--chs-color-danger)", waiting: "var(--chs-color-warning)", paused: "var(--chs-color-text-faint)",
};

function SLACell({ sla }) {
  const pct = Math.max(0, Math.min(100, (sla.left / sla.min) * 100));
  const over = sla.left < 0;
  const warn = !over && pct <= 25;
  const cls = over ? "over" : warn ? "warn" : "";
  const txt = over ? `−${Math.abs(sla.left)} мин` : `${sla.left} мин`;
  return (
    <span className="chs-sla">
      <span className="chs-sla__bar"><span className={`chs-sla__fill ${cls ? "chs-sla__fill--" + cls : ""}`} style={{ width: (over ? 100 : pct) + "%" }} /></span>
      <span className={`chs-sla__txt ${cls ? "chs-sla__txt--" + cls : ""}`}>{txt}</span>
    </span>
  );
}

function InboxScreen() {
  const [tab, setTab] = useState("all");
  const [taken, setTaken] = useState(() => ({}));

  const counts = useMemo(() => ({
    all: TASKS.length,
    mine: TASKS.filter((t) => t.execName === "А. Кравцова" || t.execName === "Е. Ларина").length,
    pool: TASKS.filter((t) => t.pool && !taken[t.id]).length,
    esc: TASKS.filter((t) => t.step.includes("эскалация") || t.step.includes("L2") || t.status === "failed").length,
  }), [taken]);

  const rows = useMemo(() => {
    return TASKS.filter((t) => {
      if (tab === "mine") return t.execName === "А. Кравцова" || t.execName === "Е. Ларина" || taken[t.id];
      if (tab === "pool") return t.pool && !taken[t.id];
      if (tab === "esc") return t.step.includes("эскалация") || t.step.includes("L2") || t.status === "failed";
      return true;
    });
  }, [tab, taken]);

  return (
    <div className="chs-inbox">
      <div className="chs-inbox__bar">
        <div className="chs-tabs">
          {TABS.map((t) => (
            <button key={t.id} className="chs-tab" aria-selected={tab === t.id ? "true" : undefined} onClick={() => setTab(t.id)}>
              {t.label}<span className="chs-tab__count">{counts[t.id]}</span>
            </button>
          ))}
        </div>
        <div className="chs-inbox__spacer" />
        <button className="chs-inbox__filter"><Icon name="filter" /> Тип исполнителя</button>
        <button className="chs-inbox__filter">SLA ↑</button>
      </div>

      <div className="chs-inbox__scroll">
        <table className="chs-itable">
          <colgroup>
            <col style={{ width: "auto" }} />
            <col style={{ width: "108px" }} />
            <col style={{ width: "176px" }} />
            <col style={{ width: "132px" }} />
            <col style={{ width: "108px" }} />
            <col style={{ width: "132px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Задача</th>
              <th>Процесс</th>
              <th>Исполнитель</th>
              <th>SLA</th>
              <th>Дедлайн</th>
              <th className="chs-r">Действие</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const isTaken = !!taken[t.id];
              const inPool = t.pool && !isTaken;
              return (
                <tr key={t.id} data-taken={isTaken ? "true" : undefined}>
                  <td>
                    <div className="chs-task">
                      <span className="chs-task__marker" style={{ background: MARKER_COLOR[t.status] }} />
                      <span className="chs-task__txt">
                        <span className="chs-task__name">{t.name}</span>
                        <span className="chs-task__step">{t.step}</span>
                      </span>
                    </div>
                  </td>
                  <td><MonoId>{t.inst}</MonoId></td>
                  <td>
                    {inPool ? (
                      <span className="chs-pool"><span className="chs-pool__glyph" /> в пуле</span>
                    ) : isTaken ? (
                      <ExecutorBadge type="human" name="М. Соколов" />
                    ) : (
                      <ExecutorBadge type={t.execType} name={t.execName} />
                    )}
                  </td>
                  <td><SLACell sla={t.sla} /></td>
                  <td><Mono style={{ color: "var(--chs-color-text-muted)", fontSize: "var(--chs-text-sm)" }}>{t.due}</Mono></td>
                  <td className="chs-r">
                    {inPool ? (
                      <Button variant="secondary" size="sm" onClick={() => setTaken((s) => ({ ...s, [t.id]: true }))}>Взять</Button>
                    ) : isTaken ? (
                      <span className="chs-taken-tag"><Icon name="check" /> взято</span>
                    ) : (
                      <Button variant="ghost" size="sm">Открыть</Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default InboxScreen;
