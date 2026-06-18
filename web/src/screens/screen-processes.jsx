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
import { authHeaders, getDevUser } from '../app-shell/dev-auth.js';
import {
  validateBindingForm,
  buildBindingPayload,
  definitionSourceLabel,
  definitionStatusLabel,
  applicationOptions,
  definitionOptions,
  bindingApplicationLabel,
  mapBindingError,
} from './process-catalog.js';

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

/**
 * T-0270: ProcessCatalogSection — REAL process definitions + the process↔application
 * binding UI ("процессы ↔ приложения"). Reads GET /api/process-catalog (real
 * definitions from process_definition + real instances from the audit-backed
 * projection — NO mock) and GET /api/applications. The «Связать с приложением» modal
 * POSTs /api/process-app-bindings. All calls use authHeaders() (mode-aware).
 */
function ProcessCatalogSection() {
  const [catalog, setCatalog] = useState(null); // null | { definitions, instances, bindings }
  const [apps, setApps] = useState([]);
  const [error, setError] = useState(null);
  const [bindOpen, setBindOpen] = useState(false);

  const loadCatalog = useCallback(async () => {
    setError(null);
    try {
      const [catRes, appsRes] = await Promise.all([
        fetch('/api/process-catalog', { headers: authHeaders() }),
        fetch('/api/applications', { headers: authHeaders() }),
      ]);
      if (!catRes.ok) throw new Error(`HTTP ${catRes.status}`);
      const catData = await catRes.json();
      setCatalog({
        definitions: catData.definitions || [],
        instances: catData.instances || [],
        bindings: catData.bindings || [],
      });
      if (appsRes.ok) {
        const appsData = await appsRes.json();
        setApps(appsData.applications || []);
      } else {
        setApps([]);
      }
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const handleBound = useCallback(() => {
    setBindOpen(false);
    loadCatalog();
  }, [loadCatalog]);

  const defs = catalog?.definitions || [];
  const bindings = catalog?.bindings || [];

  return (
    <div style={{
      borderTop: '1px solid var(--chs-border, #30333d)',
      padding: 'var(--chs-space-4, 16px)',
    }}>
      <BindProcessModal
        open={bindOpen}
        onClose={() => setBindOpen(false)}
        onBound={handleBound}
        definitions={defs}
        applications={apps}
      />

      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 'var(--chs-space-3, 12px)',
      }}>
        <h2 style={{ margin: 0, fontSize: 'var(--chs-text-md, 14px)', fontWeight: 600 }}>
          Определения процессов · связь с приложениями
        </h2>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setBindOpen(true)}
          disabled={defs.length === 0 || apps.length === 0}
          title={
            defs.length === 0
              ? 'Нет процессов для связывания'
              : apps.length === 0
                ? 'Сначала создайте приложение в конструкторе'
                : 'Связать процесс с приложением'
          }
        >
          Связать с приложением
        </Button>
      </div>

      {error ? (
        <div style={{ padding: 'var(--chs-space-4)', textAlign: 'center' }}>
          <p style={{ marginBottom: 'var(--chs-space-3)' }}>Не удалось загрузить каталог: {error}</p>
          <Button onClick={loadCatalog}>Повторить</Button>
        </div>
      ) : catalog === null ? (
        <div style={{ padding: 'var(--chs-space-4)', textAlign: 'center' }}>Загрузка каталога…</div>
      ) : (
        <>
          {/* REAL definitions */}
          {defs.length === 0 ? (
            <div style={{
              padding: 'var(--chs-space-4)', textAlign: 'center',
              color: 'var(--chs-color-text-muted, #888)', fontSize: 'var(--chs-text-sm, 13px)',
            }}>
              Пока нет ни одного определения процесса. Создайте процесс в конструкторе
              или запустите канонический ТЭЛ — реальные определения появятся здесь.
            </div>
          ) : (
            <table className="chs-itable" style={{ marginBottom: 'var(--chs-space-4, 16px)' }}>
              <thead>
                <tr>
                  <th>Определение</th>
                  <th>Ключ</th>
                  <th>Источник</th>
                  <th>Статус</th>
                  <th className="chs-r">Инстансов</th>
                </tr>
              </thead>
              <tbody>
                {defs.map((d) => (
                  <tr key={d.process_key}>
                    <td>{d.name}</td>
                    <td><MonoId>{d.process_key}</MonoId></td>
                    <td>{definitionSourceLabel(d.source)}</td>
                    <td>{definitionStatusLabel(d.status)}</td>
                    <td className="chs-r">
                      <Mono style={{ color: 'var(--chs-color-text-muted)' }}>{d.instance_count}</Mono>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Bindings: процессы ↔ приложения */}
          <h3 style={{
            margin: 'var(--chs-space-3, 12px) 0 var(--chs-space-2, 8px) 0',
            fontSize: 'var(--chs-text-sm, 13px)', fontWeight: 600,
            color: 'var(--chs-color-text-muted, #888)',
          }}>
            Связи процессов с приложениями
          </h3>
          {bindings.length === 0 ? (
            <div style={{
              padding: 'var(--chs-space-3)',
              color: 'var(--chs-color-text-muted, #888)', fontSize: 'var(--chs-text-sm, 13px)',
            }}>
              Связей пока нет. Нажмите «Связать с приложением», чтобы показать, какому
              приложению принадлежит процесс.
            </div>
          ) : (
            <table className="chs-itable">
              <thead>
                <tr>
                  <th>Процесс</th>
                  <th>Приложение</th>
                  <th>Форма</th>
                </tr>
              </thead>
              <tbody>
                {bindings.map((b) => (
                  <tr key={b.id}>
                    <td><MonoId>{b.process_key}</MonoId></td>
                    <td>{bindingApplicationLabel(b)}</td>
                    <td>
                      {b.form_key
                        ? <Mono style={{ fontSize: 'var(--chs-text-sm)' }}>{b.form_key}</Mono>
                        : <span style={{ color: 'var(--chs-color-text-muted, #888)' }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

/**
 * T-0270: BindProcessModal — pick a process definition + an application (+ optional
 * form key) and POST /api/process-app-bindings. authHeaders() on the call.
 */
function BindProcessModal({ open, onClose, onBound, definitions, applications }) {
  const [processKey, setProcessKey] = useState('');
  const [applicationId, setApplicationId] = useState('');
  const [formKey, setFormKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);

  const defOpts = definitionOptions(definitions);
  const appOpts = applicationOptions(applications);

  const reset = useCallback(() => {
    setProcessKey('');
    setApplicationId('');
    setFormKey('');
    setFieldErrors({});
    setSubmitError(null);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const handleSubmit = useCallback(async () => {
    const form = { process_key: processKey, application_id: applicationId, form_key: formKey };
    const { valid, errors } = validateBindingForm(form);
    setFieldErrors(errors);
    setSubmitError(null);
    if (!valid) return;

    setSubmitting(true);
    try {
      const res = await fetch('/api/process-app-bindings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(buildBindingPayload(form)),
      });
      if (res.status === 201) {
        reset();
        if (onBound) onBound();
      } else {
        let parsed = null;
        try { parsed = await res.json(); } catch { /* ignore */ }
        const mapped = mapBindingError(res.status, parsed);
        if (mapped.field) setFieldErrors((prev) => ({ ...prev, [mapped.field]: mapped.message }));
        else setSubmitError(mapped.message);
      }
    } catch (e) {
      setSubmitError(String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  }, [processKey, applicationId, formKey, reset, onBound]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Связать процесс с приложением"
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
        borderRadius: '8px', padding: '28px 32px', minWidth: '380px', maxWidth: '520px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      }}>
        <h2 style={{ margin: '0 0 18px 0', fontSize: 'var(--chs-text-lg, 16px)', fontWeight: 600 }}>
          Связать процесс с приложением
        </h2>

        <label style={{ display: 'block', marginBottom: '14px' }}>
          <span style={{ display: 'block', marginBottom: '4px', fontSize: 'var(--chs-text-sm, 13px)' }}>Процесс</span>
          <select
            value={processKey}
            onChange={(e) => setProcessKey(e.target.value)}
            style={{ width: '100%', padding: '6px 8px' }}
          >
            <option value="">— выберите процесс —</option>
            {defOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {fieldErrors.process_key && (
            <span style={{ color: 'var(--chs-color-danger, #e53e3e)', fontSize: 'var(--chs-text-xs, 11px)' }}>{fieldErrors.process_key}</span>
          )}
        </label>

        <label style={{ display: 'block', marginBottom: '14px' }}>
          <span style={{ display: 'block', marginBottom: '4px', fontSize: 'var(--chs-text-sm, 13px)' }}>Приложение</span>
          <select
            value={applicationId}
            onChange={(e) => setApplicationId(e.target.value)}
            style={{ width: '100%', padding: '6px 8px' }}
          >
            <option value="">— выберите приложение —</option>
            {appOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {fieldErrors.application_id && (
            <span style={{ color: 'var(--chs-color-danger, #e53e3e)', fontSize: 'var(--chs-text-xs, 11px)' }}>{fieldErrors.application_id}</span>
          )}
        </label>

        <label style={{ display: 'block', marginBottom: '18px' }}>
          <span style={{ display: 'block', marginBottom: '4px', fontSize: 'var(--chs-text-sm, 13px)' }}>Форма (необязательно)</span>
          <input
            type="text"
            value={formKey}
            placeholder="purchase-form"
            onChange={(e) => setFormKey(e.target.value)}
            style={{ width: '100%', padding: '6px 8px', boxSizing: 'border-box' }}
          />
        </label>

        {submitError && (
          <div style={{
            marginBottom: '16px', padding: '10px 14px',
            background: 'var(--chs-bg-danger-subtle, rgba(229,62,62,0.12))',
            border: '1px solid var(--chs-color-danger, #e53e3e)',
            borderRadius: '6px', fontSize: 'var(--chs-text-sm, 13px)',
          }}>
            {submitError}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={handleClose}>Отмена</Button>
          <Button variant="primary" size="sm" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Сохранение…' : 'Связать'}
          </Button>
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
      const res = await fetch('/api/processes', { headers: authHeaders() });
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
      {/* T-0270: REAL definitions + процессы↔приложения binding (under the instances). */}
      <ProcessCatalogSection />
      </div>
    </>
  );
}

export default ProcessesScreen;
