/* ============================================================================
   CHOROS — screen-inbox.jsx
   ЭКРАН 2: плотная таблица инбокса задач.
   Колонки: задача · процесс (MonoId) · тип исполнителя · SLA · дедлайн ·
   действие «взять из пула».
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, MonoId, Mono, ExecutorBadge, StatusChip } from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';
import { authHeaders, devHeaders } from '../app-shell/dev-auth.js';

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

// ---------------------------------------------------------------------------
// T-0272: TaskDetailPanel — in-screen expandable panel for task detail.
// Opens when the user clicks «Открыть» on any inbox row.
// Shows: task info (name, step, inst, executor type, SLA) + optional instance
// projection (current process status, step, started-at).
// Allows completing a step: human/approver → POST /api/inbox/:id/action {action:'approve'}.
// Shows the outcome after the step completes: status=done and the transition label.
// ---------------------------------------------------------------------------

const STATUS_LABEL = {
  running: "Выполняется",
  waiting: "Ожидание решения",
  done: "Завершено",
  failed: "Ошибка",
  paused: "Пауза",
};

function TaskDetailPanel({ taskId, onClose, onActionDone }) {
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null); // { item, projection }
  const [fetchError, setFetchError] = useState(null);
  const [completing, setCompleting] = useState(false);
  const [outcome, setOutcome] = useState(null); // null | { status, instanceId, action }
  const [actionError, setActionError] = useState(null);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/inbox/${taskId}`, { headers: authHeaders() });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setDetail(data);
    } catch (e) {
      setFetchError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (taskId) loadDetail();
  }, [taskId, loadDetail]);

  const handleComplete = useCallback(async () => {
    if (!detail?.item || completing) return;
    setCompleting(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/inbox/${taskId}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ action: 'approve' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = body?.error?.code ?? `HTTP ${res.status}`;
        throw new Error(code === 'NOT_ELIGIBLE' ? 'Нет права на выполнение этого шага' : `Ошибка: ${code}`);
      }
      setOutcome(body);
      // Notify parent to refresh the inbox list.
      if (onActionDone) onActionDone();
    } catch (e) {
      setActionError(String(e?.message || e));
    } finally {
      setCompleting(false);
    }
  }, [taskId, detail, completing, onActionDone]);

  if (!taskId) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 900,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end',
        pointerEvents: 'none',
      }}
    >
      {/* Backdrop */}
      <div
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          pointerEvents: 'auto',
        }}
        onClick={onClose}
        aria-label="Закрыть задачу"
      />
      {/* Slide-in panel */}
      <div
        role="complementary"
        aria-label="Детали задачи"
        style={{
          position: 'relative', zIndex: 901, pointerEvents: 'auto',
          width: '420px', maxWidth: '90vw', height: '100vh',
          background: 'var(--chs-bg-secondary, #1e2028)',
          borderLeft: '1px solid var(--chs-border, #30333d)',
          display: 'flex', flexDirection: 'column',
          boxShadow: '-4px 0 24px rgba(0,0,0,0.3)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid var(--chs-border, #30333d)',
          flexShrink: 0,
        }}>
          <h2 style={{ margin: 0, fontSize: 'var(--chs-text-md, 14px)', fontWeight: 600 }}>
            Задача
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Закрыть">✕</Button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
          {loading ? (
            <div style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm, 13px)' }}>
              Загрузка…
            </div>
          ) : fetchError ? (
            <div>
              <div style={{
                marginBottom: '12px', padding: '10px 14px',
                background: 'rgba(229,62,62,0.12)', border: '1px solid var(--chs-color-danger, #e53e3e)',
                borderRadius: '6px', fontSize: 'var(--chs-text-sm, 13px)',
              }}>
                Не удалось загрузить: {fetchError}
              </div>
              <Button variant="secondary" size="sm" onClick={loadDetail}>Повторить</Button>
            </div>
          ) : detail ? (
            <>
              {/* Task info */}
              <section style={{ marginBottom: '20px' }}>
                <h3 style={{ margin: '0 0 12px 0', fontSize: 'var(--chs-text-sm, 13px)', fontWeight: 600, color: 'var(--chs-color-text-muted, #888)' }}>
                  ЗАДАЧА
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', rowGap: '8px', fontSize: 'var(--chs-text-sm, 13px)' }}>
                  <span style={{ color: 'var(--chs-color-text-muted, #888)' }}>Название</span>
                  <span style={{ fontWeight: 500 }}>{detail.item.name}</span>

                  <span style={{ color: 'var(--chs-color-text-muted, #888)' }}>Шаг</span>
                  <Mono style={{ fontSize: 'var(--chs-text-sm, 13px)' }}>{detail.item.step}</Mono>

                  <span style={{ color: 'var(--chs-color-text-muted, #888)' }}>Инстанс</span>
                  <MonoId>{detail.item.inst}</MonoId>

                  <span style={{ color: 'var(--chs-color-text-muted, #888)' }}>Исполнитель</span>
                  <ExecutorBadge type={detail.item.execType || 'human'} name={detail.item.execName} />

                  <span style={{ color: 'var(--chs-color-text-muted, #888)' }}>Статус</span>
                  <StatusChip status={detail.item.status} />

                  {detail.item.due && (
                    <>
                      <span style={{ color: 'var(--chs-color-text-muted, #888)' }}>Дедлайн</span>
                      <Mono style={{ fontSize: 'var(--chs-text-sm, 13px)' }}>{detail.item.due}</Mono>
                    </>
                  )}
                </div>
              </section>

              {/* Process/instance projection (if available) */}
              {detail.projection && (
                <section style={{ marginBottom: '20px' }}>
                  <h3 style={{ margin: '0 0 12px 0', fontSize: 'var(--chs-text-sm, 13px)', fontWeight: 600, color: 'var(--chs-color-text-muted, #888)' }}>
                    ПРОЦЕСС
                  </h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', rowGap: '8px', fontSize: 'var(--chs-text-sm, 13px)' }}>
                    <span style={{ color: 'var(--chs-color-text-muted, #888)' }}>Инстанс</span>
                    <MonoId>{detail.projection.inst}</MonoId>

                    <span style={{ color: 'var(--chs-color-text-muted, #888)' }}>Процесс</span>
                    <Mono style={{ fontSize: 'var(--chs-text-sm, 13px)' }}>{detail.projection.procKey}</Mono>

                    <span style={{ color: 'var(--chs-color-text-muted, #888)' }}>Текущий шаг</span>
                    <span>{detail.projection.step}</span>

                    <span style={{ color: 'var(--chs-color-text-muted, #888)' }}>Состояние</span>
                    <StatusChip status={detail.projection.status} label={STATUS_LABEL[detail.projection.status]} />

                    <span style={{ color: 'var(--chs-color-text-muted, #888)' }}>Запущен</span>
                    <Mono style={{ fontSize: 'var(--chs-text-xs, 11px)', color: 'var(--chs-color-text-muted, #888)' }}>
                      {new Date(detail.projection.startedAt).toLocaleString('ru-RU')}
                    </Mono>
                  </div>
                </section>
              )}

              {/* Outcome: shown after step completion */}
              {outcome && (
                <section style={{ marginBottom: '20px' }}>
                  <div style={{
                    padding: '12px 16px',
                    background: 'rgba(56,161,105,0.12)',
                    border: '1px solid var(--chs-color-success, #38a169)',
                    borderRadius: '6px', fontSize: 'var(--chs-text-sm, 13px)',
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: '4px' }}>Шаг выполнен</div>
                    <div style={{ color: 'var(--chs-color-text-muted, #888)' }}>
                      Процесс <strong>{outcome.instanceId}</strong> перешёл в состояние{' '}
                      <strong>{STATUS_LABEL[outcome.status] ?? outcome.status}</strong>.
                    </div>
                  </div>
                </section>
              )}

              {/* Action error */}
              {actionError && (
                <div style={{
                  marginBottom: '12px', padding: '10px 14px',
                  background: 'rgba(229,62,62,0.12)', border: '1px solid var(--chs-color-danger, #e53e3e)',
                  borderRadius: '6px', fontSize: 'var(--chs-text-sm, 13px)',
                }}>
                  {actionError}
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Footer: complete-step action */}
        {detail && !outcome && (
          <div style={{
            padding: '16px 20px',
            borderTop: '1px solid var(--chs-border, #30333d)',
            flexShrink: 0,
            display: 'flex', gap: '8px', justifyContent: 'flex-end',
          }}>
            <Button variant="ghost" size="sm" onClick={onClose}>Закрыть</Button>
            {/* Show complete-step only when the task is still actionable (not done/failed) */}
            {detail.item.status !== 'done' && detail.item.status !== 'failed' && (
              <Button
                variant="primary"
                size="sm"
                disabled={completing}
                onClick={handleComplete}
              >
                {completing ? 'Выполнение…' : 'Выполнить шаг'}
              </Button>
            )}
          </div>
        )}

        {outcome && (
          <div style={{
            padding: '16px 20px',
            borderTop: '1px solid var(--chs-border, #30333d)',
            flexShrink: 0,
            display: 'flex', justifyContent: 'flex-end',
          }}>
            <Button variant="secondary" size="sm" onClick={onClose}>Закрыть</Button>
          </div>
        )}
      </div>
    </div>
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
  // T-0287: per-task approve inflight tracking (taskId → true)
  const [approving, setApproving] = useState(() => ({}));
  // T-0272: task detail panel (selectedTaskId → open; null → closed)
  const [selectedTaskId, setSelectedTaskId] = useState(null);

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

  // T-0287: approve a claimed instance task via POST /api/inbox/:id/action {action:'approve'}
  const approveTask = async (taskId) => {
    if (approving[taskId]) return; // inflight guard
    setApproving((s) => ({ ...s, [taskId]: true }));
    try {
      const res = await fetch(`/api/inbox/${taskId}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...devHeaders() },
        body: JSON.stringify({ action: 'approve' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code = body?.error?.code ?? `HTTP ${res.status}`;
        throw new Error(`Ошибка: ${code}`);
      }
      // Task approved → instance done; re-fetch to drop the task from the list.
      await load();
    } catch (e) {
      // eslint-disable-next-line no-alert
      alert(e.message);
    } finally {
      setApproving((s) => ({ ...s, [taskId]: false }));
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
    <>
    {/* T-0272: task detail side panel */}
    <TaskDetailPanel
      taskId={selectedTaskId}
      onClose={() => setSelectedTaskId(null)}
      onActionDone={() => { load(); setSelectedTaskId(null); }}
    />
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
                      ) : isTaken && t.mine && t.role === 'role-approver' ? (
                        <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                          <Button variant="ghost" size="sm" onClick={() => setSelectedTaskId(t.id)}>Открыть</Button>
                          <Button variant="primary" size="sm" disabled={!!approving[t.id]} onClick={() => approveTask(t.id)}>
                            {approving[t.id] ? '…' : 'Согласовать'}
                          </Button>
                        </div>
                      ) : isTaken ? (
                        <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', alignItems: 'center' }}>
                          <span className="chs-taken-tag" title={whenLabel ? `Взято ${takenName}, ${whenLabel}` : undefined}>
                            <Icon name="check" /> взято{t.mine ? " (мной)" : ""}{whenLabel ? ` · ${whenLabel}` : ""}
                          </span>
                          <Button variant="ghost" size="sm" onClick={() => setSelectedTaskId(t.id)}>Открыть</Button>
                        </div>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => setSelectedTaskId(t.id)}>Открыть</Button>
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
    </>
  );
}

export default InboxScreen;
