/**
 * src/db/agent-llm-connection-dao.ts — T-0498 [E-AGENTS]
 *
 * Tiny DAO for the BYO-LLM keystone wiring: point an agent_card row at a NAMED
 * llm_connection profile (agent_card.llm_connection_id, migration 094) — or
 * detach it (NULL → the agent falls back to its DEPRECATED inline columns, and
 * dormant/inline-fallback if those are unset too).
 *
 * Runs INSIDE the caller's open tenant-scoped tx (SET LOCAL choros.tenant_id +
 * FORCE RLS) — it does NOT open its own BEGIN/COMMIT (same convention as
 * agent-provision.ts / llm-connection-dao.ts). The UPDATE additionally carries an
 * explicit `WHERE tenant_id = $1` BYPASSRLS double-predicate guard (T-0184) on
 * TOP of RLS, so the row is pinned to the caller's tenant.
 *
 * SECRET CUSTODY: this DAO writes ONLY the connection-id FK. It never reads,
 * writes, or returns any secret handle / raw key (the handle lives on the
 * llm_connection row; resolving it is the provision/runtime path's concern).
 *
 * The addressing key mirrors the secret-handle route: the agent is keyed by its
 * agent_card.employee_id (the historical workforce-agent key). Returns the
 * matched employee_id, or null when no row matched in this tenant (→ 404).
 */

import type { PgClientLike } from "./audit-writer.js";

/**
 * Set (or clear, when connectionId is null) agent_card.llm_connection_id for one
 * agent within the current tenant, addressed by employee_id.
 *
 * Runs inside the caller's open tenant-scoped tx. Returns the updated employee_id,
 * or null when no agent_card row matched (caller maps null → 404 AGENT_NOT_FOUND).
 *
 * The composite FK (tenant_id, llm_connection_id) → llm_connection(tenant_id, id)
 * is itself tenant-scoped (migration 094): a cross-tenant connectionId can never
 * satisfy it. The route ALSO performs an explicit in-tenant existence check before
 * calling this, so a cross-tenant / missing connection is rejected with a clean
 * 400 rather than surfacing as a raw FK violation.
 */
export async function setAgentLlmConnection(
  tx: PgClientLike,
  agentEmployeeId: string,
  connectionId: string | null,
  nowMs: number,
): Promise<string | null> {
  const { rows } = await tx.query(
    `UPDATE choros.agent_card
        SET llm_connection_id = $2,
            updated_at        = $3
      WHERE tenant_id = current_setting('choros.tenant_id', true)::uuid
        AND employee_id = $1
      RETURNING employee_id`,
    [agentEmployeeId, connectionId, nowMs],
  );
  const row = rows[0] as { employee_id: string } | undefined;
  return row?.employee_id ?? null;
}
