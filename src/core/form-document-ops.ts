/**
 * src/core/form-document-ops.ts  (T-0656 · E-FORMS — machine seam)
 *
 * SERVER-SIDE PORT of web/src/forms/form-document-ops.js — the pure, React-free
 * MUTATION OPS over a form-document. These are the SAME operations the human
 * drag-n-drop editor drives the document with (insert / remove / reorder /
 * update / move); this module lets an AGENT (via POST /api/forms/document-ops)
 * reshape a form the exact same way a person does — "агент-сотрудник моделирует
 * форму как человек" (столп 2 / столп 4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A PORT, NOT A SHARED IMPORT (ADR-T0656 §4.1):
 *   tsconfig `rootDir: src` + the isolated web-build (web/ and src/ do NOT share
 *   a runtime bundle — a runtime import web→src breaks the container, proven on
 *   prior tasks) forbid importing web/src/forms/form-document-ops.js from server
 *   TS. The codebase's established answer is MIRRORING with a sync obligation +
 *   a CI/parity gate (exactly how binding-compat.ts mirrors field-contract.js,
 *   form-schema.ts mirrors form-defs.js). This file MUST stay behaviourally
 *   identical to web/src/forms/form-document-ops.js.
 *
 *   PARITY IS PROVEN, NOT ASSERTED: src/__tests__/form-document-ops-parity.test.ts
 *   runs the SAME op vectors through BOTH this module and the JS module and
 *   compares JSON.stringify — if one file is edited and the other is not, the
 *   test goes red. Edit one → edit the other.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Discipline (mirrors the JS module): ops NEVER touch process state — they only
 * reshape the declarative document. All ops clone the touched spine (structural
 * sharing of untouched subtrees) so the input document is never mutated.
 *
 * Path model: a node is addressed by an ARRAY PATH of segments from the root.
 * A segment is a NUMBER (child index of a plain container) or `{tab, index}`
 * (a child inside a tabs node's tab). `[]` is the root.
 */

// ---------------------------------------------------------------------------
// Types (structural — the document is plain JSON; the server does not need the
// full node vocabulary here, only the container/children shape the ops touch).
// ---------------------------------------------------------------------------

export interface FormNode {
  type: string;
  children?: FormNode[];
  tabs?: Array<{ title?: string; children?: FormNode[]; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface FormDoc {
  root: FormNode;
  [k: string]: unknown;
}

/** A path segment: a plain child index, or a tab-qualified child. */
export type PathSegment = number | { tab: number; index: number };
export type NodePath = PathSegment[];

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Shallow-clone a node (children handled by callers). */
function cloneNode(node: FormNode): FormNode {
  return { ...node };
}

/** Get the editable children array for a node + an optional tab index. */
function getChildren(node: FormNode, tabIndex?: number): FormNode[] {
  if (node.type === "tabs") {
    const tabs = Array.isArray(node.tabs) ? node.tabs : [];
    const t = tabs[tabIndex ?? 0];
    return Array.isArray(t?.children) ? (t!.children as FormNode[]) : [];
  }
  return Array.isArray(node.children) ? node.children : [];
}

/**
 * Return a copy of `node` with `nextChildren` set at the given location.
 * For tabs, `tabIndex` selects which tab's children to replace.
 */
function withChildren(node: FormNode, nextChildren: FormNode[], tabIndex?: number): FormNode {
  if (node.type === "tabs") {
    const tabs = Array.isArray(node.tabs) ? node.tabs.slice() : [];
    const ti = tabIndex ?? 0;
    const tab = { ...(tabs[ti] || { title: "", children: [] }), children: nextChildren };
    tabs[ti] = tab;
    return { ...node, tabs };
  }
  return { ...node, children: nextChildren };
}

/** Resolve the node at `path` (array of {index} or {tab,index}); root for []. */
export function nodeAtPath(doc: FormDoc, path: NodePath): FormNode | undefined {
  let node: FormNode | undefined = doc?.root;
  if (!node) return undefined;
  for (const seg of path) {
    if (!node) return undefined;
    if (typeof seg === "number") {
      node = getChildren(node)[seg];
    } else if (seg && typeof seg === "object") {
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
 */
function rebuildAtContainer(
  doc: FormDoc,
  containerPath: NodePath,
  transform: (children: FormNode[]) => FormNode[],
  tabIndex?: number,
): FormDoc {
  function recurse(node: FormNode, path: NodePath): FormNode {
    if (path.length === 0) {
      const kids = getChildren(node, tabIndex);
      return withChildren(cloneNode(node), transform(kids.slice()), tabIndex);
    }
    const [seg, ...rest] = path;
    const isTabSeg = seg && typeof seg === "object";
    const childIndex = isTabSeg ? (seg as { index: number }).index : (seg as number);
    const segTab = isTabSeg ? (seg as { tab: number }).tab : undefined;
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
export function insertNode(
  doc: FormDoc,
  containerPath: NodePath,
  node: FormNode,
  index?: number,
  tabIndex?: number,
): FormDoc {
  return rebuildAtContainer(doc, containerPath, (kids) => {
    const at = index === undefined || index === null ? kids.length : Math.max(0, Math.min(index, kids.length));
    kids.splice(at, 0, node);
    return kids;
  }, tabIndex);
}

/** Remove the child at `index` from the container at `containerPath`. */
export function removeNode(doc: FormDoc, containerPath: NodePath, index: number, tabIndex?: number): FormDoc {
  return rebuildAtContainer(doc, containerPath, (kids) => {
    kids.splice(index, 1);
    return kids;
  }, tabIndex);
}

/**
 * Move a child within the SAME container from `fromIndex` to `toIndex` (the
 * common drag-reorder case).
 */
export function reorderNode(
  doc: FormDoc,
  containerPath: NodePath,
  fromIndex: number,
  toIndex: number,
  tabIndex?: number,
): FormDoc {
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
 * `patch` (shallow). Never changes fieldKey implicitly.
 */
export function updateNode(
  doc: FormDoc,
  containerPath: NodePath,
  index: number,
  patch: Record<string, unknown>,
  tabIndex?: number,
): FormDoc {
  return rebuildAtContainer(doc, containerPath, (kids) => {
    if (index < 0 || index >= kids.length) return kids;
    kids[index] = { ...kids[index], ...patch };
    return kids;
  }, tabIndex);
}

/**
 * Move a node across containers: remove from `fromContainer[fromIndex]`, insert
 * into `toContainer` at `toIndex`. Implemented as remove+insert so the binding
 * is carried verbatim.
 */
export function moveNodeAcross(
  doc: FormDoc,
  fromContainer: NodePath,
  fromIndex: number,
  toContainer: NodePath,
  toIndex: number,
  fromTab?: number,
  toTab?: number,
): FormDoc {
  const moving = (() => {
    const container = nodeAtPath(doc, fromContainer);
    const kids = container ? getChildren(container, fromTab) : [];
    return kids[fromIndex];
  })();
  if (moving === undefined) return doc;
  const removed = removeNode(doc, fromContainer, fromIndex, fromTab);
  const adjustedTo = adjustPathAfterRemoval(fromContainer, fromIndex, fromTab, toContainer);
  let adjustedToIndex = toIndex;
  if (samePath(fromContainer, toContainer) && fromTab === toTab && typeof toIndex === "number" && toIndex > fromIndex) {
    adjustedToIndex = toIndex - 1;
  }
  return insertNode(removed, adjustedTo, moving, adjustedToIndex, toTab);
}

/** Structural equality of two numeric/segment paths. */
function samePath(a: NodePath, b: NodePath): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const sa = a[i];
    const sb = b[i];
    if (typeof sa === "number" || typeof sb === "number") {
      if (sa !== sb) return false;
    } else if (sa.tab !== sb.tab || sa.index !== sb.index) {
      return false;
    }
  }
  return true;
}

/**
 * Adjust a target path after a removal of `fromContainer[fromIndex]`.
 */
function adjustPathAfterRemoval(
  fromContainer: NodePath,
  fromIndex: number,
  fromTab: number | undefined,
  toContainer: NodePath,
): NodePath {
  if (fromContainer.length >= toContainer.length) return toContainer;
  for (let i = 0; i < fromContainer.length; i += 1) {
    if (!segEqual(fromContainer[i], toContainer[i])) return toContainer;
  }
  const seg = toContainer[fromContainer.length];
  const segIndex = typeof seg === "number" ? seg : seg.index;
  const segTab = typeof seg === "number" ? undefined : seg.tab;
  if (segTab === fromTab && segIndex > fromIndex) {
    const next = toContainer.slice();
    next[fromContainer.length] = typeof seg === "number" ? seg - 1 : { ...seg, index: seg.index - 1 };
    return next;
  }
  return toContainer;
}

function segEqual(a: PathSegment, b: PathSegment): boolean {
  if (typeof a === "number" || typeof b === "number") return a === b;
  return a.tab === b.tab && a.index === b.index;
}

// ---------------------------------------------------------------------------
// Builder conveniences (semantic sugar; no new core logic) — mirror JS module.
// ---------------------------------------------------------------------------

/**
 * moveNode — semantic sugar over moveNodeAcross for cross-container drag. Takes
 * ABSOLUTE node paths (containerPath + [index]) instead of split pairs.
 */
export function moveNode(doc: FormDoc, fromPath: NodePath, toPath: NodePath, fromTab?: number, toTab?: number): FormDoc {
  if (!Array.isArray(fromPath) || fromPath.length === 0) return doc;
  if (!Array.isArray(toPath) || toPath.length === 0) return doc;
  const fromContainer = fromPath.slice(0, -1);
  const fromSeg = fromPath[fromPath.length - 1];
  const toContainer = toPath.slice(0, -1);
  const toSeg = toPath[toPath.length - 1];
  const fromIndex = typeof fromSeg === "number" ? fromSeg : fromSeg.index;
  const toIndex = typeof toSeg === "number" ? toSeg : toSeg.index;
  const ft = fromTab !== undefined ? fromTab : typeof fromSeg === "object" ? fromSeg.tab : undefined;
  const tt = toTab !== undefined ? toTab : typeof toSeg === "object" ? toSeg.tab : undefined;
  return moveNodeAcross(doc, fromContainer, fromIndex, toContainer, toIndex, ft, tt);
}

/**
 * insertAt — insertNode with a REQUIRED index (drag into a specific slot).
 */
export function insertAt(doc: FormDoc, containerPath: NodePath, node: FormNode, index: number, tabIndex?: number): FormDoc {
  const at = typeof index === "number" ? index : 0;
  return insertNode(doc, containerPath, node, at, tabIndex);
}
