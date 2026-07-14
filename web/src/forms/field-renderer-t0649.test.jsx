/**
 * web/src/forms/field-renderer-t0649.test.jsx  (T-0649 · W4-UX / столп 2)
 *
 * Tests for the T-0649 field controls + P1 data-integrity fixes:
 *   - MoneyInput / groupThousands: ₽ inside the field, thousands separators,
 *     kopecks preserved (the P1 fix — the display bug that made 150000.5 read
 *     as "150 001 ₽" was in formatCellValue, tested in records-form.test.js;
 *     here we test the INPUT control keeps the exact numeric string).
 *   - DateInput: native <input type="date">/<input type="datetime-local"> with
 *     a дд.мм.гггг[ чч:мм] overlay label (locale-independent).
 *   - fetchEmployees: the P1 /api/org 401 fix — it now attaches auth headers
 *     (was a bare fetch('/api/org') that DETERMINISTICALLY 401'd in keycloak
 *     mode because Choros keycloak auth is Bearer-only, no cookie session).
 *
 * Approach: same node-env tree-walk + plain-function-call convention as
 * field-renderer.test.jsx (no jsdom/react-dom). MoneyInput/DateInput are
 * deliberately HOOK-FREE so they can be invoked directly and their returned
 * element tree inspected. fetchEmployees is a plain async function tested with
 * a stubbed globalThis.fetch (same convention as fetch-with-auth-retry.test.js).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MoneyInput,
  DateInput,
  groupThousands,
  fetchEmployees,
  buildEmployeesById,
} from './field-renderer.jsx';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_SRC = fs.readFileSync(path.resolve(HERE, 'field-renderer.jsx'), 'utf-8');

// ---------------------------------------------------------------------------
// Tree-walk helpers (mirror field-renderer.test.jsx)
// ---------------------------------------------------------------------------

function collectElements(node, predicate, results = []) {
  if (node === null || node === undefined) return results;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, results);
    return results;
  }
  if (typeof node !== 'object' || !node.type) return results;
  if (predicate(node)) results.push(node);
  const { children } = node.props || {};
  if (children !== undefined) collectElements(children, predicate, results);
  return results;
}

function findByType(tree, type) {
  return collectElements(tree, (el) => el.type === type);
}

const noop = () => {};

// ---------------------------------------------------------------------------
// groupThousands — pure formatter (kopecks NEVER touched)
// ---------------------------------------------------------------------------

describe('groupThousands (T-0649)', () => {
  it('groups the integer part with spaces', () => {
    expect(groupThousands('150000')).toBe('150 000');
    expect(groupThousands('1234567')).toBe('1 234 567');
  });

  it('preserves kopecks EXACTLY (never rounds/truncates the fraction)', () => {
    expect(groupThousands('150000.5')).toBe('150 000,5');
    expect(groupThousands('1234.99')).toBe('1 234,99');
    expect(groupThousands('0.01')).toBe('0,01');
  });

  it('accepts either "." or "," as the decimal separator on input, displays ","', () => {
    expect(groupThousands('150000,5')).toBe('150 000,5');
  });

  it('handles a negative value', () => {
    expect(groupThousands('-1500.5')).toBe('-1 500,5');
  });

  it('empty / non-string → ""', () => {
    expect(groupThousands('')).toBe('');
    expect(groupThousands(undefined)).toBe('');
    expect(groupThousands(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// MoneyInput — ₽ inside the field, controlled by a RAW numeric string
// ---------------------------------------------------------------------------

describe('MoneyInput (T-0649)', () => {
  it('renders a ₽ decorator span INSIDE the field (not a trailing suffix)', () => {
    const tree = MoneyInput({ id: 'f', inputClass: 'chs-input', value: '150000', onChange: noop, style: {} });
    const ruble = collectElements(tree, (el) => el.type === 'span' && el.props?.children === '₽');
    expect(ruble.length).toBe(1);
    // The ₽ span is absolutely positioned inside the field (position:absolute).
    expect(ruble[0].props.style.position).toBe('absolute');
  });

  it('displays the grouped value (150000.5 → "150 000,5") — kopecks visible, not rounded', () => {
    const tree = MoneyInput({ id: 'f', inputClass: 'chs-input', value: '150000.5', onChange: noop, style: {} });
    const input = findByType(tree, 'input')[0];
    expect(input.props.value).toBe('150 000,5');
  });

  it('onChange emits the RAW numeric string (grouping/₽ stripped) — same shape serializeRecordData expects', () => {
    let captured;
    const tree = MoneyInput({ id: 'f', inputClass: 'chs-input', value: '', onChange: (v) => { captured = v; }, style: {} });
    const input = findByType(tree, 'input')[0];
    // Simulate the user having typed a grouped value with kopecks.
    input.props.onChange({ target: { value: '150 000,5' } });
    // The stored value is the raw numeric string — no spaces, dot decimal, kopecks intact.
    expect(captured).toBe('150000.5');
  });

  it('read-only → the input is readOnly', () => {
    const tree = MoneyInput({ id: 'f', inputClass: 'chs-input', value: '1000', onChange: noop, readOnly: true, style: {} });
    const input = findByType(tree, 'input')[0];
    expect(input.props.readOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DateInput — native input + дд.мм.гггг overlay
// ---------------------------------------------------------------------------

describe('DateInput (T-0649)', () => {
  it('renders a native <input type="date"> (keyboard/a11y preserved)', () => {
    const tree = DateInput({ id: 'f', inputClass: 'chs-input', value: '2026-07-05', onChange: noop, style: {} });
    const input = findByType(tree, 'input')[0];
    expect(input.props.type).toBe('date');
    // The native value stays the ISO string (storage unchanged).
    expect(input.props.value).toBe('2026-07-05');
  });

  it('overlays a дд.мм.гггг label (locale-independent) — not the raw ISO', () => {
    const tree = DateInput({ id: 'f', inputClass: 'chs-input', value: '2026-07-05', onChange: noop, style: {} });
    const label = collectElements(tree, (el) => el.type === 'span' && el.props?.children === '05.07.2026');
    expect(label.length).toBe(1);
  });

  it('withTime → native <input type="datetime-local"> + дд.мм.гггг чч:мм overlay', () => {
    const tree = DateInput({ id: 'f', inputClass: 'chs-input', value: '2026-07-05T14:32', onChange: noop, withTime: true, style: {} });
    const input = findByType(tree, 'input')[0];
    expect(input.props.type).toBe('datetime-local');
    const label = collectElements(tree, (el) => el.type === 'span' && typeof el.props?.children === 'string' && /^05\.07\.2026 \d{2}:\d{2}$/.test(el.props.children));
    expect(label.length).toBe(1);
  });

  it('empty value → no overlay label (honest empty state)', () => {
    const tree = DateInput({ id: 'f', inputClass: 'chs-input', value: '', onChange: noop, style: {} });
    const label = collectElements(tree, (el) => el.type === 'span' && typeof el.props?.children === 'string' && el.props.children.includes('.'));
    expect(label.length).toBe(0);
  });

  it('onChange passes the native ISO value straight through (storage unchanged)', () => {
    let captured;
    const tree = DateInput({ id: 'f', inputClass: 'chs-input', value: '', onChange: (v) => { captured = v; }, style: {} });
    const input = findByType(tree, 'input')[0];
    input.props.onChange({ target: { value: '2026-12-31' } });
    expect(captured).toBe('2026-12-31');
  });
});

// ---------------------------------------------------------------------------
// fetchEmployees — the P1 GET /api/org 401 fix (auth headers now attached)
// ---------------------------------------------------------------------------

describe('fetchEmployees — P1 /api/org 401 fix (T-0649)', () => {
  let originalFetch;
  let originalLocalStorage;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLocalStorage = globalThis.localStorage;
    // Dev mode by default (no keycloak config loaded) → authHeaders() emits
    // X-Dev-User from localStorage. Provide a picked dev user so a header IS
    // attached (proving fetchEmployees now sends auth headers, unlike the old
    // bare fetch('/api/org') that sent none).
    const store = new Map([['chs-dev-user', JSON.stringify({ id: 'e-owner' })]]);
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });

  it('attaches auth headers to GET /api/org (was a bare fetch with NO headers → deterministic 401)', async () => {
    let seenHeaders = null;
    globalThis.fetch = async (_url, init) => {
      seenHeaders = init && init.headers ? init.headers : null;
      return {
        ok: true,
        status: 200,
        json: async () => ({ departments: [] }),
      };
    };
    await fetchEmployees();
    // The critical assertion: fetchEmployees now sends an auth header. Before
    // the fix it sent NONE, so keycloak-mode 401'd every call.
    expect(seenHeaders).not.toBeNull();
    expect(seenHeaders['X-Dev-User']).toBe('e-owner');
  });

  it('flattens human employees to {id, name, position, deactivated}; drops agents', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        // Generic synthetic fixtures — no case-specific persona/role literals
        // (D-064 anti-case discipline): a plain human + a plain agent, testing
        // only the type:"human" filter and the {id,name,position,deactivated}
        // shape. This person carries no `deactivated` key at all (mirrors an
        // active employee row, deactivated_at IS NULL) — the flattened shape
        // must still carry an explicit `deactivated: false`, not `undefined`.
        departments: [{
          positions: [{
            title: 'Position A',
            people: [
              { id: 'emp-1', name: 'Human One', type: 'human' },
              { id: 'agt-1', name: 'Agent One', type: 'agent' },
            ],
          }],
        }],
      }),
    });
    const list = await fetchEmployees();
    expect(list).toEqual([
      { id: 'emp-1', name: 'Human One', position: 'Position A', deactivated: false },
    ]);
  });

  // T-0698 (P2, T-0673's judge finding): GET /api/org's people[] now carries
  // a `deactivated` boolean (src/db/org.ts listOrgTree, migration 125
  // deactivated_at != null) — this is the FIRST of two links PersonCell's
  // deactivated marker depends on (the second is this exact flatten step).
  // Before this fix `employees.push({id, name, position})` silently dropped
  // ANY `deactivated` field the API sent, so PersonCell's marker was always
  // false in production even once the server started sending it.
  it('T-0698: threads the `deactivated` boolean through from a real /api/org response shape', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        departments: [{
          positions: [{
            title: 'Position A',
            people: [
              { id: 'emp-active', name: 'Active One', type: 'human', deactivated: false },
              { id: 'emp-gone', name: 'Gone One', type: 'human', deactivated: true },
            ],
          }],
        }],
      }),
    });
    const list = await fetchEmployees();
    const byId = buildEmployeesById(list);
    expect(byId.get('emp-active').deactivated).toBe(false);
    expect(byId.get('emp-gone').deactivated).toBe(true);
  });

  it('throws a formatted error on a non-ok response (so PersonPicker can show honest error + retry)', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await expect(fetchEmployees()).rejects.toThrow();
  });

  it('uses fetchWithAuthRetry (not bare fetch) — mode-aware headers + transient-401 self-heal', () => {
    // fetchEmployees must call the auth-retry wrapper, which attaches
    // authHeaders() on every call AND silently refreshes + retries once on a
    // genuinely transient 401 (expired token mid-session) before a login
    // redirect. Source-text guard: the old bare `fetch('/api/org')` (no
    // headers) must be gone.
    expect(RENDERER_SRC).toMatch(/fetchWithAuthRetry\(['"]\/api\/org['"]/);
    // The old bare `fetch('/api/org')` CALL must be gone. (A backtick-quoted
    // mention of it in the fix's explanatory JSDoc is fine — we only forbid an
    // actual quoted-string call `fetch('/api/org')` / `fetch("/api/org")`.)
    expect(RENDERER_SRC).not.toMatch(/(?<![`\w])fetch\(['"]\/api\/org['"]\)/);
  });
});

// ---------------------------------------------------------------------------
// buildEmployeesById — the ONE canonical list→Map step (T-0698 B1/N1) both
// record screens AND their e2e tests call, so the map's value shape cannot
// drift between a screen and its test (the drift that hid the third
// deactivated_at break in screen-record-detail's flatten-to-string map).
// ---------------------------------------------------------------------------

describe('buildEmployeesById (T-0698 N1)', () => {
  it('keys WHOLE entries by id — name and deactivated both reachable from one lookup', () => {
    const map = buildEmployeesById([
      { id: 'emp-1', name: 'Human One', position: 'Position A', deactivated: false },
      { id: 'emp-2', name: 'Human Two', position: 'Position B', deactivated: true },
    ]);
    expect(map.get('emp-1').name).toBe('Human One');
    expect(map.get('emp-1').deactivated).toBe(false);
    expect(map.get('emp-2').deactivated).toBe(true);
  });

  it('tolerates non-array input (still-loading/failed state) → empty Map, never throws', () => {
    expect(buildEmployeesById(undefined).size).toBe(0);
    expect(buildEmployeesById(null).size).toBe(0);
    expect(buildEmployeesById([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PersonPicker — honest error + «Повторить» retry (source-text presence:
// PersonPicker uses hooks, so it cannot be invoked as a plain function in this
// no-jsdom harness — same convention as screen-llm-connections.states.test.jsx).
// ---------------------------------------------------------------------------

describe('PersonPicker error + retry (T-0649, source-text presence)', () => {
  it('has a retry handler that re-triggers the employee fetch', () => {
    // handleRetry resets to the honest loading state and bumps a retry counter
    // that the useEffect depends on (re-runs fetchEmployees) — no full reload
    // needed, which was the original dead-end.
    expect(RENDERER_SRC).toMatch(/const handleRetry\s*=/);
    expect(RENDERER_SRC).toMatch(/retryTick/);
  });

  it('renders a visible «Повторить» button in the fetch-error branch', () => {
    expect(RENDERER_SRC).toMatch(/onClick=\{handleRetry\}/);
    expect(RENDERER_SRC).toContain('Повторить');
  });

  it('search box filters by name OR position («имя + должность»)', () => {
    // The filter matches emp.name OR emp.position (case-insensitive).
    expect(RENDERER_SRC).toMatch(/emp\.name\.toLowerCase\(\)\.includes/);
    expect(RENDERER_SRC).toMatch(/emp\.position\s*\|\|\s*''\)\.toLowerCase\(\)\.includes/);
  });
});
