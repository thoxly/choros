/**
 * src/core/slug-generator.ts — T-0650: canonical slug generator (auto-slugs, §7).
 *
 * PURE (no pg/fs/net/http import except node:crypto for the fallback suffix). This is
 * the canonical source of the Cyrillic→latin transliteration map + slug grammar for the
 * NEW auto-slug path (all six T-0650 create-endpoints) and the process-key path.
 *
 * SCOPE NOTE (F2, accuracy): before this module the same map existed in three places —
 * slugify-process-key.ts, register.ts::slugifyOrgName, web/src/forms/relation-cascade.js.
 * T-0650 migrated ONLY slugify-process-key.ts onto this module (it is now a thin
 * wrapper). register.ts and relation-cascade.js were deliberately NOT migrated — their
 * outputs must not change under this task (register.ts falls back to "org" with
 * SLUG_MAX=80; the client cascade falls back to "app") — so their duplicate copies of
 * the map remain. This module is therefore the SINGLE source for the auto-slug/
 * process-key paths, not (yet) for those two independent mirrors.
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
 * Generic fallback slug word for a name that is empty/whitespace-only OR filters to
 * nothing (all-symbol/non-transliterable input). Deliberately generic (anti-case,
 * D-064) — callers that need an entity-specific fallback word (e.g. process-key's
 * historical "process") coerce this value at their boundary (see
 * slugify-process-key.ts), rather than the generator hard-coding an entity name.
 */
export const GENERIC_SLUG_FALLBACK = "item";

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
  if (!name || !name.trim()) return GENERIC_SLUG_FALLBACK;
  const slug = transliterate(name.toLowerCase())
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || GENERIC_SLUG_FALLBACK).slice(0, SLUG_MAX_LEN);
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
  // 10 concurrent/pre-existing identically-named entities). Fall back to a
  // uuid8-suffixed candidate. F3 (T-0650 review): the final attempt is guarded and
  // re-rolled a few times — a fresh random suffix each time — so even the ~1-in-4e9
  // collision on a single uuid8 does not propagate a raw 23505 (which would surface as
  // a 500 on the auto path). Bounded (UUID_FALLBACK_ATTEMPTS) so it can never loop
  // unboundedly; the last re-roll re-throws so a genuine non-conflict error is honest.
  const baseTrimmed = base.slice(0, SLUG_MAX_LEN - 9);
  const UUID_FALLBACK_ATTEMPTS = 3;
  for (let i = 0; i < UUID_FALLBACK_ATTEMPTS; i++) {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
    const fallback = `${baseTrimmed}-${suffix}`;
    try {
      return await insertFn(fallback);
    } catch (err) {
      // Re-roll on the last attempt too? No — re-throw once we've exhausted the budget
      // (or immediately on any non-conflict error). A second uuid8 collision is already
      // astronomically unlikely; a third is effectively impossible.
      if (!isConflict(err) || i === UUID_FALLBACK_ATTEMPTS - 1) throw err;
    }
  }
  // Unreachable — the loop either returns or throws — but satisfies the type checker.
  throw new Error("insertWithUniqueSlugRetry: exhausted uuid fallback attempts");
}
