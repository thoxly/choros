/* ============================================================================
   CHOROS — nav-config.js
   Конфигурация навигационных пунктов + статусная классификация.

   status:
     'live' — реальные данные и действия работают на деплое
     'demo' — рендерит, но данные mock/seed или действия не функциональны
     'soon' — ещё не построено (disabled)
   hidden: true — скрыть из навигации полностью
   path   — переопределяет маршрут перехода (по умолчанию '/' + id).
            Используется для авторинг-инструментов, которые ещё не имеют
            отдельного top-level маршрута (например, Модельер → /processes/new/edit).

   Классификация пересматривается при каждом новом подключении экрана к реальным API.
   Каждый пункт nav со статусом 'demo' или 'soon' ОБЯЗАН быть помечен
   соответствующим бейджем в NavItem; hidden-пункты не рендерятся вовсе.

   ИА (T-0317 → T-0355):
   Два чётких пространства — АВТОРИНГ и РАБОТА — разделены визуальным
   разделителем в сайдбаре (shell.jsx).

   АВТОРИНГ (space: 'authoring') — для внедренца и агента:
     • КОНСТРУКТОР — собираю решение из примитивов (приложения, поля, формы);
     • МОДЕЛЬЕР — рисую BPMN-процессы;
     • АССИСТЕНТ — AI-консоль авторинга и аналитики.

   РАБОТА (space: 'work') — для конечного пользователя:
     • РАБОТА — делаю задачи и веду процессы;
     • ИСПОЛНИТЕЛИ И ДОСТУП — модель исполнителя (оргструктура, агенты, права);
     • НАБЛЮДАЕМОСТЬ — уведомления, аудит, бюджеты.

   «Раздел» (Финансы/HR/Продажи) — лёгкий конструкт группировки приложений по
   бизнес-функции, создаётся внедренцем/агентом. Пока не построен динамически:
   приложения группируются статично в «Работа». E16 добавит динамические разделы
   поверх этой IA-основы (T-0349).

   Группы с одним пунктом не заводим (заголовок без выбора — шум).
   Пути маршрутов НЕ меняются — только ярлыки и группировка.
   ============================================================================ */

/**
 * @typedef {'live' | 'demo' | 'soon'} NavStatus
 * @typedef {'authoring' | 'work'} NavSpace
 * @typedef {{ id: string, label: string, icon: string, path?: string, screen?: boolean, soon?: boolean, hidden?: boolean, status: NavStatus, count?: number }} NavItem
 * @typedef {{ group: string, space?: NavSpace, items: NavItem[], home?: boolean }} NavGroup
 */

/** @type {NavGroup[]} */
export const NAV = [
  {
    // T-0326: домашний раздел «Обзор» — точка входа над группами. Это НЕ группа
    // в смысле §«заголовок без выбора = шум»: помечен `home: true`, шелл рисует
    // его как одиночный пункт БЕЗ заголовка-ярлыка (см. shell.jsx nav-рендер).
    // Обзор стоит над двумя пространствами — не принадлежит ни одному.
    group: "Обзор",
    home: true,
    items: [
      // Обзор: домашний дашборд. Живые счётчики тянет сам экран из live-API
      // (applications / inbox / processes) — в nav счётчик не дублируем (T-0307 #5).
      { id: "overview", label: "Обзор", icon: "apps", screen: true, status: "live" },
    ],
  },

  // ── АВТОРИНГ ─────────────────────────────────────────────────────────────
  // Инструменты для внедренца и агента: строить, моделировать, настраивать.
  // ──────────────────────────────────────────────────────────────────────────
  {
    group: "Конструктор",
    space: "authoring",
    items: [
      // Приложения: GET /api/applications (live), POST /api/applications (live) — T-0262/T-0265.
      // Первый реальный create-экран продукта (E13): список + работающая «Создать приложение».
      { id: "apps", label: "Приложения", icon: "apps", screen: true, status: "live" },
      // Формы задач — developer sandbox (form-js демо). Не рабочий экран пользователя;
      // инструмент авторинга для проектирования форм, честно помечен «демо».
      { id: "forms", label: "Формы задач", icon: "forms", screen: true, status: "demo" },
    ],
  },
  {
    // Модельер (T-0323): BPMN-редактор процессов. Отдельная группа в авторинг-пространстве.
    // Маршрут: /processes/new/edit (существующий deep-route через screen-processes.jsx).
    // Собственный top-level маршрут /modeler появится в E16 (T-0349); пока — demo-вход.
    group: "Модельер",
    space: "authoring",
    items: [
      {
        id: "modeler",
        label: "Модельер",
        icon: "process",
        // Перенаправляет на существующий BPMN-редактор (новый процесс).
        // Маршрут /processes/new/edit уже существует; route /modeler добавится в E16.
        path: "/processes/new/edit",
        screen: true,
        status: "demo",
      },
    ],
  },
  {
    // Ассистент (E17 T-0358): AI-консоль авторинга и аналитики. КОНФИГУРАТОР (авторит
    // модель E16 в DRAFT, promote человеком) + АНАЛИТИК (read-only по данным + журналу).
    // Shell-only: LLM-роутинг = T-0359/T-0360. demo пока: реального бэкенда нет.
    group: "Ассистент",
    space: "authoring",
    items: [
      { id: "assistant", label: "Ассистент", icon: "assistant", screen: true, status: "demo" },
    ],
  },

  // ── РАБОТА ────────────────────────────────────────────────────────────────
  // Пространство конечного пользователя: делать задачи, вести процессы,
  // управлять исполнителями, наблюдать за системой.
  // Функциональные домены (Финансы/HR/Продажи) — динамические разделы E16 (T-0349);
  // статически группируем всё как «Работа» до их появления.
  // ──────────────────────────────────────────────────────────────────────────
  {
    group: "Работа",
    space: "work",
    items: [
      // Мои задачи (бывш. «Инбокс задач»): GET /api/inbox (live), POST /api/inbox/:id/claim
      // (live), POST /api/inbox/:id/action (live). Человеко-понятный ярлык вместо дев-«инбокс».
      { id: "inbox",     label: "Мои задачи", icon: "inbox",   screen: true, status: "live" },
      // Процессы: GET /api/processes (live), POST /api/processes/start (live)
      { id: "processes", label: "Процессы",   icon: "process", screen: true, status: "live" },
    ],
  },
  {
    group: "Исполнители и доступ",
    space: "work",
    items: [
      // Оргструктура (T-0269): дерево GET /api/org + РЕАЛЬНЫЙ CRUD над существующими
      // эндпойнтами — POST /api/{departments,positions,employees,roles}, POST
      // /api/role-assignments, DELETE /api/{…}/:id (genesis-owner gate). UUID для записи
      // берутся из GET /api/org/tenant-state. Карточка исполнителя ещё иллюстративна
      // (честно помечена), но дерево + создание/удаление/назначение — живые → live.
      { id: "org",       label: "Оргструктура",  icon: "org",    screen: true, status: "live" },
      // Агенты (T-0271): GET /api/agents (live, метаданные без секретов), POST
      // /api/agents/hire (live), POST /api/agents/:id/secret-handle (live — привязка
      // LLM через секрет-хэндл). Список + создание + привязка LLM — живые → live.
      { id: "agents",    label: "Агенты",        icon: "org",    screen: true, status: "live" },
      // Права: обзор GET /api/rights (live), интенты (live), журнал GET /api/grant-trail (live).
      // Суб-вкладки «Редактор», «Критичность», «SoD» — mock-данные (demo, см. RIGHTS_TABS).
      { id: "rights",    label: "Права и доступ", icon: "rights", screen: true, status: "live" },
    ],
  },
  {
    group: "Наблюдаемость",
    space: "work",
    items: [
      // Уведомления: GET /api/notifications (live), mark-read/all (live), preferences (live)
      { id: "notifications", label: "Уведомления", icon: "bell",   screen: true, status: "live" },
      // Аудит: GET /api/audit (live), GET /api/audit/export (live)
      { id: "audit",         label: "Аудит",       icon: "audit",  screen: true, status: "live" },
      // Бюджеты: не построено
      { id: "budgets",       label: "Бюджеты",     icon: "budget", soon: true,   status: "soon" },
    ],
  },
  // T-0382 (D5): LLM-подключение — настройка BYO LLM для тенанта.
  // T-0383 (D5/PD-6): Промпт ассистента — редактор системного промпта.
  // GET /api/llm-config (live), PUT /api/llm-config (live).
  // GET/PUT /api/assistant/prompt/:role (live).
  // Секрет-хэндл настраивается отдельно через экран «Агенты» → «Привязать LLM».
  {
    group: "Конфигурация",
    space: "work",
    items: [
      // T-0474 (E-AGENTS L2): именованные профили LLM-подключений (реестр).
      // GET/POST /api/llm-connections (live).
      {
        id: "llm-connections",
        label: "LLM-соединения",
        icon: "assistant",
        screen: true,
        status: "live",
      },
      {
        id: "llm-config",
        label: "LLM-подключение",
        icon: "assistant",
        screen: true,
        status: "live",
      },
      {
        id: "assistant-prompt",
        label: "Промпт ассистента",
        icon: "assistant",
        screen: true,
        status: "live",
      },
    ],
  },
];

/**
 * Возвращает только видимые пункты группы (hidden: true отфильтровывается).
 * @param {NavGroup} group
 * @returns {NavItem[]}
 */
export function visibleItems(group) {
  return group.items.filter((item) => !item.hidden);
}

/**
 * Возвращает статус пункта с учётом legacy-поля `soon`.
 * @param {NavItem} item
 * @returns {NavStatus}
 */
export function effectiveStatus(item) {
  if (item.status) return item.status;
  if (item.soon) return "soon";
  return "live";
}
