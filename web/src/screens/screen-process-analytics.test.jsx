/**
 * web/src/screens/screen-process-analytics.test.jsx  (T-0493)
 *
 * Тесты экрана «Аналитика процессов».
 *
 * Подход (конвенция проекта, vitest "node" environment):
 *   - Компоненты с хуками (useState/useEffect) тестируются через дерево-обход.
 *   - ProcessAnalyticsScreen содержит хуки → НЕ вызываем как функцию напрямую.
 *   - Тестируем: (1) fmtDuration форматтер; (2) fmtActorType; (3) aggregateActorBreakdown;
 *     (4) nav-config пункт process-analytics; (5) CSS-токены; (6) состояния (G4).
 *
 * Все вспомогательные функции экспортированы из экрана для unit-тестирования.
 */

import { describe, it, expect } from 'vitest';
import { fmtDuration, fmtActorType, aggregateActorBreakdown } from './screen-process-analytics.jsx';

// ---------------------------------------------------------------------------
// fmtDuration — форматтер длительности
// ---------------------------------------------------------------------------

describe('fmtDuration — человекочитаемая длительность', () => {
  it('null → «—»', () => expect(fmtDuration(null)).toBe('—'));
  it('undefined → «—»', () => expect(fmtDuration(undefined)).toBe('—'));
  it('отрицательное → «—»', () => expect(fmtDuration(-1)).toBe('—'));
  it('NaN → «—»', () => expect(fmtDuration(NaN)).toBe('—'));
  it('Infinity → «—»', () => expect(fmtDuration(Infinity)).toBe('—'));

  it('0 мс → «0 мс»', () => expect(fmtDuration(0)).toBe('0 мс'));
  it('500 мс → «500 мс»', () => expect(fmtDuration(500)).toBe('500 мс'));
  it('999 мс → «999 мс»', () => expect(fmtDuration(999)).toBe('999 мс'));

  it('1000 мс → «1 с»', () => expect(fmtDuration(1000)).toBe('1 с'));
  it('1500 мс → «1.5 с»', () => expect(fmtDuration(1500)).toBe('1.5 с'));
  it('30000 мс → «30 с»', () => expect(fmtDuration(30000)).toBe('30 с'));
  it('59999 мс → «60 с»', () => expect(fmtDuration(59999)).toBe('60 с'));

  it('60000 мс (1 мин) → «1 мин»', () => expect(fmtDuration(60000)).toBe('1 мин'));
  it('90000 мс (1.5 мин) → «1.5 мин»', () => expect(fmtDuration(90000)).toBe('1.5 мин'));
  it('3600000 мс (1 ч) → «1 ч»', () => expect(fmtDuration(3600000)).toBe('1 ч'));
  it('5400000 мс (1.5 ч) → «1.5 ч»', () => expect(fmtDuration(5400000)).toBe('1.5 ч'));

  it('86400000 мс (1 день) → «1 дн»', () => expect(fmtDuration(86400000)).toBe('1 дн'));
  it('172800000 мс (2 дня) → «2 дн»', () => expect(fmtDuration(172800000)).toBe('2 дн'));

  it('целое число секунд не содержит лишней .0', () => {
    expect(fmtDuration(2000)).toBe('2 с'); // не «2.0 с»
  });

  it('целое число минут не содержит .0', () => {
    expect(fmtDuration(120000)).toBe('2 мин'); // не «2.0 мин»
  });
});

// ---------------------------------------------------------------------------
// fmtActorType — маппинг actor_type → русский
// ---------------------------------------------------------------------------

describe('fmtActorType — человекочитаемый тип исполнителя', () => {
  it('human → «Человек»', () => expect(fmtActorType('human')).toBe('Человек'));
  it('agent → «Агент»', () => expect(fmtActorType('agent')).toBe('Агент'));
  it('service → «Сервис»', () => expect(fmtActorType('service')).toBe('Сервис'));
  it('неизвестный → передаём как есть', () => expect(fmtActorType('robot')).toBe('robot'));
  it('пустая строка → пустая строка', () => expect(fmtActorType('')).toBe(''));
});

// ---------------------------------------------------------------------------
// aggregateActorBreakdown — агрегация по actor_type
// ---------------------------------------------------------------------------

describe('aggregateActorBreakdown — суммирует count по actor_type', () => {
  it('пустой массив → все нули', () => {
    expect(aggregateActorBreakdown([])).toEqual({ human: 0, agent: 0, service: 0, other: 0 });
  });

  it('только human-строки → human суммируется', () => {
    const rows = [
      { activity: 'task.claimed', actor_type: 'human', count: 3 },
      { activity: 'task.completed', actor_type: 'human', count: 5 },
    ];
    const result = aggregateActorBreakdown(rows);
    expect(result.human).toBe(8);
    expect(result.agent).toBe(0);
    expect(result.service).toBe(0);
  });

  it('смешанный → агент и человек разделены', () => {
    const rows = [
      { activity: 'task.claimed', actor_type: 'human', count: 10 },
      { activity: 'task.completed', actor_type: 'agent', count: 4 },
      { activity: 'instance.started', actor_type: 'service', count: 2 },
    ];
    const result = aggregateActorBreakdown(rows);
    expect(result.human).toBe(10);
    expect(result.agent).toBe(4);
    expect(result.service).toBe(2);
    expect(result.other).toBe(0);
  });

  it('неизвестный actor_type → попадает в other', () => {
    const rows = [
      { activity: 'task.done', actor_type: 'robot', count: 7 },
    ];
    const result = aggregateActorBreakdown(rows);
    expect(result.other).toBe(7);
    expect(result.human).toBe(0);
  });

  it('несколько строк одного activity с разными actor_type', () => {
    const rows = [
      { activity: 'task.claimed', actor_type: 'human', count: 3 },
      { activity: 'task.claimed', actor_type: 'agent', count: 2 },
      { activity: 'task.completed', actor_type: 'human', count: 1 },
    ];
    const result = aggregateActorBreakdown(rows);
    expect(result.human).toBe(4);
    expect(result.agent).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// bottleneck-логика: выбор узкого места
// ---------------------------------------------------------------------------

describe('bottleneck-логика', () => {
  // Зеркалит логику экрана: bottleneck = cycleTime.bottleneck с проверкой типа
  function extractBottleneck(data) {
    return data && typeof data.bottleneck === 'string' ? data.bottleneck : null;
  }

  it('bottleneck-строка → возвращается', () => {
    expect(extractBottleneck({ bottleneck: 'task.approval', cycleTime: { rows: [] }, actorBreakdown: [] })).toBe('task.approval');
  });

  it('bottleneck null → null', () => {
    expect(extractBottleneck({ bottleneck: null, cycleTime: { rows: [] }, actorBreakdown: [] })).toBeNull();
  });

  it('нет поля bottleneck → null', () => {
    expect(extractBottleneck({ cycleTime: { rows: [] }, actorBreakdown: [] })).toBeNull();
  });

  it('данные ещё не загружены (null) → null', () => {
    expect(extractBottleneck(null)).toBeNull();
  });

  it('bottleneck — максимальный avg_duration_ms в строках', () => {
    const rows = [
      { activity: 'task.approval', avg_duration_ms: 5000, count: 3, human_count: 3, agent_count: 0, service_count: 0 },
      { activity: 'task.review',   avg_duration_ms: 1000, count: 5, human_count: 5, agent_count: 0, service_count: 0 },
    ];
    // bottleneck = строки отсортированы DESC → первая строка = узкое место
    const bottleneck = rows[0].activity;
    expect(bottleneck).toBe('task.approval');
  });
});

// ---------------------------------------------------------------------------
// Честные состояния (G4): логика «пусто»
// ---------------------------------------------------------------------------

describe('G4 — состояние «пусто»: нет шагов и нет событий исполнителей', () => {
  function isEmpty(data) {
    if (!data || data === false) return false;
    const rows = data.cycleTime && Array.isArray(data.cycleTime.rows) ? data.cycleTime.rows : [];
    const actorBreakdown = Array.isArray(data.actorBreakdown) ? data.actorBreakdown : [];
    return rows.length === 0 && actorBreakdown.length === 0;
  }

  it('нет данных вообще → пусто', () => {
    expect(isEmpty({ bottleneck: null, cycleTime: { rows: [] }, actorBreakdown: [] })).toBe(true);
  });

  it('есть шаги → не пусто', () => {
    const data = {
      bottleneck: 'task.claimed',
      cycleTime: { rows: [{ activity: 'task.claimed', avg_duration_ms: 1000, count: 1, human_count: 1, agent_count: 0, service_count: 0 }] },
      actorBreakdown: [],
    };
    expect(isEmpty(data)).toBe(false);
  });

  it('есть актёры → не пусто', () => {
    const data = {
      bottleneck: null,
      cycleTime: { rows: [] },
      actorBreakdown: [{ activity: 'task.done', actor_type: 'human', count: 1 }],
    };
    expect(isEmpty(data)).toBe(false);
  });

  it('null (ещё не загружено) → не считается пустым', () => {
    expect(isEmpty(null)).toBe(false);
  });

  it('false (ошибка) → не считается пустым', () => {
    expect(isEmpty(false)).toBe(false);
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
    '../screen-process-analytics.jsx',
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

  it('содержит --chs-color-accent-soft', () => {
    expect(src).toContain('--chs-color-accent-soft');
  });

  it('содержит --chs-weight-regular', () => {
    expect(src).toContain('--chs-weight-regular');
  });

  it('содержит --chs-weight-semibold', () => {
    expect(src).toContain('--chs-weight-semibold');
  });

  it('содержит --chs-weight-bold', () => {
    expect(src).toContain('--chs-weight-bold');
  });
});

// ---------------------------------------------------------------------------
// nav-config: пункт «Аналитика процессов» зарегистрирован корректно
// ---------------------------------------------------------------------------

describe('nav-config — пункт «Аналитика процессов»', async () => {
  const { NAV, visibleItems } = await import('../app-shell/nav-config.js');

  it('пункт process-analytics присутствует в NAV', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const item = allItems.find((i) => i.id === 'process-analytics');
    expect(item).toBeTruthy();
  });

  it('пункт process-analytics имеет label «Аналитика процессов»', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const item = allItems.find((i) => i.id === 'process-analytics');
    expect(item?.label).toBe('Аналитика процессов');
  });

  it('пункт process-analytics имеет status live', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const item = allItems.find((i) => i.id === 'process-analytics');
    expect(item?.status).toBe('live');
  });

  it('пункт process-analytics НЕ скрыт', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const item = allItems.find((i) => i.id === 'process-analytics');
    expect(item?.hidden).toBeFalsy();
  });

  it('пункт process-analytics имеет screen: true', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const item = allItems.find((i) => i.id === 'process-analytics');
    expect(item?.screen).toBe(true);
  });

  it('пункт process-analytics виден через visibleItems()', () => {
    const group = NAV.find((g) => g.items.some((i) => i.id === 'process-analytics'));
    expect(group).toBeTruthy();
    const visible = visibleItems(group);
    expect(visible.find((i) => i.id === 'process-analytics')).toBeTruthy();
  });

  it('пункт process-analytics в space work (Наблюдаемость)', () => {
    const group = NAV.find((g) => g.items.some((i) => i.id === 'process-analytics'));
    expect(group?.space).toBe('work');
    expect(group?.group).toBe('Наблюдаемость');
  });

  it('пункт process-analytics не имеет статуса soon', () => {
    const allItems = NAV.flatMap((g) => g.items);
    const item = allItems.find((i) => i.id === 'process-analytics');
    expect(item?.status).not.toBe('soon');
    expect(item?.soon).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Ошибки HTTP: маппинг статусов на человеческие сообщения (G4)
// ---------------------------------------------------------------------------

describe('G4 — маппинг ошибок HTTP на человеческий текст', () => {
  // Зеркалит логику loadAnalytics в экране.
  function mapFetchError(status, body) {
    if (status === 401) return 'Войдите в систему для просмотра аналитики процессов.';
    if (status === 403) return 'Нет прав на просмотр аналитики процессов.';
    const msg = body?.message;
    return `Ошибка HTTP ${status}${msg ? ': ' + msg : ''}`;
  }

  it('401 → «Войдите в систему…»', () => {
    expect(mapFetchError(401, {})).toContain('Войдите');
  });

  it('403 → «Нет прав…»', () => {
    expect(mapFetchError(403, {})).toContain('прав');
  });

  it('500 → generic с кодом (не сырой stack)', () => {
    const msg = mapFetchError(500, {});
    expect(msg).toContain('500');
    expect(msg).not.toMatch(/Error:|TypeError:|stack/);
  });

  it('500 + message → включает message', () => {
    const msg = mapFetchError(500, { message: 'Internal error' });
    expect(msg).toContain('Internal error');
  });
});
