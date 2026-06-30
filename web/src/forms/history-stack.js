/**
 * web/src/forms/history-stack.js  (T-0544 · E-FORMS — canvas undo/redo)
 *
 * Pure, React-free undo/redo over surface/form documents (T-0544 design §5).
 * The builder holds ONE HistoryStack in state; `present` is the live document.
 * Every doc-op pushes a new present (clearing redo); Ctrl+Z / Ctrl+Y walk the
 * stack. Pure → unit-testable without React.
 *
 *   interface HistoryStack { past: Doc[]; present: Doc; future: Doc[] }
 */

export const MAX_HISTORY = 50;

/** Start a history stack at `doc`. */
export function initHistory(doc) {
  return { past: [], present: doc, future: [] };
}

/**
 * Push `next` as the new present. The old present moves to `past` (capped at
 * MAX_HISTORY-1 prior entries); `future` is cleared (a new edit forks the
 * redo branch). If `next` is referentially the same as present, no-op.
 */
export function pushHistory(stack, next) {
  if (next === stack.present) return stack;
  const past = [...stack.past, stack.present];
  const trimmed = past.length > MAX_HISTORY ? past.slice(past.length - MAX_HISTORY) : past;
  return { past: trimmed, present: next, future: [] };
}

/** Undo: present → future head, past tail → present. Null if nothing to undo. */
export function undo(stack) {
  if (stack.past.length === 0) return null;
  const past = stack.past.slice(0, -1);
  const present = stack.past[stack.past.length - 1];
  const future = [stack.present, ...stack.future];
  return { past, present, future };
}

/** Redo: future head → present, present → past tail. Null if nothing to redo. */
export function redo(stack) {
  if (stack.future.length === 0) return null;
  const [present, ...future] = stack.future;
  const past = [...stack.past, stack.present];
  return { past, present, future };
}

export function canUndo(stack) {
  return !!stack && stack.past.length > 0;
}

export function canRedo(stack) {
  return !!stack && stack.future.length > 0;
}
