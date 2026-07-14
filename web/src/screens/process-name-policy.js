/**
 * web/src/screens/process-name-policy.js — T-0684 (D-064 wave-5 human-layer, capstone T-0647 P1).
 *
 * Client mirror of src/core/process-name-policy.ts. The process editor uses this for a
 * PRE-FLIGHT guard: save/publish is blocked BEFORE the network call when the author
 * never named the process (empty or still the modeler's placeholder default), showing
 * the same «Укажите название процесса» wording the server 400 carries. Keeping the
 * predicate + placeholder + message in one tiny module (not inline in the .jsx) means
 * they unit-test in the node tier and stay identical to the server contract's intent.
 *
 * Pure — no DOM, no React (matches process-catalog.js / process-instance.logic.js).
 */

/**
 * The modeler's derived placeholder for a brand-new, not-yet-named process — a UI
 * "you haven't named it yet" default, NOT a business name. Single source of truth so
 * the editor's default value and the reject-check compare the identical string.
 */
export const UNNAMED_PROCESS_PLACEHOLDER = 'Новый процесс';

/** Normalize a candidate name for the placeholder/empty comparison (trim, collapse
 *  internal whitespace, lower-case) — a user can't smuggle the placeholder past the
 *  guard with extra spaces or a different case. */
function normalizeName(name) {
  return String(name == null ? '' : name).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * True when `name` is NOT an acceptable human process name — empty/whitespace or
 * (normalized) equal to the placeholder default. Blocks save/publish client-side.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isRejectedProcessName(name) {
  const normalized = normalizeName(name);
  if (normalized === '') return true;
  if (normalized === normalizeName(UNNAMED_PROCESS_PLACEHOLDER)) return true;
  return false;
}

/** The user-facing message shown when a save/publish is blocked for a missing name —
 *  identical wording to the server's PROCESS_NAME_REQUIRED_MESSAGE. */
export const PROCESS_NAME_REQUIRED_MESSAGE = 'Укажите название процесса';
