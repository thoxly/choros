/**
 * src/core/slugify-process-key.ts
 *
 * T-0377: Auto-key assignment for new process definitions.
 *
 * Exports:
 *   slugifyProcessName(name) → string
 *     Pure: Cyrillic-aware slug from a process name.
 *     "Согласование телефонного запроса" → "soglasovanie-telefonnogo-zaprosa"
 *     Empty/whitespace → "process"
 *
 *   generateUniqueProcessKey(name, existsFn) → Promise<string>
 *     Collision-safe: tries base slug, then slug-2, slug-3 … slug-10,
 *     then slug-<uuid-suffix> as a guaranteed-unique fallback.
 *     existsFn(key) → Promise<boolean> (checks DB for collision)
 *
 * T-0650: this module is now a thin wrapper over the canonical generator
 * src/core/slug-generator.ts (unifies the Cyrillic map + grammar that used to be
 * duplicated across slugify-process-key.ts / register.ts / relation-cascade.js —
 * see ADR-T0650-auto-slugs.md §2.1). Public API/behavior is UNCHANGED (same
 * fallback word "process", same 60-char cap, same base-2..base-10 then uuid8
 * suffix shape) — no breaking change for existing callers (process-defs.ts,
 * assistant.ts, process-defs.test.ts).
 */

import { generateSlugFromName, generateUniqueSlug } from "./slug-generator.js";

/**
 * Pure: derive a URL-safe, human-readable slug from a process name.
 * Supports Cyrillic, Latin, digits. All other chars become dashes.
 * Empty/whitespace-only name → "process" (process-specific fallback word, preserved
 * for backward compat; generateSlugFromName's generic fallback is "item").
 */
export function slugifyProcessName(name: string): string {
  if (!name || !name.trim()) return "process";
  return generateSlugFromName(name);
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
