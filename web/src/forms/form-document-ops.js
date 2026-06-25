/**
 * web/src/forms/form-document-ops.js  (T-0481 · E-FORMS F2)
 *
 * Pure, React-free MUTATION OPS over a form-document. These are the operations
 * the human drag-n-drop editor (FormDesigner.jsx) drives the document with —
 * insert, move, remove, update a node. Keeping them pure means:
 *   - the editor is a thin visual shell over a tested transformation layer;
 *   - the result is byte-stable / round-trip-safe (deliverable 2: the document a
 *     human assembles equals what a bot would emit for the same layout);
 *   - every op is unit-testable without React/DOM.
 *
 * Discipline: ops NEVER touch process state — they only reshape the declarative
 * document. The binding contract (fieldKey/subKey/displayField) is preserved
 * verbatim through moves; validateDocument (form-document.js) is the gate that
 * confirms the binding is still valid against the live schema after any edit.
 *
 * Path model: a node is addressed by an ARRAY PATH of child indices from the
 * root. `[]` is the root; `[0]` is root.children[0]; `[0,1]` is
 * root.children[0].children[1]. For `tabs` nodes the path segment encodes
 * `tab#child` (e.g. "t0#2") so a child inside a specific tab is addressable. All
 * ops clone the touched spine (structural sharing of untouched subtrees) so the
 * input document is never mutated.
 */

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Shallow-clone a node (children handled by callers). */
function cloneNode(node) {
  return { ...node };
}

/** Get the editable children array for a node + an optional tab index. */
function getChildren(node, tabIndex) {
  if (node.type === 'tabs') {
    const tabs = Array.isArray(node.tabs) ? node.tabs : [];
    const t = tabs[tabIndex];
    return Array.isArray(t?.children) ? t.children : [];
  }
  return Array.isArray(node.children) ? node.children : [];
}

/**
 * Return a deep-ish copy of `node` with `nextChildren` set at the given location.
 * For tabs, `tabIndex` selects which tab's children to replace.
 */
function withChildren(node, nextChildren, tabIndex) {
  if (node.type === 'tabs') {
    const tabs = Array.isArray(node.tabs) ? node.tabs.slice() : [];
    const ti = tabIndex ?? 0;
    const tab = { ...(tabs[ti] || { title: '', children: [] }), children: nextChildren };
    tabs[ti] = tab;
    return { ...node, tabs };
  }
  return { ...node, children: nextChildren };
}

/**
 * A container ref is `{ tabIndex?: number }`. A path is an array of segments;
 * each segment is either a number (child index of a plain container) or an
 * object `{ tab: number, index: number }` (a child inside a tabs node's tab).
 * To keep the editor simple, FormDesigner uses plain numeric paths for
 * section/columns and tab-qualified segments only when descending into tabs.
 */

/** Resolve the node at `path` (array of {index} or {tab,index}); root for []. */
export function nodeAtPath(doc, path) {
  let node = doc?.root;
  if (!node) return undefined;
  for (const seg of path) {
    if (!node) return undefined;
    if (typeof seg === 'number') {
      node = getChildren(node)[seg];
    } else if (seg && typeof seg === 'object') {
      node = getChildren(node, seg.tab)[seg.index];
    } else {
      return undefined;
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// Recursive rebuild helper
// ---------------------------------------------------------------------------

/**
 * Rebuild the tree applying `transform` to the children array of the container
 * addressed by `containerPath`. `transform(children) => nextChildren`.
 * containerPath addresses a CONTAINER node (section/columns/tabs or root[]).
 */
function rebuildAtContainer(doc, containerPath, transform, tabIndex) {
  function recurse(node, path) {
    if (path.length === 0) {
      const kids = getChildren(node, tabIndex);
      return withChildren(cloneNode(node), transform(kids.slice()), tabIndex);
    }
    const [seg, ...rest] = path;
    const isTabSeg = seg && typeof seg === 'object';
    const childIndex = isTabSeg ? seg.index : seg;
    const segTab = isTabSeg ? seg.tab : undefined;
    const kids = getChildren(node, segTab).slice();
    kids[childIndex] = recurse(kids[childIndex], rest);
    return withChildren(cloneNode(node), kids, segTab);
  }
  return { ...doc, root: recurse(doc.root, containerPath) };
}

// ---------------------------------------------------------------------------
// Public ops
// ---------------------------------------------------------------------------

/**
 * Insert `node` into the container at `containerPath` at position `index`
 * (default: end). Returns a NEW document; the input is untouched.
 */
export function insertNode(doc, containerPath, node, index, tabIndex) {
  return rebuildAtContainer(doc, containerPath, (kids) => {
    const at = (index === undefined || index === null) ? kids.length : Math.max(0, Math.min(index, kids.length));
    kids.splice(at, 0, node);
    return kids;
  }, tabIndex);
}

/** Remove the child at `index` from the container at `containerPath`. */
export function removeNode(doc, containerPath, index, tabIndex) {
  return rebuildAtContainer(doc, containerPath, (kids) => {
    kids.splice(index, 1);
    return kids;
  }, tabIndex);
}

/**
 * Move a child within the SAME container from `fromIndex` to `toIndex` (the
 * common drag-reorder case). For cross-container moves the editor does
 * remove+insert (two ops) to keep this op simple and obviously correct.
 */
export function reorderNode(doc, containerPath, fromIndex, toIndex, tabIndex) {
  return rebuildAtContainer(doc, containerPath, (kids) => {
    if (fromIndex < 0 || fromIndex >= kids.length) return kids;
    const [moved] = kids.splice(fromIndex, 1);
    const at = Math.max(0, Math.min(toIndex, kids.length));
    kids.splice(at, 0, moved);
    return kids;
  }, tabIndex);
}

/**
 * Update the child at `index` of the container at `containerPath` by merging
 * `patch` (shallow). Used for label/widget/mode edits — never changes fieldKey
 * implicitly (the caller is responsible for keeping the binding intact; a
 * fieldKey change is a structural Floor-2 op, not a Floor-1 relabel).
 */
export function updateNode(doc, containerPath, index, patch, tabIndex) {
  return rebuildAtContainer(doc, containerPath, (kids) => {
    if (index < 0 || index >= kids.length) return kids;
    kids[index] = { ...kids[index], ...patch };
    return kids;
  }, tabIndex);
}

/**
 * Move a node across containers: remove from `fromContainer[fromIndex]`, insert
 * into `toContainer` at `toIndex`. Implemented as remove+insert so the binding
 * is carried verbatim. Returns the new document.
 */
export function moveNodeAcross(doc, fromContainer, fromIndex, toContainer, toIndex, fromTab, toTab) {
  const moving = (() => {
    const container = nodeAtPath(doc, fromContainer);
    const kids = container ? getChildren(container, fromTab) : [];
    return kids[fromIndex];
  })();
  if (moving === undefined) return doc;
  const removed = removeNode(doc, fromContainer, fromIndex, fromTab);
  return insertNode(removed, toContainer, moving, toIndex, toTab);
}
