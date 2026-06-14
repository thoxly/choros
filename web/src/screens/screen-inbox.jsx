/* ============================================================================
   CHOROS — screen-inbox.jsx
   ЭКРАН 2: плотная таблица инбокса задач.
   Колонки: задача · процесс (MonoId) · тип исполнителя · SLA · дедлайн ·
   действие «взять из пула».
   ============================================================================ */

import React, { useState, useEffect } from 'react';
import { Button, MonoId, Mono, ExecutorBadge } from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';

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

/**
 * Render a claim timestamp (epoch-ms) as a compact «когда взято» label.
 * Relative for fresh claims (сейчас / N мин назад), absolute clock for older ones.
 * Tolerant of missing/invalid input — returns null so the caller can omit the «·» separator.
 */
function takenWhen(claimedAt) {
  if (typeof claimedAt !== "number" || !Number.isFinite(claimedAt)) return null;
  const diffMin = Math.floor((Date.now() - claimedAt) / 60000);
  if (diffMin <= 0) return "сейчас";
  if (diffMin < 60) return `${diffMin} мин назад`;
  const d = new Date(claimedAt);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/* ---------------------------------------------------------------------------
   SLA state model (T-0095) — kept in LOCKSTEP with src/http/sla.ts.
   The SERVER owns the deadline (epoch-ms, `item.deadline`); the client derives the
   live remaining time + warn/over state PURELY from (now, deadline, total-window).
   No deadlines are invented client-side. Pure functions so the boundaries are
   unit-testable with an injected `now` (do NOT read the wall clock here).
   --------------------------------------------------------------------------- */
const SLA_WARN_FRACTION = 0.25;
const SLA_WARN_FLOOR_MS = 5 * 60000;
const SLA_WARN_CEIL_MS = 60 * 60000;

export function warnWindowMs(totalMin) {
  const total = Number.isFinite(totalMin) && totalMin > 0 ? totalMin * 60000 : 0;
  const raw = total * SLA_WARN_FRACTION;
  return Math.min(SLA_WARN_CEIL_MS, Math.max(SLA_WARN_FLOOR_MS, raw));
}

/** "normal" | "warn" | "over" from injected `nowMs` + server `deadlineMs` + total window. */
export function slaState(nowMs, deadlineMs, totalMin) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(deadlineMs)) return "normal";
  if (nowMs >= deadlineMs) return "over";
  if (nowMs >= deadlineMs - warnWindowMs(totalMin)) return "warn";
  return "normal";
}

/** Whole minutes of headroom remaining (negative once past due). Rounds toward zero. */
export function remainingMin(nowMs, deadlineMs) {
  return Math.trunc((deadlineMs - nowMs) / 60000);
}

/**
 * Render the live SLA state for one item. Prefers the server deadline (epoch-ms) and
 * runs a 1-Hz tick so the countdown + warn/over state advance in real time; falls back
 * to the static `sla.left` snapshot when no deadline is present (legacy rows).
 */
function SLACell({ sla, deadline }) {
  const hasLive = typeof deadline === "number" && Number.isFinite(deadline);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasLive) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasLive]);

  const left = hasLive ? remainingMin(now, deadline) : sla.left;
  const state = hasLive
    ? slaState(now, deadline, sla.min)
    : sla.left < 0
      ? "over"
      : (sla.left / sla.min) * 100 <= 25
        ? "warn"
        : "normal";

  const over = state === "over";
  const cls = over ? "over" : state === "warn" ? "warn" : "";
  // Bar fill: proportion of the SLA window still remaining (0 when overdue, full bar in red).
  const pct = over ? 100 : Math.max(0, Math.min(100, (left / sla.min) * 100));
  const txt = over ? `−${Math.abs(left)} мин` : `${left} мин`;
  return (
    <span className="chs-sla">
      <span className="chs-sla__bar"><span className={`chs-sla__fill ${cls ? "chs-sla__fill--" + cls : ""}`} style={{ width: pct + "%" }} /></span>
      <span className={`chs-sla__txt ${cls ? "chs-sla__txt--" + cls : ""}`}>{txt}</span>
    </span>
  );
}

function InboxScreen() {
  const [tab, setTab] = useState("all");
  const [exec, setExec] = useState(null); // executor-type filter: agent|human|service|null
  const [sortSla, setSortSla] = useState(false); // sort by SLA headroom ascending
  const [taken, setTaken] = useState(() => ({}));
  const [items, setItems] = useState(null);
  const [counts, setCounts] = useState({ all: 0, mine: 0, pool: 0, esc: 0 });
  const [error, setError] = useState(null);
  // T-0138: per-task claim inflight tracking (taskId → true)
  const [claiming, setClaiming] = useState(() => ({}));

  // T-0093: tabs/filters/sort are applied SERVER-SIDE. The query mirrors the API:
  // ?tab=...&exec=...&sort=sla. The server returns the filtered `items` plus full
  // per-tab `counts` (computed from the tenant-scoped base, not the filtered view).
  const load = async () => {
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (tab && tab !== "all") qs.set("tab", tab);
      if (exec) qs.set("exec", exec);
      if (sortSla) qs.set("sort", "sla");
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const res = await fetch(`/api/inbox${suffix}`, { headers: devHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.items);
      if (data.counts) setCounts(data.counts);
    } catch (e) {
      setError(e.message);
    }
  };

  // T-0138: claim a pool task via POST /api/inbox/:id/claim
  const claimTask = async (taskId) => {
    if (claiming[taskId]) return; // inflight guard
    setClaiming((s) => ({ ...s, [taskId]: true }));
    try {
      const res = await fetch(`/api/inbox/${taskId}/claim`, {
        method: 'POST',
        headers: devHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code = body?.error?.code ?? `HTTP ${res.status}`;
        throw new Error(code === 'ALREADY_CLAIMED' ? 'Задача уже взята другим пользователем' : `Ошибка: ${code}`);
      }
      // Optimistic local state + re-fetch to sync mine flag
      setTaken((s) => ({ ...s, [taskId]: true }));
      await load();
    } catch (e) {
      // Surface error as alert — task remains in pool for retry
      // eslint-disable-next-line no-alert
      alert(e.message);
    } finally {
      setClaiming((s) => ({ ...s, [taskId]: false }));
    }
  };

  // Re-fetch whenever the tab/filter/sort changes — semantics live on the server.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, exec, sortSla]);

  // Server already applied tab/filter/sort; render the returned rows as-is.
  const rows = items || [];

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
        <button
          className="chs-inbox__filter"
          aria-pressed={exec ? "true" : undefined}
          onClick={() => setExec((cur) => (cur === "agent" ? "human" : cur === "human" ? "service" : cur === "service" ? null : "agent"))}
        >
          <Icon name="filter" /> {exec ? `Тип: ${exec}` : "Тип исполнителя"}
        </button>
        <button
          className="chs-inbox__filter"
          aria-pressed={sortSla ? "true" : undefined}
          onClick={() => setSortSla((s) => !s)}
        >
          SLA ↑
        </button>
      </div>

      <div className="chs-inbox__scroll">
        {error ? (
          <div style={{ padding: "var(--chs-space-5)", textAlign: "center" }}>
            <p style={{ marginBottom: "var(--chs-space-3)" }}>Не удалось загрузить задачи: {error}</p>
            <Button onClick={load}>Повторить</Button>
          </div>
        ) : items === null ? (
          <div style={{ padding: "var(--chs-space-5)", textAlign: "center" }}>
            Загрузка задач…
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: "var(--chs-space-5)", textAlign: "center" }}>
            Нет задач
          </div>
        ) : (
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
                // Taken-state is server-truth: a claimed item comes back with claimedBy set
                // (pool cleared). The local `taken[t.id]` flag only bridges the brief optimistic
                // window before load() re-syncs, so the «взято» state never flickers back.
                const claimedByServer = !!t.claimedBy;
                const isTaken = claimedByServer || !!taken[t.id];
                const inPool = t.pool && !isTaken;
                // Who took it (server display name) + when — the «взято кем, когда».
                const takenName = t.execName || "—";
                const whenLabel = takenWhen(t.claimedAt);
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
                        <ExecutorBadge type="human" name={takenName} />
                      ) : (
                        <ExecutorBadge type={t.execType} name={t.execName} />
                      )}
                    </td>
                    <td><SLACell sla={t.sla} deadline={t.deadline} /></td>
                    <td><Mono style={{ color: "var(--chs-color-text-muted)", fontSize: "var(--chs-text-sm)" }}>{t.due}</Mono></td>
                    <td className="chs-r">
                      {inPool ? (
                        <Button variant="secondary" size="sm" disabled={!!claiming[t.id]} onClick={() => claimTask(t.id)}>
                          {claiming[t.id] ? '…' : 'Взять'}
                        </Button>
                      ) : isTaken ? (
                        <span className="chs-taken-tag" title={whenLabel ? `Взято ${takenName}, ${whenLabel}` : undefined}>
                          <Icon name="check" /> взято{t.mine ? " (мной)" : ""}{whenLabel ? ` · ${whenLabel}` : ""}
                        </span>
                      ) : (
                        <Button variant="ghost" size="sm">Открыть</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default InboxScreen;
