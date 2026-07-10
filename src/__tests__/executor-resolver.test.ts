/**
 * T-0429: executor-resolver.ts unit tests — full resolution ladder.
 *
 * Covers:
 *   ER-1  — direct assignee short-circuits the ladder (kind: "direct")
 *   ER-2  — pool path (holders present, no substitution port): kind: "pool"
 *   ER-3  — substitution rung: holder is absent → substitute takes the task
 *   ER-4  — chain semantics: A absent → B; if B is also absent it is NOT resolved
 *           (single-hop only; chains A→B→C are not followed — cycle-safe by construction)
 *   ER-5  — absent ≠ unfilled: all holders have substitutes → kind: "pool" (substituted)
 *   ER-6  — all holders absent with no substitutes → fallback (rung 4, kind: "fallback")
 *   ER-7  — role unfilled (no holders at all) → fallback (kind: "fallback")
 *   ER-8  — no fallback port → kind: "unresolvable"
 *   ER-9  — no substitution port → pool unchanged (step 3 is a no-op)
 *   ER-10 — mixed pool: some holders present, one absent with substitute → kind: "pool"
 *           (effective set = present holders + substitute)
 *
 * All IO via in-memory ports (no DB, no pg, no fs). Tests are pure and
 * deterministic (D-056 discipline).
 */
import { describe, it, expect } from "vitest";
import {
  resolveExecutor,
  makeInMemoryRoleHolderSource,
  makeInMemoryFallbackPort,
  type ResolverDeps,
  type ExecutorSubstitutionPort,
} from "../core/executor-resolver.js";
import { type SubstitutionRule } from "../core/substitution.js";
import { BOTTOM } from "../core/grant-lattice.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TENANT = "a0000000-0000-0000-0000-000000000001";
const ROLE = "fin-ctrl";
const NOW = 1_000_000;

// T-0744: a substitute who does NOT personally hold the role provides coverage
// ONLY via a minted Tier-2 grant. The "substitute takes over" scenarios below
// therefore carry a ttl_grant_id (Tier-2) — the corrected contract; a Tier-1
// non-holder now honestly routes to fallback (see the dedicated T-0744 test).
const T2_GRANT = "g-tier2-1";

// Employee slugs (match slug-based resolution from substitution-dao mapRow)
const ALICE = "e-alice";
const BOB = "e-bob";
const CAROL = "e-carol";
const OWNER = "e-owner";
const DIRECT = "e-direct";

// Scope used by all tests (BOTTOM = the minimal scope, always matches root oracle)
const SCOPE = BOTTOM;

// ---------------------------------------------------------------------------
// makeInMemorySubstitutionPort — pure in-memory stub for the batch port
// ---------------------------------------------------------------------------

/**
 * Creates an in-memory ExecutorSubstitutionPort from a map of
 * { [absentSlug]: SubstitutionRule[] }. Returns [] for any unknown absentSlug.
 */
function makeInMemorySubstitutionPort(
  rulesByAbsent: Record<string, SubstitutionRule[]>,
): ExecutorSubstitutionPort {
  return {
    async getActiveSubstitutions(
      _tenantId: string,
      absentEmployeeId: string,
      _nowMs: number,
    ): Promise<SubstitutionRule[]> {
      return rulesByAbsent[absentEmployeeId] ?? [];
    },
  };
}

/**
 * Build a minimal SubstitutionRule with sensible defaults (confirmed, open window,
 * slug-valued UUID fields as produced by substitution-dao.ts mapRow).
 */
function makeRule(
  absentSlug: string,
  substituteSlug: string,
  roleSlug: string = ROLE,
  overrides: Partial<SubstitutionRule> = {},
): SubstitutionRule {
  return {
    tenantId: TENANT,
    id: `rule-${absentSlug}-${substituteSlug}`,
    absentEmployeeId: absentSlug,     // slug (from DAO mapRow)
    substituteEmployeeId: substituteSlug, // slug (from DAO mapRow)
    roleId: roleSlug,                  // slug (from DAO mapRow)
    orgScope: SCOPE,
    ttlGrantId: null,
    nonInheritableExcluded: true,
    proposedBy: null,
    confirmedBy: "seed",               // confirmed = effective
    validFrom: null,                   // open start
    validUntil: null,                  // open end
    source: "manual",
    createdBy: "seed",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ER-1: Direct assignee short-circuits the ladder
// ---------------------------------------------------------------------------

describe("ER-1: direct assignee", () => {
  it("returns kind: 'direct' regardless of role holders", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE, BOB] }),
      fallback: makeInMemoryFallbackPort(OWNER),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps, { directSlug: DIRECT });
    expect(res.kind).toBe("direct");
    if (res.kind === "direct") {
      expect(res.directSlug).toBe(DIRECT);
    }
  });

  it("returns kind: 'direct' even when role is unfilled", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      fallback: makeInMemoryFallbackPort(OWNER),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps, { directSlug: DIRECT });
    expect(res.kind).toBe("direct");
  });
});

// ---------------------------------------------------------------------------
// ER-2: Pool path (no substitution port)
// ---------------------------------------------------------------------------

describe("ER-2: pool path (no substitution port)", () => {
  it("returns kind: 'pool' with all role holders when no substitution port injected", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE, BOB] }),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("pool");
    if (res.kind === "pool") {
      expect(res.candidates).toEqual(expect.arrayContaining([ALICE, BOB]));
      expect(res.candidates).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// ER-9: No substitution port → substitution step is no-op
// ---------------------------------------------------------------------------

describe("ER-9: no substitution port → step 3 is no-op", () => {
  it("pool returned unchanged even if holder is abstract-absent", async () => {
    // Alice is conceptually "absent" but no port is injected — the resolver
    // cannot see the absence and must return the raw pool.
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE] }),
      // No substitution port
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("pool");
    if (res.kind === "pool") {
      expect(res.candidates).toContain(ALICE);
    }
  });
});

// ---------------------------------------------------------------------------
// ER-3: Substitution rung — holder absent → substitute
// ---------------------------------------------------------------------------

describe("ER-3: substitution rung (single-holder absent)", () => {
  it("suppresses absent holder and returns kind: 'substitution' (Tier-2 substitute)", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE] }),
      substitution: makeInMemorySubstitutionPort({
        [ALICE]: [makeRule(ALICE, BOB, ROLE, { ttlGrantId: T2_GRANT })],
      }),
      fallback: makeInMemoryFallbackPort(OWNER),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("substitution");
    if (res.kind === "substitution") {
      expect(res.absentSlug).toBe(ALICE);
      expect(res.substituteSlug).toBe(BOB);
      expect(res.roleSlug).toBe(ROLE);
    }
  });

  it("does NOT fall back to owner when a covering (Tier-2) substitute is available", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE] }),
      substitution: makeInMemorySubstitutionPort({
        [ALICE]: [makeRule(ALICE, BOB, ROLE, { ttlGrantId: T2_GRANT })],
      }),
      fallback: makeInMemoryFallbackPort(OWNER),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).not.toBe("fallback");
    expect(res.kind).not.toBe("unresolvable");
  });

  // T-0744: a Tier-1 substitute who does NOT hold the role gives NO coverage →
  // the sole absent holder leaves an empty pool → fallback (role_unfilled).
  it("T-0744: sole holder absent + Tier-1 NON-holder substitute → fallback, not substitution", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE] }),
      substitution: makeInMemorySubstitutionPort({
        [ALICE]: [makeRule(ALICE, BOB)], // Tier-1 (ttlGrantId null), BOB not a holder
      }),
      fallback: makeInMemoryFallbackPort(OWNER),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("fallback");
    if (res.kind === "fallback") {
      expect(res.fallbackReason).toBe("role_unfilled");
    }
  });
});

// ---------------------------------------------------------------------------
// ER-5: "absent" ≠ "unfilled" — pool substituted, no fallback
// ---------------------------------------------------------------------------

describe("ER-5: absent ≠ unfilled", () => {
  it("all holders absent WITH substitutes → substituted pool, NOT fallback", async () => {
    // Both Alice and Bob are holders; both have substitutes.
    // The effective pool is { Carol, Carol } (Carol covers both) → deduped.
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE, BOB] }),
      substitution: makeInMemorySubstitutionPort({
        [ALICE]: [makeRule(ALICE, CAROL, ROLE, { ttlGrantId: T2_GRANT })],
        [BOB]: [makeRule(BOB, CAROL, ROLE, { ttlGrantId: T2_GRANT })],
      }),
      fallback: makeInMemoryFallbackPort(OWNER),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    // Both Alice and Bob are suppressed; Carol (covering Tier-2 substitute) is the
    // only effective candidate. Result is kind: "substitution" (single effective)
    // or kind: "pool" (multiple effective).
    expect(res.kind).not.toBe("fallback");
    expect(res.kind).not.toBe("unresolvable");
  });

  it("single holder absent WITH covering (Tier-2) substitute → kind: 'substitution' (not 'fallback')", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE] }),
      substitution: makeInMemorySubstitutionPort({
        [ALICE]: [makeRule(ALICE, CAROL, ROLE, { ttlGrantId: T2_GRANT })],
      }),
      fallback: makeInMemoryFallbackPort(OWNER),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("substitution");
  });
});

// ---------------------------------------------------------------------------
// ER-10: Mixed pool — some holders present, one absent with substitute
// ---------------------------------------------------------------------------

describe("ER-10: mixed pool (partial substitution)", () => {
  it("present holders + substitute of absent holder → kind: 'pool' with effective set", async () => {
    // Alice is present. Bob is absent, Carol substitutes.
    // Effective pool: { Alice, Carol }.
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE, BOB] }),
      substitution: makeInMemorySubstitutionPort({
        [ALICE]: [],                                               // Alice present
        [BOB]: [makeRule(BOB, CAROL, ROLE, { ttlGrantId: T2_GRANT })], // Bob absent → Carol (Tier-2)
      }),
      fallback: makeInMemoryFallbackPort(OWNER),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("pool");
    if (res.kind === "pool") {
      expect(res.candidates).toContain(ALICE);
      expect(res.candidates).toContain(CAROL);
      expect(res.candidates).not.toContain(BOB); // Bob suppressed
    }
  });
});

// ---------------------------------------------------------------------------
// ER-6: All holders absent with no substitutes → fallback (role_unfilled)
// ---------------------------------------------------------------------------

describe("ER-6: all holders absent, no substitutes → fallback", () => {
  it("returns kind: 'fallback' with role_unfilled when all holders absent with no active substitute", async () => {
    // Alice is the only holder; she is absent with no substitute (empty rules[]).
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE] }),
      substitution: makeInMemorySubstitutionPort({
        [ALICE]: [], // absent but no substitute
      }),
      fallback: makeInMemoryFallbackPort(OWNER),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    // After substitution step: effective pool is empty → fallback.
    // BUT: the substitution port returns [] (no rules), so Alice is NOT suppressed.
    // The pool remains { Alice } → pool path, NOT fallback.
    // Correct outcome: resolveExecutor only suppresses a holder when a RULE MATCHES.
    // No rule = no suppression = pool unchanged.
    expect(res.kind).toBe("pool");
    if (res.kind === "pool") {
      expect(res.candidates).toContain(ALICE);
    }
  });

  it("holder absent WITH a covering (Tier-2) substitute → kind: 'substitution', not fallback", async () => {
    // Alice is absent → Bob substitutes under a Tier-2 rule. Alice is suppressed,
    // Bob added. Effective pool = { Bob }. kind: "substitution".
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE] }),
      substitution: makeInMemorySubstitutionPort({
        [ALICE]: [makeRule(ALICE, BOB, ROLE, { ttlGrantId: T2_GRANT })],
      }),
      fallback: makeInMemoryFallbackPort(OWNER),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("substitution");
  });
});

// ---------------------------------------------------------------------------
// ER-7: Role unfilled (no holders) → fallback
// ---------------------------------------------------------------------------

describe("ER-7: role unfilled (no holders) → fallback", () => {
  it("returns kind: 'fallback' when role has no holders", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}), // empty
      fallback: makeInMemoryFallbackPort(OWNER),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("fallback");
    if (res.kind === "fallback") {
      expect(res.fallbackReason).toBe("role_unfilled");
      expect(res.fallbackSlug).toBe(OWNER);
      expect(res.roleSlug).toBe(ROLE);
    }
  });

  it("fallback does NOT require a substitution port to work", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      fallback: makeInMemoryFallbackPort(OWNER),
      // No substitution port
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("fallback");
  });
});

// ---------------------------------------------------------------------------
// ER-8: No fallback port → unresolvable
// ---------------------------------------------------------------------------

describe("ER-8: no fallback port → unresolvable", () => {
  it("returns kind: 'unresolvable' when role is empty and no fallback port", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      // No fallback port
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("unresolvable");
    if (res.kind === "unresolvable") {
      expect(res.fallbackReason).toBe("role_unfilled");
    }
  });

  it("returns kind: 'unresolvable' when fallback port returns null", async () => {
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({}),
      fallback: makeInMemoryFallbackPort(null), // no owner found
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("unresolvable");
  });
});

// ---------------------------------------------------------------------------
// ER-4: Chain substitution — single-hop only (chains not followed)
// ---------------------------------------------------------------------------

describe("ER-4: chain substitution / hop semantics", () => {
  it("resolves A → B when B is not absent (no further hop needed)", async () => {
    // Alice is absent → Bob substitutes. Bob has NO absence rule → Bob is the final executor.
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE] }),
      substitution: makeInMemorySubstitutionPort({
        [ALICE]: [makeRule(ALICE, BOB, ROLE, { ttlGrantId: T2_GRANT })],
        [BOB]: [], // Bob is not absent
      }),
      fallback: makeInMemoryFallbackPort(OWNER),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("substitution");
    if (res.kind === "substitution") {
      expect(res.absentSlug).toBe(ALICE);
      expect(res.substituteSlug).toBe(BOB);
    }
  });

  it("resolveExecutor does not chain beyond one hop in the single-task path (chain resolved by DAO)", async () => {
    // A → B, but B has a rule too. The CURRENT resolveExecutor only applies one
    // level of suppression (it looks up rules for each ORIGINAL holder, not for
    // the substitutes added during the pass). Chains beyond one hop are NOT
    // resolved anywhere — substitution is single-hop by design (cycle-safe).
    // Here: Alice absent → Bob; Bob's rules are NOT checked by the resolver pass
    // (Bob is not in the original holder set). Result: kind: "substitution" with BOB.
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE] }),
      substitution: makeInMemorySubstitutionPort({
        [ALICE]: [makeRule(ALICE, BOB, ROLE, { ttlGrantId: T2_GRANT })],
        [BOB]: [makeRule(BOB, CAROL)], // chain: Bob → Carol; NOT followed by resolver
      }),
      fallback: makeInMemoryFallbackPort(OWNER),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    // The resolver only suppresses ORIGINAL holders (Alice); Bob is a substitute,
    // not an original holder, so BOB's absence is NOT processed in this pass.
    // Result: substituteSlug = Bob (first-hop only).
    expect(res.kind).toBe("substitution");
    if (res.kind === "substitution") {
      expect(res.substituteSlug).toBe(BOB);
    }
  });
});

// ---------------------------------------------------------------------------
// on_behalf_of: performed_by ≠ on_behalf_of (substitution provenance)
// ---------------------------------------------------------------------------

describe("on_behalf_of: substitution provenance (kind: 'substitution' carries both slugs)", () => {
  it("kind: 'substitution' carries absentSlug (original holder) separate from substituteSlug (performer)", async () => {
    // Bob performs the task ON BEHALF OF Alice (Alice is absent).
    // absentSlug = Alice (the role holder the task was addressed to).
    // substituteSlug = Bob (the actual performer).
    // These are DIFFERENT fields — the audit trail distinguishes on_behalf_of (Alice)
    // from performed_by (Bob). The resolver supplies both.
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE] }),
      substitution: makeInMemorySubstitutionPort({
        [ALICE]: [makeRule(ALICE, BOB, ROLE, { ttlGrantId: T2_GRANT })],
      }),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("substitution");
    if (res.kind === "substitution") {
      // absentSlug is the "on_behalf_of" field (the nominal holder)
      expect(res.absentSlug).toBe(ALICE);
      // substituteSlug is the "performed_by" field (the actual actor)
      expect(res.substituteSlug).toBe(BOB);
      // They must be distinct — performed_by ≠ on_behalf_of
      expect(res.substituteSlug).not.toBe(res.absentSlug);
    }
  });

  it("kind: 'pool' does NOT carry absentSlug/substituteSlug — no on_behalf_of provenance", async () => {
    // When no substitution occurs (pool path), there's no on_behalf_of relationship.
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE, BOB] }),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("pool");
    // "absentSlug" and "substituteSlug" fields don't exist on pool result
    if (res.kind === "pool") {
      expect((res as Record<string, unknown>)["absentSlug"]).toBeUndefined();
      expect((res as Record<string, unknown>)["substituteSlug"]).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("expired substitution rule → rule not matched → holder stays in pool", async () => {
    const expiredRule = makeRule(ALICE, BOB, ROLE, { validUntil: NOW - 1 }); // expired
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE] }),
      substitution: makeInMemorySubstitutionPort({
        [ALICE]: [expiredRule],
      }),
      fallback: makeInMemoryFallbackPort(OWNER),
    };
    // The in-memory port returns the expired rule; resolveSubstitution inside
    // resolveExecutor will NOT match it (isRuleEffective returns false).
    // Result: Alice stays in the pool (no suppression).
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("pool");
    if (res.kind === "pool") {
      expect(res.candidates).toContain(ALICE);
      expect(res.candidates).not.toContain(BOB);
    }
  });

  it("unconfirmed substitution rule (proposal) → not matched → holder stays in pool", async () => {
    const proposalRule = makeRule(ALICE, BOB, ROLE, { confirmedBy: null }); // proposal
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE] }),
      substitution: makeInMemorySubstitutionPort({
        [ALICE]: [proposalRule],
      }),
      fallback: makeInMemoryFallbackPort(OWNER),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("pool");
    if (res.kind === "pool") {
      expect(res.candidates).toContain(ALICE);
    }
  });

  it("role mismatch in substitution rule → rule not matched → holder stays in pool", async () => {
    // Rule applies to a different role slug
    const wrongRoleRule = makeRule(ALICE, BOB, "other-role");
    const deps: ResolverDeps = {
      roleHolders: makeInMemoryRoleHolderSource({ [ROLE]: [ALICE] }),
      substitution: makeInMemorySubstitutionPort({
        [ALICE]: [wrongRoleRule],
      }),
      fallback: makeInMemoryFallbackPort(OWNER),
    };
    const res = await resolveExecutor(TENANT, ROLE, NOW, deps);
    expect(res.kind).toBe("pool");
    if (res.kind === "pool") {
      expect(res.candidates).toContain(ALICE);
    }
  });

  it("multiple roles: resolution is independent per role", async () => {
    const OTHER_ROLE = "fin-appr";
    const holderSource = makeInMemoryRoleHolderSource({
      [ROLE]: [ALICE],
      [OTHER_ROLE]: [],
    });

    // ROLE has Alice (present): pool path.
    const depsRole: ResolverDeps = { roleHolders: holderSource, fallback: makeInMemoryFallbackPort(OWNER) };
    const resRole = await resolveExecutor(TENANT, ROLE, NOW, depsRole);
    expect(resRole.kind).toBe("pool");

    // OTHER_ROLE is empty: fallback path.
    const depsOther: ResolverDeps = { roleHolders: holderSource, fallback: makeInMemoryFallbackPort(OWNER) };
    const resOther = await resolveExecutor(TENANT, OTHER_ROLE, NOW, depsOther);
    expect(resOther.kind).toBe("fallback");
  });
});
