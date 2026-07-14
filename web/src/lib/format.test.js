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
import { formatPersonName, formatShortDate, formatShortDateTime } from './format.js';

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

// ---------------------------------------------------------------------------
// T-0649: formatShortDate / formatShortDateTime — дд.мм.гггг numeric display.
//
// UX study §2 live bug: the record list rendered a raw ISO string
// ("2026-07-05") instead of a localized date. formatDate (existing) uses
// month NAMES ("5 июл 2026") — good for prose, wrong for the compact numeric
// дд.мм.гггг the founder specifically asked for. These are separate functions
// (additive, formatDate untouched) feeding formatCellValue's date/datetime
// branches and the DateInput control's overlay label.
// ---------------------------------------------------------------------------

describe('formatShortDate (T-0649)', () => {
  it('formats an ISO date string as дд.мм.гггг', () => {
    expect(formatShortDate('2026-07-05')).toBe('05.07.2026');
  });

  it('formats an ISO datetime string (only the date part) as дд.мм.гггг', () => {
    expect(formatShortDate('2026-07-05T14:32:08.123Z')).toBe('05.07.2026');
  });

  it('pads single-digit day/month', () => {
    expect(formatShortDate('2026-01-09')).toBe('09.01.2026');
  });

  it('null/undefined/empty → "—"', () => {
    expect(formatShortDate(null)).toBe('—');
    expect(formatShortDate(undefined)).toBe('—');
    expect(formatShortDate('')).toBe('—');
  });

  it('invalid string → "—" (no crash)', () => {
    expect(formatShortDate('not-a-date')).toBe('—');
  });

  it('does NOT shift the day near a UTC-negative-offset boundary (parses ISO date parts directly, no Date() timezone round-trip)', () => {
    // A naive `new Date('2026-07-05').toLocaleDateString()` can render "04.07.2026"
    // in a browser whose local TZ is UTC-negative (e.g. America/*) — the bare ISO
    // date parses as UTC midnight, which is the PREVIOUS calendar day locally.
    // formatShortDate must be immune to this regardless of the runtime's TZ.
    expect(formatShortDate('2026-07-05')).toBe('05.07.2026');
    expect(formatShortDate('2026-12-31')).toBe('31.12.2026');
  });
});

describe('formatShortDateTime (T-0649)', () => {
  it('formats an ISO datetime as "дд.мм.гггг чч:мм"', () => {
    const result = formatShortDateTime('2026-07-05T14:32:00');
    expect(result).toMatch(/^05\.07\.2026 \d{2}:\d{2}$/);
  });

  it('null/undefined/empty → "—"', () => {
    expect(formatShortDateTime(null)).toBe('—');
    expect(formatShortDateTime(undefined)).toBe('—');
    expect(formatShortDateTime('')).toBe('—');
  });

  it('invalid string → "—" (no crash)', () => {
    expect(formatShortDateTime('not-a-date')).toBe('—');
  });
});
