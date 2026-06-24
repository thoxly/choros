/* ============================================================================
   CHOROS — dmn-editor-api.js
   T-0435: API client for the DMN rule-table authoring screen.

   Mirrors the fetch/error style of process-editor-api.js exactly:
     - authHeaders() for mode-aware auth (x-dev-user in dev, Bearer in KC).
     - Throws Error with a user-readable Russian message on HTTP errors.
     - Pure async functions, no global state, no side effects.

   Exports:
     listRuleTables(processKey)           → Promise<Array>
     getRuleTable(id)                     → Promise<object>
     saveRuleTable(draft)                 → Promise<{ id: string }>
     publishRuleTable(id)                 → Promise<{ id, status }>

   API shapes consumed (T-0433):
     GET  /api/dmn-rule-tables?processKey=…   → array of rule-table rows
     GET  /api/dmn-rule-tables/:id            → single rule-table row
     POST /api/dmn-rule-tables                → 201 { id }
       body: { name, hitPolicy: "FIRST", rules: [...], processKey? }
       rule shape: { conditions: [{ field, operator, value? }], effects: [{ kind: "set_routing_outcome", name, value }] }
     POST /api/dmn-rule-tables/:id/publish    → 200 { id, status: "published" }
   ============================================================================ */

import { authHeaders } from '../app-shell/dev-auth.js';

/**
 * List all DMN rule tables for the current actor's tenant, optionally filtered
 * by processKey.
 *
 * @param {string} processKey — the process key to filter by.
 * @returns {Promise<Array>} array of rule-table summary rows (may be empty).
 * @throws {Error} on HTTP errors.
 */
export async function listRuleTables(processKey) {
  const qs = processKey ? `?processKey=${encodeURIComponent(processKey)}` : '';
  const res = await fetch(`/api/dmn-rule-tables${qs}`, {
    headers: authHeaders(),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.message || body?.error || detail;
    } catch { /* ignore */ }
    throw new Error(`Ошибка загрузки правил ветвления: ${detail}`);
  }

  return res.json();
}

/**
 * Load a single DMN rule table by id.
 *
 * @param {string} id — UUID of the rule table.
 * @returns {Promise<object>} the full rule-table row including definition.
 * @throws {Error} on HTTP errors.
 */
export async function getRuleTable(id) {
  const res = await fetch(`/api/dmn-rule-tables/${encodeURIComponent(id)}`, {
    headers: authHeaders(),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.message || body?.error || detail;
    } catch { /* ignore */ }
    throw new Error(`Ошибка загрузки правила: ${detail}`);
  }

  return res.json();
}

/**
 * Save (upsert) a DMN rule table as a draft.
 *
 * The backend validates: hitPolicy must be 'FIRST', each rule needs at least one
 * set_routing_outcome effect, all routing effects must share the same name.
 *
 * @param {object} draft — { name, hitPolicy: "FIRST", rules, processKey? }
 * @returns {Promise<{ id: string }>} the persisted draft's id.
 * @throws {Error} on HTTP errors or validation rejection (400 with violations).
 */
export async function saveRuleTable(draft) {
  const res = await fetch('/api/dmn-rule-tables', {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      // Surface first violation message if present.
      if (Array.isArray(body?.violations) && body.violations.length > 0) {
        detail = body.violations[0].message || detail;
      } else {
        detail = body?.message || body?.error || detail;
      }
    } catch { /* ignore */ }
    throw new Error(`Ошибка сохранения правил: ${detail}`);
  }

  return res.json(); // { id }
}

/**
 * Publish a DMN rule table (flip status draft → published).
 * After publishing the runtime evaluator picks it up immediately.
 *
 * @param {string} id — UUID of the rule table to publish.
 * @returns {Promise<{ id: string, status: string }>}
 * @throws {Error} on HTTP errors.
 */
export async function publishRuleTable(id) {
  const res = await fetch(`/api/dmn-rule-tables/${encodeURIComponent(id)}/publish`, {
    method: 'POST',
    headers: authHeaders(),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.message || body?.error || detail;
    } catch { /* ignore */ }
    throw new Error(`Ошибка публикации правил: ${detail}`);
  }

  return res.json(); // { id, status: "published" }
}
