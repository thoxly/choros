/* ============================================================================
   CHOROS — form-frame-height.ts  (T-0101)
   Pure, IO-free receiver for the form sandbox-iframe auto-height channel.

   The form executes inside an ISOLATED sandbox-iframe with an OPAQUE origin
   (`sandbox="allow-scripts"` WITHOUT `allow-same-origin`). The only seam out of
   that isolation is a `postMessage` height channel: the form posts its content
   height, the parent resizes the iframe.

   That seam MUST NOT be trusted blindly — any frame/extension can spam
   `message` events. This module is the single source of truth for whether a
   height message is acceptable and what height to apply. It is pure (no DOM, no
   `window`) so it is unit-testable; both the React `FormViewer.jsx` and the
   vanilla `web/preview/forms.html` validate origin/source the same way (the
   browser-side `web/src/forms/frame-height.js` mirrors this contract; the
   FF-FORMS2 fitness gate keeps the two surfaces honest).

   SECURITY INVARIANTS:
   - SI-2: a height is accepted ONLY when the message comes from the expected
     iframe window (`source === expectedSource`) AND from the opaque origin
     (`origin === 'null'`) AND has the exact `{type:'fjs-height', h}` shape.
   - SI-3: the height is clamped to [FRAME_MIN_HEIGHT, FRAME_MAX_HEIGHT]; a
     non-finite / negative / non-numeric height is rejected (anti-DoS: a
     compromised form cannot blow the iframe up to an arbitrary size).
   ============================================================================ */

export const FRAME_MIN_HEIGHT = 280;
export const FRAME_MAX_HEIGHT = 20000;

/** The single message type the parent accepts from the sandboxed form. */
export const FRAME_HEIGHT_MESSAGE_TYPE = 'fjs-height' as const;

/** A MessageEvent-like shape (kept structural so this module needs no DOM lib). */
export interface FrameHeightEventLike {
  /** The window that posted the message (compared against the iframe window). */
  source?: unknown;
  /** Posting origin. For an opaque-origin sandbox iframe this is the string "null". */
  origin?: unknown;
  /** The message payload. */
  data?: unknown;
}

/**
 * Validate an incoming `message` event against the auto-height contract and
 * return the clamped height to apply, or `null` to ignore the message.
 *
 * @param evt            MessageEvent-like object (`{ source, origin, data }`).
 * @param expectedSource The `contentWindow` of the iframe we own.
 * @returns clamped height in [FRAME_MIN_HEIGHT, FRAME_MAX_HEIGHT], or null.
 */
export function acceptFrameHeight(
  evt: FrameHeightEventLike | null | undefined,
  expectedSource: unknown,
): number | null {
  // SI-2: must come from the exact iframe window we mounted.
  if (!evt || expectedSource == null || evt.source !== expectedSource) return null;
  // SI-2: opaque origin only. A sandbox iframe without allow-same-origin posts
  // origin === "null". Any real origin (a sibling frame, an extension, an
  // origin-confusion attempt) is rejected.
  if (evt.origin !== 'null') return null;
  // SI-2: exact message shape.
  const data = evt.data as { type?: unknown; h?: unknown } | null | undefined;
  if (!data || data.type !== FRAME_HEIGHT_MESSAGE_TYPE) return null;
  const h = data.h;
  // SI-3: finite, non-negative number only.
  if (typeof h !== 'number' || !Number.isFinite(h) || h < 0) return null;
  // SI-3: clamp into [MIN, MAX].
  return Math.min(FRAME_MAX_HEIGHT, Math.max(FRAME_MIN_HEIGHT, Math.ceil(h)));
}
