/**
 * src/core/form-document-op-apply.ts  (T-0656 · E-FORMS — machine seam)
 *
 * The op DISPATCHER for the agent/assistant machine seam: takes a plain JSON op
 * descriptor (the wire shape POST /api/forms/document-ops accepts) + the current
 * form-document, validates the op against a CLOSED vocabulary, and applies it
 * through the SAME pure ops (src/core/form-document-ops.ts) the human canvas
 * drives. Pure — no I/O, no DB — so the wire→op mapping is unit-testable and the
 * HTTP handler stays a thin auth/persist shell.
 *
 * Closed vocabulary (fail-closed, NOT silent no-op — ADR-T0656 §4.3 / F9):
 *   insert  { containerPath, node, index?, tabIndex? }
 *   remove  { containerPath, index, tabIndex? }
 *   reorder { containerPath, fromIndex, toIndex, tabIndex? }
 *   update  { containerPath, index, patch, tabIndex? }
 *   move    { fromPath, toPath, fromTab?, toTab? }
 * Unknown kind / malformed args → { ok:false, error } (→ HTTP 400 VALIDATION).
 */

import {
  insertNode,
  removeNode,
  reorderNode,
  updateNode,
  moveNode,
  type FormDoc,
  type FormNode,
  type NodePath,
  type PathSegment,
} from "./form-document-ops.js";

export type DocumentOpKind = "insert" | "remove" | "reorder" | "update" | "move";

export interface ApplyOk {
  ok: true;
  doc: FormDoc;
}
export interface ApplyErr {
  ok: false;
  error: string;
}
export type ApplyResult = ApplyOk | ApplyErr;

const OP_KINDS: ReadonlySet<string> = new Set<string>(["insert", "remove", "reorder", "update", "move"]);

// ---------------------------------------------------------------------------
// Wire-shape validators (defensive — the op comes from an agent over HTTP).
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A path segment is a non-negative int OR {tab:int, index:int}. */
function isPathSegment(v: unknown): v is PathSegment {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0;
  if (isPlainObject(v)) {
    return (
      Number.isInteger(v.tab) && (v.tab as number) >= 0 &&
      Number.isInteger(v.index) && (v.index as number) >= 0
    );
  }
  return false;
}

function isNodePath(v: unknown): v is NodePath {
  return Array.isArray(v) && v.every(isPathSegment);
}

function isNonEmptyNodePath(v: unknown): v is NodePath {
  return isNodePath(v) && v.length > 0;
}

function isFormNode(v: unknown): v is FormNode {
  return isPlainObject(v) && typeof v.type === "string" && v.type.length > 0;
}

function isTabIndex(v: unknown): v is number | undefined {
  return v === undefined || (Number.isInteger(v) && (v as number) >= 0);
}

// ---------------------------------------------------------------------------
// applyDocumentOp — the single entry point the HTTP handler calls.
// ---------------------------------------------------------------------------

/**
 * Apply one wire op to `doc`. Returns the new document or a validation error.
 * NEVER mutates `doc` (the underlying ops are immutable).
 *
 * @param doc the current form-document (form_binding.layout)
 * @param op  the wire op descriptor { kind, ...args }
 */
export function applyDocumentOp(doc: unknown, op: unknown): ApplyResult {
  if (!isPlainObject(doc) || !isPlainObject(doc.root)) {
    return { ok: false, error: "document must be an object with a root node" };
  }
  if (!isPlainObject(op)) {
    return { ok: false, error: "op must be an object" };
  }
  const kind = op.kind;
  if (typeof kind !== "string" || !OP_KINDS.has(kind)) {
    return { ok: false, error: `unknown op kind «${String(kind)}» (allowed: ${[...OP_KINDS].join(", ")})` };
  }

  const d = doc as unknown as FormDoc;

  switch (kind as DocumentOpKind) {
    case "insert": {
      if (!isNodePath(op.containerPath)) return { ok: false, error: "insert: containerPath must be a path array" };
      if (!isFormNode(op.node)) return { ok: false, error: "insert: node must be an object with a string type" };
      if (!(op.index === undefined || Number.isInteger(op.index))) return { ok: false, error: "insert: index must be an integer or omitted" };
      if (!isTabIndex(op.tabIndex)) return { ok: false, error: "insert: tabIndex must be a non-negative integer or omitted" };
      return { ok: true, doc: insertNode(d, op.containerPath, op.node, op.index as number | undefined, op.tabIndex as number | undefined) };
    }
    case "remove": {
      if (!isNodePath(op.containerPath)) return { ok: false, error: "remove: containerPath must be a path array" };
      if (!Number.isInteger(op.index)) return { ok: false, error: "remove: index must be an integer" };
      if (!isTabIndex(op.tabIndex)) return { ok: false, error: "remove: tabIndex must be a non-negative integer or omitted" };
      return { ok: true, doc: removeNode(d, op.containerPath, op.index as number, op.tabIndex as number | undefined) };
    }
    case "reorder": {
      if (!isNodePath(op.containerPath)) return { ok: false, error: "reorder: containerPath must be a path array" };
      if (!Number.isInteger(op.fromIndex)) return { ok: false, error: "reorder: fromIndex must be an integer" };
      if (!Number.isInteger(op.toIndex)) return { ok: false, error: "reorder: toIndex must be an integer" };
      if (!isTabIndex(op.tabIndex)) return { ok: false, error: "reorder: tabIndex must be a non-negative integer or omitted" };
      return { ok: true, doc: reorderNode(d, op.containerPath, op.fromIndex as number, op.toIndex as number, op.tabIndex as number | undefined) };
    }
    case "update": {
      if (!isNodePath(op.containerPath)) return { ok: false, error: "update: containerPath must be a path array" };
      if (!Number.isInteger(op.index)) return { ok: false, error: "update: index must be an integer" };
      if (!isPlainObject(op.patch)) return { ok: false, error: "update: patch must be an object" };
      if (!isTabIndex(op.tabIndex)) return { ok: false, error: "update: tabIndex must be a non-negative integer or omitted" };
      return { ok: true, doc: updateNode(d, op.containerPath, op.index as number, op.patch, op.tabIndex as number | undefined) };
    }
    case "move": {
      if (!isNonEmptyNodePath(op.fromPath)) return { ok: false, error: "move: fromPath must be a non-empty path array" };
      if (!isNonEmptyNodePath(op.toPath)) return { ok: false, error: "move: toPath must be a non-empty path array" };
      if (!isTabIndex(op.fromTab)) return { ok: false, error: "move: fromTab must be a non-negative integer or omitted" };
      if (!isTabIndex(op.toTab)) return { ok: false, error: "move: toTab must be a non-negative integer or omitted" };
      return { ok: true, doc: moveNode(d, op.fromPath, op.toPath, op.fromTab as number | undefined, op.toTab as number | undefined) };
    }
    default:
      // Unreachable given OP_KINDS gate, but keeps the switch exhaustive.
      return { ok: false, error: `unhandled op kind «${kind}»` };
  }
}

/** The closed op vocabulary — exported for the HTTP layer / tool descriptor. */
export const DOCUMENT_OP_KINDS: readonly DocumentOpKind[] = ["insert", "remove", "reorder", "update", "move"];
