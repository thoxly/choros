/**
 * web/src/screens/register-form.js — T-0342
 *
 * Pure logic for the registration form:
 *   - validateRegisterForm(fields) → { valid, errors }
 *   - mapRegisterError(status, body) → human-readable RU message string
 *   - postRegister(fields) → Promise<{ ok, data, status }>
 *
 * No React, no DOM — fully unit-testable with vitest in Node.
 */

/** Minimal RFC-lite email check. Pure. */
export function isValidEmail(s) {
  if (typeof s !== 'string' || !s.trim()) return false;
  const i = s.lastIndexOf('@');
  if (i < 1) return false;
  const domain = s.slice(i + 1);
  return domain.includes('.') && domain.length >= 3;
}

/**
 * Validate the registration form fields.
 * Returns { valid: boolean, errors: { orgName?, email?, password? } }.
 */
export function validateRegisterForm({ orgName = '', email = '', password = '' } = {}) {
  const errors = {};
  const trimOrg = String(orgName).trim();
  const trimEmail = String(email).trim();
  const trimPass = String(password);

  if (!trimOrg) {
    errors.orgName = 'Введите название организации';
  } else if (trimOrg.length > 120) {
    errors.orgName = 'Название не должно превышать 120 символов';
  }

  if (!trimEmail) {
    errors.email = 'Введите email';
  } else if (!isValidEmail(trimEmail)) {
    errors.email = 'Введите корректный email';
  }

  if (!trimPass) {
    errors.password = 'Введите пароль';
  } else if (trimPass.length < 8) {
    errors.password = 'Пароль должен содержать не менее 8 символов';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Map an HTTP status + parsed error body to a user-friendly RU message.
 * Pure.
 *
 * @param {number} status  — HTTP status code (400, 409, 503, 500, …)
 * @param {object} body    — parsed JSON body; may have body.error.code
 * @returns {string}
 */
export function mapRegisterError(status, body) {
  const code = body?.error?.code || '';
  if (status === 409 && code === 'EMAIL_TAKEN') {
    return 'Пользователь с таким email уже зарегистрирован';
  }
  if (status === 409 && code === 'ORG_TAKEN') {
    return 'Организация с таким названием уже существует';
  }
  if (status === 409) {
    return 'Такой email или название организации уже заняты';
  }
  if (status === 400) {
    const msg = body?.error?.message;
    return msg ? `Ошибка данных: ${msg}` : 'Проверьте введённые данные';
  }
  if (status === 503) {
    return 'Сервис регистрации временно недоступен. Попробуйте позже.';
  }
  return 'Ошибка регистрации. Попробуйте ещё раз.';
}

/**
 * Submit the registration form to POST /api/register.
 * Returns { ok: bool, status: number, data: object }.
 * Never throws — wraps all network errors in { ok: false, status: 0, data: {} }.
 */
export async function postRegister({ orgName, email, password }, fetchFn = globalThis.fetch) {
  try {
    const res = await fetchFn('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgName: String(orgName).trim(),
        email: String(email).trim(),
        password: String(password),
      }),
    });
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}
