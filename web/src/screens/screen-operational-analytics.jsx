/* ============================================================================
   CHOROS — screen-operational-analytics.jsx  (T-0405 [PD-20])
   Оперативная аналитика: нагрузка по периодам + суммы по записям + выгрузка.

   Граница (ТЗ инж.ресурсов): таблица → бар → Гант; глубокий анализ = выгрузка.
   НЕ строим BI-движок/склад — агрегаты считает БД, браузер получает маленький результат.

   ЖИВЫЕ контракты:
     GET /api/operational-analytics
       ?process_key=<str>          (необязательно)
       ?registry_def_id=<uuid>     (необязательно)
       ?field_key=<str>            (необязательно)
       → { tenant_id, workload_daily[], workload_weekly[], workload_monthly[], top_actors[],
           record_sums?[], registry_def_id?, field_key? }

     GET /api/operational-analytics/export
       ?format=xlsx|csv
       ?period=day|week|month
       ?process_key=<str> ?registry_def_id=<uuid> ?field_key=<str>
       → attachment file

   ДИЗАЙН: строго OBLIK — только --chs-* токены, kit-компоненты.
   Состояния (G4): Загрузка / Ошибка / Пусто / Данные.
   Кнопки (G3): только включённые, без мёртвых действий.
   ============================================================================ */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button, Select, Field, ActorChip, LoadingState, ErrorState, EmptyState } from '../components/components.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';

// ---------------------------------------------------------------------------
// Token-only styles
// ---------------------------------------------------------------------------

const layoutStyle = { maxWidth: 1100, margin: '0 auto', padding: 'var(--chs-space-7)' };
const headerRowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--chs-space-6)' };
const h1Style = { fontSize: 'var(--chs-text-lg)', fontWeight: 'var(--chs-weight-bold)', color: 'var(--chs-color-text)', margin: 0 };
const descStyle = { fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', margin: '0 0 var(--chs-space-6) 0' };

const controlsRowStyle = {
  display: 'flex',
  gap: 'var(--chs-space-4)',
  alignItems: 'flex-end',
  flexWrap: 'wrap',
  marginBottom: 'var(--chs-space-7)',
};

const sectionStyle = {
  background: 'var(--chs-color-surface)',
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-3)',
  marginBottom: 'var(--chs-space-7)',
  overflow: 'hidden',
};

const sectionHeadStyle = {
  padding: 'var(--chs-space-5) var(--chs-space-7)',
  borderBottom: '1px solid var(--chs-color-border)',
  fontSize: 'var(--chs-text-base)',
  fontWeight: 'var(--chs-weight-semibold)',
  color: 'var(--chs-color-text)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--chs-text-sm)' };
const thStyle = {
  textAlign: 'left',
  padding: 'var(--chs-space-3) var(--chs-space-7)',
  color: 'var(--chs-color-text-muted)',
  fontWeight: 'var(--chs-weight-semibold)',
  fontSize: 'var(--chs-text-xs)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  borderBottom: '1px solid var(--chs-color-border)',
  background: 'var(--chs-color-surface)',
  whiteSpace: 'nowrap',
};
const thRightStyle = { ...thStyle, textAlign: 'right' };
const tdStyle = {
  padding: 'var(--chs-space-3) var(--chs-space-7)',
  color: 'var(--chs-color-text)',
  borderBottom: '1px solid var(--chs-color-border)',
  verticalAlign: 'middle',
};
const tdRightStyle = { ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

const exportRowStyle = {
  display: 'flex',
  gap: 'var(--chs-space-3)',
  padding: 'var(--chs-space-5) var(--chs-space-7)',
  borderTop: '1px solid var(--chs-color-border)',
  background: 'var(--chs-color-surface-raised)',
  alignItems: 'center',
};

// ---------------------------------------------------------------------------
// Горизонтальный мини-бар (относительная нагрузка)
// ---------------------------------------------------------------------------

function MiniBar({ value, max }) {
  if (!value || !max || max === 0) return null;
  const pct = Math.max(2, Math.round((value / max) * 100));
  return (
    <div
      style={{
        display: 'inline-block',
        width: 72,
        height: 6,
        background: 'var(--chs-color-border)',
        borderRadius: 'var(--chs-radius-full)',
        verticalAlign: 'middle',
        marginRight: 'var(--chs-space-3)',
        overflow: 'hidden',
      }}
      aria-hidden="true"
    >
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          background: 'var(--chs-color-accent)',
          borderRadius: 'var(--chs-radius-full)',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Гант-строка: визуальный индикатор за период (простая горизонтальная шкала)
// ---------------------------------------------------------------------------

function GanttBar({ value, max, label }) {
  if (!max || max === 0) return <span style={{ color: 'var(--chs-color-text-muted)' }}>—</span>;
  const pct = Math.max(1, Math.round((value / max) * 100));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-2)' }}>
      <div
        style={{
          flex: 1,
          maxWidth: 160,
          height: 12,
          background: 'var(--chs-color-border)',
          borderRadius: 'var(--chs-radius-1)',
          overflow: 'hidden',
        }}
        aria-label={label}
        title={label}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: 'var(--chs-color-accent)',
            borderRadius: 'var(--chs-radius-1)',
          }}
        />
      </div>
      <span style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', minWidth: 28, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorkloadTable — таблица нагрузки по периодам
// ---------------------------------------------------------------------------

function WorkloadTable({ rows, hasSums, fieldKey, title, onExport, exportDisabled }) {
  const maxTransitions = useMemo(
    () => rows.reduce((mx, r) => Math.max(mx, r.transition_count), 0),
    [rows]
  );

  if (rows.length === 0) {
    return (
      <div style={sectionStyle}>
        <div style={sectionHeadStyle}><span>{title}</span></div>
        <div style={{ padding: 'var(--chs-space-7)' }}>
          <EmptyState title="Нет данных" description="За этот период нет активности процессов." />
        </div>
      </div>
    );
  }

  return (
    <div style={sectionStyle}>
      <div style={sectionHeadStyle}>
        <span>{title}</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={tableStyle} aria-label={title}>
          <thead>
            <tr>
              <th style={thStyle}>Период</th>
              <th style={thStyle}>Нагрузка (переходы)</th>
              <th style={thRightStyle}>Переходов</th>
              <th style={thRightStyle}>Инстанций</th>
              {hasSums && (
                <>
                  <th style={thRightStyle}>Сумма ({fieldKey})</th>
                  <th style={thRightStyle}>Записей</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.period}>
                <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums', fontFamily: 'monospace', fontSize: 'var(--chs-text-xs)' }}>
                  {row.period}
                </td>
                <td style={tdStyle}>
                  <GanttBar
                    value={row.transition_count}
                    max={maxTransitions}
                    label={`${row.transition_count} переходов за ${row.period}`}
                  />
                </td>
                <td style={tdRightStyle}>{row.transition_count}</td>
                <td style={tdRightStyle}>{row.instance_count}</td>
                {hasSums && (
                  <>
                    <td style={tdRightStyle}>
                      {row._sum != null ? row._sum.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : '—'}
                    </td>
                    <td style={tdRightStyle}>{row._records ?? '—'}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={exportRowStyle}>
        <span style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
          Экспорт для глубокого анализа:
        </span>
        <Button variant="ghost" size="sm" onClick={() => onExport('csv')} disabled={exportDisabled}>
          Скачать CSV
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onExport('xlsx')} disabled={exportDisabled}>
          Скачать XLSX
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TopActorsTable — топ исполнителей за последние 30 дней
// ---------------------------------------------------------------------------

/**
 * T-0648 (D-064, UX-study §3): the actor column used to render the raw
 * employee slug/UUID directly in a <td>. The backend
 * (src/http/operational-analytics.ts handleGet) now attaches `actorResolved`
 * (the T-0648 batch-resolved shape) to each top_actors row additively — this
 * carries it through the client-side dedupe/aggregation (first non-null wins;
 * every row for the same actor resolves identically) and renders through
 * ActorChip. Falls back to the raw slug (as both name and id) when
 * unresolved, same honest-degrade as the other T-0648 call sites.
 */
function TopActorsTable({ rows }) {
  const byActor = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const prev = m.get(r.actor);
      m.set(r.actor, {
        count: (prev?.count ?? 0) + r.count,
        actorResolved: prev?.actorResolved || r.actorResolved,
      });
    }
    return Array.from(m.entries())
      .map(([actor, v]) => ({ actor, count: v.count, actorResolved: v.actorResolved }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);
  }, [rows]);

  const maxCount = byActor.reduce((mx, r) => Math.max(mx, r.count), 0);

  if (byActor.length === 0) return null;

  return (
    <div style={sectionStyle} role="region" aria-label="Топ исполнителей">
      <div style={sectionHeadStyle}><span>Топ исполнителей (последние 30 дней)</span></div>
      <div style={{ overflowX: 'auto' }}>
        <table style={tableStyle} aria-label="Топ исполнителей">
          <thead>
            <tr>
              <th style={thStyle}>Исполнитель</th>
              <th style={thStyle}>Нагрузка</th>
              <th style={thRightStyle}>Действий</th>
            </tr>
          </thead>
          <tbody>
            {byActor.map((r) => (
              <tr key={r.actor}>
                <td style={tdStyle}>
                  <ActorChip
                    type={r.actorResolved?.type || 'human'}
                    name={r.actorResolved?.name || r.actor}
                    id={r.actorResolved?.id || r.actor}
                  />
                </td>
                <td style={tdStyle}>
                  <MiniBar value={r.count} max={maxCount} />
                </td>
                <td style={tdRightStyle}>{r.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// merge workload + record_sums by period
// ---------------------------------------------------------------------------

function mergeWorkloadSums(workload, recordSums) {
  if (!Array.isArray(recordSums) || recordSums.length === 0) return workload;
  const sumMap = new Map(recordSums.map((r) => [r.period, r]));
  return workload.map((w) => {
    const s = sumMap.get(w.period);
    return { ...w, _sum: s?.total ?? null, _records: s?.row_count ?? null };
  });
}

// ---------------------------------------------------------------------------
// OperationalAnalyticsScreen — root
// ---------------------------------------------------------------------------

const PERIOD_OPTIONS = [
  { value: 'day',   label: 'По дням (30 дней)' },
  { value: 'week',  label: 'По неделям (12 нед.)' },
  { value: 'month', label: 'По месяцам (12 мес.)' },
];

export default function OperationalAnalyticsScreen() {
  const [data, setData] = useState(null);    // null=loading, false=error, obj=ok
  const [errMsg, setErrMsg] = useState(null);
  const [period, setPeriod] = useState('day');
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setErrMsg(null);
    setData(null);
    try {
      const res = await fetch('/api/operational-analytics', { headers: authHeaders() });
      if (res.status === 401) { setErrMsg('Войдите в систему.'); setData(false); return; }
      if (res.status === 403) { setErrMsg('Нет прав на просмотр аналитики.'); setData(false); return; }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrMsg(`Ошибка HTTP ${res.status}${body.message ? ': ' + body.message : ''}`);
        setData(false);
        return;
      }
      setData(await res.json());
    } catch {
      setErrMsg('Сетевая ошибка.');
      setData(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleExport = useCallback(async (format) => {
    if (exporting) return;
    setExporting(true);
    try {
      const qs = new URLSearchParams({ format, period });
      const res = await fetch(`/api/operational-analytics/export?${qs}`, { headers: authHeaders() });
      if (!res.ok) { alert(`Ошибка экспорта: HTTP ${res.status}`); return; }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') ?? '';
      const match = cd.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : `operational-analytics-${period}.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, [exporting, period]);

  // Выбираем нужный набор строк по периоду
  const workloadMap = data ? {
    day: data.workload_daily ?? [],
    week: data.workload_weekly ?? [],
    month: data.workload_monthly ?? [],
  } : { day: [], week: [], month: [] };

  const rawRows = workloadMap[period] ?? [];
  const hasSums = data && Array.isArray(data.record_sums) && data.record_sums.length > 0;
  const rows = hasSums ? mergeWorkloadSums(rawRows, data.record_sums) : rawRows;

  const isEmpty = data && data !== false && (data.workload_daily ?? []).length === 0
    && (data.workload_weekly ?? []).length === 0
    && (data.workload_monthly ?? []).length === 0;

  const periodLabel = PERIOD_OPTIONS.find((o) => o.value === period)?.label ?? period;

  return (
    <div style={layoutStyle}>
      {/* Заголовок */}
      <div style={headerRowStyle}>
        <h1 style={h1Style}>Оперативная аналитика</h1>
        <Button variant="ghost" size="sm" onClick={load} disabled={data === null}>
          Обновить
        </Button>
      </div>

      <p style={descStyle}>
        Нагрузка по периодам (переходы процессов и инстанции).
        Агрегаты считает БД — браузер получает маленький результат.
        Для глубокого анализа используйте выгрузку.
      </p>

      {/* Выбор периода */}
      {data && data !== false && (
        <div style={controlsRowStyle}>
          <div style={{ minWidth: 220 }}>
            <Select
              label="Периодичность"
              options={PERIOD_OPTIONS}
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* Загрузка */}
      {data === null && <LoadingState label="Загрузка аналитики…" />}

      {/* Ошибка */}
      {data === false && (
        <ErrorState
          title="Не удалось загрузить аналитику"
          message={errMsg ?? ''}
          onRetry={load}
        />
      )}

      {/* Пусто */}
      {isEmpty && (
        <EmptyState
          title="Данных пока нет"
          description="Запустите процессы, чтобы увидеть аналитику по нагрузке."
        />
      )}

      {/* Данные */}
      {data && !isEmpty && (
        <>
          <WorkloadTable
            rows={rows}
            hasSums={hasSums}
            fieldKey={data.field_key ?? ''}
            title={`Нагрузка — ${periodLabel}`}
            onExport={handleExport}
            exportDisabled={exporting || data === null}
          />

          <TopActorsTable rows={data.top_actors ?? []} />
        </>
      )}
    </div>
  );
}
