/* ============================================================================
   CHOROS — components.jsx
   Доменные примитивы. Глифы исполнителей: Человек=круг, Агент=ромб, Сервис=квадрат
   (форма дублирует цвет — узнаваемость без опоры только на оттенок).
   ============================================================================ */

import React from 'react';

const EXEC_META = {
  human:   { label: "Человек", cls: "chs-exec--human",   color: "var(--chs-exec-human)" },
  agent:   { label: "Агент",   cls: "chs-exec--agent",   color: "var(--chs-exec-agent)" },
  service: { label: "Сервис",  cls: "chs-exec--service", color: "var(--chs-exec-service)" },
};

/* Глиф исполнителя — простая геометрия (круг/ромб/квадрат) */
function ExecGlyph({ type, size = 9, filled = true }) {
  const color = EXEC_META[type]?.color || "currentColor";
  const fill = filled ? color : "none";
  const common = { fill, stroke: color, strokeWidth: 1.4 };
  return (
    <svg className="chs-exec__glyph" width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
      {type === "human"   && <circle cx="5" cy="5" r="4" {...common} />}
      {type === "agent"   && <rect x="5" y="-0.5" width="7.78" height="7.78" transform="rotate(45 5 5)" rx="0.6" {...common} />}
      {type === "service" && <rect x="1" y="1" width="8" height="8" rx="0.8" {...common} />}
    </svg>
  );
}

/* ExecutorBadge — единый цвето-иконочный код типа исполнителя */
function ExecutorBadge({ type = "human", label, name, bare = false, showLabel = true }) {
  const meta = EXEC_META[type] || EXEC_META.human;
  return (
    <span className={`chs-exec ${meta.cls} ${bare ? "chs-exec--bare" : ""}`} title={meta.label}>
      <ExecGlyph type={type} />
      {showLabel && <span>{name || label || meta.label}</span>}
    </span>
  );
}

/* MonoId — машинный идентификатор */
function MonoId({ children, prefix, chip = false }) {
  const cls = `chs-monoid ${chip ? "chs-monoid--chip" : ""}`;
  // Расщепляем префикс только для простых строк; иначе рендерим как есть.
  if (typeof children !== "string") {
    return <span className={cls}>{children}</span>;
  }
  let pre = prefix, rest = children;
  if (!prefix && children.includes("-")) {
    const i = children.indexOf("-");
    pre = children.slice(0, i);
    rest = children.slice(i);
  }
  return (
    <span className={cls}>
      {pre && <span className="chs-monoid__pre">{pre}</span>}{rest}
    </span>
  );
}

/* Mono — общий машинный вывод (числа/таймстампы) */
function Mono({ children, className = "", ...rest }) {
  return <span className={`chs-mono ${className}`} {...rest}>{children}</span>;
}

/* StatusChip */
const STATUS_META = {
  running: { label: "Выполняется", cls: "chs-chip--running" },
  done:    { label: "Завершено",   cls: "chs-chip--done" },
  failed:  { label: "Ошибка",      cls: "chs-chip--failed" },
  waiting: { label: "Ожидание",    cls: "chs-chip--waiting" },
  paused:  { label: "Пауза",       cls: "chs-chip--paused" },
};
function StatusChip({ status = "running", label }) {
  const meta = STATUS_META[status] || STATUS_META.running;
  return (
    <span className={`chs-chip ${meta.cls}`}>
      <span className="chs-chip__dot" />
      {label || meta.label}
    </span>
  );
}

/* Button */
function Button({ variant = "secondary", size, children, glyph, ...rest }) {
  return (
    <button className={`chs-btn chs-btn--${variant} ${size === "sm" ? "chs-btn--sm" : ""}`} {...rest}>
      {glyph}
      {children}
    </button>
  );
}

/* Input field */
function Field({ label, mono = false, invalid = false, hint, ...rest }) {
  return (
    <label className="chs-field">
      {label && <span className="chs-label">{label}</span>}
      <input
        className={`chs-input ${mono ? "chs-input--mono" : ""} ${invalid ? "chs-input--invalid" : ""}`}
        {...rest}
      />
      {hint && <span style={{ fontSize: "var(--chs-text-xs)", color: invalid ? "var(--chs-color-danger)" : "var(--chs-color-text-faint)" }}>{hint}</span>}
    </label>
  );
}

/* BudgetMeter — расход бюджета (токены/деньги), моноширинные числа */
function BudgetMeter({ used = 0, total = 100, unit = "", label, fmt }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const state = pct >= 100 ? "over" : pct >= 80 ? "warn" : "ok";
  const format = fmt || ((n) => n.toLocaleString("ru-RU"));
  return (
    <div className="chs-budget">
      <div className="chs-budget__head">
        {label && <span style={{ fontSize: "var(--chs-text-xs)", color: "var(--chs-color-text-muted)" }}>{label}</span>}
        <span className="chs-budget__val">
          {format(used)}<span className="chs-budget__total"> / {format(total)}{unit ? " " + unit : ""}</span>
        </span>
      </div>
      <div className="chs-budget__track">
        <div className={`chs-budget__fill ${state === "warn" ? "chs-budget__fill--warn" : ""} ${state === "over" ? "chs-budget__fill--over" : ""}`} style={{ width: pct + "%" }} />
      </div>
    </div>
  );
}

/* ReservationMeter — расход с РЕЗЕРВИРОВАНИЕМ: две крыши (на инстанс / на агента).
   Трек = потолок на агента; отметка = крыша на инстанс; заливка = фактический расход. */
function ReservationMeter({ used = 0, instanceCap = 0, agentCap = 0, unit = "", label, fmt }) {
  const format = fmt || ((n) => n.toLocaleString("ru-RU"));
  const max = agentCap || instanceCap || 1;
  const pctUsed = Math.max(0, Math.min(100, (used / max) * 100));
  const pctInst = Math.max(0, Math.min(100, (instanceCap / max) * 100));
  const ratio = instanceCap > 0 ? used / instanceCap : 0;
  const state = ratio >= 1 ? "over" : ratio >= 0.8 ? "warn" : "ok";
  return (
    <div className="chs-resv">
      <div className="chs-resv__head">
        {label && <span className="chs-resv__label">{label}</span>}
        <span className="chs-resv__val">
          {format(used)}<span className="chs-resv__den"> / {format(instanceCap)}{unit ? " " + unit : ""}</span>
        </span>
      </div>
      <div className="chs-resv__track">
        <div className="chs-resv__reserved" style={{ width: pctInst + "%" }} />
        <div className={`chs-resv__fill chs-resv__fill--${state}`} style={{ width: pctUsed + "%" }} />
        <span className="chs-resv__cap chs-resv__cap--inst" style={{ left: pctInst + "%" }} />
      </div>
      <div className="chs-resv__legend">
        <span className="chs-resv__roof"><i className="chs-roof chs-roof--inst" />на&nbsp;инстанс <b>{format(instanceCap)}{unit ? " " + unit : ""}</b></span>
        <span className="chs-resv__roof"><i className="chs-roof chs-roof--agent" />на&nbsp;агента <b>{format(agentCap)}{unit ? " " + unit : ""}</b></span>
      </div>
    </div>
  );
}

/* RoleAssignment — НАЗНАЧЕНИЕ роли (read): роль · орг-охват · срок действия */
function RoleAssignment({ role, scope, validity, expiring = false, onOpen }) {
  return (
    <div className={`chs-asgn ${onOpen ? "chs-asgn--link" : ""}`} onClick={onOpen}>
      <div className="chs-asgn__main">
        <span className="chs-asgn__dot" />
        <span className="chs-asgn__role">{role}</span>
      </div>
      <div className="chs-asgn__scope"><span className="chs-asgn__scopeglyph" />{scope}</div>
      <div className={`chs-asgn__validity ${expiring ? "chs-asgn__validity--exp" : ""}`}>{validity}</div>
    </div>
  );
}

/* OpKbd — операция гранта (read/write/invoke) — машинный «scope»-чип */
function OpChip({ op }) {
  return <span className={`chs-op chs-op--${op}`}>{op}</span>;
}

/* DerivedChip — производный артефакт (инструмент/поле), помечен как НЕ редактируемый */
function DerivedChip({ children, kind = "tool", state }) {
  return (
    <span className={`chs-derived chs-derived--${kind} ${state ? "chs-derived--" + state : ""}`}>
      <span className="chs-derived__glyph" />{children}
    </span>
  );
}

/* TaskRow — плотная строка задачи процесса */
function TaskRow({ status = "running", name, sub, execType = "human", execName, id, budget, ts }) {
  const markerColor = {
    running: "var(--chs-color-info)", done: "var(--chs-color-success)",
    failed: "var(--chs-color-danger)", waiting: "var(--chs-color-warning)",
    paused: "var(--chs-color-text-faint)",
  }[status];
  return (
    <div className="chs-taskrow">
      <span className="chs-taskrow__marker" style={{ background: markerColor }} />
      <div className="chs-taskrow__name">{name}{sub && <small>{sub}</small>}</div>
      <ExecutorBadge type={execType} name={execName} />
      <MonoId>{id}</MonoId>
      <BudgetMeter used={budget?.used} total={budget?.total} unit={budget?.unit} />
      <Mono className="chs-budget__total" >{ts}</Mono>
    </div>
  );
}

/* AuditEvent — строка аудит-лога */
function AuditEvent({ ts, actorType = "service", actor, action, target }) {
  return (
    <div className="chs-audit">
      <span className="chs-audit__time">{ts}</span>
      <span className="chs-audit__rail"><ExecGlyph type={actorType} size={8} /></span>
      <span className="chs-audit__body">
        <b>{actor}</b> {action} {target && <MonoId chip>{target}</MonoId>}
      </span>
    </div>
  );
}

export {
  ExecGlyph, ExecutorBadge, MonoId, Mono, StatusChip, Button, Field,
  BudgetMeter, ReservationMeter, RoleAssignment, OpChip, DerivedChip,
  TaskRow, AuditEvent, EXEC_META, STATUS_META,
};
