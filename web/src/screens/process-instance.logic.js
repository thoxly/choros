/**
 * web/src/screens/process-instance.logic.js — T-0556
 *
 * Pure (DOM-free, React-free) helpers for the read-only process-instance detail
 * view (screen-process-instance.jsx). Logic lives in this .js sibling so it is
 * unit-testable in the node vitest tier (the .jsx screen carries only rendering),
 * matching the codebase idiom (screen-audit.logic.js, process-branch-rules.js).
 *
 * Backend contract: GET /api/processes/:id returns a single ProcessInstance
 * (src/http/processes.ts):
 *   { id, name, procId, status: running|waiting|done|failed,
 *     node, nodes?: string[] (T-0456 concurrent branches), started, elapsed,
 *     progress: { done, total }, execs: (human|agent|service)[], recordId? }
 *
 * No new backend endpoint is invented (per ADR T-0556 §3): history is derived
 * best-effort from the existing /api/audit projection by filtering its redacted
 * events to those whose `target` matches the instance id.
 */

/**
 * Navigation target for the instance detail view.
 * Returns `/processes/:instanceId` (URL-encoded) for a valid id, else null so a
 * caller can avoid rendering a dead affordance (UX G3 — no enabled dead link).
 *
 * @param {string|null|undefined} instanceId
 * @returns {string|null}
 */
export function instanceDetailPath(instanceId) {
  if (typeof instanceId !== 'string') return null;
  const trimmed = instanceId.trim();
  if (!trimmed) return null;
  return `/processes/${encodeURIComponent(trimmed)}`;
}

/**
 * The CONCURRENT active nodes/steps of an instance. Prefers the T-0456 `nodes`
 * array (an AND-split leaves several active at once); falls back to the single
 * `node` string for seed fixtures without `nodes`. Returns [] when neither is set
 * (e.g. a `done` instance with no waiting step).
 *
 * @param {{ node?: string, nodes?: string[] }|null|undefined} instance
 * @returns {string[]}
 */
export function currentNodes(instance) {
  if (!instance || typeof instance !== 'object') return [];
  if (Array.isArray(instance.nodes) && instance.nodes.length > 0) {
    return instance.nodes.filter((n) => typeof n === 'string' && n.length > 0);
  }
  if (typeof instance.node === 'string' && instance.node.length > 0) {
    return [instance.node];
  }
  return [];
}

/**
 * Human-readable progress label "done/total" (e.g. "4/7"). Returns "—" when the
 * progress object is missing or malformed (honest empty, never "undefined/...").
 *
 * @param {{ done?: number, total?: number }|null|undefined} progress
 * @returns {string}
 */
export function progressLabel(progress) {
  if (!progress || typeof progress !== 'object') return '—';
  const { done, total } = progress;
  if (typeof done !== 'number' || typeof total !== 'number') return '—';
  return `${done}/${total}`;
}

/**
 * Progress as a 0..1 fraction for a progress bar. Returns 0 when total is 0 or
 * the shape is malformed; clamps to [0, 1].
 *
 * @param {{ done?: number, total?: number }|null|undefined} progress
 * @returns {number}
 */
export function progressFraction(progress) {
  if (!progress || typeof progress !== 'object') return 0;
  const { done, total } = progress;
  if (typeof done !== 'number' || typeof total !== 'number' || total <= 0) return 0;
  const f = done / total;
  if (f < 0) return 0;
  if (f > 1) return 1;
  return f;
}

/**
 * Best-effort instance history: filter the /api/audit redacted projection to the
 * events that reference this instance via their `target` field. Reuses what the
 * Audit screen already consumes (no new backend endpoint — ADR §3). When no event
 * targets the instance the result is [], and the screen renders an honest
 * "no detailed history" note sourcing from the instance projection instead.
 *
 * @param {Array<{ target?: string|null }>|null|undefined} events  audit projection rows
 * @param {string} instanceId
 * @returns {Array<object>}
 */
export function filterInstanceHistory(events, instanceId) {
  if (!Array.isArray(events) || typeof instanceId !== 'string' || !instanceId) {
    return [];
  }
  return events.filter((ev) => ev && ev.target === instanceId);
}

/**
 * Whether a record-source link should be offered. True only when recordId is a
 * non-empty string (the instance was started by on_create/record_action — T-0414).
 *
 * @param {{ recordId?: string }|null|undefined} instance
 * @returns {boolean}
 */
export function hasSourceRecord(instance) {
  return Boolean(
    instance &&
    typeof instance.recordId === 'string' &&
    instance.recordId.trim().length > 0,
  );
}

/**
 * T-0609: whether the instance carries any process variables to render. Live
 * acceptance finding — a P0 gateway-branch diagnosis previously required raw SQL
 * against the Flowable tables because no product surface showed instance
 * variables. Backend contract: GET /api/processes/:id now (best-effort, DB mode
 * only) adds `variables: Array<{name, value}>`.
 *
 * @param {{ variables?: Array<{name: string, value: unknown}> }|null|undefined} instance
 * @returns {boolean}
 */
export function hasVariables(instance) {
  return Boolean(
    instance &&
    Array.isArray(instance.variables) &&
    instance.variables.length > 0,
  );
}

/**
 * T-0609: whether the engine-sourced DETAILED history (step/kind/start/end/
 * completedBy) is available for this instance, as opposed to the pre-T-0609
 * best-effort audit-projection filter (filterInstanceHistory above). Backend
 * contract: GET /api/processes/:id sets `historyAvailable: true` only when the
 * engine's historic-activity-instances read succeeded (DB mode + reachable
 * engine); absent/false ⇒ the caller keeps the OLD best-effort audit path
 * unchanged (regression-safety for no-DB / no-engine deployments).
 *
 * @param {{ historyAvailable?: boolean }|null|undefined} instance
 * @returns {boolean}
 */
export function hasDetailedHistory(instance) {
  return Boolean(instance && instance.historyAvailable === true);
}

/**
 * T-0609: human-readable formatting of one engine-sourced history row's
 * start/end timestamps. Flowable returns ISO-8601 strings (or null while a
 * step is still active / has not started — should not happen for startTime,
 * but endTime is legitimately null for the currently-active step). Returns
 * '—' for null/invalid so the UI never shows "Invalid Date".
 *
 * @param {string|null|undefined} isoTs
 * @returns {string}
 */
export function formatHistoryTimestamp(isoTs) {
  if (typeof isoTs !== 'string' || isoTs.length === 0) return '—';
  const d = new Date(isoTs);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
