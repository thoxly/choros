/**
 * src/http/rights-change-requests.ts — T-0390 [D2-FU]
 *
 * Dual-control change-request read + decision API for the ra-criticality screen.
 *
 * Routes (all tenant-scoped, auth-gated):
 *   GET  /api/rights/change-requests          — list pending semi-confirmed
 *                                               grants and role_assignments
 *   POST /api/rights/change-requests/:id/approve — second-person dual-control
 *                                                   approval (sets confirmed2_by)
 *   POST /api/rights/change-requests/:id/reject  — reject / delete the
 *                                                   semi-confirmed row
 *
 * ── What "pending change request" means ──────────────────────────────────────
 * The existing kernel writes critical (escalating) grants and role_assignments
 * with:
 *   confirmed_by IS NOT NULL   ← first authenticated approver (actor1)
 *   confirmed2_by IS NULL      ← awaiting a DISTINCT second approver (dual-control)
 *
 * These rows are NOT active (the read-path PDP requires confirmed2_by IS NOT NULL
 * for critical/escalating changes). This module surfaces them as "pending change
 * requests" so the second approver can act from the ra-criticality screen.
 *
 * ── Dual-control invariants enforced ────────────────────────────────────────
 *   DC-1: approver MUST be a different person than the first confirmer
 *          (actor !== confirmed_by).
 *   DC-2: approver MUST also differ from proposed_by when it is set
 *          (actor !== proposed_by).
 *   DC-3: agents (employee.kind = 'agent') CANNOT be approvers.
 *          Enforced by requiring actor to resolve to a human employee.
 *
 * ── Tenant isolation ────────────────────────────────────────────────────────
 * Every query sets `SET LOCAL choros.tenant_id` + `search_path TO choros`
 * (RLS). Actor is resolved to their own tenant via resolveActorTenant — the
 * handler never trusts a body-supplied tenantId.
 *
 * ── Rule-9 ──────────────────────────────────────────────────────────────────
 * Does NOT touch: src/http/inbox.ts, src/http/process-defs.ts,
 * src/runtime/agent-dispatch/, the modeler, src/core/role-criticality.ts.
 * Grants.ts is NOT modified — the approve path mirrors handleSecondConfirm
 * logic with its own copy so grants.ts stays frozen. The reject path deletes
 * the semi-confirmed row (it was never active) and emits an audit event.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  resolveActorTenant,
  resolveActorSlugFromAuth,
} from "../db/org.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";

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
// Types
// ---------------------------------------------------------------------------

export interface ChangeRequest {
  /** Unique identifier — the grant or role_assignment UUID. */
  id: string;
  kind: "grant" | "assignment";
  /** Human-readable display of what capability / position this request covers. */
  description: string;
  /** The role this grant / assignment is attached to. */
  role_id: string;
  role_name: string | null;
  /** Who submitted the first confirmation (actor1). */
  proposed_by: string | null;
  confirmed_by: string;
  /** Epoch ms when the row was created. */
  created_at: number;
  /** Extra details (resource_type + operation for grants; employee info for assignments). */
  details: Record<string, unknown>;
}

export interface ChangeRequestListResponse {
  change_requests: ChangeRequest[];
  total: number;
}

// ---------------------------------------------------------------------------
// Audit sink
// ---------------------------------------------------------------------------

const crAuditWriter = makePgAuditWriter();

// ---------------------------------------------------------------------------
// withTenantTx helper
// Each file owns its own copy so peer files stay frozen (ADR §9.6).
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
// Actor extraction — Keycloak-aware (mirrors grants.ts pattern, T-0389)
// ---------------------------------------------------------------------------

async function extractActorFromReq(
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
// DC-3: guard — reject if the approver is an agent (not human)
// ---------------------------------------------------------------------------

async function assertApproverIsHuman(
  pool: pg.Pool,
  tenantId: string,
  actorSlug: string,
): Promise<void> {
  const { rows } = await pool.query<{ kind: string }>(
    `SELECT kind FROM choros.employee
      WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
    [tenantId, actorSlug],
  );
  if (rows.length === 0) {
    throw new HttpError(403, "FORBIDDEN", "actor not found in this tenant");
  }
  if (rows[0].kind !== "human") {
    throw new HttpError(403, "AGENT_NOT_ALLOWED", "agents cannot approve dual-control change requests");
  }
}

// ---------------------------------------------------------------------------
// LIST — GET /api/rights/change-requests
// Returns all semi-confirmed grants + role_assignments for the tenant.
// Semi-confirmed = confirmed_by IS NOT NULL AND confirmed2_by IS NULL.
// These are pending dual-control approval and are NOT active on the read-path.
// ---------------------------------------------------------------------------

async function listChangeRequests(
  pool: pg.Pool,
  tenantId: string,
): Promise<ChangeRequestListResponse> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");

    // Semi-confirmed grants: confirmed_by IS NOT NULL AND confirmed2_by IS NULL.
    const { rows: grantRows } = await client.query<{
      id: string;
      role_id: string;
      role_name: string | null;
      resource_type: string;
      operation: string;
      scope: unknown;
      proposed_by: string | null;
      confirmed_by: string;
      created_at: string;
    }>(
      `SELECT g.id, g.role_id,
              r.name AS role_name,
              g.resource_type, g.operation, g.scope,
              g.proposed_by, g.confirmed_by, g.created_at
         FROM choros."grant" g
         LEFT JOIN choros.role r ON r.tenant_id = g.tenant_id AND r.id = g.role_id
        WHERE g.tenant_id = $1
          AND g.confirmed_by IS NOT NULL
          AND g.confirmed2_by IS NULL
        ORDER BY g.created_at DESC`,
      [tenantId],
    );

    // Semi-confirmed role_assignments: confirmed_by IS NOT NULL AND confirmed2_by IS NULL.
    const { rows: raRows } = await client.query<{
      id: string;
      role_id: string;
      role_name: string | null;
      employee_id: string;
      employee_slug: string | null;
      employee_display: string | null;
      proposed_by: string | null;
      confirmed_by: string;
      created_at: string;
    }>(
      `SELECT ra.id, ra.role_id,
              r.name AS role_name,
              ra.employee_id,
              e.slug AS employee_slug,
              e.display_name AS employee_display,
              ra.proposed_by, ra.confirmed_by, ra.created_at
         FROM choros.role_assignment ra
         LEFT JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
         LEFT JOIN choros.employee e ON e.tenant_id = ra.tenant_id AND e.id = ra.employee_id
        WHERE ra.tenant_id = $1
          AND ra.confirmed_by IS NOT NULL
          AND ra.confirmed2_by IS NULL
        ORDER BY ra.created_at DESC`,
      [tenantId],
    );

    await client.query("COMMIT");

    const items: ChangeRequest[] = [
      ...grantRows.map((g) => ({
        id: g.id,
        kind: "grant" as const,
        description: `${g.resource_type}:${g.operation}`,
        role_id: g.role_id,
        role_name: g.role_name,
        proposed_by: g.proposed_by,
        confirmed_by: g.confirmed_by,
        created_at: Number(g.created_at),
        details: {
          resource_type: g.resource_type,
          operation: g.operation,
          scope: g.scope,
        },
      })),
      ...raRows.map((ra) => ({
        id: ra.id,
        kind: "assignment" as const,
        description: `Назначение роли${ra.role_name ? ` «${ra.role_name}»` : ""}${ra.employee_display ? ` для ${ra.employee_display}` : ""}`,
        role_id: ra.role_id,
        role_name: ra.role_name,
        proposed_by: ra.proposed_by,
        confirmed_by: ra.confirmed_by,
        created_at: Number(ra.created_at),
        details: {
          employee_id: ra.employee_id,
          employee_slug: ra.employee_slug,
          employee_display: ra.employee_display,
        },
      })),
    ];

    // Sort combined list by created_at descending.
    items.sort((a, b) => b.created_at - a.created_at);

    return { change_requests: items, total: items.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// APPROVE — POST /api/rights/change-requests/:id/approve
//
// Transitions a semi-confirmed grant or role_assignment to confirmed by
// setting confirmed2_by = actor (second approver).
//
// DC-1: actor MUST differ from confirmed_by (the first approver).
// DC-2: actor MUST differ from proposed_by (if set).
// DC-3: actor MUST be a human employee (not an agent).
// Idempotent guard: 409 if already confirmed2_by IS NOT NULL.
// ---------------------------------------------------------------------------

async function approveChangeRequest(args: {
  pool: pg.Pool;
  tenantId: string;
  actor: string;
  changeId: string;
  nowMs: number;
}): Promise<{ id: string; kind: "grant" | "assignment"; state: "confirmed" }> {
  const { pool, tenantId, actor, changeId, nowMs } = args;

  return withTenantTx(pool, tenantId, async (client) => {
    // Try grant table first (most common).
    const { rows: grantRows } = await client.query<{
      proposed_by: string | null;
      confirmed_by: string;
      confirmed2_by: string | null;
    }>(
      `SELECT proposed_by, confirmed_by, confirmed2_by
         FROM choros."grant"
        WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, changeId],
    );

    let changeKind: "grant" | "assignment";

    if (grantRows.length > 0) {
      changeKind = "grant";
      const row = grantRows[0];

      if (row.confirmed2_by !== null) {
        throw new HttpError(409, "ALREADY_CONFIRMED", "change request already has a second approver");
      }
      // DC-1 + DC-2: distinct-person enforcement.
      if (actor === row.confirmed_by || actor === row.proposed_by) {
        throw new HttpError(
          409,
          "DUAL_CONTROL_SELF_APPROVE",
          "approver must be a different person than the proposer and first confirmer",
        );
      }

      const upd = await client.query(
        `UPDATE choros."grant"
            SET confirmed2_by = $3
          WHERE tenant_id = $1 AND id = $2 AND confirmed2_by IS NULL`,
        [tenantId, changeId, actor],
      );
      if (upd.rowCount === 0) {
        throw new HttpError(409, "ALREADY_CONFIRMED", "concurrent confirmation detected");
      }
    } else {
      // Try role_assignment table.
      const { rows: raRows } = await client.query<{
        proposed_by: string | null;
        confirmed_by: string;
        confirmed2_by: string | null;
      }>(
        `SELECT proposed_by, confirmed_by, confirmed2_by
           FROM choros.role_assignment
          WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [tenantId, changeId],
      );

      if (raRows.length === 0) {
        throw new HttpError(404, "NOT_FOUND", `change request ${changeId} not found`);
      }

      changeKind = "assignment";
      const row = raRows[0];

      if (row.confirmed2_by !== null) {
        throw new HttpError(409, "ALREADY_CONFIRMED", "change request already has a second approver");
      }
      // DC-1 + DC-2: distinct-person enforcement.
      if (actor === row.confirmed_by || actor === row.proposed_by) {
        throw new HttpError(
          409,
          "DUAL_CONTROL_SELF_APPROVE",
          "approver must be a different person than the proposer and first confirmer",
        );
      }

      const upd = await client.query(
        `UPDATE choros.role_assignment
            SET confirmed2_by = $3, updated_at = $4
          WHERE tenant_id = $1 AND id = $2 AND confirmed2_by IS NULL`,
        [tenantId, changeId, actor, nowMs],
      );
      if (upd.rowCount === 0) {
        throw new HttpError(409, "ALREADY_CONFIRMED", "concurrent confirmation detected");
      }
    }

    // Audit event.
    await crAuditWriter.appendAuditEvent(client as unknown as PgClientLike, {
      id: randomUUID(),
      type: "change_request.approved",
      actor,
      subject: changeId,
      scope: null,
      via: "rights-change-requests.approve",
      proposed_by: null,
      confirmed_by: actor,
      payload: { change_id: changeId, change_kind: changeKind },
      occurred_at: nowMs,
    });

    return { id: changeId, kind: changeKind, state: "confirmed" };
  });
}

// ---------------------------------------------------------------------------
// REJECT — POST /api/rights/change-requests/:id/reject
//
// Removes the semi-confirmed row (it was never active — confirmed2_by IS NULL
// means the PDP never sees it). Audited as change_request.rejected.
// The actor must be a human (DC-3) but may be the same as confirmed_by
// (the first approver may self-reject/cancel a request they created).
// ---------------------------------------------------------------------------

async function rejectChangeRequest(args: {
  pool: pg.Pool;
  tenantId: string;
  actor: string;
  changeId: string;
  reason: string | null;
  nowMs: number;
}): Promise<{ id: string; kind: "grant" | "assignment"; state: "rejected" }> {
  const { pool, tenantId, actor, changeId, reason, nowMs } = args;

  return withTenantTx(pool, tenantId, async (client) => {
    // Try grant table first.
    const { rows: grantRows } = await client.query<{ confirmed2_by: string | null }>(
      `SELECT confirmed2_by FROM choros."grant"
        WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, changeId],
    );

    let changeKind: "grant" | "assignment";

    if (grantRows.length > 0) {
      changeKind = "grant";
      const row = grantRows[0];
      if (row.confirmed2_by !== null) {
        // Already confirmed — cannot reject a live row.
        throw new HttpError(409, "ALREADY_CONFIRMED", "cannot reject an already-confirmed change request");
      }
      // Soft-delete: set valid_until = now so PDP never activates it.
      // The row stays for audit purposes (we could also hard-DELETE but this is
      // safer — audit trail intact, zero schema changes, mirrors urgent-revoke).
      await client.query(
        `UPDATE choros."grant" SET valid_until = $3
          WHERE tenant_id = $1 AND id = $2 AND confirmed2_by IS NULL`,
        [tenantId, changeId, nowMs],
      );
    } else {
      // Try role_assignment.
      const { rows: raRows } = await client.query<{ confirmed2_by: string | null }>(
        `SELECT confirmed2_by FROM choros.role_assignment
          WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [tenantId, changeId],
      );
      if (raRows.length === 0) {
        throw new HttpError(404, "NOT_FOUND", `change request ${changeId} not found`);
      }

      changeKind = "assignment";
      const row = raRows[0];
      if (row.confirmed2_by !== null) {
        throw new HttpError(409, "ALREADY_CONFIRMED", "cannot reject an already-confirmed change request");
      }
      await client.query(
        `UPDATE choros.role_assignment SET valid_until = $3, updated_at = $4
          WHERE tenant_id = $1 AND id = $2 AND confirmed2_by IS NULL`,
        [tenantId, changeId, nowMs, nowMs],
      );
    }

    // Audit event.
    await crAuditWriter.appendAuditEvent(client as unknown as PgClientLike, {
      id: randomUUID(),
      type: "change_request.rejected",
      actor,
      subject: changeId,
      scope: null,
      via: "rights-change-requests.reject",
      proposed_by: null,
      confirmed_by: null,
      payload: { change_id: changeId, change_kind: changeKind, reason },
      occurred_at: nowMs,
    });

    return { id: changeId, kind: changeKind, state: "rejected" };
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register the rights change-request dual-control API routes.
 * Must be called from server.ts inside the `if (grantsPool)` block,
 * BEFORE registerRightsIntentRoutes so the fixed literal paths
 * (/api/rights/change-requests) are registered before :id catch-alls.
 */
export function registerRightsChangeRequestRoutes(
  router: Router,
  pool: pg.Pool,
): void {
  // ---- GET /api/rights/change-requests ----
  router.register("GET", "/api/rights/change-requests", withAuth(async (req, res) => {
    const actorId = await extractActorFromReq(req, pool);
    const tenantId = await resolveActorTenant(pool, actorId);

    const result = await listChangeRequests(pool, tenantId);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  }));

  // ---- POST /api/rights/change-requests/:id/approve ----
  router.register(
    "POST",
    "/api/rights/change-requests/:id/approve",
    withAuth(async (req, res, params) => {
      const changeId = params.id as string;
      assertUuidShape(changeId, "id");

      const actorId = await extractActorFromReq(req, pool);
      const tenantId = await resolveActorTenant(pool, actorId);
      const nowMs = Date.now();

      // DC-3: reject if the actor is an agent.
      await assertApproverIsHuman(pool, tenantId, actorId);

      const result = await approveChangeRequest({ pool, tenantId, actor: actorId, changeId, nowMs });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    }),
  );

  // ---- POST /api/rights/change-requests/:id/reject ----
  router.register(
    "POST",
    "/api/rights/change-requests/:id/reject",
    withAuth(async (req, res, params) => {
      const changeId = params.id as string;
      assertUuidShape(changeId, "id");

      const actorId = await extractActorFromReq(req, pool);
      const tenantId = await resolveActorTenant(pool, actorId);
      const nowMs = Date.now();

      // DC-3: agents cannot reject either.
      await assertApproverIsHuman(pool, tenantId, actorId);

      // Optional reason from body.
      let reason: string | null = null;
      try {
        const body = await readJsonBody(req);
        const b = body as Record<string, unknown>;
        if (typeof b["reason"] === "string") reason = b["reason"];
      } catch {
        // Body is optional for reject — continue without a reason if parse fails.
      }

      const result = await rejectChangeRequest({
        pool, tenantId, actor: actorId, changeId, reason, nowMs,
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    }),
  );
}
