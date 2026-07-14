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
  deriveInstanceTitle,
  formatVariableValue,
  renderableVariables,
  hasRenderableVariables,
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

// T-0684 [capstone T-0647 P1]: instance title is the HUMAN name, machine key demoted.
// Live capstone finding: the detail title rendered the machine key (a camelCase
// engine key) where the definition's human name belongs.
describe('deriveInstanceTitle — human name primary, machine key never the title', () => {
  it('promotes a real human name and demotes the raw key', () => {
    const out = deriveInstanceTitle({ name: 'Обработка виджета', procId: 'telLinear' });
    expect(out.title).toBe('Обработка виджета');
    expect(out.title).not.toBe('telLinear');
    expect(out.keyDemoted).toBe('telLinear');
  });

  it('never shows the raw key as the title when name === key (engine-only fallback)', () => {
    // The server echoes the key as `name` when no modeler row exists → name === procId.
    const out = deriveInstanceTitle({ name: 'telLinear', procId: 'telLinear' });
    expect(out.title).not.toBe('telLinear');       // NOT the machine key
    expect(out.title).toBe('Процесс');              // honest generic
    expect(out.keyDemoted).toBe('telLinear');       // key still shown, but demoted
  });

  it('is defensive against missing name / procId', () => {
    expect(deriveInstanceTitle({ procId: 'k' }).title).toBe('Процесс');
    expect(deriveInstanceTitle(null).title).toBe('Процесс');
    expect(deriveInstanceTitle({ name: 'Real Name' }).keyDemoted).toBeNull();
  });
});

// T-0684 [capstone T-0647 P1]: process-variables never render the literal "undefined".
// Live capstone finding: the variables section printed the literal `undefined` x3.
describe('formatVariableValue — no literal "undefined"/"null" ever', () => {
  it('renders undefined / null / empty as the honest em-dash, NEVER "undefined"', () => {
    expect(formatVariableValue(undefined)).toBe('—');
    expect(formatVariableValue(null)).toBe('—');
    expect(formatVariableValue('')).toBe('—');
    expect(formatVariableValue(undefined)).not.toBe('undefined');
    expect(formatVariableValue(null)).not.toBe('null');
  });

  it('renders real values honestly (string / number / boolean / object)', () => {
    expect(formatVariableValue('hello')).toBe('hello');
    expect(formatVariableValue(0)).toBe('0');       // falsy but real
    expect(formatVariableValue(false)).toBe('false');
    expect(formatVariableValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe('renderableVariables / hasRenderableVariables — no phantom rows', () => {
  it('drops phantom rows (no name AND no value) that would render as "undefined"', () => {
    const instance = {
      variables: [
        { name: undefined, value: undefined },   // phantom → dropped
        { name: '', value: null },               // phantom → dropped
        { name: 'amount', value: 500 },          // real → kept
      ],
    };
    const rows = renderableVariables(instance);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('amount');
    expect(rows[0].value).toBe(500);
  });

  it('keeps a NAMED variable with a null value (honest "exists, no value") — renders "—"', () => {
    const instance = { variables: [{ name: 'note', value: null }] };
    const rows = renderableVariables(instance);
    expect(rows).toHaveLength(1);
    expect(formatVariableValue(rows[0].value)).toBe('—');
  });

  it('hasRenderableVariables is false for a payload of ONLY phantom rows', () => {
    expect(hasRenderableVariables({ variables: [{ name: undefined, value: undefined }] })).toBe(false);
    expect(hasRenderableVariables({ variables: [] })).toBe(false);
    expect(hasRenderableVariables(null)).toBe(false);
    expect(hasRenderableVariables({ variables: [{ name: 'x', value: 1 }] })).toBe(true);
  });
});
