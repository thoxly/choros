/**
 * web/src/screens/process-branch-rules.js — T-0437
 *
 * Pure helpers for the «Правила ветвления» navigation affordance.
 *
 * These are extracted from screen-processes.jsx and screen-process-editor.jsx
 * so they can be unit-tested in isolation (no DOM / no React render needed).
 */

/**
 * Returns the browser-path for the branch-rules editor for a given processKey,
 * or null when the processKey is absent/empty (UX G3: no dead affordance).
 *
 * @param {string|null|undefined} processKey
 * @returns {string|null}
 */
export function branchRulesPath(processKey) {
  if (!processKey || typeof processKey !== 'string' || processKey.trim() === '') {
    return null;
  }
  return `/processes/${encodeURIComponent(processKey)}/branch-rules`;
}

/**
 * Returns true when a «Правила ветвления» affordance should be rendered for a
 * process-definition row. A row is eligible when it has a non-empty process_key
 * (the identifier that will be used as the :processKey route param).
 *
 * @param {{ process_key?: string|null }} definition
 * @returns {boolean}
 */
export function hasBranchRulesAffordance(definition) {
  if (!definition || typeof definition !== 'object') return false;
  return Boolean(definition.process_key && String(definition.process_key).trim() !== '');
}
