/**
 * src/core/executor-resolver.ts — T-0380/T-0429 (D4): Unified executor resolver.
 *
 * Single source of truth for task routing (§4 of process-execution-model.spec.md).
 * Called at task-routing time to decide WHO receives a process step.
 *
 * Resolution ladder (spec §4 / T-0429 ladder fix):
 *
 *   1. Direct assignee — step explicitly names a person slug. Rare; short-circuits
 *      everything else.
 *
 *   2. Role pool — confirmed holders in window. Returns the raw holder set.
 *
 *   3. Substitution — PER-HOLDER absence check (T-0429 fix):
 *      For each holder in the pool, check if they have an active substitution rule
 *      (they are declared absent). If yes: SUPPRESS the absent holder, ADD their
 *      substitute to the effective pool. This is the "suppress-absent + add-substitute"
 *      operation. Chain substitutions (a substitute is also absent) are followed up
 *      to MAX_SUBSTITUTION_HOPS hops (carried by the injected port).
 *
 *      "absent" ≠ "unfilled" — these are DIFFERENT ladder rungs:
 *        - "absent" (rung 3): a KNOWN holder has a substitution_rule → route via rule
 *        - "unfilled" (rung 4): the role has NO holders at all → route to owner + F7
 *
 *      The step is gated behind an optional `substitution` port in ResolverDeps.
 *      When absent, this step is a no-op (production default until T-0429 wires it).
 *
 *   4. Fallback → owner — effective pool is empty (role unfilled or all holders absent
 *      with no substitute). Executor = tenant owner (F6/PD-10). Marked
 *      `fallbackReason: "role_unfilled"` (F7) so the UI can say "роль не заполнена".
 *
 *   5. SLA escalation — out of scope (phase 3, D rejected).
 *
 * Design discipline:
 *   - PURE resolver contract: `resolveExecutor` takes injected ports (no direct DB/IO).
 *     Callers (inbox.ts) supply the ports with DB-backed implementations.
 *   - No new DB table (D-061). The fallback executor config is a future per-tenant/
 *     process table; for now the default-owner path is the only implementation.
 *   - Substitution port is optional. When absent, the ladder falls through to step 4.
 *     Production wiring: makeExecutorResolverDeps in inbox.ts injects the DB-backed
 *     port (substitution-dao.ts). Older callers without substitution skip step 3.
 *
 * Fallback marking (F7): when the resolver falls back to owner, the returned
 * `ExecutorResolution` carries `fallbackReason: "role_unfilled"`. The inbox
 * item gains an optional `routed_to_fallback` wire field so the UI/notification
 * can display "роль не заполнена, поэтому вам".
 */

import {
  resolveSubstitution,
  type SubstitutionRule,
} from "./substitution.js";
import { BOTTOM, type AncestryOracle, type ScopeElement } from "./grant-lattice.js";

// ---------------------------------------------------------------------------
// ExecutorResolution — the result of resolving a step's executor
// ---------------------------------------------------------------------------

/** Why was the fallback executor selected? Currently only "role_unfilled". */
export type FallbackReason = "role_unfilled";

/**
 * The resolution result:
 *   - `kind: "pool"` — deliver to the role pool (one or more slugs hold the role).
 *     `candidates` is the full set of role holders.
 *   - `kind: "substitution"` — a holder is absent; `substituteSlug` takes the task.
 *   - `kind: "direct"` — step named a specific person (`directSlug`).
 *   - `kind: "fallback"` — role empty; route to `fallbackSlug` (default = owner).
 *     Always carries `fallbackReason: "role_unfilled"` (F7).
 *   - `kind: "unresolvable"` — role empty AND no owner found (e.g. fresh tenant).
 *     Callers should surface this as an incident.
 */
export type ExecutorResolution =
  | { kind: "pool"; roleSlug: string; candidates: readonly string[] }
  | { kind: "substitution"; roleSlug: string; absentSlug: string; substituteSlug: string }
  | { kind: "direct"; directSlug: string }
  | { kind: "fallback"; roleSlug: string; fallbackSlug: string; fallbackReason: FallbackReason }
  | { kind: "unresolvable"; roleSlug: string; fallbackReason: FallbackReason };

// ---------------------------------------------------------------------------
// Port interfaces — injected by callers; never imported directly from DB here.
// ---------------------------------------------------------------------------

/**
 * Port: returns the confirmed, in-window slugs of employees holding `roleSlug`
 * within `tenantId` at `nowMs`. Returns [] when the role has no confirmed holders.
 *
 * Implemented in production by querying role_assignment JOIN employee via
 * grants-dao.ts; implemented in tests by a pure in-memory stub.
 */
export interface RoleHolderSource {
  getHoldersForRole(
    tenantId: string,
    roleSlug: string,
    nowMs: number,
  ): Promise<readonly string[]>;
}

/**
 * Port: returns the substitution rules for an absent employee (forwarded to
 * `resolveSubstitution`). The default wiring passes through SubstitutionSource
 * from substitution.ts (getActiveSubstitutions).
 */
export interface ExecutorSubstitutionPort {
  getActiveSubstitutions(
    tenantId: string,
    absentEmployeeId: string,
    nowMs: number,
  ): Promise<SubstitutionRule[]>;
}

/**
 * Port: returns the tenant fallback executor slug (F6). When a per-tenant/process
 * config table exists in the future, this port is backed by it. For now the
 * production implementation calls `findTenantOwnerSlug` (grants-dao.ts) and
 * returns null when no owner is found (unresolvable).
 *
 * Configurable means: callers can inject a custom resolver (e.g. per-process config).
 * The default production wiring uses `makeTenantOwnerFallbackPort`.
 */
export interface FallbackExecutorPort {
  /**
   * Resolve the fallback executor slug for this tenant/process.
   * Returns null when no fallback is configured (e.g. brand-new tenant with no owner).
   */
  resolveFallbackSlug(tenantId: string, procKey?: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// ResolverDeps — the injected dependency bundle for `resolveExecutor`.
// ---------------------------------------------------------------------------

export interface ResolverDeps {
  /** Port: role holders (DB-backed or in-memory fixture). */
  readonly roleHolders: RoleHolderSource;
  /** Port: substitution rules. When absent, substitution step is skipped. */
  readonly substitution?: ExecutorSubstitutionPort;
  /** Port: fallback executor (tenant owner or per-process config). When absent, falls back to unresolvable. */
  readonly fallback?: FallbackExecutorPort;
  /**
   * Injected AncestryOracle for `resolveSubstitution` scope containment check.
   * When absent, a no-op oracle is used (all scopes are considered valid — safe for
   * single-org tenants where org-scope is always root).
   */
  readonly ancestry?: AncestryOracle;
}

// ---------------------------------------------------------------------------
// No-op AncestryOracle (single-org tenants / tests without org hierarchy)
// ---------------------------------------------------------------------------

const NO_OP_ANCESTRY: AncestryOracle = {
  isDescendantOrSelf(_hierarchy, descendantId, ancestorId) {
    // When no hierarchy oracle is provided, treat every scope as contained in every
    // other scope (single-tenant / root-scope model). This is safe for tenants that
    // have not yet configured an org hierarchy.
    return descendantId === ancestorId;
  },
};

// ---------------------------------------------------------------------------
// resolveExecutor — the single resolver entry point (spec §4)
// ---------------------------------------------------------------------------

/**
 * Resolve the executor(s) for a process step.
 *
 * @param tenantId  - the tenant the process belongs to
 * @param roleSlug  - the role the step is addressed to (candidateGroups, from BPMN)
 * @param nowMs     - the current wall-clock instant (for validity-window checks)
 * @param deps      - injected ports (DB-backed in production, in-memory in tests)
 * @param opts.directSlug - when the step explicitly names a person, pass their slug
 *                          here; the resolver short-circuits to `kind: "direct"`.
 * @param opts.orgScope   - the org-scope of the step (for substitution containment).
 *                          When absent, a root scope is assumed.
 * @param opts.procKey    - the process key (for configurable fallback per process).
 */
export async function resolveExecutor(
  tenantId: string,
  roleSlug: string,
  nowMs: number,
  deps: ResolverDeps,
  opts: {
    directSlug?: string;
    orgScope?: ScopeElement;
    procKey?: string;
  } = {},
): Promise<ExecutorResolution> {
  // --- Step 1: Direct assignee (rare — step explicitly names a person) ------
  if (opts.directSlug) {
    return { kind: "direct", directSlug: opts.directSlug };
  }

  // --- Step 2: Role pool — confirmed holders in window ----------------------
  const holders = await deps.roleHolders.getHoldersForRole(tenantId, roleSlug, nowMs);

  // --- Step 3: Substitution — per-holder absence check (T-0429 лесенка fix) --
  //
  // "absent" ≠ "unfilled" — these are DIFFERENT rungs:
  //   absent  (rung 3): a KNOWN holder has a substitution_rule → suppress, add substitute
  //   unfilled (rung 4): the role has NO holders at all → fallback owner + F7 marking
  //
  // For each holder in the pool: check if they have an active substitution rule.
  // If yes: suppress that holder, add their substitute to the effective set.
  // If no rules are active for any holder: pool is unchanged.
  //
  // The substitution port handles UUID↔slug resolution (DB DAO in substitution-dao.ts).
  // When the port is absent, this step is a no-op and the raw holder set proceeds.
  //
  // Chain substitutions (a substitute is also absent) are resolved by the port;
  // the port enforces MAX_SUBSTITUTION_HOPS to prevent cycles.
  if (deps.substitution && holders.length > 0) {
    const orgScope: ScopeElement = opts.orgScope ?? BOTTOM;
    const oracle = deps.ancestry ?? NO_OP_ANCESTRY;

    // Build the effective pool: suppress absent holders, add their substitutes.
    const effectivePool = new Set<string>(holders);
    let firstSubstitution: { absentSlug: string; substituteSlug: string } | null = null;

    for (const holderSlug of holders) {
      // Query the port for active substitution rules where this holder is absent.
      const rules = await deps.substitution.getActiveSubstitutions(tenantId, holderSlug, nowMs);
      // resolveSubstitution: first effective rule where absent=holderSlug, role=roleSlug,
      // orgScope ⊑ rule.orgScope (i.e. the task's org-scope is covered by the rule's scope).
      const matched = resolveSubstitution(rules, holderSlug, roleSlug, orgScope, oracle, nowMs);
      if (matched !== null) {
        // Suppress the absent holder; add their substitute.
        effectivePool.delete(holderSlug);
        effectivePool.add(matched.substituteEmployeeId);
        // Record the first substitution for the "substitution" kind result.
        if (firstSubstitution === null) {
          firstSubstitution = {
            absentSlug: holderSlug,
            substituteSlug: matched.substituteEmployeeId,
          };
        }
      }
    }

    // If any substitution was applied AND there is exactly one absent→substitute
    // mapping (common single-holder case), return kind: "substitution".
    // For multi-holder pools with partial substitutions, return kind: "pool"
    // with the effective (substituted) candidate set.
    if (firstSubstitution !== null) {
      const effectiveCandidates = [...effectivePool];
      if (effectiveCandidates.length === 1 && firstSubstitution.substituteSlug === effectiveCandidates[0]) {
        // Single substitution: canonical "substitution" result.
        return {
          kind: "substitution",
          roleSlug,
          absentSlug: firstSubstitution.absentSlug,
          substituteSlug: firstSubstitution.substituteSlug,
        };
      }
      if (effectiveCandidates.length > 0) {
        // Mixed pool: some holders present, some substituted. Return as pool.
        return { kind: "pool", roleSlug, candidates: effectiveCandidates };
      }
      // All holders absent with no substitutes → fall through to fallback (step 4).
    } else if (holders.length > 0) {
      // No substitution rules active → return pool unchanged.
      return { kind: "pool", roleSlug, candidates: holders };
    }
  } else if (holders.length > 0) {
    // No substitution port injected — pool path (substitution step skipped).
    return { kind: "pool", roleSlug, candidates: holders };
  }

  // --- Step 4: Fallback → owner (effective pool empty, role unfilled) -------
  // "role_unfilled" covers both:
  //   (a) role has no holders (never filled), and
  //   (b) all holders are absent with no active substitutes (all suppressed).
  // In both cases route to owner (F6) and mark F7 so UI says "роль не заполнена".
  if (deps.fallback) {
    const fallbackSlug = await deps.fallback.resolveFallbackSlug(tenantId, opts.procKey);
    if (fallbackSlug !== null) {
      return {
        kind: "fallback",
        roleSlug,
        fallbackSlug,
        fallbackReason: "role_unfilled",
      };
    }
  }

  // No fallback configured / no owner found → unresolvable.
  return { kind: "unresolvable", roleSlug, fallbackReason: "role_unfilled" };
}

// ---------------------------------------------------------------------------
// makeInMemoryRoleHolderSource — pure in-memory stub (tests / dev)
// ---------------------------------------------------------------------------

/**
 * Creates a pure in-memory RoleHolderSource over a fixed mapping
 * `{ [roleSlug]: string[] }`. Used in unit tests without a live DB.
 */
export function makeInMemoryRoleHolderSource(
  holderMap: Record<string, readonly string[]>,
): RoleHolderSource {
  return {
    async getHoldersForRole(
      _tenantId: string,
      roleSlug: string,
      _nowMs: number,
    ): Promise<readonly string[]> {
      return holderMap[roleSlug] ?? [];
    },
  };
}

/**
 * Creates a pure in-memory FallbackExecutorPort over a fixed owner slug.
 * Used in unit tests without a live DB.
 */
export function makeInMemoryFallbackPort(
  ownerSlug: string | null,
): FallbackExecutorPort {
  return {
    async resolveFallbackSlug(_tenantId: string, _procKey?: string): Promise<string | null> {
      return ownerSlug;
    },
  };
}

// ---------------------------------------------------------------------------
// makeTenantOwnerFallbackPort — production wiring for F6 default-owner fallback
// ---------------------------------------------------------------------------

/**
 * Production FallbackExecutorPort: resolves the fallback executor slug as the
 * tenant owner. Backed by `findTenantOwnerSlug` from grants-dao.ts.
 *
 * Import: callers (inbox.ts) import this factory and inject the pool.
 * This factory is kept in executor-resolver.ts (not grants-dao.ts) so the
 * resolver contract stays co-located with the port interface.
 *
 * Per-tenant/process override config is a future follow-up (no new table yet —
 * D-061); extend this port's implementation when config is available.
 */
export function makeTenantOwnerFallbackPort(
  findOwnerSlug: (tenantId: string, nowMs: number) => Promise<string | null>,
): FallbackExecutorPort {
  return {
    async resolveFallbackSlug(tenantId: string, _procKey?: string): Promise<string | null> {
      return findOwnerSlug(tenantId, Date.now());
    },
  };
}

// ---------------------------------------------------------------------------
// makeDbRoleHolderSource — production wiring backed by grants-dao.ts
// ---------------------------------------------------------------------------

/**
 * Production RoleHolderSource: returns the confirmed, in-window employee slugs
 * that hold `roleSlug` in `tenantId` at `nowMs`.
 *
 * Backed by a raw SQL query (mirrors getRoleSlugsForActor but in the OTHER
 * direction: given a ROLE, find its holders). Callers inject `queryHolders`
 * to keep this module free from direct pg imports.
 */
export function makeDbRoleHolderSource(
  queryHolders: (tenantId: string, roleSlug: string, nowMs: number) => Promise<string[]>,
): RoleHolderSource {
  return {
    async getHoldersForRole(
      tenantId: string,
      roleSlug: string,
      nowMs: number,
    ): Promise<readonly string[]> {
      return queryHolders(tenantId, roleSlug, nowMs);
    },
  };
}
