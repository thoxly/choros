/* ============================================================================
   CHOROS — screen-app-records.jsx
   ЭКРАН: КОНСТРУКТОР · Записи приложения (E13, T-0267).

   ТО, РАДИ ЧЕГО СТРОИЛСЯ ВЕСЬ КОНСТРУКТОР: момент, когда приложение начинает
   ХРАНИТЬ РЕАЛЬНЫЕ ДАННЫЕ из UI. Замыкает вертикаль:
     создать приложение (T-0265) → определить поля (T-0266) → ВНЕСТИ ЗАПИСИ (здесь).

   Поток:
     • грузим реестры приложения — GET /api/registry-defs?application_id= (T-0263);
         0 реестров → пустое состояние «сначала определите поля» (ссылка в
           конструктор полей /app-schema/:appId);
         1 реестр   → он и есть governing;
         >1 реестров → даём выбрать, и ПЕРЕДАЁМ registry_def_id в POST (иначе 409);
     • грузим записи — GET /api/records?application_id=&registry_def_id= (T-0264),
         таблица: колонки из record_schema (key/title) + «Создано»;
     • «Создать запись» → ДИНАМИЧЕСКАЯ форма, СГЕНЕРИРОВАННАЯ из record_schema
         выбранного реестра: по одному полю на properties, тип ввода по типу поля
         (text/number/checkbox), маркер «обяз.» из required[];
     • submit → POST /api/records { application_id, registry_def_id, data } с ПРАВИЛЬНО
         типизированными значениями (числа — числами, булевы — булевыми: сервер
         валидирует AJV). 201 → обновляем список + подсвечиваем новую строку.
       Ошибки честно: 400 → деталь валидации (по возможности inline под полем),
         409 → «выберите реестр полей», 404/401 → честные сообщения.

   Fetch-контракт (FROZEN):
     GET  /api/registry-defs?application_id=  → { registry_defs: [...] }       (T-0263)
     GET  /api/records?application_id=&registry_def_id=  → { records: [...] }  (T-0264)
     POST /api/records  body { application_id, registry_def_id?, data }
            → 201 { id, application_id, registry_def_id, record_schema_version, data, created_at, updated_at }
            → 400 VALIDATION · 401 · 404 · 409 CONFLICT (>1 реестр) · 403 FIELD_WRITE_FORBIDDEN

   Вся нетривиальная логика (схема→поля формы, типизация/сериализация значений,
   маппинг ошибок) вынесена в чистый модуль records-form.js и покрыта unit-тестами.
   Авторизация — devHeaders() (X-Dev-User), как у остальных экранов.

   OBLIK (T-0302): «Создать запись» — через kit <Modal>; динамические поля через
   .chs-input (видимый ввод в ОБЕИХ темах через реальные --chs-color-* токены, без
   несуществующих --chs-bg-primary/--chs-border). Ноль хардкода цвета (G6).
   ============================================================================ */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Button, Mono, Modal, EmptyState, ErrorState, LoadingState, KitIcon,
} from '../components/components.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';
import {
  schemaToFormFields,
  schemaToColumns,
  blankRecordValues,
  validateRecordValues,
  serializeRecordData,
  formatCellValue,
  mapRecordError,
  extractFieldErrors,
} from './records-form.js';

// Anything at/below this is a seed/unset created_at, not a real date — render a
// dash instead of fabricating "1970-01-01" (principles.md §3, audit #7).
const EPOCH_FLOOR_MS = 24 * 60 * 60 * 1000; // ~1970-01-02

function fmtTs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < EPOCH_FLOOR_MS) return '—';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const errStyle = {
  display: 'block', marginTop: 'var(--chs-space-2)',
  fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)',
};
const labelTxt = { fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-medium)', color: 'var(--chs-color-text)' };

/**
 * CreateRecordModal — dynamic form generated from the chosen registry_def's
 * record_schema. One control per `properties` field; input type by field type
 * (text/number/checkbox); required markers from required[]. Values are typed +
 * serialized by records-form.js so the server's AJV validation passes.
 */
function CreateRecordModal({ open, onClose, onCreated, applicationId, registryDef }) {
  const formFields = useMemo(
    () => (registryDef ? schemaToFormFields(registryDef.record_schema) : []),
    [registryDef],
  );
  const [values, setValues] = useState(() => blankRecordValues(formFields));
  const [fieldErrors, setFieldErrors] = useState({}); // key → message
  const [submitErr, setSubmitErr] = useState(null);    // form-level message
  const [submitting, setSubmitting] = useState(false);

  // Reset the value state whenever the modal (re)opens or the schema changes.
  useEffect(() => {
    if (open) {
      setValues(blankRecordValues(formFields));
      setFieldErrors({});
      setSubmitErr(null);
      setSubmitting(false);
    }
  }, [open, formFields]);

  const setVal = useCallback((key, v) => {
    setValues((prev) => ({ ...prev, [key]: v }));
  }, []);

  const handleSubmit = useCallback(async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setSubmitErr(null);

    const { valid, errors } = validateRecordValues(formFields, values);
    setFieldErrors(errors);
    if (!valid) return;

    const data = serializeRecordData(formFields, values);
    setSubmitting(true);
    try {
      const body = {
        application_id: applicationId,
        registry_def_id: registryDef.id,
        data,
      };
      const res = await fetch('/api/records', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...devHeaders() },
        body: JSON.stringify(body),
      });
      if (res.status === 201) {
        const created = await res.json();
        onCreated(created);
        return;
      }
      let parsed = null;
      try { parsed = await res.json(); } catch { /* ignore parse error */ }
      const mapped = mapRecordError(res.status, parsed);
      // Best-effort: attribute AJV detail to specific fields inline.
      if (res.status === 400) {
        const known = new Set(formFields.map((f) => f.key));
        const perField = extractFieldErrors(mapped.message, known);
        if (Object.keys(perField).length > 0) setFieldErrors((prev) => ({ ...prev, ...perField }));
      }
      setSubmitErr(mapped.message);
    } catch (err) {
      setSubmitErr(String(err?.message || err));
    } finally {
      setSubmitting(false);
    }
  }, [formFields, values, applicationId, registryDef, onCreated]);

  const canSubmit = open && registryDef && formFields.length > 0;

  return (
    <Modal
      open={Boolean(open && registryDef)}
      onClose={onClose}
      title="Новая запись"
      footer={
        <>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Отмена</Button>
          <Button type="submit" form="create-record-form" variant="primary" size="sm" loading={submitting} disabled={!canSubmit}>
            {submitting ? 'Сохранение…' : 'Создать запись'}
          </Button>
        </>
      }
    >
      <form id="create-record-form" onSubmit={handleSubmit}>
        <p style={{ margin: '0 0 var(--chs-space-6) 0', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
          Реестр «{registryDef ? registryDef.display_name : ''}». Поля сгенерированы из его схемы.
        </p>

        {formFields.length === 0 && (
          <p style={{ marginBottom: 'var(--chs-space-6)', color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
            У реестра нет полей. Определите их в конструкторе полей, затем добавляйте записи.
          </p>
        )}

        {formFields.map((f) => {
          const invalid = Boolean(fieldErrors[f.key]);
          if (f.inputKind === 'checkbox') {
            return (
              <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-4)', marginBottom: 'var(--chs-space-5)' }}>
                <input
                  type="checkbox"
                  checked={Boolean(values[f.key])}
                  onChange={(e) => setVal(f.key, e.target.checked)}
                  aria-label={f.label}
                />
                <span style={labelTxt}>
                  {f.label}{f.required && <span style={{ color: 'var(--chs-color-danger)' }}> *</span>}
                </span>
                {invalid && <span style={errStyle}>{fieldErrors[f.key]}</span>}
              </label>
            );
          }
          return (
            <div key={f.key} className="chs-field" style={{ marginBottom: 'var(--chs-space-5)' }}>
              <span style={labelTxt}>
                {f.label}{f.required && <span style={{ color: 'var(--chs-color-danger)' }}> *</span>}
              </span>
              <input
                className={`chs-input ${invalid ? 'chs-input--invalid' : ''}`}
                type={f.inputKind === 'number' ? 'number' : 'text'}
                step={f.type === 'integer' ? '1' : 'any'}
                value={values[f.key] ?? ''}
                onChange={(e) => setVal(f.key, e.target.value)}
                aria-label={f.label}
                aria-invalid={invalid || undefined}
              />
              {invalid && <span style={errStyle}>{fieldErrors[f.key]}</span>}
            </div>
          );
        })}

        {submitErr && (
          <div role="alert" style={{
            marginTop: 'var(--chs-space-5)', padding: 'var(--chs-space-4) var(--chs-space-5)',
            background: 'var(--chs-color-danger-soft)',
            border: '1px solid var(--chs-color-danger)',
            borderRadius: 'var(--chs-radius-3)', fontSize: 'var(--chs-text-sm)',
            color: 'var(--chs-color-text)',
          }}>
            {submitErr}
          </div>
        )}
      </form>
    </Modal>
  );
}

function AppRecordsScreen() {
  const { appId } = useParams();
  const navigate = useNavigate();

  const [defs, setDefs] = useState(null);      // null = loading, [] = none, [...] = list
  const [defsError, setDefsError] = useState(null);
  const [app, setApp] = useState(null);        // resolved application meta (cosmetic header)
  const [selectedDefId, setSelectedDefId] = useState(null); // chosen registry_def id

  const [records, setRecords] = useState(null); // null = loading, [] = empty, [...] = list
  const [recordsError, setRecordsError] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [highlightId, setHighlightId] = useState(null);

  // ---- load registry_defs for the application -----------------------------
  const loadDefs = useCallback(async () => {
    if (!appId) { setDefsError('Не указано приложение'); return; }
    setDefsError(null);
    try {
      const res = await fetch(
        `/api/registry-defs?application_id=${encodeURIComponent(appId)}`,
        { headers: devHeaders() },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data.registry_defs) ? data.registry_defs : [];
      setDefs(list);
      // Auto-select when exactly one; otherwise leave the picker to the user.
      setSelectedDefId((prev) => {
        if (list.length === 1) return list[0].id;
        if (prev && list.some((d) => d.id === prev)) return prev;
        return null;
      });
    } catch (e) {
      setDefsError(e.message);
    }
  }, [appId]);

  // Best-effort: resolve the application's display_name for the header.
  const loadApp = useCallback(async () => {
    if (!appId) return;
    try {
      const res = await fetch('/api/applications', { headers: devHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      const found = (data.applications || []).find((a) => a.id === appId);
      if (found) setApp(found);
    } catch { /* header is cosmetic — ignore */ }
  }, [appId]);

  useEffect(() => { loadDefs(); loadApp(); }, [loadDefs, loadApp]);

  const selectedDef = useMemo(
    () => (defs || []).find((d) => d.id === selectedDefId) || null,
    [defs, selectedDefId],
  );

  // ---- load records for the chosen registry_def ---------------------------
  const loadRecords = useCallback(async () => {
    if (!appId || !selectedDefId) { setRecords(null); return; }
    setRecordsError(null);
    setRecords(null);
    try {
      const res = await fetch(
        `/api/records?application_id=${encodeURIComponent(appId)}&registry_def_id=${encodeURIComponent(selectedDefId)}`,
        { headers: devHeaders() },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRecords(Array.isArray(data.records) ? data.records : []);
    } catch (e) {
      setRecordsError(e.message);
    }
  }, [appId, selectedDefId]);

  useEffect(() => { loadRecords(); }, [loadRecords]);

  const handleCreated = useCallback((created) => {
    setCreateOpen(false);
    if (created && created.id) setHighlightId(created.id);
    loadRecords();
  }, [loadRecords]);

  const columns = useMemo(
    () => (selectedDef ? schemaToColumns(selectedDef.record_schema) : []),
    [selectedDef],
  );
  const recordList = records || [];

  // ---- header --------------------------------------------------------------
  const defList = defs || [];

  return (
    <>
      <CreateRecordModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
        applicationId={appId}
        registryDef={selectedDef}
      />
      <div className="chs-inbox">
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--chs-space-5)',
          padding: 'var(--chs-space-5) var(--chs-space-6)',
          borderBottom: '1px solid var(--chs-color-border)',
        }}>
          <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
            Записи приложения {app ? `«${app.display_name}»` : ''}
            {records !== null ? ` · ${recordList.length}` : ''}
          </span>
          <div style={{ display: 'flex', gap: 'var(--chs-space-5)', alignItems: 'center' }}>
            {/* >1 registry_def → user MUST pick which one (POST 409s otherwise). */}
            {defList.length > 1 && (
              <select
                className="chs-input"
                style={{ width: 'auto' }}
                value={selectedDefId || ''}
                onChange={(e) => setSelectedDefId(e.target.value || null)}
                aria-label="Реестр полей"
              >
                <option value="">— выберите реестр —</option>
                {defList.map((d) => (
                  <option key={d.id} value={d.id}>{d.display_name}</option>
                ))}
              </select>
            )}
            <Button
              variant="primary"
              size="sm"
              glyph={<KitIcon name="plus" />}
              disabled={!selectedDef}
              onClick={() => setCreateOpen(true)}
              title={selectedDef ? 'Создать запись' : 'Сначала выберите реестр полей'}
            >
              Создать запись
            </Button>
          </div>
        </div>

        <div className="chs-inbox__scroll">
          {/* registry_def load states first — records depend on a chosen def. */}
          {defsError ? (
            <ErrorState message={`Не удалось загрузить реестры: ${defsError}`} onRetry={loadDefs} />
          ) : defs === null ? (
            <LoadingState label="Загрузка реестров…" />
          ) : defList.length === 0 ? (
            <EmptyState
              icon={<KitIcon name="inbox" size={28} />}
              title="У приложения пока нет полей"
              description="Сначала определите поля — потом сюда можно вносить записи."
              action={
                <Button variant="primary" onClick={() => navigate(`/app-schema/${appId}`)}>
                  Настроить поля
                </Button>
              }
            />
          ) : !selectedDef ? (
            <EmptyState
              title="Выберите реестр полей"
              description="У приложения несколько реестров полей. Выберите реестр выше, чтобы увидеть и создавать его записи."
            />
          ) : recordsError ? (
            <ErrorState message={`Не удалось загрузить записи: ${recordsError}`} onRetry={loadRecords} />
          ) : records === null ? (
            <LoadingState label="Загрузка записей…" />
          ) : recordList.length === 0 ? (
            <EmptyState
              icon={<KitIcon name="inbox" size={28} />}
              title={`В реестре «${selectedDef.display_name}» пока нет записей`}
              description="Создайте первую."
              action={
                <Button variant="primary" glyph={<KitIcon name="plus" />} onClick={() => setCreateOpen(true)}>Создать запись</Button>
              }
            />
          ) : (
            <table className="chs-itable">
              <thead>
                <tr>
                  {columns.map((c) => <th key={c.key}>{c.label}</th>)}
                  <th>Создано</th>
                  {/* T-0295: detail view link column */}
                  <th style={{ width: '64px' }} />
                </tr>
              </thead>
              <tbody>
                {recordList.map((rec) => {
                  const data = rec.data && typeof rec.data === 'object' ? rec.data : {};
                  return (
                    <tr
                      key={rec.id}
                      style={rec.id === highlightId ? { background: 'var(--chs-color-success-soft)' } : undefined}
                    >
                      {columns.map((c) => (
                        <td key={c.key}>{formatCellValue(data[c.key], c.type)}</td>
                      ))}
                      <td>
                        <Mono style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                          {fmtTs(rec.created_at)}
                        </Mono>
                      </td>
                      {/* T-0295: open detail view for this record */}
                      <td style={{ textAlign: 'right' }}>
                        <Link
                          to={`/apps/${appId}/records/${rec.id}`}
                          style={{
                            fontSize: 'var(--chs-text-xs)',
                            color: 'var(--chs-color-accent)',
                            textDecoration: 'none',
                          }}
                          title="Открыть запись"
                        >
                          Открыть
                        </Link>
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

export default AppRecordsScreen;
