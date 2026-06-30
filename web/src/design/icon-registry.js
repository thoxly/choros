/**
 * web/src/design/icon-registry.js  (T-0531 — kit/token/icon adoption sweep)
 *
 * Source-of-truth for all KitIcon names.
 * Every value of `name` passed to <KitIcon name="…"> MUST be a key here.
 * Used by:
 *   - KitIcon dev-warn fallback (KNOWN_NAMES set)
 *   - Widget descriptor guard (FF-ICON-3): registerWidget() checks icon is in registry
 *   - Optional showcase auto-generation
 */
export const ICON_REGISTRY = {
  // ── kit-v1 originals ──────────────────────────────────────────────────────
  "close":           { label: "Закрыть",        since: "kit-v1", usedIn: ["Modal","Drawer","Toast","Button"] },
  "alert":           { label: "Предупреждение",  since: "kit-v1", usedIn: ["Toast"] },
  "error":           { label: "Ошибка",          since: "kit-v1", usedIn: ["ErrorState","Toast"] },
  "info":            { label: "Информация",      since: "kit-v1", usedIn: ["Toast"] },
  "success":         { label: "Успех",           since: "kit-v1", usedIn: ["Toast"] },
  "retry":           { label: "Повторить",       since: "kit-v1", usedIn: ["ErrorState"] },
  "inbox":           { label: "Входящие",        since: "kit-v1", usedIn: ["EmptyState"] },
  "plus":            { label: "Добавить",        since: "kit-v1", usedIn: ["Button","CollectionField"] },
  "chevron-down":    { label: "Раскрыть",        since: "kit-v1", usedIn: ["Select","Popover"] },
  // ── T-0531 additions ──────────────────────────────────────────────────────
  "star":            { label: "Избранное",       since: "T-0531", usedIn: [] },
  "star-outline":    { label: "Не закреплено",   since: "T-0531", usedIn: [] },
  "pencil":          { label: "Редактировать",   since: "T-0531", usedIn: [] },
  "trash":           { label: "Удалить",         since: "T-0531", usedIn: ["CollectionField"] },
  "arrow-up":        { label: "Вверх",           since: "T-0531", usedIn: [] },
  "arrow-down":      { label: "Вниз",            since: "T-0531", usedIn: [] },
  "arrow-left":      { label: "Назад",           since: "T-0531", usedIn: [] },
  "more-horizontal": { label: "Ещё",             since: "T-0531", usedIn: [] },
  "check":           { label: "Подтверждение",   since: "T-0531", usedIn: [] },
  "external-link":   { label: "Внешняя ссылка",  since: "T-0531", usedIn: [] },
  "search":          { label: "Поиск",           since: "T-0531", usedIn: [] },
  "chevron-up":      { label: "Свернуть",        since: "T-0531", usedIn: [] },
  "lock":            { label: "Заблокировано",   since: "T-0531", usedIn: [] },
};

/** Set of all known icon names — used by KitIcon dev-warn fallback. */
export const KNOWN_NAMES = new Set(Object.keys(ICON_REGISTRY));
