/**
 * Unit tests for src/core/executor-resolver.ts — T-0380 (D4)
 *
 * Tests cover the 4-step resolution order (spec §4):
 *   1. Direct assignee
 *   2. Role pool (confirmed holders)
 *   3. Substitution (absent holder → substitute)
 *   4. Fallback → owner (empty role, F6/F7)
 *   5. Unresolvable (empty role + no owner)
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
import { makeInMemorySubstitutionSource, type SubstitutionRule } from "../substitution.js";
import { BOTTOM } from "../grant-lattice.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const NOW_MS = 1_700_000_000_000;

/** Build a minimal effective SubstitutionRule for a role-level substitution. */
function makeSubRule(
  absentId: string,
  substituteId: string,
  roleId: string,
): SubstitutionRule {
  return {
    tenantId: TENANT_ID,
    id: "rule-1",
    absentEmployeeId: absentId,
    substituteEmployeeId: substituteId,
    roleId,
    // BOTTOM (⊥) as org scope means "any request scope is contained" (⊥ ⊑ anything).
    // Safe for single-org tenants in unit tests without an org hierarchy.
    orgScope: BOTTOM,
    ttlGrantId: null,
    nonInheritableExcluded: false,
    proposedBy: null,
    confirmedBy: "e-owner",
    validFrom: null,
    validUntil: null,
    source: "manual",
    createdBy: "e-owner",
    createdAt: NOW_MS - 1000,
    updatedAt: NOW_MS - 1000,
  };
}

/** Build a substitution port that adapts SubstitutionSource to ExecutorSubstitutionPort. */
function makeSubPort(rules: SubstitutionRule[]): ExecutorSubstitutionPort {
  const src = makeInMemorySubstitutionSource(rules);
  return {
    getActiveSubstitutions: (tenantId, absentId, nowMs) =>
      src.getActiveSubstitutions(tenantId, absentId, nowMs),
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
// 3. Substitution — role pool empty, substitute found
// ---------------------------------------------------------------------------

describe("resolveExecutor — step 3: substitution", () => {
  it("returns kind=substitution when pool is empty and a rule matches", async () => {
    // Role-level substitution: absentEmployeeId === roleSlug (convention)
    const rule = makeSubRule("fin-ctrl", "e-mironov", "fin-ctrl");
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ "fin-ctrl": [] }),
      substitution: makeSubPort([rule]),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("substitution");
    if (result.kind === "substitution") {
      expect(result.substituteSlug).toBe("e-mironov");
      expect(result.roleSlug).toBe("fin-ctrl");
    }
  });

  it("does NOT trigger fallback when substitution succeeds", async () => {
    let fallbackQueried = false;
    const rule = makeSubRule("fin-ctrl", "e-mironov", "fin-ctrl");
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      substitution: makeSubPort([rule]),
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
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      substitution: makeSubPort([]), // no rules → falls through
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("fallback");
  });

  it("expired substitution rule does NOT match (window predicate)", async () => {
    const expiredRule: SubstitutionRule = {
      ...makeSubRule("fin-ctrl", "e-mironov", "fin-ctrl"),
      validUntil: NOW_MS - 1, // already expired
    };
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      substitution: makeSubPort([expiredRule]),
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    // Expired rule → should fall through to fallback
    expect(result.kind).toBe("fallback");
  });

  it("unconfirmed substitution rule is NOT matched (confirmedBy=null)", async () => {
    const unconfirmedRule: SubstitutionRule = {
      ...makeSubRule("fin-ctrl", "e-mironov", "fin-ctrl"),
      confirmedBy: null, // proposal only → zero capability
    };
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      substitution: makeSubPort([unconfirmedRule]),
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
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
    const rule = makeSubRule("fin-ctrl", "e-mironov", "fin-ctrl");
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ "fin-ctrl": ["e-kravtsova"] }),
      substitution: makeSubPort([rule]),
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("pool");
  });

  it("substitution wins over fallback when a rule matches", async () => {
    const rule = makeSubRule("fin-ctrl", "e-mironov", "fin-ctrl");
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      substitution: makeSubPort([rule]),
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("substitution");
  });

  it("direct assignee wins over everything", async () => {
    const rule = makeSubRule("fin-ctrl", "e-mironov", "fin-ctrl");
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ "fin-ctrl": ["e-kravtsova"] }),
      substitution: makeSubPort([rule]),
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
