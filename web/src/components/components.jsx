/* ============================================================================
   CHOROS — components.jsx
   Доменные примитивы. Глифы исполнителей: Человек=круг, Агент=ромб, Сервис=квадрат
   (форма дублирует цвет — узнаваемость без опоры только на оттенок).
   ============================================================================ */

import React from 'react';
const { useState, useEffect, useRef, useCallback, useId } = React;
import { KNOWN_NAMES } from '../design/icon-registry.js';

/* ----------------------------------------------------------------------------
   Kit-иконки — линейные, в стиле Lucide (stroke 1.6, currentColor, без эмодзи;
   см. design/principles.md §2). Локальные для kit, чтобы примитивы были
   самодостаточны и не зависели от app-shell/icon.jsx (нет циклов, грузятся в
   витрину через babel-standalone). Размер наследуется от размера шрифта (1em).
   ---------------------------------------------------------------------------- */
function KitIcon({ name, size, className = "", strokeWidth = 1.6 }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth, strokeLinecap: "round", strokeLinejoin: "round" };
  const dim = size || "1em";
  return (
    <svg className={`chs-kiticon ${className}`} viewBox="0 0 16 16" width={dim} height={dim} aria-hidden="true" focusable="false">
      {name === "close"     && (<path {...p} d="M4 4l8 8M12 4l-8 8" />)}
      {name === "alert"     && (<><path {...p} d="M8 2.5L14.5 13.5H1.5z" /><path {...p} d="M8 6.5v3.2" /><circle cx="8" cy="11.6" r="0.8" fill="currentColor" stroke="none" /></>)}
      {name === "error"     && (<><circle {...p} cx="8" cy="8" r="6" /><path {...p} d="M8 4.6v4.2" /><circle cx="8" cy="11" r="0.8" fill="currentColor" stroke="none" /></>)}
      {name === "info"      && (<><circle {...p} cx="8" cy="8" r="6" /><path {...p} d="M8 7.4v3.6" /><circle cx="8" cy="5.2" r="0.8" fill="currentColor" stroke="none" /></>)}
      {name === "success"   && (<><circle {...p} cx="8" cy="8" r="6" /><path {...p} d="M5.3 8.2l1.9 1.9L11 6.2" /></>)}
      {name === "retry"     && (<><path {...p} d="M13 8a5 5 0 1 1-1.5-3.55" /><path {...p} d="M13 2.5V5h-2.5" /></>)}
      {name === "inbox"     && (<><path {...p} d="M2 4.5h12v7H2z" /><path {...p} d="M2 9.5h3l1 1.5h4l1-1.5h3" /></>)}
      {name === "plus"      && (<path {...p} d="M8 3v10M3 8h10" />)}
      {name === "chevron-down"    && (<path {...p} d="M3.5 6l4.5 4 4.5-4" />)}
      {/* ── T-0531 additions ──────────────────────────────────────────── */}
      {name === "star"            && (<><path {...p} d="M8 2l1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4-2.9-2.8 4-.6z" fill="currentColor" stroke="none" /></>)}
      {name === "star-outline"    && (<><path {...p} d="M8 2l1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4-2.9-2.8 4-.6z" /></>)}
      {name === "pencil"          && (<><path {...p} d="M11.5 2.5l2 2-8 8-2.5.5.5-2.5z" /><path {...p} d="M10 4l2 2" /></>)}
      {name === "trash"           && (<><path {...p} d="M3 4.5h10M5.5 4.5V3h5v1.5M6 7v4.5M10 7v4.5" /><rect {...p} x="4" y="4.5" width="8" height="9" rx="1" /></>)}
      {name === "arrow-up"        && (<path {...p} d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />)}
      {name === "arrow-down"      && (<path {...p} d="M8 3v10M3.5 8.5L8 13l4.5-4.5" />)}
      {name === "arrow-left"      && (<path {...p} d="M13 8H3M7.5 3.5L3 8l4.5 4.5" />)}
      {name === "more-horizontal" && (<><circle cx="3.5" cy="8" r="1.2" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" /><circle cx="12.5" cy="8" r="1.2" fill="currentColor" stroke="none" /></>)}
      {name === "check"           && (<path {...p} d="M3 8.5l3.5 3.5 6.5-7" />)}
      {name === "external-link"   && (<><path {...p} d="M7 3H3v10h10V9" /><path {...p} d="M10 2h4v4" /><path {...p} d="M8 8L14 2" /></>)}
      {name === "search"          && (<><circle {...p} cx="7" cy="7" r="4.5" /><path {...p} d="M10.5 10.5l3 3" /></>)}
      {name === "chevron-up"      && (<path {...p} d="M3.5 10l4.5-4 4.5 4" />)}
      {name === "lock"            && (<><rect {...p} x="3" y="7" width="10" height="8" rx="1" /><path {...p} d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>)}
      {/* ── fallback: unknown name → visible placeholder + dev-warn ─── */}
      {!KNOWN_NAMES.has(name) && (
        <>
          {typeof process !== 'undefined' && process.env.NODE_ENV !== 'production' &&
            // eslint-disable-next-line no-console
            console.warn(`[KitIcon] Unknown name: "${name}". Add it to icon-registry.js.`)}
          <rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
          <path d="M5 5l6 6M11 5l-6 6" fill="none" stroke="currentColor" strokeWidth="1" />
        </>
      )}
    </svg>
  );
}

/* Spinner — индикатор загрузки. prefers-reduced-motion гасит вращение (CSS). */
function Spinner({ size, className = "" }) {
  const dim = size || "1em";
  return (
    <svg className={`chs-spinner ${className}`} viewBox="0 0 16 16" width={dim} height={dim} aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeOpacity="0.22" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

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
  const displayName = name || label || meta.label;
  return (
    <span
      className={`chs-exec ${meta.cls} ${bare ? "chs-exec--bare" : ""}`}
      aria-label={showLabel ? undefined : meta.label}
      title={meta.label}
    >
      <ExecGlyph type={type} />
      {showLabel && <span>{displayName}</span>}
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
      {/* Dot is decorative — colour/shape duplicates the text label (§1.4.1) */}
      <span className="chs-chip__dot" aria-hidden="true" />
      {label || meta.label}
    </span>
  );
}

/* Button — варианты/размеры + disabled (aria-disabled), loading (spinner +
   aria-busy + блок клика), видимый :focus-visible ring (--chs-color-focus-ring). */
function Button({ variant = "secondary", size, children, glyph, loading = false, disabled = false, className = "", ...rest }) {
  const isDisabled = disabled || loading;
  return (
    <button
      type={rest.type || "button"}
      className={`chs-btn chs-btn--${variant} ${size === "sm" ? "chs-btn--sm" : ""} ${loading ? "chs-btn--loading" : ""} ${className}`}
      disabled={isDisabled}
      aria-disabled={isDisabled || undefined}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner className="chs-btn__spinner" /> : glyph}
      {children}
    </button>
  );
}

/* Input field — явная привязка label↔input (htmlFor/id), aria-invalid на ошибке,
   hint как aria-describedby, видимый фокус-ринг (через .chs-input). Обе темы
   читаемы (токены). id автогенерится, если не передан. */
function Field({ label, mono = false, invalid = false, hint, id, className = "", ...rest }) {
  const autoId = useId();
  const inputId = id || `chs-field-${autoId}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  return (
    <div className="chs-field">
      {label && <label className="chs-label" htmlFor={inputId}>{label}</label>}
      <input
        id={inputId}
        className={`chs-input ${mono ? "chs-input--mono" : ""} ${invalid ? "chs-input--invalid" : ""} ${className}`}
        aria-invalid={invalid || undefined}
        aria-describedby={hintId}
        {...rest}
      />
      {hint && <span id={hintId} className={`chs-hint ${invalid ? "chs-hint--invalid" : ""}`}>{hint}</span>}
    </div>
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

/* RoleAssignment — НАЗНАЧЕНИЕ роли (read): роль · орг-охват · срок действия.
   A11y (T-0529): если onOpen передан — превращаем в button (keyboard-доступен). */
function RoleAssignment({ role, scope, validity, expiring = false, onOpen }) {
  if (onOpen) {
    return (
      <button
        type="button"
        className={`chs-asgn chs-asgn--link`}
        onClick={onOpen}
        aria-label={`Роль ${role}, область ${scope}, действует ${validity}${expiring ? ', истекает скоро' : ''}`}
      >
        <div className="chs-asgn__main">
          <span className="chs-asgn__dot" aria-hidden="true" />
          <span className="chs-asgn__role">{role}</span>
        </div>
        <div className="chs-asgn__scope"><span className="chs-asgn__scopeglyph" aria-hidden="true" />{scope}</div>
        <div className={`chs-asgn__validity ${expiring ? "chs-asgn__validity--exp" : ""}`}>{validity}</div>
      </button>
    );
  }
  return (
    <div className="chs-asgn">
      <div className="chs-asgn__main">
        <span className="chs-asgn__dot" aria-hidden="true" />
        <span className="chs-asgn__role">{role}</span>
      </div>
      <div className="chs-asgn__scope"><span className="chs-asgn__scopeglyph" aria-hidden="true" />{scope}</div>
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

/* ============================================================================
   ОБЯЗАТЕЛЬНЫЙ KIT (OBLIK §2.1) — поверхности и состояния, которые экраны
   сейчас собирают руками инлайн-стилями. Все цвета/отступы/тени/радиусы — из
   токенов --chs-*; ноль хардкода. a11y по design/principles.md §4/§6.
   ============================================================================ */

/* ----- focus-trap + scroll-lock — общая механика для Modal/Drawer ----- */
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled])', 'select:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/* Блокирует прокрутку body, пока хотя бы один оверлей открыт (рефкаунт). */
let _scrollLockCount = 0;
let _scrollLockPrev = "";
function lockBodyScroll() {
  if (typeof document === "undefined") return;
  if (_scrollLockCount === 0) {
    _scrollLockPrev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  _scrollLockCount += 1;
}
function unlockBodyScroll() {
  if (typeof document === "undefined") return;
  _scrollLockCount = Math.max(0, _scrollLockCount - 1);
  if (_scrollLockCount === 0) document.body.style.overflow = _scrollLockPrev;
}

/* Фокус-ловушка: фокус на первый элемент при открытии, цикл Tab/Shift-Tab внутри
   panelRef, восстановление фокуса на триггер при закрытии, scroll-lock + Esc. */
function useFocusTrap({ open, panelRef, onClose, closeOnEsc = true }) {
  const restoreRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    restoreRef.current = typeof document !== "undefined" ? document.activeElement : null;
    lockBodyScroll();

    const panel = panelRef.current;
    // фокус на первый фокусируемый элемент панели (или саму панель)
    const focusables = panel ? panel.querySelectorAll(FOCUSABLE) : [];
    if (focusables.length) focusables[0].focus();
    else if (panel) panel.focus();

    function onKeyDown(e) {
      if (e.key === "Escape" && closeOnEsc) {
        e.stopPropagation();
        onClose && onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = panel.querySelectorAll(FOCUSABLE);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault(); first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      unlockBodyScroll();
      const r = restoreRef.current;
      if (r && typeof r.focus === "function") r.focus();
    };
  }, [open, panelRef, onClose, closeOnEsc]);
}

/* ----------------------------- Modal / Dialog ----------------------------- */
/* Затемнённый оверлей (--chs-color-overlay + --chs-shadow-3, НЕ хардкод rgba),
   центрированная панель. role=dialog/aria-modal/aria-labelledby; фокус-ловушка;
   Esc и клик по оверлею закрывают; scroll-lock. Заменяет рукотворные модалки. */
function Modal({ open, onClose, title, children, footer, size = "md", closeOnOverlay = true, closeOnEsc = true, labelId }) {
  const panelRef = useRef(null);
  const autoId = useId();
  const headingId = labelId || (title ? `chs-modal-title-${autoId}` : undefined);
  useFocusTrap({ open, panelRef, onClose, closeOnEsc });
  if (!open) return null;
  return (
    <div className="chs-overlay" onClick={(e) => { if (closeOnOverlay && e.target === e.currentTarget) onClose && onClose(); }}>
      <div
        ref={panelRef}
        className={`chs-modal chs-modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
      >
        {title && (
          <div className="chs-modal__head">
            <h2 className="chs-modal__title" id={headingId}>{title}</h2>
            <button type="button" className="chs-overlay__close" aria-label="Закрыть" onClick={() => onClose && onClose()}>
              <KitIcon name="close" />
            </button>
          </div>
        )}
        <div className="chs-modal__body">{children}</div>
        {footer && <div className="chs-modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

/* -------------------------------- Drawer --------------------------------- */
/* Боковая панель (right/left). Та же a11y, что у Modal. */
function Drawer({ open, onClose, title, children, footer, side = "right", closeOnOverlay = true, closeOnEsc = true, labelId }) {
  const panelRef = useRef(null);
  const autoId = useId();
  const headingId = labelId || (title ? `chs-drawer-title-${autoId}` : undefined);
  useFocusTrap({ open, panelRef, onClose, closeOnEsc });
  if (!open) return null;
  return (
    <div className={`chs-overlay chs-overlay--drawer chs-overlay--${side}`} onClick={(e) => { if (closeOnOverlay && e.target === e.currentTarget) onClose && onClose(); }}>
      <div
        ref={panelRef}
        className={`chs-drawer chs-drawer--${side}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
      >
        {title && (
          <div className="chs-drawer__head">
            <h2 className="chs-drawer__title" id={headingId}>{title}</h2>
            <button type="button" className="chs-overlay__close" aria-label="Закрыть" onClick={() => onClose && onClose()}>
              <KitIcon name="close" />
            </button>
          </div>
        )}
        <div className="chs-drawer__body">{children}</div>
        {footer && <div className="chs-drawer__foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ------------------------------ EmptyState ------------------------------- */
/* Слот иконки + заголовок + описание + опциональный CTA. principles.md §6. */
function EmptyState({ icon, title, description, action, compact = false }) {
  return (
    <div className={`chs-state chs-state--empty ${compact ? "chs-state--compact" : ""}`} role="status">
      {icon && <div className="chs-state__icon">{icon}</div>}
      {title && <div className="chs-state__title">{title}</div>}
      {description && <div className="chs-state__desc">{description}</div>}
      {action && <div className="chs-state__action">{action}</div>}
    </div>
  );
}

/* --------------------------- LoadingState / Skeleton --------------------- */
/* Spinner + текст. prefers-reduced-motion гасит анимацию (CSS). */
function LoadingState({ label = "Загрузка…", compact = false }) {
  return (
    <div className={`chs-state chs-state--loading ${compact ? "chs-state--compact" : ""}`} role="status" aria-live="polite" aria-busy="true">
      <Spinner className="chs-state__spinner" />
      {label && <div className="chs-state__desc">{label}</div>}
    </div>
  );
}

/* Skeleton — shimmer-плейсхолдер. variant: line | block | circle.
   prefers-reduced-motion гасит мерцание (CSS), placeholder остаётся. */
function Skeleton({ variant = "line", width, height, count = 1, className = "" }) {
  const style = {};
  if (width != null) style.width = typeof width === "number" ? `${width}px` : width;
  if (height != null) style.height = typeof height === "number" ? `${height}px` : height;
  if (count > 1) {
    return (
      <div className={`chs-skeleton-group ${className}`} aria-hidden="true">
        {Array.from({ length: count }).map((_, i) => (
          <span key={i} className={`chs-skeleton chs-skeleton--${variant}`} style={style} />
        ))}
      </div>
    );
  }
  return <span className={`chs-skeleton chs-skeleton--${variant} ${className}`} style={style} aria-hidden="true" />;
}

/* ------------------------------- ErrorState ------------------------------ */
/* Иконка ошибки + сообщение + опциональная «Повторить». principles.md §6. */
function ErrorState({ title = "Что-то пошло не так", message, onRetry, retryLabel = "Повторить", compact = false }) {
  return (
    <div className={`chs-state chs-state--error ${compact ? "chs-state--compact" : ""}`} role="alert">
      <div className="chs-state__icon chs-state__icon--error"><KitIcon name="error" size={28} /></div>
      {title && <div className="chs-state__title">{title}</div>}
      {message && <div className="chs-state__desc">{message}</div>}
      {onRetry && (
        <div className="chs-state__action">
          <Button variant="secondary" size="sm" glyph={<KitIcon name="retry" className="chs-btn__glyph" />} onClick={onRetry}>{retryLabel}</Button>
        </div>
      )}
    </div>
  );
}

/* -------------------------------- Popover -------------------------------- */
/* Привязанная плавающая панель (меню/пикеры). Клик-вне и Esc закрывают; базовое
   позиционирование (placement bottom|top|left|right + align start|end|center).
   Триггер и панель оборачиваются в inline-relative контейнер.
   A11y (T-0529): focus-on-open, aria-haspopup/expanded/controls на триггере,
   role=dialog или menu в зависимости от isMenu prop. */
function Popover({ open, onClose, trigger, children, placement = "bottom", align = "start", className = "", isMenu = false }) {
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const autoId = useId();
  const panelId = `chs-popover-panel-${autoId}`;

  useEffect(() => {
    if (!open) return undefined;
    // Focus the panel on open so keyboard users can interact
    const t = setTimeout(() => {
      if (panelRef.current) {
        const focusable = panelRef.current.querySelector(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
        );
        if (focusable) focusable.focus();
        else panelRef.current.focus();
      }
    }, 0);
    function onDocPointer(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) onClose && onClose();
    }
    function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); onClose && onClose(); } }
    document.addEventListener("mousedown", onDocPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDocPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose]);

  // Clone the trigger element to inject aria-haspopup / aria-expanded / aria-controls
  const enhancedTrigger = trigger && React.isValidElement(trigger)
    ? React.cloneElement(trigger, {
        'aria-haspopup': isMenu ? 'menu' : 'dialog',
        'aria-expanded': open,
        'aria-controls': open ? panelId : undefined,
      })
    : trigger;

  return (
    <span className={`chs-popover-root ${className}`} ref={rootRef}>
      {enhancedTrigger}
      {open && (
        <div
          id={panelId}
          ref={panelRef}
          className={`chs-popover chs-popover--${placement} chs-popover--align-${align}`}
          role={isMenu ? "menu" : "dialog"}
          tabIndex={-1}
        >
          {children}
        </div>
      )}
    </span>
  );
}

/* -------------------------------- Tooltip -------------------------------- */
/* Подсказка по hover/focus; role=tooltip, доступна с клавиатуры (focus триггера).
   CSS показывает .chs-tooltip__bubble на :hover/:focus-within — работает без JS.
   A11y (T-0529): клонирует children чтобы добавить aria-describedby без лишнего
   focusable wrapper-span; Esc-dismiss. */
function Tooltip({ label, children, placement = "top", className = "" }) {
  const autoId = useId();
  const tipId = `chs-tip-${autoId}`;
  const [visible, setVisible] = useState(true);

  // Clone children to inject aria-describedby (no extra wrapper focusable element).
  // Falls back to wrapping span if children is not a single React element.
  let inner;
  if (React.isValidElement(children)) {
    inner = React.cloneElement(children, {
      'aria-describedby': tipId,
      onKeyDown: (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); setVisible(false); }
        // pass through original handler
        if (children.props.onKeyDown) children.props.onKeyDown(e);
      },
      onFocus: (e) => {
        setVisible(true);
        if (children.props.onFocus) children.props.onFocus(e);
      },
    });
  } else {
    // Fallback: wrap in a span (for plain text children)
    inner = (
      <span className="chs-tooltip__trigger" tabIndex={0} aria-describedby={tipId}
        onKeyDown={(e) => { if (e.key === 'Escape') setVisible(false); }}
        onFocus={() => setVisible(true)}
      >
        {children}
      </span>
    );
  }

  return (
    <span className={`chs-tooltip ${className}`}>
      {inner}
      {visible && (
        <span className={`chs-tooltip__bubble chs-tooltip__bubble--${placement}`} role="tooltip" id={tipId}>{label}</span>
      )}
    </span>
  );
}

/* --------------------------------- Toast --------------------------------- */
/* Транзиентное уведомление (success/error/info/warning через статус-токены).
   Авто-скрытие (duration, 0 = не скрывать) + ручное закрытие. role=status/alert.
   Низкоуровневый компонент — для очереди используй ToastViewport/useToasts. */
const TOAST_ICON = { success: "success", error: "error", info: "info", warning: "alert" };
function Toast({ tone = "info", title, message, onClose, action }) {
  return (
    <div className={`chs-toast chs-toast--${tone}`} role={tone === "error" || tone === "warning" ? "alert" : "status"} aria-live={tone === "error" || tone === "warning" ? "assertive" : "polite"}>
      <span className="chs-toast__icon"><KitIcon name={TOAST_ICON[tone] || "info"} size={16} /></span>
      <div className="chs-toast__body">
        {title && <div className="chs-toast__title">{title}</div>}
        {message && <div className="chs-toast__msg">{message}</div>}
      </div>
      {action && <div className="chs-toast__action">{action}</div>}
      {onClose && (
        <button type="button" className="chs-toast__close" aria-label="Закрыть" onClick={onClose}>
          <KitIcon name="close" size={14} />
        </button>
      )}
    </div>
  );
}

/* useToasts — лёгкая очередь тостов + ToastViewport (фикс-стек). push() ставит
   тост с авто-дисмиссом; компонент монтирует область сам.
   A11y (T-0529): pause-on-hover — viewportRef передаётся для очистки таймеров. */
function useToasts({ duration = 4000 } = {}) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  const timersRef = useRef({});
  const pausedRef = useRef(false);

  const dismiss = useCallback((id) => {
    clearTimeout(timersRef.current[id]);
    delete timersRef.current[id];
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const scheduleTimer = useCallback((id, d) => {
    clearTimeout(timersRef.current[id]);
    if (d > 0 && !pausedRef.current) {
      timersRef.current[id] = setTimeout(() => dismiss(id), d);
    }
  }, [dismiss]);

  const push = useCallback((toast) => {
    const id = ++idRef.current;
    const d = toast.duration != null ? toast.duration : duration;
    setToasts((ts) => [...ts, { ...toast, id, _duration: d }]);
    scheduleTimer(id, d);
    return id;
  }, [duration, scheduleTimer]);

  const pauseAll = useCallback(() => {
    pausedRef.current = true;
    Object.keys(timersRef.current).forEach((id) => {
      clearTimeout(timersRef.current[id]);
    });
  }, []);

  const resumeAll = useCallback((toastList) => {
    pausedRef.current = false;
    toastList.forEach((t) => {
      if (t._duration > 0) scheduleTimer(t.id, t._duration);
    });
  }, [scheduleTimer]);

  return { toasts, push, dismiss, pauseAll, resumeAll };
}

function ToastViewport({ toasts = [], dismiss, pauseAll, resumeAll, position = "bottom-right", ...rest }) {
  return (
    <div
      className={`chs-toast-viewport chs-toast-viewport--${position}`}
      onMouseEnter={() => pauseAll && pauseAll()}
      onMouseLeave={() => resumeAll && resumeAll(toasts)}
      onFocus={() => pauseAll && pauseAll()}
      onBlur={() => resumeAll && resumeAll(toasts)}
      {...rest}
    >
      {toasts.map((t) => (
        <Toast key={t.id} tone={t.tone} title={t.title} message={t.message} action={t.action} onClose={() => dismiss && dismiss(t.id)} />
      ))}
    </div>
  );
}

/* ----------------------------- ConfirmDialog ----------------------------- */
/* Тонкая обёртка над <Modal size="sm"> для подтверждения действия — заменяет
   нативный window.confirm. Footer = Отмена (ghost) + Подтвердить (вариант по
   tone: danger→danger, default→primary). a11y (фокус-ловушка/Esc/scroll-lock)
   наследуется от Modal. principles.md §4 (опасное действие = модал).

   Расширение T-0526: dual-control поле причины:
     reason            — текущее значение (string)
     onReasonChange    — callback(string), если передан — поле рендерится
     reasonRequired    — если true, «Подтвердить» заблокирован пока reason пуст
     reasonPlaceholder — placeholder текстового поля
*/
function ConfirmDialog({
  open, title, message,
  confirmLabel = "Подтвердить", cancelLabel = "Отмена",
  tone = "danger", onConfirm, onClose, loading = false,
  reason, onReasonChange, reasonRequired = false, reasonPlaceholder = "Укажите причину",
}) {
  const confirmVariant = tone === "danger" ? "danger" : "primary";
  const confirmDisabled = loading || (reasonRequired && onReasonChange && (!reason || !reason.trim()));
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={title}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={loading}>{cancelLabel}</Button>
        <Button variant={confirmVariant} onClick={onConfirm} loading={loading} disabled={confirmDisabled}>{confirmLabel}</Button>
      </>}
    >
      {message}
      {onReasonChange && (
        <div className="chs-confirm__reason">
          <Field
            label="Причина"
            value={reason || ""}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder={reasonPlaceholder}
            className="chs-confirm__reason-field"
          />
        </div>
      )}
    </Modal>
  );
}

/* -------------------------------- Select --------------------------------- */
/* Токен-стилизованный нативный <select> с привязкой label↔select (htmlFor/id),
   aria-invalid на ошибке, hint как aria-describedby. Читаем в ОБЕИХ темах
   (фон/текст/стрелка — токены). Нативный листбокс (без кастом-рендера): доступен
   с клавиатуры и экранным ридером из коробки. options: [{value,label,disabled}]
   ИЛИ строки; children рендерятся как есть, если переданы вместо options. */
function Select({
  label, options, value, onChange, invalid = false, hint,
  placeholder, id, className = "", children, ...rest
}) {
  const autoId = useId();
  const selectId = id || `chs-select-${autoId}`;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const opts = (options || []).map((o) =>
    typeof o === "object" && o !== null ? o : { value: o, label: String(o) }
  );
  return (
    <div className="chs-field">
      {label && <label className="chs-label" htmlFor={selectId}>{label}</label>}
      <div className="chs-select-wrap">
        <select
          id={selectId}
          className={`chs-input chs-select ${invalid ? "chs-input--invalid" : ""} ${className}`}
          value={value}
          onChange={onChange}
          aria-invalid={invalid || undefined}
          aria-describedby={hintId}
          {...rest}
        >
          {placeholder != null && <option value="" disabled>{placeholder}</option>}
          {children != null
            ? children
            : opts.map((o) => (
                <option key={String(o.value)} value={o.value} disabled={o.disabled}>{o.label}</option>
              ))}
        </select>
        <KitIcon name="chevron-down" className="chs-select__arrow" />
      </div>
      {hint && <span id={hintId} className={`chs-hint ${invalid ? "chs-hint--invalid" : ""}`}>{hint}</span>}
    </div>
  );
}

/* ============================================================================
   T-0547 — DataTable / Card / Badge
   Семантические примитивы с ARIA-ролями и токенами.
   ============================================================================ */

/* -------------------------------- Badge ---------------------------------- */
/* Inline-метка с тоном (нейтральный / info / success / warning / danger).
   Дублирует тон цвет+текстом (§1.4.1).
   a11y: aria-label если иконка без текста; иначе span декоративный. */
const BADGE_TONES = {
  neutral: "chs-badge--neutral",
  info:    "chs-badge--info",
  success: "chs-badge--success",
  warning: "chs-badge--warning",
  danger:  "chs-badge--danger",
};
function Badge({ tone = "neutral", children, className = "", ...rest }) {
  const cls = BADGE_TONES[tone] || BADGE_TONES.neutral;
  return (
    <span className={`chs-badge ${cls} ${className}`} {...rest}>
      {children}
    </span>
  );
}

/* --------------------------------- Card ---------------------------------- */
/* Поверхность с заголовком (head), телом и опциональным подвалом (foot).
   role=region + aria-labelledby привязывают заголовок к секции.
   Доступен без CSS (семантика не зависит от отображения). */
function Card({ title, children, footer, actions, className = "", labelId, role = "region", ...rest }) {
  const autoId = useId();
  const headingId = labelId || (title ? `chs-card-title-${autoId}` : undefined);
  return (
    <div
      className={`chs-card ${className}`}
      role={role}
      aria-labelledby={headingId}
      {...rest}
    >
      {title && (
        <div className="chs-card__head">
          <h2 className="chs-card__title" id={headingId}>{title}</h2>
          {actions && <div className="chs-card__actions">{actions}</div>}
        </div>
      )}
      <div className="chs-card__body">{children}</div>
      {footer && <div className="chs-card__foot">{footer}</div>}
    </div>
  );
}

/* ------------------------------- DataTable ------------------------------- */
/* Семантическая таблица: role=table + aria-label. Шапка sticky (top:0).
   Использует нативные <table>/<thead>/<tbody>/<tr>/<th>/<td> — AT (скринридеры,
   ВОЗ WCAG 2.1 SC 1.3.1) понимает таблицу без ARIA-обёрток.
   Классы .chs-table/.chs-num/.chs-r/.chs-c уже в components.css (DenseTable canon).

   Экспортируемые sub-компоненты: DataTableHead, DataTableBody,
   DataTableRow, DataTableCell, DataTableHeadCell.
   Позволяет миксовать нативный HTML (тонкая обёртка) без блокировки кастомизации. */

function DataTable({ children, label, caption, className = "", ...rest }) {
  return (
    <div className="chs-table-wrap" style={{ overflowX: 'auto' }}>
      <table
        className={`chs-table ${className}`}
        aria-label={label}
        {...rest}
      >
        {caption && <caption className="chs-sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

function DataTableHead({ children, ...rest }) {
  return <thead {...rest}>{children}</thead>;
}

function DataTableBody({ children, ...rest }) {
  return <tbody {...rest}>{children}</tbody>;
}

function DataTableRow({ children, onClick, highlighted = false, faded = false, className = "", ...rest }) {
  return (
    <tr
      className={`${highlighted ? "chs-table__row--hl" : ""} ${faded ? "chs-table__row--faded" : ""} ${className}`}
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
      {...rest}
    >
      {children}
    </tr>
  );
}

function DataTableHeadCell({ children, numeric = false, right = false, center = false, className = "", ...rest }) {
  const cls = [numeric || right ? "chs-num" : "", center ? "chs-c" : "", className].filter(Boolean).join(" ");
  return (
    <th className={cls || undefined} scope="col" {...rest}>
      {children}
    </th>
  );
}

function DataTableCell({ children, numeric = false, right = false, center = false, className = "", ...rest }) {
  const cls = [(numeric || right) ? "chs-num" : right ? "chs-r" : "", center ? "chs-c" : "", className].filter(Boolean).join(" ");
  return (
    <td className={cls || undefined} {...rest}>
      {children}
    </td>
  );
}

export {
  ExecGlyph, ExecutorBadge, MonoId, Mono, StatusChip, Button, Field, Select,
  BudgetMeter, ReservationMeter, RoleAssignment, OpChip, DerivedChip,
  TaskRow, AuditEvent, EXEC_META, STATUS_META,
  KitIcon, Spinner,
  Modal, Drawer, ConfirmDialog, EmptyState, LoadingState, Skeleton, ErrorState,
  Popover, Tooltip, Toast, ToastViewport, useToasts,
  Badge, Card,
  DataTable, DataTableHead, DataTableBody, DataTableRow, DataTableHeadCell, DataTableCell,
};
