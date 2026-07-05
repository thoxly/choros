/**
 * web/src/forms/canvas-autoscroll.test.js  (T-0656)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { computeAutoscrollDelta, prefersReducedMotion, AUTOSCROLL_EDGE_PX, AUTOSCROLL_MAX_SPEED_PX } from './canvas-autoscroll.js';

const RECT = { top: 100, bottom: 500 };

describe('computeAutoscrollDelta', () => {
  it('returns 0 in the middle of the container (no autoscroll)', () => {
    expect(computeAutoscrollDelta(RECT, 300)).toBe(0);
  });

  it('returns a negative delta (scroll up) near the top edge', () => {
    const delta = computeAutoscrollDelta(RECT, RECT.top + 10);
    expect(delta).toBeLessThan(0);
  });

  it('returns a positive delta (scroll down) near the bottom edge', () => {
    const delta = computeAutoscrollDelta(RECT, RECT.bottom - 10);
    expect(delta).toBeGreaterThan(0);
  });

  it('speed increases the closer the cursor is to the edge', () => {
    const farFromEdge = computeAutoscrollDelta(RECT, RECT.top + AUTOSCROLL_EDGE_PX - 5);
    const nearEdge = computeAutoscrollDelta(RECT, RECT.top + 2);
    expect(Math.abs(nearEdge)).toBeGreaterThan(Math.abs(farFromEdge));
  });

  it('never exceeds the max speed', () => {
    const atEdge = computeAutoscrollDelta(RECT, RECT.top);
    expect(Math.abs(atEdge)).toBeLessThanOrEqual(AUTOSCROLL_MAX_SPEED_PX);
  });

  it('returns 0 when clientY is above the container entirely (not just near top edge)', () => {
    expect(computeAutoscrollDelta(RECT, RECT.top - 100)).toBe(0);
  });

  it('returns 0 when clientY is below the container entirely', () => {
    expect(computeAutoscrollDelta(RECT, RECT.bottom + 100)).toBe(0);
  });

  it('is a no-op with a missing rect or non-numeric clientY', () => {
    expect(computeAutoscrollDelta(null, 200)).toBe(0);
    expect(computeAutoscrollDelta(RECT, undefined)).toBe(0);
  });
});

describe('prefersReducedMotion', () => {
  afterEach(() => {
    delete globalThis.window;
  });

  it('returns false when there is no window / matchMedia (test/node env)', () => {
    expect(prefersReducedMotion()).toBe(false);
  });

  it('returns true when matchMedia reports the reduce preference', () => {
    globalThis.window = { matchMedia: (q) => ({ matches: q.includes('reduce') }) };
    expect(prefersReducedMotion()).toBe(true);
  });

  it('returns false when matchMedia reports no preference', () => {
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    expect(prefersReducedMotion()).toBe(false);
  });

  it('is defensive: matchMedia throwing does not blow up', () => {
    globalThis.window = { matchMedia: () => { throw new Error('boom'); } };
    expect(prefersReducedMotion()).toBe(false);
  });
});
