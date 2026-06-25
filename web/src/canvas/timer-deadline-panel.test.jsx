/**
 * T-0458 [D8-R3] — timer-deadline-panel.jsx pure-helper + moddle contract tests.
 *
 * Covers:
 *   1. validateDeadline — duration/date/field shapes (valid + malformed).
 *   2. read/writeTimerAttr — dual-write (registered moddle prop + $attrs) round-trip.
 *   3. deadlinePlaceholder / deadlineHint — per-kind copy present.
 *   4. choros-moddle-extension — TimerDeadlineExtension descriptor shape (round-trip contract).
 */

import { describe, it, expect } from 'vitest';
import {
  validateDeadline,
  readTimerAttr,
  writeTimerAttr,
  deadlinePlaceholder,
  deadlineHint,
  DEADLINE_KINDS,
  ESCALATION_TARGETS,
} from './timer-deadline-panel.jsx';
import descriptor from './choros-moddle-extension.js';

describe('validateDeadline', () => {
  it('accepts a valid ISO-8601 duration', () => {
    expect(validateDeadline('duration', 'PT24H')).toBeNull();
    expect(validateDeadline('duration', 'P1D')).toBeNull();
    expect(validateDeadline('duration', 'P1DT12H')).toBeNull();
    expect(validateDeadline('duration', 'PT30M')).toBeNull();
  });
  it('rejects a non-ISO duration', () => {
    expect(validateDeadline('duration', '24 hours')).not.toBeNull();
    expect(validateDeadline('duration', 'soon')).not.toBeNull();
  });
  it('accepts an EL expression for duration', () => {
    expect(validateDeadline('duration', '${record.sla}')).toBeNull();
  });
  it('accepts a valid ISO-8601 date', () => {
    expect(validateDeadline('date', '2026-07-01')).toBeNull();
    expect(validateDeadline('date', '2026-07-01T14:00:00Z')).toBeNull();
  });
  it('rejects a non-ISO date', () => {
    expect(validateDeadline('date', 'next tuesday')).not.toBeNull();
  });
  it('accepts any non-empty field key', () => {
    expect(validateDeadline('field', 'dueDate')).toBeNull();
  });
  it('flags an empty deadline regardless of kind', () => {
    expect(validateDeadline('duration', '')).not.toBeNull();
    expect(validateDeadline('field', '   ')).not.toBeNull();
  });
});

describe('read/writeTimerAttr — dual-write round-trip', () => {
  it('writes both the registered property and the $attrs fallback', () => {
    const bo = {};
    writeTimerAttr(bo, 'timerDeadlineKind', 'choros:timerDeadlineKind', 'date');
    expect(bo.timerDeadlineKind).toBe('date');
    expect(bo.$attrs['choros:timerDeadlineKind']).toBe('date');
    expect(readTimerAttr(bo, 'timerDeadlineKind', 'choros:timerDeadlineKind')).toBe('date');
  });
  it('clearing removes both', () => {
    const bo = { timerDeadline: 'PT1H', $attrs: { 'choros:timerDeadline': 'PT1H' } };
    writeTimerAttr(bo, 'timerDeadline', 'choros:timerDeadline', '');
    expect(bo.timerDeadline).toBeUndefined();
    expect(bo.$attrs['choros:timerDeadline']).toBeUndefined();
  });
  it('read falls back to $attrs when the registered prop is absent (imported XML)', () => {
    const bo = { $attrs: { 'choros:escalateTo': 'manager' } };
    expect(readTimerAttr(bo, 'escalateTo', 'choros:escalateTo')).toBe('manager');
  });
  it('read returns the fallback when neither is set', () => {
    expect(readTimerAttr({}, 'escalateTo', 'choros:escalateTo', 'manager')).toBe('manager');
  });
});

describe('per-kind copy', () => {
  it('has a placeholder + hint for each deadline kind', () => {
    for (const k of DEADLINE_KINDS) {
      expect(deadlinePlaceholder(k.value)).toBeTruthy();
      expect(deadlineHint(k.value).length).toBeGreaterThan(0);
    }
  });
  it('exposes the three escalation targets', () => {
    expect(ESCALATION_TARGETS.map((t) => t.value)).toEqual(['manager', 'owner', 'role']);
  });
});

describe('TimerDeadlineExtension moddle descriptor', () => {
  it('declares the timer deadline + escalation attributes as isAttr on bpmn:CatchEvent', () => {
    const ext = descriptor.types.find((t) => t.name === 'TimerDeadlineExtension');
    expect(ext).toBeDefined();
    expect(ext.extends).toContain('bpmn:CatchEvent');
    const names = ext.properties.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining(['timerDeadlineKind', 'timerDeadline', 'escalateTo']),
    );
    for (const p of ext.properties) {
      expect(p.isAttr).toBe(true);
      expect(p.type).toBe('String');
    }
  });
});
