/**
 * src/__tests__/resolve-actor-tenant.test.ts — T-0486 [SECURITY] unit tests for
 * resolveActorTenant in src/db/org.ts.
 *
 * Pure unit — no live Postgres. Mocks pool.connect() → a fake client whose
 * query() returns the employee⋈tenant join result for a given slug.
 *
 * THE CHANGE UNDER TEST (T-0486): resolveActorTenant used to FALL BACK to
 * DEV_TENANT_ID when the actor could not be resolved (unknown slug → empty
 * result set; OR a DB error). That was fail-OPEN-to-dev-tenant — an
 * unresolvable identity silently landed in the Dev Silo. It now FAILS CLOSED:
 * both unresolvable paths throw HttpError(403, "ACTOR_TENANT_UNRESOLVED").
 *
 * Covers:
 *   (a) known slug → returns the resolved tenant_id (legitimate path, unchanged)
 *   (b) unknown slug (empty result) → throws 403, NOT DEV_TENANT_ID
 *   (c) DB error (connect/query throws) → throws 403, NOT DEV_TENANT_ID
 *   (d) the thrown error is HttpError with statusCode 403 (router → 403 envelope)
 *   (e) the client is always released (no connection leak) on every path
 */

import { describe, it, expect } from "vitest";
import type { Pool, PoolClient } from "pg";
import { resolveActorTenant, DEV_TENANT_ID } from "../db/org.js";
import { HttpError } from "../http/router.js";

// ---------------------------------------------------------------------------
// Fake pool builder.
//
// tenantBySlug: map of slug → tenant_id for "known" employees. A slug absent
//   from the map models an unknown actor (the employee⋈tenant JOIN returns 0
//   rows). throwOnQuery=true models a DB error mid-query.
// ---------------------------------------------------------------------------

function makeFakePool(opts: {
  tenantBySlug?: Record<string, string>;
  throwOnConnect?: boolean;
  throwOnQuery?: boolean;
}): { pool: Pool; released: () => number } {
  const tenantBySlug = opts.tenantBySlug ?? {};
  let releaseCount = 0;

  const fakeClient = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (_sql: string, params?: unknown[]): Promise<any> => {
      if (opts.throwOnQuery) {
        throw new Error("simulated DB error (connection refused)");
      }
      const slug = (params ?? [])[0] as string | undefined;
      const tenantId = slug !== undefined ? tenantBySlug[slug] : undefined;
      return tenantId
        ? { rows: [{ tenant_id: tenantId }] }
        : { rows: [] };
    },
    release: () => {
      releaseCount += 1;
    },
  } as unknown as PoolClient;

  const pool = {
    connect: async () => {
      if (opts.throwOnConnect) {
        throw new Error("simulated connect failure");
      }
      return fakeClient;
    },
  } as unknown as Pool;

  return { pool, released: () => releaseCount };
}

// ---------------------------------------------------------------------------
// (a) known slug → returns the resolved tenant (legitimate dev/keycloak path)
// ---------------------------------------------------------------------------

describe("T-0486 resolveActorTenant — (a) known slug resolves to its real tenant", () => {
  it("returns the employee's tenant_id when the slug maps to an employee row", async () => {
    const realTenant = "11111111-1111-1111-1111-111111111111";
    const { pool, released } = makeFakePool({
      tenantBySlug: { "e-orlov": realTenant },
    });

    const result = await resolveActorTenant(pool, "e-orlov");

    expect(result).toBe(realTenant);
    // Legitimate path must NOT be the Dev Silo here (the employee has its own tenant).
    expect(result).not.toBe(DEV_TENANT_ID);
    expect(released()).toBe(1);
  });

  it("still resolves an employee whose tenant IS the dev silo (dev-mode unchanged)", async () => {
    // Legitimate dev-mode: a valid x-dev-user whose seeded employee genuinely
    // lives in the Dev Silo resolves to DEV_TENANT_ID *because the row says so*,
    // not via the removed fallback.
    const { pool } = makeFakePool({
      tenantBySlug: { "e-larina": DEV_TENANT_ID },
    });

    const result = await resolveActorTenant(pool, "e-larina");

    expect(result).toBe(DEV_TENANT_ID);
  });
});

// ---------------------------------------------------------------------------
// (b) unknown slug → FAIL CLOSED (403), NOT silently routed to the Dev Silo
// ---------------------------------------------------------------------------

describe("T-0486 resolveActorTenant — (b) unknown slug rejected, not routed to Dev Silo", () => {
  it("throws (does NOT return DEV_TENANT_ID) when the slug maps to no employee", async () => {
    const { pool, released } = makeFakePool({ tenantBySlug: {} });

    await expect(resolveActorTenant(pool, "ghost-actor")).rejects.toBeInstanceOf(
      HttpError,
    );
    // The client must still be released even on the reject path.
    expect(released()).toBe(1);
  });

  it("rejects with a 403 status and the ACTOR_TENANT_UNRESOLVED code", async () => {
    const { pool } = makeFakePool({ tenantBySlug: {} });

    let caught: unknown;
    try {
      await resolveActorTenant(pool, "ghost-actor");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).statusCode).toBe(403);
    expect((caught as HttpError).code).toBe("ACTOR_TENANT_UNRESOLVED");
  });

  it("NEVER resolves an unknown actor to DEV_TENANT_ID (regression guard)", async () => {
    const { pool } = makeFakePool({ tenantBySlug: {} });

    // Prove the old fail-open behavior is gone: the call must throw, so the
    // returned value can never equal DEV_TENANT_ID.
    await expect(resolveActorTenant(pool, "ghost-actor")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// (c) DB error → FAIL CLOSED (403), NOT a safe-fallback to Dev Silo
// ---------------------------------------------------------------------------

describe("T-0486 resolveActorTenant — (c) DB error fails closed", () => {
  it("throws 403 on query failure (was: silent DEV_TENANT_ID fallback)", async () => {
    const { pool, released } = makeFakePool({ throwOnQuery: true });

    let caught: unknown;
    try {
      await resolveActorTenant(pool, "e-orlov");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).statusCode).toBe(403);
    // The client must be released even when the query throws.
    expect(released()).toBe(1);
  });
});
