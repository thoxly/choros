/* ============================================================================
   web/src/screens/org-move-dnd.js — T-0655 (§6.4 + §1C) PURE, JSX-free helpers
   for the org-tree DRAG-AND-DROP + «Переместить в…» reassignment logic.

   Mirrors the project's established split (sidebar-dnd.js is the pure move-logic,
   the .jsx wires it to onDragStart/onDrop/onClick): this module decides WHAT a
   drop or a menu-choice MEANS (which PATCH payload to send to the T-0655 move-API
   PATCH /api/employees/:id), the .jsx only wires the DnD/menu handlers.

   Scope of the org-tree DnD (deliberately narrow — the safe, high-signal move):
     - EMPLOYEE reassignment: drag a person (leaf) onto a POSITION row → PATCH
       /api/employees/:id { position_id }. Dropping onto a department (which has
       no single position) is a no-op — the accessible «Переместить в…» menu is
       the path for choosing an explicit target position.
   Department/position REPARENT is done via the «Переместить в…»/«Переименовать»
   menu (buttons), not DnD, because their targets are not single tree rows.

   ANTI-CASE (D-064/NF-5): entirely generic — no department/position/person names
   are hardcoded; every function operates on ids/slugs only.
   ============================================================================ */

/**
 * computeEmployeeDrop — given a dragged employee (by its tree slug) and the
 * drop-target position (by its tree slug), plus the slug→uuid maps from
 * tenant-state, produce the PATCH payload for the move — or null for a no-op
 * (dropped onto its own current position, or an unresolvable id).
 *
 * @param {object} args
 * @param {string} args.employeeSlug     tree id of the dragged person (person.id == slug)
 * @param {string|null} args.fromPositionSlug  the position slug the person is CURRENTLY under (for no-op check)
 * @param {string} args.toPositionSlug   tree id (slug) of the drop-target position row
 * @param {object} args.idMaps           { employees: {slug:uuid}, positions: {slug:uuid} }
 * @returns {{ employeeId: string, body: { position_id: string } } | null}
 *   employeeId is the UUID for the PATCH path; body is the request body (tenant_id
 *   is added by the caller). null = no-op / cannot resolve → don't fire a request.
 */
export function computeEmployeeDrop({ employeeSlug, fromPositionSlug, toPositionSlug, idMaps }) {
  if (!employeeSlug || !toPositionSlug) return null;
  // No-op: dropped onto the position it already sits in.
  if (fromPositionSlug && fromPositionSlug === toPositionSlug) return null;

  const employeeId = idMaps?.employees?.[employeeSlug];
  const positionId = idMaps?.positions?.[toPositionSlug];
  // Both ids must resolve from tenant-state; otherwise we'd guess a uuid — refuse.
  if (!employeeId || !positionId) return null;

  return { employeeId, body: { position_id: positionId } };
}

/**
 * computeMoveEmployeeToPosition — the accessible «Переместить в…» equivalent:
 * the user picks a target position UUID directly (from the tenant-state select),
 * so no slug→uuid resolution of the target is needed; only the employee uuid.
 *
 * @param {string} employeeId  employee UUID (already resolved by the caller)
 * @param {string|null} toPositionId  target position UUID, or null = снять с должности
 * @returns {{ body: { position_id: string | null } }}
 */
export function computeMoveEmployeeToPosition(employeeId, toPositionId) {
  return { body: { position_id: toPositionId ?? null } };
}

/**
 * buildRenamePayload — «Переименовать» for any org entity. The move-API PATCH
 * routes accept a rename field whose NAME differs per entity:
 *   department → display_name ; position → title ; employee → display_name.
 * Returns the correct single-field body for the given entity kind (empty object
 * for an unknown kind — the caller then no-ops).
 *
 * @param {"department"|"position"|"employee"} kind
 * @param {string} newName
 * @returns {Record<string, string>}
 */
export function buildRenamePayload(kind, newName) {
  const trimmed = (newName ?? '').trim();
  if (!trimmed) return {};
  if (kind === 'position') return { title: trimmed };
  if (kind === 'department' || kind === 'employee') return { display_name: trimmed };
  return {};
}

/** The PATCH endpoint path segment for each org entity kind. */
export const MOVE_ENDPOINT = {
  department: 'departments',
  position: 'positions',
  employee: 'employees',
};
