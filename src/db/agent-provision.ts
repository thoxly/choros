/**
 * src/db/agent-provision.ts — T-0042 (E5.2): Agent provisioning DB DAO.
 *
 * insertAgentRows — runs INSIDE the caller's open withTenantTx transaction.
 * Does NOT open its own BEGIN/COMMIT (mirrors the grants.ts DAO pattern).
 * tenant_id leads every INSERT (T-0013 invariant).
 *
 * A UNIQUE violation (pg error code 23505) on (tenant_id, kc_client_id) or
 * (tenant_id, slug) surfaces as a typed "client_id_conflict" error which the
 * route handler maps to HTTP 409 (AC-12).
 */

import type { PgClientLike } from "./audit-writer.js";
import type { AgentHirePlan } from "../core/agent-hire.js";

// ---------------------------------------------------------------------------
// Typed conflict error (AC-12)
// ---------------------------------------------------------------------------

export class AgentConflictError extends Error {
  readonly code = "client_id_conflict" as const;
  constructor(detail: string) {
    super(`agent hire conflict: ${detail}`);
    this.name = "AgentConflictError";
  }
}

// ---------------------------------------------------------------------------
// insertAgentRows — the DAO
// ---------------------------------------------------------------------------

/**
 * Insert employee (kind='agent') + agent_card rows inside the caller's tx.
 * Both INSERTs share one transaction: audit + DB rows are atomic (FR-2, NF-4).
 *
 * tenant_id leads both INSERTs (T-0013 RLS invariant).
 * Throws AgentConflictError on UNIQUE violation (AC-12).
 */
export async function insertAgentRows(
  tx: PgClientLike,
  plan: AgentHirePlan,
): Promise<void> {
  const { employee, agentCard } = plan;

  try {
    // INSERT employee row (kind='agent') — migration 016 schema.
    await tx.query(
      `INSERT INTO choros.employee
         (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        employee.tenantId,
        employee.id,
        employee.positionId,
        employee.kind,
        employee.slug,
        employee.displayName,
        employee.createdAt,
        employee.updatedAt,
      ],
    );

    // INSERT agent_card row — migration 032 schema.
    // kc_client_id is UNIQUE per (tenant_id, kc_client_id) — conflict → 23505.
    await tx.query(
      `INSERT INTO choros.agent_card
         (tenant_id, employee_id, employee_kind, kc_client_id,
          llm_endpoint, llm_model, llm_secret_handle, autonomy_threshold,
          budget_policy_id, escalation_rule_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        agentCard.tenantId,
        agentCard.employeeId,
        agentCard.employeeKind,
        agentCard.kcClientId,
        agentCard.llmEndpoint,
        agentCard.llmModel,
        agentCard.llmSecretHandle,
        agentCard.autonomyThreshold,
        agentCard.budgetPolicyId,
        agentCard.escalationRuleId,
        agentCard.createdAt,
        agentCard.updatedAt,
      ],
    );
  } catch (err) {
    // pg UNIQUE violation: code '23505'
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "23505"
    ) {
      throw new AgentConflictError(
        `kc_client_id=${agentCard.kcClientId} or slug=${employee.slug} already exists in tenant ${employee.tenantId}`,
      );
    }
    throw err;
  }
}
