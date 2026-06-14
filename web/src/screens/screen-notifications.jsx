/* ============================================================================
   CHOROS — screen-notifications.jsx  (T-0203)
   In-app notification center + per-event self-preferences.

   Tab «Центр»     — list of own notifications (GET /api/notifications),
                      mark-one-read (POST /:id/read), mark-all (PATCH),
                      live unread badge (GET /api/notifications/unread-count).
   Tab «Настройки» — own per-event subscriptions: which channels per event_kind
                      (GET/PUT /api/notification-preferences/self).

   This is the in-app delivery surface the ADR T-0120 §2.2 calls for — separate
   concept/screen from the task-inbox (screen-inbox.jsx). All requests are
   own-only and tenant-scoped server-side (FF-OWN-ONLY-READ / FF-NO-CROSS-USER /
   FF-SELF-PREF-SCOPED enforced on the server, not here).
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';

// Event kinds the user can self-subscribe to (ADR §2.4 closed-extensible vocab).
// Mirrors DEFAULT_PREFERENCES in src/core/postgres/pgPrefStore.ts. Kept in lockstep:
// a row that the server does not know simply UPSERTs a new preference (still valid).
const EVENT_KINDS = [
  { kind: 'task.assigned',      label: 'Задача назначена' },
  { kind: 'approval.requested', label: 'Запрошен апрув' },
  { kind: 'sla.warning',        label: 'SLA-предупреждение' },
  { kind: 'sla.breach',         label: 'SLA нарушен' },
  { kind: 'escalation.raised',  label: 'Эскалация' },
];

// Channels offered in the self-settings UI (ChannelDriver keys, ADR §2.5).
const CHANNELS = [
  { key: 'in_app', label: 'В приложении' },
  { key: 'email',  label: 'Email' },
];

/** Render an epoch-ms created_at as a compact «когда» label. */
function whenLabel(createdAt) {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return '';
  const diffMin = Math.floor((Date.now() - createdAt) / 60000);
  if (diffMin <= 0) return 'сейчас';
  if (diffMin < 60) return `${diffMin} мин назад`;
  const d = new Date(createdAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/* ---------------------------------------------------------------------------
   Center tab — own notification list + mark-read
   --------------------------------------------------------------------------- */
function CenterTab() {
  const [items, setItems] = useState(null);
  const [unread, setUnread] = useState(0);
  const [filter, setFilter] = useState('all'); // all | unread
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (filter === 'unread') qs.set('is_read', 'false');
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const [listRes, countRes] = await Promise.all([
        fetch(`/api/notifications${suffix}`, { headers: devHeaders() }),
        fetch('/api/notifications/unread-count', { headers: devHeaders() }),
      ]);
      if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
      const listData = await listRes.json();
      setItems(listData.notifications || []);
      if (countRes.ok) {
        const c = await countRes.json();
        setUnread(c.count || 0);
      }
    } catch (e) {
      setError(e.message);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const markRead = async (id) => {
    try {
      const res = await fetch(`/api/notifications/${id}/read`, { method: 'POST', headers: devHeaders() });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const markAll = async () => {
    const ids = (items || []).filter((n) => !n.is_read).map((n) => n.id);
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const res = await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { ...devHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chs-notif">
      <div className="chs-notif__bar">
        <div className="chs-tabs">
          <button className="chs-tab" aria-selected={filter === 'all' ? 'true' : undefined} onClick={() => setFilter('all')}>
            Все
          </button>
          <button className="chs-tab" aria-selected={filter === 'unread' ? 'true' : undefined} onClick={() => setFilter('unread')}>
            Непрочитанные<span className="chs-tab__count">{unread}</span>
          </button>
        </div>
        <div className="chs-notif__spacer" />
        <Button variant="secondary" size="sm" disabled={busy || unread === 0} onClick={markAll}>
          Прочитать все
        </Button>
      </div>

      <div className="chs-notif__scroll">
        {error ? (
          <div style={{ padding: 'var(--chs-space-5)', textAlign: 'center' }}>
            <p style={{ marginBottom: 'var(--chs-space-3)' }}>Не удалось загрузить уведомления: {error}</p>
            <Button onClick={load}>Повторить</Button>
          </div>
        ) : items === null ? (
          <div style={{ padding: 'var(--chs-space-5)', textAlign: 'center' }}>Загрузка уведомлений…</div>
        ) : items.length === 0 ? (
          <div style={{ padding: 'var(--chs-space-5)', textAlign: 'center' }}>Нет уведомлений</div>
        ) : (
          <ul className="chs-notif__list">
            {items.map((n) => (
              <li key={n.id} className="chs-notif__row" data-read={n.is_read ? 'true' : undefined}>
                <span className="chs-notif__dot" aria-hidden="true" data-unread={!n.is_read ? 'true' : undefined} />
                <span className="chs-notif__body">
                  <span className="chs-notif__title">{n.title}</span>
                  <span className="chs-notif__text">{n.body}</span>
                  <span className="chs-notif__meta">{n.event_kind} · {whenLabel(n.created_at)}</span>
                </span>
                {!n.is_read && (
                  <button className="chs-notif__action" onClick={() => markRead(n.id)} title="Отметить прочитанным">
                    <Icon name="check" /> прочитать
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Settings tab — own per-event channel preferences (actor:<self>)
   --------------------------------------------------------------------------- */
function SettingsTab() {
  // prefs: { [event_kind]: Set<channel> } — derived from the server's self rows.
  const [prefs, setPrefs] = useState(null);
  const [error, setError] = useState(null);
  const [savingKind, setSavingKind] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/notification-preferences/self', { headers: devHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const map = {};
      for (const p of data.preferences || []) {
        map[p.eventKind] = new Set(p.channels || []);
      }
      setPrefs(map);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const channelsFor = (kind) => prefs?.[kind] ?? new Set();

  const toggle = async (kind, channel) => {
    const cur = new Set(channelsFor(kind));
    if (cur.has(channel)) cur.delete(channel);
    else cur.add(channel);
    setSavingKind(kind);
    try {
      // Self endpoint constructs recipient_scope = actor:<self> server-side;
      // the body must NOT carry actor:/role: scope (FF-SELF-PREF-SCOPED).
      const res = await fetch('/api/notification-preferences/self', {
        method: 'PUT',
        headers: { ...devHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventKind: kind, channels: [...cur] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Optimistic local update, then reload to stay authoritative.
      setPrefs((p) => ({ ...(p || {}), [kind]: cur }));
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingKind(null);
    }
  };

  return (
    <div className="chs-notif">
      <div className="chs-notif__scroll" style={{ padding: 'var(--chs-space-4)' }}>
        {error ? (
          <div style={{ padding: 'var(--chs-space-5)', textAlign: 'center' }}>
            <p style={{ marginBottom: 'var(--chs-space-3)' }}>Не удалось загрузить настройки: {error}</p>
            <Button onClick={load}>Повторить</Button>
          </div>
        ) : prefs === null ? (
          <div style={{ padding: 'var(--chs-space-5)', textAlign: 'center' }}>Загрузка настроек…</div>
        ) : (
          <table className="chs-itable">
            <thead>
              <tr>
                <th>Событие</th>
                {CHANNELS.map((c) => <th key={c.key} className="chs-r">{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {EVENT_KINDS.map((ev) => {
                const active = channelsFor(ev.kind);
                return (
                  <tr key={ev.kind} data-saving={savingKind === ev.kind ? 'true' : undefined}>
                    <td>
                      <span className="chs-task__name">{ev.label}</span>
                      <span className="chs-task__step">{ev.kind}</span>
                    </td>
                    {CHANNELS.map((c) => (
                      <td key={c.key} className="chs-r">
                        <input
                          type="checkbox"
                          checked={active.has(c.key)}
                          disabled={savingKind === ev.kind}
                          onChange={() => toggle(ev.kind, c.key)}
                          aria-label={`${ev.label} → ${c.label}`}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p style={{ marginTop: 'var(--chs-space-4)', color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
          Email доставляется только если администратор включил email-канал тенанта.
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Screen — top-level tab switch
   --------------------------------------------------------------------------- */
function NotificationsScreen() {
  const [tab, setTab] = useState('center'); // center | settings
  return (
    <div className="chs-notif-screen">
      <div className="chs-subtabs">
        <button className="chs-subtab" aria-selected={tab === 'center'} onClick={() => setTab('center')}>
          Центр
        </button>
        <button className="chs-subtab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>
          Настройки
        </button>
      </div>
      {tab === 'center' ? <CenterTab /> : <SettingsTab />}
    </div>
  );
}

export default NotificationsScreen;
