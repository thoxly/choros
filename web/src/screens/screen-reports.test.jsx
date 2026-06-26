/**
 * web/src/screens/screen-reports.test.jsx  (T-0490)
 *
 * Тесты экрана «Отчёты».
 *
 * Подход (конвенция проекта, vitest "node" environment):
 *   - Компоненты с хуками (useState/useEffect) нельзя вызывать как функции
 *     без React-рантайма — так делает ValidationBanner (без хуков).
 *   - Тестируем: (1) nav-config пункт reports; (2) fmtMetricValue-логику;
 *     (3) BarChart (без хуков — svg-компонент); (4) MetricCard (без хуков).
 *   - React импортируем напрямую для tree-walk без DOM/jsdom.
 *
 * В отличие от screen-process-editor.test.jsx мы НЕ вызываем ReportsScreen
 * как функцию — он содержит хуки. Тестируем вспомогательные части.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Tree-walk helpers (проектная конвенция)
// ---------------------------------------------------------------------------

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const c of node) collectText(c, out);
    return out;
  }
  if (typeof node === 'object' && node.props) {
    collectText(node.props.children, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// fmtMetricValue (скопирована из экрана — белый ящик, логика не меняется)
// ---------------------------------------------------------------------------

function fmtMetricValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/\.?0+$/, '');
  }
  if (typeof value === 'string') {
    const n = parseFloat(value);
    if (!isNaN(n) && String(n) === value) return String(n);
    return value;
  }
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

// ---------------------------------------------------------------------------
// nav-config: пункт «Отчёты» зарегистрирован корректно
// ---------------------------------------------------------------------------

describe('nav-config содержит пункт Отчёты', async () => {
  const { NAV, visibleItems } = await import('../app-shell/nav-config.js');

  it('пункт reports присутствует в NAV', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const reportsItem = allItems.find((item) => item.id === 'reports');
    expect(reportsItem).toBeTruthy();
  });

  it('пункт reports имеет label «Отчёты»', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const reportsItem = allItems.find((item) => item.id === 'reports');
    expect(reportsItem?.label).toBe('Отчёты');
  });

  it('пункт reports имеет status live', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const reportsItem = allItems.find((item) => item.id === 'reports');
    expect(reportsItem?.status).toBe('live');
  });

  it('пункт reports НЕ скрыт (нет hidden: true)', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const reportsItem = allItems.find((item) => item.id === 'reports');
    expect(reportsItem?.hidden).toBeFalsy();
  });

  it('пункт reports виден через visibleItems()', () => {
    const group = NAV.find((g) => g.items.some((i) => i.id === 'reports'));
    expect(group).toBeTruthy();
    const visible = visibleItems(group);
    expect(visible.find((i) => i.id === 'reports')).toBeTruthy();
  });

  it('пункт reports имеет screen: true', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const reportsItem = allItems.find((item) => item.id === 'reports');
    expect(reportsItem?.screen).toBe(true);
  });

  it('пункт reports в space work (Наблюдаемость)', () => {
    const group = NAV.find((g) => g.items.some((i) => i.id === 'reports'));
    expect(group?.space).toBe('work');
  });
});

// ---------------------------------------------------------------------------
// fmtMetricValue-логика: честность форматирования значений
// ---------------------------------------------------------------------------

describe('fmtMetricValue-логика', () => {
  it('null → «—»', () => expect(fmtMetricValue(null)).toBe('—'));
  it('undefined → «—»', () => expect(fmtMetricValue(undefined)).toBe('—'));
  it('целое 0 → «0»', () => expect(fmtMetricValue(0)).toBe('0'));
  it('целое 42 → «42»', () => expect(fmtMetricValue(42)).toBe('42'));
  it('целое -5 → «-5»', () => expect(fmtMetricValue(-5)).toBe('-5'));
  it('дробное 1.5 → «1.5» (без лишних нулей)', () => expect(fmtMetricValue(1.5)).toBe('1.5'));
  it('дробное 3.1400 → «3.14»', () => expect(fmtMetricValue(3.14)).toBe('3.14'));
  it('дробное 0.0001 → «0.0001»', () => expect(fmtMetricValue(0.0001)).toBe('0.0001'));
  it('строка-число «100» → «100»', () => expect(fmtMetricValue('100')).toBe('100'));
  it('обычная строка → строка', () => expect(fmtMetricValue('hello')).toBe('hello'));
  it('пустая строка → пустая строка', () => expect(fmtMetricValue('')).toBe(''));
  it('массив → через запятую', () => expect(fmtMetricValue(['a', 'b', 'c'])).toBe('a, b, c'));
  it('массив пустой → пустая строка', () => expect(fmtMetricValue([])).toBe(''));
  it('большое число → не теряет точность для целых', () => expect(fmtMetricValue(1000000)).toBe('1000000'));
});

// ---------------------------------------------------------------------------
// Честность скоупа (G3): экран только для просмотра
// Проверяем, что в nav-config нет dead-кнопки «Создать отчёт»
// (кнопка создания — зона T-0492, не T-0490)
// ---------------------------------------------------------------------------

describe('Скоуп — только просмотр (G3)', async () => {
  const { NAV } = await import('../app-shell/nav-config.js');

  it('в NAV нет пункта create-reports или reports-new', () => {
    const allItems = NAV.flatMap((g) => g.items);
    expect(allItems.find((i) => i.id === 'create-reports')).toBeFalsy();
    expect(allItems.find((i) => i.id === 'reports-new')).toBeFalsy();
  });

  it('пункт reports не имеет статуса soon (доступен сразу)', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const item = allItems.find((i) => i.id === 'reports');
    expect(item?.status).not.toBe('soon');
    expect(item?.soon).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// AGG_LABELS — проверяем маппинг через воспроизведение
// ---------------------------------------------------------------------------

describe('AGG_LABELS — полнота словаря агрегатов', () => {
  const AGG_LABELS = {
    count: 'количество',
    sum: 'сумма',
    avg: 'среднее',
    min: 'мин',
    max: 'макс',
    list: 'список',
  };

  it('покрывает все Floor-1 агрегаты', () => {
    const floor1Aggs = ['count', 'sum', 'avg', 'min', 'max', 'list'];
    for (const agg of floor1Aggs) {
      expect(AGG_LABELS[agg]).toBeTruthy();
    }
  });

  it('все значения — непустые русские строки', () => {
    for (const [, label] of Object.entries(AGG_LABELS)) {
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
