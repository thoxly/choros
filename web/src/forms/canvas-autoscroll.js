/**
 * web/src/forms/canvas-autoscroll.js  (T-0656 · E-FORMS canvas DnD polish)
 *
 * Pure, React-free autoscroll math for a drag over a scrollable canvas. Kept
 * separate from FormDesigner.jsx so the "how fast / which direction" decision
 * is unit-testable without mounting React or faking DOM drag events.
 *
 * The canvas hook (useCanvasAutoscroll in FormDesigner.jsx) calls
 * computeAutoscrollDelta(rect, clientY) on every dragover and, if it returns a
 * non-zero delta, drives a requestAnimationFrame loop that nudges
 * element.scrollTop by that delta each frame — the closer the cursor is to an
 * edge, the faster the scroll (never a fixed-speed “teleport”).
 */

/** Pixels from the top/bottom edge of the scroll container where autoscroll kicks in. */
export const AUTOSCROLL_EDGE_PX = 48;

/** Max scroll delta per animation frame (px), reached right at the edge. */
export const AUTOSCROLL_MAX_SPEED_PX = 18;

/**
 * True iff the user asked for reduced motion. The autoscroll caller uses this to
 * skip the continuous requestAnimationFrame loop (which IS the "motion") and
 * fall back to a single discrete scroll per dragover — the off-screen drop
 * target stays reachable, but nothing animates continuously. Guarded for
 * non-browser / test environments where matchMedia is absent.
 */
export function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Compute how many pixels to scroll THIS frame, given the scroll container's
 * bounding rect and the current drag cursor Y (viewport coordinates).
 *
 * @param {{top:number, bottom:number}} rect  container.getBoundingClientRect()
 * @param {number} clientY                    drag event clientY
 * @returns {number} signed delta: negative = scroll up, positive = scroll down, 0 = no scroll
 */
export function computeAutoscrollDelta(rect, clientY) {
  if (!rect || typeof clientY !== 'number') return 0;
  const distanceFromTop = clientY - rect.top;
  const distanceFromBottom = rect.bottom - clientY;

  if (distanceFromTop >= 0 && distanceFromTop < AUTOSCROLL_EDGE_PX) {
    const proximity = 1 - distanceFromTop / AUTOSCROLL_EDGE_PX; // 0..1, 1 = at the very edge
    return -Math.ceil(proximity * AUTOSCROLL_MAX_SPEED_PX);
  }
  if (distanceFromBottom >= 0 && distanceFromBottom < AUTOSCROLL_EDGE_PX) {
    const proximity = 1 - distanceFromBottom / AUTOSCROLL_EDGE_PX;
    return Math.ceil(proximity * AUTOSCROLL_MAX_SPEED_PX);
  }
  return 0;
}
