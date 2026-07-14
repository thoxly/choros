/**
 * src/core/agent-mgmt-authority.ts — T-0645 [SECURITY]: the SINGLE shared
 * `holdsAgentMgmtUpdate` authority predicate.
 *
 * Administration is NOT a subsystem — it is the pattern "hold a delegable,
 * confirmed, in-window `mgmt_object:agent`/`update` grant covering the agent's
 * org scope" (T-0029 §2). This module is the ONE definition of that predicate so
 * the agent-management write path (`PUT /api/agents/:id/instruction` — saveDraft)
 * and the agent-instruction PROMOTE path (`POST /api/artifacts/:id/promote` with
 * `artifact_table='agent_instruction'`) gate on the SAME resolver — closing the
 * T-0637 privilege-escalation asymmetry where publishing an agent instruction (the
 * live LLM system prompt) required a WEAKER right than saving its draft.
 *
 * Pure: it owns NO lattice math (delegates to the frozen `isNarrowerOrEqual`) and
 * reads NO IO. `isGenesisOwner` is an INJECTED boolean on `AdminContext` (never
 * derived here). Callers pass the agent's org scope + a tenant `AncestryOracle`.
 *
 * NOTE (unify, don't fork — memory: choros authority-resolvers are multiple): the
 * older per-file copies in secret-handle.ts / llm-config.ts / assistant-prompt-routes.ts
 * are byte-identical to this predicate; they can be migrated to this module in a
 * follow-up. This task points the saveDraft + promote pair (the asymmetry) at ONE
 * resolver and adds no new bespoke check.
 */

import { isNarrowerOrEqual, type ScopeElement, type AncestryOracle } from "./grant-lattice.js";
import type { AdminContext } from "./scoped-admin.js";

/**
 * True iff `admin` is the genesis owner OR holds a confirmed, in-window,
 * DELEGABLE `mgmt_object:agent` / `update` grant whose scope covers
 * `agentOrgScope` (`isNarrowerOrEqual(agentOrgScope, grant.scope)`).
 *
 * Fail-closed: a plain member with neither → false.
 */
export function holdsAgentMgmtUpdate(
  admin: AdminContext,
  agentOrgScope: ScopeElement,
  oracle: AncestryOracle,
): boolean {
  if (admin.isGenesisOwner) return true;
  return admin.adminGrants.some(
    (g) =>
      g.resourceType === "mgmt_object:agent" &&
      g.operation === "update" &&
      g.delegable &&
      isNarrowerOrEqual(agentOrgScope, g.scope as ScopeElement, oracle),
  );
}
