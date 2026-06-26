/* ============================================================================
   CHOROS — screen-audit.logic.js  (T-0500)
   Pure, DOM-free logic for the audit screen — extracted so it is testable in the
   project's node (no-jsdom) web test tier. The .jsx screen imports these.
   ============================================================================ */

/**
 * Infer the executor type behind an audit action — for the rail glyph only.
 * The server does NOT send an exec-type; this is purely visual classification by
 * the event `type` prefix.
 * @param {string} action  the audit event `type` (e.g. "grant.create").
 * @returns {"human"|"agent"|"service"}
 */
export function execTypeOf(action) {
  if (typeof action !== 'string') return 'service';
  if (action.startsWith('agent.') || action.startsWith('agent_')) return 'agent';
  if (
    action.startsWith('grant.') ||
    action.startsWith('assignment.') ||
    action.startsWith('substitution.') ||
    action.startsWith('set_agent')
  ) {
    return 'service';
  }
  return 'human';
}

/**
 * Format an epoch-ms timestamp into a readable ru-RU local label.
 * @param {number} ts epoch ms.
 * @returns {string}
 */
export function fmtTs(ts) {
  if (typeof ts !== 'number' || !isFinite(ts)) return '—';
  try {
    return new Date(ts).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

/**
 * Map an HTTP failure status to a human, honest message (no jargon).
 * @param {number} status
 * @returns {string}
 */
export function humanError(status) {
  if (status === 401) return 'Требуется вход в систему, чтобы смотреть журнал аудита.';
  if (status === 403) return 'Недостаточно прав: журнал аудита контура доступен владельцу или администратору.';
  if (status === 503) return 'Журнал аудита недоступен (база данных не настроена).';
  return `Не удалось загрузить журнал аудита (код ${status}).`;
}

/**
 * Build the GET /api/audit URL with optional actor/action filters + cursor.
 * Filter VALUES are URL-encoded via URLSearchParams (no manual concatenation) —
 * the server binds them as SQL parameters, but encoding here is still correct hygiene.
 * @param {{actor?: string, action?: string}} filters
 * @param {string|null} cursor
 * @returns {string}
 */
export function buildAuditUrl(filters, cursor) {
  const sp = new URLSearchParams();
  if (filters && filters.actor) sp.set('actor', filters.actor);
  if (filters && filters.action) sp.set('action', filters.action);
  if (cursor) sp.set('cursor', cursor);
  const qs = sp.toString();
  return `/api/audit${qs ? `?${qs}` : ''}`;
}
