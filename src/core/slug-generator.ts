/**
 * src/core/slug-generator.ts — T-0650: canonical slug generator (auto-slugs, §7).
 *
 * PURE (no pg/fs/net/http import except node:crypto for the fallback suffix). This is
 * the SINGLE source of the Cyrillic→latin transliteration map and the slug grammar for
 * the whole product. Before this module the map was duplicated three times
 * (slugify-process-key.ts, register.ts::slugifyOrgName, web/src/forms/relation-cascade.js)
 * and the grammar (`^[a-z0-9][a-z0-9-]{0,63}$`) six+ times — always identical, never
 * unified. T-0650 unifies the BACKEND side here; slugify-process-key.ts becomes a thin
 * wrapper (kept for backward compat — no signature change for its existing callers).
 *
 * Exports:
 *   SLUG_GENERATOR_RE       — canonical grammar (same value as every SLUG_RE mirror).
 *   transliterate(input)    — Cyrillic → latin, no grammar filtering (building block).
 *   generateSlugFromName(name) → full slug: translit → lower → [a-z0-9-] → collapse
 *                                 dashes → trim → cap at 60 chars. "" → "item".
 *   generateUniqueSlug(name, existsFn, opts?) → numbered-suffix collision resolution
 *                                 (base, base-2 … base-10, then base-<uuid8>).
 *
 * ATOMICITY (see ADR-T0650-auto-slugs.md §2.2): generateUniqueSlug's existsFn callback
 * is a convenience for callers that want a pre-check (e.g. dry-run preview), but it does
 * NOT by itself guarantee atomicity under concurrent writers — there is a check-then-act
 * window between "candidate is free" and "candidate is inserted". The callers in this
 * task (src/http/applications.ts, registry-defs.ts, seed-write.ts) do NOT use the
 * existsFn form for the write path; they use the retry-on-INSERT-conflict pattern
 * (attempt candidate → INSERT → on 23505 unique_violation → try next candidate → …),
 * which is race-free because the arbiter is the real UNIQUE constraint at the exact
 * moment of the write, not a prior read. generateUniqueSlug (existsFn form) remains
 * useful for callers that only need a same-transaction pre-check under a single
 * connection (see process-defs.ts, which reads inside the same withTenantTx boundary as
 * the eventual insert and is therefore still authoritative for that call's tenant/key
 * scope), and is preserved for slugify-process-key.ts backward compatibility.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Canonical grammar — mirrors src/http/applications.ts SLUG_RE (the original
// canonical definition per the UX study §7: "грамматика слага уже едина").
// ---------------------------------------------------------------------------
export const SLUG_GENERATOR_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ---------------------------------------------------------------------------
// Cyrillic transliteration — canonical map (was duplicated in slugify-process-key.ts,
// register.ts, web/src/forms/relation-cascade.js). Kept identical to all three so no
// existing generated slug changes shape.
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

const SLUG_MAX_LEN = 60; // leaves room for a "-<suffix>" within the 64-char column limit.

/**
 * Pure: replace each lowercase Cyrillic character with its latin equivalent.
 * Expects lowercase input (callers lowercase before calling, same as the prior art).
 */
export function transliterate(input: string): string {
  return input.replace(/[а-яё]/g, (ch) => CYRILLIC_MAP[ch] ?? ch);
}

/**
 * Derive a URL-safe, human-readable, grammar-compliant slug from a free-text name.
 * "Закупки оборудования" → "zakupki-oborudovaniya"
 * "" / whitespace-only / all-symbols → "item" (generic fallback — never a case-specific
 * default; anti-case discipline, D-064).
 */
export function generateSlugFromName(name: string): string {
  if (!name || !name.trim()) return "item";
  const slug = transliterate(name.toLowerCase())
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "item").slice(0, SLUG_MAX_LEN);
}

export interface GenerateUniqueSlugOptions {
  /** Max numbered-suffix attempts (base-2 .. base-<N+1>) before the uuid fallback. Default 9. */
  maxNumberedAttempts?: number;
}

/**
 * Collision-safe slug generation via an injected existence check.
 *
 * NOTE on atomicity: see the module header. This form is appropriate when existsFn's
 * read happens INSIDE the same transaction/connection that will perform the eventual
 * write (no cross-connection race window) — e.g. slugify-process-key.ts's use inside
 * process-defs.ts's withTenantTx. For the T-0650 create-endpoints (applications,
 * registry-defs, departments, positions, employees, roles) the retry-on-INSERT-conflict
 * pattern is used instead (see each route's resolveSlugForCreate helper) — the
 * authoritative arbiter there is the real UNIQUE constraint at INSERT time.
 *
 * Strategy:
 *   1. Try base = generateSlugFromName(name)
 *   2. If taken, try base-2 through base-<1+maxNumberedAttempts>
 *   3. If all taken, use base-<8-hex-chars-of-uuid> (practically unique, no further retry)
 */
export async function generateUniqueSlug(
  name: string,
  existsFn: (candidate: string) => Promise<boolean>,
  opts?: GenerateUniqueSlugOptions,
): Promise<string> {
  const base = generateSlugFromName(name);
  const maxAttempts = opts?.maxNumberedAttempts ?? 9;

  if (!(await existsFn(base))) return base;

  for (let n = 2; n <= maxAttempts + 1; n++) {
    const candidate = `${base}-${n}`;
    if (!(await existsFn(candidate))) return candidate;
  }

  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${base.slice(0, SLUG_MAX_LEN - 9)}-${suffix}`;
}

/** Thrown by insertWithUniqueSlugRetry's injected insertFn to signal a unique-constraint
 *  collision (pg error code 23505) — the caller's insertFn should throw this (or the
 *  helper's isUniqueViolation default checks err.code==="23505" on ANY thrown error). */
export function isUniqueViolationError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export interface InsertWithUniqueSlugRetryOptions {
  /** Max numbered-suffix attempts (base-2 .. base-<N+1>) before the uuid fallback. Default 9. */
  maxNumberedAttempts?: number;
}

/**
 * Atomic collision-safe CREATE: attempts an INSERT with successive slug candidates,
 * relying on the database's real UNIQUE constraint as the single arbiter (no
 * check-then-act race — see ADR-T0650-auto-slugs.md §2.2).
 *
 * Only used when the caller did NOT supply an explicit slug (auto-generation path).
 * If insertFn's candidate collides (throws a unique_violation, detected via
 * isUniqueViolationError by default, or a custom `isConflict` predicate), the next
 * candidate (base-2, base-3, … then a uuid-suffixed candidate) is tried. Any
 * non-conflict error propagates immediately (not swallowed/retried).
 *
 * @param name       Human-readable name to derive the base slug from.
 * @param insertFn   Performs the actual INSERT with the given candidate slug and
 *                   returns the created row (or throws on conflict / other DB error).
 * @param opts       isConflict — custom conflict predicate (default: 23505 pg code).
 */
export async function insertWithUniqueSlugRetry<T>(
  name: string,
  insertFn: (candidateSlug: string) => Promise<T>,
  opts?: InsertWithUniqueSlugRetryOptions & { isConflict?: (err: unknown) => boolean },
): Promise<T> {
  const base = generateSlugFromName(name);
  const maxAttempts = opts?.maxNumberedAttempts ?? 9;
  const isConflict = opts?.isConflict ?? isUniqueViolationError;

  const candidates: string[] = [base];
  for (let n = 2; n <= maxAttempts + 1; n++) candidates.push(`${base}-${n}`);

  for (const candidate of candidates) {
    try {
      return await insertFn(candidate);
    } catch (err) {
      if (!isConflict(err)) throw err;
      // else: try the next numbered candidate.
    }
  }

  // All numbered candidates collided (practically never in real usage — would require
  // 10 concurrent/pre-existing identically-named entities). Guaranteed-unique fallback.
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  const fallback = `${base.slice(0, SLUG_MAX_LEN - 9)}-${suffix}`;
  return insertFn(fallback);
}
