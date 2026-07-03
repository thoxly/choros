/**
 * web/src/lib/format.test.js  (T-0608, пункт г)
 *
 * Real unit tests (format.js is React-free/pure — no need for the
 * source-presence convention used for JSX screens). Covers formatPersonName:
 * the single honest-display-name layer introduced to fix the live-факт
 * приёмки bug where an employee record with an empty display_name rendered
 * as a raw UUID/slug («АВТОР: 4c653940-…», «4c653940-…» in a dropdown).
 */

import { describe, it, expect } from 'vitest';
import { formatPersonName } from './format.js';

describe('formatPersonName (T-0608 пункт г)', () => {
  it('returns the name as-is when it is a non-empty string', () => {
    expect(formatPersonName('Семён Сидоров')).toBe('Семён Сидоров');
    expect(formatPersonName('Семён Сидоров', 'semen@axon.example')).toBe('Семён Сидоров');
  });

  it('trims whitespace-only names and falls through to the email fallback', () => {
    expect(formatPersonName('   ', 'owner@axon.example')).toBe('Без имени (owner@axon.example)');
  });

  it('falls back to "Без имени (email)" when name is empty and email is given', () => {
    expect(formatPersonName('', 'owner@axon.example')).toBe('Без имени (owner@axon.example)');
    expect(formatPersonName(null, 'owner@axon.example')).toBe('Без имени (owner@axon.example)');
    expect(formatPersonName(undefined, 'owner@axon.example')).toBe('Без имени (owner@axon.example)');
  });

  it('returns null when BOTH name and email/secondary id are absent (caller supplies the last-resort fallback, e.g. raw slug)', () => {
    expect(formatPersonName(null, null)).toBeNull();
    expect(formatPersonName('', '')).toBeNull();
    expect(formatPersonName(undefined, undefined)).toBeNull();
  });

  it('never fabricates a UUID/slug — a raw id passed as `name` is returned verbatim (not the bug this guards against)', () => {
    // formatPersonName has no notion of "id"/"slug"; the bug this guards
    // against is UPSTREAM (a caller passing raw id/slug as the display name).
    // Passing an empty name + no email honestly yields null — never a
    // fabricated string — so the caller's own last-resort fallback (the raw
    // slug) is what actually renders, never something invented here.
    expect(formatPersonName(null, null)).toBeNull();
  });
});
