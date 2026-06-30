/* ============================================================================
   CHOROS — ra-grant-trail.jsx
   ЭКРАН 4: ЖУРНАЛ ВЫДАЧИ ПРАВ (grant trail).
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import {
  ExecutorBadge, MonoId, Mono, OpChip, Button, KitIcon, LoadingState, ErrorState,
  DataTable, DataTableHead, DataTableBody, DataTableRow, DataTableHeadCell, DataTableCell,
} from '../../components/components.jsx';
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
  const [allRows, setAllRows] = useState(null); // null = loading, [] = empty, [...] = data
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [loadMoreError, setLoadMoreError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const r = await fetch('/api/grant-trail');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (Array.isArray(data.rows)) {
        setAllRows(data.rows.map(apiRowToDisplay));
        setHasMore(Boolean(data.hasMore));
      } else {
        setAllRows(TRAIL_SEED.map(apiRowToDisplay));
      }
    } catch (err) {
      setLoadError(String(err?.message || err));
      // NF-8: fall back to seed data so the screen is never fully blank
      setAllRows(TRAIL_SEED.map(apiRowToDisplay));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadMore = useCallback(async () => {
    if (!hasMore || !allRows || allRows.length === 0) return;
    const minSeq = Math.min(...allRows.map((r) => r._seq));
    setLoadMoreError(null);
    try {
      const r = await fetch(`/api/grant-trail?before_seq=${minSeq}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (Array.isArray(data.rows)) {
        setAllRows((prev) => [...(prev || []), ...data.rows.map(apiRowToDisplay)]);
        setHasMore(Boolean(data.hasMore));
      }
    } catch (err) {
      setLoadMoreError(String(err?.message || err));
    }
  }, [hasMore, allRows]);

  const displayRows = allRows || [];
  const rows = displayRows.filter((r) => (filter === "all" || r.action === filter) && (!critOnly || r.crit));
  const counts = TRAIL_FILTERS.reduce((acc, f) => {
    acc[f.id] = f.id === "all" ? displayRows.length : displayRows.filter((r) => r.action === f.id).length;
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

      {/* T-0530: loading / error states */}
      {loading && <LoadingState label="Загрузка журнала…" compact />}
      {!loading && loadError && (
        <ErrorState compact title="Не удалось загрузить журнал" message={loadError} onRetry={load} />
      )}

      {/* таблица — T-0547: семантическая <table> вместо div-грида */}
      <div className="chs-trail__scroll">
        <DataTable label="Журнал выдачи прав" className="chs-trailtable">
          <DataTableHead>
            <tr className="chs-trailrow--head">
              <DataTableHeadCell>Время (UTC+3)</DataTableHeadCell>
              <DataTableHeadCell>ID</DataTableHeadCell>
              <DataTableHeadCell>Действие</DataTableHeadCell>
              <DataTableHeadCell>Кто выдал</DataTableHeadCell>
              <DataTableHeadCell>Кому</DataTableHeadCell>
              <DataTableHeadCell>Роль · грант</DataTableHeadCell>
              <DataTableHeadCell>Охват</DataTableHeadCell>
              <DataTableHeadCell>Происхождение</DataTableHeadCell>
            </tr>
          </DataTableHead>
          <DataTableBody>
            {rows.map((r) => {
              const am = ACTION_META[r.action];
              return (
                <DataTableRow key={r.id} className={r.crit ? "chs-trailrow--crit" : ""}>
                  <DataTableCell className="chs-trailcell chs-trailcell--ts"><Mono>{r.ts}</Mono></DataTableCell>
                  <DataTableCell className="chs-trailcell"><MonoId chip>{r.id}</MonoId></DataTableCell>
                  <DataTableCell className="chs-trailcell">
                    <span className={`chs-actchip chs-actchip--${am.cls}`}><span className="chs-actchip__dot" />{am.label}</span>
                    {r.crit && <span className="chs-trailcrit" title="критичный грант">крит.</span>}
                  </DataTableCell>
                  <DataTableCell className="chs-trailcell"><ExecutorBadge type={r.actor.type} name={r.actor.name} /></DataTableCell>
                  <DataTableCell className="chs-trailcell"><ExecutorBadge type={r.subject.type} name={r.subject.name} /></DataTableCell>
                  <DataTableCell className="chs-trailcell chs-trailcell--grant">
                    <span className="chs-trailrole">{r.role}</span>
                    <span className="chs-trailgrant"><OpChip op={r.op} /><Mono className="chs-trailres">{r.res.replace(/^mcp:\/\//, "")}</Mono></span>
                  </DataTableCell>
                  <DataTableCell className="chs-trailcell chs-trailcell--scope">{r.scope}</DataTableCell>
                  <DataTableCell className="chs-trailcell chs-trailcell--prov">
                    <ProvenanceTag by={r.proposed} />
                    <span className="chs-trailconfirm">
                      <KitIcon name="success" />{r.confirmed.length > 1 ? <KitIcon name="success" /> : null}{" "}
                      {r.confirmed.join(", ")}
                    </span>
                  </DataTableCell>
                </DataTableRow>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="chs-trail__empty">Записей по фильтру нет.</td>
              </tr>
            )}
          </DataTableBody>
        </DataTable>
        <div className="chs-trail__foot">
          <span className="chs-trail__footglyph" />
          Журнал неизменяем (append-only). Каждая запись — часть единого аудит-лога инстанса; правки и удаления невозможны.
          {loadMoreError && (
            <ErrorState compact title="Не удалось загрузить ещё" message={loadMoreError} onRetry={loadMore} />
          )}
          {hasMore && !loadMoreError && (
            <Button variant="secondary" size="sm" onClick={loadMore} loading={loading} disabled={loading} style={{ marginLeft: "1rem" }}>
              Загрузить ещё
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default GrantTrailScreen;
