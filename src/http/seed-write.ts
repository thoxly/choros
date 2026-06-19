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
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { loadAdminContext } from "../db/org.js";
import { validateAdminDelegation } from "../core/scoped-admin.js";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// extractActor — identical to grants.ts pattern (FF-6 requires same seam)
// No hardcoded slug comparison (FF-6 / AC-18).
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

// Minimal oracle for the scope validation — same seed as grants.ts
import type { AncestryOracle } from "../core/grant-lattice.js";

const SEED_ORACLE: AncestryOracle = {
  isDescendantOrSelf(_hierarchy, descendantId, ancestorId) {
    if (descendantId === ancestorId) return true;
    const CHILDREN: Record<string, string[]> = {
      "b0000000-0000-0000-0000-000000000001": [],
      "b0000000-0000-0000-0000-000000000002": [],
      "b0000000-0000-0000-0000-000000000003": [],
    };
    const children = CHILDREN[ancestorId] ?? [];
    for (const c of children) {
      if (this.isDescendantOrSelf(_hierarchy, descendantId, c)) return true;
    }
    return false;
  },
};

export function registerSeedWriteRoutes(router: Router, pool: pg.Pool): void {
  const nowMs = () => Date.now();

  // -------------------------------------------------------------------------
  // POST /api/tenants — create a named tenant (bootstrap-class, isGenesisOwner gate)
  // body: { slug: string, display_name: string }
  // 201: { id: uuid, slug: string }
  // 409: slug exists
  // -------------------------------------------------------------------------
  router.register("POST", "/api/tenants", withAuth(async (req, res) => {
    const actorId = extractActor(req);
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
    const actorId = extractActor(req);
    const admin = await loadAdminContext(pool, DEV_TENANT_ID, actorId, nowMs());
    if (!admin.isGenesisOwner) {
      throw new HttpError(403, "NOT_OWNER", "genesis owner required to create departments");
    }

    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;

    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required");
    }
    assertUuidShape(tenant_id, "tenant_id");

    const slug = b["slug"];
    if (typeof slug !== "string" || slug.length === 0) {
      throw new HttpError(400, "VALIDATION", "slug is required");
    }
    const display_name = b["display_name"];
    if (typeof display_name !== "string" || display_name.length === 0) {
      throw new HttpError(400, "VALIDATION", "display_name is required");
    }
    const parent_id = b["parent_id"] ?? null;
    if (parent_id !== null) {
      assertUuidShape(parent_id as string, "parent_id");
    }

    const id = randomUUID();
    const ts = nowMs();

    try {
      await withTenantTx(pool, tenant_id, async (client) => {
        await client.query(
          `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [tenant_id, id, parent_id, slug, display_name, ts],
        );
      });
    } catch (err) {
      if (isConflict(err)) {
        throw new HttpError(409, "CONFLICT", `department with slug '${slug}' already exists in tenant`);
      }
      throw err;
    }

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id, slug }));
  }));

  // -------------------------------------------------------------------------
  // POST /api/positions — create a position inside a department (isGenesisOwner gate)
  // body: { tenant_id: uuid, department_id: uuid, slug: string, title: string }
  // 201: { id: uuid, slug: string }
  // 409: (tenant_id, department_id, slug) exists
  // -------------------------------------------------------------------------
  router.register("POST", "/api/positions", withAuth(async (req, res) => {
    const actorId = extractActor(req);
    const admin = await loadAdminContext(pool, DEV_TENANT_ID, actorId, nowMs());
    if (!admin.isGenesisOwner) {
      throw new HttpError(403, "NOT_OWNER", "genesis owner required to create positions");
    }

    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;

    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required");
    }
    assertUuidShape(tenant_id, "tenant_id");

    const department_id = b["department_id"];
    if (typeof department_id !== "string") {
      throw new HttpError(400, "VALIDATION", "department_id is required");
    }
    assertUuidShape(department_id, "department_id");

    const slug = b["slug"];
    if (typeof slug !== "string" || slug.length === 0) {
      throw new HttpError(400, "VALIDATION", "slug is required");
    }
    const title = b["title"];
    if (typeof title !== "string" || title.length === 0) {
      throw new HttpError(400, "VALIDATION", "title is required");
    }

    const id = randomUUID();
    const ts = nowMs();

    try {
      await withTenantTx(pool, tenant_id, async (client) => {
        await client.query(
          `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [tenant_id, id, department_id, slug, title, ts],
        );
      });
    } catch (err) {
      if (isConflict(err)) {
        throw new HttpError(409, "CONFLICT", `position with slug '${slug}' already exists in department`);
      }
      throw err;
    }

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id, slug }));
  }));

  // -------------------------------------------------------------------------
  // POST /api/employees — create an employee (isGenesisOwner gate)
  // body: { tenant_id: uuid, position_id?: uuid|null, kind: "human"|"agent", slug: string, display_name: string }
  // 201: { id: uuid, slug: string }
  // 409: (tenant_id, slug) exists
  // 400: kind not in {human,agent}
  // -------------------------------------------------------------------------
  router.register("POST", "/api/employees", withAuth(async (req, res) => {
    const actorId = extractActor(req);
    const admin = await loadAdminContext(pool, DEV_TENANT_ID, actorId, nowMs());
    if (!admin.isGenesisOwner) {
      throw new HttpError(403, "NOT_OWNER", "genesis owner required to create employees");
    }

    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;

    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required");
    }
    assertUuidShape(tenant_id, "tenant_id");

    const kind = b["kind"];
    if (kind !== "human" && kind !== "agent") {
      throw new HttpError(400, "VALIDATION", "kind must be 'human' or 'agent'");
    }
    const slug = b["slug"];
    if (typeof slug !== "string" || slug.length === 0) {
      throw new HttpError(400, "VALIDATION", "slug is required");
    }
    const display_name = b["display_name"];
    if (typeof display_name !== "string" || display_name.length === 0) {
      throw new HttpError(400, "VALIDATION", "display_name is required");
    }
    const position_id = b["position_id"] ?? null;
    if (position_id !== null) {
      assertUuidShape(position_id as string, "position_id");
    }

    const id = randomUUID();
    const ts = nowMs();

    try {
      await withTenantTx(pool, tenant_id, async (client) => {
        await client.query(
          `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
          [tenant_id, id, position_id, kind, slug, display_name, ts],
        );
      });
    } catch (err) {
      if (isConflict(err)) {
        throw new HttpError(409, "CONFLICT", `employee with slug '${slug}' already exists in tenant`);
      }
      throw err;
    }

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id, slug }));
  }));

  // -------------------------------------------------------------------------
  // POST /api/roles — create a role (mgmt_object:role:create grant gate, ADR §2.3 option C)
  // body: { tenant_id: uuid, slug: string, display_name: string, description?: string|null }
  // 201: { id: uuid, slug: string }
  // 409: (tenant_id, slug) exists
  // -------------------------------------------------------------------------
  router.register("POST", "/api/roles", withAuth(async (req, res) => {
    const actorId = extractActor(req);

    // Read body first so we can use target tenant_id in the delegation context (R-4)
    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;

    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required");
    }
    assertUuidShape(tenant_id, "tenant_id");

    // Gate: loadAdminContext → validateAdminDelegation for mgmt_object:role:create (FF-6, AC-18)
    // Admin context uses DEV_TENANT_ID (genesis-owner lives there per ADR §2.3 option C).
    // syntheticGrant.tenantId uses target tenant_id so delegation context is scoped
    // to the tenant being written into (R-4).
    const admin = await loadAdminContext(pool, DEV_TENANT_ID, actorId, nowMs());

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

    const gateResult = validateAdminDelegation(
      admin,
      { kind: "grant", childGrant: syntheticGrant as import("../core/grant-lattice.js").Grant, targetOrgScope: admin.adminOrgScope },
      SEED_ORACLE,
    );

    if (!gateResult.ok) {
      throw new HttpError(403, "NOT_OWNER", "insufficient delegation to create roles");
    }

    const slug = b["slug"];
    if (typeof slug !== "string" || slug.length === 0) {
      throw new HttpError(400, "VALIDATION", "slug is required");
    }
    const display_name = b["display_name"];
    if (typeof display_name !== "string" || display_name.length === 0) {
      throw new HttpError(400, "VALIDATION", "display_name is required");
    }
    const description = b["description"] ?? null;

    const id = randomUUID();
    const ts = nowMs();

    try {
      await withTenantTx(pool, tenant_id, async (client) => {
        await client.query(
          `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [tenant_id, id, slug, display_name, description, ts],
        );
      });
    } catch (err) {
      if (isConflict(err)) {
        throw new HttpError(409, "CONFLICT", `role with slug '${slug}' already exists in tenant`);
      }
      throw err;
    }

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id, slug }));
  }));

  // -------------------------------------------------------------------------
  // DELETE /api/departments/:id — delete a department (isGenesisOwner gate, AC-9)
  // body: { tenant_id: uuid } — tenant_id from the target entity (R-1: must match
  //   the tenant the entity was created in, not DEV_TENANT_ID).
  // Auth gate uses DEV_TENANT_ID (genesis-owner is in the dev silo by construction).
  // RLS scope and WHERE use the caller-supplied tenant_id.
  // -------------------------------------------------------------------------
  router.register("DELETE", "/api/departments/:id", withAuth(async (req, res, params) => {
    const actorId = extractActor(req);
    // Auth gate: genesis-owner check always in dev silo (ADR §2.3 option C)
    const admin = await loadAdminContext(pool, DEV_TENANT_ID, actorId, nowMs());
    if (!admin.isGenesisOwner) {
      throw new HttpError(403, "NOT_OWNER", "genesis owner required to delete departments");
    }

    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;
    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required in request body");
    }
    assertUuidShape(tenant_id, "tenant_id");

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
    const actorId = extractActor(req);
    const admin = await loadAdminContext(pool, DEV_TENANT_ID, actorId, nowMs());
    if (!admin.isGenesisOwner) {
      throw new HttpError(403, "NOT_OWNER", "genesis owner required to delete positions");
    }

    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;
    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required in request body");
    }
    assertUuidShape(tenant_id, "tenant_id");

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
    const actorId = extractActor(req);
    const admin = await loadAdminContext(pool, DEV_TENANT_ID, actorId, nowMs());
    if (!admin.isGenesisOwner) {
      throw new HttpError(403, "NOT_OWNER", "genesis owner required to delete employees");
    }

    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;
    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required in request body");
    }
    assertUuidShape(tenant_id, "tenant_id");

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
    const actorId = extractActor(req);
    const admin = await loadAdminContext(pool, DEV_TENANT_ID, actorId, nowMs());
    if (!admin.isGenesisOwner) {
      throw new HttpError(403, "NOT_OWNER", "genesis owner required to delete roles");
    }

    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;
    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required in request body");
    }
    assertUuidShape(tenant_id, "tenant_id");

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
  // Auth gate: extractActor → loadAdminContext → isGenesisOwner (R-3: same gate as write routes).
  // The importer already sends X-Dev-User: e-owner in all requests, so this is transparent.
  // -------------------------------------------------------------------------
  router.register("GET", "/api/org/tenant-state", withAuth(async (req, res) => {
    // Auth gate: genesis-owner required (R-3)
    const actorId = extractActor(req);
    const admin = await loadAdminContext(pool, DEV_TENANT_ID, actorId, nowMs());
    if (!admin.isGenesisOwner) {
      throw new HttpError(403, "NOT_OWNER", "genesis owner required to read tenant state");
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const tenantId = url.searchParams.get("tenant_id");
    if (!tenantId) {
      throw new HttpError(400, "VALIDATION", "tenant_id query param required");
    }
    assertUuidShape(tenantId, "tenant_id");

    const state = await withTenantTx(pool, tenantId, async (client) => {
      const depts = await client.query<{ id: string; slug: string }>(
        `SELECT id, slug FROM choros.department WHERE tenant_id = $1 ORDER BY slug`,
        [tenantId],
      );
      const positions = await client.query<{ id: string; slug: string; department_id: string }>(
        `SELECT id, slug, department_id FROM choros.position WHERE tenant_id = $1 ORDER BY slug`,
        [tenantId],
      );
      const employees = await client.query<{ id: string; slug: string }>(
        `SELECT id, slug FROM choros.employee WHERE tenant_id = $1 ORDER BY slug`,
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
