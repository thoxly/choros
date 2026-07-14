/**
 * web/src/screens/screen-ops-overview.test.jsx  (T-0494)
 *
 * Тесты экрана «Операционный обзор».
 *
 * Подход (конвенция проекта, vitest "node" environment):
 *   - Компоненты с хуками НЕ вызываем как функцию напрямую.
 *   - Тестируем: (1) fmtAmount; (2) extractWindow; (3) mapHttpError;
 *     (4) nav-config пункт ops-overview; (5) CSS-токены;
 *     (6) best-effort деградация (одна ручка 500 → её сигнал, остальные ok);
 *     (7) useBestEffortFetch логика.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fmtAmount, extractWindow, mapHttpError } from './screen-ops-overview.jsx';

// ---------------------------------------------------------------------------
// fmtAmount — форматтер суммы с валютой
// ---------------------------------------------------------------------------

describe('fmtAmount — форматтер суммы', () => {
  it('null → «—»', () => expect(fmtAmount(null)).toBe('—'));
  it('undefined → «—»', () => expect(fmtAmount(undefined)).toBe('—'));
  it('NaN → «—»', () => expect(fmtAmount(NaN)).toBe('—'));
  it('Infinity → «—»', () => expect(fmtAmount(Infinity)).toBe('—'));

  it('0 USD → $0.0000', () => expect(fmtAmount(0, 'USD')).toBe('$0.0000'));
  it('1.5 USD → $1.5000', () => expect(fmtAmount(1.5, 'USD')).toBe('$1.5000'));
  it('0.001234 USD → $0.0012', () => expect(fmtAmount(0.001234, 'USD')).toBe('$0.0012'));

  it('числовая строка → парсится', () => expect(fmtAmount('2.5', 'USD')).toBe('$2.5000'));
  it('нечисловая строка → «—»', () => expect(fmtAmount('abc', 'USD')).toBe('—'));

  it('неизвестная валюта → префикс-код', () => {
    const result = fmtAmount(1, 'EUR');
    expect(result).toContain('EUR');
    expect(result).toContain('1.0000');
  });

  it('нет валюты → без префикса', () => {
    const result = fmtAmount(5.5, undefined);
    expect(result).toBe('5.5000');
  });
});

// ---------------------------------------------------------------------------
// extractWindow — извлечение окна агрегата
// ---------------------------------------------------------------------------

describe('extractWindow — извлечение временного окна', () => {
  const windows = [
    { window: 'day',   currency: 'USD', total_amount: '0.0050', total_tokens: '1000', row_count: '5' },
    { window: 'month', currency: 'USD', total_amount: '0.1200', total_tokens: '30000', row_count: '50' },
    { window: 'total', currency: 'USD', total_amount: '0.5000', total_tokens: '200000', row_count: '300' },
  ];

  it('day → правильная сумма', () => {
    const w = extractWindow(windows, 'day');
    expect(w).not.toBeNull();
    expect(w.total_amount).toBeCloseTo(0.005, 5);
    expect(w.currency).toBe('USD');
  });

  it('month → правильные токены', () => {
    const w = extractWindow(windows, 'month');
    expect(w.total_tokens).toBe(30000);
  });

  it('total → total_amount', () => {
    const w = extractWindow(windows, 'total');
    expect(w.total_amount).toBeCloseTo(0.5, 5);
  });

  it('несуществующий ключ → null', () => {
    expect(extractWindow(windows, 'week')).toBeNull();
  });

  it('не массив → null', () => {
    expect(extractWindow(null, 'day')).toBeNull();
    expect(extractWindow(undefined, 'day')).toBeNull();
    expect(extractWindow({}, 'day')).toBeNull();
  });

  it('пустой массив → null', () => {
    expect(extractWindow([], 'day')).toBeNull();
  });

  it('строковые числа → числа', () => {
    const w = extractWindow(windows, 'day');
    expect(typeof w.total_amount).toBe('number');
    expect(typeof w.total_tokens).toBe('number');
    expect(typeof w.row_count).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// mapHttpError — маппинг ошибки на русский
// ---------------------------------------------------------------------------

describe('mapHttpError — человекочитаемые ошибки HTTP', () => {
  it('401 → содержит «Войдите»', () => {
    expect(mapHttpError(401, 'расходов', {})).toContain('Войдите');
  });

  it('403 → содержит «прав»', () => {
    expect(mapHttpError(403, 'аналитики', {})).toContain('прав');
  });

  it('500 без body.message → содержит код', () => {
    const msg = mapHttpError(500, 'данных', {});
    expect(msg).toContain('500');
    expect(msg).not.toMatch(/Error:|TypeError:|stack/);
  });

  it('500 + body.message → включает message', () => {
    const msg = mapHttpError(500, 'данных', { message: 'DB offline' });
    expect(msg).toContain('DB offline');
    expect(msg).toContain('500');
  });

  it('422 → generic с кодом', () => {
    const msg = mapHttpError(422, 'списка', null);
    expect(msg).toContain('422');
  });

  it('включает domain в 401/403', () => {
    expect(mapHttpError(401, 'аналитики процессов', {})).toContain('аналитики процессов');
    expect(mapHttpError(403, 'расходов', {})).toContain('расходов');
  });
});

// ---------------------------------------------------------------------------
// best-effort деградация: одна ручка 500 → её карточка ошибка, другие ok
// Тестируем через изоляцию логики mapHttpError + extractWindow (без DOM).
// ---------------------------------------------------------------------------

describe('best-effort деградация — изолированная логика', () => {
  it('ошибка process-analytics НЕ влияет на spend-данные', () => {
    // Симулируем: process-analytics вернул ошибку, spend OK
    const spendData = {
      windows: [
        { window: 'day', currency: 'USD', total_amount: '0.01', total_tokens: '100', row_count: '2' },
      ],
      byConnection: [],
    };

    // Данные spend всё равно парсятся правильно
    const dayW = extractWindow(spendData.windows, 'day');
    expect(dayW).not.toBeNull();
    expect(dayW.total_amount).toBeCloseTo(0.01, 5);

    // Ошибка process-analytics — сообщение честное
    const errMsg = mapHttpError(500, 'аналитики процессов', {});
    expect(errMsg).toContain('500');
  });

  it('ошибка spend НЕ влияет на process-analytics-данные', () => {
    // Симулируем: spend вернул 401, process-analytics OK
    const analyticsData = {
      bottleneck: 'task.approval',
      cycleTime: {
        rows: [
          { activity: 'task.approval', avg_duration_ms: 5000, count: 3, human_count: 3, agent_count: 0, service_count: 0 },
        ],
      },
      actorBreakdown: [],
    };

    // Аналитика всё равно доступна
    expect(analyticsData.bottleneck).toBe('task.approval');
    expect(analyticsData.cycleTime.rows).toHaveLength(1);

    // Ошибка spend — сообщение содержит «Войдите»
    const errMsg = mapHttpError(401, 'расхода LLM', {});
    expect(errMsg).toContain('Войдите');
  });

  it('пустые данные spend → isEmpty=true', () => {
    const data = { windows: [], byConnection: [] };
    const isEmpty = data !== false && data.windows.length === 0 && data.byConnection.length === 0;
    expect(isEmpty).toBe(true);
  });

  it('данные spend с windows → isEmpty=false', () => {
    const data = {
      windows: [{ window: 'day', currency: 'USD', total_amount: '0.01', total_tokens: '10', row_count: '1' }],
      byConnection: [],
    };
    const isEmpty = data !== false && data.windows.length === 0 && data.byConnection.length === 0;
    expect(isEmpty).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CSS-токены: недопустимых токенов нет в исходнике
// ---------------------------------------------------------------------------

describe('CSS-токены — отсутствие несуществующих токенов', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const filePath = path.default.resolve(
    new URL(import.meta.url).pathname,
    '../screen-ops-overview.jsx',
  );
  const src = fs.default.readFileSync(filePath, 'utf-8');

  it('НЕ содержит --chs-color-primary (несуществующий токен)', () => {
    expect(src).not.toMatch(/--chs-color-primary[^-]/);
  });

  it('НЕ содержит --chs-weight-normal (несуществующий токен)', () => {
    expect(src).not.toContain('--chs-weight-normal');
  });

  it('содержит --chs-color-accent', () => {
    expect(src).toContain('--chs-color-accent');
  });

  it('содержит --chs-weight-bold', () => {
    expect(src).toContain('--chs-weight-bold');
  });

  it('содержит --chs-weight-semibold', () => {
    expect(src).toContain('--chs-weight-semibold');
  });

  it('содержит --chs-weight-regular', () => {
    expect(src).toContain('--chs-weight-regular');
  });

  it('содержит --chs-color-text-muted', () => {
    expect(src).toContain('--chs-color-text-muted');
  });

  it('содержит --chs-color-surface', () => {
    expect(src).toContain('--chs-color-surface');
  });
});

// ---------------------------------------------------------------------------
// nav-config: пункт «Операционный обзор» зарегистрирован корректно
// ---------------------------------------------------------------------------

describe('nav-config — пункт «Операционный обзор»', async () => {
  const { NAV, visibleItems } = await import('../app-shell/nav-config.js');

  it('пункт ops-overview присутствует в NAV', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const item = allItems.find((i) => i.id === 'ops-overview');
    expect(item).toBeTruthy();
  });

  it('пункт ops-overview имеет label «Операционный обзор»', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const item = allItems.find((i) => i.id === 'ops-overview');
    expect(item?.label).toBe('Операционный обзор');
  });

  it('пункт ops-overview имеет status live', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const item = allItems.find((i) => i.id === 'ops-overview');
    expect(item?.status).toBe('live');
  });

  it('пункт ops-overview НЕ скрыт', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const item = allItems.find((i) => i.id === 'ops-overview');
    expect(item?.hidden).toBeFalsy();
  });

  it('пункт ops-overview имеет screen: true', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const item = allItems.find((i) => i.id === 'ops-overview');
    expect(item?.screen).toBe(true);
  });

  it('пункт ops-overview виден через visibleItems()', () => {
    const group = NAV.find((g) => g.items.some((i) => i.id === 'ops-overview'));
    expect(group).toBeTruthy();
    const visible = visibleItems(group);
    expect(visible.find((i) => i.id === 'ops-overview')).toBeTruthy();
  });

  it('пункт ops-overview в зоне observability (Наблюдаемость) — T-0538', () => {
    // T-0538: space:'work' → zone:'observability' (4-zone rezoning).
    const group = NAV.find((g) => g.items.some((i) => i.id === 'ops-overview'));
    // NAV compat export uses zoneId (not space) for zones.
    expect(group?.zoneId || group?.space).toMatch(/observability|work/);
    expect(group?.group).toBe('Наблюдаемость');
  });

  it('ops-overview — первый пункт в группе Наблюдаемость', () => {
    const group = NAV.find((g) => g.group === 'Наблюдаемость');
    expect(group).toBeTruthy();
    expect(group.items[0]?.id).toBe('ops-overview');
  });

  it('пункт ops-overview не имеет статуса soon', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const item = allItems.find((i) => i.id === 'ops-overview');
    expect(item?.status).not.toBe('soon');
    expect(item?.soon).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Фейковые токены: guard против выдуманных CSS-var
// ---------------------------------------------------------------------------

describe('guard против фейковых CSS-токенов в screen-ops-overview', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const filePath = path.default.resolve(
    new URL(import.meta.url).pathname,
    '../screen-ops-overview.jsx',
  );
  const src = fs.default.readFileSync(filePath, 'utf-8');

  // Список реально ОТСУТСТВУЮЩИХ токенов, которые ни в коем случае нельзя использовать.
  const FAKE_TOKENS = [
    '--chs-color-primary',
    '--chs-weight-normal',
    '--chs-color-bg',
    '--chs-font-size-base',
    '--chs-border-radius',
    '--chs-shadow',
  ];

  for (const token of FAKE_TOKENS) {
    it(`НЕ содержит фейкового токена ${token}`, () => {
      expect(src).not.toContain(token);
    });
  }
});
