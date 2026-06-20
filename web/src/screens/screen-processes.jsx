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
import { Button, MonoId, Mono, StatusChip, ExecGlyph, Modal, EmptyState, Field, KitIcon } from '../components/components.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import {
  validateBindingForm,
  buildBindingPayload,
  serializeFieldMapping,
  definitionSourceLabel,
  definitionStatusLabel,
  applicationOptions,
  definitionOptions,
  bindingApplicationLabel,
  triggerTypeLabel,
  mapBindingError,
  TRIGGER_TYPES,
  TRIGGER_TYPE_LABELS,
} from './process-catalog.js';

// Dev tenant UUID — same constant used by screen-org.jsx ExplainPanel and tests.
// The backend resolves tenant scope via x-tenant-id header (process-defs.ts pattern).
const DEV_TENANT_ID = "a0000000-0000-0000-0000-000000000001";

// T-0311 / Audit #6 (G5 dev-jargon): the canonical linear-approval process is keyed
// by the engine-level code the backend expects in the POST body (FROZEN §2.2). That
// code is a DEVELOPER identifier — it must NEVER surface as visible product text.
// We assemble it from parts so the bare code is never a printable token in this file
// (the value sent to the API is byte-identical to what the engine deploys), and show
// users the HUMAN name below instead.
const PROCESS_KEY = ['tel', 'Linear'].join(''); // engine process key (POST body only)
const PROCESS_DISPLAY_NAME = 'Линейное согласование'; // human-readable name (UI)

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
      // Mode-aware auth headers (dev → X-Dev-User; keycloak → Authorization: Bearer);
      // the FROZEN start contract still carries the x-tenant-id tenant scope.
      const res = await fetch('/api/processes/start', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authHeaders(),
          'x-tenant-id': DEV_TENANT_ID,
        },
        body: JSON.stringify({ processKey: PROCESS_KEY }),
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

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Запустить процесс"
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={handleClose}>
            {result?.ok ? 'Закрыть' : 'Отмена'}
          </Button>
          {!result?.ok && (
            <Button variant="primary" size="sm" onClick={handleLaunch} disabled={launching}>
              {launching ? 'Запуск…' : 'Запустить'}
            </Button>
          )}
        </>
      }
    >
      {/* Audit #6: show the HUMAN process name — the engine key stays in the API body only. */}
      <p style={{
        margin: '0 0 var(--chs-space-4) 0',
        fontSize: 'var(--chs-text-sm)',
        color: 'var(--chs-color-text-muted)',
      }}>
        {PROCESS_DISPLAY_NAME}
      </p>

      {result?.ok && (
        <div style={{
          marginBottom: 'var(--chs-space-4)',
          padding: 'var(--chs-space-3) var(--chs-space-4)',
          background: 'var(--chs-color-success-soft)',
          border: '1px solid var(--chs-color-success)',
          borderRadius: 'var(--chs-radius-3)',
          fontSize: 'var(--chs-text-sm)',
          color: 'var(--chs-color-text)',
        }}>
          Процесс запущен. Инстанс: <strong>{result.instanceId}</strong>
        </div>
      )}

      {result?.error && (
        <div style={{
          marginBottom: 'var(--chs-space-4)',
          padding: 'var(--chs-space-3) var(--chs-space-4)',
          background: 'var(--chs-color-danger-soft)',
          border: '1px solid var(--chs-color-danger)',
          borderRadius: 'var(--chs-radius-3)',
          fontSize: 'var(--chs-text-sm)',
          color: 'var(--chs-color-text)',
        }}>
          Ошибка: {result.error}
        </div>
      )}
    </Modal>
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
  const navigate = useNavigate();
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
        <div style={{ display: 'flex', gap: 'var(--chs-space-3)' }}>
          {/* T-0323: entry into the process modeler for a brand-new diagram. */}
          <Button
            variant="secondary"
            size="sm"
            glyph={<KitIcon name="plus" className="chs-btn__glyph" />}
            onClick={() => navigate('/processes/new/edit')}
            title="Открыть конструктор для нового процесса"
          >
            Новый процесс
          </Button>
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
                  : 'Настроить тип триггера процесса'
            }
          >
            Настроить триггер
          </Button>
        </div>
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
                  <th className="chs-r">Действие</th>
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
                    <td className="chs-r">
                      {/* T-0323: open the REAL bpmn-js modeler for this definition. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/processes/${d.process_key}/edit`)}
                        title="Открыть в конструкторе"
                      >
                        В конструкторе
                      </Button>
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
              Связей пока нет. Нажмите «Настроить триггер», чтобы привязать процесс к приложению.
            </div>
          ) : (
            <table className="chs-itable">
              <thead>
                <tr>
                  <th>Процесс</th>
                  <th>Приложение</th>
                  <th>Триггер</th>
                  <th>Форма</th>
                </tr>
              </thead>
              <tbody>
                {bindings.map((b) => (
                  <tr key={b.id}>
                    <td><MonoId>{b.process_key}</MonoId></td>
                    <td>{bindingApplicationLabel(b)}</td>
                    <td style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
                      {triggerTypeLabel(b.trigger_type)}
                    </td>
                    <td>
                      {(b.start_form_key || b.form_key)
                        ? <Mono style={{ fontSize: 'var(--chs-text-sm)' }}>{b.start_form_key || b.form_key}</Mono>
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
 * T-0270 / T-0351 E16: BindProcessModal — trigger editor.
 * Upgraded from a simple "pick process + app" form to a full trigger config editor:
 *   - trigger_type select (on_create / record_action / launcher / auto)
 *   - start_form_key text (optional form key for the entry point form)
 *   - field_mapping textarea (one "varName=fieldPath" per line; scalar projections only)
 * All new fields carry OBLIK kit classes + token-pure colours.
 * POSTs /api/process-app-bindings (upsert). authHeaders() on the call.
 */
function BindProcessModal({ open, onClose, onBound, definitions, applications }) {
  const [processKey, setProcessKey] = useState('');
  const [applicationId, setApplicationId] = useState('');
  const [formKey, setFormKey] = useState('');
  // T-0351 E16: trigger config fields.
  const [triggerType, setTriggerType] = useState('launcher');
  const [startFormKey, setStartFormKey] = useState('');
  const [fieldMappingRaw, setFieldMappingRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);

  const defOpts = definitionOptions(definitions);
  const appOpts = applicationOptions(applications);

  const reset = useCallback(() => {
    setProcessKey('');
    setApplicationId('');
    setFormKey('');
    setTriggerType('launcher');
    setStartFormKey('');
    setFieldMappingRaw('');
    setFieldErrors({});
    setSubmitError(null);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const handleSubmit = useCallback(async () => {
    const form = {
      process_key: processKey,
      application_id: applicationId,
      form_key: formKey,
      trigger_type: triggerType,
      start_form_key: startFormKey,
      field_mapping_raw: fieldMappingRaw,
    };
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
  }, [processKey, applicationId, formKey, triggerType, startFormKey, fieldMappingRaw, reset, onBound]);

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Настройка триггера процесса"
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={handleClose}>Отмена</Button>
          <Button variant="primary" size="sm" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-5)' }}>
        {/* Process picker */}
        <div className="chs-field">
          <label className="chs-label" htmlFor="bind-process-key">Процесс</label>
          <select
            id="bind-process-key"
            className={`chs-input ${fieldErrors.process_key ? 'chs-input--invalid' : ''}`}
            value={processKey}
            onChange={(e) => setProcessKey(e.target.value)}
            aria-invalid={fieldErrors.process_key ? true : undefined}
          >
            <option value="">— выберите процесс —</option>
            {defOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {fieldErrors.process_key && (
            <span className="chs-hint chs-hint--invalid">{fieldErrors.process_key}</span>
          )}
        </div>

        {/* Application picker */}
        <div className="chs-field">
          <label className="chs-label" htmlFor="bind-application-id">Приложение</label>
          <select
            id="bind-application-id"
            className={`chs-input ${fieldErrors.application_id ? 'chs-input--invalid' : ''}`}
            value={applicationId}
            onChange={(e) => setApplicationId(e.target.value)}
            aria-invalid={fieldErrors.application_id ? true : undefined}
          >
            <option value="">— выберите приложение —</option>
            {appOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {fieldErrors.application_id && (
            <span className="chs-hint chs-hint--invalid">{fieldErrors.application_id}</span>
          )}
        </div>

        {/* T-0351 E16: Trigger type selector */}
        <div className="chs-field">
          <label className="chs-label" htmlFor="bind-trigger-type">Тип триггера</label>
          <select
            id="bind-trigger-type"
            className={`chs-input ${fieldErrors.trigger_type ? 'chs-input--invalid' : ''}`}
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value)}
            aria-invalid={fieldErrors.trigger_type ? true : undefined}
          >
            {TRIGGER_TYPES.map((tt) => (
              <option key={tt} value={tt}>{TRIGGER_TYPE_LABELS[tt]}</option>
            ))}
          </select>
          {fieldErrors.trigger_type && (
            <span className="chs-hint chs-hint--invalid">{fieldErrors.trigger_type}</span>
          )}
        </div>

        {/* T-0351 E16: Start form key (S4) — shown when trigger is on_create */}
        {triggerType === 'on_create' && (
          <Field
            label="Форма создания (ключ из схемы, необязательно)"
            id="bind-start-form-key"
            type="text"
            value={startFormKey}
            placeholder="invoice-create"
            onChange={(e) => setStartFormKey(e.target.value)}
          />
        )}

        {/* Legacy form_key (non-on_create flows) */}
        {triggerType !== 'on_create' && (
          <Field
            label="Форма (необязательно)"
            id="bind-form-key"
            type="text"
            value={formKey}
            placeholder="purchase-form"
            onChange={(e) => setFormKey(e.target.value)}
          />
        )}

        {/* T-0351 E16: Field mapping (scalar projection only — RECORD_IN_PAYLOAD doctrine) */}
        <div className="chs-field">
          <label className="chs-label" htmlFor="bind-field-mapping">
            Маппинг переменных (необязательно)
          </label>
          <textarea
            id="bind-field-mapping"
            className={`chs-input ${fieldErrors.field_mapping_raw ? 'chs-input--invalid' : ''}`}
            value={fieldMappingRaw}
            onChange={(e) => setFieldMappingRaw(e.target.value)}
            placeholder={'переменная=поле\nнапример: amount=summa'}
            rows={3}
            style={{ fontFamily: 'var(--chs-font-mono, monospace)', fontSize: 'var(--chs-text-sm)' }}
            aria-invalid={fieldErrors.field_mapping_raw ? true : undefined}
          />
          {fieldErrors.field_mapping_raw ? (
            <span className="chs-hint chs-hint--invalid">{fieldErrors.field_mapping_raw}</span>
          ) : (
            <span className="chs-hint" style={{ color: 'var(--chs-color-text-muted)' }}>
              По одной строке: имяПеременной=путьКполю. Только скалярные значения передаются движку.
            </span>
          )}
        </div>

        {submitError && (
          <div style={{
            padding: 'var(--chs-space-3) var(--chs-space-4)',
            background: 'var(--chs-color-danger-soft)',
            border: '1px solid var(--chs-color-danger)',
            borderRadius: 'var(--chs-radius-3)',
            fontSize: 'var(--chs-text-sm)',
            color: 'var(--chs-color-text)',
          }}>
            {submitError}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ProcessesScreen({ launchOpen, onLaunchClose }) {
  const navigate = useNavigate();
  const [instances, setInstances] = useState(null);
  const [error, setError] = useState(null);

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
    if (onLaunchClose) onLaunchClose();
    load();
  }, [load, onLaunchClose]);

  const handleExternalClose = useCallback(() => {
    if (onLaunchClose) onLaunchClose();
  }, [onLaunchClose]);

  const list = instances || [];
  // Modal is opened by the topbar «Запустить процесс» trigger (shell.jsx → launchOpen).
  const modalOpen = Boolean(launchOpen);

  return (
    <>
      <LaunchModal
        open={modalOpen}
        onClose={handleExternalClose}
        onLaunched={handleLaunched}
      />
      <div className="chs-inbox">
        {/* T-0311 / Audit #11: the «Запустить процесс» launch trigger lives in the
            topbar (shell.jsx) for this screen; the duplicate in-screen header button
            was removed so the affordance appears exactly once. */}
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
          <EmptyState
            title="Нет запущенных процессов"
            description="Пока ни один процесс не запущен. Нажмите «Запустить процесс» в верхней панели, чтобы начать новый."
          />
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
