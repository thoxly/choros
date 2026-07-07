/**
 * src/http/seed-write.ts — T-0140
 *
 * Five new write endpoints for the seed-pack importer (ADR §4):
 *   POST /api/tenants
 *   POST /api/departments
 *   POST /api/positions
 *   POST /api/employees
 *   POST /api/roles
 *
 * Every handler uses the existing auth seam:
 *   extractActor → loadAdminContext → isGenesisOwner gate (tenants/depts/positions/employees)
 *   or validateAdminDelegation mgmt_object:role:create gate (roles)
 * BEFORE any INSERT (FF-6, AC-18).
 *
 * Idempotency: UNIQUE(tenant_id,slug) constraints return 409 CONFLICT (AC-1..6).
 * No hardcoded === 'e-owner' bypasses — owner-ness resolved from DB (NF-3).
 *
 * T-0388 [D1] — the org-write ownership gate is resolved against the CALLER's
 * OWN tenant (derived from their authenticated identity via resolveActorTenant),
 * NOT a hardcoded DEV_TENANT_ID. Previously a self-registered owner — who holds
 * the tenant-owner role in THEIR tenant — got 403 NOT_OWNER because the gate
 * checked ownership against DEV_TENANT_ID (where they hold no role). The fix
 * (authorizeOrgWrite) for each route carrying a body/param tenant_id:
 *   1. resolve the caller's slug + own tenant from identity,
 *   2. if tenant_id == the caller's own tenant → gate against THAT tenant (B6),
 *   3. else allow ONLY the bootstrap-silo forest-owner (genesis owner of
 *      DEV_TENANT_ID — the importer/seed-pack super-admin) and gate against
 *      DEV_TENANT_ID; any other cross-tenant write → 403 NOT_OWNER,
 *   4. run loadAdminContext against the returned authority tenant.
 * The central security property: the proven authority tenant and the write
 * target (tenant_id used for RLS GUC + INSERT) are either the SAME tenant (the
 * caller's own) or the caller is the forest-owner — so owner-ness in tenant A can
 * never authorise a write into an unrelated tenant B.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  loadAdminContext,
  resolveActorSlugFromAuth,
  resolveActorTenant,
  isGenesisOwnerForTenant,
} from "../db/org.js";
import { validateAdminDelegation } from "../core/scoped-admin.js";
import type { AdminContext } from "../core/scoped-admin.js";
import type { Grant } from "../core/grant-lattice.js";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { insertWithUniqueSlugRetry } from "../core/slug-generator.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import {
  wouldCreateCycle,
  isEmptyPatch,
  buildDeptMoveDiff,
  buildPositionMoveDiff,
  buildEmployeeMoveDiff,
  type DeptMovePatch,
  type PositionMovePatch,
  type EmployeeMovePatch,
} from "../core/org-move.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Bootstrap silo tenant. Used ONLY by POST /api/tenants (tenant-creation is a
// privileged bootstrap operation reserved for the genesis owner of the bootstrap
// silo — it is NOT the per-tenant org-write surface that B6 is about). All other
// org-write routes resolve the caller's OWN tenant (authorizeOrgWrite) and only
// fall back to this constant for the bootstrap forest-owner path (T-0388).
const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// slug: lowercase alphanumerics + dashes, 1..64 chars. Matches the SLUG_RE
// convention in applications.ts / registry-defs.ts. T-0642 fix-forward
// (adversarial finding): POST /api/roles previously accepted ANY non-empty
// string as slug (no charset check) — role.slug is later written UNQUOTED-
// ADJACENT into BPMN XML as flowable:candidateGroups="<slug>" (see
// user-task-role-mapper.ts). escapeXml at the injection site is the primary
// fix; this charset gate is defense-in-depth so a malformed/hostile slug is
// rejected at creation time with a human 400 instead of reaching publish.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// extractActor — identical to grants.ts pattern (FF-6 requires same seam)
// No hardcoded slug comparison (FF-6 / AC-18).
// T-0372: resolve KC sub → employee slug so seeded admin personas (e-owner, …)
// are keyed on their slug (not their random KC sub UUID) for admin-context lookup.
// ---------------------------------------------------------------------------

async function extractActor(req: import("node:http").IncomingMessage, pool: pg.Pool): Promise<string> {
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
// authorizeOrgWrite — T-0388: the central org-write authorization seam.
//
// Resolves the caller's identity and decides WHICH tenant the genesis-owner gate
// must run against (`authTenantId`), while enforcing the cross-tenant property.
//
// Decision (for a request targeting `targetTenantId`):
//   1. SAME-TENANT (the B6 fix). If the target is the caller's OWN resolved
//      tenant, gate against that tenant. A self-registered owner thus passes the
//      gate for writes into their own tenant (previously 403 against DEV_TENANT_ID).
//   2. FOREST-OWNER (bootstrap super-admin; preserves the seed-pack importer).
//      If the target is a DIFFERENT tenant, the write is allowed ONLY if the
//      caller is the genesis owner of the bootstrap silo (DEV_TENANT_ID) — the
//      un-parented delegation root that owns the whole forest (scoped-admin.ts).
//      Such a caller seeds arbitrary tenants (the importer runs as e-owner); the
//      gate then runs against DEV_TENANT_ID where their ownership lives.
//   3. CROSS-TENANT DENY. Otherwise (different tenant, not the forest owner) →
//      403 NOT_OWNER, BEFORE any INSERT. A genuine owner of tenant A can never
//      spend that ownership on a write into tenant B.
//
// NF-3: owner-ness is ALWAYS resolved from the DB (resolveActorTenant +
// isGenesisOwnerForTenant + the loadAdminContext gate the caller runs against
// the returned authTenantId) — never assumed, never from a hardcoded slug.
// The returned authTenantId is the tenant the caller MUST then pass to
// loadAdminContext, so the auth ceiling and the proven authority tenant match.
// ---------------------------------------------------------------------------

// Exported (T-0583, additive): src/http/user-mgmt.ts reuses this SAME
// cross-tenant guard for POST /api/users / PATCH /api/users/:employee_id —
// one org-write authorization seam, not a second copy of the tenant-resolution
// + forest-owner-exemption logic (N5).
export async function authorizeOrgWrite(
  req: import("node:http").IncomingMessage,
  pool: pg.Pool,
  targetTenantId: string,
  nowMs: number,
): Promise<{ actorId: string; authTenantId: string }> {
  const actorId = await extractActor(req, pool);
  const callerTenantId = await resolveActorTenant(pool, actorId);

  // 1. Same-tenant write → gate against the caller's own tenant (B6).
  if (targetTenantId === callerTenantId) {
    return { actorId, authTenantId: callerTenantId };
  }

  // 2. Forest-owner exemption: only the bootstrap-silo genesis owner may write
  //    cross-tenant (the importer/seed-pack super-admin). Resolved from DB.
  const isForestOwner = await isGenesisOwnerForTenant(
    pool,
    DEV_TENANT_ID,
    actorId,
    nowMs,
  );
  if (isForestOwner) {
    // The bootstrap genesis owner's authority lives in the dev silo; gate there.
    return { actorId, authTenantId: DEV_TENANT_ID };
  }

  // 3. Cross-tenant deny — close the hole.
  throw new HttpError(403, "NOT_OWNER", "you may only write into your own tenant");
}

// ---------------------------------------------------------------------------
// withTenantTx — scoped write transaction (mirrors grants.ts pattern)
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
// isConflict — detect UNIQUE violation from pg error
// ---------------------------------------------------------------------------

function isConflict(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code: string }).code === "23505";
  }
  return false;
}

// ---------------------------------------------------------------------------
// isFkViolation — detect FOREIGN KEY violation from pg error (23503)
// Returns the blocking constraint name if available, for the 409 body.
// ---------------------------------------------------------------------------

function isFkViolation(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code: string }).code === "23503";
  }
  return false;
}

function fkConstraintName(err: unknown): string {
  if (err && typeof err === "object" && "constraint" in err) {
    const c = (err as { constraint?: string }).constraint;
    if (typeof c === "string" && c.length > 0) return c;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// registerSeedWriteRoutes — called from server.ts after grants pool is ready
// ---------------------------------------------------------------------------

// T-0515: org-ancestry for scope validation is built from the tenant's REAL
// department tree (loadTenantOrgAncestry), not a hardcoded seed map. The oracle
// is loaded per-request in each route handler and threaded into the gate.
import type { AncestryOracle } from "../core/grant-lattice.js";
import { loadTenantOrgAncestry } from "../db/org-ancestry.js";

// ---------------------------------------------------------------------------
// assertOrgObjectAuthority — T-0469 [auth]: the org-write authorization gate,
// widened from "genesis owner ONLY" to "genesis owner OR a holder of a covering,
// delegable mgmt_object grant for this object+operation".
//
// THE SEAM (reuse, not invent): the delegation machinery already loaded by
// loadAdminContext (admin.adminGrants = confirmed, in-window, delegable
// mgmt_object:* grants) is checked by validateAdminDelegation against a synthetic
// child grant — EXACTLY the pattern POST /api/roles already uses. For the genesis
// owner the check short-circuits ok (step 3 of validateAdminDelegation). For a
// non-owner it passes iff some delegable mgmt_object:<kind>/<operation> grant
// covers the target org scope. This is how `role-constructor-admin` gets owner-
// like authoring power over departments/positions/employees/roles WITHOUT being
// the owner.
//
// OWNER-ONLY BOUNDARY (the security crux — NOT routed through this helper):
//   - employee DELETION stays isGenesisOwner-only (DELETE /api/employees below),
//   - role_assignment mutation is not a seed-write surface AT ALL (this file
//     never INSERT/UPDATE/DELETEs choros.role_assignment), so a constructor-admin
//     can never remove/replace the tenant-owner through these routes.
// So a constructor-admin can author org structure but can never delete a person
// or touch who the owner is. See registerTenant role-constructor-admin seeding:
// it is granted mgmt_object:{department,position,employee,role} create/update
// ONLY — no employee:delete, no mgmt_object:grant, no freeform.
// ---------------------------------------------------------------------------

// Exported (T-0583, additive): src/http/user-mgmt.ts reuses this SAME
// owner-or-covering-delegable-grant gate for account create/deactivate — the
// identical check POST /api/employees already runs (N5, no second gate impl).
//
// T-0630 (additive): `operation` widened to also accept "read" so the SAME
// helper gates GET /api/users/accounts (owner or a covering, delegable
// mgmt_object:employee grant) — no new authority path, no new employee-lookup
// SQL (D-064/T-0658 discipline: loadAdminContext already carries the T-0658
// `deactivated_at IS NULL` fail-closed predicate; this file must not grow a
// 6th parallel authority resolver). `Operation` (grant-lattice.ts) already
// includes "read" — the lattice/validateAdminDelegation are untouched; only
// this thin wrapper's parameter type widens. All 8 pre-existing call sites
// (create/update/delete) are unaffected.
export function assertOrgObjectAuthority(
  admin: AdminContext,
  mgmtKind:
    | "mgmt_object:department"
    | "mgmt_object:position"
    | "mgmt_object:employee"
    | "mgmt_object:role",
  operation: "create" | "update" | "delete" | "read",
  tenantId: string,
  actorId: string,
  nowMs: number,
  notOwnerMessage: string,
  oracle: AncestryOracle,
): void {
  // Genesis owner short-circuits (preserves the existing owner path verbatim).
  if (admin.isGenesisOwner) return;

  // Non-owner: require a covering, delegable mgmt_object:<kind>/<operation> grant.
  const syntheticChild: Grant = {
    tenantId,
    id: randomUUID(),
    roleId: randomUUID(),
    resourceType: mgmtKind,
    operation,
    scope: admin.adminOrgScope,
    delegable: false,
    grantedBy: actorId,
    createdAt: nowMs,
  };

  const gate = validateAdminDelegation(
    admin,
    { kind: "grant", childGrant: syntheticChild, targetOrgScope: admin.adminOrgScope },
    oracle,
  );

  if (!gate.ok) {
    throw new HttpError(403, "NOT_OWNER", notOwnerMessage);
  }
}

// T-0469: does the admin hold ANY delegable org-object mgmt grant? Used by the
// READ counterpart (GET /api/org/tenant-state) where there is no specific
// operation to gate — any org-authoring authority is sufficient to read state.
const ORG_OBJECT_KINDS = new Set([
  "mgmt_object:department",
  "mgmt_object:position",
  "mgmt_object:employee",
  "mgmt_object:role",
]);

function hasOrgObjectAuthority(admin: AdminContext): boolean {
  return admin.adminGrants.some(
    (g) => g.delegable && ORG_OBJECT_KINDS.has(g.resourceType),
  );
}

export function registerSeedWriteRoutes(router: Router, pool: pg.Pool): void {
  const nowMs = () => Date.now();

  // -------------------------------------------------------------------------
  // POST /api/tenants — create a named tenant (bootstrap-class, isGenesisOwner gate)
  // body: { slug: string, display_name: string }
  // 201: { id: uuid, slug: string }
  // 409: slug exists
  // -------------------------------------------------------------------------
  router.register("POST", "/api/tenants", withAuth(async (req, res) => {
    // T-0388: Tenant CREATION is a privileged bootstrap operation reserved for the
    // genesis owner of the bootstrap silo (DEV_TENANT_ID) — the un-parented forest
    // root that mints new tenants (the importer runs as e-owner). This is NOT the
    // per-tenant org-write surface B6 is about — a self-registered owner manages
    // people/depts/roles INSIDE their existing tenant via the routes below, they do
    // not mint sibling tenants. The DEV_TENANT_ID genesis-ownership gate (resolved
    // from DB, NF-3) is authoritative: only the bootstrap owner passes it, so no
    // separate same-tenant guard is needed here.
    const actorId = await extractActor(req, pool);
    // Gate: loadAdminContext → isGenesisOwner (before INSERT, FF-6)
    const admin = await loadAdminContext(pool, DEV_TENANT_ID, actorId, nowMs());
    if (!admin.isGenesisOwner) {
      throw new HttpError(403, "NOT_OWNER", "genesis owner required to create tenants");
    }

    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;

    const slug = b["slug"];
    if (typeof slug !== "string" || slug.length === 0) {
      throw new HttpError(400, "VALIDATION", "slug is required");
    }
    const display_name = b["display_name"];
    if (typeof display_name !== "string" || display_name.length === 0) {
      throw new HttpError(400, "VALIDATION", "display_name is required");
    }

    const id = randomUUID();
    const ts = nowMs();

    // Tenant table: tenant_id = id (self-referential, migration 013).
    // RLS policy: row visible iff id = GUC. We must SET the GUC to the new id
    // so the WITH CHECK policy passes for the new row.
    let insertConflict = false;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${id}'`);
      await client.query("SET LOCAL search_path TO choros");
      await client.query(
        `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
         VALUES ($1, $1, $2, $3, $4)`,
        [id, slug, display_name, ts],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      if (!isConflict(err)) {
        throw err;
      }
      insertConflict = true;
    } finally {
      client.release();
    }

    if (insertConflict) {
      // R-6: On slug conflict, resolve the existing tenant UUID so the importer
      // can obtain {id} from the 409 body without a separate slug-lookup GET
      // (which would need the GUC the caller cannot know without the id first).
      // The pool role (migrator: BYPASSRLS) can SELECT choros.tenant without GUC.
      // Per T-0022 roadmap: when APP_DATABASE_URL splits the pool to choros_app
      // this lookup will require a SECURITY DEFINER function.
      const lookupClient = await pool.connect();
      try {
        const { rows } = await lookupClient.query<{ id: string; slug: string }>(
          `SELECT id, slug FROM choros.tenant WHERE slug = $1 LIMIT 1`,
          [slug],
        );
        if (rows.length > 0) {
          res.statusCode = 409;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ id: rows[0].id, slug: rows[0].slug, code: "CONFLICT" }));
          return;
        }
      } finally {
        lookupClient.release();
      }
      // Fallback if lookup finds nothing (theoretical race — normal flow won't hit this)
      throw new HttpError(409, "CONFLICT", `tenant with slug '${slug}' already exists`);
    }

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id, slug }));
  }));

  // -------------------------------------------------------------------------
  // POST /api/departments — create a department under a tenant (isGenesisOwner gate)
  // body: { tenant_id: uuid, slug: string, display_name: string, parent_id?: uuid|null }
  // 201: { id: uuid, slug: string }
  // 409: (tenant_id, slug) exists
  // -------------------------------------------------------------------------
  router.register("POST", "/api/departments", withAuth(async (req, res) => {
    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;

    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required");
    }
    assertUuidShape(tenant_id, "tenant_id");

    // T-0388: cross-tenant guard + gate against the resolved authority tenant
    // (caller's own tenant for self-reg owners; DEV_TENANT_ID for the bootstrap
    // forest-owner). Cross-tenant writes by non-forest-owners → 403.
    const { actorId, authTenantId } = await authorizeOrgWrite(req, pool, tenant_id, nowMs());
    const admin = await loadAdminContext(pool, authTenantId, actorId, nowMs());
    // T-0515: oracle from the authority tenant's REAL department tree.
    const oracle = await loadTenantOrgAncestry(pool, authTenantId);
    // T-0469: owner OR a covering delegable mgmt_object:department/create grant.
    assertOrgObjectAuthority(
      admin, "mgmt_object:department", "create", tenant_id, actorId, nowMs(),
      "owner or mgmt_object:department grant required to create departments",
      oracle,
    );

    // T-0650 [UX-study §7]: slug is now OPTIONAL. If omitted/blank, the server derives
    // one from display_name (auto-slugs). Explicit-slug validation is UNCHANGED.
    const rawSlug = b["slug"];
    let explicitSlug: string | null = null;
    if (rawSlug !== undefined && rawSlug !== null && rawSlug !== "") {
      if (typeof rawSlug !== "string") {
        throw new HttpError(400, "VALIDATION", "slug must be a string");
      }
      explicitSlug = rawSlug;
    }
    const display_name = b["display_name"];
    if (typeof display_name !== "string" || display_name.length === 0) {
      throw new HttpError(400, "VALIDATION", "display_name is required");
    }
    const parent_id = b["parent_id"] ?? null;
    if (parent_id !== null) {
      assertUuidShape(parent_id as string, "parent_id");
    }

    const ts = nowMs();

    const insertOne = async (candidateSlug: string): Promise<{ id: string; slug: string }> => {
      const id = randomUUID();
      await withTenantTx(pool, tenant_id, async (client) => {
        await client.query(
          `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [tenant_id, id, parent_id, candidateSlug, display_name, ts],
        );
      });
      return { id, slug: candidateSlug };
    };

    let created: { id: string; slug: string };
    if (explicitSlug !== null) {
      try {
        created = await insertOne(explicitSlug);
      } catch (err) {
        if (isConflict(err)) {
          throw new HttpError(409, "CONFLICT", `department with slug '${explicitSlug}' already exists in tenant`);
        }
        throw err;
      }
    } else {
      created = await insertWithUniqueSlugRetry(display_name, insertOne, { isConflict });
    }

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(created));
  }));

  // -------------------------------------------------------------------------
  // POST /api/positions — create a position inside a department (isGenesisOwner gate)
  // body: { tenant_id: uuid, department_id: uuid, slug: string, title: string }
  // 201: { id: uuid, slug: string }
  // 409: (tenant_id, department_id, slug) exists
  // -------------------------------------------------------------------------
  router.register("POST", "/api/positions", withAuth(async (req, res) => {
    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;

    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required");
    }
    assertUuidShape(tenant_id, "tenant_id");

    // T-0388: cross-tenant guard + gate against the resolved authority tenant.
    const { actorId, authTenantId } = await authorizeOrgWrite(req, pool, tenant_id, nowMs());
    const admin = await loadAdminContext(pool, authTenantId, actorId, nowMs());
    // T-0515: oracle from the authority tenant's REAL department tree.
    const oracle = await loadTenantOrgAncestry(pool, authTenantId);
    // T-0469: owner OR a covering delegable mgmt_object:position/create grant.
    assertOrgObjectAuthority(
      admin, "mgmt_object:position", "create", tenant_id, actorId, nowMs(),
      "owner or mgmt_object:position grant required to create positions",
      oracle,
    );

    const department_id = b["department_id"];
    if (typeof department_id !== "string") {
      throw new HttpError(400, "VALIDATION", "department_id is required");
    }
    assertUuidShape(department_id, "department_id");

    // T-0650 [UX-study §7]: slug is now OPTIONAL. If omitted/blank, the server derives
    // one from title (auto-slugs). Explicit-slug validation is UNCHANGED.
    const rawSlug = b["slug"];
    let explicitSlug: string | null = null;
    if (rawSlug !== undefined && rawSlug !== null && rawSlug !== "") {
      if (typeof rawSlug !== "string") {
        throw new HttpError(400, "VALIDATION", "slug must be a string");
      }
      explicitSlug = rawSlug;
    }
    const title = b["title"];
    if (typeof title !== "string" || title.length === 0) {
      throw new HttpError(400, "VALIDATION", "title is required");
    }

    const ts = nowMs();

    const insertOne = async (candidateSlug: string): Promise<{ id: string; slug: string }> => {
      const id = randomUUID();
      await withTenantTx(pool, tenant_id, async (client) => {
        await client.query(
          `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [tenant_id, id, department_id, candidateSlug, title, ts],
        );
      });
      return { id, slug: candidateSlug };
    };

    let created: { id: string; slug: string };
    if (explicitSlug !== null) {
      try {
        created = await insertOne(explicitSlug);
      } catch (err) {
        if (isConflict(err)) {
          throw new HttpError(409, "CONFLICT", `position with slug '${explicitSlug}' already exists in department`);
        }
        throw err;
      }
    } else {
      created = await insertWithUniqueSlugRetry(title, insertOne, { isConflict });
    }

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(created));
  }));

  // -------------------------------------------------------------------------
  // POST /api/employees — create an employee (isGenesisOwner gate)
  // body: { tenant_id: uuid, position_id?: uuid|null, kind: "human"|"agent", slug: string, display_name: string }
  // 201: { id: uuid, slug: string }
  // 409: (tenant_id, slug) exists
  // 400: kind not in {human,agent}
  // -------------------------------------------------------------------------
  router.register("POST", "/api/employees", withAuth(async (req, res) => {
    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;

    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required");
    }
    assertUuidShape(tenant_id, "tenant_id");

    // T-0388 (B6 fix): cross-tenant guard + gate against the resolved authority
    // tenant — a self-registered owner can add people to THEIR tenant.
    const { actorId, authTenantId } = await authorizeOrgWrite(req, pool, tenant_id, nowMs());
    const admin = await loadAdminContext(pool, authTenantId, actorId, nowMs());
    // T-0515: oracle from the authority tenant's REAL department tree.
    const oracle = await loadTenantOrgAncestry(pool, authTenantId);
    // T-0469: owner OR a covering delegable mgmt_object:employee/create grant.
    // (employee DELETION stays owner-only — see DELETE /api/employees below.)
    assertOrgObjectAuthority(
      admin, "mgmt_object:employee", "create", tenant_id, actorId, nowMs(),
      "owner or mgmt_object:employee grant required to create employees",
      oracle,
    );

    const kind = b["kind"];
    if (kind !== "human" && kind !== "agent") {
      throw new HttpError(400, "VALIDATION", "kind must be 'human' or 'agent'");
    }
    // T-0650 [UX-study §7]: slug is now OPTIONAL. If omitted/blank, the server derives
    // one from display_name (auto-slugs). Explicit-slug validation is UNCHANGED. Note:
    // this is the human/agent's identity slug — login resolution (T-0372/T-0633) still
    // keys on it, but auto-generation is equally safe (uniqueness enforced the same way).
    const rawSlug = b["slug"];
    let explicitSlug: string | null = null;
    if (rawSlug !== undefined && rawSlug !== null && rawSlug !== "") {
      if (typeof rawSlug !== "string") {
        throw new HttpError(400, "VALIDATION", "slug must be a string");
      }
      explicitSlug = rawSlug;
    }
    const display_name = b["display_name"];
    if (typeof display_name !== "string" || display_name.length === 0) {
      throw new HttpError(400, "VALIDATION", "display_name is required");
    }
    const position_id = b["position_id"] ?? null;
    if (position_id !== null) {
      assertUuidShape(position_id as string, "position_id");
    }

    const ts = nowMs();

    const insertOne = async (candidateSlug: string): Promise<{ id: string; slug: string }> => {
      const id = randomUUID();
      await withTenantTx(pool, tenant_id, async (client) => {
        await client.query(
          `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
          [tenant_id, id, position_id, kind, candidateSlug, display_name, ts],
        );
      });
      return { id, slug: candidateSlug };
    };

    let created: { id: string; slug: string };
    if (explicitSlug !== null) {
      try {
        created = await insertOne(explicitSlug);
      } catch (err) {
        if (isConflict(err)) {
          throw new HttpError(409, "CONFLICT", `employee with slug '${explicitSlug}' already exists in tenant`);
        }
        throw err;
      }
    } else {
      created = await insertWithUniqueSlugRetry(display_name, insertOne, { isConflict });
    }

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(created));
  }));

  // -------------------------------------------------------------------------
  // POST /api/roles — create a role (mgmt_object:role:create grant gate, ADR §2.3 option C)
  // body: { tenant_id: uuid, slug: string, display_name: string, description?: string|null }
  // 201: { id: uuid, slug: string }
  // 409: (tenant_id, slug) exists
  // -------------------------------------------------------------------------
  router.register("POST", "/api/roles", withAuth(async (req, res) => {
    // Read body first so we can use target tenant_id in the delegation context (R-4)
    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;

    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required");
    }
    assertUuidShape(tenant_id, "tenant_id");

    // T-0388: cross-tenant guard + resolve the authority tenant.
    const { actorId, authTenantId } = await authorizeOrgWrite(req, pool, tenant_id, nowMs());

    // Gate: loadAdminContext → validateAdminDelegation for mgmt_object:role:create (FF-6, AC-18)
    // Admin context is loaded against the resolved authority tenant (the caller's
    // own tenant for self-reg owners; DEV_TENANT_ID for the bootstrap forest-owner).
    // syntheticGrant.tenantId uses the target tenant_id (R-4).
    const admin = await loadAdminContext(pool, authTenantId, actorId, nowMs());

    // Build a synthetic child grant for the gate check (resource_type=mgmt_object:role, operation=create)
    const syntheticGrant = {
      tenantId: tenant_id,
      id: randomUUID(),
      roleId: randomUUID(),
      resourceType: "mgmt_object:role" as const,
      operation: "create" as const,
      scope: admin.adminOrgScope,
      delegable: false,
      grantedBy: actorId,
      createdAt: nowMs(),
    };

    // T-0515: oracle from the authority tenant's REAL department tree.
    const oracle = await loadTenantOrgAncestry(pool, authTenantId);
    const gateResult = validateAdminDelegation(
      admin,
      { kind: "grant", childGrant: syntheticGrant as import("../core/grant-lattice.js").Grant, targetOrgScope: admin.adminOrgScope },
      oracle,
    );

    if (!gateResult.ok) {
      throw new HttpError(403, "NOT_OWNER", "insufficient delegation to create roles");
    }

    // T-0650 [UX-study §7]: slug is now OPTIONAL. If omitted/blank, the server derives
    // one from display_name (auto-slugs) — generateSlugFromName's output always
    // satisfies SLUG_RE, so the T-0642 charset defense-in-depth (candidateGroups
    // XML-attribute injection guard) holds for auto-generated slugs too. Explicit-slug
    // validation is UNCHANGED.
    const rawSlug = b["slug"];
    let explicitSlug: string | null = null;
    if (rawSlug !== undefined && rawSlug !== null && rawSlug !== "") {
      if (typeof rawSlug !== "string") {
        throw new HttpError(400, "VALIDATION", "slug must be a string");
      }
      // T-0642 fix-forward: charset gate (defense-in-depth alongside the
      // escapeXml fix at the candidateGroups injection site in
      // user-task-role-mapper.ts) — role.slug must be a safe, URL/XML-attribute-
      // shaped identifier, not arbitrary text.
      if (!SLUG_RE.test(rawSlug)) {
        throw new HttpError(
          400,
          "VALIDATION",
          "slug must be a lowercase alphanumeric/dash string (1-64 chars)",
        );
      }
      explicitSlug = rawSlug;
    }
    const display_name = b["display_name"];
    if (typeof display_name !== "string" || display_name.length === 0) {
      throw new HttpError(400, "VALIDATION", "display_name is required");
    }
    const description = b["description"] ?? null;

    const ts = nowMs();

    const insertOne = async (candidateSlug: string): Promise<{ id: string; slug: string }> => {
      const id = randomUUID();
      await withTenantTx(pool, tenant_id, async (client) => {
        await client.query(
          `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [tenant_id, id, candidateSlug, display_name, description, ts],
        );
      });
      return { id, slug: candidateSlug };
    };

    let created: { id: string; slug: string };
    if (explicitSlug !== null) {
      try {
        created = await insertOne(explicitSlug);
      } catch (err) {
        if (isConflict(err)) {
          throw new HttpError(409, "CONFLICT", `role with slug '${explicitSlug}' already exists in tenant`);
        }
        throw err;
      }
    } else {
      created = await insertWithUniqueSlugRetry(display_name, insertOne, { isConflict });
    }

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(created));
  }));

  // ===========================================================================
  // T-0655 [W5-UX / ux-study §6.4 + §1C] — MOVE-API: PATCH department/position/
  // employee (reparent + rename). Additive to the existing create+delete surface.
  //
  // THE GAP (screen-org.jsx:40-45, "There is NO update/PATCH route for any org
  // entity — create + delete only"): reorganisation meant delete+recreate, which
  // severs the entity id (and thus its history / role-assignments / audit lineage).
  // These PATCH routes reparent IN PLACE, preserving the id.
  //
  // AUTHZ (reused, not invented — same seam every write route above uses):
  //   authorizeOrgWrite (cross-tenant guard: own-tenant OR bootstrap forest-owner)
  //   → loadAdminContext against the resolved authority tenant
  //   → assertOrgObjectAuthority(mgmt_object:<kind>, "update", …) — owner OR a
  //     covering delegable mgmt_object:<kind>/update grant. (loadAdminContext
  //     carries the T-0658 `deactivated_at IS NULL` fail-closed actor predicate,
  //     so a deactivated caller cannot move org structure — no new actor resolver.)
  //
  // AUDIT: each move appends ONE `<kind>.moved` event through the canonical
  // appendAuditEvent sink INSIDE the same tenant tx (a ROLLBACK undoes the UPDATE
  // and the audit entry atomically), recording the real before/after diff.
  // ===========================================================================

  // Load the tenant's department parent-map (id → parent_id|null) on the caller's
  // OPEN tenant tx (RLS GUC already set). Used only by the department reparent
  // cycle guard — reads identical topology to the grant-lattice ancestry oracle.
  const loadDeptParentMap = async (
    client: pg.PoolClient,
    tenantId: string,
  ): Promise<Map<string, string | null>> => {
    const { rows } = await client.query<{ id: string; parent_id: string | null }>(
      `SELECT id, parent_id FROM choros.department WHERE tenant_id = $1`,
      [tenantId],
    );
    const m = new Map<string, string | null>();
    for (const r of rows) m.set(r.id, r.parent_id);
    return m;
  };

  // -------------------------------------------------------------------------
  // PATCH /api/departments/:id — reparent (parent_id) and/or rename (display_name)
  // body: { tenant_id: uuid, parent_id?: uuid|null, display_name?: string }
  // 200: { id }  400: empty/invalid/CYCLE  403: cross-tenant/not-authorized
  // 404: department not in tenant  409: FK (parent not in tenant)
  // -------------------------------------------------------------------------
  router.register("PATCH", "/api/departments/:id", withAuth(async (req, res, params) => {
    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;
    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required");
    }
    assertUuidShape(tenant_id, "tenant_id");

    const { actorId, authTenantId } = await authorizeOrgWrite(req, pool, tenant_id, nowMs());
    const admin = await loadAdminContext(pool, authTenantId, actorId, nowMs());
    const oracle = await loadTenantOrgAncestry(pool, authTenantId);
    assertOrgObjectAuthority(
      admin, "mgmt_object:department", "update", tenant_id, actorId, nowMs(),
      "owner or mgmt_object:department grant required to move/rename departments",
      oracle,
    );

    const deptId = params["id"] as string;
    assertUuidShape(deptId, "id");

    // Build the validated patch (only provided fields).
    const patch: DeptMovePatch = {};
    if ("parent_id" in b) {
      const p = b["parent_id"];
      if (p === null) patch.parent_id = null;
      else { assertUuidShape(p as string, "parent_id"); patch.parent_id = p as string; }
    }
    if ("display_name" in b) {
      const dn = b["display_name"];
      if (typeof dn !== "string" || dn.length === 0) {
        throw new HttpError(400, "VALIDATION", "display_name must be a non-empty string");
      }
      patch.display_name = dn;
    }
    if (isEmptyPatch(patch)) {
      throw new HttpError(400, "VALIDATION", "nothing to update (provide parent_id and/or display_name)");
    }

    try {
      await withTenantTx(pool, tenant_id, async (client) => {
        // Fetch the current row (before-image + existence check) FOR UPDATE.
        const cur = await client.query<{ parent_id: string | null; display_name: string }>(
          `SELECT parent_id, display_name FROM choros.department WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [tenant_id, deptId],
        );
        if (cur.rowCount === 0) {
          throw new HttpError(404, "NOT_FOUND", `department ${deptId} not found`);
        }
        const before = cur.rows[0];

        // Cycle guard (application-layer, per 014_department.sql §1.1): a
        // department may not become a descendant of itself.
        if ("parent_id" in patch) {
          const parentMap = await loadDeptParentMap(client, tenant_id);
          if (wouldCreateCycle(parentMap, deptId, patch.parent_id ?? null)) {
            throw new HttpError(400, "CYCLE", "cannot move a department under itself or its own subtree");
          }
        }

        // Build the UPDATE from the touched columns.
        const sets: string[] = [];
        const vals: unknown[] = [tenant_id, deptId];
        if ("parent_id" in patch) { vals.push(patch.parent_id ?? null); sets.push(`parent_id = $${vals.length}`); }
        if (patch.display_name !== undefined) { vals.push(patch.display_name); sets.push(`display_name = $${vals.length}`); }
        vals.push(nowMs()); sets.push(`updated_at = $${vals.length}`);
        await client.query(
          `UPDATE choros.department SET ${sets.join(", ")} WHERE tenant_id = $1 AND id = $2`,
          vals,
        );

        const writer = makePgAuditWriter();
        await writer.appendAuditEvent(client as unknown as PgClientLike, {
          id: randomUUID(),
          type: "department.moved",
          actor: actorId,
          subject: deptId,
          scope: { resource: "department", department_id: deptId },
          via: "org-move-api",
          proposed_by: null,
          confirmed_by: actorId,
          payload: buildDeptMoveDiff(before, patch),
          occurred_at: nowMs(),
        });
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (isFkViolation(err)) {
        throw new HttpError(409, "FK_IN_USE", `department ${deptId} move rejected: referenced parent not in tenant (constraint: ${fkConstraintName(err)})`);
      }
      throw err;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: deptId }));
  }));

  // -------------------------------------------------------------------------
  // PATCH /api/positions/:id — move to another department (department_id) and/or
  // rename (title).
  // body: { tenant_id: uuid, department_id?: uuid, title?: string }
  // -------------------------------------------------------------------------
  router.register("PATCH", "/api/positions/:id", withAuth(async (req, res, params) => {
    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;
    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required");
    }
    assertUuidShape(tenant_id, "tenant_id");

    const { actorId, authTenantId } = await authorizeOrgWrite(req, pool, tenant_id, nowMs());
    const admin = await loadAdminContext(pool, authTenantId, actorId, nowMs());
    const oracle = await loadTenantOrgAncestry(pool, authTenantId);
    assertOrgObjectAuthority(
      admin, "mgmt_object:position", "update", tenant_id, actorId, nowMs(),
      "owner or mgmt_object:position grant required to move/rename positions",
      oracle,
    );

    const posId = params["id"] as string;
    assertUuidShape(posId, "id");

    const patch: PositionMovePatch = {};
    if ("department_id" in b) {
      const d = b["department_id"];
      // A position always belongs to a department (NOT NULL FK) — null is invalid.
      assertUuidShape(d as string, "department_id");
      patch.department_id = d as string;
    }
    if ("title" in b) {
      const t = b["title"];
      if (typeof t !== "string" || t.length === 0) {
        throw new HttpError(400, "VALIDATION", "title must be a non-empty string");
      }
      patch.title = t;
    }
    if (isEmptyPatch(patch)) {
      throw new HttpError(400, "VALIDATION", "nothing to update (provide department_id and/or title)");
    }

    try {
      await withTenantTx(pool, tenant_id, async (client) => {
        const cur = await client.query<{ department_id: string; title: string }>(
          `SELECT department_id, title FROM choros.position WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [tenant_id, posId],
        );
        if (cur.rowCount === 0) {
          throw new HttpError(404, "NOT_FOUND", `position ${posId} not found`);
        }
        const before = cur.rows[0];

        const sets: string[] = [];
        const vals: unknown[] = [tenant_id, posId];
        if (patch.department_id !== undefined) { vals.push(patch.department_id); sets.push(`department_id = $${vals.length}`); }
        if (patch.title !== undefined) { vals.push(patch.title); sets.push(`title = $${vals.length}`); }
        vals.push(nowMs()); sets.push(`updated_at = $${vals.length}`);
        await client.query(
          `UPDATE choros.position SET ${sets.join(", ")} WHERE tenant_id = $1 AND id = $2`,
          vals,
        );

        const writer = makePgAuditWriter();
        await writer.appendAuditEvent(client as unknown as PgClientLike, {
          id: randomUUID(),
          type: "position.moved",
          actor: actorId,
          subject: posId,
          scope: { resource: "position", position_id: posId },
          via: "org-move-api",
          proposed_by: null,
          confirmed_by: actorId,
          payload: buildPositionMoveDiff(before, patch),
          occurred_at: nowMs(),
        });
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (isFkViolation(err)) {
        throw new HttpError(409, "FK_IN_USE", `position ${posId} move rejected: target department not in tenant (constraint: ${fkConstraintName(err)})`);
      }
      throw err;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: posId }));
  }));

  // -------------------------------------------------------------------------
  // PATCH /api/employees/:id — move to another position (position_id; null = снять
  // с должности) and/or rename (display_name). This is the endpoint the org-tree
  // DnD (T-0655 §3) and the /agents "Назначить должность" action (§4) both drive.
  // body: { tenant_id: uuid, position_id?: uuid|null, display_name?: string }
  // -------------------------------------------------------------------------
  router.register("PATCH", "/api/employees/:id", withAuth(async (req, res, params) => {
    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;
    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required");
    }
    assertUuidShape(tenant_id, "tenant_id");

    const { actorId, authTenantId } = await authorizeOrgWrite(req, pool, tenant_id, nowMs());
    const admin = await loadAdminContext(pool, authTenantId, actorId, nowMs());
    const oracle = await loadTenantOrgAncestry(pool, authTenantId);
    // T-0469 boundary note: this is UPDATE (move/rename), NOT delete — so it goes
    // through assertOrgObjectAuthority (owner OR delegable update grant), exactly
    // like create. Employee DELETION stays isGenesisOwner-only (DELETE route below).
    assertOrgObjectAuthority(
      admin, "mgmt_object:employee", "update", tenant_id, actorId, nowMs(),
      "owner or mgmt_object:employee grant required to move/rename employees",
      oracle,
    );

    const empId = params["id"] as string;
    assertUuidShape(empId, "id");

    const patch: EmployeeMovePatch = {};
    if ("position_id" in b) {
      const p = b["position_id"];
      if (p === null) patch.position_id = null; // снять с должности
      else { assertUuidShape(p as string, "position_id"); patch.position_id = p as string; }
    }
    if ("display_name" in b) {
      const dn = b["display_name"];
      if (typeof dn !== "string" || dn.length === 0) {
        throw new HttpError(400, "VALIDATION", "display_name must be a non-empty string");
      }
      patch.display_name = dn;
    }
    if (isEmptyPatch(patch)) {
      throw new HttpError(400, "VALIDATION", "nothing to update (provide position_id and/or display_name)");
    }

    try {
      await withTenantTx(pool, tenant_id, async (client) => {
        const cur = await client.query<{ position_id: string | null; display_name: string }>(
          `SELECT position_id, display_name FROM choros.employee WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [tenant_id, empId],
        );
        if (cur.rowCount === 0) {
          throw new HttpError(404, "NOT_FOUND", `employee ${empId} not found`);
        }
        const before = cur.rows[0];

        const sets: string[] = [];
        const vals: unknown[] = [tenant_id, empId];
        if ("position_id" in patch) { vals.push(patch.position_id ?? null); sets.push(`position_id = $${vals.length}`); }
        if (patch.display_name !== undefined) { vals.push(patch.display_name); sets.push(`display_name = $${vals.length}`); }
        vals.push(nowMs()); sets.push(`updated_at = $${vals.length}`);
        await client.query(
          `UPDATE choros.employee SET ${sets.join(", ")} WHERE tenant_id = $1 AND id = $2`,
          vals,
        );

        const writer = makePgAuditWriter();
        await writer.appendAuditEvent(client as unknown as PgClientLike, {
          id: randomUUID(),
          type: "employee.moved",
          actor: actorId,
          subject: empId,
          scope: { resource: "employee", employee_id: empId },
          via: "org-move-api",
          proposed_by: null,
          confirmed_by: actorId,
          payload: buildEmployeeMoveDiff(before, patch),
          occurred_at: nowMs(),
        });
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (isFkViolation(err)) {
        throw new HttpError(409, "FK_IN_USE", `employee ${empId} move rejected: target position not in tenant (constraint: ${fkConstraintName(err)})`);
      }
      throw err;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: empId }));
  }));

  // -------------------------------------------------------------------------
  // DELETE /api/departments/:id — delete a department (isGenesisOwner gate, AC-9)
  // body: { tenant_id: uuid } — T-0388: cross-tenant guarded via authorizeOrgWrite.
  //   Auth gate (loadAdminContext → isGenesisOwner) runs against the resolved
  //   authority tenant (the caller's own tenant, or DEV_TENANT_ID for the bootstrap
  //   forest-owner), not a hardcoded DEV_TENANT_ID. RLS scope + WHERE use the body
  //   tenant_id; non-forest-owner cross-tenant deletes are rejected 403.
  // -------------------------------------------------------------------------
  router.register("DELETE", "/api/departments/:id", withAuth(async (req, res, params) => {
    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;
    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required in request body");
    }
    assertUuidShape(tenant_id, "tenant_id");

    // T-0388: cross-tenant guard + gate against the resolved authority tenant.
    const { actorId, authTenantId } = await authorizeOrgWrite(req, pool, tenant_id, nowMs());
    const admin = await loadAdminContext(pool, authTenantId, actorId, nowMs());
    // T-0515: oracle from the authority tenant's REAL department tree.
    const oracle = await loadTenantOrgAncestry(pool, authTenantId);
    // T-0469: owner OR a covering delegable mgmt_object:department/delete grant.
    assertOrgObjectAuthority(
      admin, "mgmt_object:department", "delete", tenant_id, actorId, nowMs(),
      "owner or mgmt_object:department grant required to delete departments",
      oracle,
    );

    const deptId = params["id"] as string;
    assertUuidShape(deptId, "id");

    try {
      await withTenantTx(pool, tenant_id, async (client) => {
        const { rowCount } = await client.query(
          `DELETE FROM choros.department WHERE tenant_id = $1 AND id = $2`,
          [tenant_id, deptId],
        );
        if ((rowCount ?? 0) === 0) {
          throw new HttpError(404, "NOT_FOUND", `department ${deptId} not found`);
        }
      });
    } catch (err) {
      if (isFkViolation(err)) {
        throw new HttpError(
          409,
          "FK_IN_USE",
          `department ${deptId} cannot be deleted: it is still referenced by dependent records (constraint: ${fkConstraintName(err)})`,
        );
      }
      throw err;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: deptId }));
  }));

  // -------------------------------------------------------------------------
  // DELETE /api/positions/:id — delete a position (isGenesisOwner gate, AC-9)
  // body: { tenant_id: uuid } — target tenant (R-1: must match entity's tenant)
  // -------------------------------------------------------------------------
  router.register("DELETE", "/api/positions/:id", withAuth(async (req, res, params) => {
    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;
    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required in request body");
    }
    assertUuidShape(tenant_id, "tenant_id");

    // T-0388: cross-tenant guard + gate against the resolved authority tenant.
    const { actorId, authTenantId } = await authorizeOrgWrite(req, pool, tenant_id, nowMs());
    const admin = await loadAdminContext(pool, authTenantId, actorId, nowMs());
    // T-0515: oracle from the authority tenant's REAL department tree.
    const oracle = await loadTenantOrgAncestry(pool, authTenantId);
    // T-0469: owner OR a covering delegable mgmt_object:position/delete grant.
    assertOrgObjectAuthority(
      admin, "mgmt_object:position", "delete", tenant_id, actorId, nowMs(),
      "owner or mgmt_object:position grant required to delete positions",
      oracle,
    );

    const posId = params["id"] as string;
    assertUuidShape(posId, "id");

    try {
      await withTenantTx(pool, tenant_id, async (client) => {
        const { rowCount } = await client.query(
          `DELETE FROM choros.position WHERE tenant_id = $1 AND id = $2`,
          [tenant_id, posId],
        );
        if ((rowCount ?? 0) === 0) {
          throw new HttpError(404, "NOT_FOUND", `position ${posId} not found`);
        }
      });
    } catch (err) {
      if (isFkViolation(err)) {
        throw new HttpError(
          409,
          "FK_IN_USE",
          `position ${posId} cannot be deleted: it is still referenced by dependent records (constraint: ${fkConstraintName(err)})`,
        );
      }
      throw err;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: posId }));
  }));

  // -------------------------------------------------------------------------
  // DELETE /api/employees/:id — delete an employee (isGenesisOwner gate, AC-9)
  // body: { tenant_id: uuid } — target tenant (R-1: must match entity's tenant)
  // -------------------------------------------------------------------------
  router.register("DELETE", "/api/employees/:id", withAuth(async (req, res, params) => {
    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;
    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required in request body");
    }
    assertUuidShape(tenant_id, "tenant_id");

    // T-0388: cross-tenant guard + gate against the resolved authority tenant.
    const { actorId, authTenantId } = await authorizeOrgWrite(req, pool, tenant_id, nowMs());
    const admin = await loadAdminContext(pool, authTenantId, actorId, nowMs());
    // T-0469 OWNER-ONLY BOUNDARY (the security crux): employee DELETION is NOT
    // delegable. A constructor-admin gets owner-like AUTHORING power but can NEVER
    // remove a person — that is reserved to the genesis owner. Do NOT route this
    // through assertOrgObjectAuthority; the strict isGenesisOwner gate stays.
    if (!admin.isGenesisOwner) {
      throw new HttpError(403, "NOT_OWNER", "genesis owner required to delete employees");
    }

    const empId = params["id"] as string;
    assertUuidShape(empId, "id");

    try {
      await withTenantTx(pool, tenant_id, async (client) => {
        const { rowCount } = await client.query(
          `DELETE FROM choros.employee WHERE tenant_id = $1 AND id = $2`,
          [tenant_id, empId],
        );
        if ((rowCount ?? 0) === 0) {
          throw new HttpError(404, "NOT_FOUND", `employee ${empId} not found`);
        }
      });
    } catch (err) {
      if (isFkViolation(err)) {
        throw new HttpError(
          409,
          "FK_IN_USE",
          `employee ${empId} cannot be deleted: it is still referenced by dependent records (constraint: ${fkConstraintName(err)})`,
        );
      }
      throw err;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: empId }));
  }));

  // -------------------------------------------------------------------------
  // DELETE /api/roles/:id — delete a role (isGenesisOwner gate, AC-9)
  // body: { tenant_id: uuid } — target tenant (R-1: must match entity's tenant)
  // -------------------------------------------------------------------------
  router.register("DELETE", "/api/roles/:id", withAuth(async (req, res, params) => {
    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;
    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required in request body");
    }
    assertUuidShape(tenant_id, "tenant_id");

    // T-0388: cross-tenant guard + gate against the resolved authority tenant.
    const { actorId, authTenantId } = await authorizeOrgWrite(req, pool, tenant_id, nowMs());
    const admin = await loadAdminContext(pool, authTenantId, actorId, nowMs());
    // T-0515: oracle from the authority tenant's REAL department tree.
    const oracle = await loadTenantOrgAncestry(pool, authTenantId);
    // T-0469: owner OR a covering delegable mgmt_object:role/delete grant.
    assertOrgObjectAuthority(
      admin, "mgmt_object:role", "delete", tenant_id, actorId, nowMs(),
      "owner or mgmt_object:role grant required to delete roles",
      oracle,
    );

    const roleId = params["id"] as string;
    assertUuidShape(roleId, "id");

    try {
      await withTenantTx(pool, tenant_id, async (client) => {
        const { rowCount } = await client.query(
          `DELETE FROM choros.role WHERE tenant_id = $1 AND id = $2`,
          [tenant_id, roleId],
        );
        if ((rowCount ?? 0) === 0) {
          throw new HttpError(404, "NOT_FOUND", `role ${roleId} not found`);
        }
      });
    } catch (err) {
      if (isFkViolation(err)) {
        throw new HttpError(
          409,
          "FK_IN_USE",
          `role ${roleId} cannot be deleted: it is still referenced by dependent records (constraint: ${fkConstraintName(err)})`,
        );
      }
      throw err;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: roleId }));
  }));

  // -------------------------------------------------------------------------
  // GET /api/tenants/:slug — resolve tenant id by slug (used by DB-probe tests)
  //
  // R-6 note: The importer (seed/importer.ts) no longer calls this endpoint —
  // it reads the tenant UUID directly from the POST /api/tenants 201/409 body.
  // This route is retained for test-side verification (seed-pack.test.ts).
  //
  // RLS discipline: SELECT executes on the pool connection without setting
  // choros.tenant_id GUC. This is correct ONLY because the pool role is
  // choros_migrator (BYPASSRLS superuser) in the current T-0140 architecture.
  // When T-0022 splits the pool to choros_app (NOBYPASSRLS), this route will
  // require a SECURITY DEFINER function to perform the slug→UUID lookup.
  // -------------------------------------------------------------------------
  router.register("GET", "/api/tenants/:slug", withAuth(async (req, res, params) => {
    const slug = params["slug"] as string;
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ id: string; slug: string }>(
        `SELECT id, slug FROM choros.tenant WHERE slug = $1 LIMIT 1`,
        [slug],
      );
      if (rows.length === 0) {
        throw new HttpError(404, "NOT_FOUND", `tenant with slug '${slug}' not found`);
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(rows[0]));
    } finally {
      client.release();
    }
  }));

  // -------------------------------------------------------------------------
  // GET /api/org/tenant-state — get current tenant state for reset diff (by tenant_id query param)
  // Auth gate: authorizeOrgWrite → loadAdminContext → isGenesisOwner (R-3: same gate
  // as the write routes — this is the read-counterpart of the importer write surface).
  // T-0388: gate against the resolved authority tenant (caller's own, or DEV_TENANT_ID
  // for the bootstrap forest-owner); a non-forest-owner cannot read another tenant's
  // state (cross-tenant → 403).
  // -------------------------------------------------------------------------
  router.register("GET", "/api/org/tenant-state", withAuth(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const tenantId = url.searchParams.get("tenant_id");
    if (!tenantId) {
      throw new HttpError(400, "VALIDATION", "tenant_id query param required");
    }
    assertUuidShape(tenantId, "tenant_id");

    // T-0388: cross-tenant guard + gate against the resolved authority tenant —
    // a caller may read only their OWN tenant's state (the bootstrap forest-owner
    // may read any tenant, since the importer diffs arbitrary tenants).
    const { actorId, authTenantId } = await authorizeOrgWrite(req, pool, tenantId, nowMs());
    const admin = await loadAdminContext(pool, authTenantId, actorId, nowMs());
    // T-0469: owner OR a holder of any covering delegable org-object mgmt grant may
    // read the state to diff/author it (the read-counterpart of the write surface).
    if (!admin.isGenesisOwner && !hasOrgObjectAuthority(admin)) {
      throw new HttpError(403, "NOT_OWNER", "owner or org-object grant required to read tenant state");
    }

    const state = await withTenantTx(pool, tenantId, async (client) => {
      const depts = await client.query<{ id: string; slug: string }>(
        `SELECT id, slug FROM choros.department WHERE tenant_id = $1 ORDER BY slug`,
        [tenantId],
      );
      const positions = await client.query<{ id: string; slug: string; department_id: string }>(
        `SELECT id, slug, department_id FROM choros.position WHERE tenant_id = $1 ORDER BY slug`,
        [tenantId],
      );
      // T-0608 (пункт г): display_name is now selected alongside id/slug — this
      // is additive (widens the row shape, never narrows it), so the existing
      // reset-diff importer consumer is unaffected. Before this fix, callers of
      // this endpoint (e.g. screen-rights.jsx's "Назначить роль" employee
      // picker) had NO display name to render at all and fell back to the raw
      // slug — for a KC-registered human, slug == the Keycloak user UUID, so
      // the dropdown showed a bare UUID regardless of what the employee row's
      // display_name column actually held.
      const employees = await client.query<{ id: string; slug: string; display_name: string }>(
        `SELECT id, slug, display_name FROM choros.employee WHERE tenant_id = $1 ORDER BY slug`,
        [tenantId],
      );
      const roles = await client.query<{ id: string; slug: string }>(
        `SELECT id, slug FROM choros.role WHERE tenant_id = $1 ORDER BY slug`,
        [tenantId],
      );
      return {
        departments: depts.rows,
        positions: positions.rows,
        employees: employees.rows,
        roles: roles.rows,
      };
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(state));
  }));
}
