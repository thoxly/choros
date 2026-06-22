/**
 * src/db/agent-card-llm.ts — T-0382 (D5): per-tenant LLM config reader.
 *
 * Reads agent_card.(llm_endpoint, llm_model, llm_secret_handle) for the
 * SYSTEM assistant agent ("assistant-agent" slug or by card primary key).
 *
 * This is the ONLY module that bridges the DB agent_card LLM fields to the
 * composition root (src/server.ts). It belongs in src/db/ so no core module
 * needs to import it (NF-1: no process.env in core; FF-LP-1: no SDK in core).
 *
 * Security invariants:
 *   - llm_secret_handle is an opaque handle (never a raw key; see RL-3 / T-0025).
 *   - The value is read ONLY at factory call time (not at startup) so stale env
 *     values do not shadow live DB config that the tenant has updated.
 *   - If the DB row is absent or all three fields are NULL, we return null so
 *     the caller falls back to the global env config (backward-compatible).
 *
 * Called from: src/server.ts makeLlmPortFactory (composition root only).
 */

import pg from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-tenant LLM config read from agent_card.
 * All three fields must be non-null for the config to be considered "live".
 * If any is null the config is treated as absent (dormant fallback applies).
 */
export interface TenantLlmConfig {
  llm_endpoint: string;
  llm_model: string;
  llm_secret_handle: string;
}

// ---------------------------------------------------------------------------
// withTenantTx — local helper (same pattern as other db/*.ts modules)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function withTenantReadTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`[T-0382] Invalid tenantId shape: ${tenantId}`);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// loadTenantLlmConfig
// ---------------------------------------------------------------------------

/**
 * Read the first agent_card row for the given tenant that has all three
 * LLM fields set (non-null).  The "first" row is the assistant agent row
 * (slug "assistant-agent") if present, otherwise the first configured agent.
 *
 * Returns null when no configured agent_card row exists for the tenant, or
 * when the pool is null (no-DB mode — honest degrade to global env fallback).
 *
 * CALLER MUST: validate the returned handle via validateSecretHandleShape
 * before passing to OpenAILlmPort (done in makeLlmPortFactory in server.ts).
 */
export async function loadTenantLlmConfig(
  pool: pg.Pool | null,
  tenantId: string,
): Promise<TenantLlmConfig | null> {
  if (!pool) return null;

  try {
    return await withTenantReadTx(pool, tenantId, async (client) => {
      const { rows } = await client.query<{
        llm_endpoint: string | null;
        llm_model: string | null;
        llm_secret_handle: string | null;
      }>(
        `SELECT ac.llm_endpoint, ac.llm_model, ac.llm_secret_handle
           FROM choros.agent_card ac
           JOIN choros.employee e
                ON e.tenant_id = ac.tenant_id AND e.id = ac.employee_id
          WHERE ac.tenant_id = current_setting('choros.tenant_id', true)::uuid
            AND ac.llm_endpoint IS NOT NULL
            AND ac.llm_model IS NOT NULL
            AND ac.llm_secret_handle IS NOT NULL
          ORDER BY
            CASE WHEN e.slug = 'assistant-agent' THEN 0 ELSE 1 END,
            e.slug
          LIMIT 1`,
      );

      const row = rows[0];
      if (
        !row ||
        row.llm_endpoint === null ||
        row.llm_model === null ||
        row.llm_secret_handle === null
      ) {
        return null;
      }

      return {
        llm_endpoint: row.llm_endpoint,
        llm_model: row.llm_model,
        llm_secret_handle: row.llm_secret_handle,
      };
    });
  } catch {
    // DB failure → fall back to global env config (honest degrade, not crash).
    return null;
  }
}

// ---------------------------------------------------------------------------
// saveTenantLlmConfig — used by the LLM-config HTTP route (T-0382)
// ---------------------------------------------------------------------------

/**
 * Update agent_card.(llm_endpoint, llm_model) for a specific agent within a
 * tenant.  The secret handle is managed separately via the existing
 * /api/agents/:id/secret-handle routes (T-0025 lifecycle; not stored raw here).
 *
 * Called only from src/http/llm-config.ts — NOT from core or adapters.
 *
 * Upsert strategy: UPDATE the row; if rowCount=0, the agent_card row does not
 * exist yet (should not happen for seeded agents, but fail-safe to 404).
 */
export async function saveTenantLlmEndpointModel(
  pool: pg.Pool,
  tenantId: string,
  agentId: string,
  llmEndpoint: string,
  llmModel: string,
): Promise<boolean> {
  return withTenantReadTx(pool, tenantId, async (client) => {
    const nowMs = Date.now();
    const r = await client.query(
      `UPDATE choros.agent_card
          SET llm_endpoint = $2,
              llm_model    = $3,
              updated_at   = $4
        WHERE tenant_id = current_setting('choros.tenant_id', true)::uuid
          AND employee_id = $1
        RETURNING employee_id`,
      [agentId, llmEndpoint, llmModel, nowMs],
    );
    return (r.rowCount ?? 0) > 0;
  });
}
