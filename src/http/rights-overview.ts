/**
 * src/http/rights-overview.ts — T-0572 [D2/D5]
 *
 * Honest READ of tenant rights-state for the «Доступ» screen (§0/FR-1 spec,
 * ADR §2.1). Replaces the demo-pack / RIGHTS_SEED lie the old GET /api/rights
 * (src/http/rights.ts) tells: THIS endpoint reads the REAL
 * choros.role / choros.role_assignment / choros."grant" rows for the tenant
 * of the AUTHENTICATED caller — never a query parameter, never a fixture.
 *
 * Route:
 *   GET /api/rights/tenant-state
 *
 * ── Why a NEW file, not rights.ts ────────────────────────────────────────────
 * rights.ts carries a declared zero-`pg`-import invariant (FF-DISPLAY-4) for
 * its no-DB / demo-pack display plane. FR-1 requires live DB reads, which
 * would break that invariant. ADR §2.1 / §4-alt-1: new file, rights.ts stays
 * untouched (frozen, only imported nowhere — genuinely independent).
 *
 * ── Two projections (FR-6, FR-7, ADR §2.2) ──────────────────────────────────
 *   admin/owner  (isGenesisOwner || adminGrants.length > 0, via loadAdminContext)
 *     scope: "tenant", can_manage: true  — ALL roles of the tenant, with their
 *     active assignments/grants + a separate `pending` bucket for
 *     semi-confirmed rows (NEVER merged into the active arrays — FR-5/AC-8).
 *   ordinary user (no admin authority)
 *     scope: "self", can_manage: false — ONLY the roles the caller holds
 *     (assignments filtered to `employee_id = caller`), no `pending` bucket
 *     (an ordinary user does not participate in the grant-approval workflow).
 * Fail-closed: any resolution error on admin authority is treated as a
 * self-projection, never widened to tenant (mirrors nav-capabilities honesty).
 *
 * ── "Active" predicate (ADR §2.1, mirrors grants.ts write semantics) ────────
 * A grant/assignment row is ACTIVE iff:
 *   confirmed_by IS NOT NULL
 *   AND (confirmed2_by IS NOT NULL OR proposed_by IS NULL)
 *   AND in-window (valid_from/valid_until straddle now, when applicable)
 * A row is PENDING (semi-confirmed, NOT active) iff:
 *   confirmed_by IS NOT NULL AND confirmed2_by IS NULL AND proposed_by IS NOT NULL
 * This mirrors exactly how src/http/grants.ts WRITES rows: the routine
 * (non-escalating) path sets proposed_by=NULL confirmed_by=actor
 * confirmed2_by=NULL and is immediately active; the escalating path sets
 * proposed_by=actor confirmed_by=actor confirmed2_by=NULL and stays pending
 * until a distinct second approver confirms (confirmed2_by set) via the
 * existing /api/rights/change-requests/:id/approve inbox (rights-change-
 * requests.ts, T-0390) — NOT duplicated here (NF-1).
 *
 * ── N+1 discipline (ADR §2.1, AC-1) ──────────────────────────────────────────
 * One transaction, three queries total (roles / all-role assignments+employee
 * JOIN / all-role grants) — NOT one query per role. Aggregation is in-memory
 * keyed by role_id.
 *
 * ── Rule-9 / frozen surfaces ─────────────────────────────────────────────────
 * Does NOT touch (import-only): src/http/grants.ts, src/http/rights.ts,
 * src/http/rights-change-requests.ts, src/core/dual-control.ts,
 * src/core/role-criticality.ts, src/core/grant-resolver.ts,
 * src/core/grant-lattice.ts. This is a READ-ONLY module — no INSERT/UPDATE/
 * DELETE anywhere in this file (FF-T0572-FROZEN / NF-1).
 */

import pg from "pg";
import {
  resolveActorTenant,
  resolveActorSlugFromAuth,
  loadAdminContext,
} from "../db/org.js";
import { HttpError, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";

// ---------------------------------------------------------------------------
// Types (mirrors ADR §6.1 object model verbatim)
// ---------------------------------------------------------------------------

export interface OverviewAssignment {
  id: string;
  employee_id: string;
  employee_slug: string | null;
  employee_display: string | null;
  employee_kind: "human" | "agent" | "service";
  org_scope: unknown;
  // T-0608 (F-1 fix): validity window surfaced so the client can dedup by the
  // FULL composite identity of an assignment (employee + org_scope + window) —
  // migrations/020_role_assignment.sql:29-32 documents NO UNIQUE(employee_id,
  // role_id): the same (employee, role) legitimately coexists across different
  // org_scope/window (e.g. "approver in fin until Q3, in cs from Q4"). Those
  // are NOT duplicates — collapsing them by employee_id alone hides scopes and
  // makes a single "Отозвать" revoke MORE than the admin intends. epoch-ms;
  // null = open-ended (no lower/upper bound).
  valid_from: number | null;
  valid_until: number | null;
  state: "active";
}

export interface OverviewGrant {
  id: string;
  resource_type: string;
  operation: string;
  resource_facet: unknown | null;
  scope: unknown;
  state: "active";
}

export interface OverviewPendingAssignment {
  id: string;
  employee_display: string | null;
  confirmed_by: string | null;
}

export interface OverviewPendingGrant {
  id: string;
  description: string;
  confirmed_by: string | null;
}

export interface OverviewPending {
  assignments: OverviewPendingAssignment[];
  grants: OverviewPendingGrant[];
}

export interface OverviewRole {
  id: string;
  slug: string;
  name: string | null;
  assignments: OverviewAssignment[];
  grants: OverviewGrant[];
  pending: OverviewPending;
}

export interface TenantStateResponse {
  scope: "tenant" | "self";
  can_manage: boolean;
  roles: OverviewRole[];
}

// ---------------------------------------------------------------------------
// UUID guard (defense-in-depth, mirrors grants.ts / rights-change-requests.ts)
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// withTenantReadTx — own copy so peer files stay frozen (ADR §9.6 convention,
// same as rights-change-requests.ts / rights-sod.ts).
// ---------------------------------------------------------------------------

async function withTenantReadTx<T>(
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
// Actor extraction — Keycloak-aware (mirrors grants.ts / rights-change-
// requests.ts pattern, T-0389).
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
// resolveCallerEmployeeId — the caller's OWN choros.employee.id within the
// resolved tenant (used to scope the "self" projection — AC-10). Resolved
// INSIDE the tenant transaction so it participates in the same RLS/GUC scope
// as the rest of the read.
// ---------------------------------------------------------------------------

async function resolveCallerEmployeeId(
  client: pg.PoolClient,
  tenantId: string,
  actorSlug: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
    [tenantId, actorSlug],
  );
  return rows.length > 0 ? rows[0].id : null;
}

// ---------------------------------------------------------------------------
// loadTenantState — the core aggregation (ADR §2.1/§6.1).
//
// selfEmployeeId: when non-null, the assignments/pending-assignments arrays
// are filtered to this employee only (the "self" projection, AC-10) — the
// filter runs server-side against the value resolved from AUTH, never a
// client-supplied parameter (there is no such parameter on this endpoint).
// ---------------------------------------------------------------------------

async function loadTenantState(
  pool: pg.Pool,
  tenantId: string,
  nowMs: number,
  selfEmployeeId: string | null,
): Promise<OverviewRole[]> {
  return withTenantReadTx(pool, tenantId, async (client) => {
    // 1. All roles of the tenant.
    const { rows: roleRows } = await client.query<{
      id: string;
      slug: string;
      display_name: string | null;
    }>(
      `SELECT id, slug, display_name FROM choros.role WHERE tenant_id = $1 ORDER BY slug`,
      [tenantId],
    );

    const roleIds = roleRows.map((r) => r.id);
    const byRole = new Map<string, OverviewRole>();
    for (const r of roleRows) {
      byRole.set(r.id, {
        id: r.id,
        slug: r.slug,
        name: r.display_name,
        assignments: [],
        grants: [],
        pending: { assignments: [], grants: [] },
      });
    }

    if (roleIds.length === 0) {
      return [];
    }

    // 2. ALL role_assignment rows for ALL roles of the tenant, JOINed with
    //    employee for human-readable display — ONE query, not one per role
    //    (N+1 discipline, AC-1).
    const { rows: raRows } = await client.query<{
      id: string;
      role_id: string;
      employee_id: string;
      employee_slug: string | null;
      employee_display: string | null;
      employee_kind: string | null;
      org_scope: unknown;
      proposed_by: string | null;
      confirmed_by: string | null;
      confirmed2_by: string | null;
      valid_from: string | null;
      valid_until: string | null;
    }>(
      `SELECT ra.id, ra.role_id, ra.employee_id,
              e.slug AS employee_slug,
              e.display_name AS employee_display,
              e.kind AS employee_kind,
              ra.org_scope,
              ra.proposed_by, ra.confirmed_by, ra.confirmed2_by,
              ra.valid_from, ra.valid_until
         FROM choros.role_assignment ra
         LEFT JOIN choros.employee e
                ON e.tenant_id = ra.tenant_id AND e.id = ra.employee_id
        WHERE ra.tenant_id = $1
          AND ra.role_id = ANY($2::uuid[])`,
      [tenantId, roleIds],
    );

    for (const ra of raRows) {
      const role = byRole.get(ra.role_id);
      if (!role) continue;
      // Self-projection filter (AC-10): server-side, against the AUTH-resolved
      // employee id — never a client-supplied param (this endpoint has none).
      if (selfEmployeeId !== null && ra.employee_id !== selfEmployeeId) {
        continue;
      }

      const inWindow =
        (ra.valid_from === null || Number(ra.valid_from) <= nowMs) &&
        (ra.valid_until === null || Number(ra.valid_until) > nowMs);

      const isActive =
        ra.confirmed_by !== null &&
        (ra.confirmed2_by !== null || ra.proposed_by === null) &&
        inWindow;

      const isPending =
        ra.confirmed_by !== null &&
        ra.confirmed2_by === null &&
        ra.proposed_by !== null;

      if (isActive) {
        role.assignments.push({
          id: ra.id,
          employee_id: ra.employee_id,
          employee_slug: ra.employee_slug,
          employee_display: ra.employee_display,
          employee_kind: (ra.employee_kind === "agent" ? "agent" : "human") as
            | "human"
            | "agent"
            | "service",
          org_scope: ra.org_scope,
          // T-0608 (F-1): surface the window (epoch-ms) so the client's dedup
          // key is the FULL assignment identity, not just employee_id.
          valid_from: ra.valid_from === null ? null : Number(ra.valid_from),
          valid_until: ra.valid_until === null ? null : Number(ra.valid_until),
          state: "active",
        });
      } else if (isPending) {
        role.pending.assignments.push({
          id: ra.id,
          employee_display: ra.employee_display,
          confirmed_by: ra.confirmed_by,
        });
      }
    }

    // 3. ALL grant rows for ALL roles of the tenant — ONE query (AC-1).
    const { rows: grantRows } = await client.query<{
      id: string;
      role_id: string;
      resource_type: string;
      resource_facet: unknown;
      operation: string;
      scope: unknown;
      proposed_by: string | null;
      confirmed_by: string | null;
      confirmed2_by: string | null;
      valid_from: string | null;
      valid_until: string | null;
    }>(
      `SELECT g.id, g.role_id, g.resource_type, g.resource_facet,
              g.operation, g.scope,
              g.proposed_by, g.confirmed_by, g.confirmed2_by,
              g.valid_from, g.valid_until
         FROM choros."grant" g
        WHERE g.tenant_id = $1
          AND g.role_id = ANY($2::uuid[])`,
      [tenantId, roleIds],
    );

    for (const g of grantRows) {
      const role = byRole.get(g.role_id);
      if (!role) continue;
      // Grants are attached to a ROLE, not an employee — in the self
      // projection they're kept only for roles the caller actually holds
      // (which is exactly the set of roles left non-empty after the
      // assignment filter above); a role with 0 self-assignments in this
      // projection is filtered out entirely at the end (see below), so
      // grants attached to a role the caller does not hold never leak.

      const inWindow =
        (g.valid_from === null || Number(g.valid_from) <= nowMs) &&
        (g.valid_until === null || Number(g.valid_until) > nowMs);

      const isActive =
        g.confirmed_by !== null &&
        (g.confirmed2_by !== null || g.proposed_by === null) &&
        inWindow;

      const isPending =
        g.confirmed_by !== null &&
        g.confirmed2_by === null &&
        g.proposed_by !== null;

      if (isActive) {
        role.grants.push({
          id: g.id,
          resource_type: g.resource_type,
          operation: g.operation,
          resource_facet: g.resource_facet ?? null,
          scope: g.scope,
          state: "active",
        });
      } else if (isPending) {
        role.pending.grants.push({
          id: g.id,
          description: `${g.resource_type}:${g.operation}`,
          confirmed_by: g.confirmed_by,
        });
      }
    }

    let roles = Array.from(byRole.values());

    // Self projection (AC-9/AC-10): only roles the caller actually holds
    // (i.e. has at least one active OR pending assignment surfaced above) are
    // returned — an ordinary user never sees the tenant's full role catalogue,
    // only "their" slice of it.
    if (selfEmployeeId !== null) {
      roles = roles.filter(
        (r) => r.assignments.length > 0 || r.pending.assignments.length > 0,
      );
    }

    return roles;
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register GET /api/rights/tenant-state.
 *
 * Must be called from server.ts inside the `if (grantsPool)` block, BEFORE
 * registerRightsRoutes — the fixed literal path /api/rights/tenant-state must
 * not fall through to the GET /api/rights/:roleId catch-all (first-match-wins
 * routing, same ordering discipline as change-requests/sod).
 */
export function registerRightsOverviewRoutes(router: Router, pool: pg.Pool): void {
  router.register(
    "GET",
    "/api/rights/tenant-state",
    withAuth(async (req, res) => {
      const actorId = await extractActorFromReq(req, pool);
      const tenantId = await resolveActorTenant(pool, actorId);
      const nowMs = Date.now();

      // Fail-closed: any resolution error surfaces as self-projection, never
      // widened to admin (mirrors the fail-closed discipline of
      // GET /api/me/nav-capabilities).
      let canManage = false;
      try {
        const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);
        canManage = admin.isGenesisOwner || admin.adminGrants.length > 0;
      } catch {
        canManage = false;
      }

      const scope: "tenant" | "self" = canManage ? "tenant" : "self";

      let selfEmployeeId: string | null = null;
      if (!canManage) {
        selfEmployeeId = await withTenantReadTx(pool, tenantId, (client) =>
          resolveCallerEmployeeId(client, tenantId, actorId),
        );
      }

      const roles = await loadTenantState(pool, tenantId, nowMs, selfEmployeeId);

      const body: TenantStateResponse = { scope, can_manage: canManage, roles };

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    }),
  );
}
