/**
 * src/http/invoke.ts
 *
 * T-0024 E5.4: Invoke-grant HTTP routes — request vs command split.
 *
 * Routes:
 *   POST /api/invoke/request  — checks invoke-grant, inserts invoke_proposal
 *                               (status='proposed'), emits "invoke.request" audit.
 *   POST /api/invoke/command  — checks invoke-grant, emits "invoke.command" audit,
 *                               returns 202 { invocation_id } (dispatch = stub day-1).
 *
 * DESIGN INVARIANTS:
 *  - Caller identity from X-Dev-User header (NF-6; same dev convention as grants.ts).
 *  - Grant check uses coversInvoke() which composes T-0018 primitives
 *    (isNarrowerOrEqual + isEffective) — no second authority subsystem (NF-2/FF-IG-5).
 *  - Audit goes through encodeInvokeAuditEvent → appendAuditEvent canonical seam only
 *    (NF-3/FF-IG-6).
 *  - Fail-closed: 403 FORBIDDEN if no covering invoke-grant; no row inserted, no audit
 *    (NF-4/FF-IG-7).
 *  - INSERT + audit in ONE withTenantTx (atomic, mirrors grants.ts).
 *  - No cross-table FK: caller_id/target_id are application-layer validated (T-0017 lesson).
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import pg from "pg";
import {
  type Grant,
  type ScopeElement,
  type AncestryOracle,
  isNarrowerOrEqual,
  isEffective,
} from "../core/grant-lattice.js";
import {
  encodeInvokeAuditEvent,
  type InvokeAuditEvent,
  type AuditEventInput,
} from "../core/audit-grant-encoder.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER } from "./auth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Seed oracle (mirrors grants.ts — day-1 org ancestry oracle)
// ---------------------------------------------------------------------------

const ORG_SEED_CHILDREN: Record<string, string[]> = {
  org: ["fin", "cs", "plat", "sales"],
  fin: ["fin-calc", "fin-approve", "fin-treasury"],
  cs: ["cs-l1", "cs-l2"],
  sales: ["sales-smb", "sales-ent"],
  "b0000000-0000-0000-0000-000000000001": [],
  "b0000000-0000-0000-0000-000000000002": [],
  "b0000000-0000-0000-0000-000000000003": [],
};

function isDescendantOrSelfSeed(descendantId: string, ancestorId: string): boolean {
  if (descendantId === ancestorId) return true;
  const children = ORG_SEED_CHILDREN[ancestorId] ?? [];
  for (const c of children) {
    if (isDescendantOrSelfSeed(descendantId, c)) return true;
  }
  return false;
}

export const SEED_ORACLE: AncestryOracle = {
  isDescendantOrSelf(_hierarchy, descendantId, ancestorId) {
    return isDescendantOrSelfSeed(descendantId, ancestorId);
  },
};

// ---------------------------------------------------------------------------
// withTenantTx helper (mirrors grants.ts pattern)
// ---------------------------------------------------------------------------

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

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
// extractActor — reads caller identity from X-Dev-User header (NF-6)
// ---------------------------------------------------------------------------

function extractActor(req: IncomingMessage): string {
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

const invokeAuditWriter = makePgAuditWriter();

export async function writeInvokeAuditEvent(
  client: pg.PoolClient,
  _tenantId: string,
  evt: InvokeAuditEvent,
  nowMs: number,
): Promise<void> {
  const input: AuditEventInput = encodeInvokeAuditEvent(evt, nowMs);
  await invokeAuditWriter.appendAuditEvent(client as unknown as PgClientLike, input);
}

// ---------------------------------------------------------------------------
// coversInvoke — the covering predicate for an invoke-grant.
//
// A grant covers the invocation iff ALL of:
//   1. operation === 'invoke'
//   2. isEffective(grant, nowMs) — within validity window (T-0018)
//   3. resource_facet.agent_role_id === targetRoleId — role match
//   4. isNarrowerOrEqual(targetOrgScope, grant.scope, oracle) — scope covers target
//
// This composes the exported T-0018 primitives (isNarrowerOrEqual + isEffective).
// It is the ONLY grant-decision path; no second authority subsystem.
// ---------------------------------------------------------------------------

export function coversInvoke(
  grant: Grant,
  targetRoleId: string,
  targetOrgScope: ScopeElement,
  nowMs: number,
  oracle: AncestryOracle,
): boolean {
  if (grant.operation !== "invoke") return false;
  if (!isEffective(grant, nowMs)) return false;

  // resource_facet must carry agent_role_id matching the target's assigned role
  const facet = grant.resourceFacet as Record<string, unknown> | undefined;
  if (!facet || facet["agent_role_id"] !== targetRoleId) return false;

  // Grant scope must cover the target's org position
  const grantScope = grant.scope;
  if (grantScope.kind === "freeform") return false;
  return isNarrowerOrEqual(targetOrgScope, grantScope as ScopeElement, oracle);
}

// ---------------------------------------------------------------------------
// DB helpers — load agent_card and role_assignment
// ---------------------------------------------------------------------------

interface AgentCardRow {
  employee_id: string;
}

interface RoleAssignmentRow {
  role_id: string;
  org_scope: unknown;
}

async function loadAgentCard(
  client: pg.PoolClient,
  tenantId: string,
  targetAgentId: string,
): Promise<AgentCardRow | null> {
  const { rows } = await client.query<AgentCardRow>(
    `SELECT employee_id FROM choros.agent_card
      WHERE tenant_id = $1 AND employee_id = $2`,
    [tenantId, targetAgentId],
  );
  return rows[0] ?? null;
}

async function loadActiveRoleAssignment(
  client: pg.PoolClient,
  tenantId: string,
  employeeId: string,
): Promise<RoleAssignmentRow | null> {
  const { rows } = await client.query<RoleAssignmentRow>(
    `SELECT role_id, org_scope FROM choros.role_assignment
      WHERE tenant_id = $1 AND employee_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, employeeId],
  );
  return rows[0] ?? null;
}

async function loadCallerInvokeGrants(
  client: pg.PoolClient,
  tenantId: string,
  callerId: string,
): Promise<Grant[]> {
  // Load invoke-grants for all roles the caller holds via their role_assignments
  const { rows } = await client.query<{
    id: string;
    role_id: string;
    resource_type: string;
    resource_facet: unknown;
    operation: string;
    scope: unknown;
    constraint: unknown;
    delegable: boolean;
    granted_by: string;
    valid_from: string | null;
    valid_until: string | null;
    created_at: string;
  }>(
    `SELECT g.id, g.role_id, g.resource_type, g.resource_facet,
            g.operation, g.scope, g."constraint", g.delegable,
            g.granted_by, g.valid_from, g.valid_until, g.created_at
       FROM choros."grant" g
       JOIN choros.role_assignment ra
         ON ra.tenant_id = g.tenant_id AND ra.role_id = g.role_id
      WHERE g.tenant_id = $1
        AND ra.employee_id = $2
        AND g.operation = 'invoke'`,
    [tenantId, callerId],
  );
  return rows.map((g) => ({
    tenantId,
    id: g.id,
    roleId: g.role_id,
    resourceType: g.resource_type as Grant["resourceType"],
    resourceFacet: g.resource_facet ?? undefined,
    operation: g.operation as Grant["operation"],
    scope: g.scope as Grant["scope"],
    constraint: g.constraint ?? undefined,
    delegable: g.delegable,
    grantedBy: g.granted_by,
    validFrom: g.valid_from != null ? Number(g.valid_from) : undefined,
    validUntil: g.valid_until != null ? Number(g.valid_until) : undefined,
    createdAt: Number(g.created_at),
  }));
}

// ---------------------------------------------------------------------------
// validateInvokeBody — parse and validate request body
// ---------------------------------------------------------------------------

interface InvokeBody {
  target_agent_id: string;
  goal: string;
  context?: unknown;
}

function validateInvokeBody(body: unknown): InvokeBody {
  if (body === null || typeof body !== "object") {
    throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  const targetAgentId = b["target_agent_id"];
  if (typeof targetAgentId !== "string" || !UUID_RE.test(targetAgentId)) {
    throw new HttpError(400, "VALIDATION", "target_agent_id must be a valid UUID");
  }

  const goal = b["goal"];
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new HttpError(400, "VALIDATION", "goal must be a non-empty string");
  }

  return {
    target_agent_id: targetAgentId,
    goal: goal.trim(),
    context: b["context"],
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerInvokeRoutes(router: Router, pool: pg.Pool): void {

  // ---------- POST /api/invoke/request (FR-3 / AC-1/2/5/7/8/9/10/11) -------
  router.register("POST", "/api/invoke/request", async (req, res) => {
    const callerId = extractActor(req);
    const tenantId = DEV_TENANT_ID;
    const nowMs = Date.now();

    const rawBody = await readJsonBody(req);
    const body = validateInvokeBody(rawBody);

    const { target_agent_id: targetAgentId, goal, context } = body;
    assertUuidShape(targetAgentId, "target_agent_id");

    const result = await withTenantTx(pool, tenantId, async (client) => {
      // FR-8: validate target is a provisioned agent
      const agentCard = await loadAgentCard(client, tenantId, targetAgentId);
      if (!agentCard) {
        throw new HttpError(400, "VALIDATION", "target_agent_id is not a provisioned agent");
      }

      // Load target's active role assignment
      const roleAssignment = await loadActiveRoleAssignment(client, tenantId, targetAgentId);
      if (!roleAssignment) {
        throw new HttpError(400, "VALIDATION", "target agent has no active role assignment");
      }

      const targetRoleId = roleAssignment.role_id;
      const targetOrgScope = roleAssignment.org_scope as ScopeElement;

      // Load caller's invoke-grants (NF-4: fail-closed)
      const grants = await loadCallerInvokeGrants(client, tenantId, callerId);

      // Find a covering grant
      const coveringGrant = grants.find((g) =>
        coversInvoke(g, targetRoleId, targetOrgScope, nowMs, SEED_ORACLE),
      );

      // NF-4: fail-closed — no row, no audit if no grant
      if (!coveringGrant) {
        throw new HttpError(403, "FORBIDDEN", "no covering invoke-grant for this agent");
      }

      // Insert invoke_proposal (status='proposed')
      const proposalId = randomUUID();
      await client.query(
        `INSERT INTO choros.invoke_proposal
           (tenant_id, id, caller_id, target_id, goal, context, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'proposed', $7)`,
        [tenantId, proposalId, callerId, targetAgentId, goal, context ?? null, nowMs],
      );

      // Audit "invoke.request" (AC-5)
      const invokeEvt: InvokeAuditEvent = {
        kind: "invoke.request",
        actor: callerId,
        targetAgentId,
        agentRoleId: targetRoleId,
        orgScope: targetOrgScope,
        goal,
      };
      await writeInvokeAuditEvent(client, tenantId, invokeEvt, nowMs);

      return { id: proposalId };
    });

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });

  // ---------- POST /api/invoke/command (FR-4 / AC-3/4/6/7) -----------------
  router.register("POST", "/api/invoke/command", async (req, res) => {
    const callerId = extractActor(req);
    const tenantId = DEV_TENANT_ID;
    const nowMs = Date.now();

    const rawBody = await readJsonBody(req);
    const body = validateInvokeBody(rawBody);

    const { target_agent_id: targetAgentId, goal } = body;
    assertUuidShape(targetAgentId, "target_agent_id");

    const result = await withTenantTx(pool, tenantId, async (client) => {
      // FR-8: validate target is a provisioned agent
      const agentCard = await loadAgentCard(client, tenantId, targetAgentId);
      if (!agentCard) {
        throw new HttpError(400, "VALIDATION", "target_agent_id is not a provisioned agent");
      }

      // Load target's active role assignment
      const roleAssignment = await loadActiveRoleAssignment(client, tenantId, targetAgentId);
      if (!roleAssignment) {
        throw new HttpError(400, "VALIDATION", "target agent has no active role assignment");
      }

      const targetRoleId = roleAssignment.role_id;
      const targetOrgScope = roleAssignment.org_scope as ScopeElement;

      // Load caller's invoke-grants
      const grants = await loadCallerInvokeGrants(client, tenantId, callerId);

      // Find a covering grant
      const coveringGrant = grants.find((g) =>
        coversInvoke(g, targetRoleId, targetOrgScope, nowMs, SEED_ORACLE),
      );

      // Fail-closed
      if (!coveringGrant) {
        throw new HttpError(403, "FORBIDDEN", "no covering invoke-grant for this agent");
      }

      // Day-1: dispatch is a no-op stub (Stage-2 connects real dispatch)
      const invocationId = randomUUID();

      // Audit "invoke.command" (AC-6)
      const invokeEvt: InvokeAuditEvent = {
        kind: "invoke.command",
        actor: callerId,
        targetAgentId,
        agentRoleId: targetRoleId,
        orgScope: targetOrgScope,
        goal,
      };
      await writeInvokeAuditEvent(client, tenantId, invokeEvt, nowMs);

      return { invocation_id: invocationId };
    });

    res.statusCode = 202;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });
}
