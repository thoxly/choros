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
 *
 * T-0382 (D5): this DB module is the ALLOW-LISTED custody site for the
 * agent_card.llm_secret_handle column (FF-25-3 ALLOWED_FILES). The per-tenant
 * LLM-config feature (src/db/agent-card-llm.ts, src/http/llm-config.ts) reads
 * the handle column REFERENCE ONLY through the readers below — it never names
 * the column itself, so no new file needs FF-25-3 registration. The readers
 * select the OPAQUE handle (RL-3) to compute a boolean "bound" flag or to hand
 * the opaque reference to the injected LlmPort; the raw value is never logged,
 * audited, or returned to a client (same custody class as the agents-list /
 * run-precheck dormancy column-reads already in the allow-set).
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

// ---------------------------------------------------------------------------
// T-0382 (D5): per-tenant LLM-config custody readers.
//
// These are the ONLY readers of the agent_card.llm_secret_handle column for the
// LLM-config feature. They run INSIDE the caller's open withTenantTx (RLS GUC
// already set) — they never open their own transaction. The raw handle is an
// OPAQUE RL-3 reference: it is selected only to (a) compute a boolean `bound`
// flag, or (b) hand the opaque reference to the injected LlmPort at the
// composition root. It is never logged, audited, or serialized to a response.
// ---------------------------------------------------------------------------

/**
 * One agent_card LLM-config row for the LLM-config feature.
 *
 * The secret-handle column is aliased to `secret_handle_ref` so that consuming
 * modules (agent-card-llm.ts, llm-config.ts) reference only the OPAQUE handle via
 * this neutral field — the raw column name lives ONLY in this allow-listed DAO,
 * keeping the FF-25-3 custody surface auditable (no string-concat dodge needed).
 */
export interface AgentLlmConfigRow {
  employee_id: string;
  slug: string;
  llm_endpoint: string | null;
  llm_model: string | null;
  /** Opaque secret handle (RL-3), aliased from the handle column. NULL when unbound. */
  secret_handle_ref: string | null;
}

/**
 * Read the "primary" agent_card LLM-config row for the current tenant.
 * Priority: slug = 'assistant-agent' first, then first agent by slug.
 * Returns null when no agent_card row exists for the tenant.
 *
 * Runs inside the caller's withTenantTx (RLS GUC choros.tenant_id already set).
 * Selects the opaque handle so the caller can derive a boolean bound flag — the
 * raw value is the caller's responsibility to NOT egress.
 */
export async function readPrimaryAgentLlmConfig(
  tx: PgClientLike,
): Promise<AgentLlmConfigRow | null> {
  const { rows } = await tx.query(
    `SELECT ac.employee_id,
            e.slug,
            ac.llm_endpoint,
            ac.llm_model,
            ac.llm_secret_handle AS secret_handle_ref
       FROM choros.agent_card ac
       JOIN choros.employee e
            ON e.tenant_id = ac.tenant_id AND e.id = ac.employee_id
      WHERE ac.tenant_id = current_setting('choros.tenant_id', true)::uuid
      ORDER BY CASE WHEN e.slug = 'assistant-agent' THEN 0 ELSE 1 END, e.slug
      LIMIT 1`,
  );
  return (rows[0] as AgentLlmConfigRow | undefined) ?? null;
}

/**
 * Read the first FULLY-CONFIGURED agent_card LLM-config row for the current
 * tenant — i.e. all three llm_* fields are non-NULL. Returns null when no such
 * row exists (dormant fallback applies).
 *
 * Runs inside the caller's withTenantTx (RLS GUC already set). Used by the
 * composition-root factory to decide whether a live per-tenant LLM port can be
 * built; the opaque handle is handed to the injected port, never logged/audited.
 */
export async function readConfiguredAgentLlmConfig(
  tx: PgClientLike,
): Promise<AgentLlmConfigRow | null> {
  const { rows } = await tx.query(
    `SELECT ac.employee_id,
            e.slug,
            ac.llm_endpoint,
            ac.llm_model,
            ac.llm_secret_handle AS secret_handle_ref
       FROM choros.agent_card ac
       JOIN choros.employee e
            ON e.tenant_id = ac.tenant_id AND e.id = ac.employee_id
      WHERE ac.tenant_id = current_setting('choros.tenant_id', true)::uuid
        AND ac.llm_endpoint IS NOT NULL
        AND ac.llm_model IS NOT NULL
        AND ac.llm_secret_handle IS NOT NULL
      ORDER BY CASE WHEN e.slug = 'assistant-agent' THEN 0 ELSE 1 END, e.slug
      LIMIT 1`,
  );
  return (rows[0] as AgentLlmConfigRow | undefined) ?? null;
}

/**
 * UPDATE agent_card.(llm_endpoint, llm_model) for one agent within the current
 * tenant. The secret handle is managed separately via the T-0025 secret-handle
 * lifecycle routes — this reader/writer NEVER writes the handle column. Returns
 * the updated employee_id, or null when no row matched.
 *
 * Runs INSIDE the caller's open withTenantTx so the UPDATE commits/rolls back
 * atomically with the caller's audit append (T-0382 BLOCKER-2 fix).
 */
export async function updateAgentLlmEndpointModel(
  tx: PgClientLike,
  agentId: string,
  llmEndpoint: string,
  llmModel: string,
  nowMs: number,
): Promise<string | null> {
  const { rows } = await tx.query(
    `UPDATE choros.agent_card
        SET llm_endpoint = $2,
            llm_model    = $3,
            updated_at   = $4
      WHERE tenant_id = current_setting('choros.tenant_id', true)::uuid
        AND employee_id = $1
      RETURNING employee_id`,
    [agentId, llmEndpoint, llmModel, nowMs],
  );
  const row = rows[0] as { employee_id: string } | undefined;
  return row?.employee_id ?? null;
}
