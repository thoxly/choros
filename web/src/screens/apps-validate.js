/**
 * web/src/screens/apps-validate.js
 *
 * Pure, framework-free validation + error-mapping for the "Создать приложение"
 * form (T-0265). Kept JSX-free so it is unit-testable in isolation (mirrors the
 * pure-helper pattern of screen-inbox.jsx's slaState/warnWindowMs).
 *
 * The slug regex is the EXACT mirror of the backend contract
 * (src/http/applications.ts SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/). Client-side
 * validation is a UX convenience only — the server is the source of truth and
 * still enforces 400 VALIDATION / 409 CONFLICT. We never invent acceptance the
 * server would reject, nor reject what the server would accept.
 */

// EXACT mirror of backend SLUG_RE (src/http/applications.ts).
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const DISPLAY_NAME_MAX = 256;

/**
 * Validate the create-application form fields client-side.
 *
 * T-0650 [UX-study §7]: slug is now OPTIONAL — an empty slug means "let the
 * server auto-generate one from display_name" (see SlugField). Only a
 * NON-EMPTY slug is grammar-checked; this mirrors the server's contract
 * (src/http/applications.ts: blank/absent slug → auto-generate, explicit
 * non-empty slug → validated as before).
 *
 * @param {{ slug?: string, display_name?: string, description?: string }} fields
 * @returns {{ valid: boolean, errors: { slug?: string, display_name?: string, description?: string } }}
 */
export function validateAppForm(fields) {
  const errors = {};
  const slug = typeof fields?.slug === "string" ? fields.slug : "";
  const displayName = typeof fields?.display_name === "string" ? fields.display_name : "";
  const description = fields?.description;

  if (slug.length > 0 && !SLUG_RE.test(slug)) {
    errors.slug = "Слаг: строчные латинские буквы, цифры и дефис (1–64 символа)";
  }

  if (displayName.trim().length === 0) {
    errors.display_name = "Укажите название";
  } else if (displayName.length > DISPLAY_NAME_MAX) {
    errors.display_name = `Название не длиннее ${DISPLAY_NAME_MAX} символов`;
  }

  if (description != null && typeof description !== "string") {
    errors.description = "Описание должно быть строкой";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Map a non-2xx create response (status + parsed body) to a user-facing message.
 * Honest surfacing of the backend contract: 409 → "слаг занят", 400 → the
 * server's VALIDATION message (falls back to a generic one), 401 → re-login hint.
 *
 * @param {number} status HTTP status code.
 * @param {unknown} body  Parsed JSON body (may be null / non-object).
 * @returns {{ field?: 'slug', message: string }}
 */
export function mapCreateError(status, body) {
  const serverMsg =
    body && typeof body === "object"
      ? (body.error?.message || body.message)
      : undefined;
  if (status === 409) {
    return { field: "slug", message: "Слаг уже занят в этом тенанте" };
  }
  if (status === 400) {
    return { message: serverMsg || "Проверьте корректность полей" };
  }
  if (status === 401) {
    return { message: "Сессия не авторизована — войдите заново" };
  }
  return { message: serverMsg || `Не удалось создать приложение (HTTP ${status})` };
}
