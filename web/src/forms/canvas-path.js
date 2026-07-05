/**
 * web/src/forms/canvas-path.js  (T-0656 · E-FORMS canvas DnD — path identity)
 *
 * Pure, React-free helpers for reasoning about container/insertion PATHS in the
 * form-builder canvas. Kept separate from FormDesigner.jsx so the load-bearing
 * "is this drag hovering inside THIS container?" decision is unit-testable —
 * and so a prefix-collision regression (a container at index 1 lighting up while
 * the drag is really inside container 10) can be asserted directly.
 *
 * PATH MODEL (mirrors form-document-ops.js): a container path is an array of
 * segments; each segment is a plain child index (number) or a tab-qualified
 * child `{ tab, index }`. A tabIndex may hang off the END of a path to select
 * which tab's children an insertion targets.
 *
 * WHY NOT string.startsWith: the earlier code compared CONCATENATED path strings
 * ("1" vs "10:0") with String.prototype.startsWith, which has no segment
 * boundary — "10:0".startsWith("1") === true → a false-positive highlight the
 * moment a form has 10+ sibling containers (or nested paths like [0,1] vs
 * [0,10]). The fix is STRUCTURAL: compare segment arrays element-by-element.
 */

/** True iff two path segments are structurally equal (number or {tab,index}). */
export function segmentsEqual(a, b) {
  const aNum = typeof a === 'number';
  const bNum = typeof b === 'number';
  if (aNum || bNum) return a === b;
  if (!a || !b) return false;
  return a.tab === b.tab && a.index === b.index;
}

/**
 * True iff `containerPath` is a PREFIX of `hoverPath` by SEGMENTS (not by string).
 * An exact match counts as a prefix (a container hovered at its own insertion
 * point IS "inside itself"). `[]` (root) is a prefix of every path.
 *
 * @param {Array} containerPath the container we're asking about
 * @param {Array} hoverPath     the container path currently under the drag
 */
export function isPrefixPath(containerPath, hoverPath) {
  if (!Array.isArray(containerPath) || !Array.isArray(hoverPath)) return false;
  if (containerPath.length > hoverPath.length) return false;
  for (let i = 0; i < containerPath.length; i += 1) {
    if (!segmentsEqual(containerPath[i], hoverPath[i])) return false;
  }
  return true;
}

/**
 * Decide whether a container node should highlight as the drop target, given the
 * canvas-wide hover state. A container highlights when the current drag hover is
 * INSIDE it — i.e. the container's own path is a segment-prefix of the hover
 * container path (same tab context). Root-level insertion points (hoverPath
 * `[]`) never highlight a specific container.
 *
 * @param {Array}  myContainerPath  the path OF the container node (its own children live here)
 * @param {Array|null} hoverPath    the container path under the drag, or null when nothing is hovered
 * @returns {boolean}
 */
export function containerIsDropTarget(myContainerPath, hoverPath) {
  if (!Array.isArray(hoverPath)) return false;
  // Root hover ([]) targets the canvas background, not any specific container.
  if (hoverPath.length === 0) return false;
  return isPrefixPath(myContainerPath, hoverPath);
}
