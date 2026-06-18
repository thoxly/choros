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
   ============================================================================ */

/**
 * @typedef {'live' | 'demo' | 'soon'} NavStatus
 * @typedef {{ id: string, label: string, icon: string, screen?: boolean, soon?: boolean, hidden?: boolean, status: NavStatus, count?: number }} NavItem
 * @typedef {{ group: string, items: NavItem[] }} NavGroup
 */

/** @type {NavGroup[]} */
export const NAV = [
  {
    group: "Конструктор",
    items: [
      // Приложения: GET /api/applications (live), POST /api/applications (live) — T-0262/T-0265.
      // Первый реальный create-экран продукта (E13): список + работающая «Создать приложение».
      { id: "apps", label: "Приложения", icon: "apps", screen: true, status: "live" },
    ],
  },
  {
    group: "Оркестрация",
    items: [
      // Инбокс: GET /api/inbox (live), POST /api/inbox/:id/claim (live), POST /api/inbox/:id/action (live)
      { id: "inbox",     label: "Инбокс задач", icon: "inbox",   count: 18, screen: true, status: "live" },
      // Оргструктура: дерево GET /api/org live, но панель деталей — EXEC_DETAIL static mock.
      { id: "org",       label: "Оргструктура",  icon: "org",                screen: true, status: "demo" },
      // Процессы: GET /api/processes (live), POST /api/processes/start (live)
      { id: "processes", label: "Процессы",       icon: "process", count: 7, screen: true, status: "live" },
    ],
  },
  {
    group: "Наблюдаемость",
    items: [
      // Уведомления: GET /api/notifications (live), mark-read/all (live), preferences (live)
      { id: "notifications", label: "Уведомления",    icon: "bell",  screen: true, status: "live" },
      // Аудит: GET /api/audit (live), GET /api/audit/export (live)
      { id: "audit",         label: "Аудит инстанса", icon: "audit", screen: true, status: "live" },
      // Бюджеты: не построено
      { id: "budgets",       label: "Бюджеты",        icon: "budget", soon: true,  status: "soon" },
    ],
  },
  {
    group: "Доступ",
    items: [
      // Права: обзор GET /api/rights (live), интенты (live), журнал GET /api/grant-trail (live).
      // Суб-вкладки «Редактор», «Критичность», «SoD» — mock-данные (demo, см. RIGHTS_TABS).
      { id: "rights", label: "Права и доступ", icon: "rights", count: 8, screen: true, status: "live" },
    ],
  },
  {
    group: "Разработка",
    items: [
      // Формы: sandbox-iframe с form-js демо. POST /api/forms/:id/submit работает,
      // но это developer sandbox, не рабочий экран пользователя.
      { id: "forms", label: "Формы задач", icon: "forms", screen: true, status: "demo" },
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
