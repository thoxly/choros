/* ============================================================================
   CHOROS — screen-inbox.jsx
   ЭКРАН 2: плотная таблица инбокса задач.
   Колонки: задача · процесс (MonoId) · тип исполнителя · SLA · дедлайн ·
   действие «взять из пула».
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, MonoId, Mono, ExecutorBadge, StatusChip,
  Drawer, EmptyState, LoadingState, ErrorState,
} from '../components/components.jsx';
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

  // Tokenized inline styles — kept in this single in-scope screen file (no new CSS
  // file / app-shell edit). Every value references a --chs-* token; ZERO hardcoded
  // color/spacing (gate G6). The kit Drawer owns surface/scrim/shadow/border.
  const S = {
    section: { marginBottom: 'var(--chs-space-8)' },
    title: {
      margin: '0 0 var(--chs-space-5)', fontSize: 'var(--chs-text-xs)',
      fontWeight: 'var(--chs-weight-semibold)', letterSpacing: 'var(--chs-tracking-wide)',
      textTransform: 'uppercase', color: 'var(--chs-color-text-faint)',
    },
    grid: {
      display: 'grid', gridTemplateColumns: '100px 1fr',
      rowGap: 'var(--chs-space-4)', columnGap: 'var(--chs-space-5)',
      alignItems: 'center', fontSize: 'var(--chs-text-sm)',
    },
    key: { color: 'var(--chs-color-text-muted)' },
    val: { color: 'var(--chs-color-text)', fontWeight: 'var(--chs-weight-medium)' },
    muted: { color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-xs)' },
    notice: {
      marginBottom: 'var(--chs-space-6)', padding: 'var(--chs-space-5) var(--chs-space-6)',
      border: '1px solid transparent', borderRadius: 'var(--chs-radius-3)',
      fontSize: 'var(--chs-text-sm)', lineHeight: 'var(--chs-leading-normal)',
    },
    noticeSuccess: { background: 'var(--chs-color-success-soft)', borderColor: 'var(--chs-color-success)', color: 'var(--chs-color-text)' },
    noticeError: { background: 'var(--chs-color-danger-soft)', borderColor: 'var(--chs-color-danger)', color: 'var(--chs-color-text)' },
    noticeTitle: { fontWeight: 'var(--chs-weight-semibold)', marginBottom: 'var(--chs-space-2)' },
    noticeBody: { color: 'var(--chs-color-text-muted)' },
  };

  // Footer: complete-step action (or a single Close once the step is done).
  // Built outside the JSX tree so the kit Drawer owns the overlay/scrim, focus-trap,
  // Esc and scroll-lock — no hand-rolled fixed-inset modal (gate G6) and no hardcoded color.
  let footer = null;
  if (outcome) {
    footer = <Button variant="secondary" size="sm" onClick={onClose}>Закрыть</Button>;
  } else if (detail) {
    footer = (
      <>
        <Button variant="ghost" size="sm" onClick={onClose}>Закрыть</Button>
        {/* Show complete-step only when the task is still actionable (not done/failed) */}
        {detail.item.status !== 'done' && detail.item.status !== 'failed' && (
          <Button variant="primary" size="sm" disabled={completing} onClick={handleComplete}>
            {completing ? 'Выполнение…' : 'Выполнить шаг'}
          </Button>
        )}
      </>
    );
  }

  return (
    <Drawer open={!!taskId} onClose={onClose} title="Задача" side="right" footer={footer}>
      {loading ? (
        <LoadingState label="Загрузка задачи…" />
      ) : fetchError ? (
        <ErrorState message={`Не удалось загрузить: ${fetchError}`} onRetry={loadDetail} />
      ) : detail ? (
        <>
          {/* Task info */}
          <section style={S.section}>
            <h3 style={S.title}>Задача</h3>
            <div style={S.grid}>
              <span style={S.key}>Название</span>
              <span style={S.val}>{detail.item.name}</span>

              <span style={S.key}>Шаг</span>
              <Mono>{detail.item.step}</Mono>

              <span style={S.key}>Инстанс</span>
              <MonoId>{detail.item.inst}</MonoId>

              <span style={S.key}>Исполнитель</span>
              <ExecutorBadge type={detail.item.execType || 'human'} name={detail.item.execName} />

              <span style={S.key}>Статус</span>
              <StatusChip status={detail.item.status} />

              {detail.item.due && (
                <>
                  <span style={S.key}>Дедлайн</span>
                  <Mono>{detail.item.due}</Mono>
                </>
              )}
            </div>
          </section>

          {/* Process/instance projection (if available) */}
          {detail.projection && (
            <section style={S.section}>
              <h3 style={S.title}>Процесс</h3>
              <div style={S.grid}>
                <span style={S.key}>Инстанс</span>
                <MonoId>{detail.projection.inst}</MonoId>

                <span style={S.key}>Процесс</span>
                <Mono>{detail.projection.procKey}</Mono>

                <span style={S.key}>Текущий шаг</span>
                <span style={S.val}>{detail.projection.step}</span>

                <span style={S.key}>Состояние</span>
                <StatusChip status={detail.projection.status} label={STATUS_LABEL[detail.projection.status]} />

                <span style={S.key}>Запущен</span>
                <Mono style={S.muted}>
                  {new Date(detail.projection.startedAt).toLocaleString('ru-RU')}
                </Mono>
              </div>
            </section>
          )}

          {/* Outcome: shown after step completion */}
          {outcome && (
            <div style={{ ...S.notice, ...S.noticeSuccess }}>
              <div style={S.noticeTitle}>Шаг выполнен</div>
              <div style={S.noticeBody}>
                Процесс <strong>{outcome.instanceId}</strong> перешёл в состояние{' '}
                <strong>{STATUS_LABEL[outcome.status] ?? outcome.status}</strong>.
              </div>
            </div>
          )}

          {/* Action error */}
          {actionError && (
            <div style={{ ...S.notice, ...S.noticeError }}>
              {actionError}
            </div>
          )}
        </>
      ) : null}
    </Drawer>
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
          <ErrorState
            title="Не удалось загрузить задачи"
            message={error}
            onRetry={load}
          />
        ) : items === null ? (
          <LoadingState label="Загрузка задач…" />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Icon name="inbox" />}
            title="Задач нет"
            description="Новые задачи появятся здесь, как только процессы их создадут."
          />
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
