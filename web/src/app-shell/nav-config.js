/* ============================================================================
   CHOROS — nav-config.js
   Конфигурация навигационных пунктов + статусная классификация.

   status:
     'live' — реальные данные и действия работают на деплое
     'demo' — рендерит, но данные mock/seed или действия не функциональны
     'soon' — ещё не построено (disabled)
   hidden: true — скрыть из навигации полностью

   Классификация пересматривается при каждом новом подключении экрана к реальным API.
   Каждый пункт nav со статусом 'demo' или 'soon' ОБЯЗАН быть помечен
   соответствующим бейджем в NavItem; hidden-пункты не рендерятся вовсе.

   ИА (T-0317): информационная архитектура сведена к 4 разделам вокруг того, ЧТО
   делает пользователь, а не как устроена система. Раздел = ответ на вопрос
   «зачем я сюда пришёл»:
     • КОНСТРУКТОР — собираю своё решение из примитивов (приложения, поля, записи);
     • РАБОТА — делаю задачи и веду процессы;
     • ИСПОЛНИТЕЛИ И ДОСТУП — модель исполнителя целиком (кто работает + что можно):
       оргструктура, агенты, права (раньше были разнесены по трём группам);
     • НАБЛЮДАЕМОСТЬ — смотрю, что происходит (уведомления, аудит, бюджеты).
   Группы с одним пунктом не заводим (заголовок без выбора — шум).
   Пути маршрутов НЕ меняются — только ярлыки и группировка.
   ============================================================================ */

/**
 * @typedef {'live' | 'demo' | 'soon'} NavStatus
 * @typedef {{ id: string, label: string, icon: string, screen?: boolean, soon?: boolean, hidden?: boolean, status: NavStatus, count?: number }} NavItem
 * @typedef {{ group: string, items: NavItem[], home?: boolean }} NavGroup
 */

/** @type {NavGroup[]} */
export const NAV = [
  {
    // T-0326: домашний раздел «Обзор» — точка входа над группами. Это НЕ группа
    // в смысле §«заголовок без выбора = шум»: помечен `home: true`, шелл рисует
    // его как одиночный пункт БЕЗ заголовка-ярлыка (см. shell.jsx nav-рендер).
    group: "Обзор",
    home: true,
    items: [
      // Обзор: домашний дашборд. Живые счётчики тянет сам экран из live-API
      // (applications / inbox / processes) — в nav счётчик не дублируем (T-0307 #5).
      { id: "overview", label: "Обзор", icon: "apps", screen: true, status: "live" },
    ],
  },
  {
    group: "Конструктор",
    items: [
      // Приложения: GET /api/applications (live), POST /api/applications (live) — T-0262/T-0265.
      // Первый реальный create-экран продукта (E13): список + работающая «Создать приложение».
      { id: "apps", label: "Приложения", icon: "apps", screen: true, status: "live" },
      // Формы задач — developer sandbox (form-js демо). Не рабочий экран пользователя;
      // живёт под Конструктором как инструмент авторинга, честно помечен «демо».
      { id: "forms", label: "Формы задач", icon: "forms", screen: true, status: "demo" },
    ],
  },
  {
    group: "Работа",
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
    items: [
      // Уведомления: GET /api/notifications (live), mark-read/all (live), preferences (live)
      { id: "notifications", label: "Уведомления", icon: "bell",   screen: true, status: "live" },
      // Аудит: GET /api/audit (live), GET /api/audit/export (live)
      { id: "audit",         label: "Аудит",       icon: "audit",  screen: true, status: "live" },
      // Бюджеты: не построено
      { id: "budgets",       label: "Бюджеты",     icon: "budget", soon: true,   status: "soon" },
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
