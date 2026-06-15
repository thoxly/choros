/* ============================================================================
   CHOROS — frame-height.js  (T-0101, browser ESM)
   Pure receiver for the form sandbox-iframe auto-height postMessage channel.

   The form runs inside an ISOLATED sandbox-iframe with an OPAQUE origin
   (`sandbox="allow-scripts"` WITHOUT `allow-same-origin`). The only way out is a
   `postMessage` height channel — which the parent MUST validate, never trust
   blindly. This is the browser-side mirror of the canonical pure contract in
   `src/core/form-frame-height.ts` (unit-tested there; FF-FORMS2 keeps the two
   surfaces honest). Kept as a standalone copy because `web/**` is not bundled
   with `src/**`.

   Accept a height ONLY when:
     - source === the iframe's contentWindow                       (SI-2)
     - origin === 'null'  (opaque-origin sandbox signature)        (SI-2)
     - data === { type: 'fjs-height', h: <finite, >= 0 number> }   (SI-2/SI-3)
   then clamp into [FRAME_MIN_HEIGHT, FRAME_MAX_HEIGHT]            (SI-3, anti-DoS)
   ============================================================================ */

export const FRAME_MIN_HEIGHT = 280;
export const FRAME_MAX_HEIGHT = 20000;
export const FRAME_HEIGHT_MESSAGE_TYPE = 'fjs-height';

/**
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
