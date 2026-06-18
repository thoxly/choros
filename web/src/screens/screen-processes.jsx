/* ============================================================================
   CHOROS — screen-processes.jsx
   ЭКРАН: плотная таблица процессов (инстансов).
   Колонки: Процесс · Инстанс · Статус · Узел · Прогресс · Запущен · Исполнители · Действие.

   T-0281: добавлена кнопка «Запустить процесс» + modal запуска канонического ТЭЛ.
   Fetch-контракт §2.2 ADR T-0278: POST /api/processes/start с заголовками
   x-dev-user (актор) и x-tenant-id (тенант), тело { processKey: "telLinear" }.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, MonoId, Mono, StatusChip, ExecGlyph } from '../components/components.jsx';
import { devHeaders, getDevUser } from '../app-shell/dev-auth.js';

// Dev tenant UUID — same constant used by screen-org.jsx ExplainPanel and tests.
// The backend resolves tenant scope via x-tenant-id header (process-defs.ts pattern).
const DEV_TENANT_ID = "a0000000-0000-0000-0000-000000000001";

const MARKER_COLOR = {
  running: "var(--chs-color-info)", done: "var(--chs-color-success)",
  failed: "var(--chs-color-danger)", waiting: "var(--chs-color-warning)",
};

/**
 * T-0281: LaunchModal — минимальный modal запуска канонического ТЭЛ-процесса.
 * Fetch-контракт §2.2 (FROZEN): POST /api/processes/start → 201 { instanceId, processKey, tenantId }.
 * На 201 перезагружает список процессов; показывает созданный instanceId.
 */
function LaunchModal({ open, onClose, onLaunched }) {
  const [launching, setLaunching] = useState(false);
  const [result, setResult] = useState(null); // null | { ok, instanceId } | { error }

  const handleLaunch = useCallback(async () => {
    setLaunching(true);
    setResult(null);
    try {
      const user = getDevUser();
      const actor = user?.id ?? "";
      const res = await fetch('/api/processes/start', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dev-user': actor,
          'x-tenant-id': DEV_TENANT_ID,
        },
        body: JSON.stringify({ processKey: 'telLinear' }),
      });
      if (res.status === 201) {
        const data = await res.json();
        setResult({ ok: true, instanceId: data.instanceId });
        if (onLaunched) onLaunched(data);
      } else {
        let errMsg = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          errMsg = body?.error?.message || body?.message || errMsg;
        } catch { /* ignore json parse error */ }
        setResult({ error: errMsg });
      }
    } catch (e) {
      setResult({ error: String(e?.message || e) });
    } finally {
      setLaunching(false);
    }
  }, [onLaunched]);

  const handleClose = useCallback(() => {
    setResult(null);
    onClose();
  }, [onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Запустить процесс"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div style={{
        background: 'var(--chs-bg-secondary, #1e2028)',
        border: '1px solid var(--chs-border, #30333d)',
        borderRadius: '8px',
        padding: '28px 32px',
        minWidth: '360px',
        maxWidth: '480px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      }}>
        <h2 style={{ margin: '0 0 8px 0', fontSize: 'var(--chs-text-lg, 16px)', fontWeight: 600 }}>
          Запустить процесс
        </h2>
        <p style={{ margin: '0 0 20px 0', fontSize: 'var(--chs-text-sm, 13px)', color: 'var(--chs-color-text-muted, #888)' }}>
          Канонический линейный ТЭЛ-процесс (telLinear)
        </p>

        {result?.ok && (
          <div style={{
            marginBottom: '16px', padding: '10px 14px',
            background: 'var(--chs-bg-success-subtle, rgba(56,161,105,0.12))',
            border: '1px solid var(--chs-color-success, #38a169)',
            borderRadius: '6px', fontSize: 'var(--chs-text-sm, 13px)',
          }}>
            Процесс запущен. Инстанс: <strong>{result.instanceId}</strong>
          </div>
        )}

        {result?.error && (
          <div style={{
            marginBottom: '16px', padding: '10px 14px',
            background: 'var(--chs-bg-danger-subtle, rgba(229,62,62,0.12))',
            border: '1px solid var(--chs-color-danger, #e53e3e)',
            borderRadius: '6px', fontSize: 'var(--chs-text-sm, 13px)',
          }}>
            Ошибка: {result.error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={handleClose}>
            {result?.ok ? 'Закрыть' : 'Отмена'}
          </Button>
          {!result?.ok && (
            <Button variant="primary" size="sm" onClick={handleLaunch} disabled={launching}>
              {launching ? 'Запуск…' : 'Запустить'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function ProcessesScreen({ launchOpen, onLaunchClose }) {
  const navigate = useNavigate();
  const [instances, setInstances] = useState(null);
  const [error, setError] = useState(null);
  // T-0281: internal launch modal state (for the in-screen button)
  const [internalLaunchOpen, setInternalLaunchOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/processes', { headers: devHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setInstances(data.instances);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // When a process is launched successfully, close modal and reload list
  const handleLaunched = useCallback(() => {
    setInternalLaunchOpen(false);
    if (onLaunchClose) onLaunchClose();
    load();
  }, [load, onLaunchClose]);

  const handleExternalClose = useCallback(() => {
    if (onLaunchClose) onLaunchClose();
  }, [onLaunchClose]);

  const list = instances || [];
  // Modal is open if triggered internally OR by external (topbar/inbox) caller
  const modalOpen = internalLaunchOpen || Boolean(launchOpen);

  return (
    <>
      <LaunchModal
        open={modalOpen}
        onClose={() => { setInternalLaunchOpen(false); handleExternalClose(); }}
        onLaunched={handleLaunched}
      />
      <div className="chs-inbox">
        {/* T-0281: prominent launch button at top of processes screen */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end',
          padding: 'var(--chs-space-3, 12px) var(--chs-space-4, 16px)',
          borderBottom: '1px solid var(--chs-border, #30333d)',
        }}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setInternalLaunchOpen(true)}
          >
            Запустить процесс
          </Button>
        </div>
      <div className="chs-inbox__scroll">
        {error ? (
          <div style={{ padding: "var(--chs-space-5)", textAlign: "center" }}>
            <p style={{ marginBottom: "var(--chs-space-3)" }}>Не удалось загрузить процессы: {error}</p>
            <Button onClick={load}>Повторить</Button>
          </div>
        ) : instances === null ? (
          <div style={{ padding: "var(--chs-space-5)", textAlign: "center" }}>
            Загрузка процессов…
          </div>
        ) : list.length === 0 ? (
          <div style={{ padding: "var(--chs-space-5)", textAlign: "center" }}>
            Нет процессов
          </div>
        ) : (
          <table className="chs-itable">
            <colgroup>
              <col style={{ width: "auto" }} />
              <col style={{ width: "108px" }} />
              <col style={{ width: "132px" }} />
              <col style={{ width: "176px" }} />
              <col style={{ width: "100px" }} />
              <col style={{ width: "150px" }} />
              <col style={{ width: "120px" }} />
              <col style={{ width: "100px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Процесс</th>
                <th>Инстанс</th>
                <th>Статус</th>
                <th>Текущий узел</th>
                <th>Прогресс</th>
                <th>Запущен</th>
                <th>Исполнители</th>
                <th className="chs-r">Действие</th>
              </tr>
            </thead>
            <tbody>
              {list.map((inst) => (
                <tr key={inst.id}>
                  <td>
                    <div className="chs-task">
                      <span className="chs-task__marker" style={{ background: MARKER_COLOR[inst.status] }} />
                      <span className="chs-task__txt">
                        <span className="chs-task__name">{inst.name}</span>
                        <span className="chs-task__step">{inst.procId}</span>
                      </span>
                    </div>
                  </td>
                  <td><MonoId>{inst.id}</MonoId></td>
                  <td><StatusChip status={inst.status} /></td>
                  <td><Mono style={{ fontSize: "var(--chs-text-sm)" }}>{inst.node}</Mono></td>
                  <td>
                    <Mono style={{ fontSize: "var(--chs-text-sm)", color: "var(--chs-color-text-muted)" }}>
                      {inst.progress.done}/{inst.progress.total}
                    </Mono>
                  </td>
                  <td><Mono style={{ fontSize: "var(--chs-text-xs)", color: "var(--chs-color-text-muted)" }}>{inst.started}</Mono></td>
                  <td>
                    <div style={{ display: "flex", gap: "var(--chs-space-2)" }}>
                      {inst.execs.map((execType, idx) => (
                        <ExecGlyph key={idx} type={execType} size={9} filled={true} />
                      ))}
                    </div>
                  </td>
                  <td className="chs-r">
                    <Button variant="ghost" size="sm" onClick={() => navigate('/audit')}>Открыть</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </div>
    </>
  );
}

export default ProcessesScreen;
