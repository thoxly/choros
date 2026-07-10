/**
 * src/http/rights-sod.ts — T-0391 [D2-FU]
 *
 * SoD (Segregation of Duties) read API for the ra-sod screen.
 *
 * Routes (all tenant-scoped, auth-gated):
 *   GET  /api/rights/sod-rules           — list the tenant's active SoD
 *                                          constraint declarations
 *   GET  /api/rights/sod-check?subjectId=:slug
 *                                        — given a subject (employee slug),
 *                                          report static SoD conflicts among
 *                                          their confirmed, in-window role
 *                                          assignments
 *
 * ── Data model ───────────────────────────────────────────────────────────────
 * The `choros.sod_constraint` table (migration 027) exists and holds the
 * constraint DECLARATIONS. There is no Postgres DAO implementing the full
 * SodSource interface (T-0053 was never built). This module queries the table
 * directly — SELECT only — and applies the static-SoD detection logic from
 * src/core/sod.ts in-process.
 *
 * Dynamic SoD (requires the ActorEventReader / actor_event trail) is NOT
 * covered by these read-API endpoints — it is an action-time guard in
 * grant-resolver.ts, not a displayable list. The UI shows static constraints
 * only; dynamic rules are flagged as "requires action context" in the response.
 *
 * ── sod-rules shape ──────────────────────────────────────────────────────────
 * {
 *   rules: Array<{
 *     id: string;
 *     kind: "static" | "dynamic";
 *     // static only:
 *     roleA?: { id: string; name: string };
 *     roleB?: { id: string; name: string };
 *     selfRecord: boolean;
 *     detail: Record<string, unknown> | null;
 *     createdAt: number;
 *   }>;
 *   total: number;
 * }
 *
 * ── sod-check shape ──────────────────────────────────────────────────────────
 * {
 *   subjectId: string;         // slug echo
 *   heldRoles: Array<{ id: string; name: string }>;
 *   conflicts: Array<{
 *     constraintId: string;
 *     kind: "static" | "dynamic";
 *     roleA: { id: string; name: string } | null;
 *     roleB: { id: string; name: string } | null;
 *     // dynamic constraints are not evaluable from role list alone:
 *     note?: string;
 *   }>;
 * }
 *
 * ── Tenant isolation ────────────────────────────────────────────────────────
 * Every query runs inside a tenant-scoped read transaction:
 *   SET LOCAL choros.tenant_id = '<uuid>'
 *   SET LOCAL search_path TO choros
 * plus RLS on sod_constraint (ENABLE + FORCE). Actor → tenant via
 * resolveActorTenant; the handler never trusts a query-supplied tenantId.
 *
 * ── Routing order ───────────────────────────────────────────────────────────
 * These routes use LITERAL paths (/api/rights/sod-rules, /api/rights/sod-check)
 * and MUST be registered BEFORE registerRightsRoutes (which adds the
 * GET /api/rights/:roleId catch-all). The catch-all uses first-match-wins; a
 * literal path registered first is never captured by a param slot. See server.ts
 * for the canonical ordering comment (mirrors the change-requests pattern).
 *
 * ── Rule-9 ──────────────────────────────────────────────────────────────────
 * Does NOT touch: src/http/inbox.ts, src/http/agent-dispatch/,
 * src/http/process-defs.ts, src/core/role-criticality.ts, src/db/grants-dao.ts.
 * The grants-dao read-path is not modified; this module queries sod_constraint
 * and role_assignment directly in its own withTenantReadTx.
 */

import pg from "pg";
import {
  resolveActorTenant,
  resolveActorSlugFromAuth,
} from "../db/org.js";
import { resolveActorPrivilege } from "../db/sandbox-gate-dao.js";
import { HttpError, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";

// ---------------------------------------------------------------------------
// withTenantReadTx — own copy so peers stay frozen (ADR §9.6)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

async function withTenantReadTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuid(tenantId, "tenantId");
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
// Actor extraction — Keycloak-aware (mirrors rights-change-requests.ts)
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
// Types
// ---------------------------------------------------------------------------

export interface SodRuleDto {
  id: string;
  kind: "static" | "dynamic";
  roleA: { id: string; name: string } | null;
  roleB: { id: string; name: string } | null;
  selfRecord: boolean;
  detail: Record<string, unknown> | null;
  createdAt: number;
}

export interface SodRulesResponse {
  rules: SodRuleDto[];
  total: number;
}

export interface HeldRoleDto {
  id: string;
  name: string;
}

export interface SodConflictDto {
  constraintId: string;
  kind: "static" | "dynamic";
  roleA: { id: string; name: string } | null;
  roleB: { id: string; name: string } | null;
  note?: string;
}

export interface SodCheckResponse {
  subjectId: string;
  heldRoles: HeldRoleDto[];
  conflicts: SodConflictDto[];
}

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------

interface SodConstraintRow {
  id: string;
  kind: string;
  role_a: string | null;
  role_b: string | null;
  role_a_name: string | null;
  role_b_name: string | null;
  self_record: boolean;
  detail: Record<string, unknown> | null;
  created_at: string;
}

interface RoleAssignmentRow {
  role_id: string;
  display_name: string;
}

// ---------------------------------------------------------------------------
// listSodRules — load all active sod_constraint rows for the tenant,
// LEFT JOIN role to resolve display names for both role_a and role_b.
// ---------------------------------------------------------------------------

async function listSodRules(
  pool: pg.Pool,
  tenantId: string,
): Promise<SodRulesResponse> {
  return withTenantReadTx(pool, tenantId, async (client) => {
    const { rows } = await client.query<SodConstraintRow>(
      `SELECT
         sc.id,
         sc.kind,
         sc.role_a,
         sc.role_b,
         ra.display_name AS role_a_name,
         rb.display_name AS role_b_name,
         sc.self_record,
         sc.detail,
         sc.created_at
       FROM choros.sod_constraint sc
       LEFT JOIN choros.role ra
         ON ra.tenant_id = sc.tenant_id AND ra.id = sc.role_a
       LEFT JOIN choros.role rb
         ON rb.tenant_id = sc.tenant_id AND rb.id = sc.role_b
      WHERE sc.tenant_id = $1
      ORDER BY sc.created_at ASC`,
      [tenantId],
    );

    const rules: SodRuleDto[] = rows.map((row) => ({
      id: row.id,
      kind: row.kind as "static" | "dynamic",
      roleA: row.role_a
        ? { id: row.role_a, name: row.role_a_name ?? row.role_a }
        : null,
      roleB: row.role_b
        ? { id: row.role_b, name: row.role_b_name ?? row.role_b }
        : null,
      selfRecord: row.self_record,
      detail: row.detail ?? null,
      createdAt: typeof row.created_at === "string"
        ? parseInt(row.created_at, 10)
        : (row.created_at as unknown as number),
    }));

    return { rules, total: rules.length };
  });
}

// ---------------------------------------------------------------------------
// checkSodForSubject — load the subject's confirmed, in-window role
// assignments, then detect which sod_constraint rows they violate.
//
// Static SoD: principal holds BOTH role_a AND role_b in a constraint → violation.
// Dynamic SoD: not evaluable from held roles alone (requires actor_event trail
// at action time) → returned as a non-evaluated note entry when the subject
// holds role_a (or any role if role_a is null).
// ---------------------------------------------------------------------------

async function checkSodForSubject(
  pool: pg.Pool,
  tenantId: string,
  subjectSlug: string,
): Promise<SodCheckResponse> {
  return withTenantReadTx(pool, tenantId, async (client) => {
    const nowMs = Date.now();

    // 1. Resolve slug → employee id.
    const { rows: empRows } = await client.query<{ id: string }>(
      `SELECT id FROM choros.employee
        WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
      [tenantId, subjectSlug],
    );
    if (empRows.length === 0) {
      throw new HttpError(404, "NOT_FOUND", `employee with slug "${subjectSlug}" not found`);
    }
    const employeeId = empRows[0]!.id;

    // 2. Confirmed, in-window role assignments with display names.
    const { rows: raRows } = await client.query<RoleAssignmentRow>(
      `SELECT ra.role_id, r.display_name
         FROM choros.role_assignment ra
         JOIN choros.role r
           ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        WHERE ra.tenant_id = $1
          AND ra.employee_id = $2
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $3)`,
      [tenantId, employeeId, nowMs],
    );

    const heldRoles: HeldRoleDto[] = raRows.map((r) => ({
      id: r.role_id,
      name: r.display_name,
    }));
    const heldRoleIds = new Set(raRows.map((r) => r.role_id));

    // 3. Load all active sod_constraints with role names.
    const { rows: constraintRows } = await client.query<SodConstraintRow>(
      `SELECT
         sc.id,
         sc.kind,
         sc.role_a,
         sc.role_b,
         ra.display_name AS role_a_name,
         rb.display_name AS role_b_name,
         sc.self_record,
         sc.detail,
         sc.created_at
       FROM choros.sod_constraint sc
       LEFT JOIN choros.role ra
         ON ra.tenant_id = sc.tenant_id AND ra.id = sc.role_a
       LEFT JOIN choros.role rb
         ON rb.tenant_id = sc.tenant_id AND rb.id = sc.role_b
      WHERE sc.tenant_id = $1
      ORDER BY sc.created_at ASC`,
      [tenantId],
    );

    // 4. Evaluate conflicts.
    const conflicts: SodConflictDto[] = [];

    for (const c of constraintRows) {
      const kind = c.kind as "static" | "dynamic";
      const roleADto = c.role_a
        ? { id: c.role_a, name: c.role_a_name ?? c.role_a }
        : null;
      const roleBDto = c.role_b
        ? { id: c.role_b, name: c.role_b_name ?? c.role_b }
        : null;

      if (kind === "static") {
        // Violation: subject holds BOTH role_a AND role_b.
        if (
          c.role_a !== null &&
          c.role_b !== null &&
          heldRoleIds.has(c.role_a) &&
          heldRoleIds.has(c.role_b)
        ) {
          conflicts.push({ constraintId: c.id, kind, roleA: roleADto, roleB: roleBDto });
        }
      } else {
        // Dynamic constraint: only evaluable at action time (actor_event trail
        // not available in a list endpoint). Surface as informational note when
        // the subject holds role_a (or any role if role_a is null, i.e. applies
        // to all principals).
        const subjectRelevant =
          c.role_a === null || heldRoleIds.has(c.role_a);
        if (subjectRelevant) {
          conflicts.push({
            constraintId: c.id,
            kind,
            roleA: roleADto,
            roleB: roleBDto,
            note: "Динамическое правило — проверяется автоматически при выполнении действий.",
          });
        }
      }
    }

    return { subjectId: subjectSlug, heldRoles, conflicts };
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSodRoutes(router: Router, pool: pg.Pool): void {
  // ── GET /api/rights/sod-rules ────────────────────────────────────────────
  // Returns the tenant's SoD constraint declarations (rules registry).
  // Empty array when none are configured — honest-empty, no fabricated data.
  router.register(
    "GET",
    "/api/rights/sod-rules",
    withAuth(async (req, res) => {
      const actorId = await extractActorFromReq(req, pool);
      const tenantId = await resolveActorTenant(pool, actorId);
      const result = await listSodRules(pool, tenantId);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    }),
  );

  // ── GET /api/rights/sod-check?subjectId=:slug ───────────────────────────
  // Reports SoD conflicts for a subject (employee slug).
  // ?subjectId is optional: defaults to the authenticated actor.
  router.register(
    "GET",
    "/api/rights/sod-check",
    withAuth(async (req, res) => {
      const actorId = await extractActorFromReq(req, pool);
      const tenantId = await resolveActorTenant(pool, actorId);

      // Parse subjectId from query string (optional, defaults to actor self).
      const url = new URL(req.url ?? "/", "http://localhost");
      const subjectId = url.searchParams.get("subjectId") ?? actorId;

      // T-0736 [security P1 — the MOST dangerous of the three T-0726 §5.2
      // findings]: subjectId was caller-overridable to ANY slug with zero
      // privilege check — an unprivileged member could read ANY colleague's
      // SoD conflicts (which roles they hold + which pairs collide) just by
      // querying that colleague's slug. Self-view needs no extra gate (the
      // established §B "self-scoped" doctrine this same coverage gate already
      // applies elsewhere — notifications.ts/user-prefs.ts — self data needs
      // no authority resolver); gate ONLY the override, on the same
      // admin/owner bar as GET /api/grant-trail (T-0736 ADR §2):
      // resolveActorPrivilege(...).isOwnerOrAdmin. A bare identity swap
      // (subjectId !== actorId) without that privilege is now rejected
      // BEFORE checkSodForSubject ever resolves whether the subject exists —
      // no exists/doesn't-exist oracle leaks to an unprivileged caller.
      if (subjectId !== actorId) {
        const priv = await resolveActorPrivilege(pool, tenantId, actorId, Date.now());
        if (!priv.isOwnerOrAdmin) {
          throw new HttpError(
            403,
            "FORBIDDEN",
            "viewing another subject's SoD conflicts requires admin/owner authority",
          );
        }
      }

      const result = await checkSodForSubject(pool, tenantId, subjectId);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    }),
  );
}
