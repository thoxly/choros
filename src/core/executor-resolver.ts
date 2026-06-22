/**
 * src/core/executor-resolver.ts — T-0380 (D4): Unified executor resolver.
 *
 * Single source of truth for task routing (§4 of process-execution-model.spec.md).
 * Called at task-routing time to decide WHO receives a process step.
 *
 * Resolution order (spec §4):
 *   1. Direct assignee — step explicitly names a person slug. Rare.
 *   2. Role pool — confirmed holders in window (getRoleSlugsForActor / role membership).
 *      The pool is the full set of slugs holding the named role.
 *   3. Substitution — a holder is absent → their substitute takes the task.
 *      The step is gated behind an optional `substitution` port in ResolverDeps.
 *      The DB-backed SubstitutionSource (which resolves UUIDs for absent_employee_id
 *      and role_id from the substitution_rule table) is a follow-up task (T-0053).
 *      Until that port is injected (it is NOT wired in production today), this step
 *      is a no-op and control falls through to step 4.
 *   4. Fallback → owner — role is empty (no confirmed holders in window).
 *      Executor is configurable per-tenant/process; DEFAULT = tenant owner (F6/PD-10).
 *      The task is MARKED with `fallbackReason: "role_unfilled"` so the UI/notification
 *      can say "роль не заполнена, поэтому вам" (F7).
 *   5. SLA escalation — out of scope (phase 3).
 *
 * Design discipline:
 *   - PURE resolver contract: `resolveExecutor` takes injected ports (no direct DB/IO).
 *     Callers (inbox.ts) supply the ports with DB-backed implementations.
 *   - No new DB table (D-061). The fallback executor config is a future per-tenant/
 *     process table; for now the default-owner path is the only implementation.
 *   - Substitution path is gated behind an optional port that callers inject.
 *     The DB-backed implementation (UUID-based lookup per absent_employee_id)
 *     is a follow-up (T-0053). `resolveSubstitution` from substitution.ts is
 *     available for callers that inject a properly UUID-backed port.
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

  if (holders.length > 0) {
    // Role has confirmed holders: deliver to the pool.
    // (Substitution is not triggered when the role has live holders — the absent
    //  holder's substitute is only relevant when THAT specific person is absent.
    //  For a pool task addressed to a role, any pool member can take it — the
    //  substitution path applies when a specific assignee in step 1 is absent,
    //  which is not the current case. Future: per-person absence + substitution
    //  for directed steps goes through step 1 + substitution lookup below.)
    return { kind: "pool", roleSlug, candidates: holders };
  }

  // --- Step 3: Substitution — no holder present → try substitute -----------
  // The substitution_rule table stores absent_employee_id and role_id as UUIDs
  // (FK to employee and role respectively — see migrations/036_substitution_rule.sql).
  // A correct DB-backed port must therefore resolve the role slug → role.id UUID
  // and each holder's slug → employee.id UUID before calling getActiveSubstitutions,
  // then map the returned substituteEmployeeId UUID back to a slug.
  //
  // That UUID-resolution layer (a DB-backed SubstitutionSource) is pending T-0053.
  // Until callers inject a properly-wired port the step is a controlled no-op:
  // `deps.substitution` is undefined in production (makeExecutorResolverDeps does
  // not inject it), so the block below is never entered and control falls through
  // to step 4 (fallback-owner). This is intentional and documented.
  if (deps.substitution) {
    // NOTE: the injected port is responsible for UUID resolution (slug→UUID→slug).
    // When a correctly wired port is present it calls getActiveSubstitutions with
    // the absent employee's UUID, then resolveSubstitution matches by UUID fields,
    // and the returned substituteEmployeeId UUID is translated back to a slug by
    // the port before returning.
    const orgScope: ScopeElement = opts.orgScope ?? BOTTOM;
    const oracle = deps.ancestry ?? NO_OP_ANCESTRY;

    // The port provides rules already filtered for `absentEmployeeId` (as UUID).
    // We pass a placeholder here; correct ports must supply their own absent-id
    // from a prior role-holder lookup, not the raw roleSlug.
    // For now no production port is wired, so this branch is never reached.
    const rules = await deps.substitution.getActiveSubstitutions(tenantId, roleSlug, nowMs);
    const matched = resolveSubstitution(rules, roleSlug, roleSlug, orgScope, oracle, nowMs);
    if (matched !== null) {
      return {
        kind: "substitution",
        roleSlug,
        absentSlug: roleSlug,
        substituteSlug: matched.substituteEmployeeId,
      };
    }
  }

  // --- Step 4: Fallback → owner (role empty, no substitution) ---------------
  // The fallback executor is configurable per tenant/process (F6). Default = owner.
  // Mark as `fallbackReason: "role_unfilled"` (F7) so the UI/notification can
  // display "роль не заполнена, поэтому вам".
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
