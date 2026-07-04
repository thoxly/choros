/**
 * Unit tests for src/core/executor-resolver.ts — T-0380 (D4) / T-0429 ladder fix.
 *
 * T-0429 CONTRACT CHANGE: the resolution ladder now distinguishes:
 *   "absent"   (rung 3): a KNOWN holder has a substitution_rule → suppress, add substitute
 *   "unfilled" (rung 4): the role has NO holders → route to owner + F7 marking
 *
 * OLD behavior (pre-T-0429): substitution ran when the pool was EMPTY.
 * NEW behavior (T-0429):     substitution runs PER-HOLDER when holders are PRESENT.
 *                             When pool is empty → fallback (skip substitution entirely).
 *
 * Tests cover the 4-step resolution ladder (spec §4 / T-0429):
 *   1. Direct assignee (short-circuits everything)
 *   2. Role pool (confirmed holders present; substitution port IS queried per-holder)
 *   3. Substitution rung (holder is absent → suppress, add substitute)
 *   4. Fallback → owner (effective pool empty, role_unfilled)
 *   5. Unresolvable (empty role + no fallback)
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
import type { SubstitutionRule } from "../substitution.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const NOW_MS = 1_700_000_000_000;

/**
 * Build a minimal ExecutorSubstitutionPort stub that returns a rule when
 * queried for a specific absentId. absentId = holder slug (T-0429: port is
 * called per-holder with holder slug as the absent key). The rule's roleId
 * must match the roleSlug being resolved.
 */
function makeSubPortStub(
  absentSlug: string,
  roleSlug: string,
  substituteSlug: string,
): ExecutorSubstitutionPort {
  return {
    async getActiveSubstitutions(tenantId, queriedAbsentId, _nowMs) {
      if (tenantId !== TENANT_ID) return [];
      if (queriedAbsentId !== absentSlug) return [];
      // Return a confirmed, open-window rule (T-0429: slug-valued IDs from mapRow).
      const rule: SubstitutionRule = {
        tenantId,
        id: "stub-rule-1",
        absentEmployeeId: absentSlug, // slug (as returned by DAO mapRow)
        substituteEmployeeId: substituteSlug,
        roleId: roleSlug,             // slug (as returned by DAO mapRow)
        orgScope: BOTTOM,
        ttlGrantId: null,
        nonInheritableExcluded: false,
        proposedBy: null,
        confirmedBy: "e-owner",       // confirmed = effective
        validFrom: null,
        validUntil: null,
        source: "stub",
        createdBy: "e-owner",
        createdAt: NOW_MS - 1000,
        updatedAt: NOW_MS - 1000,
      };
      return [rule];
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
  it("returns kind=pool with all candidates when role has holders (no substitution rules)", async () => {
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

  it("T-0429: substitution port IS queried per-holder when pool has holders", async () => {
    // Under T-0429, the substitution port is called for each holder to check
    // if they have an active absence rule. When no rules match, the holder
    // stays in the pool (unchanged).
    const subQueriedFor: string[] = [];
    let fallbackQueried = false;
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({
        "fin-ctrl": ["e-kravtsova"],
      }),
      substitution: {
        async getActiveSubstitutions(_tenantId, absentId, _nowMs) {
          subQueriedFor.push(absentId);
          return []; // no absence rule → holder stays in pool
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
    // T-0429: substitution port is called for each holder (e-kravtsova)
    expect(subQueriedFor).toContain("e-kravtsova");
    // Fallback should NOT be queried (pool is non-empty)
    expect(fallbackQueried).toBe(false);
  });

  it("pool stays unchanged when no holders have active substitution rules", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({
        "fin-ctrl": ["e-kravtsova"],
      }),
      substitution: {
        async getActiveSubstitutions() { return []; }, // no rules
      },
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("pool");
    if (result.kind === "pool") {
      expect(result.candidates).toContain("e-kravtsova");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Substitution port — T-0429: called PER-HOLDER (not on empty pool)
//
// KEY BEHAVIORAL CHANGE from pre-T-0429:
//   - BEFORE: substitution ran when the pool was EMPTY (absent_employee_id = roleSlug)
//   - AFTER:  substitution runs PER-HOLDER when holders ARE present; port called with
//             holderSlug as absentId; if rule matches → suppress holder, add substitute.
//
// When the pool is EMPTY: substitution step is SKIPPED → falls to fallback (rung 4).
// This correctly implements "absent" ≠ "unfilled".
// ---------------------------------------------------------------------------

describe("resolveExecutor — step 3: substitution port contract (T-0429 ladder)", () => {
  it("T-0429: returns kind=substitution when holder is absent AND port returns matching rule", async () => {
    // Pool has one holder (e-kravtsova); she has an active substitution rule.
    // Expected: e-kravtsova is suppressed, e-mironov substitutes → kind: "substitution".
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ "fin-ctrl": ["e-kravtsova"] }),
      substitution: makeSubPortStub("e-kravtsova", "fin-ctrl", "e-mironov"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("substitution");
    if (result.kind === "substitution") {
      expect(result.substituteSlug).toBe("e-mironov");
      expect(result.absentSlug).toBe("e-kravtsova");
      expect(result.roleSlug).toBe("fin-ctrl");
    }
  });

  it("T-0429: empty pool → fallback (substitution is NOT invoked)", async () => {
    // Under T-0429, an empty pool → role is UNFILLED → rung 4 (fallback), not substitution.
    // The substitution port is NEVER called when pool is empty.
    let subQueried = false;
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ "fin-ctrl": [] }),
      substitution: {
        async getActiveSubstitutions() {
          subQueried = true;
          return [];
        },
      },
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("fallback"); // unfilled → fallback (rung 4)
    expect(subQueried).toBe(false);       // substitution NOT invoked for empty pool
  });

  it("T-0429: no holders (undefined in map) → fallback, substitution not invoked", async () => {
    let subQueried = false;
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),  // role not even in map → []
      substitution: {
        async getActiveSubstitutions() {
          subQueried = true;
          return [];
        },
      },
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("fallback");
    expect(subQueried).toBe(false);
  });

  it("does NOT trigger fallback when holder is absent and substitute is available", async () => {
    let fallbackQueried = false;
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ "fin-ctrl": ["e-kravtsova"] }),
      substitution: makeSubPortStub("e-kravtsova", "fin-ctrl", "e-mironov"),
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

  it("falls through to fallback when substitution port returns no matching rule for the holder", async () => {
    // Port queried for "e-kravtsova" but returns empty (no active rule).
    // Holder stays in pool → kind: "pool".
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ "fin-ctrl": ["e-kravtsova"] }),
      substitution: makeSubPortStub("other-person", "fin-ctrl", "e-mironov"), // wrong absentId
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    // No matching rule for e-kravtsova → she stays in pool → kind: "pool"
    expect(result.kind).toBe("pool");
  });

  it("falls through to fallback when substitution port is not injected (production default)", async () => {
    // When pool is empty and no substitution port, go to fallback.
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      // no substitution port
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("fallback");
  });

  it("substitution step is skipped when port is absent, pool has holders → kind: 'pool'", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ "fin-ctrl": ["e-kravtsova"] }),
      // No substitution port — step 3 is a no-op → pool returned unchanged
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("pool");
    if (result.kind === "pool") {
      expect(result.candidates).toContain("e-kravtsova");
    }
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

  // T-0588 (FR-2/FR-4, AC-7): the DB-backed roleHolders/fallback ports now filter
  // deactivated_at IS NULL (grants-dao.ts getHoldersForRole/findTenantOwnerSlug).
  // From this pure resolver's point of view, a role whose sole holder was
  // deactivated (with no active substitution) is INDISTINGUISHABLE from a role
  // that was never filled: the DAO already excluded the deactivated employee,
  // so roleHolders returns []. When the fallback owner is ALSO deactivated
  // (findTenantOwnerSlug → null once T-0588 lands), the fallback port returns
  // null too — the ladder's existing unresolvable branch fires with NO new code.
  it("T-0588 AC-7: deactivated sole holder (no substitution) + deactivated/absent owner → kind=unresolvable", async () => {
    const deps: ResolverDeps = {
      // Mirrors getHoldersForRole post-T-0588: the deactivated holder is already
      // excluded at the DAO layer, so the pure port sees an empty pool.
      roleHolders: makeInMemoryRoleHolderSource({}),
      // Mirrors findTenantOwnerSlug post-T-0588: a deactivated owner resolves to
      // null (no fallback to a disabled account) — same shape as "no owner exists".
      fallback: makeInMemoryFallbackPort(null),
    };
    const result = await resolveExecutor(TENANT_ID, "role-y", NOW_MS, deps);
    expect(result.kind).toBe("unresolvable");
    if (result.kind === "unresolvable") {
      // The task is not silently swallowed — it carries the explicit
      // role_unfilled marker (F7), never an implicit assignment to the
      // deactivated holder or a disabled owner account.
      expect(result.fallbackReason).toBe("role_unfilled");
    }
  });
});

// ---------------------------------------------------------------------------
// Priority invariants — T-0429 ladder: direct > pool > substitution > fallback
// ---------------------------------------------------------------------------

describe("resolveExecutor — priority invariants (T-0429 ladder)", () => {
  it("pool wins over substitution when role has holders AND no absence rules", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ "fin-ctrl": ["e-kravtsova"] }),
      substitution: {
        async getActiveSubstitutions() { return []; }, // no absence rule
      },
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("pool");
  });

  it("substitution wins over fallback when holder is absent AND has active substitute", async () => {
    // Pool has one holder (e-kravtsova) who is absent → Bob substitutes.
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ "fin-ctrl": ["e-kravtsova"] }),
      substitution: makeSubPortStub("e-kravtsova", "fin-ctrl", "e-mironov"),
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("substitution");
    if (result.kind === "substitution") {
      expect(result.substituteSlug).toBe("e-mironov");
    }
  });

  it("T-0429: empty pool → fallback (NOT substitution; unfilled ≠ absent)", async () => {
    // Under T-0429 semantics: an EMPTY pool is "unfilled", not "absent".
    // Unfilled → rung 4 (fallback), regardless of substitution port.
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}), // empty = unfilled
      substitution: makeSubPortStub("fin-ctrl", "fin-ctrl", "e-mironov"), // port present but skipped
      fallback: makeInMemoryFallbackPort("e-owner"),
    };
    const result = await resolveExecutor(TENANT_ID, "fin-ctrl", NOW_MS, deps);
    expect(result.kind).toBe("fallback"); // NOT substitution
  });

  it("direct assignee wins over everything", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ "fin-ctrl": ["e-kravtsova"] }),
      substitution: makeSubPortStub("e-kravtsova", "fin-ctrl", "e-mironov"),
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
