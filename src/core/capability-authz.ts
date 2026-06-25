/**
 * src/core/capability-authz.ts — T-0475 [E-AGENTS L4]: capability authorization.
 *
 * Spec: docs/specs/agent-registry-and-llm-keys.spec.md §6.
 *
 * PURE TS — no DB / IO / LLM. The DB-side grant resolution (getGrantsForSubject,
 * the owner lookup, the system-agent existence check) lives in
 * src/db/capability-grants-dao.ts; this module is the decidable PREDICATE over a
 * resolved `Grant[]`, mirroring the existing hasAuthoringDraftGrant predicate
 * pattern (assistant-configurator.ts).
 *
 * WHY A SEPARATE CAPABILITY AXIS (not mgmt_object). The two new grants are NOT
 * org-place / scoped-admin delegations — they are CAPABILITIES that flow from a
 * grant rather than an org node (spec §2 decision 2, §6). Concretely:
 *   - `llm_connection:configure` — author/edit an LLM connection + key. Held by the
 *     genesis owner OR an explicit grantee (e.g. a role-constructor-admin acting
 *     inside the owner-delegated envelope, T-0469).
 *   - `system_agent:operate` — configure/run a SYSTEM agent (configurator /
 *     docs-author / implementation), which builds applications/processes over the
 *     platform. NOT everyone; spec §6 ties it to the configurator's
 *     `authoring_draft` capability (T-0462) — so an authoring_draft holder is, by
 *     construction, allowed to operate a system agent (the configurator IS a
 *     system agent), AND a direct `system_agent:operate` grant also suffices.
 *
 * EMPLOYEE_ID-NULL SYSTEM AGENTS (spec §3/§4, T-0473). A system/assistant agent has
 * `agent_card.employee_id IS NULL` — it has no org position, so its authority can
 * NOT come from an org-place. It comes from CAPABILITY: the HUMAN operator's
 * capability grant authorizes operating the org-less system agent. The check is
 * keyed on the operator's grants, never on the org-less agent's (non-existent)
 * role_assignment. canOperateSystemAgent encodes exactly that.
 *
 * The raw `resourceType` strings are intentionally NOT in the closed
 * grant-lattice ResourceType union (which is org-resource shaped). They are
 * capability tokens stored verbatim in choros."grant".resource_type (free text,
 * no DB CHECK) — same widening-cast precedent as authoring_draft
 * (assistant-configurator.ts AUTHORING_DRAFT_RESOURCE). The predicate matches on
 * the resource_type STRING only, so the closed Operation enum is irrelevant here.
 */

import type { Grant } from "./grant-lattice.js";

// ---------------------------------------------------------------------------
// Capability resource-type tokens (the grant.resource_type strings).
// ---------------------------------------------------------------------------

// The capability tokens are stored verbatim in choros."grant".resource_type
// (free text). The grant-lattice ResourceType union is org-resource shaped and
// does NOT include them, so we declare them as a widening-cast to
// Grant["resourceType"] — the SAME precedent as authoring_draft in
// assistant-configurator.ts (AUTHORING_DRAFT_RESOURCE). The predicates compare on
// the resource_type STRING only, so the closed Operation enum is irrelevant.

/** Grant resource_type for "configure an LLM connection + key" (spec §6). */
export const LLM_CONNECTION_CONFIGURE =
  "llm_connection:configure" as Grant["resourceType"];

/** Grant resource_type for "configure/run a SYSTEM agent" (spec §6). */
export const SYSTEM_AGENT_OPERATE =
  "system_agent:operate" as Grant["resourceType"];

/**
 * Grant resource_type for the configurator's draft authoring capability (T-0462,
 * migration 088 / register.ts). Held by configurators/admins. Spec §6 ties
 * system-agent operation to THIS capability — an authoring_draft holder operates
 * system agents by construction (the configurator IS a system agent).
 */
export const AUTHORING_DRAFT = "authoring_draft" as Grant["resourceType"];

// ---------------------------------------------------------------------------
// Predicates over a resolved Grant[] (already confirmed + in-window — the DAO
// applies confirmed_by IS NOT NULL + the validity window before this predicate).
// ---------------------------------------------------------------------------

/**
 * holdsLlmConnectionConfigure — true iff the resolved grant set contains an
 * effective `llm_connection:configure` grant.
 *
 * The route gate is `isGenesisOwner || holdsLlmConnectionConfigure(grants)` — the
 * owner short-circuit is applied by the caller (the owner is the un-parented
 * delegation root and need not hold the explicit grant). Pure: only inspects
 * resource_type, so the closed Operation enum does not constrain it.
 */
export function holdsLlmConnectionConfigure(grants: readonly Grant[]): boolean {
  return grants.some((g) => g.resourceType === LLM_CONNECTION_CONFIGURE);
}

/**
 * canOperateSystemAgent — true iff the resolved grant set authorizes operating a
 * SYSTEM agent (spec §6).
 *
 * Authority comes from EITHER:
 *   - an explicit `system_agent:operate` grant, OR
 *   - an `authoring_draft` grant (create OR update) — spec §6 ties system-agent
 *     operation to the configurator's authoring_draft capability (T-0462), so an
 *     authoring_draft holder operates system agents by construction.
 *
 * The owner short-circuit (isGenesisOwner) is applied by the caller. This is the
 * capability axis used for `employee_id IS NULL` system agents: it is evaluated
 * against the OPERATOR's grants, never the org-less agent's org-place (which does
 * not exist). A plain tenant member with neither capability gets `false`.
 */
export function canOperateSystemAgent(grants: readonly Grant[]): boolean {
  return grants.some(
    (g) =>
      g.resourceType === SYSTEM_AGENT_OPERATE ||
      (g.resourceType === AUTHORING_DRAFT &&
        (g.operation === "create" || g.operation === "update")),
  );
}
