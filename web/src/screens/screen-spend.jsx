/* ============================================================================
   CHOROS — screen-spend.jsx  (T-0477, E-AGENTS L5)
   Расход: read-only экран учёта стоимости LLM-вызовов.

   Агрегаты из spend_ledger по окнам (день/месяц/всего) и по соединениям.
   Таблица последних вызовов с токенами и суммами.

   НЕ СЕЙЧАС (Stage-2): жёсткие потолки/лимиты/отсечка — только учёт + показ.

   ЖИВЫЕ контракты:
     GET  /api/spend         — окна + по-соединениям агрегаты
     GET  /api/spend/recent  — последние N строк (default 50)

   ДИЗАЙН: строго OBLIK — только --chs-* токены, kit-компоненты.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, LoadingState, ErrorState, EmptyState } from '../components/components.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';

// ---------------------------------------------------------------------------
// Token-only styles (OBLIK: --chs-* only)
// ---------------------------------------------------------------------------
const sectionStyle = {
  background: 'var(--chs-color-surface)',
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-3)',
  padding: 'var(--chs-space-7)',
  marginBottom: 'var(--chs-space-7)',
};
const headingStyle = {
  fontSize: 'var(--chs-text-base)',
  fontWeight: 'var(--chs-weight-semibold)',
  color: 'var(--chs-color-text)',
  margin: '0 0 var(--chs-space-4) 0',
};
const descStyle = {
  fontSize: 'var(--chs-text-sm)',
  color: 'var(--chs-color-text-muted)',
  margin: '0 0 var(--chs-space-6) 0',
};
const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 'var(--chs-text-sm)',
};
const thStyle = {
  textAlign: 'left',
  padding: 'var(--chs-space-3) var(--chs-space-4)',
  borderBottom: '2px solid var(--chs-color-border)',
  color: 'var(--chs-color-text-muted)',
  fontWeight: 'var(--chs-weight-semibold)',
  fontSize: 'var(--chs-text-xs)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};
const tdStyle = {
  padding: 'var(--chs-space-3) var(--chs-space-4)',
  borderBottom: '1px solid var(--chs-color-border)',
  color: 'var(--chs-color-text)',
  verticalAlign: 'top',
};
const monoStyle = {
  fontFamily: 'var(--chs-font-mono, monospace)',
  fontSize: 'var(--chs-text-xs)',
  background: 'var(--chs-color-surface-raised)',
  padding: '1px 5px',
  borderRadius: 'var(--chs-radius-2)',
};
const windowGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 'var(--chs-space-5)',
  marginBottom: 'var(--chs-space-6)',
};
const windowCardStyle = {
  background: 'var(--chs-color-surface-raised)',
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-3)',
  padding: 'var(--chs-space-5) var(--chs-space-6)',
};
const windowLabelStyle = {
  fontSize: 'var(--chs-text-xs)',
  color: 'var(--chs-color-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 'var(--chs-space-2)',
};
const windowAmountStyle = {
  fontSize: 'var(--chs-text-xl)',
  fontWeight: 'var(--chs-weight-bold)',
  color: 'var(--chs-color-text)',
  fontVariantNumeric: 'tabular-nums',
};
const windowSubStyle = {
  fontSize: 'var(--chs-text-xs)',
  color: 'var(--chs-color-text-muted)',
  marginTop: 'var(--chs-space-1)',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtAmount(amount, currency) {
  if (amount == null) return '—';
  const sym = currency === 'USD' ? '$' : currency + ' ';
  return `${sym}${amount.toFixed(4)}`;
}

function fmtTokens(n) {
  if (n == null || n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const WINDOW_LABELS = { day: 'За 24 часа', month: 'За 30 дней', total: 'Всего' };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function SpendScreen() {
  const [overview, setOverview] = useState(null); // null=loading, false=error, {}=loaded
  const [overviewErr, setOverviewErr] = useState(null);
  const [recent, setRecent] = useState(null);
  const [recentErr, setRecentErr] = useState(null);

  // -------------------------------------------------------------------------
  // Load overview (windows + by-connection)
  // -------------------------------------------------------------------------
  const loadOverview = useCallback(async () => {
    setOverviewErr(null);
    setOverview(null);
    try {
      const res = await fetch('/api/spend', { headers: authHeaders() });
      if (res.status === 401) { setOverviewErr('Войдите в систему.'); setOverview(false); return; }
      if (!res.ok) { setOverviewErr(`Ошибка HTTP ${res.status}`); setOverview(false); return; }
      setOverview(await res.json());
    } catch {
      setOverviewErr('Сетевая ошибка.');
      setOverview(false);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Load recent rows
  // -------------------------------------------------------------------------
  const loadRecent = useCallback(async () => {
    setRecentErr(null);
    setRecent(null);
    try {
      const res = await fetch('/api/spend/recent?limit=50', { headers: authHeaders() });
      if (res.status === 401) { setRecentErr('Войдите в систему.'); setRecent(false); return; }
      if (!res.ok) { setRecentErr(`Ошибка HTTP ${res.status}`); setRecent(false); return; }
      const data = await res.json();
      setRecent(Array.isArray(data.rows) ? data.rows : []);
    } catch {
      setRecentErr('Сетевая ошибка.');
      setRecent(false);
    }
  }, []);

  useEffect(() => {
    loadOverview();
    loadRecent();
  }, [loadOverview, loadRecent]);

  // Derive window map from array (key by window name)
  const windowMap = {};
  if (overview && Array.isArray(overview.windows)) {
    for (const w of overview.windows) windowMap[w.window] = w;
  }

  const byConnection = overview && Array.isArray(overview.byConnection)
    ? overview.byConnection : [];

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div style={{ maxWidth: 940, margin: '0 auto', padding: 'var(--chs-space-7)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--chs-space-6)' }}>
        <h1 style={{ fontSize: 'var(--chs-text-lg)', fontWeight: 'var(--chs-weight-bold)', color: 'var(--chs-color-text)', margin: 0 }}>
          Расход LLM
        </h1>
        <Button variant="ghost" size="sm" type="button" onClick={() => { loadOverview(); loadRecent(); }}>
          Обновить
        </Button>
      </div>

      <p style={{ ...descStyle, marginBottom: 'var(--chs-space-7)' }}>
        Учёт стоимости LLM-вызовов (только наблюдение — без лимитов и отсечки).
        Суммы рассчитываются из цен, заданных на соединениях.
      </p>

      {/* ── Окна суммарного расхода ──────────────────────────────────────── */}
      <div style={sectionStyle}>
        <h2 style={headingStyle}>Сводка по периодам</h2>

        {overview === null && <LoadingState label="Загрузка…" />}
        {overview === false && (
          <ErrorState title="Ошибка загрузки" message={overviewErr ?? ''} onRetry={loadOverview} />
        )}

        {overview && (
          <div style={windowGridStyle}>
            {['day', 'month', 'total'].map((win) => {
              const d = windowMap[win];
              return (
                <div key={win} style={windowCardStyle}>
                  <div style={windowLabelStyle}>{WINDOW_LABELS[win]}</div>
                  <div style={windowAmountStyle}>
                    {d ? fmtAmount(d.total_amount, d.currency) : '$0.0000'}
                  </div>
                  <div style={windowSubStyle}>
                    {d ? `${fmtTokens(d.total_tokens)} токенов · ${d.row_count} вызовов` : '— вызовов нет'}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Расход по соединениям ────────────────────────────────────────── */}
      <div style={sectionStyle}>
        <h2 style={headingStyle}>По соединениям</h2>
        {overview === null && <LoadingState label="Загрузка…" />}
        {overview === false && (
          <ErrorState title="Ошибка загрузки" message={overviewErr ?? ''} onRetry={loadOverview} />
        )}
        {overview && byConnection.length === 0 && (
          <EmptyState
            title="Нет данных о расходах"
            message="Расходы появятся после LLM-вызовов с настроенными ценами."
          />
        )}
        {overview && byConnection.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Соединение</th>
                  <th style={thStyle}>Провайдер</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Токены</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Вызовов</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Сумма</th>
                </tr>
              </thead>
              <tbody>
                {byConnection.map((c, i) => (
                  <tr key={c.llm_connection_id ?? `noconn-${i}`}>
                    <td style={tdStyle}>{c.connection_name ?? <span style={{ color: 'var(--chs-color-text-muted)' }}>—</span>}</td>
                    <td style={tdStyle}>
                      {c.provider ? <span style={monoStyle}>{c.provider}</span> : '—'}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {fmtTokens(c.total_tokens)}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {c.row_count}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {fmtAmount(c.total_amount, c.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Последние вызовы ─────────────────────────────────────────────── */}
      <div style={sectionStyle}>
        <h2 style={headingStyle}>Последние вызовы</h2>
        <p style={descStyle}>Последние 50 записей из журнала расходов.</p>

        {recent === null && <LoadingState label="Загрузка…" />}
        {recent === false && (
          <ErrorState title="Ошибка загрузки" message={recentErr ?? ''} onRetry={loadRecent} />
        )}
        {Array.isArray(recent) && recent.length === 0 && (
          <EmptyState
            title="Нет записей о расходах"
            message="Записи появятся после LLM-вызовов с настроенными ценами."
          />
        )}
        {Array.isArray(recent) && recent.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Время</th>
                  <th style={thStyle}>Соединение</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Вх</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Исх</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Итого</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Сумма</th>
                  <th style={thStyle}>Контекст</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                      {fmtTime(r.recorded_at)}
                    </td>
                    <td style={tdStyle}>
                      {r.connection_name ?? <span style={{ color: 'var(--chs-color-text-muted)' }}>—</span>}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--chs-color-text-muted)' }}>
                      {r.prompt_tokens != null ? fmtTokens(r.prompt_tokens) : '—'}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--chs-color-text-muted)' }}>
                      {r.completion_tokens != null ? fmtTokens(r.completion_tokens) : '—'}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {r.total_tokens != null ? fmtTokens(r.total_tokens) : '—'}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {fmtAmount(r.amount, r.currency)}
                    </td>
                    <td style={{ ...tdStyle, fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.description ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
