/**
 * src/core/slugify-process-key.ts
 *
 * T-0377: Auto-key assignment for new process definitions.
 *
 * Exports:
 *   slugifyProcessName(name) → string
 *     Pure: Cyrillic-aware slug from a process name.
 *     "Согласование телефонного запроса" → "soglasovanie-telefonnogo-zaprosa"
 *     Empty / whitespace-only / all-symbol (filters to empty) → "process"
 *
 *   generateUniqueProcessKey(name, existsFn) → Promise<string>
 *     Collision-safe: tries base slug, then slug-2, slug-3 … slug-10,
 *     then slug-<uuid-suffix> as a guaranteed-unique fallback.
 *     existsFn(key) → Promise<boolean> (checks DB for collision)
 *
 * T-0650: this module is now a thin wrapper over the canonical generator
 * src/core/slug-generator.ts (which owns the single Cyrillic map + grammar). Public
 * API/behavior is byte-for-byte UNCHANGED, INCLUDING the "process" fallback word for
 * every name that yields no slug (T-0650 F1 fix coerces the generator's generic
 * "item" back to "process" at this boundary — see slugifyProcessName). Same 60-char
 * cap, same base-2..base-10 then uuid8 suffix shape — no regression for existing
 * callers (process-defs.ts, assistant.ts, process-defs.test.ts).
 *
 * NOTE (F2, doc accuracy): T-0650 unified only the process-key path onto the
 * canonical generator. register.ts::slugifyOrgName and web/src/forms/relation-cascade.js
 * still carry their OWN independent copies of the transliteration map (deliberately
 * NOT migrated, to avoid changing their output) — the ADR reflects this.
 */

import {
  GENERIC_SLUG_FALLBACK,
  generateSlugFromName,
  generateUniqueSlug,
} from "./slug-generator.js";

/**
 * The process-key path's historical fallback word. Preserved verbatim from the
 * pre-T-0650 implementation for EVERY name that yields no slug — not only
 * empty/whitespace, but also a non-empty name that transliterates/filters to
 * nothing ("!!!###", "ъъъ", "---", "№№№", CJK-only). generateSlugFromName returns
 * the GENERIC fallback ("item") in that case; the wrapper coerces it back to
 * "process" so process-key generation is byte-for-byte unchanged (T-0650 F1 fix).
 */
const PROCESS_KEY_FALLBACK = "process";

/**
 * Pure: derive a URL-safe, human-readable slug from a process name.
 * Supports Cyrillic, Latin, digits. All other chars become dashes.
 * Any name that yields no slug (empty, whitespace-only, OR all-symbol/
 * non-transliterable) → "process" — the process-specific fallback word, preserved
 * for backward compat. (The canonical generator's generic fallback is "item";
 * this wrapper maps it back to "process" so the process-key contract is unchanged.)
 */
export function slugifyProcessName(name: string): string {
  const s = generateSlugFromName(name);
  return s === GENERIC_SLUG_FALLBACK ? PROCESS_KEY_FALLBACK : s;
}

/**
 * Collision-safe key generation.
 *
 * Strategy:
 *   1. Try base = slugifyProcessName(name)
 *   2. If taken, try base-2 through base-10
 *   3. If all taken, use base-<first-8-chars-of-uuid> (practically unique)
 *
 * @param name      Human-readable process name (may be Cyrillic).
 * @param existsFn  Returns true if the candidate key is already used in the tenant.
 */
export async function generateUniqueProcessKey(
  name: string,
  existsFn: (key: string) => Promise<boolean>,
): Promise<string> {
  const base = slugifyProcessName(name);
  // Delegate to the canonical generator, seeded with the process-specific base
  // (so the "process" fallback word is preserved) rather than re-deriving from name.
  // maxNumberedAttempts:9 → tries base-2..base-10 (9 numbered attempts), matching the
  // original loop bound exactly.
  return generateUniqueSlug(base, existsFn, { maxNumberedAttempts: 9 });
}
