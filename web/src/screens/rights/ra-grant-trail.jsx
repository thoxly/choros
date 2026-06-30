/* ============================================================================
   CHOROS — ra-grant-trail.jsx
   ЭКРАН 4: ЖУРНАЛ ВЫДАЧИ ПРАВ (grant trail).
   ============================================================================ */

import React, { useState, useEffect } from 'react';
import { ExecutorBadge, MonoId, Mono, OpChip, Button, KitIcon } from '../../components/components.jsx';
import { TRAIL as TRAIL_SEED, ProvenanceTag, SectionHead } from './ra-data.jsx';
import { formatDate } from '../../lib/format.js';

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

// ---------------------------------------------------------------------------
// Map a GrantTrailRow (from /api/grant-trail) to the display shape the table
// uses. The API returns machine types; we derive the display fields here.
// ---------------------------------------------------------------------------

function apiRowToDisplay(r) {
  // Derive action from type: "grant.create" → "grant", "grant.revoke" → "revoke",
  // "assignment.create" → "grant", "assignment.revoke" → "revoke".
  let action;
  if (r.type === "grant.create" || r.type === "assignment.create") action = "grant";
  else if (r.type === "grant.revoke" || r.type === "assignment.revoke") action = "revoke";
  else action = "grant";

  // Format occurred_at (epoch-ms) to a display timestamp string.
  const ts = formatDate(r.occurred_at);

  // Subject display: actor and subject are plain strings in the API response.
  const actorDisplay = { type: "human", name: r.actor };
  const subjectDisplay = { type: "human", name: r.subject ?? "—" };

  // Scope display: render nodeId or a JSON snippet for other scope kinds.
  let scopeDisplay = "—";
  if (r.scope && typeof r.scope === "object") {
    const s = r.scope;
    if (s.kind === "node") scopeDisplay = `${s.hierarchy}:${s.nodeId}`;
    else if (s.kind === "tags") scopeDisplay = (s.tags ?? []).join(", ");
    else if (s.kind === "interval") scopeDisplay = `${s.axis} ≤ ${s.hi}`;
    else scopeDisplay = JSON.stringify(s);
  }

  // Payload fields
  const payload = r.payload && typeof r.payload === "object" ? r.payload : {};
  const op = String(payload.operation ?? payload.roleId ?? r.type);
  const res = String(payload.resourceType ?? payload.roleId ?? "—");
  const role = r.subject ?? "—";

  return {
    id: r.id,
    ts,
    action,
    actor: actorDisplay,
    subject: subjectDisplay,
    role,
    res,
    op,
    scope: scopeDisplay,
    proposed: r.proposed_by ?? "human",
    confirmed: r.confirmed_by ? [r.confirmed_by] : [],
    crit: false, // day-1: crit flag not pre-computed by API (spec §4)
    _seq: r.seq,
  };
}

function GrantTrailScreen() {
  const [filter, setFilter] = useState("all");
  const [critOnly, setCritOnly] = useState(false);
  const [allRows, setAllRows] = useState(() => TRAIL_SEED.map(apiRowToDisplay));
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch('/api/grant-trail')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.rows)) {
          setAllRows(data.rows.map(apiRowToDisplay));
          setHasMore(Boolean(data.hasMore));
        }
      })
      .catch(() => {
        // keep seed — NF-8: static fallback if API is unavailable
      })
      .finally(() => setLoading(false));
  }, []);

  function loadMore() {
    if (!hasMore || allRows.length === 0) return;
    const minSeq = Math.min(...allRows.map((r) => r._seq));
    setLoading(true);
    fetch(`/api/grant-trail?before_seq=${minSeq}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.rows)) {
          setAllRows((prev) => [...prev, ...data.rows.map(apiRowToDisplay)]);
          setHasMore(Boolean(data.hasMore));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  const rows = allRows.filter((r) => (filter === "all" || r.action === filter) && (!critOnly || r.crit));
  const counts = TRAIL_FILTERS.reduce((acc, f) => {
    acc[f.id] = f.id === "all" ? allRows.length : allRows.filter((r) => r.action === f.id).length;
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
                    <KitIcon name="success" />{r.confirmed.length > 1 ? <KitIcon name="success" /> : null}{" "}
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
          {hasMore && (
            <Button variant="secondary" size="sm" onClick={loadMore} disabled={loading} style={{ marginLeft: "1rem" }}>
              {loading ? "Загрузка…" : "Загрузить ещё"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default GrantTrailScreen;
