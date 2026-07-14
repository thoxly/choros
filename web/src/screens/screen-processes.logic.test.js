/**
 * web/src/screens/screen-processes.logic.test.js — T-0735 (T-0654-b)
 *
 * Behavioral tests for the pure grid logic (buildProcessesQuery + helpers). The
 * .jsx screen is asserted structurally in screen-processes.test.jsx (project
 * convention: node env, no React mount); the load-bearing query-building logic is
 * tested here against the part-A contract (GET /api/processes params).
 */

import { describe, it, expect } from 'vitest';
import {
  PROCESSES_VIEW_PREF_KEY,
  PROCESSES_COLUMNS,
  PROCESSES_PAGE_SIZE,
  defaultProcessesView,
  normalizeProcessesView,
  buildProcessesQuery,
  hasActiveProcessFilter,
  definitionFilterOptions,
  instanceStepNodes,
  dateInputToEpochStart,
  dateInputToEpochEnd,
} from './screen-processes.logic.js';

describe('PROCESSES_COLUMNS — catalog (mirrors src/core/view-config.ts)', () => {
  it('carries exactly the 5 platform keys name/process/status/started/actor', () => {
    expect(PROCESSES_COLUMNS.map((c) => c.key)).toEqual([
      'name', 'process', 'status', 'started', 'actor',
    ]);
  });
  it('every column has a human Russian label (no bare machine key surfaced)', () => {
    for (const c of PROCESSES_COLUMNS) {
      expect(typeof c.label).toBe('string');
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.label).not.toBe(c.key);
    }
  });
  it('anti-case: no key is a domain/process slug (only platform fields)', () => {
    const platform = new Set(['name', 'process', 'status', 'started', 'actor']);
    for (const c of PROCESSES_COLUMNS) expect(platform.has(c.key)).toBe(true);
  });
});

describe('buildProcessesQuery — filter state → part-A query params', () => {
  const base = { limit: PROCESSES_PAGE_SIZE, offset: 0 };

  it('always emits limit + offset (server pagination)', () => {
    const qs = buildProcessesQuery(base);
    expect(qs.get('limit')).toBe(String(PROCESSES_PAGE_SIZE));
    expect(qs.get('offset')).toBe('0');
  });

  it('AC-B2: ?q= carries the TRIMMED text search (empty/whitespace omitted)', () => {
    expect(buildProcessesQuery({ ...base, q: '  аренда офиса ' }).get('q')).toBe('аренда офиса');
    expect(buildProcessesQuery({ ...base, q: '   ' }).has('q')).toBe(false);
    expect(buildProcessesQuery({ ...base }).has('q')).toBe(false);
  });

  it('AC-B2: ?definition= carries the exact procKey', () => {
    expect(buildProcessesQuery({ ...base, definition: 'invoiceApprove' }).get('definition')).toBe('invoiceApprove');
    expect(buildProcessesQuery({ ...base, definition: '' }).has('definition')).toBe(false);
  });

  it('AC-B2: ?status= carries the exact status', () => {
    expect(buildProcessesQuery({ ...base, status: 'running' }).get('status')).toBe('running');
    expect(buildProcessesQuery({ ...base, status: '' }).has('status')).toBe(false);
  });

  it('AC-B2: ?mine=1 emitted only when the toggle is on', () => {
    expect(buildProcessesQuery({ ...base, mine: true }).get('mine')).toBe('1');
    expect(buildProcessesQuery({ ...base, mine: false }).has('mine')).toBe(false);
  });

  it('AC-B2: date bounds → integer epoch-ms strings (from=start-of-day, to=end-of-day)', () => {
    const qs = buildProcessesQuery({ ...base, startedFrom: '2026-07-01', startedTo: '2026-07-03' });
    expect(qs.get('started_from')).toBe(String(dateInputToEpochStart('2026-07-01')));
    expect(qs.get('started_to')).toBe(String(dateInputToEpochEnd('2026-07-03')));
    // to-bound is later than from-bound of the SAME day (inclusive end-of-day).
    expect(dateInputToEpochEnd('2026-07-01')).toBeGreaterThan(dateInputToEpochStart('2026-07-01'));
  });

  it('empty date inputs omit the bound (unknown-time instances pass — AC-A4)', () => {
    const qs = buildProcessesQuery({ ...base, startedFrom: '', startedTo: '' });
    expect(qs.has('started_from')).toBe(false);
    expect(qs.has('started_to')).toBe(false);
  });

  it('AC-B3: pagination — a later page carries the advanced offset', () => {
    const qs = buildProcessesQuery({ ...base, offset: PROCESSES_PAGE_SIZE });
    expect(qs.get('offset')).toBe(String(PROCESSES_PAGE_SIZE));
    expect(qs.get('limit')).toBe(String(PROCESSES_PAGE_SIZE));
  });

  it('composes ALL filters at once (the anti-case journey: mine + search)', () => {
    const qs = buildProcessesQuery({
      q: 'заявка', definition: 'rentApprove', status: 'waiting',
      startedFrom: '2026-07-01', startedTo: '2026-07-31', mine: true,
      limit: PROCESSES_PAGE_SIZE, offset: 0,
    });
    expect(qs.get('q')).toBe('заявка');
    expect(qs.get('definition')).toBe('rentApprove');
    expect(qs.get('status')).toBe('waiting');
    expect(qs.get('mine')).toBe('1');
    expect(qs.has('started_from')).toBe(true);
    expect(qs.has('started_to')).toBe(true);
  });
});

describe('dateInputToEpoch* — YYYY-MM-DD → epoch-ms bound', () => {
  it('returns a finite number for a valid date, null for empty/garbage', () => {
    expect(typeof dateInputToEpochStart('2026-07-01')).toBe('number');
    expect(dateInputToEpochStart('')).toBeNull();
    expect(dateInputToEpochStart('   ')).toBeNull();
    expect(dateInputToEpochStart(null)).toBeNull();
    expect(dateInputToEpochEnd(undefined)).toBeNull();
  });
});

describe('definitionFilterOptions — human NAME label, procKey value', () => {
  it('maps {name, process_key} → {value: key, label: name}', () => {
    // Abstract placeholders — the grid is generic over ANY process (anti-case D-064).
    const opts = definitionFilterOptions([
      { name: 'Процесс А', process_key: 'procA' },
      { name: 'Процесс Б', process_key: 'procB' },
    ]);
    expect(opts).toEqual([
      { value: 'procA', label: 'Процесс А' },
      { value: 'procB', label: 'Процесс Б' },
    ]);
  });
  it('falls back to the key as label when the name is blank (option never empty)', () => {
    expect(definitionFilterOptions([{ name: '  ', process_key: 'k1' }])).toEqual([
      { value: 'k1', label: 'k1' },
    ]);
  });
  it('drops definitions with no key (nothing to filter by); tolerates junk input', () => {
    expect(definitionFilterOptions([{ name: 'x' }])).toEqual([]);
    expect(definitionFilterOptions(null)).toEqual([]);
    expect(definitionFilterOptions(undefined)).toEqual([]);
  });
});

describe('normalizeProcessesView — personal density (honest-degrade)', () => {
  it('defaults to comfortable', () => {
    expect(defaultProcessesView()).toEqual({ density: 'comfortable' });
    expect(normalizeProcessesView(null)).toEqual({ density: 'comfortable' });
    expect(normalizeProcessesView('garbage')).toEqual({ density: 'comfortable' });
    expect(normalizeProcessesView({})).toEqual({ density: 'comfortable' });
  });
  it('honours a persisted compact density', () => {
    expect(normalizeProcessesView({ density: 'compact' })).toEqual({ density: 'compact' });
  });
  it('uses the shared user_pref store key', () => {
    expect(PROCESSES_VIEW_PREF_KEY).toBe('processes.view');
  });
});

describe('instanceStepNodes — current step cell (concurrent branches T-0456)', () => {
  it('prefers the nodes[] array (parallel branches)', () => {
    expect(instanceStepNodes({ nodes: ['a', 'b'], node: 'x' })).toEqual(['a', 'b']);
  });
  it('falls back to the single node string', () => {
    expect(instanceStepNodes({ node: 'Этап один' })).toEqual(['Этап один']);
  });
  it('returns [] for a done instance with no waiting step / junk', () => {
    expect(instanceStepNodes({})).toEqual([]);
    expect(instanceStepNodes(null)).toEqual([]);
    expect(instanceStepNodes({ nodes: [] })).toEqual([]);
  });
});

describe('hasActiveProcessFilter — drives empty-state copy', () => {
  it('false when every filter is empty', () => {
    expect(hasActiveProcessFilter({ q: '', definition: '', status: '', startedFrom: '', startedTo: '', mine: false })).toBe(false);
    expect(hasActiveProcessFilter({})).toBe(false);
  });
  it('true when ANY filter is set', () => {
    expect(hasActiveProcessFilter({ q: 'x' })).toBe(true);
    expect(hasActiveProcessFilter({ definition: 'k' })).toBe(true);
    expect(hasActiveProcessFilter({ status: 'running' })).toBe(true);
    expect(hasActiveProcessFilter({ startedFrom: '2026-07-01' })).toBe(true);
    expect(hasActiveProcessFilter({ mine: true })).toBe(true);
    expect(hasActiveProcessFilter({ q: '   ' })).toBe(false); // whitespace-only is not active
  });
});
