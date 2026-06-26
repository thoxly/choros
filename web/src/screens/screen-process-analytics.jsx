/* ============================================================================
   CHOROS — screen-process-analytics.jsx  (T-0493)
   Аналитика процессов: цикл-тайм по шагам + нагрузка по исполнителям.

   ЖИВОЙ контракт:
     GET /api/process-analytics  (требует авторизацию; тенант резолвится с сервера)
     Ответ:
       {
         bottleneck: string | null,       // имя активности с макс. средним временем
         cycleTime: {
           bottleneck: string | null,
           rows: ActivityCycleTime[]      // сортированы по avg_duration_ms DESC (nulls last)
         },
         actorBreakdown: ActorTypeBreakdown[]
       }

     ActivityCycleTime: { activity, avg_duration_ms: number|null, count, human_count, agent_count, service_count }
     ActorTypeBreakdown: { activity, actor_type, count }

   ДИЗАЙН: строго OBLIK — только --chs-* токены, kit-компоненты.
   Состояния (G4): Загрузка / Ошибка / Пусто / Данные.
   Кнопки (G3): только включённые, без мёртвых действий.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, Select, LoadingState, ErrorState, EmptyState } from '../components/components.jsx';
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
  margin: '0 0 var(--chs-space-6) 0',
};

// T-0495: селектор процесса (дрилл-даун)
const selectorRowStyle = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 'var(--chs-space-4)',
  marginBottom: 'var(--chs-space-6)',
  maxWidth: 420,
};

const selectorWrapStyle = {
  flex: 1,
  minWidth: 0,
};

const selectorEmptyHintStyle = {
  fontSize: 'var(--chs-text-xs)',
  color: 'var(--chs-color-text-muted)',
  marginBottom: 'var(--chs-space-6)',
};

const summaryCardStyle = {
  background: 'var(--chs-color-surface)',
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-3)',
  padding: 'var(--chs-space-7)',
  marginBottom: 'var(--chs-space-7)',
  display: 'flex',
  gap: 'var(--chs-space-9)',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
};

const summaryItemStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--chs-space-2)',
};

const summaryLabelStyle = {
  fontSize: 'var(--chs-text-xs)',
  fontWeight: 'var(--chs-weight-semibold)',
  color: 'var(--chs-color-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const summaryValueStyle = {
  fontSize: 'var(--chs-text-xl)',
  fontWeight: 'var(--chs-weight-bold)',
  color: 'var(--chs-color-text)',
  fontVariantNumeric: 'tabular-nums',
  lineHeight: 1.15,
};

const summaryHintStyle = {
  fontSize: 'var(--chs-text-xs)',
  color: 'var(--chs-color-text-muted)',
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
};

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 'var(--chs-text-sm)',
};

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

const thRightStyle = {
  ...thStyle,
  textAlign: 'right',
};

const tdStyle = {
  padding: 'var(--chs-space-3) var(--chs-space-7)',
  color: 'var(--chs-color-text)',
  borderBottom: '1px solid var(--chs-color-border)',
  verticalAlign: 'middle',
};

const tdRightStyle = {
  ...tdStyle,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
};

const actorGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: 'var(--chs-space-5)',
  padding: 'var(--chs-space-7)',
};

const actorCardStyle = {
  background: 'var(--chs-color-surface-raised)',
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-3)',
  padding: 'var(--chs-space-5)',
};

const actorLabelStyle = {
  fontSize: 'var(--chs-text-xs)',
  color: 'var(--chs-color-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 'var(--chs-space-2)',
};

const actorCountStyle = {
  fontSize: 'var(--chs-text-xl)',
  fontWeight: 'var(--chs-weight-bold)',
  color: 'var(--chs-color-text)',
  fontVariantNumeric: 'tabular-nums',
};

const actorHintStyle = {
  fontSize: 'var(--chs-text-xs)',
  color: 'var(--chs-color-text-muted)',
  marginTop: 'var(--chs-space-1)',
};

// ---------------------------------------------------------------------------
// Форматтер длительности: мс → человекочитаемый вид
// ---------------------------------------------------------------------------

/**
 * Форматирует миллисекунды в читаемую строку.
 * @param {number|null} ms
 * @returns {string}
 */
export function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} мс`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1).replace(/\.0$/, '')} с`;
  const mins = secs / 60;
  if (mins < 60) return `${mins.toFixed(1).replace(/\.0$/, '')} мин`;
  const hours = mins / 60;
  if (hours < 24) return `${hours.toFixed(1).replace(/\.0$/, '')} ч`;
  const days = hours / 24;
  return `${days.toFixed(1).replace(/\.0$/, '')} дн`;
}

// ---------------------------------------------------------------------------
// Метка типа исполнителя: actor_type → русский
// ---------------------------------------------------------------------------

const ACTOR_TYPE_LABELS = {
  human: 'Человек',
  agent: 'Агент',
  service: 'Сервис',
};

/**
 * Возвращает человекочитаемую метку для actor_type.
 * @param {string} actorType
 * @returns {string}
 */
export function fmtActorType(actorType) {
  return ACTOR_TYPE_LABELS[actorType] ?? actorType;
}

// ---------------------------------------------------------------------------
// Бар: горизонтальный прогресс-бар для avg_duration (CSS, без SVG-либ)
// ---------------------------------------------------------------------------

function DurationBar({ value, max }) {
  if (!value || !max || max === 0) return null;
  const pct = Math.max(2, Math.round((value / max) * 100));
  return (
    <div
      style={{
        display: 'inline-block',
        width: 80,
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
// BottleneckCard — сводка вверху экрана
// ---------------------------------------------------------------------------

function BottleneckCard({ bottleneck, totalActivities }) {
  return (
    <div style={summaryCardStyle} role="region" aria-label="Сводка аналитики">
      {/* Узкое место */}
      <div style={summaryItemStyle}>
        <span style={summaryLabelStyle}>Узкое место</span>
        {bottleneck ? (
          <>
            <span
              style={{
                ...summaryValueStyle,
                fontSize: 'var(--chs-text-md)',
                color: 'var(--chs-color-accent)',
                maxWidth: 320,
                wordBreak: 'break-word',
              }}
            >
              {bottleneck}
            </span>
            <span style={summaryHintStyle}>самый долгий шаг</span>
          </>
        ) : (
          <>
            <span style={{ ...summaryValueStyle, fontSize: 'var(--chs-text-md)', color: 'var(--chs-color-text-muted)' }}>
              —
            </span>
            <span style={summaryHintStyle}>данных пока нет</span>
          </>
        )}
      </div>

      {/* Всего шагов */}
      <div style={summaryItemStyle}>
        <span style={summaryLabelStyle}>Всего шагов</span>
        <span style={summaryValueStyle}>{totalActivities}</span>
        <span style={summaryHintStyle}>уникальных активностей</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CycleTimeTable — таблица цикл-тайма по активностям
// ---------------------------------------------------------------------------

function CycleTimeTable({ rows, bottleneck }) {
  if (!rows || rows.length === 0) return null;

  const maxDuration = rows.reduce(
    (mx, r) => (r.avg_duration_ms != null && r.avg_duration_ms > mx ? r.avg_duration_ms : mx),
    0,
  );

  return (
    <div style={sectionStyle} role="region" aria-label="Цикл-тайм по шагам">
      <div style={sectionHeadStyle}>Среднее время шага</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={tableStyle} aria-label="Цикл-тайм по шагам">
          <thead>
            <tr>
              <th style={thStyle}>Шаг (активность)</th>
              <th style={thStyle}>Среднее время шага</th>
              <th style={thRightStyle}>Всего</th>
              <th style={thRightStyle}>Человек</th>
              <th style={thRightStyle}>Агент</th>
              <th style={thRightStyle}>Сервис</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isBottleneck = row.activity === bottleneck;
              const rowStyle = isBottleneck
                ? {
                    background: 'var(--chs-color-accent-soft)',
                    borderLeft: '3px solid var(--chs-color-accent)',
                  }
                : {};

              return (
                <tr key={row.activity} style={rowStyle} aria-current={isBottleneck ? 'true' : undefined}>
                  <td style={{ ...tdStyle, ...(isBottleneck ? { paddingLeft: 'calc(var(--chs-space-7) - 3px)' } : {}) }}>
                    <span
                      style={{
                        fontWeight: isBottleneck ? 'var(--chs-weight-semibold)' : 'var(--chs-weight-regular)',
                        color: isBottleneck ? 'var(--chs-color-accent)' : 'var(--chs-color-text)',
                      }}
                    >
                      {row.activity}
                    </span>
                    {isBottleneck && (
                      <span
                        style={{
                          marginLeft: 'var(--chs-space-3)',
                          fontSize: 'var(--chs-text-xs)',
                          color: 'var(--chs-color-accent)',
                          fontWeight: 'var(--chs-weight-semibold)',
                          background: 'var(--chs-color-accent-soft)',
                          padding: '1px 6px',
                          borderRadius: 'var(--chs-radius-full)',
                          border: '1px solid var(--chs-color-accent-border)',
                        }}
                        aria-label="Узкое место"
                        title="Самый долгий шаг"
                      >
                        узкое место
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <DurationBar value={row.avg_duration_ms} max={maxDuration} />
                    <span style={{ color: isBottleneck ? 'var(--chs-color-accent)' : 'var(--chs-color-text)' }}>
                      {fmtDuration(row.avg_duration_ms)}
                    </span>
                  </td>
                  <td style={tdRightStyle}>{row.count}</td>
                  <td style={tdRightStyle}>{row.human_count}</td>
                  <td style={tdRightStyle}>{row.agent_count}</td>
                  <td style={tdRightStyle}>{row.service_count}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActorBreakdownPanel — нагрузка по исполнителям
// ---------------------------------------------------------------------------

/**
 * Агрегирует actorBreakdown (массив { activity, actor_type, count }) по actor_type:
 * суммирует count для каждого типа.
 * @param {Array<{activity: string, actor_type: string, count: number}>} breakdown
 * @returns {{human: number, agent: number, service: number, other: number}}
 */
export function aggregateActorBreakdown(breakdown) {
  const totals = { human: 0, agent: 0, service: 0, other: 0 };
  for (const row of breakdown) {
    const key = row.actor_type in totals ? row.actor_type : 'other';
    totals[key] += row.count;
  }
  return totals;
}

function ActorBreakdownPanel({ breakdown }) {
  if (!breakdown || breakdown.length === 0) return null;

  const totals = aggregateActorBreakdown(breakdown);
  const total = totals.human + totals.agent + totals.service + totals.other;

  function pct(n) {
    if (!total) return '0%';
    return `${Math.round((n / total) * 100)}%`;
  }

  const cards = [
    { key: 'human',   label: 'Человек',  count: totals.human,   hint: 'шагов закрыто людьми' },
    { key: 'agent',   label: 'Агент',    count: totals.agent,   hint: 'шагов закрыто агентами' },
    { key: 'service', label: 'Сервис',   count: totals.service, hint: 'шагов закрыто сервисами' },
  ].filter((c) => c.count > 0);

  if (cards.length === 0) {
    cards.push({ key: 'unknown', label: 'Другое', count: totals.other, hint: 'шагов' });
  }

  return (
    <div style={sectionStyle} role="region" aria-label="Нагрузка по исполнителям">
      <div style={sectionHeadStyle}>Нагрузка по исполнителям</div>
      <div style={actorGridStyle}>
        {cards.map((c) => (
          <div key={c.key} style={actorCardStyle}>
            <div style={actorLabelStyle}>{c.label}</div>
            <div style={actorCountStyle}>{c.count}</div>
            <div style={actorHintStyle}>
              {pct(c.count)} · {c.hint}
            </div>
          </div>
        ))}
        {/* Итого */}
        <div style={{ ...actorCardStyle, borderColor: 'var(--chs-color-border-strong)' }}>
          <div style={actorLabelStyle}>Итого</div>
          <div style={actorCountStyle}>{total}</div>
          <div style={actorHintStyle}>событий в журнале</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProcessAnalyticsScreen — корневой компонент
// ---------------------------------------------------------------------------

// Значение «все процессы» в селекторе (пустая строка → без параметра запроса).
export const ALL_PROCESSES = '';

export default function ProcessAnalyticsScreen() {
  const [data, setData] = useState(null);   // null=loading, false=error, obj=ok
  const [errMsg, setErrMsg] = useState(null);
  // T-0495: выбранный процесс для дрилл-дауна ('' = все процессы).
  const [selected, setSelected] = useState(ALL_PROCESSES);
  // Список доступных процессов из последнего успешного ответа (для селектора).
  const [processKeys, setProcessKeys] = useState([]);

  // load(processKey): '' / undefined → без фильтра (все процессы).
  const load = useCallback(async (processKey) => {
    setErrMsg(null);
    setData(null);
    const qs = processKey ? `?process_key=${encodeURIComponent(processKey)}` : '';
    try {
      const res = await fetch(`/api/process-analytics${qs}`, { headers: authHeaders() });
      if (res.status === 401) {
        setErrMsg('Войдите в систему для просмотра аналитики процессов.');
        setData(false);
        return;
      }
      if (res.status === 403) {
        setErrMsg('Нет прав на просмотр аналитики процессов.');
        setData(false);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrMsg(
          `Ошибка HTTP ${res.status}${body.message ? ': ' + body.message : ''}`,
        );
        setData(false);
        return;
      }
      const json = await res.json();
      // Список процессов берём из ответа (самосогласован с данными).
      if (Array.isArray(json.processKeys)) setProcessKeys(json.processKeys);
      setData(json);
    } catch {
      setErrMsg('Сетевая ошибка при загрузке аналитики процессов.');
      setData(false);
    }
  }, []);

  // Первичная загрузка — все процессы.
  useEffect(() => {
    load(ALL_PROCESSES);
  }, [load]);

  // Смена процесса в селекторе → рефетч с фильтром (или без — для «Все процессы»).
  const onSelectProcess = useCallback((e) => {
    const next = e.target.value;
    setSelected(next);
    load(next);
  }, [load]);

  // Извлекаем поля из ответа (безопасно)
  const bottleneck = data && typeof data.bottleneck === 'string' ? data.bottleneck : null;
  const rows = data && data.cycleTime && Array.isArray(data.cycleTime.rows) ? data.cycleTime.rows : [];
  const actorBreakdown = data && Array.isArray(data.actorBreakdown) ? data.actorBreakdown : [];

  // «Пусто» — ответ пришёл, но нет ни шагов, ни событий исполнителей
  const isEmpty = data && data !== false && rows.length === 0 && actorBreakdown.length === 0;

  // Заголовок отражает выбранный процесс (человеческий язык).
  const titleSuffix = selected ? `: ${selected}` : '';
  const scopeLabel = selected ? selected : 'Все процессы';

  // Опции селектора: «Все процессы» + список из ответа.
  const selectOptions = [
    { value: ALL_PROCESSES, label: 'Все процессы' },
    ...processKeys.map((k) => ({ value: k, label: k })),
  ];
  const hasProcesses = processKeys.length > 0;

  return (
    <div style={layoutStyle}>
      {/* Заголовок */}
      <div style={headerRowStyle}>
        <h1 style={h1Style}>Аналитика процессов{titleSuffix}</h1>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => load(selected)}
          disabled={data === null}
        >
          Обновить
        </Button>
      </div>

      <p style={descStyle}>
        Цикл-тайм по шагам процессов и нагрузка по типам исполнителей.
        Сейчас показано: <strong>{scopeLabel}</strong>.
        Данные накапливаются из журнала переходов по мере выполнения задач.
      </p>

      {/* T-0495: селектор процесса. Показываем только когда есть из чего выбирать. */}
      {hasProcesses ? (
        <div style={selectorRowStyle}>
          <div style={selectorWrapStyle}>
            <Select
              label="Процесс"
              options={selectOptions}
              value={selected}
              onChange={onSelectProcess}
              disabled={data === null}
              hint="Выберите процесс, чтобы посмотреть его узкое место и шаги."
            />
          </div>
        </div>
      ) : (
        data && data !== false && (
          <p style={selectorEmptyHintStyle}>
            Пока нет процессов с данными для фильтрации — показаны все.
          </p>
        )
      )}

      {/* Загрузка */}
      {data === null && <LoadingState label="Загрузка аналитики…" />}

      {/* Ошибка */}
      {data === false && (
        <ErrorState
          title="Не удалось загрузить аналитику"
          message={errMsg ?? ''}
          onRetry={() => load(selected)}
        />
      )}

      {/* Пусто */}
      {isEmpty && (
        <EmptyState
          title={selected ? `Нет данных по процессу «${selected}»` : 'Аналитика пока недоступна'}
          description={
            selected
              ? 'По выбранному процессу пока нет выполненных шагов. Выберите «Все процессы» или запустите этот процесс.'
              : 'Запустите процессы, чтобы увидеть аналитику. Данные появятся после первых выполненных шагов.'
          }
        />
      )}

      {/* Данные */}
      {data && !isEmpty && (
        <>
          {/* Сводка: узкое место + всего активностей */}
          <BottleneckCard
            bottleneck={bottleneck}
            totalActivities={rows.length}
          />

          {/* Таблица цикл-тайма */}
          <CycleTimeTable rows={rows} bottleneck={bottleneck} />

          {/* Нагрузка по исполнителям */}
          <ActorBreakdownPanel breakdown={actorBreakdown} />
        </>
      )}
    </div>
  );
}
