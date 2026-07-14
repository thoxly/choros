/**
 * src/db/capability-grants-dao.ts — T-0475 [E-AGENTS L4]: DB resolvers for the
 * capability-authz checks (spec §6).
 *
 * THIN composition over the EXISTING grant machinery — no new resolution path,
 * no new table:
 *   - getGrantsForSubject (grants-dao.ts) → the actor's CONFIRMED, in-window
 *     Grant[] (the DAO already applies confirmed_by IS NOT NULL + the validity
 *     window). The capability predicates in core/capability-authz.ts run over it.
 *   - isGenesisOwnerForTenant (org.ts) → the owner short-circuit (owner is the
 *     un-parented delegation root, need not hold the explicit grant).
 *   - isOrglessSystemAgent → proves a target agent_card row is a SYSTEM/ASSISTANT
 *     agent WITH employee_id IS NULL (T-0473 taxonomy). This is the
 *     capability-not-org-place wiring: the org-less agent has NO role_assignment,
 *     so the authority to operate it is the HUMAN OPERATOR's capability grant,
 *     resolved against the operator's slug — never the agent's (non-existent)
 *     org-place.
 *
 * Tenant isolation: every read runs inside a SET LOCAL choros.tenant_id tx (RLS),
 * mirroring grants-dao.ts withTenantReadTx and the assertUuid defence-in-depth.
 */

import pg from "pg";
import { getGrantsForSubject } from "./grants-dao.js";
import { isGenesisOwnerForTenant } from "./org.js";
import {
  holdsLlmConnectionConfigure,
  canOperateSystemAgent,
} from "../core/capability-authz.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// canConfigureLlmConnection — owner OR holder of llm_connection:configure.
//
// Spec §6: "Завести/править подключение и ключ = грант llm_connection:configure →
// владелец/админ". The owner short-circuits; otherwise the actor must hold an
// effective llm_connection:configure grant (a role-constructor-admin granted it
// inside the owner-delegated envelope, T-0469, qualifies — the grant covers).
// ---------------------------------------------------------------------------

export async function canConfigureLlmConnection(
  pool: pg.Pool,
  tenantId: string,
  actorSlug: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  assertUuid(tenantId, "tenantId");
  // Owner short-circuit (resolved from DB, never assumed — NF-3).
  if (await isGenesisOwnerForTenant(pool, tenantId, actorSlug, nowMs)) return true;
  const grants = await getGrantsForSubject(pool, tenantId, actorSlug, nowMs);
  return holdsLlmConnectionConfigure(grants);
}

// ---------------------------------------------------------------------------
// canActorOperateSystemAgents — owner OR (system_agent:operate | authoring_draft).
//
// Spec §6: "Настраивать/запускать системного агента = отдельный грант
// (system_agent:operate), не всем — связать с грантом authoring_draft (T-0462)".
// Evaluated against the OPERATOR's grants — this is the capability axis the
// employee_id-IS-NULL system agents authorize through (they have no org-place).
// ---------------------------------------------------------------------------

export async function canActorOperateSystemAgents(
  pool: pg.Pool,
  tenantId: string,
  actorSlug: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  assertUuid(tenantId, "tenantId");
  if (await isGenesisOwnerForTenant(pool, tenantId, actorSlug, nowMs)) return true;
  const grants = await getGrantsForSubject(pool, tenantId, actorSlug, nowMs);
  return canOperateSystemAgent(grants);
}

// ---------------------------------------------------------------------------
// isOrglessSystemAgent — true iff (tenant_id, agentCardId) is a SYSTEM/ASSISTANT
// agent_card row with employee_id IS NULL (T-0473 taxonomy).
//
// Used by the operate-system-agent gate to assert the TARGET really is an
// org-less capability agent (so the capability axis is the right authority
// source), distinct from a workforce agent that DOES have an org-place. RLS-scoped
// + explicit WHERE tenant_id (defence-in-depth).
// ---------------------------------------------------------------------------

export async function isOrglessSystemAgent(
  pool: pg.Pool,
  tenantId: string,
  agentCardId: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  assertUuid(tenantId, "tenantId");
  assertUuid(agentCardId, "agentCardId");
  void nowMs; // agent_card has no validity window; kept for signature symmetry.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const { rows } = await client.query<{ id: string }>(
      `SELECT id
         FROM choros.agent_card
        WHERE tenant_id = $1
          AND id = $2
          AND employee_id IS NULL
          AND agent_type IN ('system', 'assistant')
        LIMIT 1`,
      [tenantId, agentCardId],
    );
    await client.query("COMMIT");
    return rows.length > 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// canOperateSystemAgentTarget — full gate: the OPERATOR holds the capability AND
// the TARGET is an org-less system/assistant agent. Both must hold. This is the
// composed check a route/handler calls when it wants to authorize operating a
// SPECIFIC org-less agent (capability flows from the operator's grant, the agent
// has no org-place to derive authority from).
// ---------------------------------------------------------------------------

export async function canOperateSystemAgentTarget(
  pool: pg.Pool,
  tenantId: string,
  actorSlug: string,
  agentCardId: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const [operatorOk, targetOk] = await Promise.all([
    canActorOperateSystemAgents(pool, tenantId, actorSlug, nowMs),
    isOrglessSystemAgent(pool, tenantId, agentCardId, nowMs),
  ]);
  return operatorOk && targetOk;
}
