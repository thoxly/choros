/**
 * web/src/screens/screen-processes.logic.js — T-0735 (T-0654-b)
 *
 * Pure (DOM-free, React-free) helpers for the «Процессы» operator grid
 * (screen-processes.jsx). Logic lives in this .js sibling so it is unit-testable
 * in the node vitest tier (the .jsx screen carries only rendering) — the same
 * idiom the rest of this codebase uses (screen-audit.logic.js,
 * process-instance.logic.js).
 *
 * Backend contract consumed (part A, T-0654 — already in dev): GET /api/processes
 *   ?q= ?definition=<procKey> ?status= ?started_from= ?started_to= ?mine=1
 *   ?limit= ?offset=
 * → { instances: ProcessInstance[], total, limit, offset }
 * All filters are applied AFTER the tenant-scoped projection server-side, so no
 * query this module builds can ever widen visibility (FF-5).
 */

/** Personal-view pref key (density) — the SAME per-actor user_pref store the
 *  sidebar collapse (T-0651) and the inbox personal view (T-0653) use, a
 *  different key. Honest-degrade: no pref ⇒ comfortable density. */
export const PROCESSES_VIEW_PREF_KEY = 'processes.view';

/**
 * Column catalog — an independent small copy of src/core/view-config.ts
 * PROCESSES_VIEW_COLUMNS (the web layer does not import the server core module;
 * same convention RecordRef uses for deriveRecordLabel). STABLE machine keys →
 * human-readable Russian labels the operator sees. Keys are PLATFORM fields, not
 * tenant/domain constants (anti-case D-064).
 */
export const PROCESSES_COLUMNS = [
  { key: 'name', label: 'Процесс' },
  { key: 'process', label: 'Текущий шаг' },
  { key: 'status', label: 'Статус' },
  { key: 'started', label: 'Запущен' },
  { key: 'actor', label: 'Кто запустил' },
];

/** Explicit page size so pagination actually engages (part-A default limit=200
 *  would return everything for typical tenants — no pagination to exercise). */
export const PROCESSES_PAGE_SIZE = 25;

/** Default personal view: comfortable density (matches the server's synthetic
 *  default — defaultProcessesViewConfig). */
export function defaultProcessesView() {
  return { density: 'comfortable' };
}

/** Merge a persisted pref (possibly partial/garbage) onto the default, safely. */
export function normalizeProcessesView(raw) {
  if (!raw || typeof raw !== 'object') return defaultProcessesView();
  return { density: raw.density === 'compact' ? 'compact' : 'comfortable' };
}

/** A `<input type="date">` value ("YYYY-MM-DD") → epoch-ms at the START of that
 *  local day. Returns null for empty/invalid so an absent bound is simply omitted
 *  (the server treats an absent bound as "no filter", and an unknown-time instance
 *  passes an optional bound — AC-A4). Sent as an integer string; the server accepts
 *  pure-integer epoch-ms directly (avoids Date.parse UTC/local ambiguity). */
export function dateInputToEpochStart(dateStr) {
  if (typeof dateStr !== 'string' || dateStr.trim() === '') return null;
  const t = new Date(`${dateStr}T00:00:00`).getTime();
  return Number.isFinite(t) ? t : null;
}

/** As above but the INCLUSIVE END of the local day (23:59:59.999), so an
 *  instance started any time on the "to" day is included. */
export function dateInputToEpochEnd(dateStr) {
  if (typeof dateStr !== 'string' || dateStr.trim() === '') return null;
  const t = new Date(`${dateStr}T23:59:59.999`).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Build the URLSearchParams for GET /api/processes from the grid's filter state.
 * Only non-empty filters are emitted; limit/offset are always present.
 * PURE — no fetch, no DOM. Returns a URLSearchParams (caller does `.toString()`).
 *
 * @param {{
 *   q?: string, definition?: string, status?: string,
 *   startedFrom?: string, startedTo?: string, mine?: boolean,
 *   limit: number, offset: number
 * }} state
 */
export function buildProcessesQuery(state) {
  const qs = new URLSearchParams();
  const q = typeof state.q === 'string' ? state.q.trim() : '';
  if (q) qs.set('q', q);
  if (state.definition) qs.set('definition', state.definition);
  if (state.status) qs.set('status', state.status);
  const from = dateInputToEpochStart(state.startedFrom);
  if (from !== null) qs.set('started_from', String(from));
  const to = dateInputToEpochEnd(state.startedTo);
  if (to !== null) qs.set('started_to', String(to));
  if (state.mine) qs.set('mine', '1');
  qs.set('limit', String(state.limit));
  qs.set('offset', String(state.offset));
  return qs;
}

/** True when ANY user-facing filter is active — drives the empty-state copy
 *  (a filtered-to-nothing list needs "измените фильтр", a genuinely empty tenant
 *  needs the "процессы запускаются автоматически" guidance). */
export function hasActiveProcessFilter(state) {
  return Boolean(
    (typeof state.q === 'string' && state.q.trim() !== '') ||
    state.definition || state.status || state.startedFrom || state.startedTo || state.mine,
  );
}

/**
 * Options for the definition filter <select>: human NAME as the label, procKey as
 * the value (?definition=procKey). Source = GET /api/process-catalog definitions
 * ([{ name, process_key }]). A definition with no key is dropped (nothing to
 * filter by); an empty name falls back to the key so the option is never blank.
 *
 * @param {Array<{name?: string, process_key?: string}>|null|undefined} definitions
 * @returns {Array<{value: string, label: string}>}
 */
export function definitionFilterOptions(definitions) {
  if (!Array.isArray(definitions)) return [];
  return definitions
    .filter((d) => d && typeof d.process_key === 'string' && d.process_key.trim() !== '')
    .map((d) => ({
      value: d.process_key,
      label: (typeof d.name === 'string' && d.name.trim() !== '') ? d.name.trim() : d.process_key,
    }));
}

/**
 * The CONCURRENT active nodes/steps of an instance for the grid's «Текущий шаг»
 * cell. Prefers the T-0456 `nodes` array (an AND-split leaves several active);
 * falls back to the single `node`. Returns [] for a done instance with no
 * waiting step. Mirrors process-instance.logic.js::currentNodes (kept a small
 * independent copy so the grid does not import the detail screen's module).
 *
 * @param {{ node?: string, nodes?: string[] }|null|undefined} instance
 * @returns {string[]}
 */
export function instanceStepNodes(instance) {
  if (!instance || typeof instance !== 'object') return [];
  if (Array.isArray(instance.nodes) && instance.nodes.length > 0) {
    return instance.nodes.filter((n) => typeof n === 'string' && n.length > 0);
  }
  if (typeof instance.node === 'string' && instance.node.length > 0) {
    return [instance.node];
  }
  return [];
}
