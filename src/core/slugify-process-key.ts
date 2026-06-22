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
 * Design:
 *   - Reuses the same Cyrillic→latin transliteration map as slugifyOrgName
 *     (src/core/register.ts) — NOT re-imported (to avoid circular deps and
 *     keep this util zero-dep stdlib-only). The map is duplicated intentionally.
 *   - Max slug length: 60 chars (leaves room for numeric/uuid suffix within 80).
 *   - No IO — all IO is behind the injected existsFn.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Cyrillic transliteration (mirrors register.ts — no import to avoid cycles)
// ---------------------------------------------------------------------------

const CYRILLIC_MAP: Record<string, string> = {
  а: "a",  б: "b",  в: "v",  г: "g",  д: "d",
  е: "e",  ё: "e",  ж: "zh", з: "z",  и: "i",
  й: "y",  к: "k",  л: "l",  м: "m",  н: "n",
  о: "o",  п: "p",  р: "r",  с: "s",  т: "t",
  у: "u",  ф: "f",  х: "h",  ц: "ts", ч: "ch",
  ш: "sh", щ: "sch", ъ: "",  ы: "y",  ь: "",
  э: "e",  ю: "yu", я: "ya",
};

const SLUG_BASE_MAX = 60;

/**
 * Pure: derive a URL-safe, human-readable slug from a process name.
 * Supports Cyrillic, Latin, digits. All other chars become dashes.
 */
export function slugifyProcessName(name: string): string {
  if (!name || !name.trim()) return "process";
  const slug = name
    .toLowerCase()
    .replace(/[а-яё]/g, (ch) => CYRILLIC_MAP[ch] ?? ch)
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "process").slice(0, SLUG_BASE_MAX);
}

/**
 * Collision-safe key generation.
 *
 * Strategy:
 *   1. Try base = slugifyProcessName(name)
 *   2. If taken, try base-2, base-3 … base-10
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

  // Try base first
  if (!(await existsFn(base))) return base;

  // Try base-2 through base-10
  for (let n = 2; n <= 10; n++) {
    const candidate = `${base}-${n}`;
    if (!(await existsFn(candidate))) return candidate;
  }

  // Guaranteed-unique fallback: base + uuid short suffix
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${base.slice(0, 48)}-${suffix}`;
}
