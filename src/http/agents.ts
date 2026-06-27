/**
 * src/http/agents.ts — T-0042 (E5.2): Agent hire route.
 *
 * Registers POST /api/agents/hire.
 *
 * Composition order (ADR §1, step-by-step):
 *   1. extractActor(req)  — x-dev-user under CHOROS_AUTH_MODE=dev (NF-3 / AC-15)
 *   2. loadAdminContext + validateAdminDelegation({kind:"assignment"}, targetOrgScope)
 *      — GATE BEFORE ANY SIDE-EFFECT (FF-HIRE-1 / FR-1 / AC-1/3)
 *   3. buildAgentHirePlan(body)  — derive kc_client_id (pure)
 *   4. kcPort.createServiceAccountClient(spec)  — Keycloak FIRST (NF-4 / ADR §4)
 *   5. withTenantTx:
 *        insertAgentRows(tx, plan)    — DB INSERT employee + agent_card
 *        appendAuditEvent(tx, audit)  — hire audit row (FR-6 / AC-11)
 *      On DB failure → best-effort kcPort.deleteClient (NF-4 / AC-7)
 *   6. 201 {employee_id, kc_client_id}
 *
 * Sister task boundaries:
 *   T-0060: JWT validation — NOT touched here (only x-dev-user / dev-auth seam).
 *   T-0024: invoke-grants — NOT touched here (hire ends at employee+agent_card+KC).
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { loadAdminContext } from "../db/org.js";
import { validateAdminDelegation } from "../core/scoped-admin.js";
import {
  buildAgentHirePlan,
  encodeAgentHireAuditEvent,
  type KeycloakAdminPort,
  type AgentHireAuditEvent,
} from "../core/agent-hire.js";
import { insertAgentRows, AgentConflictError } from "../db/agent-provision.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth, resolveActorTenant } from "../db/org.js";
import { isNarrowerOrEqual, type ScopeElement, type AncestryOracle } from "../core/grant-lattice.js";
import { validateSecretHandleShape } from "../core/secret-handle-validator.js";
import type { AuditEventInput } from "../core/audit-grant-encoder.js";
import type { AdminContext } from "../core/scoped-admin.js";
import { getLlmConnection } from "../db/llm-connection-dao.js";
import { setAgentLlmConnection } from "../db/agent-llm-connection-dao.js";
import {
  readAgentActivity,
  decodeActivityCursor,
  type AgentActivityCursor,
} from "../db/agent-activity-dao.js";

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

import { loadTenantOrgAncestry } from "../db/org-ancestry.js";

// ---------------------------------------------------------------------------
// withTenantTx helper (write-path, mirrors grants.ts)
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
// Canonical audit writer (singleton, mirrors grants.ts)
// ---------------------------------------------------------------------------

const agentAuditWriter = makePgAuditWriter();

// ---------------------------------------------------------------------------
// extractActor — mode-aware caller identity (mirrors process-defs.ts / applications.ts).
//   - keycloak: identity from the VALIDATED token (sub/preferred_username → slug); null
//     → 401 fail-closed. x-dev-user is NOT consulted once a token authenticated.
//   - dev: getAuthContext is undefined (withAuth no-op) → x-dev-user, unchanged.
// Previously dev-only — broke agent hire under CHOROS_AUTH_MODE=keycloak (always 401
// "missing x-dev-user header" despite a valid Bearer).
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
// lookupPositionOrgNode — resolve the org node for a position_id
// Day-1: direct DB lookup inside a tenant-scoped read (no full tree traversal needed).
// ---------------------------------------------------------------------------

async function lookupPositionOrgScope(
  pool: pg.Pool,
  tenantId: string,
  positionId: string,
): Promise<ScopeElement> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const { rows } = await client.query<{ department_id: string; id: string }>(
      `SELECT id, department_id FROM choros.position WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, positionId],
    );
    await client.query("COMMIT");
    if (rows.length === 0) {
      throw new HttpError(400, "VALIDATION", `position_id ${positionId} not found`);
    }
    // Return a scope element keyed on the department's ID (the org node).
    // day-1: we use the department_id as the org node for the scope check.
    return {
      kind: "node",
      hierarchy: "org",
      nodeId: rows[0].department_id,
      nodeLevel: "department",
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// T-0498 [E-AGENTS]: bind an agent to a NAMED llm_connection profile.
//
// Authz — THE SAME class/predicate as the secret-handle lifecycle
// (POST /api/agents/:id/secret-handle, secret-handle.ts::holdsAgentMgmtUpdate):
// genesis-owner OR a confirmed, in-window, delegable mgmt_object:agent/update
// grant covering the agent's org scope (isNarrowerOrEqual). Fail-closed: a plain
// member with neither → 403. Binding the LLM connection is the SAME management
// operation as binding the secret handle (it points the agent at where its key
// lives), so it MUST NOT be a weaker gate.
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

/**
 * Resolve the agent's org placement (department) for the gate's scope check.
 * Mirrors secret-handle.ts::loadAgentOrgScope: employee → position → department.
 * An org-less agent (no department) maps to the tenant-root org node — only a
 * root-covering delegation (or genesis-owner) admits it.
 */
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

/**
 * PUT /api/agents/:id/llm-connection — point an agent at a named llm_connection
 * profile (or detach it).
 *
 * Body: { llm_connection_id: string|null }
 *   - UUID  → bind the agent to that connection (MUST exist in the actor's tenant).
 *   - null  → detach (agent falls back to its inline columns / dormant fallback).
 *
 * Tenant validation (the KEYSTONE invariant): BOTH the agent (:id) AND the
 * llm_connection_id are resolved under the ACTOR's tenant (resolveActorTenant →
 * withTenantTx + RLS). An agent in another tenant → 404. A connection in another
 * tenant (or non-existent) → 400 (getLlmConnection is tenant-scoped, so it returns
 * null for a foreign id; the composite FK would also reject it). null is always
 * valid (detach).
 *
 * Response: { ok:true, llm_connection_id, connection_summary?: {name,provider,model} }
 * — REDACTED metadata only. The secret handle / raw key is NEVER read or returned.
 */
async function handleSetAgentLlmConnection(
  pool: pg.Pool,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  agentId: string,
): Promise<void> {
  const actorId = await extractActor(req, pool);
  const tenantId = await resolveActorTenant(pool, actorId);
  assertUuidShape(agentId, "agent id");

  // Parse + validate the body. llm_connection_id is REQUIRED to be present and is
  // either a UUID (bind) or null (detach). An absent/garbage value → 400.
  const body = await readJsonBody(req);
  if (typeof body !== "object" || body === null) {
    throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
  }
  const raw = (body as Record<string, unknown>)["llm_connection_id"];
  let connectionId: string | null;
  if (raw === null) {
    connectionId = null;
  } else if (typeof raw === "string") {
    // Reject a malformed UUID up front (a clean 400, not a DB error).
    assertUuidShape(raw, "llm_connection_id");
    connectionId = raw;
  } else {
    throw new HttpError(
      400,
      "VALIDATION",
      "llm_connection_id must be a UUID string or null",
    );
  }

  const nowMs = Date.now();

  // Authz — loadAdminContext is a DB read (own tx, no side-effect), BEFORE the write
  // tx (mirrors secret-handle.ts / llm-config.ts). The org-scope check then runs
  // inside the write tx where the agent row is read.
  const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);

  let summary: { name: string; provider: string; model: string | null } | null = null;

  await withTenantTx(pool, tenantId, async (client) => {
    // Gate: same predicate as secret-handle binding (mgmt_object:agent/update).
    const agentOrgScope = await loadAgentOrgScope(client, agentId, tenantId);
    // T-0515: oracle from the tenant's REAL department tree (reuse this tx's client).
    const oracle = await loadTenantOrgAncestry(client, tenantId);
    if (!holdsAgentMgmtUpdate(admin, agentOrgScope, oracle)) {
      throw new HttpError(
        403,
        "ADMIN_GATE_REJECTED",
        "insufficient management authority for agent",
      );
    }

    // CROSS-TENANT GUARD: when binding (non-null), the connection MUST exist in the
    // ACTOR's tenant. getLlmConnection is tenant-scoped (RLS + explicit tenant_id
    // predicate) → null for a foreign or missing id → 400. Never attach an agent to
    // another tenant's connection. (The composite FK is a second, DB-level guard.)
    if (connectionId !== null) {
      const conn = await getLlmConnection(
        client as unknown as PgClientLike,
        tenantId,
        connectionId,
      );
      if (conn === null) {
        throw new HttpError(
          400,
          "LLM_CONNECTION_NOT_FOUND",
          "llm_connection_id does not exist in this tenant",
        );
      }
      // Redacted summary — name/provider/model are NOT secrets. The opaque handle
      // (conn.secretHandle) is NEVER read into the response.
      summary = { name: conn.name, provider: conn.provider, model: conn.model };
    }

    const updated = await setAgentLlmConnection(
      client as unknown as PgClientLike,
      agentId,
      connectionId,
      nowMs,
    );
    if (updated === null) {
      // The agent is not in the caller's tenant (or has no employee-keyed card).
      throw new HttpError(404, "AGENT_NOT_FOUND", "agent not found");
    }

    // Audit — connection-id is NOT a secret; we log only the FK + redacted summary.
    // The secret handle is NEVER named here.
    const auditInput: AuditEventInput = {
      id: randomUUID(),
      type: "set_agent_llm_connection",
      actor: actorId,
      subject: agentId,
      scope: null,
      via: "agents",
      proposed_by: null,
      confirmed_by: null,
      payload: {
        agentEmployeeId: agentId,
        llm_connection_id: connectionId,
        connection_name: summary?.name ?? null,
        connection_provider: summary?.provider ?? null,
      },
      occurred_at: nowMs,
    };
    await agentAuditWriter.appendAuditEvent(client as unknown as PgClientLike, auditInput);
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      ok: true,
      llm_connection_id: connectionId,
      ...(summary !== null ? { connection_summary: summary } : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// T-0499 [E-AGENTS]: read an agent's ACTIVITY (outcome events) from the REAL
// hash-chained audit log (choros.audit_event), the events dispatch-outcome.ts
// writes (agent.proceeded / agent.deferred / agent.blocked).
//
// Authz — THE SAME class/predicate as the agent-management lifecycle
// (PUT /api/agents/:id/llm-connection, POST /api/agents/:id/secret-handle —
// holdsAgentMgmtUpdate): genesis-owner OR a confirmed, in-window, delegable
// mgmt_object:agent/update grant covering the agent's org scope. NOT weaker:
// whoever may MANAGE the agent may see WHAT it did. Fail-closed: a plain member
// → 403; no identity → 401.
//
// Tenant-scope (CRITICAL, audit exposure): runs under withTenantTx (SET LOCAL +
// FORCE RLS) AND the DAO carries a literal WHERE tenant_id = $1. The agent :id is
// validated in the actor's tenant (foreign → 404) BEFORE any audit row is read.
//
// Redaction: the DAO projects ONLY a safe allow-list (outcome / time / proc_key /
// instance_id / step / canned summary). The raw audit payload (free-text reasons,
// agent_draft, signal) NEVER reaches the response.
// ---------------------------------------------------------------------------

/** Default + ceiling page size for the activity list. */
const ACTIVITY_DEFAULT_LIMIT = 20;
const ACTIVITY_MAX_LIMIT = 50;

/** Parse + clamp ?limit= and decode ?cursor= for the activity list. */
function parseActivityQuery(req: import("node:http").IncomingMessage): {
  limit: number;
  cursor: AgentActivityCursor | null;
} {
  const rawUrl = req.url ?? "";
  const qIdx = rawUrl.indexOf("?");
  const sp = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : "");

  let limit = ACTIVITY_DEFAULT_LIMIT;
  const rawLimit = sp.get("limit");
  if (rawLimit !== null) {
    const parsed = parseInt(rawLimit, 10);
    if (!isNaN(parsed)) {
      limit = Math.min(Math.max(1, parsed), ACTIVITY_MAX_LIMIT);
    }
  }

  const rawCursor = sp.get("cursor");
  const cursor = rawCursor !== null ? decodeActivityCursor(rawCursor) : null;

  return { limit, cursor };
}

/**
 * GET /api/agents/:id/activity?limit=&cursor= — the agent's outcome stream.
 *
 * Response: { items: [{ id, ts, outcome, process_key?, step?, instance_id?, summary? }],
 *             nextCursor }
 */
async function handleGetAgentActivity(
  pool: pg.Pool,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  agentId: string,
): Promise<void> {
  const actorId = await extractActor(req, pool);
  const tenantId = await resolveActorTenant(pool, actorId);
  assertUuidShape(agentId, "agent id");

  const { limit, cursor } = parseActivityQuery(req);
  const nowMs = Date.now();

  // Authz — loadAdminContext is a DB read (own tx, no side-effect), BEFORE the
  // read tx (mirrors handleSetAgentLlmConnection / secret-handle.ts). The org-scope
  // check runs inside the read tx where the agent row is resolved.
  const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);

  const page = await withTenantTx(pool, tenantId, async (client) => {
    // (1) Resolve the agent's org scope — this ALSO proves the agent exists in the
    //     actor's tenant (RLS + literal tenant_id in the chain query). A foreign /
    //     missing agent yields the org-root fallback, so we additionally assert the
    //     agent row is present below to return 404 honestly.
    const agentOrgScope = await loadAgentOrgScope(client, agentId, tenantId);

    // T-0515: oracle from the tenant's REAL department tree (reuse this tx's client).
    const oracle = await loadTenantOrgAncestry(client, tenantId);

    // (2) Gate: same predicate as agent management (mgmt_object:agent/update).
    if (!holdsAgentMgmtUpdate(admin, agentOrgScope, oracle)) {
      throw new HttpError(
        403,
        "ADMIN_GATE_REJECTED",
        "insufficient management authority for agent",
      );
    }

    // (3) Tenant existence guard: the agent (:id) MUST be an employee in the actor's
    //     tenant. A foreign / missing agent → 404 (never leak another tenant's audit).
    const exists = await client.query<{ id: string }>(
      `SELECT id
         FROM choros.employee
        WHERE tenant_id = $1 AND id = $2
        LIMIT 1`,
      [tenantId, agentId],
    );
    if (exists.rows.length === 0) {
      throw new HttpError(404, "AGENT_NOT_FOUND", "agent not found");
    }

    // (4) Read the redacted activity page (tenant-scoped under RLS + literal guard).
    return readAgentActivity(
      client as unknown as PgClientLike,
      tenantId,
      agentId,
      limit,
      cursor,
    );
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ items: page.items, nextCursor: page.nextCursor }));
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register POST /api/agents/hire (T-0042 — additive, no existing routes modified).
 *
 * The kcPort parameter is the KeycloakAdminPort — injected so tests can substitute
 * an InMemoryKeycloakAdminPort without a live Keycloak (NF-7 / AC-16 / FF-HIRE-6).
 */
export function registerAgentRoutes(
  router: Router,
  pool: pg.Pool,
  kcPort: KeycloakAdminPort,
): void {

  // ---- POST /api/agents/hire ----------------------------------------------
  // withAuth: keycloak mode REQUIRES a valid Bearer JWT (401 otherwise; no x-dev-user
  // bypass); dev mode is a no-op pass-through and the x-dev-user path is unchanged.
  router.register("POST", "/api/agents/hire", withAuth(async (req, res) => {
    const actorId = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(pool, actorId);
    const nowMs = Date.now();

    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;

    // Validate required fields
    const positionId = b["position_id"];
    if (typeof positionId !== "string") {
      throw new HttpError(400, "VALIDATION", "position_id is required");
    }
    assertUuidShape(positionId, "position_id");

    const slug = b["slug"];
    if (typeof slug !== "string" || slug.trim() === "") {
      throw new HttpError(400, "VALIDATION", "slug is required");
    }

    const displayName = b["display_name"];
    if (typeof displayName !== "string" || displayName.trim() === "") {
      throw new HttpError(400, "VALIDATION", "display_name is required");
    }

    // Optional Stage-2 fields
    const llmEndpoint = typeof b["llm_endpoint"] === "string" ? b["llm_endpoint"] : null;
    const llmModel = typeof b["llm_model"] === "string" ? b["llm_model"] : null;
    const llmSecretHandle = typeof b["llm_secret_handle"] === "string" ? b["llm_secret_handle"] : null;
    const autonomyThreshold = typeof b["autonomy_threshold"] === "number" ? b["autonomy_threshold"] : null;

    // ── C-1: validate llm_secret_handle shape BEFORE any side-effect (RL-3 / FF-25-8) ──
    // NF-1: verdict.reason is a CODE, never the handle value itself.
    if (llmSecretHandle !== null) {
      const verdict = validateSecretHandleShape(llmSecretHandle);
      if (!verdict.ok) {
        throw new HttpError(400, "INVALID_HANDLE", verdict.reason);
      }
    }

    // ── Step 2: GATE — validateAdminDelegation BEFORE any side-effect (FF-HIRE-1) ──
    // Resolve the org scope for the target position_id (the admin's grant must admit it).
    const targetOrgScope = await lookupPositionOrgScope(pool, tenantId, positionId);

    // Load admin context (DB read — no side-effect).
    const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);

    // Gate: {kind:"assignment"} — the org-axis is the whole check for agent hire
    // (analogous to role-assignment gate in grants.ts; the position's org node is
    // the target scope the admin's grant must cover). Rejected before KC call or DB write.
    // T-0515: build the oracle from the tenant's REAL department tree.
    const oracle = await loadTenantOrgAncestry(pool, tenantId);
    const gateResult = validateAdminDelegation(
      admin,
      { kind: "assignment", targetOrgScope },
      oracle,
    );

    if (!gateResult.ok) {
      throw new HttpError(403, "no_mgmt_grant", gateResult.reason);
    }

    // ── Step 3: Build the hire plan (pure) ───────────────────────────────────
    const plan = buildAgentHirePlan({
      tenantId,
      positionId,
      slug,
      displayName,
      llmEndpoint,
      llmModel,
      llmSecretHandle,
      autonomyThreshold,
      nowMs,
    });

    // ── Step 4: Keycloak FIRST (NF-4 / ADR §4) ───────────────────────────────
    // Create the service account BEFORE the DB transaction.
    // If this fails → no DB write, no orphan (AC-6).
    let kcResult: { clientId: string };
    try {
      kcResult = await kcPort.createServiceAccountClient(plan.kcSpec);
    } catch (kcErr) {
      throw new HttpError(
        503,
        "keycloak_failed",
        kcErr instanceof Error ? kcErr.message : "Keycloak service account creation failed",
      );
    }

    // ── Step 5: DB transaction — insertAgentRows + appendAuditEvent ───────────
    // If the tx fails after KC succeeded → best-effort deleteClient (NF-4 / AC-7).
    try {
      await withTenantTx(pool, tenantId, async (client) => {
        // INSERT employee + agent_card (UNIQUE violation → AgentConflictError → 409)
        await insertAgentRows(client as unknown as PgClientLike, plan);

        // Hire audit row (FR-6 / AC-11) — same tx (audit failure rolls back rows)
        const auditEvt: AgentHireAuditEvent = {
          actor: actorId,
          subject: plan.employee.id,
          capability: { resourceType: "mgmt_object:agent", operation: "create" },
          scope: targetOrgScope,
        };
        const auditInput = encodeAgentHireAuditEvent(auditEvt, nowMs, randomUUID());
        await agentAuditWriter.appendAuditEvent(client as unknown as PgClientLike, auditInput);

        // C-1: when llmSecretHandle is non-NULL, emit the canonical custody audit
        // event set_llm_secret_handle in the SAME withTenantTx — no handle value in
        // any field (NF-1 / ADR §13.4). Omitted when llmSecretHandle is NULL.
        if (llmSecretHandle !== null) {
          const custodyAuditInput: AuditEventInput = {
            id: randomUUID(),
            type: "set_llm_secret_handle",
            actor: actorId,
            subject: plan.employee.id,
            scope: null,
            via: "secret-handle",
            proposed_by: null,
            confirmed_by: null,
            payload: { agentEmployeeId: plan.employee.id },
            occurred_at: nowMs,
          };
          await agentAuditWriter.appendAuditEvent(client as unknown as PgClientLike, custodyAuditInput);
        }
      });
    } catch (dbErr) {
      // Best-effort orphan cleanup — attempt to delete the KC client (NF-4 / AC-7).
      // We do NOT await failure of delete to avoid masking the DB error.
      void kcPort.deleteClient(kcResult.clientId).catch(() => {
        // Audit the orphan-cleanup failure if delete also fails — best-effort only.
        // In production this would emit a structured log/alert; for now swallow.
      });

      // Surface typed 409 for conflict, 500 for other DB errors.
      if (dbErr instanceof AgentConflictError) {
        throw new HttpError(409, "client_id_conflict", dbErr.message);
      }
      throw new HttpError(
        500,
        "db_failed",
        dbErr instanceof Error ? dbErr.message : "DB commit failed after Keycloak create",
      );
    }

    // ── Step 6: 201 response ─────────────────────────────────────────────────
    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        employee_id: plan.employee.id,
        kc_client_id: kcResult.clientId,
      }),
    );
  }));

  // ---- PUT /api/agents/:id/llm-connection (T-0498) ------------------------
  // Bind an agent to a named llm_connection profile (or detach with null). Same
  // authz class as POST /api/agents/:id/secret-handle (mgmt_object:agent/update).
  // withAuth: keycloak mode REQUIRES a valid Bearer (401 otherwise; no x-dev-user
  // bypass); dev mode is a pass-through and the x-dev-user path is unchanged.
  router.register(
    "PUT",
    "/api/agents/:id/llm-connection",
    withAuth(async (req, res, params) =>
      handleSetAgentLlmConnection(pool, req, res, params["id"] ?? ""),
    ),
  );

  // ---- GET /api/agents/:id/activity (T-0499) ------------------------------
  // The agent's outcome stream from the REAL audit log. Same authz class as
  // agent management (mgmt_object:agent/update); tenant-scoped (RLS + literal
  // guard, foreign agent → 404); payload-redacted (safe allow-list only).
  // withAuth: keycloak mode REQUIRES a valid Bearer (401 otherwise; no x-dev-user
  // bypass); dev mode is a pass-through and the x-dev-user path is unchanged.
  router.register(
    "GET",
    "/api/agents/:id/activity",
    withAuth(async (req, res, params) =>
      handleGetAgentActivity(pool, req, res, params["id"] ?? ""),
    ),
  );
}
