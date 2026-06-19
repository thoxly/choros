/* ============================================================================
   CHOROS — screen-audit.jsx
   ЭКРАН 3 (hero): таймлайн аудита одного инстанса процесса.
   Единый вертикальный поток событий человек/агент/сервис.
   Каждый вызов инструмента — отдельный AuditEvent с моноширинными ID и
   таймстампом; раскрывается payload (вход/выход, длительность, токены, ₽).
   ============================================================================ */

import React, { useState, useEffect } from 'react';
import { ExecGlyph, MonoId, Mono, StatusChip, BudgetMeter, EXEC_META, LoadingState, ErrorState, EmptyState } from '../components/components.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';


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
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = async () => {
    setError(null);
    try {
      const res = await fetch('/api/audit', { headers: devHeaders() });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const flat = [];

  // Error state
  if (error) {
    return (
      <div className="chs-audit-screen">
        <ErrorState message={`Не удалось загрузить аудит: ${error}`} onRetry={load} />
      </div>
    );
  }

  // Loading state
  if (data === null) {
    return (
      <div className="chs-audit-screen">
        <LoadingState label="Загрузка аудита…" />
      </div>
    );
  }

  // Empty state
  if (!data.trace || data.trace.length === 0) {
    return (
      <div className="chs-audit-screen">
        <EmptyState title="Нет событий" description="Для этого инстанса процесса ещё не записано ни одного события аудита." />
      </div>
    );
  }

  const { instance, trace } = data;

  return (
    <div className="chs-audit-screen">
      {/* Заголовок инстанса */}
      <div className="chs-inst">
        <div className="chs-inst__top">
          <div>
            <h1 className="chs-inst__title">
              {instance.process}
              <StatusChip status={instance.status} />
            </h1>
            <div className="chs-inst__sub">
              <MonoId chip>{instance.id}</MonoId>
              <span className="chs-crumbs__sep">/</span>
              <MonoId>{instance.procId}</MonoId>
              <span className="chs-crumbs__sep">/</span>
              <span>текущий узел: <Mono style={{ color: "var(--chs-color-text)" }}>{instance.node}</Mono></span>
            </div>
          </div>
          <div className="chs-inst__execs">
            {instance.execs.map((t) => (
              <span className={`chs-inst__execdot chs-inst__execdot--${t}`} key={t} title={EXEC_META[t].label}>
                <ExecGlyph type={t} size={11} />
              </span>
            ))}
          </div>
        </div>
        <div className="chs-inst__facts">
          <div className="chs-statcell"><span className="chs-statcell__k">Запущен</span><span className="chs-statcell__v"><Mono>{instance.started}</Mono></span></div>
          <div className="chs-statcell"><span className="chs-statcell__k">В работе</span><span className="chs-statcell__v"><Mono>{instance.elapsed}</Mono></span></div>
          {instance.budget.map((b) => (
            <div className="chs-statcell" key={b.label} style={{ minWidth: "180px" }}>
              <BudgetMeter label={b.label} used={b.used} total={b.total} unit={b.unit} fmt={b.money ? (n) => "₽" + n.toLocaleString("ru-RU") : (n) => n.toLocaleString("ru-RU")} />
            </div>
          ))}
        </div>
      </div>

      {/* Трасса */}
      <div className="chs-trace">
        {trace.map((step) => {
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
