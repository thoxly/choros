/* ============================================================================
   CHOROS — ra-grant-trail.jsx
   ЭКРАН 4: ЖУРНАЛ ВЫДАЧИ ПРАВ (grant trail).
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import {
  ActorChip, MonoId, Mono, OpChip, Button, KitIcon, LoadingState, ErrorState,
  DataTable, DataTableHead, DataTableBody, DataTableRow, DataTableHeadCell, DataTableCell,
} from '../../components/components.jsx';
import { TRAIL as TRAIL_SEED, ProvenanceTag } from './ra-data.jsx';
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

/**
 * T-0648 LIVE_PROOF fix (React #31 crash on /rights/trail): coerce a raw
 * actor/subject field into the {type,name,id,resolved} display shape ActorChip
 * expects, whatever concrete shape the caller hands us:
 *   • undefined/null            → honest "—" placeholder (no fabricated identity)
 *   • a plain STRING (API rows) → honest "service" fallback (slug/UUID name+id)
 *   • an OBJECT {type,name,...}  → the SEED (ra-data.jsx TRAIL) shape — carry its
 *     OWN type/name through (never nest the object as `name`).
 *
 * ROOT CAUSE this closes: when the API fetch fails/returns a non-array, the
 * screen falls back to `TRAIL_SEED.map(apiRowToDisplay)`. Seed rows carry
 * `actor`/`subject` as `{type,name}` OBJECTS (not strings). The old code did
 * `name: r.actor` (an object) and, worse, `role = r.subject ?? "—"` (an object)
 * which was rendered as a bare `{r.role}` JSX child → React error #31
 * ("object with keys {type, name}"). Normalising here makes every downstream
 * field a primitive string.
 */
function coerceActorField(v, resolved) {
  if (resolved && typeof resolved === "object") return resolved;
  if (v === null || v === undefined || v === "") {
    return { type: "service", name: "—", id: null, resolved: false };
  }
  if (typeof v === "object") {
    // SEED shape {type, name} (occasionally with more keys) — trust its own type.
    const name = typeof v.name === "string" ? v.name : String(v.name ?? "—");
    return { type: v.type || "service", name, id: v.id ?? null, resolved: false };
  }
  // Raw string slug/UUID (API row without a resolver hit).
  return { type: "service", name: String(v), id: String(v), resolved: false };
}

/** Human-readable role label — NEVER an object (seed subject is {type,name}). */
function roleLabelOf(subject) {
  if (subject === null || subject === undefined || subject === "") return "—";
  if (typeof subject === "object") {
    return typeof subject.name === "string" ? subject.name : String(subject.name ?? "—");
  }
  return String(subject);
}

function apiRowToDisplay(r) {
  // Derive action from type: "grant.create" → "grant", "grant.revoke" → "revoke",
  // "assignment.create" → "grant", "assignment.revoke" → "revoke".
  // SEED rows (ra-data.jsx) already carry a literal `action` — honour it.
  let action;
  if (typeof r.action === "string") action = r.action;
  else if (r.type === "grant.create" || r.type === "assignment.create") action = "grant";
  else if (r.type === "grant.revoke" || r.type === "assignment.revoke") action = "revoke";
  else action = "grant";

  // Format occurred_at (epoch-ms) to a display timestamp string. Seed rows carry
  // a pre-formatted `ts` string instead of `occurred_at` — honour it.
  const ts = typeof r.ts === "string" ? r.ts : formatDate(r.occurred_at);

  // T-0648 (D-064, UX-study §3 + §6.2 /rights/trail crash): actor/subject were
  // hardcoded to { type: "human", ... } regardless of the real actor kind (a
  // service/automation actor like "policy-sync" rendered as a human — wrong
  // glyph). GET /api/grant-trail now attaches `actorResolved`/`subjectResolved`
  // (T-0648 batch resolver, src/http/grant-trail.ts attachResolvedActors) —
  // prefer those; otherwise coerce whatever the row carries (string OR the seed
  // {type,name} object) into a well-formed, NEVER-nested display shape.
  const actorDisplay = coerceActorField(r.actor, r.actorResolved);
  const subjectDisplay = coerceActorField(r.subject, r.subjectResolved);

  // Scope display: render nodeId or a JSON snippet for other scope kinds.
  // Seed rows (ra-data.jsx) carry `scope` as a plain STRING already — honour it.
  let scopeDisplay = "—";
  if (typeof r.scope === "string") {
    scopeDisplay = r.scope;
  } else if (r.scope && typeof r.scope === "object") {
    const s = r.scope;
    if (s.kind === "node") scopeDisplay = `${s.hierarchy}:${s.nodeId}`;
    else if (s.kind === "tags") scopeDisplay = (s.tags ?? []).join(", ");
    else if (s.kind === "interval") scopeDisplay = `${s.axis} ≤ ${s.hi}`;
    else scopeDisplay = JSON.stringify(s);
  }

  // Payload fields. Seed rows carry `op`/`res` as plain strings (no payload).
  const payload = r.payload && typeof r.payload === "object" ? r.payload : {};
  const op = typeof r.op === "string" ? r.op : String(payload.operation ?? payload.roleId ?? r.type ?? "—");
  const res = typeof r.res === "string" ? r.res : String(payload.resourceType ?? payload.roleId ?? "—");
  // role is ALWAYS a primitive string — seed `subject` is a {type,name} OBJECT,
  // so `r.subject ?? "—"` would leak an object into the bare `{r.role}` JSX child
  // (the React #31 crash). roleLabelOf coerces object → its .name.
  const role = roleLabelOf(r.subject);

  // confirmed: seed rows carry a `confirmed` string-array already; API rows carry
  // a single `confirmed_by` string. Normalise to an array of strings either way.
  let confirmed;
  if (Array.isArray(r.confirmed)) confirmed = r.confirmed.map((c) => (typeof c === "string" ? c : String(c ?? "")));
  else if (r.confirmed_by) confirmed = [String(r.confirmed_by)];
  else confirmed = [];

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
    proposed: r.proposed ?? r.proposed_by ?? "human",
    confirmed,
    crit: Boolean(r.crit), // day-1: API rows have no crit flag; seed rows do
    _seq: r.seq ?? 0,
  };
}

/**
 * GrantTrailRow — ONE trail row, extracted as a PURE (hook-free) component so
 * the node test tier (web/vitest.config.js, no jsdom) can render it and walk
 * the element tree for the React #31 regression: NO field may reach a bare JSX
 * child as an object. `r` is an apiRowToDisplay output — actor/subject are the
 * well-formed {type,name,id} shape, role/op/res/scope/ts are primitives.
 */
function GrantTrailRow({ r }) {
  const am = ACTION_META[r.action] || ACTION_META.grant;
  const actor = r.actor && typeof r.actor === "object" ? r.actor : { type: "service", name: String(r.actor ?? "—"), id: null };
  const subject = r.subject && typeof r.subject === "object" ? r.subject : { type: "service", name: String(r.subject ?? "—"), id: null };
  return (
    <DataTableRow className={r.crit ? "chs-trailrow--crit" : ""}>
      <DataTableCell className="chs-trailcell chs-trailcell--ts"><Mono>{r.ts}</Mono></DataTableCell>
      <DataTableCell className="chs-trailcell"><MonoId chip>{r.id}</MonoId></DataTableCell>
      <DataTableCell className="chs-trailcell">
        <span className={`chs-actchip chs-actchip--${am.cls}`}><span className="chs-actchip__dot" />{am.label}</span>
        {r.crit && <span className="chs-trailcrit" title="критичный грант">крит.</span>}
      </DataTableCell>
      <DataTableCell className="chs-trailcell"><ActorChip type={actor.type} name={actor.name} id={actor.id} deactivated={actor.deactivated} /></DataTableCell>
      <DataTableCell className="chs-trailcell"><ActorChip type={subject.type} name={subject.name} id={subject.id} deactivated={subject.deactivated} /></DataTableCell>
      <DataTableCell className="chs-trailcell chs-trailcell--grant">
        <span className="chs-trailrole">{r.role}</span>
        <span className="chs-trailgrant"><OpChip op={r.op} /><Mono className="chs-trailres">{String(r.res ?? "").replace(/^mcp:\/\//, "")}</Mono></span>
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
            {rows.map((r) => <GrantTrailRow key={r.id} r={r} />)}
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

// T-0648: named exports for the node test tier (web/vitest.config.js — no DOM).
// `apiRowToDisplay` exercises the actor/subject resolution + coercion; the pure
// `GrantTrailRow` component lets the test RENDER a row and walk the element tree
// to assert NO object ever reaches a bare JSX child (the exact React #31 crash
// that a SEED-shape row triggered live — see ra-grant-trail.test.js).
export { apiRowToDisplay, GrantTrailRow };
export default GrantTrailScreen;
