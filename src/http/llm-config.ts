/**
 * src/http/llm-config.ts — T-0382 (D5): per-tenant LLM connection config HTTP routes.
 *
 * Routes:
 *   GET  /api/llm-config   — read the current tenant LLM endpoint+model (no key).
 *   PUT  /api/llm-config   — write endpoint+model to agent_card for the tenant's
 *                            assistant-agent (or first configured agent).
 *
 * The secret handle lifecycle (set/rotate/revoke) stays in the EXISTING
 *   POST/PUT/DELETE /api/agents/:id/secret-handle  (T-0025, src/http/secret-handle.ts).
 * This route handles ONLY endpoint+model, which are NOT secrets.
 *
 * Auth: same x-dev-user / keycloak-Bearer pattern (withAuth + extractActor).
 * Authz: genesis-owner OR mgmt_object:agent/update grant (same as secret-handle routes).
 * Tenant isolation: resolveActorTenant → withTenantTx (SET LOCAL + FORCE RLS).
 *
 * Security invariants (D5 / T-0025):
 *   - llm_endpoint and llm_model are NOT secrets — they can be returned to the UI.
 *   - llm_secret_handle is NEVER read or returned here (use secret-handle/status route).
 *   - No raw key is accepted or stored here.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { loadAdminContext } from "../db/org.js";
import { isNarrowerOrEqual, type ScopeElement } from "../core/grant-lattice.js";
import { SEED_ORACLE } from "./seed-ancestry.js";
import type { AdminContext } from "../core/scoped-admin.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import type { AuditEventInput } from "../core/audit-grant-encoder.js";
import { saveTenantLlmEndpointModel } from "../db/agent-card-llm.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

export interface LlmConfigRouteDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
}

// ---------------------------------------------------------------------------
// Auth helpers (same pattern as agents-list.ts)
// ---------------------------------------------------------------------------

function extractActor(req: import("node:http").IncomingMessage): string {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) return ctx.sub;
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// withTenantTx — mirrors secret-handle.ts (write-path needs own transaction)
// ---------------------------------------------------------------------------

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuidShape(tenantId, "tenantId");
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
// Authz (same predicate as secret-handle.ts)
// ---------------------------------------------------------------------------

function holdsAgentMgmtUpdate(
  admin: AdminContext,
  agentOrgScope: ScopeElement,
): boolean {
  if (admin.isGenesisOwner) return true;
  return admin.adminGrants.some(
    (g) =>
      g.resourceType === "mgmt_object:agent" &&
      g.operation === "update" &&
      g.delegable &&
      isNarrowerOrEqual(agentOrgScope, g.scope as ScopeElement, SEED_ORACLE),
  );
}

async function loadAgentOrgScope(
  client: pg.PoolClient,
  agentId: string,
  tenantId: string,
): Promise<ScopeElement> {
  const { rows } = await client.query<{ department_id: string | null }>(
    `SELECT p.department_id
       FROM choros.employee e
       LEFT JOIN choros.position p
         ON p.tenant_id = e.tenant_id AND p.id = e.position_id
      WHERE e.tenant_id = $1 AND e.id = $2
      LIMIT 1`,
    [tenantId, agentId],
  );
  const deptId = rows[0]?.department_id ?? null;
  if (deptId) {
    return { kind: "node", hierarchy: "org", nodeId: deptId, nodeLevel: "department" };
  }
  return { kind: "node", hierarchy: "org", nodeId: "org", nodeLevel: "department" };
}

// ---------------------------------------------------------------------------
// Audit writer
// ---------------------------------------------------------------------------

const llmConfigAuditWriter = makePgAuditWriter();

async function appendAudit(
  client: pg.PoolClient,
  input: AuditEventInput,
): Promise<void> {
  await llmConfigAuditWriter.appendAuditEvent(client as unknown as PgClientLike, input);
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

interface AgentCardRow {
  employee_id: string;
  slug: string;
  llm_endpoint: string | null;
  llm_model: string | null;
  /** NEVER returned to the client; used only server-side for bound status. */
  llm_secret_handle: string | null;
}

/**
 * Find the "primary" assistant agent for a tenant.
 * Priority: slug = 'assistant-agent' first, then first agent row by slug.
 * Returns null if no agent_card rows exist for the tenant.
 */
async function findPrimaryAgent(
  client: pg.PoolClient,
  tenantId: string,
): Promise<AgentCardRow | null> {
  const { rows } = await client.query<AgentCardRow>(
    `SELECT ac.employee_id,
            e.slug,
            ac.llm_endpoint,
            ac.llm_model,
            ac.llm_secret_handle
       FROM choros.agent_card ac
       JOIN choros.employee e
            ON e.tenant_id = ac.tenant_id AND e.id = ac.employee_id
      WHERE ac.tenant_id = current_setting('choros.tenant_id', true)::uuid
      ORDER BY
        CASE WHEN e.slug = 'assistant-agent' THEN 0 ELSE 1 END,
        e.slug
      LIMIT 1`,
    [tenantId],
  );
  // The query above uses SET LOCAL choros.tenant_id so RLS scopes the result.
  // We pass tenantId only to satisfy the query parameter placeholder — RLS does
  // the actual isolation check.
  void tenantId; // used implicitly via SET LOCAL choros.tenant_id
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// GET /api/llm-config
// ---------------------------------------------------------------------------

/**
 * Returns the current tenant LLM endpoint + model configuration.
 * The llm_secret_handle is NEVER returned — only a boolean `secret_bound`.
 *
 * Response shape:
 *   {
 *     agent_id: string | null,
 *     agent_slug: string | null,
 *     llm_endpoint: string | null,
 *     llm_model: string | null,
 *     secret_bound: boolean
 *   }
 */
async function handleGetLlmConfig(
  pool: pg.Pool,
  resolveActorTenant: ActorTenantResolver,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const actor = extractActor(req);
  const tenantId = await resolveActorTenant(actor);

  const result = await withTenantTx(pool, tenantId, async (client) => {
    const row = await findPrimaryAgent(client, tenantId);
    if (!row) {
      return {
        agent_id: null,
        agent_slug: null,
        llm_endpoint: null,
        llm_model: null,
        secret_bound: false,
      };
    }
    return {
      agent_id: row.employee_id,
      agent_slug: row.slug,
      llm_endpoint: row.llm_endpoint,
      llm_model: row.llm_model,
      // Security: only expose whether a handle is bound, never its value.
      secret_bound: row.llm_secret_handle !== null,
    };
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result));
}

// ---------------------------------------------------------------------------
// PUT /api/llm-config
// ---------------------------------------------------------------------------

/**
 * Saves llm_endpoint and llm_model to the tenant's primary agent_card row.
 *
 * Request body (JSON):
 *   { llm_endpoint: string, llm_model: string }
 *
 * The secret handle MUST be set separately via:
 *   POST /api/agents/:id/secret-handle  (T-0025 lifecycle — not this route).
 *
 * Responds { ok: true, agent_id: string } on success.
 */
async function handlePutLlmConfig(
  pool: pg.Pool,
  resolveActorTenant: ActorTenantResolver,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const actor = extractActor(req);
  const tenantId = await resolveActorTenant(actor);
  const nowMs = Date.now();

  const body = await readJsonBody(req);
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>)["llm_endpoint"] !== "string" ||
    typeof (body as Record<string, unknown>)["llm_model"] !== "string"
  ) {
    throw new HttpError(400, "VALIDATION", "llm_endpoint and llm_model are required strings");
  }
  const llmEndpoint = (body as Record<string, string>)["llm_endpoint"].trim();
  const llmModel = (body as Record<string, string>)["llm_model"].trim();

  if (!llmEndpoint) {
    throw new HttpError(400, "VALIDATION", "llm_endpoint must not be empty");
  }
  if (!llmModel) {
    throw new HttpError(400, "VALIDATION", "llm_model must not be empty");
  }

  // Basic URL shape check for endpoint (not secret — just format validation).
  try {
    new URL(llmEndpoint);
  } catch {
    throw new HttpError(400, "VALIDATION", "llm_endpoint must be a valid URL");
  }

  const admin = await loadAdminContext(pool, tenantId, actor, nowMs);

  let agentId: string | null = null;

  await withTenantTx(pool, tenantId, async (client) => {
    const row = await findPrimaryAgent(client, tenantId);
    if (!row) {
      throw new HttpError(
        404,
        "NO_AGENT",
        "No agent configured for this tenant. Hire an agent first.",
      );
    }
    agentId = row.employee_id;

    const orgScope = await loadAgentOrgScope(client, row.employee_id, tenantId);
    if (!holdsAgentMgmtUpdate(admin, orgScope)) {
      throw new HttpError(403, "ADMIN_GATE_REJECTED", "insufficient management authority");
    }

    const updated = await saveTenantLlmEndpointModel(
      pool,
      tenantId,
      row.employee_id,
      llmEndpoint,
      llmModel,
    );
    if (!updated) {
      throw new HttpError(404, "AGENT_NOT_FOUND", "agent card not found");
    }

    // Audit: endpoint and model are NOT secrets — we log them directly.
    const auditInput: AuditEventInput = {
      id: randomUUID(),
      type: "set_llm_endpoint_model",
      actor,
      subject: row.employee_id,
      scope: null,
      via: "llm-config",
      proposed_by: null,
      confirmed_by: null,
      payload: {
        agentEmployeeId: row.employee_id,
        llm_endpoint: llmEndpoint,
        llm_model: llmModel,
      },
      occurred_at: nowMs,
    };
    await appendAudit(client, auditInput);
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, agent_id: agentId }));
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register GET /api/llm-config and PUT /api/llm-config.
 * Additive: does not touch any existing route registrations.
 */
export function registerLlmConfigRoutes(
  router: Router,
  deps: LlmConfigRouteDeps,
): void {
  const { pool, resolveActorTenant } = deps;

  router.register(
    "GET",
    "/api/llm-config",
    withAuth(async (req, res) =>
      handleGetLlmConfig(pool, resolveActorTenant, req, res),
    ),
  );

  router.register(
    "PUT",
    "/api/llm-config",
    withAuth(async (req, res) =>
      handlePutLlmConfig(pool, resolveActorTenant, req, res),
    ),
  );
}
