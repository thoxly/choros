/* ============================================================================
   web/src/app-shell/sidebar-app-menu.js — T-0651 (sidebar-workspace)

   Declarative item list for the sidebar's application context menu ("⋯" next
   to an app name inside a section group). A DELIBERATE SUBSET of
   screen-apps.jsx's buildAppMenuItems (T-0567) — the sidebar is a navigation
   surface, not the full "управление приложением" screen, so destructive
   (Удалить) and publish actions stay on /apps where their confirm-dialogs and
   consequences already live (spec T-0651 §1: "контекст-меню приложения
   (Переименовать / В раздел → / Настроить поля) на месте").

   Pure + no hooks (same "logic in a testable sibling" doctrine as
   buildAppMenuItems) — order/labels are unit-testable without React.
   ============================================================================ */

/**
 * @param {{id: string, display_name: string}} app
 * @param {{ openRename: () => void, openSection: () => void, navigate: (path: string) => void }} actions
 * @returns {Array<{ key: string, label: string, run: () => void }>}
 */
export function buildSidebarAppMenuItems(app, actions) {
  return [
    { key: 'rename',  label: 'Переименовать',       run: () => actions.openRename() },
    { key: 'section', label: 'В раздел →',           run: () => actions.openSection() },
    { key: 'schema',  label: 'Настроить поля',       run: () => actions.navigate(`/app-schema/${app.id}`) },
  ];
}
