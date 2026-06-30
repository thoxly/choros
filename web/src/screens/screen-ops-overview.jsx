/* ============================================================================
   CHOROS — screen-ops-overview.jsx  (T-0494)
   Операционный обзор: три независимые карточки-сигнала в одной панели.

   Паттерн best-effort: каждая карточка фетчит НЕЗАВИСИМО.
   Падение одной карточки — она показывает честную ошибку; остальные живут.

   ЖИВЫЕ контракты:
     GET /api/process-analytics → { bottleneck: string|null, cycleTime: { rows: [...] }, actorBreakdown: [...] }
     GET /api/spend → { windows: SpendByWindow[], byConnection: SpendByConnection[] }
       SpendByWindow: { window: 'day'|'month'|'total', currency, total_amount, total_tokens, row_count }
       SpendByConnection: { llm_connection_id, connection_name, provider, currency, total_amount, ... }
     GET /api/applications → { applications: [{ id, display_name, ... }] }
       (отчёты — карточка ведёт на /reports; счётчик app-level опционален)

   ДИЗАЙН: строго OBLIK — только --chs-* токены, kit-компоненты.
   Состояния (G4): Загрузка / Ошибка / Пусто / Данные — на каждой карточке.
   Кнопки (G3): только включённые, без мёртвых действий.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, LoadingState, ErrorState, EmptyState, Card } from '../components/components.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import { fmtDuration } from './screen-process-analytics.jsx';

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

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
  gap: 'var(--chs-space-6)',
};

const cardStyle = {
  background: 'var(--chs-color-surface)',
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-3)',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};

const cardHeadStyle = {
  padding: 'var(--chs-space-5) var(--chs-space-6)',
  borderBottom: '1px solid var(--chs-color-border)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const cardTitleStyle = {
  fontSize: 'var(--chs-text-base)',
  fontWeight: 'var(--chs-weight-semibold)',
  color: 'var(--chs-color-text)',
  margin: 0,
};

const cardBodyStyle = {
  padding: 'var(--chs-space-6)',
  flex: 1,
};

const cardFootStyle = {
  padding: 'var(--chs-space-4) var(--chs-space-6)',
  borderTop: '1px solid var(--chs-color-border)',
  display: 'flex',
  justifyContent: 'flex-end',
};

const metricRowStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--chs-space-4)',
};

const metricItemStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--chs-space-1)',
};

const metricLabelStyle = {
  fontSize: 'var(--chs-text-xs)',
  fontWeight: 'var(--chs-weight-semibold)',
  color: 'var(--chs-color-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const metricValueStyle = {
  fontSize: 'var(--chs-text-xl)',
  fontWeight: 'var(--chs-weight-bold)',
  color: 'var(--chs-color-text)',
  fontVariantNumeric: 'tabular-nums',
  lineHeight: 1.2,
};

const metricHintStyle = {
  fontSize: 'var(--chs-text-xs)',
  color: 'var(--chs-color-text-muted)',
};

const accentValueStyle = {
  ...metricValueStyle,
  fontSize: 'var(--chs-text-md)',
  color: 'var(--chs-color-accent)',
  maxWidth: 280,
  wordBreak: 'break-word',
};

const separatorStyle = {
  borderTop: '1px solid var(--chs-color-border)',
  margin: 'var(--chs-space-4) 0',
};

const miniListStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--chs-space-2)',
};

const miniRowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontSize: 'var(--chs-text-sm)',
  color: 'var(--chs-color-text)',
};

const miniLabelStyle = {
  fontSize: 'var(--chs-text-sm)',
  fontWeight: 'var(--chs-weight-regular)',
  color: 'var(--chs-color-text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: 160,
};

const miniValueStyle = {
  fontSize: 'var(--chs-text-sm)',
  fontWeight: 'var(--chs-weight-semibold)',
  color: 'var(--chs-color-text)',
  fontVariantNumeric: 'tabular-nums',
  flexShrink: 0,
  marginLeft: 'var(--chs-space-3)',
};

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Форматирует сумму с валютой.
 * @param {number|string|null|undefined} amount
 * @param {string} [currency]
 * @returns {string}
 */
export function fmtAmount(amount, currency) {
  if (amount == null) return '—';
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (!Number.isFinite(n)) return '—';
  const sym = currency === 'USD' ? '$' : (currency ? currency + ' ' : '');
  return `${sym}${n.toFixed(4)}`;
}

/**
 * Извлекает окно (day/month/total) из массива windows по ключу.
 * @param {Array<{window: string, currency: string, total_amount: number|string, total_tokens: number|string, row_count: number|string}>} windows
 * @param {'day'|'month'|'total'} key
 * @returns {{currency: string, total_amount: number, total_tokens: number, row_count: number}|null}
 */
export function extractWindow(windows, key) {
  if (!Array.isArray(windows)) return null;
  const w = windows.find((x) => x.window === key);
  if (!w) return null;
  return {
    currency: w.currency ?? 'USD',
    total_amount: Number(w.total_amount ?? 0),
    total_tokens: Number(w.total_tokens ?? 0),
    row_count: Number(w.row_count ?? 0),
  };
}

/**
 * Маппинг ошибки HTTP-статуса на человеческий русский текст.
 * @param {number} status
 * @param {string} domain — «процессов»/«расходов»/…
 * @param {{message?: string}|null} [body]
 * @returns {string}
 */
export function mapHttpError(status, domain, body) {
  if (status === 401) return `Войдите в систему для просмотра ${domain}.`;
  if (status === 403) return `Нет прав на просмотр ${domain}.`;
  const msg = body?.message;
  return `Ошибка HTTP ${status}${msg ? ': ' + msg : ''}`;
}

// ---------------------------------------------------------------------------
// Хук best-effort фетча одного эндпоинта
// ---------------------------------------------------------------------------

/**
 * Возвращает { data, errMsg, loading, reload }:
 *   data — null=загружается, false=ошибка, object=ок
 *   errMsg — текст ошибки (только когда data===false)
 *   loading — boolean
 *   reload — функция перезагрузки
 *
 * @param {string} url
 * @param {string} errorDomain — русское слово для ошибки («аналитики процессов»)
 */
export function useBestEffortFetch(url, errorDomain) {
  const [data, setData] = useState(null);
  const [errMsg, setErrMsg] = useState(null);

  const reload = useCallback(async () => {
    setErrMsg(null);
    setData(null);
    try {
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrMsg(mapHttpError(res.status, errorDomain, body));
        setData(false);
        return;
      }
      setData(await res.json());
    } catch {
      setErrMsg(`Сетевая ошибка при загрузке ${errorDomain}.`);
      setData(false);
    }
  }, [url, errorDomain]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, errMsg, loading: data === null, reload };
}

// ---------------------------------------------------------------------------
// ProcessCard — карточка «Пульс процессов»
// ---------------------------------------------------------------------------

function ProcessCard() {
  const navigate = useNavigate();
  const { data, errMsg, loading, reload } = useBestEffortFetch(
    '/api/process-analytics',
    'аналитики процессов',
  );

  const bottleneck = data && typeof data.bottleneck === 'string' ? data.bottleneck : null;
  const rows = data && data.cycleTime && Array.isArray(data.cycleTime.rows) ? data.cycleTime.rows : [];
  const isEmpty = data && data !== false && rows.length === 0;

  // Top-3 steps by avg_duration_ms for the mini-list
  const topRows = rows.slice(0, 3);

  // T-0547: Card kit-примитив (role=region + aria-labelledby автоматически)
  return (
    <Card
      title="Процессы"
      footer={
        <Button variant="ghost" size="sm" type="button" onClick={() => navigate('/process-analytics')}>
          Подробнее →
        </Button>
      }
    >
      {loading && <LoadingState label="Загрузка аналитики…" />}
      {data === false && (
        <ErrorState
          title="Не удалось загрузить аналитику"
          message={errMsg ?? ''}
          onRetry={reload}
        />
      )}
      {isEmpty && (
        <EmptyState
          title="Пока нет данных"
          description="Запустите процессы — аналитика появится после первых шагов."
        />
      )}
      {data && !isEmpty && (
        <div style={metricRowStyle}>
          <div style={metricItemStyle}>
            <span style={metricLabelStyle}>Узкое место</span>
            {bottleneck ? (
              <>
                <span style={accentValueStyle}>{bottleneck}</span>
                <span style={metricHintStyle}>самый долгий шаг</span>
              </>
            ) : (
              <span style={{ ...metricValueStyle, color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-md)' }}>—</span>
            )}
          </div>

          <div style={metricItemStyle}>
            <span style={metricLabelStyle}>Всего шагов</span>
            <span style={metricValueStyle}>{rows.length}</span>
            <span style={metricHintStyle}>уникальных активностей</span>
          </div>

          {topRows.length > 0 && (
            <>
              <div style={separatorStyle} />
              <div style={metricItemStyle}>
                <span style={metricLabelStyle}>Топ шаги (ср. время)</span>
                <div style={miniListStyle}>
                  {topRows.map((r) => (
                    <div key={r.activity} style={miniRowStyle}>
                      <span style={miniLabelStyle} title={r.activity}>{r.activity}</span>
                      <span style={miniValueStyle}>{fmtDuration(r.avg_duration_ms)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SpendCard — карточка «Расход LLM»
// ---------------------------------------------------------------------------

const WINDOW_LABELS = {
  day: 'За 24 часа',
  month: 'За 30 дней',
  total: 'Всего',
};

function SpendCard() {
  const navigate = useNavigate();
  const { data, errMsg, loading, reload } = useBestEffortFetch(
    '/api/spend',
    'расхода LLM',
  );

  const windows = data && Array.isArray(data.windows) ? data.windows : [];
  const byConnection = data && Array.isArray(data.byConnection) ? data.byConnection : [];
  const isEmpty = data && data !== false && windows.length === 0 && byConnection.length === 0;

  const dayW = extractWindow(windows, 'day');
  const monthW = extractWindow(windows, 'month');
  const totalW = extractWindow(windows, 'total');

  // Top-2 connections by total_amount
  const topConns = [...byConnection]
    .sort((a, b) => Number(b.total_amount ?? 0) - Number(a.total_amount ?? 0))
    .slice(0, 2);

  // T-0547: Card kit-примитив
  return (
    <Card
      title="Расход LLM"
      footer={
        <Button variant="ghost" size="sm" type="button" onClick={() => navigate('/spend')}>
          Подробнее →
        </Button>
      }
    >
      {loading && <LoadingState label="Загрузка расхода…" />}
      {data === false && (
        <ErrorState
          title="Не удалось загрузить расход"
          message={errMsg ?? ''}
          onRetry={reload}
        />
      )}
      {isEmpty && (
        <EmptyState
          title="Расходов пока нет"
          description="LLM-вызовы ещё не совершались или не настроены цены на соединениях."
        />
      )}
      {data && !isEmpty && (
        <div style={metricRowStyle}>
          {/* Three time windows */}
          <div style={{ display: 'flex', gap: 'var(--chs-space-6)', flexWrap: 'wrap' }}>
            {[
              { key: 'day', w: dayW },
              { key: 'month', w: monthW },
              { key: 'total', w: totalW },
            ].map(({ key, w }) => (
              <div key={key} style={metricItemStyle}>
                <span style={metricLabelStyle}>{WINDOW_LABELS[key]}</span>
                <span style={metricValueStyle}>
                  {w ? fmtAmount(w.total_amount, w.currency) : '—'}
                </span>
                {w && (
                  <span style={metricHintStyle}>
                    {Number(w.total_tokens ?? 0).toLocaleString('ru-RU')} токенов
                  </span>
                )}
              </div>
            ))}
          </div>

          {topConns.length > 0 && (
            <>
              <div style={separatorStyle} />
              <div style={metricItemStyle}>
                <span style={metricLabelStyle}>По соединениям</span>
                <div style={miniListStyle}>
                  {topConns.map((c, i) => (
                    <div key={c.llm_connection_id ?? c.connection_name ?? `unknown-${i}`} style={miniRowStyle}>
                      <span style={miniLabelStyle} title={c.connection_name ?? 'Без имени'}>
                        {c.connection_name ?? 'Без имени'}
                      </span>
                      <span style={miniValueStyle}>
                        {fmtAmount(c.total_amount, c.currency)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ReportsCard — карточка «Отчёты»
// Мы не делаем двойной фетч (apps → report-pages per app), это переусложнение.
// Показываем число приложений (из /api/applications, дёшево) + ссылку на /reports.
// ---------------------------------------------------------------------------

function ReportsCard() {
  const navigate = useNavigate();
  const { data, errMsg, loading, reload } = useBestEffortFetch(
    '/api/applications',
    'списка приложений',
  );

  const apps = data && Array.isArray(data.applications) ? data.applications : [];
  const isEmpty = data && data !== false && apps.length === 0;

  // T-0547: Card kit-примитив
  return (
    <Card
      title="Отчёты"
      footer={
        <Button variant="ghost" size="sm" type="button" onClick={() => navigate('/reports')}>
          Перейти к отчётам →
        </Button>
      }
    >
      {loading && <LoadingState label="Загрузка данных…" />}
      {data === false && (
        <ErrorState
          title="Не удалось загрузить список приложений"
          message={errMsg ?? ''}
          onRetry={reload}
        />
      )}
      {isEmpty && (
        <EmptyState
          title="Приложения не найдены"
          description="Создайте приложение в разделе Конструктор, чтобы строить отчёты."
        />
      )}
      {data && !isEmpty && (
        <div style={metricRowStyle}>
          <div style={metricItemStyle}>
            <span style={metricLabelStyle}>Приложений</span>
            <span style={metricValueStyle}>{apps.length}</span>
            <span style={metricHintStyle}>доступных для построения отчётов</span>
          </div>

          {apps.length > 0 && (
            <>
              <div style={separatorStyle} />
              <div style={metricItemStyle}>
                <span style={metricLabelStyle}>Последние</span>
                <div style={miniListStyle}>
                  {apps.slice(0, 3).map((a) => (
                    <div key={a.id} style={miniRowStyle}>
                      <span style={miniLabelStyle} title={a.display_name}>
                        {a.display_name}
                      </span>
                    </div>
                  ))}
                  {apps.length > 3 && (
                    <span style={metricHintStyle}>и ещё {apps.length - 3}…</span>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// OpsOverviewScreen — корневой компонент
// ---------------------------------------------------------------------------

export default function OpsOverviewScreen() {
  const [reloadKey, setReloadKey] = useState(0);

  // Incrementing reloadKey causes child cards to re-mount, triggering their useEffect.
  // Each card manages its own fetch independently.
  const reloadAll = useCallback(() => setReloadKey((k) => k + 1), []);

  return (
    <div style={layoutStyle}>
      {/* Заголовок */}
      <div style={headerRowStyle}>
        <h1 style={h1Style}>Операционный обзор</h1>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={reloadAll}
        >
          Обновить
        </Button>
      </div>

      <p style={descStyle}>
        Три операционных сигнала в одном месте: пульс процессов, расход LLM и доступные отчёты.
        Каждый блок загружается независимо — ошибка одного не мешает остальным.
      </p>

      {/* Three best-effort cards */}
      <div style={gridStyle} key={reloadKey}>
        <ProcessCard />
        <SpendCard />
        <ReportsCard />
      </div>
    </div>
  );
}
