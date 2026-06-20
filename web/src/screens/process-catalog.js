/**
 * web/src/screens/process-catalog.js — T-0270, updated T-0351 E16
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
 *   POST /api/process-app-bindings  { process_key, application_id, form_key?,
 *                                      trigger_type?, start_form_key?, field_mapping? }
 *                                    → 201 { id, process_key, application_id, form_key,
 *                                            trigger_type, start_form_key, field_mapping }
 *                                    → 400 VALIDATION | 401 | 404 (app not in tenant)
 *
 * T-0351 E16: trigger_type + start_form_key + field_mapping added to binding payload.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v) {
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------------------
// T-0351 E16: trigger type constants (mirrors migration 082 CHECK constraint)
// ---------------------------------------------------------------------------

/** Valid trigger type values from the backend contract. */
export const TRIGGER_TYPES = ['on_create', 'record_action', 'launcher', 'auto'];

/** Russian labels for trigger types (used in the trigger editor UI). */
export const TRIGGER_TYPE_LABELS = {
  on_create:     'При создании записи (создать = запустить)',
  record_action: 'Действие на записи (кнопка)',
  launcher:      'Лаунчер (выбор из «Создать…»)',
  auto:          'Авто (событие / таймер / условие)',
};

// ---------------------------------------------------------------------------
// Binding form — validation + payload (POST /api/process-app-bindings)
// ---------------------------------------------------------------------------

/**
 * Validate the "bind process → application" form.
 * process_key + application_id are REQUIRED by the backend; other fields optional.
 * T-0351: trigger_type validated against the 4-value set when present.
 * @param {{process_key?,application_id?,form_key?,trigger_type?,start_form_key?,field_mapping_raw?}} f
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

  // T-0351 E16: trigger_type must be one of the 4 valid values when provided.
  const tt = str(f?.trigger_type).trim();
  if (tt.length > 0 && !TRIGGER_TYPES.includes(tt)) {
    errors.trigger_type = `Допустимые типы: ${TRIGGER_TYPES.join(', ')}`;
  }

  // T-0351 E16: field_mapping_raw is a user-entered text (one "varName=fieldPath"
  // per line). Validate: each non-empty line must contain '='.
  const raw = str(f?.field_mapping_raw);
  if (raw.trim().length > 0) {
    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const badLines = lines.filter((l) => !l.includes('='));
    if (badLines.length > 0) {
      errors.field_mapping_raw = 'Каждая строка должна быть в формате переменная=поле';
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Parse the user-entered field_mapping_raw text (one "varName=fieldPath" per line)
 * into a { [varName]: fieldPath } object.
 * Empty lines and lines without '=' are ignored (validation catches bad lines).
 * @param {string} raw
 * @returns {Record<string,string>}
 */
export function parseFieldMapping(raw) {
  const result = {};
  if (typeof raw !== 'string') return result;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const eqIdx = trimmed.indexOf('=');
    const varName = trimmed.slice(0, eqIdx).trim();
    const fieldPath = trimmed.slice(eqIdx + 1).trim();
    if (varName.length > 0 && fieldPath.length > 0) {
      result[varName] = fieldPath;
    }
  }
  return result;
}

/**
 * Serialize a field_mapping object to user-editable text (one "varName=fieldPath" per line).
 * @param {Record<string,string>|null|undefined} mapping
 * @returns {string}
 */
export function serializeFieldMapping(mapping) {
  if (!mapping || typeof mapping !== 'object') return '';
  return Object.entries(mapping)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/**
 * Build the exact POST /api/process-app-bindings body.
 * T-0351 E16: includes trigger_type, start_form_key, field_mapping.
 * form_key and start_form_key are sent as null when empty.
 * NEVER sends an application_id derived from a header — it comes from the picked application.
 * @param {{process_key,application_id,form_key?,trigger_type?,start_form_key?,field_mapping_raw?}} f
 * @returns body for POST /api/process-app-bindings
 */
export function buildBindingPayload(f) {
  const formKey = str(f?.form_key).trim();
  const triggerType = str(f?.trigger_type).trim();
  const startFormKey = str(f?.start_form_key).trim();
  const fieldMapping = parseFieldMapping(str(f?.field_mapping_raw));
  return {
    process_key: str(f.process_key).trim(),
    application_id: str(f.application_id).trim(),
    form_key: formKey.length > 0 ? formKey : null,
    // T-0351 E16 fields: omit trigger_type if empty (backend defaults to 'launcher').
    ...(triggerType.length > 0 ? { trigger_type: triggerType } : {}),
    start_form_key: startFormKey.length > 0 ? startFormKey : null,
    field_mapping: fieldMapping,
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

/**
 * T-0351 E16: Russian label for a binding's trigger_type.
 * @param {string} triggerType
 */
export function triggerTypeLabel(triggerType) {
  return TRIGGER_TYPE_LABELS[triggerType] || triggerType || 'Лаунчер';
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
