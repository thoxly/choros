/**
 * src/http/agents-list.ts — T-0271 (E13): GET /api/agents + GET /api/agents/:id.
 *
 * Additive read surface over employee(kind='agent') ⋈ agent_card. The agent HIRE
 * write path (POST /api/agents/hire) and the LLM secret-handle lifecycle
 * (POST/PUT/DELETE/GET /api/agents/:id/secret-handle) already exist in
 * src/http/agents.ts and src/http/secret-handle.ts respectively; this module is
 * the previously-missing LIST/GET (404 before T-0271).
 *
 * Deliberately a SEPARATE module from agents.ts:
 *   - agents.ts is the hire route, frozen byte-immutable by config-agent-seed.sh
 *     Check-6 (over-reach unrelated to T-0077's real seed-only invariant). Putting
 *     the list here keeps that frozen surface untouched — no sanction needed — and
 *     keeps a parallel hire-wrapping task's diff non-conflicting.
 *
 * AUTH (mirrors externalWorker.ts): both routes are withAuth-wrapped and mode-aware.
 *   - dev mode      → identity from x-dev-user (401 if absent).
 *   - keycloak mode → withAuth validates the Bearer JWT (401 without it) BEFORE the
 *                     handler runs; the handler then reads AuthContext.sub.
 *
 * TENANCY: resolveActorTenant (NEVER the request body) → withTenantTx (SET LOCAL +
 * FORCE RLS). Isolation proven here is the production RLS path.
 *
 * SECURITY (the core T-0271 invariant): the response is METADATA ONLY. The raw
 * llm_secret_handle is read solely to compute a boolean `llm_bound` and NEVER
 * appears in any serialized field. The redacted-summary surface is the dedicated
 * GET /api/agents/:id/secret-handle/status endpoint, not this list.
 */

import pg from "pg";
import { HttpError, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

/** Resolve an actor slug/sub to a tenant UUID (same shape as other route modules). */
export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

/** Injected deps for the list/get routes. When absent the routes are not registered. */
export interface AgentListDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
}

// ---------------------------------------------------------------------------
// withTenantTx — mirrors registry-defs.ts / agents.ts (T-0013 RLS)
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
// extractActor — mode-aware (mirrors registry-defs.ts)
// keycloak mode reads AuthContext (set by withAuth); dev mode reads x-dev-user.
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
// Row + public types
// ---------------------------------------------------------------------------

/**
 * Agent function taxonomy (migration 093). The registry shows this; the org
 * structure (GET /api/org) shows ONLY 'workforce' agents (they alone have an
 * org-place). 'system' / 'assistant' agents live in the registry without an
 * employee row (employee_id IS NULL).
 */
export type AgentType = "workforce" | "system" | "assistant";

/** Raw row from agent_card ⟕ employee ⟕ position ⟕ department (LEFT joins). */
interface AgentListRow {
  /** Surrogate registry id (migration 093) — org-independent agent identity. */
  agent_card_id: string;
  /** Org-place link; NULL for system/assistant agents (no org-place). */
  employee_id: string | null;
  agent_type: AgentType;
  /** NULL when the agent has no employee row (org-less). */
  slug: string | null;
  /** NULL when the agent has no employee row; falls back to kc_client_id below. */
  display_name: string | null;
  kc_client_id: string;
  llm_endpoint: string | null;
  llm_model: string | null;
  /** Present ONLY to derive the boolean `llm_bound`; never serialized. */
  llm_secret_handle: string | null;
  /** Named LLM connection profile the agent is bound to (T-0498). NULL = none. NOT a secret. */
  llm_connection_id: string | null;
  position_title: string | null;
  department_name: string | null;
}

/**
 * Public agent metadata (the GET response shape). SECURITY: this type has NO
 * field that can carry secret material — `llm_secret_handle` is collapsed to the
 * boolean `llm_bound` and the raw handle never reaches this object.
 */
export interface AgentPublic {
  /**
   * Addressing id. For an org-attached (workforce) agent this is the employee_id
   * — unchanged, so the existing GET-by-id / secret-handle routes (keyed on
   * employee_id) keep working. For an org-less (system/assistant) agent it is the
   * surrogate agent_card id (migration 093), so the registry can still address it.
   */
  id: string;
  /** Agent function taxonomy (migration 093). */
  agent_type: AgentType;
  /** true iff this agent has an org-place (employee_id set) — i.e. workforce. */
  has_org_place: boolean;
  slug: string;
  display_name: string;
  /** Lifecycle hint derived from config — never a secret. */
  status: "configured" | "needs_llm";
  kc_client_id: string;
  /** Provider label derived from the endpoint HOST (NOT the key). null when unset. */
  llm_provider: string | null;
  llm_model: string | null;
  /** true iff agent_card.llm_secret_handle is non-NULL. The handle itself is never sent. */
  llm_bound: boolean;
  /**
   * Named LLM connection profile the agent is bound to (T-0498), or null when none.
   * NOT a secret — it is the FK id the UI shows as the current selection in the
   * connection dropdown. The key/handle lives on the connection, never here.
   */
  llm_connection_id: string | null;
  position: string | null;
  department: string | null;
}

/**
 * Derive a human-readable provider label from an LLM endpoint URL, WITHOUT
 * leaking any credential (the endpoint is a base URL, never a key). Returns the
 * hostname (e.g. "api.openai.com") or null when no endpoint is configured.
 */
export function deriveLlmProvider(endpoint: string | null): string | null {
  if (!endpoint || endpoint.trim() === "") return null;
  try {
    return new URL(endpoint).host || null;
  } catch {
    return endpoint.trim().slice(0, 64) || null;
  }
}

/**
 * Map a raw join row to the public metadata shape. PURE. Security invariant:
 * the returned object never contains `llm_secret_handle` — it is read only to
 * compute `llm_bound`.
 */
export function serializeAgent(row: AgentListRow): AgentPublic {
  const bound = row.llm_secret_handle !== null;
  const hasOrgPlace = row.employee_id !== null;
  return {
    // Org-attached agents address by employee_id (existing routes unchanged);
    // org-less agents address by their surrogate registry id.
    id: hasOrgPlace ? row.employee_id! : row.agent_card_id,
    agent_type: row.agent_type,
    has_org_place: hasOrgPlace,
    // Org-less agents have no employee row → fall back to the kc_client_id for a
    // stable handle in both slug and display name.
    slug: row.slug ?? row.kc_client_id,
    display_name: row.display_name ?? row.kc_client_id,
    status: bound ? "configured" : "needs_llm",
    kc_client_id: row.kc_client_id,
    llm_provider: deriveLlmProvider(row.llm_endpoint),
    llm_model: row.llm_model,
    llm_bound: bound,
    // The named-connection FK (T-0498): the UI's current dropdown selection. Not a secret.
    llm_connection_id: row.llm_connection_id ?? null,
    position: row.position_title,
    department: row.department_name,
  };
}

// ---------------------------------------------------------------------------
// DB read
// ---------------------------------------------------------------------------

/**
 * Tenant-scoped read of agent metadata under FORCE RLS. The REGISTRY drives the
 * read: agent_card ⟕ employee ⟕ position ⟕ department (LEFT joins), so org-less
 * agents (employee_id IS NULL — system/assistant, migration 093) appear too. The
 * employee join is dropped for them; slug/display_name come back NULL and the
 * serializer falls back to kc_client_id. Reads llm_secret_handle ONLY to compute
 * llm_bound; the value never escapes serializeAgent.
 *
 * The optional `agentId` filter matches EITHER the agent's employee_id (workforce,
 * the historical addressing) OR the surrogate agent_card id (org-less) — so
 * GET /api/agents/:id resolves both addressing schemes.
 */
async function listAgentsTx(
  pool: pg.Pool,
  tenantId: string,
  agentId: string | null,
): Promise<AgentListRow[]> {
  return withTenantTx(pool, tenantId, async (client) => {
    const { rows } = await client.query<AgentListRow>(
      `SELECT ac.id            AS agent_card_id,
              ac.employee_id   AS employee_id,
              ac.agent_type    AS agent_type,
              e.slug           AS slug,
              e.display_name   AS display_name,
              ac.kc_client_id  AS kc_client_id,
              ac.llm_endpoint  AS llm_endpoint,
              ac.llm_model     AS llm_model,
              ac.llm_secret_handle AS llm_secret_handle,
              ac.llm_connection_id AS llm_connection_id,
              p.title          AS position_title,
              d.display_name   AS department_name
         FROM choros.agent_card ac
         LEFT JOIN choros.employee e
              ON e.tenant_id = ac.tenant_id AND e.id = ac.employee_id
         LEFT JOIN choros.position p
              ON p.tenant_id = e.tenant_id AND p.id = e.position_id
         LEFT JOIN choros.department d
              ON d.tenant_id = p.tenant_id AND d.id = p.department_id
        WHERE ac.tenant_id = current_setting('choros.tenant_id', true)::uuid
          AND ($1::uuid IS NULL OR ac.employee_id = $1::uuid OR ac.id = $1::uuid)
        ORDER BY ac.agent_type, COALESCE(e.slug, ac.kc_client_id)`,
      [agentId],
    );
    return rows;
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register GET /api/agents (list) + GET /api/agents/:id (one). Both withAuth-
 * wrapped, tenant-scoped, METADATA-ONLY (serializeAgent never emits secrets).
 */
export function registerAgentListRoutes(router: Router, deps: AgentListDeps): void {
  const { pool, resolveActorTenant } = deps;

  // GET /api/agents — list this tenant's agents (metadata only).
  router.register(
    "GET",
    "/api/agents",
    withAuth(async (req, res) => {
      const actor = extractActor(req);
      const tenantId = await resolveActorTenant(actor);
      const rows = await listAgentsTx(pool, tenantId, null);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ agents: rows.map(serializeAgent) }));
    }),
  );

  // GET /api/agents/:id — one agent (404 when not in the caller's tenant).
  router.register(
    "GET",
    "/api/agents/:id",
    withAuth(async (req, res, params) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "agent id");
      const actor = extractActor(req);
      const tenantId = await resolveActorTenant(actor);
      const rows = await listAgentsTx(pool, tenantId, id);
      if (rows.length === 0) {
        throw new HttpError(404, "NOT_FOUND", "agent not found");
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(serializeAgent(rows[0]!)));
    }),
  );
}
