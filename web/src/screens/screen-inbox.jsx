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
                        <Button variant="secondary" size="sm" disabled={!!claiming[t.id]} onClick={() => claimTask(t.id)}>
                          {claiming[t.id] ? '…' : 'Взять'}
                        </Button>
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
        )}
      </div>
    </div>
  );
}

export default InboxScreen;
