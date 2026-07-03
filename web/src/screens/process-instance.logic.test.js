/**
 * web/src/screens/process-instance.logic.test.js — T-0556
 *
 * Unit tests for the read-only process-instance detail view's pure logic
 * (process-instance.logic.js). Pure node environment, no DOM, no React rendering
 * — mirrors the existing screen-test idiom (process-branch-rules.test.js,
 * screen-audit.logic tier).
 */

import { describe, it, expect } from 'vitest';
import {
  instanceDetailPath,
  currentNodes,
  progressLabel,
  progressFraction,
  filterInstanceHistory,
  hasSourceRecord,
  hasVariables,
  hasDetailedHistory,
  formatHistoryTimestamp,
} from './process-instance.logic.js';

describe('instanceDetailPath — navigation target for the instance detail view', () => {
  it('returns /processes/:id for a simple id', () => {
    expect(instanceDetailPath('INS-7731')).toBe('/processes/INS-7731');
  });

  it('URL-encodes ids with special characters', () => {
    expect(instanceDetailPath('07a450cb/x')).toBe('/processes/07a450cb%2Fx');
  });

  it('returns null for empty / whitespace / non-string (no dead affordance)', () => {
    expect(instanceDetailPath('')).toBeNull();
    expect(instanceDetailPath('   ')).toBeNull();
    expect(instanceDetailPath(null)).toBeNull();
    expect(instanceDetailPath(undefined)).toBeNull();
    expect(instanceDetailPath(123)).toBeNull();
  });
});

describe('currentNodes — concurrent active steps (T-0456)', () => {
  it('prefers the nodes array when present', () => {
    expect(currentNodes({ node: 'n1', nodes: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('falls back to the single node string when nodes is absent/empty', () => {
    expect(currentNodes({ node: 'n7 · Утверждение' })).toEqual(['n7 · Утверждение']);
    expect(currentNodes({ node: 'n7', nodes: [] })).toEqual(['n7']);
  });

  it('filters out non-string / empty entries in nodes', () => {
    expect(currentNodes({ nodes: ['a', '', null, 'b'] })).toEqual(['a', 'b']);
  });

  it('returns [] for a done instance with no waiting step', () => {
    expect(currentNodes({ node: '', nodes: [] })).toEqual([]);
    expect(currentNodes(null)).toEqual([]);
    expect(currentNodes(undefined)).toEqual([]);
  });
});

describe('progressLabel — done/total', () => {
  it('formats done/total', () => {
    expect(progressLabel({ done: 4, total: 7 })).toBe('4/7');
    expect(progressLabel({ done: 0, total: 0 })).toBe('0/0');
  });

  it('returns — for malformed/missing progress (never "undefined/...")', () => {
    expect(progressLabel(null)).toBe('—');
    expect(progressLabel({})).toBe('—');
    expect(progressLabel({ done: 'x', total: 5 })).toBe('—');
  });
});

describe('progressFraction — bar fill 0..1', () => {
  it('computes the fraction', () => {
    expect(progressFraction({ done: 1, total: 4 })).toBe(0.25);
    expect(progressFraction({ done: 3, total: 3 })).toBe(1);
  });

  it('returns 0 for total 0 or malformed; clamps out-of-range', () => {
    expect(progressFraction({ done: 1, total: 0 })).toBe(0);
    expect(progressFraction(null)).toBe(0);
    expect(progressFraction({ done: 5, total: 3 })).toBe(1);
    expect(progressFraction({ done: -1, total: 3 })).toBe(0);
  });
});

describe('filterInstanceHistory — audit events targeting this instance', () => {
  const events = [
    { id: 1, target: 'INS-7731', action: 'x' },
    { id: 2, target: 'DOC-4471', action: 'y' },
    { id: 3, target: 'INS-7731', action: 'z' },
    { id: 4, target: null, action: 'w' },
  ];

  it('keeps only events whose target matches the instance id', () => {
    const out = filterInstanceHistory(events, 'INS-7731');
    expect(out.map((e) => e.id)).toEqual([1, 3]);
  });

  it('returns [] when nothing targets the instance', () => {
    expect(filterInstanceHistory(events, 'INS-9999')).toEqual([]);
  });

  it('returns [] for malformed inputs', () => {
    expect(filterInstanceHistory(null, 'INS-7731')).toEqual([]);
    expect(filterInstanceHistory(events, '')).toEqual([]);
    expect(filterInstanceHistory(events, null)).toEqual([]);
  });
});

describe('hasSourceRecord — record-source link gate (T-0414)', () => {
  it('true only when recordId is a non-empty string', () => {
    expect(hasSourceRecord({ recordId: 'REC-1' })).toBe(true);
    expect(hasSourceRecord({ recordId: '  ' })).toBe(false);
    expect(hasSourceRecord({})).toBe(false);
    expect(hasSourceRecord(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-0609 — process variables + engine-sourced detailed history.
// ---------------------------------------------------------------------------

describe('hasVariables — process-variables section gate (T-0609)', () => {
  it('true only when variables is a non-empty array', () => {
    expect(hasVariables({ variables: [{ name: 'amount', value: 42000 }] })).toBe(true);
  });
  it('false for missing/empty/malformed variables', () => {
    expect(hasVariables({ variables: [] })).toBe(false);
    expect(hasVariables({})).toBe(false);
    expect(hasVariables(null)).toBe(false);
    expect(hasVariables({ variables: 'not-an-array' })).toBe(false);
  });
});

describe('hasDetailedHistory — engine-sourced history gate (T-0609)', () => {
  it('true only when historyAvailable is exactly true', () => {
    expect(hasDetailedHistory({ historyAvailable: true })).toBe(true);
  });
  it('false when historyAvailable is false/absent (regression: old audit-filter path)', () => {
    expect(hasDetailedHistory({ historyAvailable: false })).toBe(false);
    expect(hasDetailedHistory({})).toBe(false);
    expect(hasDetailedHistory(null)).toBe(false);
    // Non-DB / no-engine fixtures never carry this field at all — must NOT be
    // mistaken for "available" (truthy coercion bug class).
    expect(hasDetailedHistory({ historyAvailable: undefined })).toBe(false);
  });
});

describe('formatHistoryTimestamp — engine ISO-8601 → human-readable (T-0609)', () => {
  it('formats a valid ISO-8601 timestamp', () => {
    const out = formatHistoryTimestamp('2026-07-03T10:00:00.000+0000');
    expect(out).not.toBe('—');
    expect(typeof out).toBe('string');
  });
  it('returns — for null (the currently-active step has no endTime yet)', () => {
    expect(formatHistoryTimestamp(null)).toBe('—');
  });
  it('returns — for undefined / empty / malformed input (never "Invalid Date")', () => {
    expect(formatHistoryTimestamp(undefined)).toBe('—');
    expect(formatHistoryTimestamp('')).toBe('—');
    expect(formatHistoryTimestamp('not-a-date')).toBe('—');
  });
});
