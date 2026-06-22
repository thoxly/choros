/* ============================================================================
   CHOROS — FormBuilder.jsx  (T-0376)
   Form Builder: derive a form schema from an application's registry_def fields
   and bind it to a process step (userTask) via POST /api/forms/binding.

   PD-9 (no free invention): every field in the builder is sourced from a REAL
   registry_def.record_schema under a real application. The user picks:
     • Process key  — a process definition key (from /api/process-catalog)
     • Step key     — the BPMN userTask step identifier (free text matching
                      the task_step value in the audit log / inbox item.step)
     • Application  — which application's fields to derive the form from
     • Registry def — the specific registry_def under that app
   Then configures per-field: label, required, display order, visibility.
   Saves via POST /api/forms/binding (actor-scoped, resolves tenant).

   UX honest-gate:
   G6 no-new-hardcode: ALL fields derived from real registry_def.record_schema
       (parseRecordSchema from apps-schema.js). Zero invented fields.
   G5 jargon: plain user copy, no technical jargon in labels.
   G2 theme-pairing: only --chs-* tokens, kit <Field> / <Button> / <EmptyState>
       components. No inline styles with hardcoded color/spacing values.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, Field, EmptyState, LoadingState, ErrorState, KitIcon,
} from '../components/components.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import { parseRecordSchema, FIELD_TYPES } from '../screens/apps-schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-readable label for a field type code. */
function fieldTypeLabel(typeCode) {
  const found = FIELD_TYPES.find((t) => t.value === typeCode);
  return found ? found.label : typeCode;
}

// ---------------------------------------------------------------------------
// FieldConfigRow — one field in the builder's configurator
// ---------------------------------------------------------------------------

/**
 * One field row in the form configurator. Controls:
 *   • Include/exclude (checkbox)
 *   • Label override (text input; default = field.title || field.key)
 *   • Required toggle (checkbox)
 *   • Display order (implicit from array position — up/down arrows)
 */
function FieldConfigRow({ field, config, index, count, onChange, onMove }) {
  const included = config.included !== false;
  const label = config.label ?? (field.title || field.key);
  const required = config.required ?? field.required;

  return (
    <div
      role="group"
      aria-label={`Поле «${label}»`}
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0,1fr) minmax(0,1.4fr) auto auto',
        gap: 'var(--chs-space-4)',
        alignItems: 'center',
        padding: 'var(--chs-space-3) 0',
        borderBottom: '1px solid var(--chs-color-border)',
        opacity: included ? 1 : 0.45,
      }}
    >
      {/* Include checkbox */}
      <label style={{ display: 'inline-flex', alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={included}
          onChange={(e) => onChange({ ...config, included: e.target.checked })}
          aria-label={`Включить поле «${label}»`}
        />
      </label>

      {/* Field key + type (read-only, derived from registry) */}
      <div style={{ minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontFamily: 'var(--chs-font-mono)',
            fontSize: 'var(--chs-text-sm)',
            color: 'var(--chs-color-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {field.key}
        </span>
        <span
          style={{
            fontSize: 'var(--chs-text-xs)',
            color: 'var(--chs-color-text-muted)',
          }}
        >
          {fieldTypeLabel(field.type)}
          {field.required ? ' · обязательное' : ''}
        </span>
      </div>

      {/* Label override */}
      <input
        className="chs-input"
        type="text"
        value={label}
        onChange={(e) => onChange({ ...config, label: e.target.value })}
        placeholder={field.title || field.key}
        aria-label={`Метка поля «${label}»`}
        disabled={!included}
      />

      {/* Required toggle */}
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--chs-space-2)',
          fontSize: 'var(--chs-text-sm)',
          color: 'var(--chs-color-text-muted)',
          cursor: included ? 'pointer' : 'default',
        }}
      >
        <input
          type="checkbox"
          checked={required}
          onChange={(e) => onChange({ ...config, required: e.target.checked })}
          disabled={!included}
          aria-label={`Обязательное поле «${label}»`}
        />
        Обяз.
      </label>

      {/* Reorder arrows */}
      <div style={{ display: 'flex', gap: 'var(--chs-space-1)' }}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={index === 0}
          onClick={() => onMove(index, index - 1)}
          title="Вверх"
          aria-label="Переместить вверх"
        >
          ↑
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={index === count - 1}
          onClick={() => onMove(index, index + 1)}
          title="Вниз"
          aria-label="Переместить вниз"
        >
          ↓
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FormBuilder — main component
// ---------------------------------------------------------------------------

/**
 * FormBuilder — builds and saves a form binding for a process step.
 *
 * Props: none (self-contained; fetches its own data)
 */
function FormBuilder() {
  // Step 1: pick process + step key
  const [processKey, setProcessKey] = useState('');
  const [stepKey, setStepKey] = useState('');

  // Step 2: pick application + registry def
  const [applications, setApplications] = useState(null); // null = loading
  const [appsError, setAppsError] = useState(null); // null | string
  const [selectedAppId, setSelectedAppId] = useState('');
  const [registryDefs, setRegistryDefs] = useState(null); // null = not loaded
  const [defsError, setDefsError] = useState(null); // null | string
  const [selectedDefId, setSelectedDefId] = useState('');

  // Step 3: field configurator state
  // fields: parsed FieldDef[] from registry schema
  // configs: per-field config (included, label, required) indexed by field.key
  // configOrder: ordered array of field keys (determines display_order)
  const [fields, setFields] = useState([]); // FieldDef[] from parseRecordSchema
  const [configs, setConfigs] = useState({}); // { [fieldKey]: { included, label, required } }
  const [configOrder, setConfigOrder] = useState([]); // ordered field keys

  // Catalog of processes (for the process key picker)
  const [processCatalog, setProcessCatalog] = useState(null);

  // UI state
  const [loadingApps, setLoadingApps] = useState(false);
  const [loadingDefs, setLoadingDefs] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null); // null | { ok, message }
  const [formErrors, setFormErrors] = useState({});

  // Load process catalog on mount
  useEffect(() => {
    setLoadingCatalog(true);
    fetch('/api/process-catalog', { headers: authHeaders() })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data) => setProcessCatalog(data.definitions || []))
      .catch(() => setProcessCatalog([]))
      .finally(() => setLoadingCatalog(false));
  }, []);

  // Load applications list
  useEffect(() => {
    setLoadingApps(true);
    setApplications(null);
    setAppsError(null);
    setSelectedAppId('');
    setRegistryDefs(null);
    setSelectedDefId('');
    setFields([]);
    setConfigs({});
    setConfigOrder([]);
    fetch('/api/applications', { headers: authHeaders() })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data) => setApplications(data.applications || []))
      .catch((err) => { setAppsError(String(err?.message || err)); setApplications([]); })
      .finally(() => setLoadingApps(false));
  }, []);

  // Load registry defs when app changes
  useEffect(() => {
    if (!selectedAppId) {
      setRegistryDefs(null);
      setDefsError(null);
      setSelectedDefId('');
      setFields([]);
      setConfigs({});
      setConfigOrder([]);
      return;
    }
    setLoadingDefs(true);
    setRegistryDefs(null);
    setDefsError(null);
    setSelectedDefId('');
    setFields([]);
    setConfigs({});
    setConfigOrder([]);
    fetch(`/api/registry-defs?application_id=${encodeURIComponent(selectedAppId)}`, { headers: authHeaders() })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data) => setRegistryDefs(data.registry_defs || []))
      .catch((err) => { setDefsError(String(err?.message || err)); setRegistryDefs([]); })
      .finally(() => setLoadingDefs(false));
  }, [selectedAppId]);

  // Parse fields when registry def changes
  const handleDefChange = useCallback((defId) => {
    setSelectedDefId(defId);
    setFields([]);
    setConfigs({});
    setConfigOrder([]);
    setSaveResult(null);

    if (!defId || !registryDefs) return;
    const def = registryDefs.find((d) => d.id === defId);
    if (!def) return;

    const parsed = parseRecordSchema(def.record_schema);
    const order = parsed.map((f) => f.key);
    const initConfigs = {};
    for (const f of parsed) {
      initConfigs[f.key] = {
        included: true,
        label: f.title || f.key,
        required: f.required,
      };
    }
    setFields(parsed);
    setConfigOrder(order);
    setConfigs(initConfigs);
  }, [registryDefs]);

  // Load existing binding when processKey + stepKey are set
  useEffect(() => {
    if (!processKey || !stepKey) return;
    setLoadingExisting(true);
    setSaveResult(null);
    fetch(
      `/api/forms/binding?processKey=${encodeURIComponent(processKey)}&stepKey=${encodeURIComponent(stepKey)}`,
      { headers: authHeaders() }
    )
      .then((r) => {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!data || !Array.isArray(data.fields)) return;
        // Pre-populate configs from existing binding
        const existingFields = data.fields;
        setConfigs((prev) => {
          const next = { ...prev };
          for (const bf of existingFields) {
            if (next[bf.key]) {
              next[bf.key] = {
                ...next[bf.key],
                included: true,
                label: bf.label ?? next[bf.key].label,
                required: bf.required ?? next[bf.key].required,
              };
            }
          }
          return next;
        });
      })
      .catch(() => { /* ignore — existing binding is optional */ })
      .finally(() => setLoadingExisting(false));
  }, [processKey, stepKey]);

  // Move a field in the order array
  const moveField = useCallback((from, to) => {
    setConfigOrder((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const copy = [...prev];
      const [item] = copy.splice(from, 1);
      copy.splice(to, 0, item);
      return copy;
    });
  }, []);

  // Update one field config
  const updateConfig = useCallback((key, next) => {
    setConfigs((prev) => ({ ...prev, [key]: next }));
  }, []);

  // Save the binding
  const handleSave = useCallback(async () => {
    const errors = {};
    if (!processKey.trim()) errors.processKey = 'Укажите ключ процесса';
    if (!stepKey.trim()) errors.stepKey = 'Укажите ключ шага';
    if (fields.length === 0) errors.registry = 'Выберите набор полей';
    const includedCount = configOrder.filter((k) => configs[k]?.included !== false).length;
    if (includedCount === 0) errors.fields = 'Включите хотя бы одно поле';
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    // Build BindingField[] from included fields in order
    const bindingFields = configOrder
      .filter((k) => configs[k]?.included !== false)
      .map((k, idx) => {
        const f = fields.find((ff) => ff.key === k);
        const cfg = configs[k] || {};
        return {
          key: k,
          type: f?.type ?? 'string',
          required: cfg.required ?? f?.required ?? false,
          label: cfg.label || f?.title || k,
          display_order: idx,
        };
      });

    setSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch('/api/forms/binding', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          processKey: processKey.trim(),
          stepKey: stepKey.trim(),
          fields: bindingFields,
        }),
      });
      if (res.status === 200 || res.status === 201) {
        setSaveResult({ ok: true, message: res.status === 201 ? 'Форма создана' : 'Форма обновлена' });
      } else {
        const parsed = await res.json().catch(() => null);
        const msg = parsed?.error?.message || `HTTP ${res.status}`;
        setSaveResult({ ok: false, message: `Ошибка: ${msg}` });
      }
    } catch (err) {
      setSaveResult({ ok: false, message: String(err?.message || err) });
    } finally {
      setSaving(false);
    }
  }, [processKey, stepKey, fields, configOrder, configs]);

  // Ordered field rows (parallel arrays for render)
  const orderedFields = configOrder.map((k) => fields.find((f) => f.key === k)).filter(Boolean);

  const headerStyle = {
    fontSize: 'var(--chs-text-xs)',
    fontWeight: 'var(--chs-weight-semibold)',
    color: 'var(--chs-color-text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  };
  const sectionStyle = {
    border: '1px solid var(--chs-color-border)',
    borderRadius: 'var(--chs-radius-4)',
    padding: 'var(--chs-space-6)',
    marginBottom: 'var(--chs-space-6)',
    background: 'var(--chs-color-surface)',
  };

  return (
    <div>
      {/* Section 1: process + step */}
      <div style={sectionStyle}>
        <h3 style={{ margin: '0 0 var(--chs-space-5)', fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)', color: 'var(--chs-color-text)' }}>
          1. Процесс и шаг
        </h3>
        <div style={{ display: 'flex', gap: 'var(--chs-space-5)', flexWrap: 'wrap' }}>
          {/* Process key — picker from catalog or free text */}
          <div style={{ flex: '1 1 200px' }}>
            <Field
              label="Ключ процесса"
              mono
              value={processKey}
              onChange={(e) => { setProcessKey(e.target.value); setSaveResult(null); setFormErrors((p) => ({ ...p, processKey: undefined })); }}
              placeholder="telLinear"
              invalid={Boolean(formErrors.processKey)}
            />
            {loadingCatalog ? (
              <span style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>Загрузка процессов…</span>
            ) : processCatalog && processCatalog.length > 0 && (
              <div style={{ marginTop: 'var(--chs-space-2)' }}>
                <span style={{ display: 'block', marginBottom: 'var(--chs-space-1)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                  Быстрый выбор:
                </span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--chs-space-2)' }}>
                  {processCatalog.map((d) => (
                    <button
                      key={d.process_key}
                      type="button"
                      className="chs-tab"
                      aria-selected={processKey === d.process_key ? 'true' : undefined}
                      onClick={() => { setProcessKey(d.process_key); setSaveResult(null); setFormErrors((p) => ({ ...p, processKey: undefined })); }}
                      style={{ fontSize: 'var(--chs-text-xs)' }}
                    >
                      {d.name || d.process_key}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {formErrors.processKey && (
              <span style={{ display: 'block', marginTop: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}>
                {formErrors.processKey}
              </span>
            )}
          </div>

          {/* Step key — the BPMN userTask step identifier */}
          <div style={{ flex: '1 1 200px' }}>
            <Field
              label="Шаг процесса"
              mono
              value={stepKey}
              onChange={(e) => { setStepKey(e.target.value); setSaveResult(null); setFormErrors((p) => ({ ...p, stepKey: undefined })); }}
              placeholder="Согласование"
              invalid={Boolean(formErrors.stepKey)}
            />
            <span style={{ display: 'block', marginTop: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
              Совпадает со значением поля «Шаг» в карточке задачи инбокса
            </span>
            {formErrors.stepKey && (
              <span style={{ display: 'block', marginTop: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}>
                {formErrors.stepKey}
              </span>
            )}
            {loadingExisting && (
              <span style={{ display: 'block', marginTop: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                Проверка существующей формы…
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Section 2: source of truth — pick application + registry def */}
      <div style={sectionStyle}>
        <h3 style={{ margin: '0 0 var(--chs-space-5)', fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)', color: 'var(--chs-color-text)' }}>
          2. Источник полей (приложение и набор полей)
        </h3>
        <div style={{ display: 'flex', gap: 'var(--chs-space-5)', flexWrap: 'wrap' }}>
          {/* Application picker */}
          <div className="chs-field" style={{ flex: '1 1 200px' }}>
            <label className="chs-label" htmlFor="fb-app-select">Приложение</label>
            {loadingApps ? (
              <LoadingState label="Загрузка приложений…" />
            ) : appsError ? (
              <ErrorState
                message={`Не удалось загрузить приложения: ${appsError}`}
                onRetry={() => {
                  setAppsError(null);
                  setApplications(null);
                  setLoadingApps(true);
                  fetch('/api/applications', { headers: authHeaders() })
                    .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
                    .then((data) => setApplications(data.applications || []))
                    .catch((err) => { setAppsError(String(err?.message || err)); setApplications([]); })
                    .finally(() => setLoadingApps(false));
                }}
              />
            ) : (
              <select
                id="fb-app-select"
                className="chs-input"
                value={selectedAppId}
                onChange={(e) => { setSelectedAppId(e.target.value); setFormErrors((p) => ({ ...p, registry: undefined })); }}
                aria-label="Выберите приложение"
              >
                <option value="">— выберите приложение —</option>
                {(applications || []).map((a) => (
                  <option key={a.id} value={a.id}>{a.display_name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Registry def picker */}
          {selectedAppId && (
            <div className="chs-field" style={{ flex: '1 1 200px' }}>
              <label className="chs-label" htmlFor="fb-def-select">Набор полей</label>
              {loadingDefs ? (
                <LoadingState label="Загрузка наборов полей…" />
              ) : defsError ? (
                <ErrorState
                  message={`Не удалось загрузить наборы полей: ${defsError}`}
                  onRetry={() => {
                    setDefsError(null);
                    setRegistryDefs(null);
                    setLoadingDefs(true);
                    fetch(`/api/registry-defs?application_id=${encodeURIComponent(selectedAppId)}`, { headers: authHeaders() })
                      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
                      .then((data) => setRegistryDefs(data.registry_defs || []))
                      .catch((err) => { setDefsError(String(err?.message || err)); setRegistryDefs([]); })
                      .finally(() => setLoadingDefs(false));
                  }}
                />
              ) : registryDefs && registryDefs.length === 0 ? (
                <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
                  Нет наборов полей — сначала создайте их в конструкторе приложения
                </span>
              ) : (
                <select
                  id="fb-def-select"
                  className="chs-input"
                  value={selectedDefId}
                  onChange={(e) => { handleDefChange(e.target.value); setFormErrors((p) => ({ ...p, registry: undefined })); }}
                  aria-label="Выберите набор полей"
                >
                  <option value="">— выберите набор полей —</option>
                  {(registryDefs || []).map((d) => (
                    <option key={d.id} value={d.id}>{d.display_name}</option>
                  ))}
                </select>
              )}
              {formErrors.registry && (
                <span style={{ display: 'block', marginTop: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}>
                  {formErrors.registry}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Section 3: field configurator */}
      {fields.length > 0 && (
        <div style={sectionStyle}>
          <h3 style={{ margin: '0 0 var(--chs-space-5)', fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)', color: 'var(--chs-color-text)' }}>
            3. Настройка полей формы
          </h3>
          <p style={{ margin: '0 0 var(--chs-space-5)', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
            Все поля получены из набора полей «{(registryDefs || []).find((d) => d.id === selectedDefId)?.display_name}».
            Отключите поля, которые не нужны на этом шаге, или измените их метки.
          </p>

          {/* Column headers */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'auto minmax(0,1fr) minmax(0,1.4fr) auto auto',
            gap: 'var(--chs-space-4)',
            padding: '0 0 var(--chs-space-3)',
            borderBottom: '1px solid var(--chs-color-border)',
          }}>
            <span style={headerStyle}>Вкл.</span>
            <span style={headerStyle}>Поле (ключ / тип)</span>
            <span style={headerStyle}>Метка в форме</span>
            <span style={headerStyle}>Обяз.</span>
            <span style={{ ...headerStyle, textAlign: 'right' }}>Порядок</span>
          </div>

          {orderedFields.map((f, i) => (
            <FieldConfigRow
              key={f.key}
              field={f}
              config={configs[f.key] || {}}
              index={i}
              count={orderedFields.length}
              onChange={(next) => updateConfig(f.key, next)}
              onMove={moveField}
            />
          ))}

          {formErrors.fields && (
            <div style={{ marginTop: 'var(--chs-space-4)', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-danger)' }}>
              {formErrors.fields}
            </div>
          )}
        </div>
      )}

      {/* Empty state when no registry selected yet */}
      {selectedDefId === '' && selectedAppId && !loadingDefs && registryDefs && registryDefs.length > 0 && (
        <div style={{ ...sectionStyle, textAlign: 'center' }}>
          <EmptyState
            icon={<KitIcon name="inbox" size={24} />}
            title="Выберите набор полей"
            description="Поля для настройки формы загрузятся после выбора набора."
          />
        </div>
      )}

      {/* Save button + result */}
      {fields.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-5)', marginTop: 'var(--chs-space-2)' }}>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Сохранение…' : 'Сохранить форму для шага'}
          </Button>
          {saveResult && (
            <span
              role="status"
              aria-live="polite"
              style={{
                fontSize: 'var(--chs-text-sm)',
                color: saveResult.ok ? 'var(--chs-color-success)' : 'var(--chs-color-danger)',
                fontWeight: 'var(--chs-weight-medium)',
              }}
            >
              {saveResult.message}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default FormBuilder;
