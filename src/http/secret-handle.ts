/**
 * src/http/secret-handle.ts — T-0025 E5.5 BYO-LLM Secret-Handle Custody
 *
 * Registers four route handlers for the llm_secret_handle lifecycle:
 *
 *   POST   /api/agents/:agentId/secret-handle          → setSecretHandle   (FR-1)
 *   PUT    /api/agents/:agentId/secret-handle          → rotateSecretHandle (FR-2)
 *   DELETE /api/agents/:agentId/secret-handle          → revokeSecretHandle (FR-3)
 *   GET    /api/agents/:agentId/secret-handle/status   → getSecretHandleStatus (FR-4)
 *
 * Design invariants:
 *  - Auth via extractActor (x-dev-user header); 401 if absent.
 *  - Authz via loadAdminContext + holdsAgentMgmtUpdate predicate; 403 if denied.
 *  - All writes run inside withTenantTx (SET LOCAL + FORCE RLS) for tenant isolation (FR-7).
 *  - Audit via canonical appendAuditEventInput INSIDE the same withTenantTx (atomic, NF-4).
 *  - handle_value NEVER appears in: logs, error messages, audit payload (NF-1 / AC-11).
 *  - resolveSecret port is declared (SecretResolverPort), NEVER invoked here (FR-6 / Stage-2).
 *
 * withTenantTx is duplicated from grants.ts by the codebase's "write-path needs own transaction"
 * precedent (line 100 comment in grants.ts) — grants.ts is a frozen file; exporting the helper
 * would mutate a frozen surface for no gain (ADR §3 rejected alternatives).
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { loadAdminContext } from "../db/org.js";
import { isNarrowerOrEqual, type ScopeElement, type AncestryOracle } from "../core/grant-lattice.js";
import { loadTenantOrgAncestry } from "../db/org-ancestry.js";
import type { AdminContext } from "../core/scoped-admin.js";
import type { AuditEventInput } from "../core/audit-grant-encoder.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER } from "./auth.js";
import {
  validateSecretHandleShape,
  redactHandle,
} from "../core/secret-handle-validator.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

// Audit event type literals (NF-4 exact strings).
const AUDIT_TYPE_SET    = "set_llm_secret_handle"    as const;
const AUDIT_TYPE_ROTATE = "rotate_llm_secret_handle" as const;
const AUDIT_TYPE_REVOKE = "revoke_llm_secret_handle" as const;

// ---------------------------------------------------------------------------
// UUID / shape helpers (duplicated from grants.ts — write-path own transaction)
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// withTenantTx helper (mirrors src/db/org.ts — write-path needs own transaction)
// Duplicated by the same precedent grants.ts acknowledges at line ~100.
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
// Audit writer (canonical sink — mirrors grants.ts pattern)
// ---------------------------------------------------------------------------

const secretHandleAuditWriter = makePgAuditWriter();

async function appendAuditEventInput(
  client: pg.PoolClient,
  _tenantId: string,
  input: AuditEventInput,
): Promise<void> {
  await secretHandleAuditWriter.appendAuditEvent(client as unknown as PgClientLike, input);
}

// ---------------------------------------------------------------------------
// Auth helper (pattern from grants.ts::extractActor)
// ---------------------------------------------------------------------------

function extractActor(req: import("node:http").IncomingMessage): string {
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// Authority gate predicate (ADR §4 — composes existing exports, NO new logic)
//
// holdsAgentMgmtUpdate: true iff the admin is the genesis owner OR holds a
// confirmed, in-window, delegable mgmt_object:agent/update grant that covers
// the agent's org scope (isNarrowerOrEqual from scoped-admin.ts).
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

// ---------------------------------------------------------------------------
// Agent org scope lookup helper
// Returns a ScopeElement representing the agent's org placement.
// Day-1: reads employee.department_id from the same withTenantTx; if the agent
// has no department, falls back to an org-root node (the gate predicate covers
// all descendant nodes, so a root scope is the most permissive placement).
// ---------------------------------------------------------------------------

async function loadAgentOrgScope(
  client: pg.PoolClient,
  agentId: string,
  tenantId: string,
): Promise<ScopeElement> {
  // Resolve the agent's department via the employee → position → department chain.
  // employee.position_id → position.department_id → department.id
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
  // Fallback: org root node (covers entire tree for coverage check).
  return { kind: "node", hierarchy: "org", nodeId: "org", nodeLevel: "department" };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** POST /api/agents/:agentId/secret-handle — set handle (FR-1) */
async function handleSetSecretHandle(
  pool: pg.Pool,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  agentId: string,
): Promise<void> {
  const actor = extractActor(req);
  const tenantId = DEV_TENANT_ID;
  assertUuidShape(agentId, "agentId");

  const body = await readJsonBody(req);
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>)["handle_value"] !== "string"
  ) {
    throw new HttpError(400, "VALIDATION", "handle_value is required and must be a string");
  }
  const handleValue = (body as Record<string, string>)["handle_value"];

  const verdict = validateSecretHandleShape(handleValue);
  if (!verdict.ok) {
    // NF-1: reason is a CODE (not the value) in the error message.
    throw new HttpError(400, "INVALID_HANDLE", verdict.reason);
  }

  const nowMs = Date.now();
  const admin = await loadAdminContext(pool, tenantId, actor, nowMs);

  await withTenantTx(pool, tenantId, async (client) => {
    const agentOrgScope = await loadAgentOrgScope(client, agentId, tenantId);
    // T-0515: oracle from the tenant's REAL department tree (reuse this tx's client).
    const oracle = await loadTenantOrgAncestry(client, tenantId);
    if (!holdsAgentMgmtUpdate(admin, agentOrgScope, oracle)) {
      throw new HttpError(403, "ADMIN_GATE_REJECTED", "insufficient management authority for agent");
    }

    const r = await client.query(
      `UPDATE choros.agent_card
          SET llm_secret_handle = $2, updated_at = $3
        WHERE tenant_id = current_setting('choros.tenant_id', true)::uuid
          AND employee_id = $1
        RETURNING employee_id`,
      [agentId, handleValue, nowMs],
    );
    if (r.rowCount === 0) {
      throw new HttpError(404, "AGENT_NOT_FOUND", "agent not found");
    }

    const auditInput: AuditEventInput = {
      id: randomUUID(),
      type: AUDIT_TYPE_SET,
      actor,
      subject: agentId,
      scope: null,
      via: "secret-handle",
      proposed_by: null,
      confirmed_by: null,
      payload: { agentEmployeeId: agentId },
      occurred_at: nowMs,
    };
    await appendAuditEventInput(client, tenantId, auditInput);
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));
}

/** PUT /api/agents/:agentId/secret-handle — rotate handle (FR-2) */
async function handleRotateSecretHandle(
  pool: pg.Pool,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  agentId: string,
): Promise<void> {
  const actor = extractActor(req);
  const tenantId = DEV_TENANT_ID;
  assertUuidShape(agentId, "agentId");

  const body = await readJsonBody(req);
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>)["handle_value"] !== "string"
  ) {
    throw new HttpError(400, "VALIDATION", "handle_value is required and must be a string");
  }
  const handleValue = (body as Record<string, string>)["handle_value"];

  const verdict = validateSecretHandleShape(handleValue);
  if (!verdict.ok) {
    throw new HttpError(400, "INVALID_HANDLE", verdict.reason);
  }

  const nowMs = Date.now();
  const admin = await loadAdminContext(pool, tenantId, actor, nowMs);

  await withTenantTx(pool, tenantId, async (client) => {
    const agentOrgScope = await loadAgentOrgScope(client, agentId, tenantId);
    // T-0515: oracle from the tenant's REAL department tree (reuse this tx's client).
    const oracle = await loadTenantOrgAncestry(client, tenantId);
    if (!holdsAgentMgmtUpdate(admin, agentOrgScope, oracle)) {
      throw new HttpError(403, "ADMIN_GATE_REJECTED", "insufficient management authority for agent");
    }

    const r = await client.query(
      `UPDATE choros.agent_card
          SET llm_secret_handle = $2, updated_at = $3
        WHERE tenant_id = current_setting('choros.tenant_id', true)::uuid
          AND employee_id = $1
        RETURNING employee_id`,
      [agentId, handleValue, nowMs],
    );
    if (r.rowCount === 0) {
      throw new HttpError(404, "AGENT_NOT_FOUND", "agent not found");
    }

    const auditInput: AuditEventInput = {
      id: randomUUID(),
      type: AUDIT_TYPE_ROTATE,
      actor,
      subject: agentId,
      scope: null,
      via: "secret-handle",
      proposed_by: null,
      confirmed_by: null,
      payload: { agentEmployeeId: agentId },
      occurred_at: nowMs,
    };
    await appendAuditEventInput(client, tenantId, auditInput);
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));
}

/** DELETE /api/agents/:agentId/secret-handle — revoke handle (FR-3) */
async function handleRevokeSecretHandle(
  pool: pg.Pool,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  agentId: string,
): Promise<void> {
  const actor = extractActor(req);
  const tenantId = DEV_TENANT_ID;
  assertUuidShape(agentId, "agentId");

  const nowMs = Date.now();
  const admin = await loadAdminContext(pool, tenantId, actor, nowMs);

  await withTenantTx(pool, tenantId, async (client) => {
    const agentOrgScope = await loadAgentOrgScope(client, agentId, tenantId);
    // T-0515: oracle from the tenant's REAL department tree (reuse this tx's client).
    const oracle = await loadTenantOrgAncestry(client, tenantId);
    if (!holdsAgentMgmtUpdate(admin, agentOrgScope, oracle)) {
      throw new HttpError(403, "ADMIN_GATE_REJECTED", "insufficient management authority for agent");
    }

    const r = await client.query(
      `UPDATE choros.agent_card
          SET llm_secret_handle = NULL, updated_at = $2
        WHERE tenant_id = current_setting('choros.tenant_id', true)::uuid
          AND employee_id = $1
        RETURNING employee_id`,
      [agentId, nowMs],
    );
    if (r.rowCount === 0) {
      throw new HttpError(404, "AGENT_NOT_FOUND", "agent not found");
    }

    const auditInput: AuditEventInput = {
      id: randomUUID(),
      type: AUDIT_TYPE_REVOKE,
      actor,
      subject: agentId,
      scope: null,
      via: "secret-handle",
      proposed_by: null,
      confirmed_by: null,
      payload: { agentEmployeeId: agentId },
      occurred_at: nowMs,
    };
    await appendAuditEventInput(client, tenantId, auditInput);
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));
}

/** GET /api/agents/:agentId/secret-handle/status — read status (FR-4) */
async function handleGetSecretHandleStatus(
  pool: pg.Pool,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  agentId: string,
): Promise<void> {
  extractActor(req); // 401 if absent
  const tenantId = DEV_TENANT_ID;
  assertUuidShape(agentId, "agentId");

  const result = await withTenantTx(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ llm_secret_handle: string | null }>(
      `SELECT llm_secret_handle
         FROM choros.agent_card
        WHERE tenant_id = current_setting('choros.tenant_id', true)::uuid
          AND employee_id = $1
        LIMIT 1`,
      [agentId],
    );
    if (rows.length === 0) {
      throw new HttpError(404, "AGENT_NOT_FOUND", "agent not found");
    }
    // Consume full value SERVER-SIDE ONLY; NF-1: never echo it.
    const raw = rows[0]?.llm_secret_handle ?? null;
    if (raw === null) {
      return { bound: false };
    }
    // redactHandle produces a scheme-prefix or first-8-chars summary (FR-4).
    const summary = redactHandle(raw);
    return { bound: true, summary };
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result));
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * registerSecretHandleRoutes — registers the four T-0025 routes.
 * Called from server.ts alongside registerGrantsRoutes.
 */
export function registerSecretHandleRoutes(router: Router, pool: pg.Pool): void {
  router.register("POST", "/api/agents/:agentId/secret-handle", (req, res, params) =>
    handleSetSecretHandle(pool, req, res, params["agentId"] ?? ""),
  );

  router.register("PUT", "/api/agents/:agentId/secret-handle", (req, res, params) =>
    handleRotateSecretHandle(pool, req, res, params["agentId"] ?? ""),
  );

  router.register("DELETE", "/api/agents/:agentId/secret-handle", (req, res, params) =>
    handleRevokeSecretHandle(pool, req, res, params["agentId"] ?? ""),
  );

  router.register("GET", "/api/agents/:agentId/secret-handle/status", (req, res, params) =>
    handleGetSecretHandleStatus(pool, req, res, params["agentId"] ?? ""),
  );
}
