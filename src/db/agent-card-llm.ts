/**
 * src/db/agent-card-llm.ts — T-0382 (D5): per-tenant LLM config reader.
 *
 * Reads agent_card LLM config (endpoint, model, opaque handle) for the tenant's
 * primary assistant agent ("assistant-agent" slug, falling back to first agent).
 *
 * This module bridges the DB agent_card LLM fields to the composition root
 * (src/server.ts). It belongs in src/db/ so no core module needs to import it
 * (NF-1: no process.env in core; FF-LP-1: no SDK in core).
 *
 * SECRET-HANDLE CUSTODY (T-0382 MAJOR-3 fix):
 *   The agent_card secret-handle column is read EXCLUSIVELY through the
 *   allow-listed custody DAO src/db/agent-provision.ts (FF-25-3 ALLOWED_FILES),
 *   which aliases it to the neutral field `secret_handle_ref`. This module NEVER
 *   names the column — it calls readConfiguredAgentLlmConfig, which keeps the
 *   custody surface audited by FF-25-3 (no string-concat dodge, no new
 *   unregistered custody site).
 *
 * Security invariants:
 *   - The opaque secret handle is returned as `secretHandle` (RL-3 custody).
 *   - The value is read ONLY at factory call time (not at startup) so stale env
 *     values do not shadow live DB config that the tenant has updated.
 *   - If the DB row is absent or all three fields are NULL, we return null so
 *     the caller falls back to the global env config (backward-compatible).
 *
 * Called from: src/server.ts makeLlmPortFactory (composition root only).
 */

import pg from "pg";
import type { PgClientLike } from "./audit-writer.js";
import { readConfiguredAgentLlmConfig } from "./agent-provision.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-tenant LLM config read from agent_card.
 * All three fields must be non-null for the config to be considered "live".
 * If any is null the config is treated as absent (dormant fallback applies).
 */
export interface TenantLlmConfig {
  /** agent_card.llm_endpoint */
  llmEndpoint: string;
  /** agent_card.llm_model */
  llmModel: string;
  /** agent_card opaque secret handle — RL-3: opaque reference only, never raw. */
  secretHandle: string;
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
 * CALLER MUST: validate the returned secretHandle via validateSecretHandleShape
 * before passing to OpenAILlmPort (done in makeLlmPortFactory in server.ts).
 *
 * The handle column itself is read by the allow-listed custody DAO
 * (readConfiguredAgentLlmConfig in agent-provision.ts) — this module only sees
 * the opaque value via the row's typed field, never the column name.
 */
export async function loadTenantLlmConfig(
  pool: pg.Pool | null,
  tenantId: string,
): Promise<TenantLlmConfig | null> {
  if (!pool) return null;

  try {
    return await withTenantReadTx(pool, tenantId, async (client) => {
      const row = await readConfiguredAgentLlmConfig(client as unknown as PgClientLike);
      if (
        !row ||
        row.llm_endpoint === null ||
        row.llm_model === null ||
        row.secret_handle_ref === null
      ) {
        return null;
      }
      return {
        llmEndpoint: row.llm_endpoint,
        llmModel: row.llm_model,
        secretHandle: row.secret_handle_ref,
      };
    });
  } catch {
    // DB failure → fall back to global env config (honest degrade, not crash).
    return null;
  }
}
