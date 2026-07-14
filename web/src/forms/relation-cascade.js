/* ============================================================================
   web/src/forms/relation-cascade.js — T-0463 [D8-G2]

   Client-side MIRROR of src/core/relation-cascade.ts. The visual relation-picker
   is the SECOND driver of the cascade primitive (Развилка-5: one primitive, two
   drivers). The picker uses these helpers to decide, when the user types a NEW
   relation target that isn't in the existing list, whether to LINK to an existing
   app, CREATE a related one, or ASK (ambiguous). Same dedup + hop-cap rules as the
   core so bot and picker behave identically.

   Pure: no fetch, no React. The picker calls resolveRelationTarget then performs
   the create/link via the existing /api/registry-defs path.
   ============================================================================ */

// Mirror of HOP_CAP from src/core/cross-app-ref.ts (= 3). A cascade chain deeper
// than this stops (no runaway fan-out of related apps).
export const HOP_CAP = 3;

/** Normalize a display name for lenient (case/space-insensitive) comparison. */
function normalizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Cyrillic-aware slug derivation (mirrors core slugFromName).
const CYRILLIC_SLUG_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function slugFromName(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[а-яё]/g, (ch) => (ch in CYRILLIC_SLUG_MAP ? CYRILLIC_SLUG_MAP[ch] : ch))
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return slug || 'app';
}

/**
 * Resolve a relation target against existing registry_defs.
 *
 * @param {{targetSlug?:string, targetDisplayName?:string, explicitTargetRegistryId?:string}} ref
 * @param {Array<{id:string, slug:string, displayName:string}>} candidates  existing registry_defs
 * @param {number} depth  the depth the cascaded app WOULD be created at (parent + 1; first cascade = 1)
 * @returns {{decision:'link'|'create'|'ask'|'hop_cap_exceeded', ...}}
 *
 * Mirrors src/core/relation-cascade.ts resolveRelationTarget exactly:
 *   1. explicit id → link
 *   2. exact slug → link
 *   3. exact (normalized) name: 1 hit → link, >1 → ask
 *   4. no match → create (unless depth > HOP_CAP → hop_cap_exceeded)
 */
export function resolveRelationTarget(ref, candidates, depth) {
  const cands = Array.isArray(candidates) ? candidates : [];

  if (ref && ref.explicitTargetRegistryId && String(ref.explicitTargetRegistryId).trim()) {
    return { decision: 'link', targetRegistryId: ref.explicitTargetRegistryId, matchReason: 'explicit_id' };
  }

  const wantSlug = String((ref && ref.targetSlug) || '').trim();
  const wantName = normalizeName(ref && ref.targetDisplayName);

  if (wantSlug) {
    const slugHit = cands.find((c) => c.slug === wantSlug);
    if (slugHit) return { decision: 'link', targetRegistryId: slugHit.id, matchReason: 'exact_slug' };
  }

  if (wantName) {
    const nameHits = cands.filter((c) => normalizeName(c.displayName) === wantName);
    if (nameHits.length === 1) {
      return { decision: 'link', targetRegistryId: nameHits[0].id, matchReason: 'exact_name' };
    }
    if (nameHits.length > 1) {
      return {
        decision: 'ask',
        candidates: nameHits,
        question:
          `Несколько приложений с названием «${(ref && ref.targetDisplayName) || ''}» — ` +
          'уточните, на какое ссылаться, или создайте новое.',
      };
    }
  }

  if (depth > HOP_CAP) {
    return { decision: 'hop_cap_exceeded', attemptedDepth: depth, cap: HOP_CAP };
  }

  const appDisplayName = String((ref && ref.targetDisplayName) || wantSlug).trim() || wantSlug;
  const appSlug = wantSlug || slugFromName(appDisplayName);
  return { decision: 'create', appSlug, appDisplayName, depth };
}
