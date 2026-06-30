/* ============================================================================
   CHOROS — screen-reports.jsx  (T-0490 · T-0492)
   Отчёты: список report_page выбранного приложения + просмотр агрегатов Floor-1
   + ПОСТРОИТЕЛЬ отчёта из UI (T-0492) + кнопка «Выгрузить».

   ЖИВЫЕ контракты:
     GET  /api/applications                — список приложений тенанта → { applications: [...] }
     GET  /api/registry-defs?application_id=<uuid> — наборы полей приложения → { registry_defs: [...] }
       def: { id, slug, display_name, record_schema: { properties: {<key>:{type,title?}} } }
     GET  /api/report-pages?app_id=<uuid>  — список страниц приложения → { pages: [...] }
     GET  /api/report-pages/:id/render     — Floor-1 агрегат: { page_id, floor, metrics[] }
       MetricResult: { source_registry_def_id, field_key, agg, result, grouped?, title? }
     GET  /api/report-pages/:id/export?format=xlsx|csv — файл агрегата (attachment)
     POST /api/report-pages   body { app_id, slug, title, floor:'1', page_def }
       → 201 { id, ... }   (floor='1' требует page_def; deps выводятся сервером)
     PATCH /api/report-pages/:id  body { title?, page_def? } → 200
     POST /api/report-pages/:id/promote → 200   (черновик → опубликован)

   page_def — массив метрик: { source_registry_def_id, field_key, agg, group_by?, title? }.
   Собирается ИСКЛЮЧИТЕЛЬНО чистым модулем report-builder.js (buildPageDef) —
   ровно та форма, что парсит сервер (report-page-render.ts → parseMetrics).

   ДИЗАЙН: строго OBLIK — только --chs-* токены, kit-компоненты.
   Состояния (G4): Загрузка / Пусто / Ошибка / Данные.
   Кнопки (G3): только включённые, без мёртвых действий.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, Field, Select, LoadingState, ErrorState, EmptyState, ConfirmDialog, useToasts, ToastViewport } from '../components/components.jsx';
import { ConsequenceSummary, useDestructiveConfirm } from '../util/confirm-helpers.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import {
  AGG_LABELS as BUILDER_AGG_LABELS,
  BUILDER_AGGS,
  extractSchemaFields,
  validateBuilder,
  buildCreateBody,
  buildPatchBody,
  blankMetric,
} from './report-builder.js';

// ---------------------------------------------------------------------------
// Token-only styles (OBLIK: --chs-* only)
// ---------------------------------------------------------------------------

const layoutStyle = {
  maxWidth: 1100,
  margin: '0 auto',
  padding: 'var(--chs-space-7)',
};

const headerRowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 'var(--chs-space-6)',
};

const h1Style = {
  fontSize: 'var(--chs-text-lg)',
  fontWeight: 'var(--chs-weight-bold)',
  color: 'var(--chs-color-text)',
  margin: 0,
};

const descStyle = {
  fontSize: 'var(--chs-text-sm)',
  color: 'var(--chs-color-text-muted)',
  margin: '0 0 var(--chs-space-5) 0',
};

// App selector row
const appSelectorRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--chs-space-4)',
  marginBottom: 'var(--chs-space-7)',
};

const appSelectorLabelStyle = {
  fontSize: 'var(--chs-text-sm)',
  fontWeight: 'var(--chs-weight-semibold)',
  color: 'var(--chs-color-text)',
  whiteSpace: 'nowrap',
};

const appSelectorSelectStyle = {
  fontSize: 'var(--chs-text-sm)',
  color: 'var(--chs-color-text)',
  background: 'var(--chs-color-surface)',
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-2)',
  padding: 'var(--chs-space-2) var(--chs-space-4)',
  minWidth: 200,
  cursor: 'pointer',
};

const twoColStyle = {
  display: 'grid',
  gridTemplateColumns: '280px 1fr',
  gap: 'var(--chs-space-6)',
  alignItems: 'start',
};

const sidebarStyle = {
  background: 'var(--chs-color-surface)',
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-3)',
  overflow: 'hidden',
};

const sidebarHeadStyle = {
  padding: 'var(--chs-space-4) var(--chs-space-5)',
  borderBottom: '1px solid var(--chs-color-border)',
  fontSize: 'var(--chs-text-xs)',
  fontWeight: 'var(--chs-weight-semibold)',
  color: 'var(--chs-color-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const reportItemBaseStyle = {
  width: '100%',
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--chs-color-border)',
  padding: 'var(--chs-space-4) var(--chs-space-5)',
  cursor: 'pointer',
  display: 'block',
};

const reportItemActiveStyle = {
  ...reportItemBaseStyle,
  background: 'var(--chs-color-accent-soft)',
  borderLeft: '3px solid var(--chs-color-accent)',
  paddingLeft: 'calc(var(--chs-space-5) - 3px)',
};

const reportItemLabelStyle = (active) => ({
  fontSize: 'var(--chs-text-sm)',
  fontWeight: active ? 'var(--chs-weight-semibold)' : 'var(--chs-weight-regular)',
  color: active ? 'var(--chs-color-accent)' : 'var(--chs-color-text)',
  display: 'block',
  marginBottom: 2,
});

const reportItemMetaStyle = {
  fontSize: 'var(--chs-text-xs)',
  color: 'var(--chs-color-text-muted)',
};

const mainPanelStyle = {
  background: 'var(--chs-color-surface)',
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-3)',
  padding: 'var(--chs-space-7)',
};

const panelHeadStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 'var(--chs-space-6)',
};

const panelTitleStyle = {
  fontSize: 'var(--chs-text-base)',
  fontWeight: 'var(--chs-weight-semibold)',
  color: 'var(--chs-color-text)',
  margin: 0,
};

const metricsGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 'var(--chs-space-4)',
  marginBottom: 'var(--chs-space-7)',
};

const metricCardStyle = {
  background: 'var(--chs-color-surface-raised)',
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-3)',
  padding: 'var(--chs-space-5)',
};

const metricLabelStyle = {
  fontSize: 'var(--chs-text-xs)',
  color: 'var(--chs-color-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 'var(--chs-space-2)',
};

const metricValueStyle = {
  fontSize: 'var(--chs-text-xl)',
  fontWeight: 'var(--chs-weight-bold)',
  color: 'var(--chs-color-text)',
  fontVariantNumeric: 'tabular-nums',
};

const metricAggStyle = {
  fontSize: 'var(--chs-text-xs)',
  color: 'var(--chs-color-text-muted)',
  marginTop: 'var(--chs-space-1)',
};

const sectionTitleStyle = {
  fontSize: 'var(--chs-text-sm)',
  fontWeight: 'var(--chs-weight-semibold)',
  color: 'var(--chs-color-text)',
  margin: '0 0 var(--chs-space-4) 0',
};

// Builder (T-0492) styles — token-only.
const builderPanelStyle = {
  background: 'var(--chs-color-surface)',
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-4)',
  padding: 'var(--chs-space-7) var(--chs-space-8)',
  marginBottom: 'var(--chs-space-7)',
};

const builderFieldErrStyle = {
  display: 'block',
  marginTop: 'var(--chs-space-2)',
  fontSize: 'var(--chs-text-xs)',
  color: 'var(--chs-color-danger)',
};

const metricRowStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 1.2fr) auto',
  gap: 'var(--chs-space-4)',
  alignItems: 'end',
  padding: 'var(--chs-space-3) 0',
  borderBottom: '1px solid var(--chs-color-border)',
};

// ---------------------------------------------------------------------------
// Bar chart (CSS/SVG, без внешних библиотек)
// ---------------------------------------------------------------------------

/**
 * Минимальный столбчатый SVG-график для сгруппированного метрического результата.
 * Принимает массив { group_key, result } (числовые значения).
 */
function BarChart({ data, title }) {
  if (!data || data.length === 0) return null;

  const HEIGHT = 160;
  const BAR_WIDTH = 32;
  const BAR_GAP = 12;
  const LABEL_AREA = 24;
  const PADDING_TOP = 16;
  const PADDING_LEFT = 8;

  // Парсим числовые значения
  const values = data.map((d) => {
    const v = parseFloat(d.result);
    return isNaN(v) ? 0 : v;
  });
  const maxVal = Math.max(...values, 1);

  const chartWidth = PADDING_LEFT * 2 + data.length * (BAR_WIDTH + BAR_GAP) - BAR_GAP;
  const chartHeight = HEIGHT + LABEL_AREA + PADDING_TOP;

  return (
    <div style={{ marginTop: 'var(--chs-space-5)', overflowX: 'auto' }}>
      {title && <div style={sectionTitleStyle}>{title}</div>}
      <svg
        width={chartWidth}
        height={chartHeight}
        aria-label={title ? `График: ${title}` : 'Столбчатый график'}
        role="img"
        style={{ display: 'block' }}
      >
        {data.map((d, i) => {
          const x = PADDING_LEFT + i * (BAR_WIDTH + BAR_GAP);
          const barH = Math.max(2, Math.round((values[i] / maxVal) * HEIGHT));
          const y = PADDING_TOP + HEIGHT - barH;
          const labelVal = fmtMetricValue(d.result);

          return (
            <g key={d.group_key ?? i}>
              {/* Подсказка-значение над баром */}
              <text
                x={x + BAR_WIDTH / 2}
                y={y - 4}
                textAnchor="middle"
                fontSize="9"
                fill="var(--chs-color-text-muted)"
              >
                {labelVal}
              </text>
              {/* Столбец */}
              <rect
                x={x}
                y={y}
                width={BAR_WIDTH}
                height={barH}
                rx="3"
                fill="var(--chs-color-accent)"
                opacity="0.85"
              />
              {/* Метка группы под столбцом */}
              <text
                x={x + BAR_WIDTH / 2}
                y={PADDING_TOP + HEIGHT + LABEL_AREA - 4}
                textAnchor="middle"
                fontSize="9"
                fill="var(--chs-color-text-muted)"
              >
                {String(d.group_key ?? '').slice(0, 12)}
              </text>
            </g>
          );
        })}
        {/* Базовая линия */}
        <line
          x1={0}
          y1={PADDING_TOP + HEIGHT}
          x2={chartWidth}
          y2={PADDING_TOP + HEIGHT}
          stroke="var(--chs-color-border)"
          strokeWidth="1"
        />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGG_LABELS = {
  count: 'количество',
  sum: 'сумма',
  avg: 'среднее',
  min: 'мин',
  max: 'макс',
  list: 'список',
};

function fmtMetricValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    // Round floats to 4 decimals, drop trailing zeros
    return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/\.?0+$/, '');
  }
  if (typeof value === 'string') {
    // Попробуем распарсить как число
    const n = parseFloat(value);
    if (!isNaN(n) && String(n) === value) return String(n);
    return value;
  }
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function metricTitle(m) {
  if (m.title) return m.title;
  return `${m.field_key} (${AGG_LABELS[m.agg] ?? m.agg})`;
}

// ---------------------------------------------------------------------------
// downloadReportExport — честное браузерное скачивание файла отчёта (T-0492).
//
// GET /api/report-pages/:id/export?format= шлёт attachment с auth-заголовком.
// Прямой <a href> НЕ работает: auth у нас через X-Dev-User / Bearer заголовки,
// которые навигация по ссылке не передаёт. Поэтому fetch(blob) → object URL →
// программный клик по a[download]. 401/403 → честное сообщение, без молчания.
//
// @returns {Promise<{ ok: true } | { ok: false, message: string }>}
// ---------------------------------------------------------------------------

async function downloadReportExport(pageId, format) {
  try {
    const res = await fetch(
      `/api/report-pages/${encodeURIComponent(pageId)}/export?format=${encodeURIComponent(format)}`,
      { headers: authHeaders() },
    );
    if (res.status === 401) return { ok: false, message: 'Войдите в систему для выгрузки.' };
    if (res.status === 403) return { ok: false, message: 'Нет прав на выгрузку этого отчёта.' };
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, message: `Ошибка выгрузки (HTTP ${res.status})${body.message ? ': ' + body.message : ''}` };
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `report-${pageId}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Освобождаем object URL на следующем тике (Safari ломается при синхронном revoke).
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return { ok: true };
  } catch {
    return { ok: false, message: 'Сетевая ошибка при выгрузке отчёта.' };
  }
}

// ---------------------------------------------------------------------------
// MetricCard — одна карточка метрики (скалярная или сгруппированная)
// ---------------------------------------------------------------------------

function MetricCard({ metric }) {
  const hasGrouped = Array.isArray(metric.grouped) && metric.grouped.length > 0;

  if (hasGrouped) {
    return (
      <div style={{ ...metricCardStyle, gridColumn: '1 / -1' }}>
        <div style={metricLabelStyle}>{metricTitle(metric)}</div>
        <BarChart data={metric.grouped} />
        <div style={{ marginTop: 'var(--chs-space-4)', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--chs-text-sm)' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--chs-color-text-muted)', fontWeight: 'var(--chs-weight-semibold)', fontSize: 'var(--chs-text-xs)', borderBottom: '1px solid var(--chs-color-border)' }}>
                  {metric.title || metric.field_key}
                </th>
                <th style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--chs-color-text-muted)', fontWeight: 'var(--chs-weight-semibold)', fontSize: 'var(--chs-text-xs)', borderBottom: '1px solid var(--chs-color-border)' }}>
                  {AGG_LABELS[metric.agg] ?? metric.agg}
                </th>
              </tr>
            </thead>
            <tbody>
              {metric.grouped.map((row, i) => (
                <tr key={row.group_key ?? i}>
                  <td style={{ padding: '4px 8px', color: 'var(--chs-color-text)', borderBottom: '1px solid var(--chs-color-border)' }}>
                    {String(row.group_key ?? '—')}
                  </td>
                  <td style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--chs-color-text)', fontVariantNumeric: 'tabular-nums', borderBottom: '1px solid var(--chs-color-border)' }}>
                    {fmtMetricValue(row.result)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div style={metricCardStyle}>
      <div style={metricLabelStyle}>{metricTitle(metric)}</div>
      <div style={metricValueStyle}>{fmtMetricValue(metric.result)}</div>
      <div style={metricAggStyle}>{AGG_LABELS[metric.agg] ?? metric.agg}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReportViewer — панель просмотра одного отчёта
// ---------------------------------------------------------------------------

function ReportViewer({ report, onEdit }) {
  const [renderResult, setRenderResult] = useState(null); // null=loading, false=error, obj=ok
  const [renderErr, setRenderErr] = useState(null);
  const [exporting, setExporting] = useState(null);       // 'xlsx' | 'csv' | null
  const [exportErr, setExportErr] = useState(null);

  const loadRender = useCallback(async () => {
    setRenderErr(null);
    setRenderResult(null);
    try {
      const res = await fetch(`/api/report-pages/${report.id}/render`, {
        headers: authHeaders(),
      });
      if (res.status === 401) {
        setRenderErr('Войдите в систему для просмотра отчёта.');
        setRenderResult(false);
        return;
      }
      if (res.status === 403) {
        setRenderErr('Нет прав на просмотр этого отчёта.');
        setRenderResult(false);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRenderErr(`Ошибка HTTP ${res.status}${body.message ? ': ' + body.message : ''}`);
        setRenderResult(false);
        return;
      }
      setRenderResult(await res.json());
    } catch {
      setRenderErr('Сетевая ошибка при загрузке отчёта.');
      setRenderResult(false);
    }
  }, [report.id]);

  useEffect(() => {
    loadRender();
  }, [loadRender]);

  const handleExport = useCallback(async (format) => {
    setExportErr(null);
    setExporting(format);
    const r = await downloadReportExport(report.id, format);
    if (!r.ok) setExportErr(r.message);
    setExporting(null);
  }, [report.id]);

  const metrics = renderResult && Array.isArray(renderResult.metrics) ? renderResult.metrics : [];
  // Выгрузка осмысленна только когда отчёт отрисован (есть авторизованный агрегат).
  const canExport = renderResult && renderResult !== false;

  return (
    <div style={mainPanelStyle}>
      <div style={panelHeadStyle}>
        <h2 style={panelTitleStyle}>{report.title ?? report.page_code ?? report.id}</h2>
        <div style={{ display: 'flex', gap: 'var(--chs-space-3)', alignItems: 'center' }}>
          {onEdit && report.tier !== 'published' && (
            <Button variant="ghost" size="sm" type="button" onClick={() => onEdit(report)}>
              Изменить
            </Button>
          )}
          <Button
            variant="ghost" size="sm" type="button"
            onClick={() => handleExport('xlsx')}
            disabled={!canExport || exporting !== null}
            loading={exporting === 'xlsx'}
            title="Скачать как Excel (.xlsx)"
          >
            Выгрузить XLSX
          </Button>
          <Button
            variant="ghost" size="sm" type="button"
            onClick={() => handleExport('csv')}
            disabled={!canExport || exporting !== null}
            loading={exporting === 'csv'}
            title="Скачать как CSV"
          >
            CSV
          </Button>
          <Button variant="ghost" size="sm" type="button" onClick={loadRender}>
            Обновить
          </Button>
        </div>
      </div>

      {exportErr && (
        <div role="alert" style={{
          marginBottom: 'var(--chs-space-5)', padding: 'var(--chs-space-3) var(--chs-space-4)',
          background: 'var(--chs-color-danger-soft)', border: '1px solid var(--chs-color-danger)',
          borderRadius: 'var(--chs-radius-2)', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text)',
        }}>
          {exportErr}
        </div>
      )}

      <div style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', marginBottom: 'var(--chs-space-5)' }}>
        {report.floor === '1' ? 'Floor-1 · агрегаты' : `Floor-${report.floor}`}
        {report.slug && <span style={{ marginLeft: 8 }}>/ {report.title || report.slug}</span>}
      </div>

      {/* Загрузка */}
      {renderResult === null && <LoadingState label="Загрузка данных отчёта…" />}

      {/* Ошибка */}
      {renderResult === false && (
        <ErrorState
          title="Не удалось загрузить отчёт"
          message={renderErr ?? ''}
          onRetry={loadRender}
        />
      )}

      {/* Пусто — данные пришли, но метрик нет */}
      {renderResult && metrics.length === 0 && (
        <EmptyState
          title="Данных нет"
          description="В этом отчёте пока нет метрик или данные ещё не накоплены."
        />
      )}

      {/* Данные */}
      {renderResult && metrics.length > 0 && (
        <div style={metricsGridStyle}>
          {metrics.map((m, i) => (
            <MetricCard key={`${m.field_key}-${m.agg}-${i}`} metric={m} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReportBuilder — построитель отчёта из UI (T-0492)
//
// Пользователь собирает Floor-1 отчёт сам: набор полей → группировка → метрики.
// page_def собирается чистым report-builder.js (ровно форма parseMetrics).
// Сохранение: POST (create) / PATCH (edit) → затем onSaved(page) показывает
// собранный отчёт через /render. Опубликовать: POST :id/promote.
//
// props:
//   appId      — приложение, к которому привязан отчёт (для POST app_id).
//   editing    — null = новый; объект report_page = правка черновика.
//   onSaved    — (savedPage) => void  (вызывается с актуальной строкой после сейва).
//   onCancel   — () => void.
// ---------------------------------------------------------------------------

function MetricRow({ index, metric, fields, error, onChange, onRemove, canRemove }) {
  const agg = metric.agg || 'count';
  const needsField = agg !== 'count'; // count может быть без поля
  const fieldOptions = (needsField ? fields.filter((f) => f.numeric) : fields).map((f) => ({
    value: f.key,
    label: f.label,
  }));

  return (
    <div role="group" aria-label={`Метрика ${index + 1}`} style={metricRowStyle}>
      <Select
        label={index === 0 ? 'Тип подсчёта' : undefined}
        aria-label="Тип подсчёта"
        value={agg}
        onChange={(e) => onChange({ ...metric, agg: e.target.value })}
        options={BUILDER_AGGS.map((a) => ({ value: a, label: BUILDER_AGG_LABELS[a] }))}
      />
      <Select
        label={index === 0 ? 'Поле' : undefined}
        aria-label="Поле метрики"
        value={metric.fieldKey || ''}
        onChange={(e) => onChange({ ...metric, fieldKey: e.target.value })}
        invalid={Boolean(error)}
        placeholder={
          !needsField
            ? '(не требуется — считаем записи)'
            : fieldOptions.length === 0
              ? 'Нет числовых полей в наборе'
              : 'Выберите числовое поле…'
        }
        disabled={!needsField || fieldOptions.length === 0}
        options={fieldOptions}
      />
      <Field
        label={index === 0 ? 'Подпись (опц.)' : undefined}
        aria-label="Подпись метрики"
        value={metric.title || ''}
        onChange={(e) => onChange({ ...metric, title: e.target.value })}
        placeholder="напр. Итого по сумме"
      />
      <Button
        type="button" variant="ghost" size="sm"
        onClick={() => onRemove(index)}
        disabled={!canRemove}
        title="Удалить метрику" aria-label="Удалить метрику"
      >
        Удалить
      </Button>
      {error && (
        <span style={{ ...builderFieldErrStyle, gridColumn: '1 / -1' }}>{error}</span>
      )}
    </div>
  );
}

function ReportBuilder({ appId, editing, onSaved, onCancel }) {
  const isEdit = Boolean(editing);

  // ── Наборы полей приложения ──────────────────────────────────────────────
  const [defs, setDefs] = useState(null);   // null=loading, false=error, []=ok
  const [defsErr, setDefsErr] = useState(null);

  // ── Состояние формы ──────────────────────────────────────────────────────
  const [title, setTitle] = useState(editing?.title || '');
  const [registryDefId, setRegistryDefId] = useState('');
  const [groupBy, setGroupBy] = useState('');
  const [metrics, setMetrics] = useState([blankMetric()]);

  const [errors, setErrors] = useState({});
  const [metricErrors, setMetricErrors] = useState({});
  const [submitErr, setSubmitErr] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // T-0526: undo-тосты для удаления метрик + confirm для публикации
  const { toasts: builderToasts, push: pushBuilderToast, dismiss: dismissBuilderToast } = useToasts();
  const [publishReportConfirmOpen, setPublishReportConfirmOpen] = useState(false);

  // Загрузка наборов полей выбранного приложения.
  const loadDefs = useCallback(async () => {
    if (!appId) return;
    setDefsErr(null);
    setDefs(null);
    try {
      const res = await fetch(
        `/api/registry-defs?application_id=${encodeURIComponent(appId)}`,
        { headers: authHeaders() },
      );
      if (res.status === 401) { setDefsErr('Войдите в систему.'); setDefs(false); return; }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDefsErr(`Ошибка HTTP ${res.status}${body.message ? ': ' + body.message : ''}`);
        setDefs(false);
        return;
      }
      const data = await res.json();
      const list = Array.isArray(data?.registry_defs) ? data.registry_defs : [];
      setDefs(list);
      // По умолчанию: первый набор. При правке пытаемся восстановить набор из page_def.
      const fromEditing = isEdit && Array.isArray(editing?.page_def) && editing.page_def[0]
        ? editing.page_def[0].source_registry_def_id
        : null;
      const preferred = (fromEditing && list.some((d) => d.id === fromEditing))
        ? fromEditing
        : (list.length > 0 ? list[0].id : '');
      setRegistryDefId((prev) => prev || preferred);
    } catch {
      setDefsErr('Сетевая ошибка при загрузке наборов полей.');
      setDefs(false);
    }
  }, [appId, isEdit, editing]);

  useEffect(() => { loadDefs(); }, [loadDefs]);

  // При правке: восстанавливаем метрики + группировку из page_def черновика.
  useEffect(() => {
    if (!isEdit || !Array.isArray(editing?.page_def) || editing.page_def.length === 0) return;
    const pd = editing.page_def;
    const restored = pd
      .filter((m) => m && BUILDER_AGGS.includes(m.agg))
      .map((m) => ({ agg: m.agg, fieldKey: m.agg === 'count' ? '' : (m.field_key || ''), title: m.title || '' }));
    if (restored.length > 0) setMetrics(restored);
    const gb = pd.find((m) => m && typeof m.group_by === 'string' && m.group_by);
    if (gb) setGroupBy(gb.group_by);
  }, [isEdit, editing]);

  // Поля выбранного набора (для группировки/метрик).
  const selectedDef = Array.isArray(defs) ? defs.find((d) => d.id === registryDefId) : null;
  const fields = selectedDef ? extractSchemaFields(selectedDef.record_schema) : [];
  // Стабильный fallback-ключ для count-метрик (любое реальное скалярное поле набора).
  const countFallbackKey = fields.length > 0 ? fields[0].key : '';

  const updateMetric = useCallback((i, next) => {
    setMetrics((prev) => prev.map((m, idx) => (idx === i ? next : m)));
  }, []);
  const addMetric = useCallback(() => setMetrics((prev) => [...prev, blankMetric()]), []);
  const removeMetric = useCallback((i) => {
    // Сайт 10: удаление метрики — undo-тост (5 с)
    setMetrics((prev) => {
      const removed = prev[i];
      const next = prev.filter((_, idx) => idx !== i);
      if (removed) {
        const toastId = pushBuilderToast({
          tone: 'success',
          title: 'Метрика удалена',
          duration: 5000,
          action: (
            <button
              type="button"
              className="chs-toast__undo"
              onClick={() => {
                setMetrics((cur) => {
                  const copy = [...cur];
                  copy.splice(Math.min(i, copy.length), 0, removed);
                  return copy;
                });
                dismissBuilderToast(toastId);
              }}
            >
              Отменить
            </button>
          ),
        });
      }
      return next;
    });
  }, [pushBuilderToast, dismissBuilderToast]);

  // При смене набора сбрасываем группировку и поля метрик (старые ключи невалидны).
  const handleRegistryChange = useCallback((newId) => {
    setRegistryDefId(newId);
    setGroupBy('');
    setMetrics([blankMetric()]);
    setMetricErrors({});
  }, []);

  const handleSubmit = useCallback(async (promote) => {
    setSubmitErr(null);
    const state = { title, registryDefId, groupBy, metrics, countFallbackKey };
    const v = validateBuilder(state);
    setErrors(v.errors);
    setMetricErrors(v.metricErrors);
    if (!v.valid) return;

    setSubmitting(true);
    try {
      let pageId = editing?.id;
      // 1) Создать или обновить черновик.
      if (isEdit) {
        const res = await fetch(`/api/report-pages/${encodeURIComponent(editing.id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify(buildPatchBody({ title, registryDefId, groupBy, metrics, countFallbackKey })),
        });
        if (!res.ok) {
          if (res.status === 401) { setSubmitErr('Войдите в систему.'); return; }
          if (res.status === 403) { setSubmitErr('Нет прав на создание отчётов в этом приложении. Обратитесь к владельцу.'); return; }
          setSubmitErr(await apiErr(res, 'Не удалось сохранить отчёт'));
          return;
        }
      } else {
        const res = await fetch('/api/report-pages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify(buildCreateBody({ appId, title, registryDefId, groupBy, metrics, countFallbackKey })),
        });
        if (res.status !== 201 && res.status !== 200) {
          if (res.status === 401) { setSubmitErr('Войдите в систему.'); return; }
          if (res.status === 403) { setSubmitErr('Нет прав на создание отчётов в этом приложении. Обратитесь к владельцу.'); return; }
          setSubmitErr(await apiErr(res, 'Не удалось создать отчёт'));
          return;
        }
        const created = await res.json().catch(() => null);
        pageId = created?.id;
      }

      // 2) Опубликовать, если запрошено.
      if (promote && pageId) {
        const res = await fetch(`/api/report-pages/${encodeURIComponent(pageId)}/promote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
        });
        if (!res.ok) {
          if (res.status === 401) { setSubmitErr('Отчёт сохранён. Войдите в систему для публикации.'); return; }
          if (res.status === 403) { setSubmitErr('Публиковать отчёты может только человек с правом публикации.'); return; }
          setSubmitErr(await apiErr(res, 'Отчёт сохранён, но не опубликован'));
          // Всё равно показываем сохранённый отчёт ниже.
        }
      }

      if (pageId) {
        onSaved({
          id: pageId,
          app_id: appId,
          title: title.trim(),
          floor: '1',
          tier: promote ? 'published' : 'draft',
        });
      }
    } catch (err) {
      setSubmitErr(String(err?.message || err));
    } finally {
      setSubmitting(false);
    }
  }, [title, registryDefId, groupBy, metrics, countFallbackKey, appId, isEdit, editing, onSaved]);

  return (
    <div style={builderPanelStyle}>
      <h2 style={{ margin: '0 0 var(--chs-space-6) 0', fontSize: 'var(--chs-text-md)', fontWeight: 'var(--chs-weight-semibold)', color: 'var(--chs-color-text)' }}>
        {isEdit ? 'Изменить отчёт' : 'Новый отчёт'}
      </h2>

      {/* Загрузка/ошибка наборов полей */}
      {defs === null && <LoadingState label="Загрузка наборов полей…" />}
      {defs === false && (
        <ErrorState title="Не удалось загрузить наборы полей" message={defsErr ?? ''} onRetry={loadDefs} />
      )}
      {Array.isArray(defs) && defs.length === 0 && (
        <EmptyState
          title="Нет наборов полей"
          description="Сначала определите поля приложения в конструкторе — тогда по ним можно строить отчёты."
        />
      )}

      {Array.isArray(defs) && defs.length > 0 && (
        <>
          {/* Заголовок */}
          <div style={{ marginBottom: 'var(--chs-space-6)', maxWidth: 480 }}>
            <Field
              label="Заголовок отчёта"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="напр. Закупки по статусу"
              invalid={Boolean(errors.title)}
            />
            {errors.title && <span style={builderFieldErrStyle}>{errors.title}</span>}
          </div>

          {/* Набор полей (что считаем) */}
          <div style={{ marginBottom: 'var(--chs-space-6)', maxWidth: 480 }}>
            <Select
              label="Что считаем (набор полей)"
              value={registryDefId}
              onChange={(e) => handleRegistryChange(e.target.value)}
              invalid={Boolean(errors.registryDefId)}
              placeholder="Выберите набор полей…"
              options={defs.map((d) => ({ value: d.id, label: d.display_name || d.slug }))}
            />
            {errors.registryDefId && <span style={builderFieldErrStyle}>{errors.registryDefId}</span>}
          </div>

          {/* Группировка */}
          <div style={{ marginBottom: 'var(--chs-space-7)', maxWidth: 480 }}>
            <Select
              label="Группировать по полю (необязательно)"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value)}
              disabled={fields.length === 0}
              options={[
                { value: '', label: '— без группировки —' },
                ...fields.map((f) => ({ value: f.key, label: f.label })),
              ]}
            />
            {fields.length === 0 && (
              <span style={{ ...builderFieldErrStyle, color: 'var(--chs-color-text-muted)' }}>
                В выбранном наборе нет полей для группировки
              </span>
            )}
          </div>

          {/* Метрики */}
          <div style={{ marginBottom: 'var(--chs-space-5)' }}>
            <div style={sectionTitleStyle}>Метрики</div>
            {errors.metrics && <span style={builderFieldErrStyle}>{errors.metrics}</span>}
            {metrics.map((m, i) => (
              <MetricRow
                key={i}
                index={i}
                metric={m}
                fields={fields}
                error={metricErrors[i]}
                onChange={(next) => updateMetric(i, next)}
                onRemove={removeMetric}
                canRemove={metrics.length > 1}
              />
            ))}
            <div style={{ marginTop: 'var(--chs-space-4)' }}>
              <Button type="button" variant="ghost" size="sm" onClick={addMetric}>
                + Добавить метрику
              </Button>
            </div>
          </div>

          {/* Ошибка отправки */}
          {submitErr && (
            <div role="alert" style={{
              marginTop: 'var(--chs-space-5)', padding: 'var(--chs-space-4) var(--chs-space-5)',
              background: 'var(--chs-color-danger-soft)', border: '1px solid var(--chs-color-danger)',
              borderRadius: 'var(--chs-radius-3)', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text)',
            }}>
              {submitErr}
            </div>
          )}

          {/* Кнопки */}
          <div style={{ display: 'flex', gap: 'var(--chs-space-4)', justifyContent: 'flex-end', marginTop: 'var(--chs-space-7)' }}>
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
              Отмена
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => handleSubmit(false)} loading={submitting}>
              Сохранить черновик
            </Button>
            {/* T-0526: визуальный разделитель + danger variant */}
            <span aria-hidden="true" style={{ display: 'inline-block', width: 1, background: 'var(--chs-color-border)', alignSelf: 'stretch', margin: '0 2px' }} />
            <Button type="button" variant="danger" size="sm" onClick={() => setPublishReportConfirmOpen(true)} loading={submitting}>
              Опубликовать
            </Button>
          </div>
        </>
      )}

      {/* T-0526: ConfirmDialog для публикации отчёта */}
      <ConfirmDialog
        open={publishReportConfirmOpen}
        tone="danger"
        title="Опубликовать отчёт?"
        message={
          <ConsequenceSummary
            who={`Отчёт «${title || 'Новый отчёт'}»`}
            what="Черновик публикуется. Отчёт становится доступен всем пользователям с правом просмотра."
            reversibility="Необратимо. Для правки нужно создать новую версию."
          />
        }
        confirmLabel="Опубликовать"
        onConfirm={() => { setPublishReportConfirmOpen(false); handleSubmit(true); }}
        onClose={() => setPublishReportConfirmOpen(false)}
        loading={submitting}
      />
      <ToastViewport toasts={builderToasts} dismiss={dismissBuilderToast} />
    </div>
  );
}

/** Извлекает человеческое сообщение из ответа-ошибки API. */
async function apiErr(res, fallback) {
  const body = await res.json().catch(() => null);
  if (body && typeof body.message === 'string' && body.message) return body.message;
  return `${fallback} (HTTP ${res.status})`;
}

// ---------------------------------------------------------------------------
// ReportsScreen — корневой компонент
// ---------------------------------------------------------------------------

export default function ReportsScreen() {
  // ── Приложения тенанта ────────────────────────────────────────────────────
  const [apps, setApps] = useState(null);      // null=loading, false=error, []=ok
  const [appsErr, setAppsErr] = useState(null);
  const [selectedAppId, setSelectedAppId] = useState(null);

  const loadApps = useCallback(async () => {
    setAppsErr(null);
    setApps(null);
    try {
      const res = await fetch('/api/applications', { headers: authHeaders() });
      if (res.status === 401) {
        setAppsErr('Войдите в систему.');
        setApps(false);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setAppsErr(`Ошибка HTTP ${res.status}${body.message ? ': ' + body.message : ''}`);
        setApps(false);
        return;
      }
      const data = await res.json();
      const list = Array.isArray(data.applications) ? data.applications : [];
      setApps(list);
      if (list.length > 0) setSelectedAppId((prev) => prev ?? list[0].id);
    } catch {
      setAppsErr('Сетевая ошибка при загрузке приложений.');
      setApps(false);
    }
  }, []);

  useEffect(() => {
    loadApps();
  }, [loadApps]);

  // ── Список отчётов выбранного приложения ──────────────────────────────────
  const [pages, setPages] = useState(null);    // null=loading, false=error, []=ok
  const [pagesErr, setPagesErr] = useState(null);
  const [selected, setSelected] = useState(null); // выбранный report_page

  const loadPages = useCallback(async () => {
    if (!selectedAppId) return;
    setPagesErr(null);
    setPages(null);
    setSelected(null);
    try {
      const res = await fetch(`/api/report-pages?app_id=${encodeURIComponent(selectedAppId)}`, {
        headers: authHeaders(),
      });
      if (res.status === 401) {
        setPagesErr('Войдите в систему.');
        setPages(false);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setPagesErr(`Ошибка HTTP ${res.status}${body.message ? ': ' + body.message : ''}`);
        setPages(false);
        return;
      }
      const data = await res.json();
      // Blocker 1 fix: сервер возвращает { pages: [...] }; устойчивость к массиву
      const list = Array.isArray(data) ? data : (Array.isArray(data.pages) ? data.pages : (Array.isArray(data.items) ? data.items : []));
      setPages(list);
      if (list.length > 0) setSelected(list[0]);
    } catch {
      setPagesErr('Сетевая ошибка.');
      setPages(false);
    }
  }, [selectedAppId]);

  useEffect(() => {
    loadPages();
  }, [loadPages]);

  // При смене selectedId сбрасываем если больше нет в списке
  useEffect(() => {
    if (Array.isArray(pages) && selected) {
      const still = pages.find((p) => p.id === selected.id);
      if (!still) setSelected(pages.length > 0 ? pages[0] : null);
    }
  }, [pages]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Вычисляем имя выбранного приложения ──────────────────────────────────
  const selectedApp = Array.isArray(apps) ? apps.find((a) => a.id === selectedAppId) : null;

  // ── Режим построителя (T-0492) ───────────────────────────────────────────
  // undefined = закрыт; null = новый отчёт; объект report_page = правка черновика.
  const [builder, setBuilder] = useState(undefined);

  // После сохранения/публикации: закрыть построитель, перезагрузить список,
  // выбрать сохранённый отчёт (по id), чтобы он сразу отрисовался через /render.
  const handleBuilderSaved = useCallback(async (savedPage) => {
    setBuilder(undefined);
    if (!selectedAppId || !savedPage?.id) { loadPages(); return; }
    try {
      const res = await fetch(`/api/report-pages?app_id=${encodeURIComponent(selectedAppId)}`, {
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : (Array.isArray(data.pages) ? data.pages : []);
        setPages(list);
        const match = list.find((p) => p.id === savedPage.id);
        setSelected(match || savedPage);
        return;
      }
    } catch { /* падаем в общий перезагруз */ }
    loadPages();
  }, [selectedAppId, loadPages]);

  return (
    <div style={layoutStyle}>
      {/* ── Заголовок ──────────────────────────────────────────────────────── */}
      <div style={headerRowStyle}>
        <h1 style={h1Style}>Отчёты</h1>
        <div style={{ display: 'flex', gap: 'var(--chs-space-4)', alignItems: 'center' }}>
          <Button variant="ghost" size="sm" type="button" onClick={loadPages} disabled={!selectedAppId || builder !== undefined}>
            Обновить
          </Button>
          {builder === undefined && (
            <Button
              variant="primary" size="sm" type="button"
              onClick={() => setBuilder(null)}
              disabled={!selectedAppId}
              title={selectedAppId ? 'Собрать новый отчёт' : 'Сначала выберите приложение'}
            >
              Новый отчёт
            </Button>
          )}
        </div>
      </div>

      <p style={descStyle}>
        Просмотр и сборка отчётов по данным реестров. Соберите отчёт из полей
        приложения — без программиста — и выгрузите его в XLSX или CSV.
      </p>

      {/* ── Загрузка списка приложений ───────────────────────────────────── */}
      {apps === null && <LoadingState label="Загрузка приложений…" />}

      {/* ── Ошибка загрузки приложений ───────────────────────────────────── */}
      {apps === false && (
        <ErrorState
          title="Не удалось загрузить приложения"
          message={appsErr ?? ''}
          onRetry={loadApps}
        />
      )}

      {/* ── Нет приложений ───────────────────────────────────────────────── */}
      {Array.isArray(apps) && apps.length === 0 && (
        <EmptyState
          title="Нет приложений"
          description="Сначала создайте приложение в конструкторе, затем добавьте к нему отчёты."
        />
      )}

      {/* ── Есть приложения: селектор + список отчётов ───────────────────── */}
      {Array.isArray(apps) && apps.length > 0 && (
        <>
          {/* Селектор приложения */}
          <div style={appSelectorRowStyle}>
            <label htmlFor="app-select" style={appSelectorLabelStyle}>
              Приложение:
            </label>
            <select
              id="app-select"
              style={appSelectorSelectStyle}
              value={selectedAppId ?? ''}
              onChange={(e) => setSelectedAppId(e.target.value)}
            >
              {apps.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.display_name ?? app.slug ?? app.id}
                </option>
              ))}
            </select>
            {selectedApp && (
              <span style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                {selectedApp.slug}
              </span>
            )}
          </div>

          {/* ── Построитель отчёта (T-0492) ──────────────────────────────── */}
          {builder !== undefined && selectedAppId && (
            <ReportBuilder
              key={builder?.id ?? 'new'}
              appId={selectedAppId}
              editing={builder}
              onSaved={handleBuilderSaved}
              onCancel={() => setBuilder(undefined)}
            />
          )}

          {/* Пока открыт построитель — список ниже скрыт, чтобы не конкурировать. */}

          {/* ── Загрузка списка отчётов ──────────────────────────────────── */}
          {builder === undefined && pages === null && <LoadingState label="Загрузка списка отчётов…" />}

          {/* ── Ошибка загрузки отчётов ──────────────────────────────────── */}
          {builder === undefined && pages === false && (
            <ErrorState
              title="Не удалось загрузить отчёты"
              message={pagesErr ?? ''}
              onRetry={loadPages}
            />
          )}

          {/* ── Пусто ────────────────────────────────────────────────────── */}
          {builder === undefined && Array.isArray(pages) && pages.length === 0 && (
            <EmptyState
              title="Отчётов пока нет"
              description="Соберите первый отчёт по полям приложения."
              action={
                <Button variant="primary" type="button" onClick={() => setBuilder(null)}>
                  Новый отчёт
                </Button>
              }
            />
          )}

          {/* ── Двухколоночный макет: список + просмотр ──────────────────── */}
          {builder === undefined && Array.isArray(pages) && pages.length > 0 && (
            <div style={twoColStyle}>
              {/* Левая колонка: список */}
              <div style={sidebarStyle}>
                <div style={sidebarHeadStyle}>Список отчётов</div>
                {pages.map((page) => {
                  const active = selected?.id === page.id;
                  return (
                    <button
                      key={page.id}
                      type="button"
                      style={active ? reportItemActiveStyle : reportItemBaseStyle}
                      aria-pressed={active}
                      onClick={() => setSelected(page)}
                    >
                      <span style={reportItemLabelStyle(active)}>
                        {page.title ?? page.page_code ?? page.id}
                      </span>
                      <span style={reportItemMetaStyle}>
                        {page.floor === '1' ? 'агрегаты' : `floor-${page.floor}`}
                        {page.tier ? ` · ${{ draft: 'черновик', published: 'опубликован' }[page.tier] ?? page.tier}` : ''}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Правая колонка: просмотр */}
              {selected ? (
                <ReportViewer key={selected.id} report={selected} onEdit={(p) => setBuilder(p)} />
              ) : (
                <div style={{ ...mainPanelStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200 }}>
                  <span style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
                    Выберите отчёт из списка
                  </span>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
