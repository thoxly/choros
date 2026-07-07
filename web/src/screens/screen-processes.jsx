/* ============================================================================
   CHOROS — screen-processes.jsx
   ЭКРАН: плотная таблица процессов (инстансов).
   Колонки: Процесс · Инстанс · Статус · Узел · Прогресс · Запущен · Исполнители · Действие.

   T-0374 (B17/B18): generic hardcoded «Запустить процесс» launcher removed.
   Processes start from real business entry points configured via process↔app
   bindings (trigger_type: on_create / record_action / launcher / auto). The
   runtime screen now shows an honest empty state when no instances are running,
   with a CTA to the process modeler so an admin can design new flows.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, MonoId, Mono, StatusChip, ExecGlyph, Modal, EmptyState, LoadingState, ErrorState, Field, KitIcon } from '../components/components.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import {
  validateBindingForm,
  buildBindingPayload,
  definitionSourceLabel,
  definitionStatusLabel,
  applicationOptions,
  definitionOptions,
  bindingApplicationLabel,
  bindingProcessLabel,
  triggerTypeLabel,
  mapBindingError,
  registryTargetOptions,
  findExistingBinding,
  prefillFieldsFromBinding,
  TRIGGER_TYPES,
  TRIGGER_TYPE_LABELS,
} from './process-catalog.js';

const MARKER_COLOR = {
  running: "var(--chs-color-info)", done: "var(--chs-color-success)",
  failed: "var(--chs-color-danger)", waiting: "var(--chs-color-warning)",
};

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
      borderTop: '1px solid var(--chs-color-border)',
      padding: 'var(--chs-space-4)',
    }}>
      <BindProcessModal
        open={bindOpen}
        onClose={() => setBindOpen(false)}
        onBound={handleBound}
        definitions={defs}
        applications={apps}
        existingBindings={bindings}
      />

      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 'var(--chs-space-3)',
      }}>
        <h2 style={{ margin: 0, fontSize: 'var(--chs-text-md)', fontWeight: 'var(--chs-weight-semibold)' }}>
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
        <ErrorState
          title="Не удалось загрузить каталог"
          message={error}
          onRetry={loadCatalog}
        />
      ) : catalog === null ? (
        <LoadingState label="Загрузка каталога…" />
      ) : (
        <>
          {/* REAL definitions */}
          {defs.length === 0 ? (
            <EmptyState
              title="Пока нет ни одного определения процесса"
              description="Создайте процесс в конструкторе или запустите канонический ТЭЛ — реальные определения появятся здесь."
            />
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
                    <td className="chs-r" style={{ display: 'flex', gap: 'var(--chs-space-2)', justifyContent: 'flex-end' }}>
                      {/* T-0323: open the REAL bpmn-js modeler for this definition. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/processes/${d.process_key}/edit`)}
                        title="Открыть в конструкторе"
                      >
                        В конструкторе
                      </Button>
                      {/* T-0437: open the branch-rules editor for this definition.
                          G3: only render when process_key is a non-empty string — a
                          row without a valid key has no editor to navigate to. */}
                      {d.process_key ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => navigate(`/processes/${d.process_key}/branch-rules`)}
                          title="Редактор правил ветвления"
                        >
                          Правила ветвления
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Bindings: процессы ↔ приложения */}
          <h3 style={{
            margin: 'var(--chs-space-3) 0 var(--chs-space-2) 0',
            fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)',
            color: 'var(--chs-color-text-muted)',
          }}>
            Связи процессов с приложениями
          </h3>
          {bindings.length === 0 ? (
            <EmptyState
              compact
              title="Связей пока нет"
              description="Нажмите «Настроить триггер», чтобы привязать процесс к приложению."
            />
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
                {bindings.map((b) => {
                  // T-0684 [capstone T-0647 P1]: ПРОЦЕСС column shows the human
                  // definition NAME (resolved from `defs` — the same list already
                  // loaded), with the raw slug DEMOTED to a mono secondary. Was the
                  // raw slug primary (novyy-protsess-6, …). When no name is known
                  // (engine-only key) the slug stays as the sole honest label.
                  const proc = bindingProcessLabel(b, defs);
                  return (
                  <tr key={b.id}>
                    <td>
                      {proc.hasName ? (
                        <div className="chs-task">
                          <span className="chs-task__txt">
                            <span className="chs-task__name">{proc.name}</span>
                            <span className="chs-task__step"><MonoId>{proc.key}</MonoId></span>
                          </span>
                        </div>
                      ) : (
                        <MonoId>{proc.key}</MonoId>
                      )}
                    </td>
                    <td>{bindingApplicationLabel(b)}</td>
                    <td style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
                      {triggerTypeLabel(b.trigger_type)}
                    </td>
                    <td>
                      {(b.start_form_key || b.form_key)
                        ? <Mono style={{ fontSize: 'var(--chs-text-sm)' }}>{b.start_form_key || b.form_key}</Mono>
                        : <span style={{ color: 'var(--chs-color-text-muted)' }}>—</span>}
                    </td>
                  </tr>
                  );
                })}
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
function BindProcessModal({ open, onClose, onBound, definitions, applications, existingBindings }) {
  const [processKey, setProcessKey] = useState('');
  const [applicationId, setApplicationId] = useState('');
  const [formKey, setFormKey] = useState('');
  // T-0351 E16: trigger config fields.
  const [triggerType, setTriggerType] = useState('launcher');
  const [startFormKey, setStartFormKey] = useState('');
  const [fieldMappingRaw, setFieldMappingRaw] = useState('');
  // T-0681 (migration 119): per-binding target registry override. '' = default slug.
  const [targetRegistrySlug, setTargetRegistrySlug] = useState('');
  const [registryDefs, setRegistryDefs] = useState([]); // this app's real registries
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);

  const defOpts = definitionOptions(definitions);
  const appOpts = applicationOptions(applications);
  const regOpts = registryTargetOptions(registryDefs);

  // T-0669 (NB-2 fix, T-0681 judge non-blocking finding): the (process_key,
  // application_id) pair upserts on ON CONFLICT — re-binding a pair that already
  // has a saved target_registry_slug/trigger_type/etc. while this form sits at its
  // fresh-open defaults SILENTLY CLEARS those columns back to NULL/'launcher' on
  // submit. Resolve the existing row for the currently-picked pair (if any, via the
  // pure findExistingBinding helper — unit-tested in process-catalog.test.js) so the
  // effects below can pre-fill instead of blind-reset.
  const existingBinding = findExistingBinding(existingBindings, processKey, applicationId);

  // T-0681: load the picked application's real registries so the target-registry
  // picker offers DATA (this tenant's registries), never a hardcoded slug list. Uses
  // authHeaders() (mode-aware) — a bare fetch would 401 and silently degrade.
  // T-0669: pre-fills targetRegistrySlug from an existing binding for THIS pair once
  // its registries are loaded (so the value corresponds to a real option in the
  // reloaded regOpts) — a fresh pair (no existingBinding) still resets to '' (default),
  // unchanged from before.
  useEffect(() => {
    if (!applicationId) { setRegistryDefs([]); setTargetRegistrySlug(''); return; }
    let cancelled = false;
    setTargetRegistrySlug(prefillFieldsFromBinding(existingBinding).targetRegistrySlug);
    fetch(`/api/registry-defs?application_id=${encodeURIComponent(applicationId)}`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : { registry_defs: [] }))
      .then((data) => {
        if (cancelled) return;
        setRegistryDefs(data.registry_defs || []);
        setTargetRegistrySlug(prefillFieldsFromBinding(existingBinding).targetRegistrySlug);
      })
      .catch(() => { if (!cancelled) setRegistryDefs([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationId, existingBinding?.target_registry_slug]);

  // T-0669 (NB-2 fix): pre-fill the REST of the upsert fields (trigger_type,
  // start_form_key/form_key, field_mapping) from an existing binding for the
  // currently-picked pair — same reasoning as targetRegistrySlug above: without
  // this, re-binding an already-configured pair through this form silently
  // resets trigger_type to 'launcher' and clears start_form_key/field_mapping.
  // A pair with no existing binding (existingBinding === null) is unaffected —
  // fields stay at whatever the author already typed (fresh-bind path, unchanged).
  //
  // Keyed on `existingBinding?.id` (a stable string), NOT the `existingBinding`
  // object itself: findExistingBinding() runs a fresh `.find()` every render, so
  // the object reference changes every render even when the underlying row does
  // not — depending on the object would re-run this effect (and stomp the
  // author's in-progress edits back to the binding's saved values) on every
  // keystroke in ANY of this modal's fields, not just when the picked pair
  // actually changes.
  useEffect(() => {
    if (!existingBinding) return;
    const prefill = prefillFieldsFromBinding(existingBinding);
    setFormKey(prefill.formKey);
    setTriggerType(prefill.triggerType);
    setStartFormKey(prefill.startFormKey);
    setFieldMappingRaw(prefill.fieldMappingRaw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingBinding?.id]);

  const reset = useCallback(() => {
    setProcessKey('');
    setApplicationId('');
    setFormKey('');
    setTriggerType('launcher');
    setStartFormKey('');
    setFieldMappingRaw('');
    setTargetRegistrySlug('');
    setRegistryDefs([]);
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
      target_registry_slug: targetRegistrySlug,
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
  }, [processKey, applicationId, formKey, triggerType, startFormKey, fieldMappingRaw, targetRegistrySlug, reset, onBound]);

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Настройка триггера процесса"
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={handleClose}>Отмена</Button>
          <Button variant="primary" size="sm" onClick={handleSubmit} loading={submitting} disabled={submitting}>
            Сохранить
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

        {/* T-0681: target registry picker (migration 119). Only meaningful once an
            application is picked (its registries drive the options). '' = default —
            the process's step result lands in the app's default step-result registry.
            Picking a NON-default registry is exactly what unblocks saving a form for
            that registry (server floor-gate resolves its live schema, no false 409). */}
        {applicationId && regOpts.length > 0 && (
          <div className="chs-field">
            <label className="chs-label" htmlFor="bind-target-registry">
              Реестр результата (необязательно)
            </label>
            <select
              id="bind-target-registry"
              className={`chs-input ${fieldErrors.target_registry_slug ? 'chs-input--invalid' : ''}`}
              value={targetRegistrySlug}
              onChange={(e) => setTargetRegistrySlug(e.target.value)}
              aria-invalid={fieldErrors.target_registry_slug ? true : undefined}
            >
              <option value="">— по умолчанию —</option>
              {regOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {fieldErrors.target_registry_slug ? (
              <span className="chs-hint chs-hint--invalid">{fieldErrors.target_registry_slug}</span>
            ) : (
              <span className="chs-hint" style={{ color: 'var(--chs-color-text-muted)' }}>
                Куда попадает результат шага процесса. По умолчанию — реестр приложения по умолчанию.
              </span>
            )}
          </div>
        )}

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

function ProcessesScreen() {
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

  const list = instances || [];

  return (
    <>
      <div className="chs-inbox">
        {/* T-0374 (B17): generic «Запустить процесс» hardcoded launcher removed.
            Processes start via real business entry points configured in the
            process↔app binding (on_create, record_action, launcher, auto). */}
      <div className="chs-inbox__scroll">
        {error ? (
          <ErrorState
            title="Не удалось загрузить процессы"
            message={error}
            onRetry={load}
          />
        ) : instances === null ? (
          <LoadingState label="Загрузка процессов…" />
        ) : list.length === 0 ? (
          <EmptyState
            title="Нет активных процессов"
            description="Процессы запускаются автоматически при создании объектов или по действию на карточке. Спроектируйте процесс в конструкторе и свяжите его с приложением — тогда он будет запускаться самостоятельно."
            action={
              <Button
                variant="secondary"
                size="sm"
                disabled={false}
                onClick={() => navigate('/processes/new/edit')}
              >
                Открыть конструктор
              </Button>
            }
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
                  {/* T-0456 [D8-R1]: show CONCURRENT branches of an AND-split.
                      inst.nodes carries every active step; render each on its own line
                      with a "parallel" marker when there is more than one. Falls back to
                      the single inst.node for seed fixtures without nodes. */}
                  <td>
                    {(() => {
                      const nodes = Array.isArray(inst.nodes) && inst.nodes.length > 0
                        ? inst.nodes
                        : [inst.node];
                      if (nodes.length <= 1) {
                        return <Mono style={{ fontSize: "var(--chs-text-sm)" }}>{nodes[0]}</Mono>;
                      }
                      return (
                        <div
                          data-testid="concurrent-branches"
                          style={{ display: "flex", flexDirection: "column", gap: "var(--chs-space-1)" }}
                        >
                          {nodes.map((n, i) => (
                            <div key={i} style={{ display: "flex", alignItems: "center", gap: "var(--chs-space-2)" }}>
                              <span
                                aria-hidden="true"
                                title="Параллельная ветка"
                                style={{
                                  display: "inline-block",
                                  width: 6,
                                  height: 6,
                                  borderRadius: "50%",
                                  background: "var(--chs-color-accent, var(--chs-color-text-muted))",
                                  flexShrink: 0,
                                }}
                              />
                              <Mono style={{ fontSize: "var(--chs-text-sm)" }}>{n}</Mono>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </td>
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
                    {/* T-0556: «Открыть» ведёт на detail-вью экземпляра
                        /processes/:instanceId (раньше было захардкожено на /audit). */}
                    <Button variant="ghost" size="sm" onClick={() => navigate(`/processes/${inst.id}`)}>Открыть</Button>
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
