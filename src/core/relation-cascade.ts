/**
 * src/core/relation-cascade.ts — T-0463 [D8-G2]: relation-cascade primitive.
 *
 * Spec: docs/specs/text-first-solution-builder.spec.md §3.2.
 *
 * THE PROBLEM
 *   A relation field references a target application. When the target does NOT
 *   exist yet, naively erroring is wrong: the author (bot OR visual picker)
 *   wants to CREATE the related application in the SAME DRAFT bundle so a single
 *   promote brings both. But blindly creating duplicates an app that already
 *   exists. So the primitive must, given the referenced target and the set of
 *   existing registry_defs, DECIDE:
 *
 *     - LINK     → an existing registry_def matches → link to it (no duplicate).
 *     - CREATE   → nothing matches → cascade-create a related app in the bundle.
 *     - ASK      → multiple plausible matches / ambiguous → return a clarification
 *                  (do NOT guess — PD-5 "validate against existing").
 *     - HOP_CAP  → the cascade chain is deeper than HOP_CAP → stop (no runaway).
 *
 * TWO DRIVERS, ONE CONTRACT (Развилка-5)
 *   - The configurator bot (assistant-configurator.ts) calls this when planning a
 *     relation field whose target is named/sloughed but has no target_registry_id.
 *   - The visual relation-picker (web/src/screens/screen-app-schema.jsx) calls the
 *     SAME logic (mirrored client-side) to offer "create related app" when the
 *     picked target doesn't exist. Both go through resolveRelationTarget so the
 *     dedup + hop-cap rules are identical.
 *
 * PURITY (CI: no-env-in-core, keyed-digest-core-purity discipline)
 *   PURE: no pg, no http, no fetch, no process.env, no child_process. The caller
 *   injects the candidate set (existing registry_defs) and the current depth.
 *   All side effects (the actual create) are expressed as a returned plan, which
 *   the HTTP layer executes via the SAME create_application path as T-0462.
 *
 * HOP-CAP
 *   Reuses HOP_CAP=3 from cross-app-ref.ts (the existing cross-application
 *   reference traversal cap). A cascade chain deeper than HOP_CAP stops. This is
 *   the authoring-time analogue of the read-time hop-cap: it bounds the number of
 *   apps a single relation chain can spawn so a self-referential or pathological
 *   description cannot create an unbounded fan-out of apps.
 */

import { HOP_CAP } from "./cross-app-ref.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * A reference to a relation target as expressed at authoring time, BEFORE it is
 * resolved to a concrete target_registry_id. The author names the thing they
 * want to relate to — by slug, by display name, or both.
 */
export interface RelationTargetRef {
  /** Slug the author wants (URL-shaped). Optional — may only have a name. */
  readonly targetSlug?: string;
  /** Human display name the author wants (e.g. «Контрагенты»). */
  readonly targetDisplayName?: string;
  /**
   * If the author already pinned an EXISTING registry_def UUID, the cascade is a
   * no-op LINK to that id (the visual picker's existing-selection path). Present
   * only when the author explicitly chose an existing target.
   */
  readonly explicitTargetRegistryId?: string;
}

/**
 * A candidate existing registry_def to dedup against. The caller supplies the
 * tenant's registry_defs (the SAME list the visual picker fetches from
 * GET /api/registry-defs). Only the matchable fields are needed here.
 */
export interface RegistryDefCandidate {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type RelationCascadeDecision =
  | RelationCascadeLink
  | RelationCascadeCreate
  | RelationCascadeAsk
  | RelationCascadeHopCapped;

/** An existing app matched unambiguously → link to it, create nothing. */
export interface RelationCascadeLink {
  readonly decision: "link";
  /** The registry_def UUID to write into the relation field's x-relation. */
  readonly targetRegistryId: string;
  /** Why we matched (for the changelog / picker UI). */
  readonly matchReason: "explicit_id" | "exact_slug" | "exact_name";
}

/**
 * Nothing matched → CREATE a related app in the SAME draft bundle.
 * This is a PLAN, not a side effect: the caller executes it via the T-0462
 * create_application path (same DRAFT bundle as the parent).
 */
export interface RelationCascadeCreate {
  readonly decision: "create";
  /** The slug to create the new application with. */
  readonly appSlug: string;
  /** The display name to create the new application with. */
  readonly appDisplayName: string;
  /**
   * The depth this cascaded app sits at (parent depth + 1). Carried so a chained
   * cascade (the created app's own relation fields) can keep counting toward the cap.
   */
  readonly depth: number;
}

/**
 * Ambiguous — multiple plausible existing matches. Do NOT guess; ask the human
 * (bot) or surface a disambiguation (picker). PD-5 "validate against existing".
 */
export interface RelationCascadeAsk {
  readonly decision: "ask";
  /** The candidate apps that plausibly match — the human picks one (or "create new"). */
  readonly candidates: readonly RegistryDefCandidate[];
  /** Human-readable clarification question. */
  readonly question: string;
}

/** The cascade chain is deeper than HOP_CAP → stop (no runaway fan-out). */
export interface RelationCascadeHopCapped {
  readonly decision: "hop_cap_exceeded";
  /** The depth that would have been created (always > HOP_CAP). */
  readonly attemptedDepth: number;
  /** The cap that was hit. */
  readonly cap: number;
}

// ---------------------------------------------------------------------------
// Normalization (dedup matching)
// ---------------------------------------------------------------------------

/**
 * Normalize a string for case/space-insensitive NAME comparison. Mirrors the
 * lenient matching a human expects ("Контрагенты" == " контрагенты ").
 * Slugs are compared raw (already URL-shaped, lowercase by construction).
 */
function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// The primitive
// ---------------------------------------------------------------------------

/**
 * Resolve a relation target against the existing registry_defs, deciding whether
 * to LINK (dedup hit), CREATE (cascade a new app in the same bundle), ASK
 * (ambiguous), or STOP (hop-cap exceeded).
 *
 * DEDUP RULES (PD-5):
 *   1. explicitTargetRegistryId present → LINK to it (the picker's
 *      existing-selection path). No matching needed.
 *   2. Exact slug match → LINK (slugs are unique per tenant; a slug hit is
 *      unambiguous by construction).
 *   3. Exact (normalized) name match:
 *        - exactly one candidate → LINK.
 *        - multiple candidates with the same normalized name → ASK (ambiguous).
 *   4. No match → CREATE (cascade), unless hop-cap exceeded → HOP_CAP.
 *
 * HOP-CAP:
 *   The new app would sit at `depth` (= parent depth + 1). If `depth > HOP_CAP`,
 *   the cascade is refused: decision = hop_cap_exceeded. depth is 1-based for the
 *   FIRST cascaded app (a top-level author is at depth 0; its relation creates an
 *   app at depth 1). HOP_CAP=3 → at most 3 cascaded apps deep in a single chain.
 *
 * @param ref         What the author referenced (slug / name / explicit id).
 * @param candidates  The tenant's existing registry_defs to dedup against.
 * @param depth       The depth the cascaded app WOULD be created at (parent + 1).
 *                    The first cascade off a top-level field passes depth=1.
 */
export function resolveRelationTarget(
  ref: RelationTargetRef,
  candidates: readonly RegistryDefCandidate[],
  depth: number,
): RelationCascadeDecision {
  // Rule 1: the author explicitly pinned an existing id → link, no dedup needed.
  if (ref.explicitTargetRegistryId && ref.explicitTargetRegistryId.trim()) {
    return {
      decision: "link",
      targetRegistryId: ref.explicitTargetRegistryId,
      matchReason: "explicit_id",
    };
  }

  const wantSlug = (ref.targetSlug ?? "").trim();
  const wantName = normalizeName(ref.targetDisplayName ?? "");

  // Rule 2: exact slug match → unambiguous LINK (slug unique per tenant).
  if (wantSlug) {
    const slugHit = candidates.find((c) => c.slug === wantSlug);
    if (slugHit) {
      return { decision: "link", targetRegistryId: slugHit.id, matchReason: "exact_slug" };
    }
  }

  // Rule 3: exact normalized-name match.
  if (wantName) {
    const nameHits = candidates.filter((c) => normalizeName(c.displayName) === wantName);
    if (nameHits.length === 1) {
      return { decision: "link", targetRegistryId: nameHits[0].id, matchReason: "exact_name" };
    }
    if (nameHits.length > 1) {
      // Ambiguous: several apps share this name. Don't guess — ASK.
      return {
        decision: "ask",
        candidates: nameHits,
        question:
          `Несколько приложений с названием «${ref.targetDisplayName}» — ` +
          `уточните, на какое ссылаться, или создайте новое.`,
      };
    }
  }

  // Rule 4: nothing matched → CREATE, unless the cascade is too deep.
  if (depth > HOP_CAP) {
    return { decision: "hop_cap_exceeded", attemptedDepth: depth, cap: HOP_CAP };
  }

  // Derive create slug/name. Prefer the explicit slug; else slugify the name.
  // The actual slug-collision-safe generation happens at the create_application
  // path (it already handles 23505); here we just propose the intended slug/name.
  const appDisplayName = (ref.targetDisplayName ?? wantSlug).trim() || wantSlug;
  const appSlug = wantSlug || slugFromName(appDisplayName);

  return { decision: "create", appSlug, appDisplayName, depth };
}

/**
 * Minimal slug derivation for a proposed cascade-create when the author gave only
 * a name. Cyrillic-aware, mirrors slugify-process-key.ts's shape (duplicated to
 * keep this module zero-import beyond HOP_CAP). The create_application path does
 * the authoritative slug validation + collision handling.
 */
const CYRILLIC_SLUG_MAP: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

function slugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[а-яё]/g, (ch) => CYRILLIC_SLUG_MAP[ch] ?? ch)
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return slug || "app";
}

// Re-export HOP_CAP so callers (and the picker mirror) reference one cap.
export { HOP_CAP };
