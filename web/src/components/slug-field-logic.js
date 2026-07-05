/**
 * web/src/components/slug-field-logic.js — T-0650 [W4-UX §7]
 *
 * Pure, framework-free transliteration preview + SlugField state helpers.
 * JSX-free so it is unit-testable in isolation (mirrors org-crud.js / apps-validate.js).
 *
 * MIRROR NOTICE: the transliteration map + grammar here are an EXACT client-side
 * mirror of the canonical server generator (src/core/slug-generator.ts). This is a
 * live-typing UX preview only ("будет создан как …") — the SERVER is the source of
 * truth for the final slug (it re-derives from display_name and resolves collisions
 * atomically; see ADR-T0650-auto-slugs.md). A client/server mismatch here would only
 * affect the preview text shown before submit, never the persisted slug.
 */

// EXACT mirror of src/core/slug-generator.ts CYRILLIC_MAP.
const CYRILLIC_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd',
  е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

const SLUG_MAX_LEN = 60;

// EXACT mirror of src/core/slug-generator.ts SLUG_GENERATOR_RE.
export const SLUG_FIELD_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Pure: replace each Cyrillic character with its latin equivalent. */
export function transliterate(input) {
  return String(input || '').replace(/[а-яё]/g, (ch) => (ch in CYRILLIC_MAP ? CYRILLIC_MAP[ch] : ch));
}

/**
 * Client-side preview mirror of generateSlugFromName (src/core/slug-generator.ts).
 * Does NOT resolve collisions (that only the server can do atomically) — this is
 * purely the "what will the base slug look like" live preview.
 */
export function previewSlugFromName(name) {
  if (!name || !String(name).trim()) return '';
  const slug = transliterate(String(name).toLowerCase())
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, SLUG_MAX_LEN);
}
