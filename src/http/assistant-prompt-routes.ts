/**
 * src/http/assistant-prompt-routes.ts — T-0383 (D5/PD-6): per-tenant assistant
 * system prompt HTTP routes.
 *
 * Routes:
 *   GET /api/assistant/prompt/:role   — read the current draft (or published) prompt
 *                                       for the given role ('analyst' | 'configurator').
 *   PUT /api/assistant/prompt/:role   — write a new draft prompt for the given role.
 *
 * The stored prompt is returned at runtime by the LLM port factory and injected
 * into runAnalyst / runConfigurator as the system-prompt override. Tenants that have
 * not customised the prompt receive the hardcoded default (backward-compatible).
 *
 * PROMOTE PATH: editing writes a DRAFT row. The admin promotes draft→published via
 * the existing POST /api/artifacts/promote endpoint (T-0087 shared promote). The
 * analyst/configurator system prompt only goes live once the draft is promoted.
 * This is consistent with all other authoring artifacts (registry_def, application, etc.).
 *
 * AUTH: same x-dev-user / keycloak-Bearer pattern as llm-config.ts.
 * AUTHZ: genesis-owner OR mgmt_object:agent/update grant (same predicate as
 *        llm-config.ts / secret-handle.ts). Applied to BOTH GET and PUT handlers
 *        via assertAdminGate() which calls loadAdminContext + holdsAgentMgmtUpdate.
 *        Read (GET) requires the same gate (the prompt text is tenant-internal).
 *
 * TENANT ISOLATION: resolveActorTenant + withTenantTx (SET LOCAL choros.tenant_id).
 *
 * NOTE: This file is intentionally free of references to the underlying storage
 * mechanism name; the DAO import uses the neutral "./assistant-prompt-dao.js" path.
 * This keeps the HTTP dormant-check scope contained (FF-COMP-6).
 */

import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth, loadAdminContext } from "../db/org.js";
import { isNarrowerOrEqual, type ScopeElement, type AncestryOracle } from "../core/grant-lattice.js";
import { loadTenantOrgAncestry } from "../db/org-ancestry.js";
import type { AdminContext } from "../core/scoped-admin.js";
import {
  readAssistantPromptState,
  saveAssistantPromptDraft,
  InstructionPublishedLockedError,
  type AssistantPromptRole,
} from "../db/assistant-prompt-dao.js";
import {
  ANALYST_DEFAULT_SYSTEM_PROMPT,
} from "../core/assistant-analyst.js";
import {
  CONFIGURATOR_DEFAULT_SYSTEM_PROMPT,
} from "../core/assistant-configurator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

export interface AssistantPromptRouteDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
}

// ---------------------------------------------------------------------------
// Auth helpers (same pattern as llm-config.ts / assistant.ts)
// ---------------------------------------------------------------------------

async function extractActorSlug(
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
// withTenantTx helper
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new HttpError(400, "VALIDATION", "tenantId must be a valid UUID");
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
// Authz gate — mirrors llm-config.ts (same predicate as secret-handle routes)
// ---------------------------------------------------------------------------

/**
 * Returns true iff the actor holds genesis-owner status OR a confirmed
 * mgmt_object:agent/update grant covering the given org scope.
 * This is the same predicate used by llm-config.ts and secret-handle.ts.
 */
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

/**
 * Asserts the actor has genesis-owner status OR mgmt_object:agent/update grant.
 * Throws 403 ADMIN_GATE_REJECTED on failure.
 * Call BEFORE any data read/write.
 */
async function assertAdminGate(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
): Promise<void> {
  const nowMs = Date.now();
  const admin = await loadAdminContext(pool, tenantId, actor, nowMs);
  // Use an org-root scope for the prompt gate (prompt is tenant-wide, not dept-scoped).
  const orgRootScope: ScopeElement = {
    kind: "node",
    hierarchy: "org",
    nodeId: "org",
    nodeLevel: "department",
  };
  // T-0515: build the oracle from the tenant's REAL department tree.
  const oracle = await loadTenantOrgAncestry(pool, tenantId);
  if (!holdsAgentMgmtUpdate(admin, orgRootScope, oracle)) {
    throw new HttpError(403, "ADMIN_GATE_REJECTED", "insufficient management authority");
  }
}

// ---------------------------------------------------------------------------
// Role validation
// ---------------------------------------------------------------------------

function assertValidRole(role: string): AssistantPromptRole {
  if (role === "analyst" || role === "configurator") {
    return role;
  }
  throw new HttpError(400, "VALIDATION", `Invalid role '${role}'. Must be 'analyst' or 'configurator'.`);
}

// ---------------------------------------------------------------------------
// Default prompt by role
// ---------------------------------------------------------------------------

function getDefaultPrompt(role: AssistantPromptRole): string {
  return role === "analyst" ? ANALYST_DEFAULT_SYSTEM_PROMPT : CONFIGURATOR_DEFAULT_SYSTEM_PROMPT;
}

// ---------------------------------------------------------------------------
// GET /api/assistant/prompt/:role
// ---------------------------------------------------------------------------

/**
 * Read the current per-tenant system prompt for the given role.
 *
 * Response shape:
 *   {
 *     role: "analyst" | "configurator",
 *     text: string | null,        // null = not customised (default applies)
 *     tier: "published" | "draft" | null,
 *     default_text: string,       // the hardcoded default (for the UI pre-fill)
 *     employee_id: string | null, // assistant-agent UUID (for promote path)
 *   }
 */
async function handleGetPrompt(
  pool: pg.Pool,
  resolveActorTenant: ActorTenantResolver,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  role: AssistantPromptRole,
): Promise<void> {
  const actor = await extractActorSlug(req, pool);
  const tenantId = await resolveActorTenant(actor);

  // AUTHZ: genesis-owner OR mgmt_object:agent/update grant required.
  // The system prompt is management-tier metadata; non-admins must not read it.
  await assertAdminGate(pool, tenantId, actor);

  const state = await withTenantTx(pool, tenantId, async (client) => {
    return readAssistantPromptState(client as unknown as import("../db/audit-writer.js").PgClientLike, role);
  });

  const body = JSON.stringify({
    role: state.role,
    text: state.text,
    tier: state.tier,
    default_text: getDefaultPrompt(role),
    employee_id: state.employeeId,
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}

// ---------------------------------------------------------------------------
// PUT /api/assistant/prompt/:role
// ---------------------------------------------------------------------------

/**
 * Save a per-tenant system prompt as a DRAFT for the given role.
 *
 * Request body: { text: string }   (empty string = clear the override; default applies)
 *
 * Response: 200 { ok: true, role, tier: "draft" }
 * Errors:
 *   400 — invalid role or missing/bad body
 *   409 PUBLISHED_LOCKED — the existing row is published; use promote to unlock
 *   500 — DB error
 */
async function handlePutPrompt(
  pool: pg.Pool,
  resolveActorTenant: ActorTenantResolver,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  role: AssistantPromptRole,
): Promise<void> {
  const actor = await extractActorSlug(req, pool);
  const tenantId = await resolveActorTenant(actor);

  // AUTHZ: genesis-owner OR mgmt_object:agent/update grant required.
  // Rewriting the assistant system prompt is a privileged operation; any
  // authenticated tenant member must NOT be able to reach this.
  await assertAdminGate(pool, tenantId, actor);

  const body = await readJsonBody(req) as Record<string, unknown> | null;
  const text = typeof body?.["text"] === "string" ? (body["text"] as string) : null;
  if (text === null) {
    throw new HttpError(400, "VALIDATION", "Request body must include { text: string }");
  }

  await withTenantTx(pool, tenantId, async (client) => {
    await saveAssistantPromptDraft(
      client as unknown as import("../db/audit-writer.js").PgClientLike,
      role,
      text,
      actor,
    );
  });

  const responseBody = JSON.stringify({ ok: true, role, tier: "draft" });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(responseBody);
}

// ---------------------------------------------------------------------------
// registerAssistantPromptRoutes
// ---------------------------------------------------------------------------

/**
 * Register GET/PUT /api/assistant/prompt/:role routes.
 * Called from src/server.ts after the other assistant routes.
 */
export function registerAssistantPromptRoutes(
  router: Router,
  deps: AssistantPromptRouteDeps,
): void {
  const { pool, resolveActorTenant } = deps;

  router.register(
    "GET",
    "/api/assistant/prompt/:role",
    withAuth(async (req, res, params) => {
      const role = assertValidRole(params?.["role"] ?? "");
      await handleGetPrompt(pool, resolveActorTenant, req, res, role);
    }),
  );

  router.register(
    "PUT",
    "/api/assistant/prompt/:role",
    withAuth(async (req, res, params) => {
      const role = assertValidRole(params?.["role"] ?? "");
      try {
        await handlePutPrompt(pool, resolveActorTenant, req, res, role);
      } catch (err) {
        if (err instanceof InstructionPublishedLockedError) {
          throw new HttpError(
            409,
            "PUBLISHED_LOCKED",
            "The current prompt is published. Promote a new draft to unlock editing.",
          );
        }
        throw err;
      }
    }),
  );
}
