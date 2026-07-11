// @vitest-environment jsdom
/**
 * web/src/screens/screen-overview.mount.test.jsx  (T-0306)
 *
 * REAL DOM mount test — @testing-library/react + jsdom (конвенция T-0715,
 * см. screen-inbox.mount.test.jsx): source-presence sibling-файл никогда не
 * рендерит OverviewScreen, так что краш на реальном mount-пути (битый JSX
 * маркера, исключение в FirstStepsStrip, кривой ответ API) остался бы для
 * него невидим (fake-green). Здесь монтируется НАСТОЯЩИЙ default export
 * <OverviewScreen /> внутри MemoryRouter (useNavigate — load-bearing),
 * boot-time GET'ы замоканы, и проверяются три сценария first-run (E14):
 *
 *   A. СВЕЖИЙ ПУСТОЙ WORKSPACE (0 приложений, всё загрузилось): полоса
 *      «Первые шаги» видима, шаг «Создайте приложение» с рабочей CTA,
 *      НОЛЬ маркеров «недоступно» (пусто = подтверждённый todo, не сбой).
 *   B. ДЕГРАДАЦИЯ (/api/applications 500): шаг 1 рендерит честный маркер
 *      «Статус шага недоступен», НЕ пустой todo-круг — сбой ≠ «нет приложений».
 *   C. ВСЁ ПРОЙДЕНО: полоса скрыта целиком (AC-7 T-0598 — mount-подтверждение).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, waitFor, screen, cleanup } from '@testing-library/react';
import OverviewScreen from './screen-overview.jsx';

function jsonOk(body) {
  return { ok: true, status: 200, json: async () => body };
}
function httpFail(status = 500) {
  return { ok: false, status, json: async () => ({}) };
}

/**
 * Роутер моков «свежий пустой тенант» (сценарий A):
 * приложений 0, задач 0, процессов 0; assistant-agent существует (register.ts
 * сеет его каждому тенанту), но LLM не подключён и тредов нет; права видны.
 */
function freshTenantFetch(url) {
  const u = String(url);
  if (u.startsWith('/api/applications')) return jsonOk({ applications: [] });
  if (u.startsWith('/api/inbox')) return jsonOk({ items: [], counts: { all: 0, mine: 0, pool: 0, esc: 0 } });
  if (u.startsWith('/api/processes')) return jsonOk({ instances: [] });
  if (u.startsWith('/api/agents')) {
    return jsonOk({ agents: [{ id: 'agent-1', agent_type: 'assistant', llm_connection_id: null }] });
  }
  if (u.startsWith('/api/assistant/threads')) return jsonOk({ threads: [] });
  if (u.startsWith('/api/rights/tenant-state')) return jsonOk({ can_manage: true });
  return jsonOk({});
}

function renderOverview() {
  return render(
    <MemoryRouter>
      <OverviewScreen />
    </MemoryRouter>,
  );
}

describe('OverviewScreen — REAL mount, first-run сценарии (T-0306)', () => {
  let originalFetch;
  let originalLocalStorage;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLocalStorage = globalThis.localStorage;
    globalThis.fetch = async (url) => freshTenantFetch(url);
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });

  // F1-r2: probe «загрузка завершена» — дешёвый class-селектор (LoadingState
  // рендерит .chs-state--loading; покрывает и плитки, и строки полосы). НЕ
  // зависит от stepMarkerState (StepRow ветвится на `loading ? (` литерале) —
  // мутация decision-функции не подвесит ожидание: probe завершится, а упадёт
  // БЫСТРЫЙ assertion по маркерам. Поллинг getAllByRole(img,{name}) из r2
  // вычислял accessible-name на каждый тик waitFor и детерминированно пробивал
  // дефолтные 5s под конкур-нагрузкой (класс w6/w7 «timeout-маска», теперь в
  // web-тире); замена — attribute/class-селекторы + разовые проверки атрибутов;
  // per-test timeout 10000 на A/B — подстраховка.
  async function waitLoaded() {
    await waitFor(() => {
      expect(document.querySelectorAll('.chs-state--loading')).toHaveLength(0);
    });
  }
  const UNKNOWN_MARKER_SEL = '[title="Статус шага недоступен"]';

  it('A: свежий пустой workspace → «Первые шаги» видимы, CTA «Создать приложение» рабочая, 0 маркеров «недоступно»', async () => {
    renderOverview();
    // Полоса и шаг 1 присутствуют сразу (полоса не ждёт сигналов, чтобы показаться).
    expect(screen.getByText('Первые шаги')).toBeTruthy();
    expect(screen.getByText('Создайте приложение')).toBeTruthy();
    // Дождаться завершения ВСЕХ загрузок (плитки + сигналы полосы) дёшево.
    await waitLoaded();
    // Пустой workspace = подтверждённый todo: ни одного «недоступно» после загрузки.
    expect(document.querySelectorAll(UNKNOWN_MARKER_SEL)).toHaveLength(0);
    // Счётчик приложений на плитке «Конструктор» загрузился (0, а не спиннер).
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
    // CTA шага 1 — настоящая кнопка (разовый getAllByRole ВНЕ waitFor — не поллинг).
    const ctas = screen.getAllByRole('button', { name: 'Создать приложение' });
    expect(ctas.length).toBeGreaterThan(0);
  }, 10000);

  it('B: /api/applications 500 → шаг 1 показывает честный маркер «Статус шага недоступен» (сбой ≠ пусто)', async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith('/api/applications')) return httpFail(500);
      return freshTenantFetch(url);
    };
    renderOverview();
    await waitLoaded();
    // Ровно один честный маркер — шаг 1 (шаги 2-3 загрузились честно). Сломанный
    // stepMarkerState (unknown→todo) даёт 0 → МГНОВЕННЫЙ assertion-fail, не таймаут:
    // waitLoaded ветвится на `loading ? (` литерале StepRow, не на decision-функции.
    const markers = document.querySelectorAll(UNKNOWN_MARKER_SEL);
    expect(markers).toHaveLength(1);
    // a11y-контракт маркера — прямые атрибуты (без вычисления accessible-name).
    expect(markers[0].getAttribute('role')).toBe('img');
    expect(markers[0].getAttribute('aria-label')).toBe('Статус шага недоступен');
    // Полоса при деградации остаётся видимой, CTA рабочая (AC-6 T-0598 сохранён).
    expect(screen.getByText('Первые шаги')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Создать приложение' }).length).toBeGreaterThan(0);
  }, 10000);

  it('C: все три шага подтверждённо пройдены → полоса скрыта целиком (mount-подтверждение AC-7)', async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith('/api/applications')) {
        return jsonOk({ applications: [{ id: 'app-1', slug: 'generic-app', display_name: 'Generic App' }] });
      }
      if (u.startsWith('/api/agents')) {
        return jsonOk({ agents: [{ id: 'agent-1', agent_type: 'assistant', llm_connection_id: 'conn-1' }] });
      }
      if (u.startsWith('/api/assistant/threads')) {
        return jsonOk({ threads: [{ id: 't1', message_count: 2 }] });
      }
      return freshTenantFetch(url);
    };
    renderOverview();
    await waitFor(() => {
      expect(screen.queryByText('Первые шаги')).toBeNull();
    });
    // Дом при этом жив: плитки разделов рендерятся.
    expect(screen.getByText('Конструктор')).toBeTruthy();
  });
});
