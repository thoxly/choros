/* ============================================================================
   CHOROS — nav-config.js
   Конфигурация навигационных зон и пунктов.

   T-0538 (NAV-IA / Ф1): пересборка из 2 пространств (authoring/work) в
   4 операционные зоны (work · constructor · observability · admin).
   T-0539 (NAV-IA / Ф2): capability-driven visibility — фильтр сайдбара на основе
   NavCapabilitySet от GET /api/me/nav-capabilities. Функции:
     visibleZones(navSet)          — зоны, видимые актору (fail-closed).
     visibleItems(zoneId, navSet)  — пункты зоны (zone-гейт + ownerOnly).
     projectZones(caps, owner)     — единственный маппинг capability→зона.
   SCREEN_REGISTRY — реестр экранов (id → ScreenRegistryEntry) для FF-SCREEN-DECL.

   status:
     'live' — реальные данные и действия работают на деплое
     'demo' — рендерит, но данные mock/seed или действия не функциональны
     'soon' — ещё не построено (disabled)
   hidden: true — скрыть из навигации полностью (маршрут жив)
   path   — переопределяет маршрут перехода (по умолчанию '/' + id).
   zone   — операционная зона ('work'|'constructor'|'observability'|'admin'|null)
   capability — capability-токен зоны: null ⇒ видно всем (zone 'work' / home).
   audience   — семантический ярлык (информативно, не gate)
   frequency  — как часто нужен (информативно)
   ownerOnly  — true ⇒ виден только genesis-owner (SoD-ломтики, T-0409)

   Зоны в порядке рендера:
   1 РАБОТА · 2 КОНСТРУКТОР · 3 НАБЛЮДАЕМОСТЬ · 4 АДМИНИСТРИРОВАНИЕ

   Маппинг зона→capability (ADR §6, системно-фиксировано MVP):
     РАБОТА         — capability:null (пол, видна всем участникам тенанта)
     КОНСТРУКТОР    — 'authoring_draft'
     НАБЛЮДАЕМОСТЬ  — 'observability:read'
     АДМИНИСТРИРОВАНИЕ — любой mgmt_object:* ИЛИ isGenesisOwner

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
  // «Раздел» (Финансы/HR/Продажи) — атрибут бизнес-функции приложения (app.section,
  // migration 108). Сайдбар строит подсекции зоны РАБОТА динамически из данных:
  // GET /api/applications → groupAppsBySection() → нав-секции. Управление разделами —
  // пользовательское действие через screen-apps или агент (PATCH /api/applications/:id).
  // Построено в T-0540 (E-NAV-IA), НЕ в E16. E16 — рантайм-привязка (триггеры/исходы).
  //
  // Функциональные домены (Финансы/HR/Продажи) — динамические разделы T-0540 (E-NAV-IA);
  // app.section = поле бизнес-функции; groupAppsBySection() строит секции из данных.
  {
    id: "work", label: "Работа", audience: "end-user", order: 1,
    items: [
      // Мои задачи: GET /api/inbox (live), claim/action (live).
      { id: "inbox",     label: "Мои задачи", icon: "inbox",   zone: "work", audience: "end-user", capability: null, frequency: "daily",  order: 1, screen: true, status: "live" },
      // Процессы: GET /api/processes (live), start (live).
      { id: "processes", label: "Процессы",   icon: "process", zone: "work", audience: "end-user", capability: null, frequency: "daily",  order: 2, screen: true, status: "live" },
      // Динамические секции приложений добавляются в сайдбаре через groupAppsBySection()
      // (shell.jsx) из GET /api/applications; не в items[] — не статичные пункты.
    ],
  },

  // ── 2. КОНСТРУКТОР — собираю решение из примитивов. Аудитория: внедренец/агент.
  //    Capability-gate: 'authoring_draft' (T-0539, ADR §6).
  {
    id: "constructor", label: "Конструктор", audience: "builder", order: 2,
    capability: "authoring_draft",
    items: [
      // Приложения: GET /api/applications (live), POST (live). E13.
      { id: "apps",      label: "Приложения",  icon: "apps",      zone: "constructor", audience: "builder", capability: "authoring_draft", frequency: "weekly", order: 1, screen: true, status: "live" },
      // Разделы: управление разделами-сущностями (ELMA-папки) — T-0551. Маршрут /sections.
      { id: "sections",  label: "Разделы",     icon: "apps",      zone: "constructor", audience: "builder", capability: "authoring_draft", frequency: "weekly", order: 2, screen: true, status: "live" },
      // Конструктор форм: конструктор форм/интерфейсов (T-0543/544/545). Маршрут /forms. T-0550: снят hidden+demo.
      { id: "forms",     label: "Конструктор форм", icon: "forms",     zone: "constructor", audience: "builder", capability: "authoring_draft", frequency: "weekly", order: 3, screen: true, status: "live" },
      // Модельер: BPMN-редактор. Маршрут /processes/new/edit (path-override). T-0323.
      { id: "modeler",   label: "Модельер",    icon: "process",   zone: "constructor", audience: "builder", capability: "authoring_draft", frequency: "weekly", order: 4, path: "/processes/new/edit", screen: true, status: "live" },
      // Ассистент: AI-консоль авторинга и аналитики. E17. T-0573: снят демо-бейдж —
      // ТОЛЬКО как следствие доказанного backfill (migration 118, AC-1) +
      // живого прохода владельца тенанта через чат (AC-4), не косметика впереди факта.
      { id: "assistant", label: "Ассистент",   icon: "assistant", zone: "constructor", audience: "builder", capability: "authoring_draft", frequency: "weekly", order: 5, screen: true, status: "live" },
    ],
  },

  // ── 3. НАБЛЮДАЕМОСТЬ — смотрю, как система работает. Аудитория: менеджер.
  //    Capability-gate: 'observability:read' (T-0539, ADR §6 / §4.3).
  {
    id: "observability", label: "Наблюдаемость", audience: "manager", order: 3,
    capability: "observability:read",
    items: [
      // Операционный обзор (T-0494): три сигнала в одной панели.
      { id: "ops-overview",      label: "Операционный обзор",  icon: "audit",  zone: "observability", audience: "manager",  capability: "observability:read", frequency: "weekly", order: 1, screen: true, status: "live" },
      // Отчёты (T-0490).
      { id: "reports",           label: "Отчёты",              icon: "audit",  zone: "observability", audience: "manager",  capability: "observability:read", frequency: "weekly", order: 2, screen: true, status: "live" },
      // Аналитика процессов (T-0493).
      { id: "process-analytics", label: "Аналитика процессов", icon: "audit",  zone: "observability", audience: "manager",  capability: "observability:read", frequency: "weekly", order: 3, screen: true, status: "live" },
      // Оперативная аналитика (T-0405, PD-20): нагрузка по периодам + xlsx/csv выгрузка.
      { id: "operational-analytics", label: "Оперативная аналитика", icon: "audit", zone: "observability", audience: "manager", capability: "observability:read", frequency: "weekly", order: 4, screen: true, status: "live" },
      // Аудит: GET /api/audit (live).
      { id: "audit",             label: "Аудит",               icon: "audit",  zone: "observability", audience: "manager",  capability: "observability:read", frequency: "weekly", order: 5, screen: true, status: "live" },
      // Расход (T-0477, E-AGENTS L5): учёт стоимости LLM-вызовов.
      { id: "spend",             label: "Расход",              icon: "budget", zone: "observability", audience: "manager",  capability: "observability:read", frequency: "weekly", order: 6, screen: true, status: "live" },
      // Уведомления (быстрый доступ дублируется в аккаунт-поповере на тот же /notifications).
      { id: "notifications",     label: "Уведомления",         icon: "bell",   zone: "observability", audience: "end-user", capability: "observability:read", frequency: "daily",  order: 7, screen: true, status: "live" },
    ],
  },

  // ── 4. АДМИНИСТРИРОВАНИЕ — настраиваю исполнителей/доступ/справочники/интеграции.
  //    Подгруппы: Исполнители · Доступ · Справочники · Интеграции и LLM
  //    Capability-gate: any mgmt_object:* OR isGenesisOwner (T-0539, ADR §6).
  {
    id: "admin", label: "Администрирование", audience: "admin", order: 4,
    capability: "mgmt_object:*",  // sentinel — фактический гейт = adminGrants.length>0 || isGenesisOwner
    items: [
      // Исполнители
      { id: "org",               label: "Оргструктура",       icon: "org",       zone: "admin", subgroup: "Исполнители",        audience: "admin", capability: "mgmt_object:*", frequency: "rare", order: 1, screen: true, status: "live" },
      { id: "agents",            label: "Агенты",             icon: "org",       zone: "admin", subgroup: "Исполнители",        audience: "admin", capability: "mgmt_object:*", frequency: "rare", order: 2, screen: true, status: "live" },
      // T-0583: user accounts (human logins) — "нанять человека не сложнее агента".
      { id: "users",             label: "Пользователи",       icon: "org",       zone: "admin", subgroup: "Исполнители",        audience: "admin", capability: "mgmt_object:*", frequency: "rare", order: 3, screen: true, status: "live" },
      // Доступ (T-0538): операционный просмотр грантов (overview + журнал).
      // Ярлык изменён с «Права и доступ» → «Доступ» (scope сужен после выноса справочников в 'reference').
      { id: "rights",            label: "Доступ",             icon: "rights",    zone: "admin", subgroup: "Доступ",             audience: "admin", capability: "mgmt_object:*", frequency: "rare", order: 3, screen: true, status: "live" },
      // Справочники (T-0538): вынос из RIGHTS_TABS — критичность/SoD/каталог ролей/интенты.
      // path:/rights/criticality — существующий маршрут (инвариант §6).
      // F1 (review): в FF-NAV-MAP это новая точка входа, не потеря; id='reference' добавлен сознательно.
      { id: "reference",         label: "Справочники",        icon: "rights",    zone: "admin", subgroup: "Справочники",        audience: "admin", capability: "mgmt_object:*", frequency: "rare", order: 4, screen: true, status: "live", path: "/rights/criticality" },
      // Интеграции и LLM
      { id: "llm-connections",   label: "LLM-соединения",     icon: "assistant", zone: "admin", subgroup: "Интеграции и LLM",  audience: "admin", capability: "mgmt_object:*", frequency: "rare", order: 5, screen: true, status: "live" },
      { id: "llm-config",        label: "LLM-подключение",    icon: "assistant", zone: "admin", subgroup: "Интеграции и LLM",  audience: "admin", capability: "mgmt_object:*", frequency: "rare", order: 6, screen: true, status: "live" },
      { id: "assistant-prompt",  label: "Промпт ассистента",  icon: "assistant", zone: "admin", subgroup: "Интеграции и LLM",  audience: "admin", capability: "mgmt_object:*", frequency: "rare", order: 7, screen: true, status: "live" },
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
 * Возвращает только видимые пункты зоны/группы (hidden:true отфильтровывается).
 * Обратная совместимость (T-0538 compat): принимает group-объект {items:[]} для CommandPalette.
 * T-0539: перегружена — если первый аргумент строка (zoneId), принимает (zoneId, navSet).
 *
 * @overload
 * @param {{ items: NavItem[] }} group  NavGroup или NavZone (compat, без capability-фильтра)
 * @returns {NavItem[]}
 *
 * @overload
 * @param {string} zoneId       Идентификатор зоны
 * @param {object|null} navSet  NavCapabilitySet от /api/me/nav-capabilities (или null → fail-closed)
 * @returns {NavItem[]}
 */
export function visibleItems(groupOrZoneId, navSet) {
  // Compat path: called with {items:[]} group object (CommandPalette, T-0538 tests).
  if (groupOrZoneId && typeof groupOrZoneId === 'object') {
    return groupOrZoneId.items.filter((item) => !item.hidden);
  }
  // T-0539 path: called with (zoneId, navSet).
  const zoneId = groupOrZoneId;
  const visZones = visibleZones(navSet);
  if (!visZones.includes(zoneId)) return [];  // zone hidden entirely
  const zone = ZONES.find((z) => z.id === zoneId);
  if (!zone) return [];
  return zone.items
    .filter((it) => !it.hidden)
    .filter((it) => !it.ownerOnly || (navSet && navSet.isGenesisOwner));
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

// ============================================================================
// T-0539: capability-driven nav visibility helpers
// ============================================================================

/**
 * projectZones — ЕДИНСТВЕННОЕ место маппинга capability→зона (ADR §4.4 / §6).
 * Системно-фиксированный MVP-маппинг; зеркалит серверный projectZones в org.ts.
 *
 * @param {string[]} capabilities  набор capability-токенов актора
 * @param {boolean}  isGenesisOwner
 * @returns {string[]}  NavZoneId[]
 */
export function projectZones(capabilities, isGenesisOwner) {
  const caps = Array.isArray(capabilities) ? capabilities : [];
  const zones = ['work']; // пол: всегда
  if (isGenesisOwner || caps.includes('authoring_draft')) zones.push('constructor');
  if (isGenesisOwner || caps.some((c) => c === 'observability:read')) zones.push('observability');
  if (isGenesisOwner || caps.some((c) => c.startsWith('mgmt_object:'))) zones.push('admin');
  return zones;
}

/**
 * visibleZones — зоны, видимые актору, из NavCapabilitySet (ADR §5).
 * Fail-closed: нет данных / degraded → ['work'].
 *
 * @param {object|null|undefined} navSet  NavCapabilitySet | null
 * @returns {string[]}
 */
export function visibleZones(navSet) {
  if (!navSet) return ['work'];               // fail-closed: нет данных → только пол
  if (navSet.degraded) return ['work'];       // fail-closed: деградация → только пол
  if (navSet.zones && navSet.zones.length) return navSet.zones;
  return ['work'];
}

/**
 * canPublishDraft — T-0627: PRESENTATION-ONLY mirror of
 * src/db/sandbox-gate-dao.ts's resolveActorPrivilege (isOwnerOrAdmin ||
 * hasAuthoringDraftGrant), used SOLELY to decide which draft-sandbox banner
 * copy to show and whether to render the «Опубликовать» button — NEVER to
 * gate any read/write. The actual sandbox-gate decision stays entirely
 * server-side (src/core/sandbox-gate.ts), untouched by this helper.
 *
 * Fail-closed: no NavCapabilitySet (not yet resolved / degraded) → false
 * (no button shown) — never worse than omitting the affordance.
 *
 * @param {object|null|undefined} navSet  NavCapabilitySet | null
 * @returns {boolean}
 */
export function canPublishDraft(navSet) {
  if (!navSet || navSet.degraded) return false;
  if (navSet.isGenesisOwner) return true;
  const caps = Array.isArray(navSet.capabilities) ? navSet.capabilities : [];
  return caps.some((c) => c === 'authoring_draft' || c.startsWith('mgmt_object:'));
}

// ============================================================================
// T-0539: SCREEN_REGISTRY — реестр экранов (id → ScreenRegistryEntry)
// FF-SCREEN-DECL: каждый <Route> в shell.jsx обязан иметь запись с zone+capability.
// ============================================================================

/**
 * @typedef {Object} ScreenRegistryEntry
 * @property {string}           id
 * @property {NavZoneId|null}   zone        null только для home (overview)
 * @property {string|null}      capability  null только для zone:work / home
 * @property {NavAudience}      audience
 * @property {NavFrequency}     frequency
 * @property {number}           order
 * @property {string=}          path
 * @property {boolean=}         ownerOnly   только genesis-owner (T-0409)
 * @property {boolean=}         hidden
 */

/**
 * Реестр экранов — INDEX всех NavItem по id.
 * Проверяется CI-гардом ci/checks/ux/screen-registry-declares.sh:
 *   каждый <Route path=…> в shell.jsx → запись с непустым zone и capability
 *   (capability:null допустим ТОЛЬКО для zone:'work' и home).
 *
 * @type {Record<string, ScreenRegistryEntry>}
 */
export const SCREEN_REGISTRY = Object.fromEntries([
  // home — над зонами
  [NAV_HOME.id, { ...NAV_HOME, zone: null, capability: null }],
  // все пункты всех зон
  ...ZONES.flatMap((z) => z.items.map((item) => [item.id, { ...item }])),
]);
