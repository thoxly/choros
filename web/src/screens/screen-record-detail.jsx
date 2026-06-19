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
import { Button, Mono } from '../components/components.jsx';
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
  gap: '4px',
  padding: '12px 0',
  borderBottom: '1px solid var(--chs-border, #30333d)',
};

const labelStyle = {
  fontSize: 'var(--chs-text-xs, 12px)',
  color: 'var(--chs-color-text-muted, #888)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const valueStyle = {
  fontSize: 'var(--chs-text-sm, 13px)',
  color: 'inherit',
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
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px',
        padding: 'var(--chs-space-3, 12px) var(--chs-space-4, 16px)',
        borderBottom: '1px solid var(--chs-border, #30333d)',
      }}>
        <span style={{ fontSize: 'var(--chs-text-sm, 13px)', color: 'var(--chs-color-text-muted, #888)' }}>
          Детали записи
        </span>
        <Button variant="ghost" size="sm" onClick={() => navigate(backPath)}>
          ← Назад к списку
        </Button>
      </div>

      <div className="chs-inbox__scroll" style={{ padding: 'var(--chs-space-4, 16px) var(--chs-space-5, 20px)' }}>
        {/* Loading */}
        {!error && record === null && (
          <div style={{ padding: 'var(--chs-space-5)', textAlign: 'center' }}>
            Загрузка записи…
          </div>
        )}

        {/* Not found */}
        {error && typeof error === 'object' && error.notFound && (
          <div style={{ padding: 'var(--chs-space-5)', textAlign: 'center' }}>
            <p style={{ marginBottom: 'var(--chs-space-3)', color: 'var(--chs-color-text-muted, #888)' }}>
              Запись не найдена или у вас нет к ней доступа.
            </p>
            <Button variant="primary" onClick={() => navigate(backPath)}>
              Вернуться к списку
            </Button>
          </div>
        )}

        {/* Generic error */}
        {error && typeof error === 'string' && (
          <div style={{ padding: 'var(--chs-space-5)', textAlign: 'center' }}>
            <p style={{ marginBottom: 'var(--chs-space-3)' }}>Не удалось загрузить запись: {error}</p>
            <Button onClick={loadRecord}>Повторить</Button>
          </div>
        )}

        {/* Detail view */}
        {record && !error && (
          <div style={{ maxWidth: '640px' }}>
            {/* Meta header */}
            <div style={{ marginBottom: '24px' }}>
              <Mono style={{ fontSize: 'var(--chs-text-xs, 12px)', color: 'var(--chs-color-text-muted, #888)' }}>
                {record.id}
              </Mono>
            </div>

            {/* Schema-driven field list */}
            {formFields.length === 0 ? (
              <div style={{ marginBottom: '24px' }}>
                {/* Fallback: no schema / empty schema — render raw data keys */}
                {Object.keys(data).length === 0 ? (
                  <p style={{ color: 'var(--chs-color-text-muted, #888)', fontSize: 'var(--chs-text-sm, 13px)' }}>
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
              <div style={{ marginBottom: '24px' }}>
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
              gap: '12px 24px',
              paddingTop: '16px',
              borderTop: '1px solid var(--chs-border, #30333d)',
            }}>
              <div style={fieldRowStyle}>
                <span style={labelStyle}>Создано</span>
                <Mono style={{ ...valueStyle, fontSize: 'var(--chs-text-xs, 12px)' }}>
                  {fmtTs(record.created_at)}
                </Mono>
              </div>
              <div style={fieldRowStyle}>
                <span style={labelStyle}>Обновлено</span>
                <Mono style={{ ...valueStyle, fontSize: 'var(--chs-text-xs, 12px)' }}>
                  {fmtTs(record.updated_at)}
                </Mono>
              </div>
              {record.created_by && (
                <div style={fieldRowStyle}>
                  <span style={labelStyle}>Автор</span>
                  <Mono style={{ ...valueStyle, fontSize: 'var(--chs-text-xs, 12px)' }}>
                    {record.created_by}
                  </Mono>
                </div>
              )}
              <div style={fieldRowStyle}>
                <span style={labelStyle}>Версия схемы</span>
                <Mono style={{ ...valueStyle, fontSize: 'var(--chs-text-xs, 12px)' }}>
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
