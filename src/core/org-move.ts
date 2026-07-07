/**
 * src/core/org-move.ts — T-0655 [W5-UX / ux-study §6.4 + §1C]
 *
 * PURE, DB-free helpers for the org-structure MOVE-API (PATCH department/position/
 * employee — reparent + rename). Mirrors the project's established split
 * (sidebar-dnd.js is the pure move-logic, the .ts/.jsx wires it to the DB / DOM):
 * this module decides WHAT a department reparent means for cycle-safety and
 * WHICH audit-diff a move produced — never touches Postgres.
 *
 * THE CYCLE PROBLEM (ADR 014_department.sql §1.1): the department tree is an
 * adjacency list with an application-layer cycle guard ("ancestor walk before
 * UPDATE parent_id"). A reparent PATCH must reject making a department a
 * descendant of itself — directly (parent == self) or transitively (the chosen
 * new parent already lives in the moved node's own subtree). We reuse the SAME
 * parent-map the ancestry oracle is built from (a Map<id, parentId|null>), so
 * this guard and the grant-lattice ancestry oracle read identical topology.
 *
 * ANTI-CASE (D-064 / NF-5): entirely generic — no department/position names are
 * hardcoded; every function operates on ids and parent-map topology only.
 */

// ---------------------------------------------------------------------------
// Department cycle guard
// ---------------------------------------------------------------------------

/**
 * wouldCreateCycle — would setting department `movingId`'s parent to `newParentId`
 * create a cycle in the adjacency tree described by `parentOf`?
 *
 * @param parentOf  Map<departmentId, parentId|null> — the tenant's CURRENT tree
 *                  (before the move). Roots map to null.
 * @param movingId  the department being reparented.
 * @param newParentId  the proposed new parent (null = make it a root — never a cycle).
 * @returns true iff the move would introduce a cycle (self-parent, or the new
 *          parent is `movingId` itself or any of its descendants).
 *
 * Method: a department D can legally become the parent of `movingId` ONLY if D is
 * NOT in `movingId`'s subtree. Equivalently: walking UP from `newParentId` via
 * `parentOf` must never reach `movingId`. (If newParentId === movingId that walk
 * hits movingId immediately → cycle.) The walk is bounded by a visited-set so a
 * pre-existing corrupt cycle in the data cannot spin forever.
 */
export function wouldCreateCycle(
  parentOf: Map<string, string | null>,
  movingId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return false; // becoming a root is always safe
  if (newParentId === movingId) return true; // self-parent

  // Walk UP the ancestor chain from newParentId. If we ever reach movingId, the
  // proposed parent is inside movingId's subtree → cycle.
  const seen = new Set<string>();
  let cursor: string | null = newParentId;
  while (cursor !== null) {
    if (cursor === movingId) return true;
    if (seen.has(cursor)) break; // guard against a pre-existing corrupt cycle
    seen.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Move-patch normalization (shared shape across the three entities)
// ---------------------------------------------------------------------------

/**
 * A validated org-move patch: which fields the caller actually wants to change.
 * `undefined` = field absent from the request (leave unchanged). For the
 * reparent field, an explicit `null` is a MEANINGFUL value (department → root;
 * employee → no position). department_id/position_id for position/employee moves
 * are NON-null (a position always belongs to a department; but an employee's
 * position_id may be null = "снять с должности").
 */
export interface DeptMovePatch {
  parent_id?: string | null;
  display_name?: string;
}
export interface PositionMovePatch {
  department_id?: string;
  title?: string;
}
export interface EmployeeMovePatch {
  position_id?: string | null;
  display_name?: string;
}

/**
 * isEmptyPatch — true iff the patch changes nothing (no key present). Callers
 * reject an empty patch with 400 rather than issuing a no-op UPDATE + audit event
 * that records "nothing changed".
 */
export function isEmptyPatch(patch: object): boolean {
  return Object.keys(patch).length === 0;
}

// ---------------------------------------------------------------------------
// Audit-diff builders — what a move actually changed (for the *.moved payload)
// ---------------------------------------------------------------------------

/**
 * buildDeptMoveDiff — the audit payload for department.moved: the before/after of
 * whatever the patch touched, plus a `renamed` flag. Only fields present in the
 * patch appear in the diff (so the audit trail records the real delta, not noise).
 */
export function buildDeptMoveDiff(
  before: { parent_id: string | null; display_name: string },
  patch: DeptMovePatch,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  if ("parent_id" in patch) {
    diff["from_parent_id"] = before.parent_id;
    diff["to_parent_id"] = patch.parent_id ?? null;
  }
  if (patch.display_name !== undefined) {
    diff["from_name"] = before.display_name;
    diff["to_name"] = patch.display_name;
    diff["renamed"] = true;
  }
  return diff;
}

export function buildPositionMoveDiff(
  before: { department_id: string; title: string },
  patch: PositionMovePatch,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  if (patch.department_id !== undefined) {
    diff["from_department_id"] = before.department_id;
    diff["to_department_id"] = patch.department_id;
  }
  if (patch.title !== undefined) {
    diff["from_title"] = before.title;
    diff["to_title"] = patch.title;
    diff["renamed"] = true;
  }
  return diff;
}

export function buildEmployeeMoveDiff(
  before: { position_id: string | null; display_name: string },
  patch: EmployeeMovePatch,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  if ("position_id" in patch) {
    diff["from_position_id"] = before.position_id;
    diff["to_position_id"] = patch.position_id ?? null;
  }
  if (patch.display_name !== undefined) {
    diff["from_name"] = before.display_name;
    diff["to_name"] = patch.display_name;
    diff["renamed"] = true;
  }
  return diff;
}
