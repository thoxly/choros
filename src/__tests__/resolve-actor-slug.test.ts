/**
 * src/__tests__/resolve-actor-slug.test.ts — T-0371/T-0372 unit tests for
 * resolveActorSlugFromAuth in src/db/org.ts.
 *
 * Pure unit — no live Postgres. Mocks pool.connect() → a fake client whose
 * query() returns { rows: [{ exists: true|false }] } based on slug argument.
 *
 * NOTE (T-0372): the DB lookup is now restricted to kind='human'. The fake
 * pool simulates this by only returning exists=true for slugs that are in the
 * existsSlugs set (representing rows where kind='human'). Agent slugs are absent
 * from the set, so they return exists=false, matching the production SQL guard.
 *
 * Covers:
 *   (a) sub matches an employee → returns sub (short-circuit; preferred_username NOT consulted)
 *   (b) sub misses, preferredUsername has an employee → returns preferredUsername (seeded persona)
 *   (c) neither sub nor preferredUsername matches → returns null (fail-closed)
 *   (d) preferredUsername === sub → only one lookup, returns null when it misses (no redundant query)
 *   (e) empty/undefined preferredUsername with missing sub → null
 *   (f) agent slug is not in kind='human' set → returns null even if slug matches an employee name
 */

import { describe, it, expect } from "vitest";
import type { Pool, PoolClient } from "pg";
import { resolveActorSlugFromAuth } from "../db/org.js";

// ---------------------------------------------------------------------------
// Fake pool builder
//
// existsSlugs: the set of slugs that "exist" in the DB.
// queryCalls: collects every slug argument passed to EXISTS check queries.
// ---------------------------------------------------------------------------

function makeFakePool(existsSlugs: Set<string>): {
  pool: Pool;
  queryCalls: string[];
} {
  const queryCalls: string[] = [];

  // Fake PoolClient: responds to the EXISTS query used by employeeSlugExists.
  const fakeClient = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (_sql: string, params?: unknown[]): Promise<any> => {
      // The resolver only issues one query shape:
      //   SELECT EXISTS (SELECT 1 FROM choros.employee WHERE slug = $1) AS exists
      // The slug is always params[0].
      const slug = (params ?? [])[0] as string | undefined;
      if (slug !== undefined) {
        queryCalls.push(slug);
      }
      const exists = slug !== undefined && existsSlugs.has(slug);
      return { rows: [{ exists }] };
    },
    release: () => { /* no-op */ },
  } as unknown as PoolClient;

  const pool = {
    connect: async () => fakeClient,
  } as unknown as Pool;

  return { pool, queryCalls };
}

// ---------------------------------------------------------------------------
// (a) sub matches → returns sub; preferred_username NOT consulted
// ---------------------------------------------------------------------------

describe("T-0371 resolveActorSlugFromAuth — (a) sub matches employee", () => {
  it("returns sub when employee.slug == sub; does NOT issue a preferredUsername lookup", async () => {
    const sub = "uuid-of-registered-user";
    const preferredUsername = "e-orlov";

    const { pool, queryCalls } = makeFakePool(new Set([sub, preferredUsername]));

    const result = await resolveActorSlugFromAuth(pool, sub, preferredUsername);

    expect(result).toBe(sub);
    // Short-circuit: only ONE query should have been issued (the sub check).
    // The preferred_username lookup must NOT occur because sub-first succeeded.
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]).toBe(sub);
  });
});

// ---------------------------------------------------------------------------
// (b) sub misses, preferredUsername has an employee → returns preferredUsername
// ---------------------------------------------------------------------------

describe("T-0371 resolveActorSlugFromAuth — (b) sub misses, preferredUsername matches", () => {
  it("returns preferredUsername when sub misses but preferredUsername has an employee", async () => {
    const sub = "kc-random-uuid-for-e-larina";
    const preferredUsername = "e-larina";

    // Only preferredUsername exists in the DB (seeded persona whose KC sub ≠ slug).
    const { pool, queryCalls } = makeFakePool(new Set([preferredUsername]));

    const result = await resolveActorSlugFromAuth(pool, sub, preferredUsername);

    expect(result).toBe(preferredUsername);
    // Two queries: sub (miss) then preferredUsername (hit).
    expect(queryCalls).toEqual([sub, preferredUsername]);
  });
});

// ---------------------------------------------------------------------------
// (c) neither sub nor preferredUsername matches → null (fail-closed)
// ---------------------------------------------------------------------------

describe("T-0371 resolveActorSlugFromAuth — (c) neither matches → null", () => {
  it("returns null when neither sub nor preferredUsername maps to an employee", async () => {
    const sub = "unknown-uuid";
    const preferredUsername = "unknown-username";

    const { pool } = makeFakePool(new Set()); // empty — nothing exists

    const result = await resolveActorSlugFromAuth(pool, sub, preferredUsername);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (d) preferredUsername === sub → only one lookup, null when it misses
// ---------------------------------------------------------------------------

describe("T-0371 resolveActorSlugFromAuth — (d) preferredUsername === sub → single lookup", () => {
  it("does NOT issue a second query when preferredUsername === sub (no redundant / spurious match)", async () => {
    const sub = "same-value-for-both";
    const preferredUsername = "same-value-for-both"; // same as sub

    const { pool, queryCalls } = makeFakePool(new Set()); // nothing exists

    const result = await resolveActorSlugFromAuth(pool, sub, preferredUsername);

    // Must return null (fail-closed) — the fallback is skipped when === sub.
    expect(result).toBeNull();
    // Only one query issued — the sub check. The preferredUsername check is
    // skipped by the `preferredUsername !== sub` guard in the implementation.
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]).toBe(sub);
  });
});

// ---------------------------------------------------------------------------
// (e) empty / undefined preferredUsername with missing sub → null
// ---------------------------------------------------------------------------

describe("T-0371 resolveActorSlugFromAuth — (e) undefined preferredUsername with missing sub → null", () => {
  it("returns null when sub misses and preferredUsername is undefined (no crash, no fallback)", async () => {
    const sub = "missing-sub-uuid";

    const { pool, queryCalls } = makeFakePool(new Set());

    const result = await resolveActorSlugFromAuth(pool, sub, undefined);

    expect(result).toBeNull();
    // Only the sub query is issued; the undefined fallback is skipped.
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]).toBe(sub);
  });

  it("returns null when sub misses and preferredUsername is empty string", async () => {
    const sub = "missing-sub-uuid";
    const preferredUsername = "";

    const { pool, queryCalls } = makeFakePool(new Set());

    const result = await resolveActorSlugFromAuth(pool, sub, preferredUsername);

    expect(result).toBeNull();
    // Empty string is falsy → the fallback branch is skipped.
    expect(queryCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (f) T-0372: agent slug absent from kind='human' set → returns null
// Simulates the kind='human' DB restriction: the fake pool only has the agent
// slug in existsSlugs if we add it. This test ensures we DON'T add agent
// slugs (i.e. existsSlugs = only human slugs) → the resolver must return null
// even when the preferred_username exactly matches an agent slug.
// ---------------------------------------------------------------------------

describe("T-0372 resolveActorSlugFromAuth — (f) agent slug not in kind='human' set → null", () => {
  it("returns null when neither sub nor preferredUsername resolve to a human employee", async () => {
    // Simulate: DB only contains kind='human' rows. 'config-agent-seed' is kind='agent'
    // so it is absent from the fake existsSlugs set.
    const sub = "kc-client-uuid-for-config-agent";
    const preferredUsername = "config-agent-seed"; // kind='agent' slug

    // existsSlugs is empty — no human employees with these slugs.
    const { pool, queryCalls } = makeFakePool(new Set());

    const result = await resolveActorSlugFromAuth(pool, sub, preferredUsername);

    // Must be null: the agent slug does not resolve to a human employee (T-0372 guard).
    expect(result).toBeNull();
    // Both lookups were attempted (sub miss → preferredUsername miss → null).
    expect(queryCalls).toEqual([sub, preferredUsername]);
  });
});
