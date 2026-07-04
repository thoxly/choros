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
 *   - The secret handle is NEVER read or returned here (use secret-handle/status route).
 *   - No raw key is accepted or stored here.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { loadAdminContext, resolveActorSlugFromAuth } from "../db/org.js";
import { isNarrowerOrEqual, type ScopeElement, type AncestryOracle } from "../core/grant-lattice.js";
import { loadTenantOrgAncestry } from "../db/org-ancestry.js";
import type { AdminContext } from "../core/scoped-admin.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import type { AuditEventInput } from "../core/audit-grant-encoder.js";
import {
  readPrimaryAgentLlmConfig,
  updateAgentLlmEndpointModel,
} from "../db/agent-provision.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
// Auth helpers (mirrors agents.ts::extractActor — T-0371/T-0633: resolve the
// keycloak sub to the REAL employee slug via resolveActorSlugFromAuth before
// it drives tenant/grant resolution; a seeded persona's KC sub is a random
// UUID, not its slug). dev mode (x-dev-user) unchanged.
// ---------------------------------------------------------------------------

async function extractActor(
  req: import("node:http").IncomingMessage,
  pool: pg.Pool,
): Promise<string> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
  }
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

async function loadAgentOrgScope(
  client: pg.PoolClient,
  agentId: string | null,
  tenantId: string,
): Promise<ScopeElement> {
  // Org-less agent (system/assistant, migration 093): no employee row → no
  // department. Map to the tenant-root org scope, same as the deptId-NULL path
  // below — only a root-covering delegation (or genesis-owner) admits it.
  if (agentId === null) {
    return { kind: "node", hierarchy: "org", nodeId: "org", nodeLevel: "department" };
  }
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
  /** NULL for an org-less agent (system/assistant, migration 093). */
  employee_id: string | null;
  /** NULL when the agent has no employee row (org-less). */
  slug: string | null;
  llm_endpoint: string | null;
  llm_model: string | null;
  /** Computed boolean: true iff the agent's secret handle is bound. Never the raw value. */
  secret_bound: boolean;
}

/**
 * Find the "primary" assistant agent for a tenant.
 * Priority: slug = 'assistant-agent' first, then first agent row by slug.
 * Returns null if no agent_card rows exist for the tenant.
 *
 * Security (T-0382 MAJOR-3): the secret-handle column is read EXCLUSIVELY via
 * the allow-listed custody DAO (readPrimaryAgentLlmConfig in agent-provision.ts).
 * This file never names the column — the raw opaque handle is collapsed here to
 * a boolean `secret_bound` (handle IS NOT NULL) and never reaches a response.
 */
async function findPrimaryAgent(
  client: pg.PoolClient,
): Promise<AgentCardRow | null> {
  const row = await readPrimaryAgentLlmConfig(client as unknown as PgClientLike);
  if (!row) return null;
  return {
    employee_id: row.employee_id,
    slug: row.slug,
    llm_endpoint: row.llm_endpoint,
    llm_model: row.llm_model,
    // Collapse the opaque handle to a boolean — the raw value never travels on.
    secret_bound: row.secret_handle_ref !== null,
  };
}

// ---------------------------------------------------------------------------
// GET /api/llm-config
// ---------------------------------------------------------------------------

/**
 * Returns the current tenant LLM endpoint + model configuration.
 * The secret handle is NEVER returned — only a boolean `secret_bound`.
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
  const actor = await extractActor(req, pool);
  const tenantId = await resolveActorTenant(actor);
  const nowMs = Date.now();

  // MINOR (T-0382): admin-gate GET to match the PUT route — the LLM connection
  // config (provider/endpoint/model + bound-state) is management-tier metadata,
  // not general-read. Same predicate as PUT (genesis-owner OR mgmt_object:agent/update).
  const admin = await loadAdminContext(pool, tenantId, actor, nowMs);

  const result = await withTenantTx(pool, tenantId, async (client) => {
    const row = await findPrimaryAgent(client);
    if (!row) {
      return {
        agent_id: null,
        agent_slug: null,
        llm_endpoint: null,
        llm_model: null,
        secret_bound: false,
      };
    }
    const orgScope = await loadAgentOrgScope(client, row.employee_id, tenantId);
    // T-0515: oracle from the tenant's REAL department tree (reuse this tx's client).
    const oracle = await loadTenantOrgAncestry(client, tenantId);
    if (!holdsAgentMgmtUpdate(admin, orgScope, oracle)) {
      throw new HttpError(403, "ADMIN_GATE_REJECTED", "insufficient management authority");
    }
    return {
      agent_id: row.employee_id,
      agent_slug: row.slug,
      llm_endpoint: row.llm_endpoint,
      llm_model: row.llm_model,
      // secret_bound is computed from (handle IS NOT NULL) — raw value never travels here.
      secret_bound: row.secret_bound,
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
  const actor = await extractActor(req, pool);
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

  // Endpoint URL + scheme policy. The endpoint receives the resolved LLM key as
  // an Authorization: Bearer header, so it MUST be https — an http:// endpoint
  // would ship the bearer over plaintext (T-0382 BLOCKER-1 hardening).
  // T-0413: also reject endpoints containing userinfo (https://user@host) — the
  // username component could be used to steer requests or to embed data into the
  // target URL. Userinfo is never needed for a legitimate LLM API endpoint.
  // Store parsedEndpoint.href (normalized) rather than the raw trimmed string so
  // the persisted value is always canonical (no trailing whitespace, consistent
  // scheme casing, etc.).
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(llmEndpoint);
  } catch {
    throw new HttpError(400, "VALIDATION", "llm_endpoint must be a valid URL");
  }
  if (parsedEndpoint.protocol !== "https:") {
    throw new HttpError(
      400,
      "VALIDATION",
      "llm_endpoint must use https (the LLM key is sent as a bearer token)",
    );
  }
  if (parsedEndpoint.username !== "") {
    throw new HttpError(
      400,
      "VALIDATION",
      "llm_endpoint must not contain userinfo (user@host form is not permitted)",
    );
  }
  // Use the WHATWG-normalized href as the canonical stored value.
  const canonicalEndpoint = parsedEndpoint.href;

  const admin = await loadAdminContext(pool, tenantId, actor, nowMs);

  let agentId: string | null = null;

  await withTenantTx(pool, tenantId, async (client) => {
    const row = await findPrimaryAgent(client);
    if (!row) {
      throw new HttpError(
        404,
        "NO_AGENT",
        "No agent configured for this tenant. Hire an agent first.",
      );
    }
    const orgScope = await loadAgentOrgScope(client, row.employee_id, tenantId);
    // T-0515: oracle from the tenant's REAL department tree (reuse this tx's client).
    const oracle = await loadTenantOrgAncestry(client, tenantId);
    if (!holdsAgentMgmtUpdate(admin, orgScope, oracle)) {
      throw new HttpError(403, "ADMIN_GATE_REJECTED", "insufficient management authority");
    }

    // This write path addresses the agent_card by employee_id (the historical key).
    // An org-less agent (system/assistant, migration 093) has no employee_id and
    // cannot be updated here yet — L2 (llm_connection) introduces surrogate-id
    // addressing for org-less LLM config. Fail honestly rather than silently no-op.
    if (row.employee_id === null) {
      throw new HttpError(
        409,
        "AGENT_HAS_NO_ORG_PLACE",
        "this agent has no org-place; LLM config for org-less agents lands with the connection registry (L2)",
      );
    }
    agentId = row.employee_id;

    // BLOCKER-2 (T-0382): the UPDATE runs on connection A (this client) INSIDE
    // the outer withTenantTx, so the audit append below and the endpoint/model
    // write commit/rollback ATOMICALLY together.
    // T-0413: canonicalEndpoint is the WHATWG-normalized href (not raw user input).
    const updated = await updateAgentLlmEndpointModel(
      client as unknown as PgClientLike,
      row.employee_id,
      canonicalEndpoint,
      llmModel,
      nowMs,
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
        llm_endpoint: canonicalEndpoint,
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
