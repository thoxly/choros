/**
 * src/http/sla.ts
 *
 * Pure SLA state model (T-0095). The SERVER owns the deadline (epoch-ms, source of
 * truth); this module derives the live visual state — normal / warn / over — purely
 * as a function of (now, deadline, total-window). No wall-clock reads: `now` is always
 * injected by the caller (the server when materializing, the client tick on render),
 * which makes the boundaries deterministically testable.
 *
 * Threshold model (consistent across server + client):
 *   - over   : now >= deadline                 (past due)
 *   - warn   : deadline - warnWindow <= now < deadline   (approaching due)
 *   - normal : now <  deadline - warnWindow
 *
 * warnWindow = WARN_FRACTION of the task's total SLA window, clamped to
 * [WARN_FLOOR_MS, WARN_CEIL_MS] so very long SLAs don't warn days early and very
 * short ones still get a meaningful heads-up. This mirrors the pre-existing client
 * heuristic (warn at <=25% headroom) but anchors it to the real deadline.
 *
 * Zero dependencies — safe to import from both the server (TS) and, conceptually,
 * the web client (the JSX re-implements the SAME constants/formula; see
 * web/src/screens/screen-inbox.jsx SLACell — kept in lockstep with SLA_WARN_FRACTION).
 */

export type SlaState = "normal" | "warn" | "over";

/** Fraction of the total SLA window that counts as the "warn" zone before the deadline. */
export const SLA_WARN_FRACTION = 0.25;

/** Floor/ceiling on the warn window so the warn zone is neither trivially small nor huge. */
export const SLA_WARN_FLOOR_MS = 5 * 60_000; // never warn for less than 5 min
export const SLA_WARN_CEIL_MS = 60 * 60_000; // never warn earlier than 60 min out

const MIN_MS = 60_000;

/**
 * Width (ms) of the warn zone immediately preceding the deadline, derived from the
 * total SLA window (in minutes) and clamped. Pure; no clock.
 */
export function warnWindowMs(totalMin: number): number {
  const total = Number.isFinite(totalMin) && totalMin > 0 ? totalMin * MIN_MS : 0;
  const raw = total * SLA_WARN_FRACTION;
  return Math.min(SLA_WARN_CEIL_MS, Math.max(SLA_WARN_FLOOR_MS, raw));
}

/**
 * Compute the SLA visual state from an injected `now`.
 *   - `nowMs`     : current time (epoch-ms), injected by the caller — never read here.
 *   - `deadlineMs`: the task's due time (epoch-ms), the SERVER's source of truth.
 *   - `totalMin`  : the task's total SLA window in minutes (drives the warn threshold).
 *
 * Boundary semantics (deterministic):
 *   - exactly at the deadline (nowMs === deadlineMs) → "over"
 *   - exactly at the warn boundary (nowMs === deadlineMs - warnWindow) → "warn"
 */
export function slaState(nowMs: number, deadlineMs: number, totalMin: number): SlaState {
  if (!Number.isFinite(nowMs) || !Number.isFinite(deadlineMs)) return "normal";
  if (nowMs >= deadlineMs) return "over";
  if (nowMs >= deadlineMs - warnWindowMs(totalMin)) return "warn";
  return "normal";
}

/** Whole minutes of headroom remaining (negative once past due). Pure; rounds toward zero. */
export function remainingMin(nowMs: number, deadlineMs: number): number {
  return Math.trunc((deadlineMs - nowMs) / MIN_MS);
}
