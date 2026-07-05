/**
 * src/core/process-name-policy.ts — T-0684 (D-064 wave-5 human-layer, capstone T-0647 P1).
 *
 * The SINGLE source of truth for "is this a real, human-meaningful process name?".
 *
 * Live capstone finding (T-0647): the process modeler never required the author to
 * type a name, so a save/publish went through with the editor's derived PLACEHOLDER
 * default. The result on the operator's real screens was a swamp of definitions all
 * literally named the placeholder text, plus binding rows / instance titles that fell
 * back to the raw machine key. This module gates that at the source: the create AND
 * publish server paths reject a name that is empty OR equal to the known placeholder
 * default (case/space-insensitive), so a NEW definition can never be born nameless.
 *
 * Pure, framework-free, pg-free (mirrors slugify-process-key.ts / process-catalog-view.ts)
 * so both the create route and the publish path import ONE predicate — the two gates
 * can never drift apart, and it unit-tests in isolation.
 *
 * SCOPE (enforcement vs data): this stops NEW nameless definitions. The 11 pre-existing
 * placeholder-named rows found live are DATA, not something enforcement rewrites — a
 * data backfill/rename is a separate, owner-visible concern (an author re-opens each in
 * the modeler and gives it a real name). Enforcement here guarantees the swamp does not
 * grow.
 */

/**
 * The modeler's derived placeholder for a brand-new, not-yet-named process. This is a
 * UI PLACEHOLDER string (the "you haven't named it yet" default), NOT a business case
 * name — it lives here as the ONE canonical constant so the client editor
 * (screen-process-editor.jsx) and the server gate test the identical value. A saved
 * definition whose name still equals this placeholder means the author never named it.
 */
export const UNNAMED_PROCESS_PLACEHOLDER = "Новый процесс";

/**
 * Normalize a candidate name for the placeholder/empty comparison: trim, collapse
 * internal whitespace runs to a single space, and lower-case. So "  новый   Процесс "
 * is recognized as the placeholder just as "Новый процесс" is — a user cannot smuggle
 * the placeholder past the gate with extra spaces or a different case.
 */
function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * True when `name` is NOT an acceptable human process name — either empty/whitespace,
 * not a string, or (normalized) equal to the placeholder default. The create/publish
 * routes reject with a 400 «Укажите название процесса» when this is true.
 */
export function isRejectedProcessName(name: unknown): boolean {
  if (typeof name !== "string") return true;
  const normalized = normalizeName(name);
  if (normalized === "") return true;
  if (normalized === normalizeName(UNNAMED_PROCESS_PLACEHOLDER)) return true;
  return false;
}

/**
 * Type-guard complement of {@link isRejectedProcessName}: true (and narrows to
 * `string`) when `name` IS an acceptable human process name. Lets a caller narrow the
 * `unknown` request field to `string` on the accepted branch without a second cast.
 */
export function isAcceptedProcessName(name: unknown): name is string {
  return !isRejectedProcessName(name);
}

/**
 * The user-facing validation message surfaced (400 VALIDATION) when a create/publish
 * is rejected for a missing/placeholder name — one string, so the two server gates and
 * the client editor's pre-flight guard show identical wording.
 */
export const PROCESS_NAME_REQUIRED_MESSAGE = "Укажите название процесса";
