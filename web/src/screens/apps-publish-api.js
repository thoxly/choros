/* ============================================================================
   CHOROS — apps-publish-api.js  (T-0563 · «Опубликовать решение»)

   Тонкий типизированный клиент к ДВУМ frozen-эндпоинтам публикации связанного
   решения (ADR T-0561, PD-26). Бэкенд (отдельная задача) реализует ИМЕННО этот
   контракт — здесь только клиент к нему + чистые хелперы для UI. JSX-free, чтобы
   тестировалось vitest без DOM (конвенция apps-validate.js / process-editor-api.js).

   FROZEN HTTP CONTRACT (не меняем — зеркалим ровно):
     1. GET  /api/applications/:id/publish-preview
        → 200 {
             app_id: string,
             items: Array<{
               kind: "application"|"process"|"form",
               id: string,
               name: string,
               tier: "draft"|"published",
               will_publish: boolean
             }>,
             counts: { total: number, to_publish: number }
           }
     2. POST /api/applications/:id/publish-solution
        → 200 {
             app_id: string,
             results: Array<{
               kind: "application"|"process"|"form",
               id: string,
               name: string,
               ok: boolean,
               error: string|null
             }>,
             all_ok: boolean
           }

   Авторизация — authHeaders() (keycloak Bearer / dev X-Dev-User), как у прочих
   экранов. Ошибки — Error с человекочитаемым message (никаких голых «HTTP 500»
   там, где сервер прислал текст).
   ============================================================================ */

import { authHeaders } from '../app-shell/dev-auth.js';

/** Русская метка вида элемента для confirm-списка и результатов. */
export const KIND_LABEL = {
  application: 'приложение',
  process: 'процесс',
  form: 'форма шага',
};

/** Достать честный текст ошибки из тела ответа (или упасть на «HTTP <code>»). */
async function readErr(res) {
  let detail = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    detail = body?.error?.message || body?.message || detail;
  } catch { /* тело не JSON — оставляем HTTP-код */ }
  return detail;
}

/**
 * GET publish-preview — собрать связанный набор для приложения (1 hop, derive
 * на сервере) и вернуть список того, что войдёт в публикацию.
 *
 * @param {string} appId — UUID приложения (route :id).
 * @returns {Promise<{ app_id: string, items: PreviewItem[], counts: { total: number, to_publish: number } }>}
 * @throws {Error} на любой не-2xx (message = честный текст сервера).
 */
export async function fetchPublishPreview(appId) {
  const res = await fetch(
    `/api/applications/${encodeURIComponent(appId)}/publish-preview`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    throw new Error(`Не удалось собрать решение: ${await readErr(res)}`);
  }
  const data = await res.json();
  return normalizePreview(data);
}

/**
 * POST publish-solution — промоутнуть весь связанный набор вместе. Возвращает
 * per-item результат (✓/✗ с причиной). Партиал НЕ бросает исключение — это
 * штатный «частично доехало», честно показываемый пользователю.
 *
 * @param {string} appId — UUID приложения.
 * @returns {Promise<{ app_id: string, results: ResultItem[], all_ok: boolean }>}
 * @throws {Error} только на транспортной/серверной ошибке (не-2xx без тела результатов).
 */
export async function publishSolution(appId) {
  const res = await fetch(
    `/api/applications/${encodeURIComponent(appId)}/publish-solution`,
    { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' } },
  );
  if (!res.ok) {
    throw new Error(`Публикация не выполнена: ${await readErr(res)}`);
  }
  const data = await res.json();
  return normalizeResults(data);
}

/* --------------------------------------------------------------------------
   Чистые хелперы — источник UI-логики, покрыты тестами напрямую.
   -------------------------------------------------------------------------- */

/** Нормализовать/защитить ответ preview (чужой формат → безопасная форма). */
export function normalizePreview(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const counts = data?.counts || {};
  return {
    app_id: data?.app_id ?? null,
    items,
    counts: {
      total: Number.isFinite(counts.total) ? counts.total : items.length,
      to_publish: Number.isFinite(counts.to_publish)
        ? counts.to_publish
        : items.filter((i) => i.will_publish).length,
    },
  };
}

/** Нормализовать/защитить ответ publish-solution. */
export function normalizeResults(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  return {
    app_id: data?.app_id ?? null,
    results,
    all_ok: typeof data?.all_ok === 'boolean'
      ? data.all_ok
      : results.length > 0 && results.every((r) => r.ok),
  };
}

/**
 * Человекочитаемая строка confirm-списка для одного элемента превью.
 * «приложение X» / «процесс Z» / «форма шага Y».
 */
export function previewItemLabel(item) {
  const kind = KIND_LABEL[item?.kind] || item?.kind || 'элемент';
  return `${kind} «${item?.name ?? '—'}»`;
}

/**
 * Есть ли у ПУБЛИКУЕМОГО (already-published) приложения неопубликованные
 * изменения — т.е. в превью есть элементы с will_publish. Основа бейджа
 * «есть неопубликованные изменения» (ADR §2 п.5).
 *
 * @param {{ tier?: string }} app — строка приложения (tier из GET /api/applications).
 * @param {{ counts?: { to_publish?: number } }} preview — ответ preview.
 */
export function hasUnpublishedChanges(app, preview) {
  if (!app || app.tier !== 'published') return false;
  const toPublish = preview?.counts?.to_publish;
  return Number.isFinite(toPublish) && toPublish > 0;
}

/** Сводка результатов для тоста: {ok, failed, total, allOk}. */
export function summarizeResults(results) {
  const list = Array.isArray(results) ? results : [];
  const ok = list.filter((r) => r.ok).length;
  const failed = list.length - ok;
  return { ok, failed, total: list.length, allOk: list.length > 0 && failed === 0 };
}
