/* ============================================================================
   CHOROS — frame-height.js  (T-0101 + T-0250, browser ESM)
   Pure receivers for the two form sandbox-iframe postMessage channels:
     fjs-height  — auto-height resizing (T-0101)
     fjs-submit  — form field values for server POST (T-0250)

   The form runs inside an ISOLATED sandbox-iframe with an OPAQUE origin
   (`sandbox="allow-scripts"` WITHOUT `allow-same-origin`). The only way out is a
   `postMessage` channel — which the parent MUST validate, never trust blindly.
   This is the browser-side mirror of the canonical pure contract in
   `src/core/form-frame-height.ts` (unit-tested there; FF-FORMS2 keeps the two
   surfaces honest). Kept as a standalone copy because `web/**` is not bundled
   with `src/**`.

   Both functions share the same three-gate pattern (SI-2/SI-3):
     - source === the iframe's contentWindow                       (SI-2)
     - origin === 'null'  (opaque-origin sandbox signature)        (SI-2)
     - data.type matches the frozen message-shape literal           (SI-2/SI-3)
   ============================================================================ */

export const FRAME_MIN_HEIGHT = 280;
export const FRAME_MAX_HEIGHT = 20000;

// Frozen message-shape type literals (both channels).
// Changing either breaks the sandbox contract — keep together.
export const FRAME_HEIGHT_MESSAGE_TYPE = 'fjs-height';
export const FRAME_SUBMIT_MESSAGE_TYPE = 'fjs-submit';

/**
 * acceptFrameHeight — height channel gate (T-0101).
 * @param {MessageEvent|{source:any,origin:any,data:any}} evt
 * @param {Window} expectedSource  the iframe contentWindow we own
 * @returns {number|null} clamped height to apply, or null to ignore
 */
export function acceptFrameHeight(evt, expectedSource) {
  // SI-2: must come from the exact iframe window we mounted.
  if (!evt || expectedSource == null || evt.source !== expectedSource) return null;
  // SI-2: opaque origin only — a sandbox iframe without allow-same-origin posts
  // origin === "null". Any real origin is an origin-confusion attempt → reject.
  if (evt.origin !== 'null') return null;
  // SI-2: exact message shape.
  const data = evt.data;
  if (!data || data.type !== FRAME_HEIGHT_MESSAGE_TYPE) return null;
  const h = data.h;
  // SI-3: finite, non-negative number only.
  if (typeof h !== 'number' || !Number.isFinite(h) || h < 0) return null;
  // SI-3: clamp into [MIN, MAX] (anti-DoS on iframe size).
  return Math.min(FRAME_MAX_HEIGHT, Math.max(FRAME_MIN_HEIGHT, Math.ceil(h)));
}

/**
 * acceptFrameSubmit — submit channel gate (T-0250).
 * Twin of acceptFrameHeight for the fjs-submit postMessage channel.
 * Same three-gate (source + opaque-origin + shape), then returns the value
 * object so the parent can POST it to /api/forms/:formId/submit.
 *
 * @param {MessageEvent|{source:any,origin:any,data:any}} evt
 * @param {Window} expectedSource  the iframe contentWindow we own
 * @returns {Record<string,unknown>|null} the submitted field values, or null to ignore
 */
export function acceptFrameSubmit(evt, expectedSource) {
  // SI-2: source gate — must be the exact iframe we own.
  if (!evt || expectedSource == null || evt.source !== expectedSource) return null;
  // SI-2: opaque origin — sandbox without allow-same-origin.
  if (evt.origin !== 'null') return null;
  // SI-2: exact message shape.
  const data = evt.data;
  if (!data || data.type !== FRAME_SUBMIT_MESSAGE_TYPE) return null;
  // SI-3: value must be a plain object (not null, not array, not primitive).
  const value = data.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value;
}
