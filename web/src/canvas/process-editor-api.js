/* ============================================================================
   CHOROS — process-editor-api.js
   T-0324: Backend API calls for the BPMN process editor.
   T-0377 (B19): saveProcessDef accepts optional processKey — when absent the
                 backend auto-generates a slug from the name and returns it as
                 `assignedKey`. Callers must use the returned key for navigation.

   Exports:
     fetchProcessDef(processKey)            → Promise<{ bpmnXml, version, status, id } | null>
     saveProcessDef(processKey, name, xml)  → Promise<{ id, processKey, assignedKey, version, status }>
       processKey may be null/undefined for new processes — backend assigns one.
     publishProcessDef(processKey)          → Promise<{ id, processKey, version, status, deploymentId }>

   All functions:
   - Use authHeaders() + x-tenant-id (same convention as screen-org, screen-agents).
   - Throw an Error with a user-readable message on HTTP errors.
   - Are pure async functions — no side effects, no global state.

   Tenant scope:
   - The process-defs.ts backend requires x-tenant-id header (dev mode) in addition
     to x-dev-user. This mirrors the screen-processes.jsx DEV_TENANT_ID pattern.
   ============================================================================ */

import { authHeaders } from '../app-shell/dev-auth.js';

// Dev tenant UUID — same constant used by screen-processes.jsx, screen-org.jsx etc.
const DEV_TENANT_ID = 'a0000000-0000-0000-0000-000000000001';

/** Build the full header set for process-def API calls. */
function apiHeaders(extra = {}) {
  return {
    ...authHeaders(),
    'x-tenant-id': DEV_TENANT_ID,
    ...extra,
  };
}

/**
 * Load the latest version of a process definition from the backend.
 *
 * @param {string} processKey — the process key (route :id param, not UUID).
 * @returns {Promise<{ bpmnXml: string, version: number, status: string, id: string, name: string } | null>}
 *   null if the definition does not exist yet (404) — caller should use blank XML.
 * @throws {Error} on non-404 HTTP errors.
 */
export async function fetchProcessDef(processKey) {
  const res = await fetch(`/api/process-defs/${encodeURIComponent(processKey)}`, {
    headers: apiHeaders(),
  });

  if (res.status === 404) return null;

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.error?.message || body?.message || detail;
    } catch { /* ignore */ }
    throw new Error(`Ошибка загрузки процесса: ${detail}`);
  }

  const data = await res.json();
  return {
    id: data.id,
    processKey: data.processKey,
    name: data.name,
    bpmnXml: data.bpmnXml,
    version: data.version,
    status: data.status,
  };
}

/**
 * Save (upsert) a BPMN XML draft to the backend.
 * Creates a new version row each call (upsert-by-version semantics in process-defs.ts).
 *
 * T-0377 (B19): processKey is now optional (null/undefined for new processes).
 * When absent, the backend auto-generates a collision-safe slug from `name` and
 * returns it as `assignedKey`. Callers should use `assignedKey` (always present)
 * rather than `processKey` to obtain the definitive key for the saved definition.
 *
 * @param {string|null|undefined} processKey — existing key, or null/undefined for new.
 * @param {string} name — display name for the process definition.
 * @param {string} bpmnXml
 * @returns {Promise<{ id: string, processKey: string, assignedKey: string, version: number, status: string }>}
 * @throws {Error} on HTTP errors or validation rejection.
 */
export async function saveProcessDef(processKey, name, bpmnXml) {
  // Build request body — omit processKey when null/undefined so the backend
  // triggers auto-generation rather than treating "" as an invalid key.
  const requestBody = { name, bpmnXml };
  if (processKey) requestBody.processKey = processKey;

  const res = await fetch('/api/process-defs', {
    method: 'POST',
    headers: apiHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.error?.message || body?.message || detail;
    } catch { /* ignore */ }
    throw new Error(`Ошибка сохранения: ${detail}`);
  }

  const data = await res.json();
  // Normalise: assignedKey is always the canonical key (backend guarantees it).
  return {
    ...data,
    assignedKey: data.assignedKey ?? data.processKey,
  };
}

/**
 * Publish a process definition: lint → deploy to Flowable engine → persist deployment_id.
 *
 * On 422 the backend returns { error: { code: "BPMN_LINT_FAILED", violations: [...] } }.
 * This function surfaces that as an Error with a violations property attached.
 *
 * @param {string} processKey
 * @returns {Promise<{ id: string, processKey: string, version: number, status: string, deploymentId: string }>}
 * @throws {Error} on lint failure (err.violations set), engine error, or HTTP errors.
 */
export async function publishProcessDef(processKey) {
  const res = await fetch(`/api/process-defs/${encodeURIComponent(processKey)}/publish`, {
    method: 'POST',
    headers: apiHeaders(),
  });

  if (res.status === 422) {
    let violations = [];
    try {
      const body = await res.json();
      violations = body?.error?.violations || [];
    } catch { /* ignore */ }
    const err = new Error(`Диаграмма не прошла проверку перед публикацией`);
    err.violations = violations;
    throw err;
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.error?.message || body?.message || detail;
    } catch { /* ignore */ }
    throw new Error(`Ошибка публикации: ${detail}`);
  }

  return res.json();
}
