/* ============================================================================
   T-0101 — unit tests for the form sandbox-iframe auto-height receiver.
   Verifies the SI-2 (origin/source/shape) and SI-3 (clamp/finite) invariants.
   ============================================================================ */

import { describe, it, expect } from 'vitest';
import {
  acceptFrameHeight,
  FRAME_MIN_HEIGHT,
  FRAME_MAX_HEIGHT,
  FRAME_HEIGHT_MESSAGE_TYPE,
} from '../core/form-frame-height.js';

// A distinct sentinel standing in for an iframe contentWindow.
const IFRAME = { id: 'the-iframe-window' };
const OTHER = { id: 'some-other-window' };

function evt(over: Record<string, unknown> = {}) {
  return {
    source: IFRAME,
    origin: 'null',
    data: { type: FRAME_HEIGHT_MESSAGE_TYPE, h: 600 },
    ...over,
  };
}

describe('acceptFrameHeight — SI-2 (origin/source/shape)', () => {
  it('accepts a well-formed message from the expected opaque-origin iframe', () => {
    expect(acceptFrameHeight(evt(), IFRAME)).toBe(600);
  });

  it('rejects a message from a DIFFERENT window (source mismatch)', () => {
    expect(acceptFrameHeight(evt({ source: OTHER }), IFRAME)).toBeNull();
  });

  it('rejects a message whose origin is NOT the opaque "null" origin', () => {
    expect(acceptFrameHeight(evt({ origin: 'https://evil.example' }), IFRAME)).toBeNull();
    expect(acceptFrameHeight(evt({ origin: 'https://app.choros' }), IFRAME)).toBeNull();
    expect(acceptFrameHeight(evt({ origin: '' }), IFRAME)).toBeNull();
  });

  it('rejects a message of the wrong type', () => {
    expect(acceptFrameHeight(evt({ data: { type: 'evil', h: 600 } }), IFRAME)).toBeNull();
    expect(acceptFrameHeight(evt({ data: { h: 600 } }), IFRAME)).toBeNull();
  });

  it('rejects null/undefined event or missing expectedSource', () => {
    expect(acceptFrameHeight(null, IFRAME)).toBeNull();
    expect(acceptFrameHeight(undefined, IFRAME)).toBeNull();
    expect(acceptFrameHeight(evt(), null)).toBeNull();
    expect(acceptFrameHeight(evt(), undefined)).toBeNull();
  });

  it('rejects a message with no data', () => {
    expect(acceptFrameHeight(evt({ data: null }), IFRAME)).toBeNull();
    expect(acceptFrameHeight(evt({ data: undefined }), IFRAME)).toBeNull();
  });
});

describe('acceptFrameHeight — SI-3 (clamp / finite)', () => {
  it('clamps to FRAME_MIN_HEIGHT when content is shorter', () => {
    expect(acceptFrameHeight(evt({ data: { type: FRAME_HEIGHT_MESSAGE_TYPE, h: 10 } }), IFRAME)).toBe(
      FRAME_MIN_HEIGHT,
    );
    expect(acceptFrameHeight(evt({ data: { type: FRAME_HEIGHT_MESSAGE_TYPE, h: 0 } }), IFRAME)).toBe(
      FRAME_MIN_HEIGHT,
    );
  });

  it('clamps to FRAME_MAX_HEIGHT (anti-DoS) when a form posts an absurd height', () => {
    expect(
      acceptFrameHeight(evt({ data: { type: FRAME_HEIGHT_MESSAGE_TYPE, h: 1e9 } }), IFRAME),
    ).toBe(FRAME_MAX_HEIGHT);
    expect(
      acceptFrameHeight(evt({ data: { type: FRAME_HEIGHT_MESSAGE_TYPE, h: FRAME_MAX_HEIGHT + 1 } }), IFRAME),
    ).toBe(FRAME_MAX_HEIGHT);
  });

  it('ceils a fractional height inside the band', () => {
    expect(
      acceptFrameHeight(evt({ data: { type: FRAME_HEIGHT_MESSAGE_TYPE, h: 600.2 } }), IFRAME),
    ).toBe(601);
  });

  it('rejects non-finite / negative / non-numeric heights', () => {
    for (const bad of [NaN, Infinity, -Infinity, -1, '600', null, undefined, {}]) {
      expect(
        acceptFrameHeight(evt({ data: { type: FRAME_HEIGHT_MESSAGE_TYPE, h: bad } }), IFRAME),
      ).toBeNull();
    }
  });

  it('MIN < MAX and both are sane bounds', () => {
    expect(FRAME_MIN_HEIGHT).toBeGreaterThan(0);
    expect(FRAME_MAX_HEIGHT).toBeGreaterThan(FRAME_MIN_HEIGHT);
  });
});
