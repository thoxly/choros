/* ============================================================================
   CHOROS — screen-reports.jsx  (T-0490)
   Отчёты: список report_page текущего тенанта + просмотр агрегатов Floor-1.

   Только ПРОСМОТР — построитель/создание в T-0492.

   ЖИВЫЕ контракты:
     GET  /api/report-pages?app_id=<uuid>  — список страниц приложения
     GET  /api/report-pages/:id/render     — Floor-1 агрегат: { page_id, floor, metrics[] }
       MetricResult: { source_registry_def_id, field_key, agg, result, grouped?, title? }

   ДИЗАЙН: строго OBLIK — только --chs-* токены, kit-компоненты.
   Состояния (G4): Загрузка / Пусто / Ошибка / Данные.
   Кнопки (G3): только включённые, без мёртвых действий.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, LoadingState, ErrorState, EmptyState } from '../components/components.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';

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
  margin: '0 0 var(--chs-space-7) 0',
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
  background: 'var(--chs-color-primary-subtle)',
  borderLeft: '3px solid var(--chs-color-primary)',
  paddingLeft: 'calc(var(--chs-space-5) - 3px)',
};

const reportItemLabelStyle = (active) => ({
  fontSize: 'var(--chs-text-sm)',
  fontWeight: active ? 'var(--chs-weight-semibold)' : 'var(--chs-weight-normal)',
  color: active ? 'var(--chs-color-primary)' : 'var(--chs-color-text)',
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
                fill="var(--chs-color-primary)"
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
                  {metric.field_key}
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

function ReportViewer({ report }) {
  const [renderResult, setRenderResult] = useState(null); // null=loading, false=error, obj=ok
  const [renderErr, setRenderErr] = useState(null);

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

  const metrics = renderResult && Array.isArray(renderResult.metrics) ? renderResult.metrics : [];

  return (
    <div style={mainPanelStyle}>
      <div style={panelHeadStyle}>
        <h2 style={panelTitleStyle}>{report.title ?? report.page_code ?? report.id}</h2>
        <Button variant="ghost" size="sm" type="button" onClick={loadRender}>
          Обновить
        </Button>
      </div>

      <div style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', marginBottom: 'var(--chs-space-5)' }}>
        {report.floor === '1' ? 'Floor-1 · агрегаты' : `Floor-${report.floor}`}
        {report.slug && <span style={{ marginLeft: 8 }}>/ {report.slug}</span>}
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
// ReportsScreen — корневой компонент
// ---------------------------------------------------------------------------

export default function ReportsScreen() {
  // Список всех отчётов (без фильтра по приложению — тенант-изоляция на сервере)
  const [pages, setPages] = useState(null);   // null=loading, false=error, []=ok
  const [pagesErr, setPagesErr] = useState(null);
  const [selected, setSelected] = useState(null); // выбранный report_page

  const loadPages = useCallback(async () => {
    setPagesErr(null);
    setPages(null);
    try {
      const res = await fetch('/api/report-pages', { headers: authHeaders() });
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
      const list = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
      setPages(list);
      // Автовыбор первого элемента
      if (list.length > 0 && !selected) setSelected(list[0]);
    } catch {
      setPagesErr('Сетевая ошибка.');
      setPages(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  return (
    <div style={layoutStyle}>
      {/* ── Заголовок ──────────────────────────────────────────────────────── */}
      <div style={headerRowStyle}>
        <h1 style={h1Style}>Отчёты</h1>
        <Button variant="ghost" size="sm" type="button" onClick={loadPages}>
          Обновить
        </Button>
      </div>

      <p style={descStyle}>
        Просмотр отчётов и агрегатов по данным реестров.
        Создание отчётов — в конструкторе.
      </p>

      {/* ── Загрузка списка ─────────────────────────────────────────────── */}
      {pages === null && <LoadingState label="Загрузка списка отчётов…" />}

      {/* ── Ошибка загрузки списка ──────────────────────────────────────── */}
      {pages === false && (
        <ErrorState
          title="Не удалось загрузить отчёты"
          message={pagesErr ?? ''}
          onRetry={loadPages}
        />
      )}

      {/* ── Пусто ───────────────────────────────────────────────────────── */}
      {Array.isArray(pages) && pages.length === 0 && (
        <EmptyState
          title="Отчётов пока нет"
          description="Создайте отчёт в конструкторе, чтобы он появился здесь."
        />
      )}

      {/* ── Двухколоночный макет: список + просмотр ─────────────────────── */}
      {Array.isArray(pages) && pages.length > 0 && (
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
                    {page.tier ? ` · ${page.tier}` : ''}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Правая колонка: просмотр */}
          {selected ? (
            <ReportViewer key={selected.id} report={selected} />
          ) : (
            <div style={{ ...mainPanelStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200 }}>
              <span style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
                Выберите отчёт из списка
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
