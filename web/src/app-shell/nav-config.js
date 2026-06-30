/* ============================================================================
   CHOROS — nav-config.js
   Конфигурация навигационных зон и пунктов.

   T-0538 (NAV-IA / Ф1): пересборка из 2 пространств (authoring/work) в
   4 операционные зоны (work · constructor · observability · admin).

   status:
     'live' — реальные данные и действия работают на деплое
     'demo' — рендерит, но данные mock/seed или действия не функциональны
     'soon' — ещё не построено (disabled)
   hidden: true — скрыть из навигации полностью (маршрут жив)
   path   — переопределяет маршрут перехода (по умолчанию '/' + id).
   zone   — операционная зона ('work'|'constructor'|'observability'|'admin'|null)
   capability — ЗАДЕЛ под T-0539: null ⇒ видно всем (фильтрация НЕ реализована)
   audience   — семантический ярлык (информативно, не gate)
   frequency  — как часто нужен (информативно)

   Зоны в порядке рендера:
   1 РАБОТА · 2 КОНСТРУКТОР · 3 НАБЛЮДАЕМОСТЬ · 4 АДМИНИСТРИРОВАНИЕ

   Группы с одним пунктом не заводим (заголовок без выбора — шум).
   Пути маршрутов НЕ меняются — только ярлыки и группировка (инвариант §6).
   ============================================================================ */

/**
 * @typedef {'live' | 'demo' | 'soon'} NavStatus
 * @typedef {'work' | 'constructor' | 'observability' | 'admin'} NavZoneId
 * @typedef {'end-user' | 'builder' | 'manager' | 'admin'} NavAudience
 * @typedef {'daily' | 'weekly' | 'rare'} NavFrequency
 *
 * @typedef {Object} NavItem
 * @property {string}          id          стабильный id (== screen-id, основа маршрута)
 * @property {string}          label       человеко-понятный ярлык (ru)
 * @property {string}          icon        kit Lucide icon name
 * @property {NavZoneId|null}  zone        зона (null = home над зонами)
 * @property {NavAudience}     audience    для кого (дефолт = zone.audience)
 * @property {string|null}     capability  ЗАДЕЛ под T-0539: null ⇒ видно всем
 * @property {NavFrequency}    frequency   частота (информативно)
 * @property {number}          order       порядок внутри зоны
 * @property {string=}         subgroup    подгруппа внутри зоны admin
 * @property {string=}         path        переопределение маршрута
 * @property {boolean=}        screen      есть реальный экран/маршрут
 * @property {boolean=}        hidden      скрыт из nav (маршрут жив)
 * @property {NavStatus}       status      live | demo | soon
 *
 * @typedef {Object} NavZone
 * @property {NavZoneId}    id        идентификатор зоны
 * @property {string}       label     Работа|Конструктор|Наблюдаемость|Администрирование
 * @property {NavAudience}  audience  дефолтная аудитория зоны
 * @property {number}       order     порядок зон в сайдбаре (1..4)
 * @property {NavItem[]}    items     пункты зоны (в порядке item.order)
 */

/** Одиночный home-пункт «Обзор» — НАД зонами, рендерится без заголовка.
 *  @type {NavItem} */
export const NAV_HOME = {
  id: "overview", label: "Обзор", icon: "apps",
  zone: null, audience: "end-user", capability: null, frequency: "daily", order: 0,
  screen: true, status: "live",
};

/** Четыре операционные зоны. Экспортируется для рендера сайдбара и тестов.
 *  @type {NavZone[]} */
export const ZONES = [
  // ── 1. РАБОТА — делаю задачи, веду процессы. Аудитория: конечный пользователь.
  {
    id: "work", label: "Работа", audience: "end-user", order: 1,
    items: [
      // Мои задачи: GET /api/inbox (live), claim/action (live).
      { id: "inbox",     label: "Мои задачи", icon: "inbox",   zone: "work", audience: "end-user", capability: null, frequency: "daily",  order: 1, screen: true, status: "live" },
      // Процессы: GET /api/processes (live), start (live).
      { id: "processes", label: "Процессы",   icon: "process", zone: "work", audience: "end-user", capability: null, frequency: "daily",  order: 2, screen: true, status: "live" },
    ],
  },

  // ── 2. КОНСТРУКТОР — собираю решение из примитивов. Аудитория: внедренец/агент.
  {
    id: "constructor", label: "Конструктор", audience: "builder", order: 2,
    items: [
      // Приложения: GET /api/applications (live), POST (live). E13.
      { id: "apps",      label: "Приложения",  icon: "apps",      zone: "constructor", audience: "builder", capability: null, frequency: "weekly", order: 1, screen: true, status: "live" },
      // Формы задач: убраны из nav (hidden), маршрут /forms жив. T-0482.
      { id: "forms",     label: "Формы задач", icon: "forms",     zone: "constructor", audience: "builder", capability: null, frequency: "weekly", order: 2, screen: true, status: "demo", hidden: true },
      // Модельер: BPMN-редактор. Маршрут /processes/new/edit (path-override). T-0323.
      { id: "modeler",   label: "Модельер",    icon: "process",   zone: "constructor", audience: "builder", capability: null, frequency: "weekly", order: 3, path: "/processes/new/edit", screen: true, status: "live" },
      // Ассистент: AI-консоль авторинга и аналитики. E17.
      { id: "assistant", label: "Ассистент",   icon: "assistant", zone: "constructor", audience: "builder", capability: null, frequency: "weekly", order: 4, screen: true, status: "demo" },
    ],
  },

  // ── 3. НАБЛЮДАЕМОСТЬ — смотрю, как система работает. Аудитория: менеджер.
  {
    id: "observability", label: "Наблюдаемость", audience: "manager", order: 3,
    items: [
      // Операционный обзор (T-0494): три сигнала в одной панели.
      { id: "ops-overview",      label: "Операционный обзор",  icon: "audit",  zone: "observability", audience: "manager",  capability: null, frequency: "weekly", order: 1, screen: true, status: "live" },
      // Отчёты (T-0490).
      { id: "reports",           label: "Отчёты",              icon: "audit",  zone: "observability", audience: "manager",  capability: null, frequency: "weekly", order: 2, screen: true, status: "live" },
      // Аналитика процессов (T-0493).
      { id: "process-analytics", label: "Аналитика процессов", icon: "audit",  zone: "observability", audience: "manager",  capability: null, frequency: "weekly", order: 3, screen: true, status: "live" },
      // Аудит: GET /api/audit (live).
      { id: "audit",             label: "Аудит",               icon: "audit",  zone: "observability", audience: "manager",  capability: null, frequency: "weekly", order: 4, screen: true, status: "live" },
      // Расход (T-0477, E-AGENTS L5): учёт стоимости LLM-вызовов.
      { id: "spend",             label: "Расход",              icon: "budget", zone: "observability", audience: "manager",  capability: null, frequency: "weekly", order: 5, screen: true, status: "live" },
      // Уведомления (быстрый доступ дублируется в аккаунт-поповере на тот же /notifications).
      { id: "notifications",     label: "Уведомления",         icon: "bell",   zone: "observability", audience: "end-user", capability: null, frequency: "daily",  order: 6, screen: true, status: "live" },
    ],
  },

  // ── 4. АДМИНИСТРИРОВАНИЕ — настраиваю исполнителей/доступ/справочники/интеграции.
  //    Подгруппы: Исполнители · Доступ · Справочники · Интеграции и LLM
  {
    id: "admin", label: "Администрирование", audience: "admin", order: 4,
    items: [
      // Исполнители
      { id: "org",               label: "Оргструктура",       icon: "org",       zone: "admin", subgroup: "Исполнители",        audience: "admin", capability: null, frequency: "rare", order: 1, screen: true, status: "live" },
      { id: "agents",            label: "Агенты",             icon: "org",       zone: "admin", subgroup: "Исполнители",        audience: "admin", capability: null, frequency: "rare", order: 2, screen: true, status: "live" },
      // Доступ (T-0538): операционный просмотр грантов (overview + журнал).
      // Ярлык изменён с «Права и доступ» → «Доступ» (scope сужен после выноса справочников в 'reference').
      { id: "rights",            label: "Доступ",             icon: "rights",    zone: "admin", subgroup: "Доступ",             audience: "admin", capability: null, frequency: "rare", order: 3, screen: true, status: "live" },
      // Справочники (T-0538): вынос из RIGHTS_TABS — критичность/SoD/каталог ролей/интенты.
      // path:/rights/criticality — существующий маршрут (инвариант §6).
      // F1 (review): в FF-NAV-MAP это новая точка входа, не потеря; id='reference' добавлен сознательно.
      { id: "reference",         label: "Справочники",        icon: "rights",    zone: "admin", subgroup: "Справочники",        audience: "admin", capability: null, frequency: "rare", order: 4, screen: true, status: "live", path: "/rights/criticality" },
      // Интеграции и LLM
      { id: "llm-connections",   label: "LLM-соединения",     icon: "assistant", zone: "admin", subgroup: "Интеграции и LLM",  audience: "admin", capability: null, frequency: "rare", order: 5, screen: true, status: "live" },
      { id: "llm-config",        label: "LLM-подключение",    icon: "assistant", zone: "admin", subgroup: "Интеграции и LLM",  audience: "admin", capability: null, frequency: "rare", order: 6, screen: true, status: "live" },
      { id: "assistant-prompt",  label: "Промпт ассистента",  icon: "assistant", zone: "admin", subgroup: "Интеграции и LLM",  audience: "admin", capability: null, frequency: "rare", order: 7, screen: true, status: "live" },
    ],
  },
];

/**
 * NAV: совместимый экспорт для паллитры и SCREEN_META.
 * paletteDestinations() итерирует по NAV (grp.items), item.screen && status!=='soon'.
 * Сформирован из NAV_HOME + всех items всех ZONES — ни один пункт не теряется.
 *
 * Структура group/items сохранена для обратной совместимости CommandPalette.
 * @type {Array<{group: string, home?: boolean, items: NavItem[]}>}
 */
export const NAV = [
  { group: "Обзор", home: true, items: [NAV_HOME] },
  ...ZONES.map((z) => ({ group: z.label, zoneId: z.id, items: z.items })),
];

/**
 * Возвращает только видимые пункты (hidden: true отфильтровывается).
 * @param {{ items: NavItem[] }} group  NavGroup или NavZone
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
