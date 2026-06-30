/**
 * web/src/app-shell/nav-sections.js — T-0540 (E-NAV-IA / Ф3)
 * Группировка приложений по полю `section` для нав зоны РАБОТА.
 *
 * Чистая функция без зависимостей: принимает массив приложений из
 * GET /api/applications, возвращает упорядоченные секции.
 *
 * FF-SECTIONS-FROM-DATA: секции строятся из данных app.section, не хардкода.
 * FF-SECTIONS-FALLBACK: приложение с section=null не теряется → fallback «Другое».
 * FF-SECTIONS-EMPTY-HIDDEN: пустой массив → пустой результат; нет секций-пустышек.
 */

/**
 * @typedef {{ id: string, slug: string, display_name: string, section: string|null, tier?: string }} NavApp
 * @typedef {{ section: string, fallback: boolean, apps: NavApp[] }} NavAppSection
 */

/** Метка fallback-секции для приложений без раздела. */
export const FALLBACK_SECTION_LABEL = 'Другое';

/**
 * Группирует приложения по полю `section` для нав зоны РАБОТА.
 *
 * Инварианты:
 * - Приложение с section=null попадает в fallback-секцию «Другое» (не теряется).
 * - Именованные секции сортируются по алфавиту (ru-локаль).
 * - Fallback-секция — всегда последней (если есть).
 * - Пустой массив → пустой результат (нет шума в нав).
 * - sum(result[].apps.length) === apps.length (нет потерь, нет дублей).
 *
 * @param {NavApp[]} apps  Массив приложений из GET /api/applications
 * @returns {NavAppSection[]}
 */
export function groupAppsBySection(apps) {
  if (!Array.isArray(apps) || apps.length === 0) return [];

  /** @type {Map<string, NavApp[]>} */
  const named = new Map();
  /** @type {NavApp[]} */
  const fallback = [];

  for (const app of apps) {
    if (app.section && typeof app.section === 'string' && app.section.trim().length > 0) {
      if (!named.has(app.section)) named.set(app.section, []);
      named.get(app.section).push(app);
    } else {
      fallback.push(app);
    }
  }

  const result = [...named.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'ru'))
    .map(([section, sectionApps]) => ({ section, fallback: false, apps: sectionApps }));

  if (fallback.length > 0) {
    result.push({ section: FALLBACK_SECTION_LABEL, fallback: true, apps: fallback });
  }

  return result;
}
