/**
 * web/src/screens/record-links.js — T-0352 [E16]
 *
 * Pure helpers for cross-app link projections on the record card.
 *
 * §6 card policy: 1-hop live projections resolved by GET /api/records/:id/links.
 * This module handles display logic only (grouping, redaction label, field
 * formatting). No fetch, no side-effects.
 *
 * Exports:
 *   groupLinksByLabel(links)   — group LinkProjection[] by label for section rendering
 *   isHopAllowed(hop)          — type-guard: true if hop has fields
 *   isHopDenied(hop)           — type-guard: true if hop has redactedProjection
 *   getRedactionReason(hop)    — human-readable denial reason (RU)
 *   formatLinkedFields(fields) — format allowed hop fields for display
 *   buildLinkSectionTitle(label) — section header string (e.g. «Из договора»)
 */

/**
 * Group an array of LinkProjection by their `label` field.
 * Each group corresponds to one labeled isolated section on the card.
 *
 * @param {Array<{refId: string, label: string, refField: string, hop: object}>} links
 * @returns {Map<string, Array>} label → LinkProjection[]
 */
export function groupLinksByLabel(links) {
  const groups = new Map();
  for (const link of links) {
    const key = link.label;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(link);
  }
  return groups;
}

/**
 * Type-guard: returns true if the hop was allowed (has `fields`).
 * @param {object} hop
 * @returns {boolean}
 */
export function isHopAllowed(hop) {
  return hop != null && hop.allowed === true;
}

/**
 * Type-guard: returns true if the hop was denied (has `redactedProjection`).
 * @param {object} hop
 * @returns {boolean}
 */
export function isHopDenied(hop) {
  return hop != null && hop.allowed === false;
}

/**
 * Human-readable denial reason in Russian, suitable for displaying in the
 * «label/id only» redacted projection cell.
 *
 * @param {object} hop  A denied hop (allowed === false).
 * @returns {string}
 */
export function getRedactionReason(hop) {
  if (!hop || hop.allowed !== false) return '';
  switch (hop.reason) {
    case 'no_grant':          return 'Нет доступа';
    case 'not_found':         return 'Запись не найдена';
    case 'hop_cap_exceeded':  return 'Превышена глубина ссылок';
    case 'dangling_ref':      return 'Ссылка не установлена';
    case 'cross_tenant':      return 'Доступ запрещён';
    default:                  return 'Нет доступа';
  }
}

/**
 * Format the fields of an allowed hop for display.
 * Returns an ordered array of { key, value } pairs, skipping internal ID fields.
 *
 * Internal fields filtered out: 'id', 'tenant_id', 'registry_id', 'created_at',
 * 'updated_at', 'created_by' — these are schema metadata, not business fields.
 *
 * @param {Record<string, unknown>} fields  Allowed hop fields (already PDP-projected).
 * @param {number} [maxFields=8]            Max fields to show (cognitive budget, §6).
 * @returns {Array<{key: string, displayValue: string}>}
 */
export function formatLinkedFields(fields, maxFields = 8) {
  if (!fields || typeof fields !== 'object') return [];

  const INTERNAL_KEYS = new Set([
    'id', 'tenant_id', 'registry_id', 'created_at', 'updated_at', 'created_by',
  ]);

  return Object.entries(fields)
    .filter(([key]) => !INTERNAL_KEYS.has(key))
    .slice(0, maxFields)
    .map(([key, val]) => ({
      key,
      displayValue: formatFieldValue(val),
    }));
}

/**
 * Build a labeled section title from a ref label.
 * Follows §6 convention: «Из [label]».
 *
 * @param {string} label  The ref def label (e.g. «Договор», «CRM»).
 * @returns {string}
 */
export function buildLinkSectionTitle(label) {
  if (!label || typeof label !== 'string') return 'Связанные данные';
  // If the label already starts with «Из», use as-is; otherwise prefix.
  const trimmed = label.trim();
  if (trimmed.toLowerCase().startsWith('из ')) return trimmed;
  return `Из ${trimmed}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format a single field value to a display string.
 * @param {unknown} val
 * @returns {string}
 */
function formatFieldValue(val) {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'boolean') return val ? 'Да' : 'Нет';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'string') {
    // ISO date string → localized date
    if (/^\d{4}-\d{2}-\d{2}(T.+)?$/.test(val)) {
      try {
        const d = new Date(val);
        if (!isNaN(d.getTime())) {
          return d.toLocaleDateString('ru-RU');
        }
      } catch { /* fall through */ }
    }
    return val;
  }
  if (typeof val === 'object') {
    return JSON.stringify(val);
  }
  return String(val);
}
