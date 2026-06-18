/**
 * web/src/screens/process-catalog.js — T-0270
 *
 * Pure, framework-free logic for the process-catalog section of screen-processes.jsx:
 *   - binding payload assembly + validation (POST /api/process-app-bindings);
 *   - definition / binding display mapping;
 *   - HTTP error → Russian message mapping.
 * JSX-free so it unit-tests in isolation (mirrors agents-form.js / records-form.js).
 *
 * WIRED CONTRACTS (exact, read from src/http/process-catalog.ts):
 *   GET  /api/process-catalog       → 200 { definitions:[], instances:[], bindings:[] }
 *   GET  /api/process-app-bindings  → 200 { bindings:[] }
 *   POST /api/process-app-bindings  { process_key, application_id, form_key? }
 *                                    → 201 { id, process_key, application_id, form_key }
 *                                    → 400 VALIDATION | 401 | 404 (app not in tenant)
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v) {
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------------------
// Binding form — validation + payload (POST /api/process-app-bindings)
// ---------------------------------------------------------------------------

/**
 * Validate the "bind process → application" form.
 * process_key + application_id are REQUIRED by the backend; form_key is optional.
 * @param {{process_key?,application_id?,form_key?}} f
 * @returns {{valid:boolean, errors:Record<string,string>}}
 */
export function validateBindingForm(f) {
  const errors = {};
  const procKey = str(f?.process_key).trim();
  if (procKey.length === 0) errors.process_key = 'Выберите процесс';

  const appId = str(f?.application_id).trim();
  if (appId.length === 0) errors.application_id = 'Выберите приложение';
  else if (!UUID_RE.test(appId))
    errors.application_id = 'Некорректный идентификатор приложения';

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Build the exact POST /api/process-app-bindings body. form_key is sent as null when
 * empty (the backend coerces empty → null anyway, but we are explicit). NEVER sends
 * an application_id derived from a header — it comes from the picked application.
 * @param {{process_key,application_id,form_key?}} f
 * @returns body for POST /api/process-app-bindings
 */
export function buildBindingPayload(f) {
  const formKey = str(f?.form_key).trim();
  return {
    process_key: str(f.process_key).trim(),
    application_id: str(f.application_id).trim(),
    form_key: formKey.length > 0 ? formKey : null,
  };
}

// ---------------------------------------------------------------------------
// Display mapping — pure, used by the screen for honest rendering.
// ---------------------------------------------------------------------------

/**
 * Russian label for a definition's source. The backend only emits 'modeler' (a real
 * process_definition row) or 'engine' (derived from REAL running instances) — never a
 * mock, so both labels are honest.
 * @param {string} source
 */
export function definitionSourceLabel(source) {
  if (source === 'modeler') return 'Конструктор';
  if (source === 'engine') return 'Движок';
  return source || '—';
}

/**
 * Russian label for a definition status.
 * @param {string} status
 */
export function definitionStatusLabel(status) {
  switch (status) {
    case 'draft':
      return 'Черновик';
    case 'published':
      return 'Опубликован';
    case 'deployed':
      return 'Развёрнут';
    default:
      return status || '—';
  }
}

/**
 * Build the application <select> options from GET /api/applications.
 * Returns [{ value, label }]. Defensive against missing fields.
 * @param {Array<{id?,slug?,display_name?}>} rows
 * @returns {Array<{value:string,label:string}>}
 */
export function applicationOptions(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && typeof r.id === 'string' && r.id.length > 0)
    .map((r) => ({
      value: r.id,
      label: str(r.display_name) || str(r.slug) || r.id,
    }));
}

/**
 * Build the process-definition <select> options from a process-catalog
 * `definitions` array. Returns [{ value, label }] keyed by process_key.
 * @param {Array<{process_key?,name?}>} defs
 * @returns {Array<{value:string,label:string}>}
 */
export function definitionOptions(defs) {
  if (!Array.isArray(defs)) return [];
  return defs
    .filter((d) => d && typeof d.process_key === 'string' && d.process_key.length > 0)
    .map((d) => ({
      value: d.process_key,
      label: str(d.name) ? `${str(d.name)} (${d.process_key})` : d.process_key,
    }));
}

/**
 * Render-friendly label for a binding row's target application. Falls back honestly
 * when the application has been deleted (LEFT JOIN → null) so we never show a stale
 * name as if it were live.
 * @param {{application_name?,application_slug?,application_id?}} b
 */
export function bindingApplicationLabel(b) {
  const name = str(b?.application_name);
  if (name) return name;
  const slug = str(b?.application_slug);
  if (slug) return slug;
  return '(приложение удалено)';
}

// ---------------------------------------------------------------------------
// Error mapping — honest surfacing of the process-catalog/binding contracts.
// ---------------------------------------------------------------------------

/**
 * Map an HTTP failure to an actionable Russian message + optional field anchor.
 * @param {number} status
 * @param {unknown} body parsed JSON (may be null/non-object)
 * @returns {{ field?: string, message: string }}
 */
export function mapBindingError(status, body) {
  const obj = body && typeof body === 'object' ? body : undefined;
  const serverMsg = obj ? (obj.error?.message || obj.message) : undefined;

  if (status === 404) {
    return { field: 'application_id', message: 'Приложение не найдено в этом тенанте.' };
  }
  if (status === 401) {
    return { message: 'Сессия не авторизована — войдите заново.' };
  }
  if (status === 400) {
    return { message: serverMsg || 'Проверьте корректность полей.' };
  }
  return { message: serverMsg || `Не удалось создать связь (HTTP ${status}).` };
}
