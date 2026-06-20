/**
 * src/core/agent-on-behalf.ts — T-0359 (E17): On-behalf-of grants intersection.
 *
 * PURE: no pg / node:http / https / net / fetch / child_process / process.env.
 * No new authority — composes the existing GrantSource interface + lattice
 * isNarrowerOrEqual to build the INTERSECTION of agent and user grants.
 *
 * SECURITY INVARIANT:
 *   makeIntersectionGrantSource(base, agentSubject, userSubject).getGrants()
 *   NEVER returns a grant that is NOT also held by the user. The intersection
 *   is structural: a grant in the result set must be covered by at least one
 *   user grant (isNarrowerOrEqual(agentGrant.scope, userGrant.scope) holds).
 *
 * This is the seam that prevents agent privilege escalation: even if an agent
 * has broader grants than the user, the intersection limits the effective
 * authority to what the user can already see/do.
 *
 * Design: T-0359 ADR §4, agent-console-authoring-and-analytics.md §4.
 */

import {
  type Grant,
  type AncestryOracle,
  isNarrowerOrEqual,
  isEffective,
} from "./grant-lattice.js";
import type { GrantSource } from "./grant-resolver.js";
import type { ResolveSubject } from "./object-handle.js";

// ---------------------------------------------------------------------------
// makeIntersectionGrantSource
// ---------------------------------------------------------------------------

/**
 * Build a GrantSource that returns the INTERSECTION of agent grants and user grants.
 *
 * A grant from `agentSubject` appears in the result iff it is "covered" by at
 * least one grant of `userSubject` at the same `nowMs`:
 *
 *   covered(agentGrant, userGrants) ≡
 *     ∃ userGrant ∈ userGrants:
 *       userGrant.resourceType === agentGrant.resourceType
 *       ∧ userGrant.operation  === agentGrant.operation
 *       ∧ isEffective(userGrant, now)
 *       ∧ isLatticeScope(userGrant.scope)
 *       ∧ isNarrowerOrEqual(agentGrant.scope, userGrant.scope, ancestry)
 *
 * This is strictly fail-closed: if `agentGrant.scope` is broader than any
 * user grant, the agent grant is EXCLUDED (never widens past the user).
 *
 * @param base       - The underlying GrantSource (DB DAO) for BOTH subjects.
 * @param agentSubject  - The agent actor (employee slug + tenantId).
 * @param userSubject   - The on-behalf-of user (employee slug + tenantId).
 * @param ancestry   - The hierarchy AncestryOracle (injected, pure, no IO).
 */
export function makeIntersectionGrantSource(
  base: GrantSource,
  agentSubject: ResolveSubject,
  userSubject: ResolveSubject,
  ancestry: AncestryOracle,
): GrantSource {
  // Cross-tenant: return empty immediately — no grants cross the tenant wall.
  if (agentSubject.tenantId !== userSubject.tenantId) {
    return {
      async getGrants(_subject: ResolveSubject, _nowMs: number): Promise<Grant[]> {
        return [];
      },
    };
  }

  return {
    async getGrants(subject: ResolveSubject, nowMs: number): Promise<Grant[]> {
      // We resolve BOTH sides in parallel — pure IO efficiency.
      const [agentGrants, userGrants] = await Promise.all([
        base.getGrants(agentSubject, nowMs),
        base.getGrants(userSubject, nowMs),
      ]);

      // Filter to user grants that are currently effective (time-window check).
      // We do NOT filter agentGrants here — the isNarrowerOrEqual check below
      // uses the userGrant scope as the "ceiling"; the agent grant's own
      // effectiveness is already enforced by the PDP (resolveFor step 3).
      const effectiveUserGrants = userGrants.filter((g) => isEffective(g, nowMs));

      // Intersection: keep only agent grants covered by some user grant.
      return agentGrants.filter((agentGrant) =>
        isGrantCoveredByUserGrants(agentGrant, effectiveUserGrants, ancestry),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers (pure, no IO)
// ---------------------------------------------------------------------------

/**
 * Returns true iff agentGrant is "covered by" at least one userGrant.
 *
 * A user grant covers an agent grant when:
 *  1. Same resourceType — so the agent can only read what the user can read.
 *  2. Same operation   — so the agent can only write where the user can write.
 *  3. The user grant scope CONTAINS the agent grant scope (isNarrowerOrEqual
 *     tests whether agentScope ⊑ userScope — "is contained in").
 *
 * Freeform scopes are EXCLUDED from the intersection (fail-closed): a freeform
 * grant is owner-only / non-delegable and has no lattice position, so it can
 * never be structurally compared — it is treated as non-intersecting.
 */
function isGrantCoveredByUserGrants(
  agentGrant: Grant,
  effectiveUserGrants: Grant[],
  ancestry: AncestryOracle,
): boolean {
  // Freeform scopes are not lattice elements — fail-closed, never intersect.
  if (agentGrant.scope.kind === "freeform") return false;

  for (const userGrant of effectiveUserGrants) {
    if (userGrant.resourceType !== agentGrant.resourceType) continue;
    if (userGrant.operation !== agentGrant.operation) continue;
    // User freeform scopes also excluded (non-lattice, non-delegable).
    if (userGrant.scope.kind === "freeform") continue;

    // isNarrowerOrEqual(agentScope, userScope) ≡ agentScope ⊑ userScope
    // = the agent's scope is a subset of (or equal to) the user's scope.
    if (isNarrowerOrEqual(agentGrant.scope, userGrant.scope, ancestry)) {
      return true;
    }
  }
  return false;
}
