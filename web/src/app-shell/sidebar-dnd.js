/* ============================================================================
   web/src/app-shell/sidebar-dnd.js — T-0651 (sidebar-workspace) PURE,
   JSX-free helpers for the sidebar's drag-and-drop + ▲/▼ reorder logic.

   Mirrors the project's established split (kanban-board.js is the pure logic,
   .jsx is presentation — same doctrine as list-view-panel.js/apps-schema.js):
   this module decides WHAT a drop or an arrow-click means (which PATCH
   payload to send), the .jsx wires it to onDragStart/onDrop/onClick handlers.

   Two independent movements, both persisted via the SAME existing PATCH
   routes (ADR-T0651 §3/§4 — no new API invented):
     - APPLICATION move: within a section (reorder) or across sections
       (re-parent + reorder) -> PATCH /api/applications/:id { section_id?, sort_order }
     - SECTION move: reorder sections themselves (mirrors screen-sections.jsx's
       existing index-swap) -> PATCH /api/sections/:id { sort_order }

   ANTI-CASE (D-064/NF-5): entirely generic — no section/app names are
   hardcoded; every function operates on ids and index positions only.
   ============================================================================ */

/**
 * computeAppMove — given the sidebar's current nav-groups (as built by
 * groupAppsBySection) and a drag source/target, decide the minimal PATCH
 * payload(s) needed to realize the move.
 *
 * @param {Array<{section_id: string|null, apps: Array<{id, sort_order}>}>} groups
 *   the CURRENT rendered groups (in display order — output of groupAppsBySection)
 * @param {string} draggedAppId
 * @param {string|null} targetSectionId   the section_id of the group the app was dropped ON
 * @param {string|null} [beforeAppId]     optional: drop position — insert BEFORE this app id
 *   within the target group (undefined/null = append at the end of the target group)
 * @returns {Array<{ id: string, section_id?: string|null, sort_order: number }>}
 *   one or more PATCH payloads (application id + fields to send). Empty array
 *   means "no-op" (e.g. dropped onto its own unchanged position).
 */
export function computeAppMove(groups, draggedAppId, targetSectionId, beforeAppId) {
  if (!Array.isArray(groups) || !draggedAppId) return [];

  // Locate the dragged app + its current group.
  let sourceGroup = null;
  let draggedApp = null;
  for (const g of groups) {
    const found = (g.apps || []).find((a) => a.id === draggedAppId);
    if (found) { sourceGroup = g; draggedApp = found; break; }
  }
  if (!draggedApp) return [];

  const targetGroup = groups.find((g) => (g.section_id ?? null) === (targetSectionId ?? null));
  if (!targetGroup) return [];

  // Build the target group's app-id list WITHOUT the dragged app, then splice
  // it back in at the requested position (before `beforeAppId`, or at the end).
  const others = (targetGroup.apps || []).filter((a) => a.id !== draggedAppId);
  let insertAt = others.length;
  if (beforeAppId) {
    const idx = others.findIndex((a) => a.id === beforeAppId);
    if (idx >= 0) insertAt = idx;
  }
  const reordered = [...others.slice(0, insertAt), draggedApp, ...others.slice(insertAt)];

  // No-op check: same group, same resulting order.
  const sameGroup = sourceGroup && (sourceGroup.section_id ?? null) === (targetSectionId ?? null);
  const unchanged = sameGroup && reordered.every((a, i) => a.id === (targetGroup.apps || [])[i]?.id);
  if (unchanged) return [];

  // Assign fresh sequential sort_order (0..n-1) to every app in the target
  // group's new order — simplest correct scheme, mirrors screen-sections.jsx's
  // index-based normalization ("use index-based ordering so ties never
  // deadlock the swap").
  const payloads = reordered.map((a, i) => {
    const payload = { id: a.id, sort_order: i };
    if (a.id === draggedAppId && !sameGroup) payload.section_id = targetSectionId ?? null;
    return payload;
  });

  // Only send PATCHes for apps whose position or section actually changed
  // (avoid redundant writes for untouched siblings).
  return payloads.filter((p) => {
    const before = (targetGroup.apps || []).find((a) => a.id === p.id);
    if (!before) return true; // the dragged app itself, moving into this group
    return before.sort_order !== p.sort_order || 'section_id' in p;
  });
}

/**
 * computeArrowMove — the ▲/▼ keyboard-accessible equivalent for an
 * application: swap sort_order with the adjacent sibling WITHIN THE SAME
 * group (never changes section_id). Mirrors screen-sections.jsx's
 * `handleMove` for sections.
 *
 * @param {Array<{id, sort_order}>} appsInGroup  the CURRENT group's apps, in display order
 * @param {string} appId
 * @param {-1|1} dir  -1 = up, +1 = down
 * @returns {Array<{ id: string, sort_order: number }>}  0 or 2 PATCH payloads
 */
export function computeArrowMove(appsInGroup, appId, dir) {
  if (!Array.isArray(appsInGroup)) return [];
  const idx = appsInGroup.findIndex((a) => a.id === appId);
  const swapIdx = idx + dir;
  if (idx < 0 || swapIdx < 0 || swapIdx >= appsInGroup.length) return [];
  const a = appsInGroup[idx];
  const b = appsInGroup[swapIdx];
  return [
    { id: a.id, sort_order: swapIdx },
    { id: b.id, sort_order: idx },
  ];
}

/**
 * computeSectionArrowMove — ▲/▼ for sections themselves (identical shape to
 * screen-sections.jsx's existing handleMove; re-exported here as pure logic
 * so the sidebar's inline section list can share the exact same computation
 * instead of re-deriving it — single source of truth for "how do we swap two
 * ordered things by index").
 *
 * @param {Array<{id, sort_order}>} sections  in display order
 * @param {string} sectionId
 * @param {-1|1} dir
 * @returns {Array<{ id: string, sort_order: number }>}
 */
export function computeSectionArrowMove(sections, sectionId, dir) {
  return computeArrowMove(sections, sectionId, dir);
}

/**
 * computeSectionDrop — DnD for reordering sections against each other
 * (dropping section A's header onto section B's header). Same index-swap
 * semantics as the arrow-move, just triggered by a drop instead of a click —
 * moves the dragged section to sit immediately before the drop target and
 * renumbers everything in between (stable single-pass reindex, avoids the
 * "swap only adjacent" limitation of the arrow move).
 *
 * @param {Array<{id, sort_order}>} sections  in display order
 * @param {string} draggedSectionId
 * @param {string} targetSectionId
 * @returns {Array<{ id: string, sort_order: number }>}
 */
export function computeSectionDrop(sections, draggedSectionId, targetSectionId) {
  if (!Array.isArray(sections) || draggedSectionId === targetSectionId) return [];
  const without = sections.filter((s) => s.id !== draggedSectionId);
  const targetIdx = without.findIndex((s) => s.id === targetSectionId);
  if (targetIdx < 0) return [];
  const dragged = sections.find((s) => s.id === draggedSectionId);
  if (!dragged) return [];
  const reordered = [...without.slice(0, targetIdx), dragged, ...without.slice(targetIdx)];
  return reordered
    .map((s, i) => ({ id: s.id, sort_order: i }))
    .filter((p, i) => sections[i]?.id !== p.id || sections[i]?.sort_order !== p.sort_order);
}
