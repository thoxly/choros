/**
 * Unit tests for src/core/executor-resolver.ts — T-0380 (D4)
 *
 * Tests cover the 4-step resolution order (spec §4):
 *   1. Direct assignee
 *   2. Role pool (confirmed holders)
 *   3. Substitution port (optional; DB-backed UUID-resolution pending T-0053)
 *   4. Fallback → owner (empty role, F6/F7)
 *   5. Unresolvable (empty role + no owner)
 *
 * SUBSTITUTION NOTE: substitution_rule.absent_employee_id and role_id are UUIDs
 * in the DB (FK to employee/role — see migrations/036_substitution_rule.sql).
 * A correct DB-backed port must resolve role slug → UUID and holder slug → UUID
 * before querying, and translate substituteEmployeeId UUID → slug on return.
 * That port (T-0053) is NOT yet wired in production (makeExecutorResolverDeps in
 * inbox.ts does not inject substitution). Tests here assert the PORT INTERFACE
 * contract (the resolver calls the port and honours its return), not a slug-based
 * convention that the DB cannot satisfy.
 *
 * All tests use in-memory stubs — no live DB required.
 */

import { describe, it, expect } from "vitest";
import {
  resolveExecutor,
  makeInMemoryRoleHolderSource,
  makeInMemoryFallbackPort,
  type ResolverDeps,
  type ExecutorSubstitutionPort,
} from "../executor-resolver.js";
import { BOTTOM } from "../grant-lattice.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const NOW_MS = 1_700_000_000_000;

/**
 * Build a minimal ExecutorSubstitutionPort stub that returns a fixed substituteSlug
 * when queried for absentId. This tests the RESOLVER's port-contract (it calls the
 * port and honours the returned rules) independently of the DB UUID-resolution
 * concern. The real port (T-0053) translates UUIDs; the stub just returns fixtures.
 *
 * The stub mimics what a correctly-wired port would return: SubstitutionRule objects
 * with `absentEmployeeId` matching the absent-id the resolver passes, and
 * `substituteEmployeeId` containing the resolved substitute slug (post UUID→slug
 * translation that the real port performs).
 */
function makeSubPortStub(
  absentId: string,
  substituteSlug: string,
): ExecutorSubstitutionPort {
  return {
    async getActiveSubstitutions(tenantId, queriedAbsentId, _nowMs) {
      if (tenantId !== TENANT_ID) return [];
      if (queriedAbsentId !== absentId) return [];
      // Return a rule that resolveSubstitution will match:
      // absentEmployeeId === queriedAbsentId, roleId === queriedAbsentId (the
      // resolver currently passes roleSlug for both; a future port may differ).
      return [
        {
          tenantId,
          id: "stub-rule-1",
          absentEmployeeId: queriedAbsentId,
          substituteEmployeeId: substituteSlug,
          roleId: queriedAbsentId,
          orgScope: BOTTOM,
          ttlGrantId: null,
          nonInheritableExcluded: false,
          proposedBy: null,
          confirmedBy: "e-owner",
          validFrom: null,
          validUntil: null,
          source: "stub",
          createdBy: "e-owner",
          createdAt: NOW_MS - 1000,
          updatedAt: NOW_MS - 1000,
        },
      ];
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Direct assignee
// ---------------------------------------------------------------------------

describe("resolveExecutor — step 1: direct assignee", () => {
  it("returns kind=direct when directSlug is provided", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps, {
      directSlug: "e-kravtsova",
    });
    expect(result.kind).toBe("direct");
    if (result.kind === "direct") {
      expect(result.directSlug).toBe("e-kravtsova");
    }
  });

  it("does not query role holders when directSlug is present", async () => {
    let queried = false;
    const deps: ResolverDeps = {
      roleHolders: {
        async getHoldersForRole() {
          queried = true;
          return [];
        },
      },
    };
    await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps, { directSlug: "e-orlov" });
    expect(queried).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Role pool — confirmed holders present
// ---------------------------------------------------------------------------

describe("resolveExecutor — step 2: role pool", () => {
  it("returns kind=pool with all candidates when role has holders", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({
        "fin-ctrl": ["e-kravtsova", "e-sokolov"],
      }),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("pool");
    if (result.kind === "pool") {
      expect(result.roleSlug).toBe("fin-ctrl");
      expect(result.candidates).toContain("e-kravtsova");
      expect(result.candidates).toContain("e-sokolov");
    }
  });

  it("does NOT trigger substitution or fallback when pool has holders", async () => {
    let subQueried = false;
    let fallbackQueried = false;
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({
        "fin-ctrl": ["e-kravtsova"],
      }),
      substitution: {
        async getActiveSubstitutions() {
          subQueried = true;
          return [];
        },
      },
      fallback: {
        async resolveFallbackSlug() {
          fallbackQueried = true;
          return "e-owner";
        },
      },
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("pool");
    expect(subQueried).toBe(false);
    expect(fallbackQueried).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Substitution port — gated behind optional deps.substitution
//
// IMPORTANT: the substitution_rule DB table stores absent_employee_id and role_id
// as UUIDs (FK columns — see migrations/036_substitution_rule.sql). A real port
// (T-0053) must translate role slug → role.id and holder slug → employee.id before
// querying, and map substituteEmployeeId UUID → slug before returning. These tests
// assert the RESOLVER's port-call contract (it calls the port and honours the result)
// NOT a slug-based matching convention that the DB cannot satisfy.
//
// Production wiring: makeExecutorResolverDeps in inbox.ts does NOT inject the
// substitution port (T-0053 pending), so in production the step is always skipped
// and control falls through to step 4 (fallback-owner). That is correct and safe.
// ---------------------------------------------------------------------------

describe("resolveExecutor — step 3: substitution port contract", () => {
  it("returns kind=substitution when pool is empty and port returns a matching rule", async () => {
    // Stub port mimics a correctly-wired UUID-aware port returning a resolved rule.
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ "fin-ctrl": [] }),
      substitution: makeSubPortStub("fin-ctrl", "e-mironov"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("substitution");
    if (result.kind === "substitution") {
      expect(result.substituteSlug).toBe("e-mironov");
      expect(result.roleSlug).toBe("fin-ctrl");
    }
  });

  it("does NOT trigger fallback when substitution port returns a matching rule", async () => {
    let fallbackQueried = false;
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      substitution: makeSubPortStub("fin-ctrl", "e-mironov"),
      fallback: {
        async resolveFallbackSlug() {
          fallbackQueried = true;
          return "e-owner";
        },
      },
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("substitution");
    expect(fallbackQueried).toBe(false);
  });

  it("falls through to fallback when substitution port returns no matching rule", async () => {
    // Port returns nothing for "fin-ctrl" → resolver falls through.
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      substitution: makeSubPortStub("other-role", "e-mironov"), // wrong absent-id → no match
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("fallback");
  });

  it("falls through to fallback when substitution port is not injected (production default)", async () => {
    // This is the production path: makeExecutorResolverDeps does not inject
    // substitution (T-0053 pending). Without the port, the step is skipped.
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      // no substitution port
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("fallback");
  });

  it("substitution step is skipped when port is absent (no-op, falls to step 4)", async () => {
    // Verify that omitting deps.substitution entirely does not throw and routes correctly.
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "any-role", NOW_MS, deps);
    expect(result.kind).toBe("fallback");
  });
});

// ---------------------------------------------------------------------------
// 4. Fallback → owner (F6/F7)
// ---------------------------------------------------------------------------

describe("resolveExecutor — step 4: fallback-owner (F6/F7)", () => {
  it("returns kind=fallback with owner slug when role is empty and fallback is configured", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}), // empty role
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("fallback");
    if (result.kind === "fallback") {
      expect(result.fallbackSlug).toBe("e-owner");
      expect(result.roleSlug).toBe("fin-ctrl");
      // F7: must be marked role_unfilled
      expect(result.fallbackReason).toBe("role_unfilled");
    }
  });

  it("fallback task carries fallbackReason=role_unfilled (F7 marking)", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "cs-l1", NOW_MS, deps);
    expect(result.kind).toBe("fallback");
    if (result.kind === "fallback") {
      expect(result.fallbackReason).toBe("role_unfilled");
    }
  });

  it("passes procKey to the fallback port for per-process config", async () => {
    let receivedProcKey: string | undefined = undefined;
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      fallback: {
        async resolveFallbackSlug(_tenantId, procKey) {
          receivedProcKey = procKey;
          return "e-owner";
        },
      },
    };
    await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps, { procKey: "telLinear" });
    expect(receivedProcKey).toBe("telLinear");
  });
});

// ---------------------------------------------------------------------------
// 5. Unresolvable (empty role + no fallback / no owner found)
// ---------------------------------------------------------------------------

describe("resolveExecutor — step 5: unresolvable", () => {
  it("returns kind=unresolvable when role is empty and fallback port returns null", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      fallback: makeInMemoryFallbackPort(null), // no owner configured
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("unresolvable");
    if (result.kind === "unresolvable") {
      expect(result.fallbackReason).toBe("role_unfilled");
    }
  });

  it("returns kind=unresolvable when no fallback port is injected", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      // no fallback port
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("unresolvable");
  });
});

// ---------------------------------------------------------------------------
// Priority invariants — pool > substitution > fallback
// ---------------------------------------------------------------------------

describe("resolveExecutor — priority invariants", () => {
  it("pool wins over substitution when role has holders", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ "fin-ctrl": ["e-kravtsova"] }),
      substitution: makeSubPortStub("fin-ctrl", "e-mironov"),
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("pool");
  });

  it("substitution wins over fallback when port returns a matching rule", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      substitution: makeSubPortStub("fin-ctrl", "e-mironov"),
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("substitution");
  });

  it("direct assignee wins over everything", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ "fin-ctrl": ["e-kravtsova"] }),
      substitution: makeSubPortStub("fin-ctrl", "e-mironov"),
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps, {
      directSlug: "e-specific-person",
    });
    expect(result.kind).toBe("direct");
    if (result.kind === "direct") {
      expect(result.directSlug).toBe("e-specific-person");
    }
  });
});
