/* ============================================================================
   CHOROS — ra-grant-trail.jsx
   ЭКРАН 4: ЖУРНАЛ ВЫДАЧИ ПРАВ (grant trail).
   ============================================================================ */

import React, { useState } from 'react';
import { ExecutorBadge, MonoId, Mono, OpChip, Button } from '../../components/components.jsx';
import { TRAIL, ProvenanceTag, SectionHead } from './ra-data.jsx';

const ACTION_META = {
  grant:  { label: "выдан",  cls: "grant" },
  revoke: { label: "отозван", cls: "revoke" },
  narrow: { label: "сужен",  cls: "narrow" },
};

const TRAIL_FILTERS = [
  { id: "all", label: "Все" },
  { id: "grant", label: "Выдачи" },
  { id: "revoke", label: "Отзывы" },
  { id: "narrow", label: "Сужения" },
];

function GrantTrailScreen() {
  const [filter, setFilter] = useState("all");
  const [critOnly, setCritOnly] = useState(false);

  const rows = TRAIL.filter((r) => (filter === "all" || r.action === filter) && (!critOnly || r.crit));
  const counts = TRAIL_FILTERS.reduce((acc, f) => {
    acc[f.id] = f.id === "all" ? TRAIL.length : TRAIL.filter((r) => r.action === f.id).length;
    return acc;
  }, {});

  return (
    <div className="chs-trail-screen">
      {/* панель фильтров */}
      <div className="chs-trail__bar">
        <div className="chs-tabs">
          {TRAIL_FILTERS.map((f) => (
            <button key={f.id} type="button" className="chs-tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}<span className="chs-tab__count">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <div className="chs-inbox__spacer" />
        <button type="button" className={`chs-trail__crit ${critOnly ? "chs-trail__crit--on" : ""}`} onClick={() => setCritOnly((v) => !v)}>
          <span className="chs-trail__critdot" />только критичные
        </button>
        <span className="chs-trail__append"><span className="chs-trail__appenddot" />append-only</span>
        <Button variant="secondary" size="sm">Экспорт</Button>
      </div>

      {/* таблица */}
      <div className="chs-trail__scroll">
        <div className="chs-trailtable">
          <div className="chs-trailrow chs-trailrow--head">
            <span>Время (UTC+3)</span>
            <span>ID</span>
            <span>Действие</span>
            <span>Кто выдал</span>
            <span>Кому</span>
            <span>Роль · грант</span>
            <span>Охват</span>
            <span>Происхождение</span>
          </div>
          {rows.map((r) => {
            const am = ACTION_META[r.action];
            return (
              <div key={r.id} className={`chs-trailrow ${r.crit ? "chs-trailrow--crit" : ""}`}>
                <span className="chs-trailcell chs-trailcell--ts"><Mono>{r.ts}</Mono></span>
                <span className="chs-trailcell"><MonoId chip>{r.id}</MonoId></span>
                <span className="chs-trailcell">
                  <span className={`chs-actchip chs-actchip--${am.cls}`}><span className="chs-actchip__dot" />{am.label}</span>
                  {r.crit && <span className="chs-trailcrit" title="критичный грант">крит.</span>}
                </span>
                <span className="chs-trailcell"><ExecutorBadge type={r.actor.type} name={r.actor.name} /></span>
                <span className="chs-trailcell"><ExecutorBadge type={r.subject.type} name={r.subject.name} /></span>
                <span className="chs-trailcell chs-trailcell--grant">
                  <span className="chs-trailrole">{r.role}</span>
                  <span className="chs-trailgrant"><OpChip op={r.op} /><Mono className="chs-trailres">{r.res.replace(/^mcp:\/\//, "")}</Mono></span>
                </span>
                <span className="chs-trailcell chs-trailcell--scope">{r.scope}</span>
                <span className="chs-trailcell chs-trailcell--prov">
                  <ProvenanceTag by={r.proposed} />
                  <span className="chs-trailconfirm">
                    {r.confirmed.length > 1 ? "✓✓ " : "✓ "}
                    {r.confirmed.join(", ")}
                  </span>
                </span>
              </div>
            );
          })}
          {rows.length === 0 && <div className="chs-trail__empty">Записей по фильтру нет.</div>}
        </div>
        <div className="chs-trail__foot">
          <span className="chs-trail__footglyph" />
          Журнал неизменяем (append-only). Каждая запись — часть единого аудит-лога инстанса; правки и удаления невозможны.
        </div>
      </div>
    </div>
  );
}

export default GrantTrailScreen;
