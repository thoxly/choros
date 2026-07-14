/* ============================================================================
   CHOROS — screen-process-catalog.jsx
   ЭКРАН (зона «Конструктор», маршрут /process-catalog) — T-0742 (T-0654-c).

   «Каталог процессов» = определения процессов КАРТОЧКАМИ. Строит дом для функций,
   которые T-0735 (AC-B6) сознательно ОСТАВИЛ на /processes до постройки нового
   экрана: список определений, счётчик инстансов (deep-link в грид «Процессы»),
   триггеры-связи (свёрнуты В карточку — отдельной таблицы «Связи» больше нет),
   вход в модельер и в редактор правил ветвления (DMN), и настройку триггера
   (BindProcessModal — перенесена сюда из screen-processes.jsx без изменения логики).

   Потребляет ТОТ ЖЕ контракт, что и снятая секция:
     GET /api/process-catalog  → { definitions, instances, bindings }
     GET /api/applications      → { applications }   (для модалки триггера)
     POST /api/process-app-bindings (upsert через BindProcessModal)
   Все вызовы — authHeaders() (mode-aware). Анти-UUID: имя определения — контент,
   ключ — вторичная mono-подпись. Анти-кейс: ни одной кейс-константы.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, MonoId, Mono, Modal, EmptyState, LoadingState, ErrorState, Field, KitIcon, Card, Badge,
} from '../components/components.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import {
  validateBindingForm,
  buildBindingPayload,
  definitionSourceLabel,
  definitionStatusLabel,
  definitionVersionLabel,
  instanceCountLabel,
  bindingsForDefinition,
  processGridDeepLink,
  applicationOptions,
  definitionOptions,
  bindingApplicationLabel,
  triggerTypeLabel,
  mapBindingError,
  registryTargetOptions,
  findExistingBinding,
  prefillFieldsFromBinding,
  TRIGGER_TYPES,
  TRIGGER_TYPE_LABELS,
} from './process-catalog.js';

// Lifecycle status → Badge tone. Platform enum values (see definitionStatusLabel),
// NOT case/domain constants. Unknown status falls back to neutral.
const STATUS_TONE = { draft: 'neutral', published: 'info', deployed: 'success' };

/**
 * DefinitionCard — one authoring card per REAL process definition. Folds INTO
 * itself everything the former ProcessCatalogSection scattered across a table +
 * a separate «Связи» table: human name (key demoted to a mono subtitle), status,
 * version, live-instance count (deep-link into the operator grid when >0), the
 * process↔application trigger bindings for THIS definition, and the entry points
 * to the modeler / branch-rules (DMN) / trigger config.
 */
function DefinitionCard({ def, bindings, onConfigureTrigger }) {
  const navigate = useNavigate();
  const procKey = def.process_key;
  // Anti-uuid: the human name is the content; show the raw key as a demoted mono
  // subtitle ONLY when a real name differs from it (server falls the name back to
  // the key for engine-only defs — then the title already IS the key, no repeat).
  const demotedKey = def.name && def.name !== procKey ? procKey : null;
  const versionLabel = definitionVersionLabel(def);
  const defBindings = bindingsForDefinition(bindings, procKey);
  const count = def.instance_count || 0;

  return (
    <Card
      title={def.name || procKey}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-3)' }}>
          {versionLabel && <Badge tone="neutral">{versionLabel}</Badge>}
          <Badge tone={STATUS_TONE[def.status] || 'neutral'}>{definitionStatusLabel(def.status)}</Badge>
        </div>
      }
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/processes/${procKey}/edit`)}
            title="Открыть определение в модельере"
          >
            В модельер
          </Button>
          {procKey ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate(`/processes/${procKey}/branch-rules`)}
              title="Редактор правил ветвления (DMN)"
            >
              Правила ветвления
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            glyph={<KitIcon name="plus" className="chs-btn__glyph" />}
            onClick={() => onConfigureTrigger(procKey)}
            title="Связать определение с приложением и настроить триггер запуска"
          >
            Настроить триггер
          </Button>
        </>
      }
    >
      {/* Meta row: machine key (demoted) + source. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--chs-space-4)', marginBottom: 'var(--chs-space-5)' }}>
        {demotedKey && <MonoId>{demotedKey}</MonoId>}
        <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
          Источник: {definitionSourceLabel(def.source)}
        </span>
      </div>

      {/* Live-instance count — a deep-link into the operator grid (pre-filtered by
          this definition) ONLY when there are instances to show; otherwise honest
          static text (never a dead affordance — G7). */}
      <div style={{ marginBottom: 'var(--chs-space-5)' }}>
        {count > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(processGridDeepLink(procKey))}
            title="Показать живые процессы этого определения на экране «Процессы»"
          >
            {instanceCountLabel(count)}
          </Button>
        ) : (
          <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
            {instanceCountLabel(0)}
          </span>
        )}
      </div>

      {/* Triggers — the former standalone «Связи» table, folded INTO the card. */}
      <div>
        <h3 style={{
          margin: '0 0 var(--chs-space-2) 0',
          fontSize: 'var(--chs-text-xs)', fontWeight: 'var(--chs-weight-semibold)',
          textTransform: 'uppercase', letterSpacing: '0.04em',
          color: 'var(--chs-color-text-muted)',
        }}>
          Связи с приложениями
        </h3>
        {defBindings.length === 0 ? (
          <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
            Нет связей. Нажмите «Настроить триггер», чтобы запускать это определение из приложения.
          </span>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-2)' }}>
            {defBindings.map((b) => (
              <li key={b.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--chs-space-3)' }}>
                <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text)' }}>
                  {bindingApplicationLabel(b)}
                </span>
                <span aria-hidden="true" style={{ color: 'var(--chs-color-text-muted)' }}>·</span>
                <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
                  {triggerTypeLabel(b.trigger_type)}
                </span>
                {(b.start_form_key || b.form_key) && (
                  <Mono style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                    {b.start_form_key || b.form_key}
                  </Mono>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/**
 * ProcessCatalogScreen — the «Конструктор»-zone home for process definitions.
 * One creation point («Новый процесс» in the header — the duplicate the old screen
 * carried is gone, AC-C6); one card per real definition.
 */
function ProcessCatalogScreen() {
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState(null); // null | { definitions, instances, bindings }
  const [apps, setApps] = useState([]);
  const [error, setError] = useState(null);
  // bindFor: null = closed; string = the definition's process_key the trigger modal opens for.
  const [bindFor, setBindFor] = useState(null);

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
    setBindFor(null);
    loadCatalog();
  }, [loadCatalog]);

  const defs = catalog?.definitions || [];
  const bindings = catalog?.bindings || [];

  return (
    <div className="chs-inbox">
      <BindProcessModal
        open={bindFor !== null}
        initialProcessKey={bindFor || ''}
        onClose={() => setBindFor(null)}
        onBound={handleBound}
        definitions={defs}
        applications={apps}
        existingBindings={bindings}
      />

      {/* Header: one creation point (AC-C6) — no duplicate «Новый процесс». */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: 'var(--chs-space-5) var(--chs-space-6)',
        borderBottom: '1px solid var(--chs-color-border)',
      }}>
        <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
          Каталог процессов{catalog !== null ? ` · ${defs.length}` : ''}
        </span>
        <Button
          variant="primary"
          size="sm"
          glyph={<KitIcon name="plus" className="chs-btn__glyph" />}
          onClick={() => navigate('/processes/new/edit')}
          title="Открыть модельер для нового процесса"
        >
          Новый процесс
        </Button>
      </div>

      <div className="chs-inbox__scroll">
        {error ? (
          <ErrorState
            title="Не удалось загрузить каталог"
            message={error}
            onRetry={loadCatalog}
          />
        ) : catalog === null ? (
          <LoadingState label="Загрузка каталога…" />
        ) : defs.length === 0 ? (
          // AC-C6: no empty-state «Новый процесс» button — that would duplicate the
          // header creation point. The single «Новый процесс» button above is the one
          // creation entry; the copy points there.
          <EmptyState
            icon={<KitIcon name="inbox" size={28} />}
            title="Пока нет ни одного определения процесса"
            description="Нажмите «Новый процесс» вверху и спроектируйте процесс в модельере — определения появятся здесь карточками, и вы свяжете их с приложениями."
          />
        ) : (
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-5)',
            padding: 'var(--chs-space-6)', maxWidth: '880px',
          }}>
            {defs.map((d) => (
              <DefinitionCard
                key={d.process_key}
                def={d}
                bindings={bindings}
                onConfigureTrigger={setBindFor}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * BindProcessModal — trigger editor. MOVED verbatim from screen-processes.jsx
 * (T-0270 / T-0351 E16 / T-0669 / T-0681) as part of T-0742's «catalog gets a
 * dedicated home» split: the ONLY entry into process↔application trigger config.
 * Logic unchanged (same process-catalog.js helpers, same POST upsert contract);
 * the sole addition is `initialProcessKey` — when the modal opens from a specific
 * definition's card, its process is pre-selected (the picker still lets the author
 * change it). Fields:
 *   - trigger_type select (on_create / record_action / launcher / auto)
 *   - start_form_key / form_key (optional entry-point form)
 *   - target_registry_slug (T-0681, migration 119 — this app's registries)
 *   - field_mapping textarea (one "varName=fieldPath" per line; scalar only)
 */
function BindProcessModal({ open, initialProcessKey = '', onClose, onBound, definitions, applications, existingBindings }) {
  const [processKey, setProcessKey] = useState('');
  const [applicationId, setApplicationId] = useState('');
  const [formKey, setFormKey] = useState('');
  const [triggerType, setTriggerType] = useState('launcher');
  const [startFormKey, setStartFormKey] = useState('');
  const [fieldMappingRaw, setFieldMappingRaw] = useState('');
  const [targetRegistrySlug, setTargetRegistrySlug] = useState('');
  const [registryDefs, setRegistryDefs] = useState([]); // this app's real registries
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);

  const defOpts = definitionOptions(definitions);
  const appOpts = applicationOptions(applications);
  const regOpts = registryTargetOptions(registryDefs);

  // T-0742: when the modal opens from a definition card, seed the process picker to
  // that definition (the author can still change it). Keyed on open+initialProcessKey
  // so re-opening for a different card re-seeds; a manual change during the session is
  // preserved (effect only fires on open transition / initial key change).
  useEffect(() => {
    if (open && initialProcessKey) setProcessKey(initialProcessKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialProcessKey]);

  // T-0669: resolve the existing row for the currently-picked pair so re-binding an
  // already-configured pair pre-fills instead of blind-resetting its columns to NULL.
  const existingBinding = findExistingBinding(existingBindings, processKey, applicationId);

  // T-0681: load the picked application's real registries so the target-registry
  // picker offers DATA (this tenant's registries), never a hardcoded slug list.
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

  // T-0669: pre-fill the rest of the upsert fields from an existing binding for the
  // currently-picked pair (keyed on the stable id, NOT the object — see original note).
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

        {/* T-0681: target registry picker (migration 119). */}
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

        {/* Trigger type selector */}
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

        {/* Start form key (on_create) */}
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

        {/* Field mapping (scalar projection only — RECORD_IN_PAYLOAD doctrine) */}
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

export default ProcessCatalogScreen;
