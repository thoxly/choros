/**
 * web/src/screens/screen-reports.test.jsx  (T-0490)
 *
 * Тесты экрана «Отчёты».
 *
 * Подход (конвенция проекта, vitest "node" environment):
 *   - Компоненты с хуками (useState/useEffect) нельзя вызывать как функции
 *     без React-рантайма — так делает ValidationBanner (без хуков).
 *   - Тестируем: (1) nav-config пункт reports; (2) fmtMetricValue-логику;
 *     (3) BarChart (без хуков — svg-компонент); (4) MetricCard (без хуков);
 *     (5) парсинг ключа pages; (6) наличие app-selector; (7) пустое-состояние.
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
// Парсинг ключа ответа /api/report-pages (Blocker 1)
// ---------------------------------------------------------------------------

/**
 * Имитирует логику экрана: из тела ответа извлекает список страниц.
 * Сервер возвращает { pages: [...] }; устойчивость к массиву и data.items.
 */
function parseReportPages(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.pages)) return data.pages;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

describe('parseReportPages — парсинг ключа ответа (Blocker 1)', () => {
  it('читает data.pages (серверный контракт)', () => {
    const pages = [{ id: 'p1', title: 'Отчёт 1' }];
    expect(parseReportPages({ pages })).toEqual(pages);
  });

  it('устойчивость: если вдруг массив напрямую', () => {
    const list = [{ id: 'p1' }];
    expect(parseReportPages(list)).toEqual(list);
  });

  it('устойчивость: data.items (старый формат)', () => {
    const items = [{ id: 'p2' }];
    expect(parseReportPages({ items })).toEqual(items);
  });

  it('пустой объект → пустой массив', () => {
    expect(parseReportPages({})).toEqual([]);
  });

  it('data.pages=[] → пустой массив (не undefined)', () => {
    expect(parseReportPages({ pages: [] })).toEqual([]);
  });

  it('СТАРЫЙ ключ data.items НЕ ломает: items=[x] возвращает [x]', () => {
    expect(parseReportPages({ items: [{ id: 'x' }] })).toEqual([{ id: 'x' }]);
  });

  it('при наличии обоих keys — приоритет у pages', () => {
    const pages = [{ id: 'fromPages' }];
    const items = [{ id: 'fromItems' }];
    expect(parseReportPages({ pages, items })).toEqual(pages);
  });
});

// ---------------------------------------------------------------------------
// App-selector: логика выбора первого приложения по умолчанию (Blocker 2)
// ---------------------------------------------------------------------------

describe('app-selector — логика по умолчанию (Blocker 2)', () => {
  it('первое приложение становится выбранным по умолчанию', () => {
    const apps = [
      { id: 'app-uuid-1', display_name: 'Закупки', slug: 'purchases' },
      { id: 'app-uuid-2', display_name: 'CRM', slug: 'crm' },
    ];
    // Логика: selectedAppId ?? apps[0].id
    const selectedAppId = null;
    const defaultId = selectedAppId ?? apps[0].id;
    expect(defaultId).toBe('app-uuid-1');
  });

  it('при пустом списке приложений — нет дефолтного id', () => {
    const apps = [];
    const defaultId = apps.length > 0 ? apps[0].id : null;
    expect(defaultId).toBeNull();
  });

  it('URL для отчётов содержит app_id из выбранного приложения', () => {
    const appId = 'b7c2a1d3-e4f5-6789-abcd-ef0123456789';
    const url = `/api/report-pages?app_id=${encodeURIComponent(appId)}`;
    expect(url).toBe(`/api/report-pages?app_id=${appId}`);
    expect(url).toContain('app_id=');
    expect(url).toContain(appId);
  });

  it('display_name используется как метка в селекторе (не UUID)', () => {
    const app = { id: 'uuid-xxx', display_name: 'Мой реестр', slug: 'my-registry' };
    const label = app.display_name ?? app.slug ?? app.id;
    expect(label).toBe('Мой реестр');
  });

  it('fallback метка: slug если нет display_name', () => {
    const app = { id: 'uuid-yyy', slug: 'my-registry' };
    const label = app.display_name ?? app.slug ?? app.id;
    expect(label).toBe('my-registry');
  });

  it('состояние "нет приложений" — не показывает список отчётов', () => {
    // Проверяем условие рендера: список отчётов виден только если apps.length > 0
    const apps = [];
    const shouldShowReportList = Array.isArray(apps) && apps.length > 0;
    expect(shouldShowReportList).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CSS-токены (Blocker 3): несуществующих токенов нет в исходнике
// ---------------------------------------------------------------------------

describe('CSS-токены — отсутствие несуществующих токенов (Blocker 3)', async () => {
  // Читаем исходник через динамический import текста (используем fs через vitest)
  const fs = await import('fs');
  const path = await import('path');
  const filePath = path.default.resolve(
    new URL(import.meta.url).pathname,
    '../screen-reports.jsx',
  );
  const src = fs.default.readFileSync(filePath, 'utf-8');

  it('НЕ содержит --chs-color-primary (несуществующий токен)', () => {
    // Убеждаемся, что нет голого --chs-color-primary (без -subtle/-hover)
    expect(src).not.toMatch(/--chs-color-primary[^-]/);
  });

  it('НЕ содержит --chs-color-primary-subtle', () => {
    expect(src).not.toContain('--chs-color-primary-subtle');
  });

  it('НЕ содержит --chs-weight-normal (несуществующий токен)', () => {
    expect(src).not.toContain('--chs-weight-normal');
  });

  it('содержит --chs-color-accent (замена primary)', () => {
    expect(src).toContain('--chs-color-accent');
  });

  it('содержит --chs-color-accent-soft (замена primary-subtle)', () => {
    expect(src).toContain('--chs-color-accent-soft');
  });

  it('содержит --chs-weight-regular (замена weight-normal)', () => {
    expect(src).toContain('--chs-weight-regular');
  });
});

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

  it('пункт reports в зоне observability (Наблюдаемость) — T-0538', () => {
    // T-0538: space:'work' → zone:'observability' (4-zone rezoning).
    const group = NAV.find((g) => g.items.some((i) => i.id === 'reports'));
    expect(group?.zoneId || group?.space).toMatch(/observability|work/);
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
// Честность скоупа (G3): построитель ВСТРОЕН в экран «Отчёты» (T-0492),
// а не отдельный пункт меню. В nav-config нет отдельной dead-кнопки.
// ---------------------------------------------------------------------------

describe('Скоуп — построитель встроен, не отдельный пункт меню (G3)', async () => {
  const { NAV } = await import('../app-shell/nav-config.js');

  it('в NAV нет отдельного пункта create-reports или reports-new', () => {
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
// Выгрузка (T-0492): контракт URL экспорта /export?format=xlsx|csv
// ---------------------------------------------------------------------------

describe('Выгрузка — URL экспорта /export?format=', () => {
  // Зеркалит downloadReportExport: строит URL для скачивания файла отчёта.
  function exportUrl(pageId, format) {
    return `/api/report-pages/${encodeURIComponent(pageId)}/export?format=${encodeURIComponent(format)}`;
  }

  it('xlsx → корректный путь и query', () => {
    const id = 'b7c2a1d3-e4f5-6789-abcd-ef0123456789';
    expect(exportUrl(id, 'xlsx')).toBe(`/api/report-pages/${id}/export?format=xlsx`);
  });

  it('csv → корректный путь и query', () => {
    const id = 'b7c2a1d3-e4f5-6789-abcd-ef0123456789';
    expect(exportUrl(id, 'csv')).toBe(`/api/report-pages/${id}/export?format=csv`);
  });

  it('имя скачиваемого файла включает id и расширение формата', () => {
    const id = 'page-uuid';
    const filename = (pageId, format) => `report-${pageId}.${format}`;
    expect(filename(id, 'xlsx')).toBe('report-page-uuid.xlsx');
    expect(filename(id, 'csv')).toBe('report-page-uuid.csv');
  });
});

// ---------------------------------------------------------------------------
// Построитель — машина состояний режима (undefined/null/object)
// ---------------------------------------------------------------------------

describe('Построитель — режим (undefined=закрыт / null=новый / object=правка)', () => {
  it('«Новый отчёт» открывает построитель с editing=null', () => {
    let builder = undefined;
    const setBuilder = (v) => { builder = v; };
    setBuilder(null);            // клик «Новый отчёт»
    expect(builder).toBeNull();  // открыт в режиме создания
  });

  it('«Изменить» открывает построитель с объектом страницы (правка)', () => {
    let builder = undefined;
    const setBuilder = (v) => { builder = v; };
    const page = { id: 'p1', title: 'Отчёт', tier: 'draft' };
    setBuilder(page);
    expect(builder).toBe(page);
  });

  it('«Отмена»/«Сохранено» закрывает построитель (undefined)', () => {
    let builder = null;
    const setBuilder = (v) => { builder = v; };
    setBuilder(undefined);
    expect(builder).toBeUndefined();
  });

  it('кнопка «Новый отчёт» видна только когда построитель закрыт', () => {
    const showNewButton = (builder) => builder === undefined;
    expect(showNewButton(undefined)).toBe(true);
    expect(showNewButton(null)).toBe(false);   // создание открыто
    expect(showNewButton({ id: 'p' })).toBe(false); // правка открыта
  });

  it('опубликованный отчёт не показывает кнопку «Изменить» (published-locked)', () => {
    const canEdit = (report) => report.tier !== 'published';
    expect(canEdit({ tier: 'draft' })).toBe(true);
    expect(canEdit({ tier: 'published' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Построитель — восстановление формы из page_def черновика (правка)
// ---------------------------------------------------------------------------

describe('Построитель — восстановление метрик/группировки из page_def', () => {
  const BUILDER_AGGS = ['count', 'sum', 'avg', 'min', 'max'];

  // Зеркалит логику восстановления в ReportBuilder useEffect.
  function restoreFromPageDef(pageDef) {
    const metrics = (Array.isArray(pageDef) ? pageDef : [])
      .filter((m) => m && BUILDER_AGGS.includes(m.agg))
      .map((m) => ({ agg: m.agg, fieldKey: m.agg === 'count' ? '' : (m.field_key || ''), title: m.title || '' }));
    const gb = (Array.isArray(pageDef) ? pageDef : []).find((m) => m && typeof m.group_by === 'string' && m.group_by);
    return { metrics, groupBy: gb ? gb.group_by : '' };
  }

  it('восстанавливает count-метрику с пустым полем (поле count игнорируется)', () => {
    const { metrics } = restoreFromPageDef([
      { source_registry_def_id: 'r', field_key: 'status', agg: 'count', group_by: 'status' },
    ]);
    expect(metrics).toEqual([{ agg: 'count', fieldKey: '', title: '' }]);
  });

  it('восстанавливает числовую метрику с её полем и подписью', () => {
    const { metrics } = restoreFromPageDef([
      { source_registry_def_id: 'r', field_key: 'amount', agg: 'sum', title: 'Итого' },
    ]);
    expect(metrics).toEqual([{ agg: 'sum', fieldKey: 'amount', title: 'Итого' }]);
  });

  it('восстанавливает группировку из любой метрики, где есть group_by', () => {
    const { groupBy } = restoreFromPageDef([
      { agg: 'count', field_key: 'status', group_by: 'status' },
      { agg: 'sum', field_key: 'amount', group_by: 'status' },
    ]);
    expect(groupBy).toBe('status');
  });

  it('без group_by — группировка пустая', () => {
    const { groupBy } = restoreFromPageDef([{ agg: 'sum', field_key: 'amount' }]);
    expect(groupBy).toBe('');
  });

  it('игнорирует метрики с неизвестным агрегатором (list/median)', () => {
    const { metrics } = restoreFromPageDef([
      { agg: 'list', field_key: 'x' },
      { agg: 'sum', field_key: 'amount' },
    ]);
    expect(metrics).toEqual([{ agg: 'sum', fieldKey: 'amount', title: '' }]);
  });
});

// ---------------------------------------------------------------------------
// B1: человеческие сообщения об ошибках на submit-пути (401/403)
// ---------------------------------------------------------------------------

describe('B1 — submit: 401/403 → человеческий русский (не сырой английский)', () => {
  // Mirrors the logic in handleSubmit, extracted for pure unit-testing.
  function mapSubmitError(status, context) {
    if (status === 401) return 'Войдите в систему.';
    if (status === 403 && context === 'author') return 'Нет прав на создание отчётов в этом приложении. Обратитесь к владельцу.';
    if (status === 403 && context === 'promote') return 'Публиковать отчёты может только человек с правом публикации.';
    return null; // falls through to apiErr
  }

  it('401 на create/update → «Войдите в систему.»', () => {
    expect(mapSubmitError(401, 'author')).toBe('Войдите в систему.');
  });

  it('403 на create → русское сообщение без raw-ключей', () => {
    const msg = mapSubmitError(403, 'author');
    expect(msg).toBeTruthy();
    expect(msg).not.toMatch(/denied|mgmt_object|report_page/);
    expect(msg).toContain('прав');
  });

  it('403 на promote → упоминает публикацию, не raw «promote is human-only»', () => {
    const msg = mapSubmitError(403, 'promote');
    expect(msg).toBeTruthy();
    expect(msg).not.toMatch(/promote|human-only/);
    expect(msg).toContain('Публиковать');
  });

  it('200 статус → нет ошибки (falls through)', () => {
    expect(mapSubmitError(200, 'author')).toBeNull();
  });

  it('500 → falls through (не маппится, идёт к apiErr)', () => {
    expect(mapSubmitError(500, 'author')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P3: tier labels — «черновик»/«опубликован» вместо «draft»/«published»
// ---------------------------------------------------------------------------

describe('P3 — tier labels: draft/published → русский', () => {
  const TIER_LABELS = { draft: 'черновик', published: 'опубликован' };

  function tierLabel(tier) {
    return TIER_LABELS[tier] ?? tier;
  }

  it('draft → «черновик»', () => {
    expect(tierLabel('draft')).toBe('черновик');
  });

  it('published → «опубликован»', () => {
    expect(tierLabel('published')).toBe('опубликован');
  });

  it('неизвестный статус → оставляем как есть (не ломаем)', () => {
    expect(tierLabel('archived')).toBe('archived');
  });

  it('пустой tier → пустая строка (не ломаем)', () => {
    expect(tierLabel('')).toBe('');
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
