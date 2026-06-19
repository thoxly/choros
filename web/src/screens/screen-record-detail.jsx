/* ============================================================================
   CHOROS — screen-record-detail.jsx
   ЭКРАН: КОНСТРУКТОР · Детали записи (T-0295, read-only).

   Открывается по маршруту /apps/:appId/records/:id.
   Загружает одну запись через GET /api/records/:id (enriched — T-0295):
     { id, application_id, registry_def_id, record_schema_version,
       record_schema, data, created_at, updated_at, created_by }
   Рендерит все поля записи по их меткам из record_schema (schemaToFormFields)
   как читаемый список «метка → значение». Обрабатывает 404 честно.

   READ-ONLY: форма редактирования и любые мутации НЕ входят в этот экран.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Mono, LoadingState, ErrorState, EmptyState, KitIcon } from '../components/components.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';
import { schemaToFormFields, formatCellValue } from './records-form.js';

function fmtTs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fieldRowStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--chs-space-2)',
  padding: 'var(--chs-space-5) 0',
  borderBottom: '1px solid var(--chs-color-border)',
};

const labelStyle = {
  fontSize: 'var(--chs-text-xs)',
  color: 'var(--chs-color-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const valueStyle = {
  fontSize: 'var(--chs-text-sm)',
  color: 'var(--chs-color-text)',
  wordBreak: 'break-word',
};

function RecordDetailScreen() {
  const { appId, id } = useParams();
  const navigate = useNavigate();

  const [record, setRecord] = useState(null); // null = loading
  const [error, setError] = useState(null);   // string | { notFound: true }

  const loadRecord = useCallback(async () => {
    if (!id) { setError('Не указан идентификатор записи'); return; }
    setError(null);
    setRecord(null);
    try {
      const res = await fetch(`/api/records/${encodeURIComponent(id)}`, {
        headers: devHeaders(),
      });
      if (res.status === 404) {
        setError({ notFound: true });
        return;
      }
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); detail = j?.message || detail; } catch { /* ignore */ }
        setError(detail);
        return;
      }
      const data = await res.json();
      setRecord(data);
    } catch (e) {
      setError(String(e?.message || e));
    }
  }, [id]);

  useEffect(() => { loadRecord(); }, [loadRecord]);

  // Derive an ordered list of display fields from record_schema (may be null/missing)
  const formFields = record ? schemaToFormFields(record.record_schema) : [];
  const data = record?.data && typeof record.data === 'object' ? record.data : {};

  const backPath = appId ? `/app-records/${appId}` : '/apps';

  return (
    <div className="chs-inbox">
      {/* Header bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--chs-space-5)',
        padding: 'var(--chs-space-3) var(--chs-space-4)',
        borderBottom: '1px solid var(--chs-color-border)',
      }}>
        <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
          Детали записи
        </span>
        <Button variant="ghost" size="sm" onClick={() => navigate(backPath)}>
          ← Назад к списку
        </Button>
      </div>

      <div className="chs-inbox__scroll" style={{ padding: 'var(--chs-space-4, 16px) var(--chs-space-5, 20px)' }}>
        {/* Loading */}
        {!error && record === null && (
          <LoadingState label="Загрузка записи…" />
        )}

        {/* Not found */}
        {error && typeof error === 'object' && error.notFound && (
          <EmptyState
            icon={<KitIcon name="inbox" size={28} />}
            title="Запись не найдена"
            description="Запись не найдена или у вас нет к ней доступа."
            action={
              <Button variant="primary" onClick={() => navigate(backPath)}>
                Вернуться к списку
              </Button>
            }
          />
        )}

        {/* Generic error */}
        {error && typeof error === 'string' && (
          <ErrorState
            message={`Не удалось загрузить запись: ${error}`}
            onRetry={loadRecord}
          />
        )}

        {/* Detail view */}
        {record && !error && (
          <div style={{ maxWidth: '640px' }}>
            {/* Meta header */}
            <div style={{ marginBottom: 'var(--chs-space-8)' }}>
              <Mono style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                {record.id}
              </Mono>
            </div>

            {/* Schema-driven field list */}
            {formFields.length === 0 ? (
              <div style={{ marginBottom: 'var(--chs-space-8)' }}>
                {/* Fallback: no schema / empty schema — render raw data keys */}
                {Object.keys(data).length === 0 ? (
                  <p style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
                    Запись не содержит полей.
                  </p>
                ) : (
                  Object.entries(data).map(([key, val]) => (
                    <div key={key} style={fieldRowStyle}>
                      <span style={labelStyle}>{key}</span>
                      <span style={valueStyle}>
                        {val === null || val === undefined
                          ? '—'
                          : typeof val === 'boolean'
                            ? (val ? 'Да' : 'Нет')
                            : typeof val === 'object'
                              ? JSON.stringify(val)
                              : String(val)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            ) : (
              <div style={{ marginBottom: 'var(--chs-space-8)' }}>
                {formFields.map((f) => (
                  <div key={f.key} style={fieldRowStyle}>
                    <span style={labelStyle}>{f.label}</span>
                    <span style={valueStyle}>
                      {data[f.key] === undefined || data[f.key] === null
                        ? '—'
                        : formatCellValue(data[f.key], f.type)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Metadata footer */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 'var(--chs-space-5) var(--chs-space-8)',
              paddingTop: 'var(--chs-space-6)',
              borderTop: '1px solid var(--chs-color-border)',
            }}>
              <div style={fieldRowStyle}>
                <span style={labelStyle}>Создано</span>
                <Mono style={{ ...valueStyle, fontSize: 'var(--chs-text-xs)' }}>
                  {fmtTs(record.created_at)}
                </Mono>
              </div>
              <div style={fieldRowStyle}>
                <span style={labelStyle}>Обновлено</span>
                <Mono style={{ ...valueStyle, fontSize: 'var(--chs-text-xs)' }}>
                  {fmtTs(record.updated_at)}
                </Mono>
              </div>
              {record.created_by && (
                <div style={fieldRowStyle}>
                  <span style={labelStyle}>Автор</span>
                  <Mono style={{ ...valueStyle, fontSize: 'var(--chs-text-xs)' }}>
                    {record.created_by}
                  </Mono>
                </div>
              )}
              <div style={fieldRowStyle}>
                <span style={labelStyle}>Версия схемы</span>
                <Mono style={{ ...valueStyle, fontSize: 'var(--chs-text-xs)' }}>
                  {record.record_schema_version}
                </Mono>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default RecordDetailScreen;
