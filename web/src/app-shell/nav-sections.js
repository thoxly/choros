/**
 * web/src/app-shell/nav-sections.js — T-0551 (E-NAV-IA) — РЕВЕРС T-0540.
 * Группировка приложений по РАЗДЕЛУ-СУЩНОСТИ (choros.section) для нав зоны РАБОТА.
 *
 * Раздел теперь — первоклассная сущность (ELMA-папка), а не строка app.section.
 * Группировка идёт по app.section_id; заголовок = section.name; порядок =
 * section.sort_order (ties → name). Приложения с section_id=null → «Без раздела»
 * (валидное состояние, не fallback-авария), всегда последним.
 *
 * Чистая функция без зависимостей: принимает массив приложений (GET /api/applications,
 * каждое несёт section_id + section_name) и опционально список разделов
 * (GET /api/sections, для порядка sort_order). Возвращает упорядоченные группы.
 *
 * FF-SECTIONS-FROM-ENTITY:   группы строятся из section_id, заголовок из section_name.
 * FF-SECTIONS-NOSECTION:     приложение с section_id=null → «Без раздела», не теряется.
 * FF-SECTIONS-EMPTY-HIDDEN:  пустой массив → пустой результат; нет групп-пустышек.
 * FF-SECTIONS-ORDER:         порядок из sort_order разделов (ties → name).
 */

/**
 * @typedef {{ id: string, slug: string, display_name: string, section_id?: string|null, section_name?: string|null, tier?: string }} NavApp
 * @typedef {{ id: string, name: string, sort_order?: number }} NavSection
 * @typedef {{ section_id: string|null, section: string, fallback: boolean, apps: NavApp[] }} NavAppSection
 */

/** Метка группы для приложений без раздела (раньше «Другое»; T-0551 → «Без раздела»). */
export const NO_SECTION_LABEL = 'Без раздела';

// Backward-compat alias (некоторый код/тесты могли импортировать старое имя).
export const FALLBACK_SECTION_LABEL = NO_SECTION_LABEL;

/**
 * Группирует приложения по разделу-сущности для нав зоны РАБОТА.
 *
 * Инварианты:
 * - Приложение с section_id=null → группа «Без раздела» (не теряется).
 * - Именованные группы упорядочены по sort_order раздела (ties → name, ru-локаль).
 *   Если список разделов не передан — порядок по name (ru).
 * - Группа «Без раздела» — всегда последней (если есть).
 * - Пустой массив → пустой результат (нет шума в нав).
 * - sum(result[].apps.length) === apps.length (нет потерь, нет дублей).
 *
 * @param {NavApp[]} apps        Массив приложений из GET /api/applications
 * @param {NavSection[]} [sections]  Разделы из GET /api/sections (для sort_order)
 * @returns {NavAppSection[]}
 */
export function groupAppsBySection(apps, sections) {
  if (!Array.isArray(apps) || apps.length === 0) return [];

  // sort_order lookup из переданных разделов (если есть).
  /** @type {Map<string, number>} */
  const orderById = new Map();
  if (Array.isArray(sections)) {
    for (const s of sections) {
      if (s && typeof s.id === 'string') {
        orderById.set(s.id, typeof s.sort_order === 'number' ? s.sort_order : 0);
      }
    }
  }

  /** @type {Map<string, { name: string, apps: NavApp[] }>} */
  const named = new Map();
  /** @type {NavApp[]} */
  const noSection = [];

  for (const app of apps) {
    const sid = app && typeof app.section_id === 'string' && app.section_id.length > 0
      ? app.section_id
      : null;
    if (sid) {
      if (!named.has(sid)) {
        // Имя раздела: из app.section_name (денормализовано в /api/applications) или из
        // списка разделов; запасной вариант — sid (никогда не должно случиться).
        const fromList = Array.isArray(sections)
          ? (sections.find((s) => s && s.id === sid) || null)
          : null;
        const name = (app.section_name && String(app.section_name)) ||
          (fromList && fromList.name) || sid;
        named.set(sid, { name, apps: [] });
      }
      named.get(sid).apps.push(app);
    } else {
      noSection.push(app);
    }
  }

  const result = [...named.entries()]
    .sort(([idA, a], [idB, b]) => {
      const oa = orderById.has(idA) ? orderById.get(idA) : 0;
      const ob = orderById.has(idB) ? orderById.get(idB) : 0;
      if (oa !== ob) return oa - ob;
      return a.name.localeCompare(b.name, 'ru');
    })
    .map(([sid, group]) => ({
      section_id: sid,
      section: group.name,
      fallback: false,
      apps: group.apps,
    }));

  if (noSection.length > 0) {
    result.push({ section_id: null, section: NO_SECTION_LABEL, fallback: true, apps: noSection });
  }

  return result;
}
