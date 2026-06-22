/* ============================================================================
   CHOROS — ra-criticality.jsx
   ЭКРАН 2: КРИТИЧНОСТЬ И DUAL-CONTROL.

   T-0390 [D2-FU]: wired to real dual-control change-request API.
     GET  /api/rights/change-requests          — pending change requests (paged)
     POST /api/rights/change-requests/:id/approve|reject — dual-control action

   UX invariants:
     G2 — consumes design-system tokens only (no hardcoded colours).
     G5 — no dev-jargon in visible text.
     G6 — no new inline styles or raw colour literals.
   Honest states: loading / error / empty / list.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import {
  EmptyState,
  LoadingState,
  ErrorState,
  Button,
  useToasts,
  ToastViewport,
} from '../../components/components.jsx';
import { Icon } from '../../app-shell/icon.jsx';
import { devHeaders } from '../../app-shell/dev-auth.js';

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchChangeRequests() {
  const res = await fetch('/api/rights/change-requests', {
    headers: devHeaders(),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

async function decideChangeRequest(id, action, reason) {
  const res = await fetch(`/api/rights/change-requests/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...devHeaders() },
    body: JSON.stringify(reason ? { reason } : {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const code = body?.error?.code ?? `HTTP ${res.status}`;
    if (res.status === 409 && code === 'DUAL_CONTROL_SELF_APPROVE') {
      throw new Error('Нельзя одобрить собственный запрос — требуется другой сотрудник.');
    }
    if (res.status === 409 && code === 'ALREADY_CONFIRMED') {
      throw new Error('Запрос уже обработан другим сотрудником.');
    }
    if (res.status === 403 && code === 'AGENT_NOT_ALLOWED') {
      throw new Error('Агент не может подтверждать изменения прав — требуется сотрудник.');
    }
    throw new Error(body?.error?.message ?? code);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function KindChip({ kind }) {
  const label = kind === 'grant' ? 'Грант' : 'Назначение';
  return (
    <span className={`chs-chip chs-chip--${kind === 'grant' ? 'grant' : 'assignment'}`}>
      {label}
    </span>
  );
}

function ChangeRequestRow({ item, onApprove, onReject, busy }) {
  return (
    <div className="chs-cr-row">
      <div className="chs-cr-row__header">
        <KindChip kind={item.kind} />
        <span className="chs-cr-row__desc">{item.description}</span>
        {item.role_name && (
          <span className="chs-cr-row__role">Роль: {item.role_name}</span>
        )}
      </div>
      <div className="chs-cr-row__meta">
        <span className="chs-cr-row__proposer">
          Инициатор: <strong>{item.proposed_by ?? item.confirmed_by}</strong>
        </span>
        <span className="chs-cr-row__date">
          {new Date(item.created_at).toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}
        </span>
      </div>
      <div className="chs-cr-row__actions">
        <Button
          variant="primary"
          size="sm"
          disabled={busy !== null}
          loading={busy === item.id + ':approve'}
          onClick={() => onApprove(item.id)}
        >
          Одобрить
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          loading={busy === item.id + ':reject'}
          onClick={() => onReject(item.id)}
        >
          Отклонить
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

function CriticalityScreen() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null); // "<id>:approve" | "<id>:reject" | null
  const { toasts, push: pushToast } = useToasts();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await fetchChangeRequests();
      setData(result);
    } catch (e) {
      setLoadError(e.message ?? 'Не удалось загрузить запросы.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleApprove = useCallback(async (id) => {
    setBusy(id + ':approve');
    try {
      await decideChangeRequest(id, 'approve', null);
      pushToast({ tone: 'success', message: 'Изменение одобрено.' });
      await load();
    } catch (e) {
      pushToast({ tone: 'error', message: e.message ?? 'Не удалось одобрить запрос.' });
    } finally {
      setBusy(null);
    }
  }, [load, pushToast]);

  const handleReject = useCallback(async (id) => {
    setBusy(id + ':reject');
    try {
      await decideChangeRequest(id, 'reject', null);
      pushToast({ tone: 'success', message: 'Изменение отклонено.' });
      await load();
    } catch (e) {
      pushToast({ tone: 'error', message: e.message ?? 'Не удалось отклонить запрос.' });
    } finally {
      setBusy(null);
    }
  }, [load, pushToast]);

  // Render: loading → error → empty → list
  if (loading) {
    return (
      <div className="chs-crit-screen">
        <div className="chs-crit-screen__inner">
          <LoadingState label="Загрузка запросов…" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="chs-crit-screen">
        <div className="chs-crit-screen__inner">
          <ErrorState
            title="Не удалось загрузить запросы"
            message={loadError}
            onRetry={load}
          />
        </div>
      </div>
    );
  }

  const items = data?.change_requests ?? [];

  if (items.length === 0) {
    return (
      <div className="chs-crit-screen">
        <div className="chs-crit-screen__inner">
          <EmptyState
            icon={<Icon name="rights" />}
            title="Запросов на изменение прав нет"
            description="Когда кто-то запросит изменение роли, требующее подтверждения, оно появится здесь. Критичные изменения требуют двух подтверждений."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="chs-crit-screen">
      <div className="chs-crit-screen__inner">
        <div className="chs-crit-screen__header">
          <h2 className="chs-crit-screen__title">
            Запросы на изменение прав
          </h2>
          <span className="chs-crit-screen__count">
            {items.length}
            {' '}
            {items.length === 1 ? 'запрос' : items.length < 5 ? 'запроса' : 'запросов'}
          </span>
        </div>
        <div className="chs-cr-list">
          {items.map((item) => (
            <ChangeRequestRow
              key={item.id}
              item={item}
              onApprove={handleApprove}
              onReject={handleReject}
              busy={busy}
            />
          ))}
        </div>
      </div>
      <ToastViewport toasts={toasts} />
    </div>
  );
}

export default CriticalityScreen;
