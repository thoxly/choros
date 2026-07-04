/**
 * web/src/screens/users-form.js — T-0583
 *
 * Pure, framework-free payload-assembly + validation + error-mapping for the
 * "Пользователи" (user accounts) screen (screen-users.jsx). JSX-free so it
 * unit-tests in isolation (mirrors agents-form.js / org-crud.js).
 *
 * WIRED CONTRACTS (exact, read from src/http/user-mgmt.ts):
 *   GET   /api/users/accounts            → 200 { accounts: [{employee_id, login, display_name, position, department, active}] }
 *   POST  /api/users                     { tenant_id, login, password, display_name, position_id?, role_id? } → 201 { employee_id, login }
 *   PATCH /api/users/:employee_id        { active: boolean } → 200 { employee_id, active }
 *
 * SECURITY — the central rule of this screen: the password is entered ONCE at
 * creation time (type=password, autoComplete=off) and sent ONLY in the POST
 * /api/users body. It is never stored client-side beyond the form's own local
 * state, never logged, never echoed back by the server (F1/N1) — this module
 * never returns it in any payload but the create request.
 */

const PASSWORD_MIN = 8;
const DISPLAY_NAME_MAX = 256;

function str(v) {
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------------------
// Create-account validation + payload  (POST /api/users)
// ---------------------------------------------------------------------------

/**
 * Validate the "создать учётку" form.
 * @param {{login?, password?, display_name?}} f
 * @returns {{valid:boolean, errors:Record<string,string>}}
 */
export function validateCreateUser(f) {
  const errors = {};
  const login = str(f?.login).trim();
  if (login.length === 0) errors.login = 'Укажите логин';

  const password = str(f?.password);
  if (password.length === 0) errors.password = 'Укажите пароль';
  else if (password.length < PASSWORD_MIN)
    errors.password = `Пароль: не короче ${PASSWORD_MIN} символов`;

  const name = str(f?.display_name).trim();
  if (name.length === 0) errors.display_name = 'Укажите отображаемое имя';
  else if (name.length > DISPLAY_NAME_MAX)
    errors.display_name = `Имя: не длиннее ${DISPLAY_NAME_MAX} символов`;

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Build the exact POST /api/users body. tenant_id comes from the caller's
 * active tenant (resolved elsewhere, e.g. getActiveTenantId()). Optional
 * position_id/role_id are omitted when empty so the server's typeof guards
 * fall through to their null defaults (mirrors buildHirePayload).
 * @returns body for POST /api/users
 */
export function buildCreateUserPayload(tenantId, f) {
  const body = {
    tenant_id: str(tenantId),
    login: str(f.login).trim(),
    password: str(f.password),
    display_name: str(f.display_name).trim(),
  };
  const positionId = str(f.position_id);
  if (positionId.length > 0) body.position_id = positionId;
  const roleId = str(f.role_id);
  if (roleId.length > 0) body.role_id = roleId;
  return body;
}

// ---------------------------------------------------------------------------
// Error mapping — honest surfacing of the user-mgmt contract.
// ---------------------------------------------------------------------------

/**
 * Map an HTTP failure to an actionable Russian message + optional field anchor.
 * Covers user-mgmt.ts error codes (create/list/patch).
 * @param {number} status
 * @param {unknown} body parsed JSON (may be null/non-object)
 * @param {string} [entity] label for the generic fallback
 * @returns {{ field?: string, message: string }}
 */
export function mapUserError(status, body, entity = 'операцию') {
  const obj = body && typeof body === 'object' ? body : undefined;
  const code = obj ? (obj.error?.code || obj.code) : undefined;
  const serverMsg = obj ? (obj.error?.message || obj.message) : undefined;

  if (status === 409 && code === 'EMAIL_TAKEN') {
    return { field: 'login', message: 'Такой логин уже занят.' };
  }
  if (status === 409) {
    return { field: 'login', message: 'Учётка с таким логином уже существует в этом тенанте.' };
  }
  if (status === 403) {
    return {
      message:
        'Недостаточно прав: создавать/изменять учётки может только владелец тенанта или администратор с соответствующим грантом.',
    };
  }
  if (status === 404) {
    return { message: serverMsg || 'Учётка не найдена (возможно, в другом тенанте).' };
  }
  if (status === 401) {
    return { message: 'Сессия не авторизована — войдите заново.' };
  }
  if (status === 503) {
    return { message: serverMsg || 'Сервис учёток временно недоступен (Keycloak). Повторите позже.' };
  }
  if (status === 400) {
    return { message: serverMsg || 'Проверьте корректность полей.' };
  }
  return { message: serverMsg || `Не удалось выполнить ${entity} (HTTP ${status}).` };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Human label + StatusChip status for an account's active flag.
 * @param {boolean} active
 * @returns {{ chip: string, label: string }}
 */
export function accountStatusMeta(active) {
  return active
    ? { chip: 'done', label: 'Активна' }
    : { chip: 'paused', label: 'Деактивирована' };
}

/**
 * Build the position dropdown options from a GET /api/org/tenant-state
 * positions array (mirrors positionOptions in agents-form.js).
 * @param {Array<{id?:string, slug?:string, title?:string}>} rows
 * @returns {Array<{id:string,label:string}>}
 */
export function positionOptions(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && typeof r.id === 'string' && r.id.length > 0)
    .map((r) => ({
      id: r.id,
      label: str(r.title) || str(r.slug) || r.id,
    }));
}
