/**
 * src/db/org.ts
 *
 * DB access layer for org structure queries (T-0017 ADR §3.6) plus
 * the admin-context helpers introduced by T-0030 (write-path only).
 *
 * Exports:
 *   listOrgTree, findEmployeeById, listHumanEmployees   (T-0017)
 *   isGenesisOwnerForTenant, loadAdminContext           (T-0030)
 */
import pg from "pg";
import type { Grant, ScopeElement } from "../core/grant-lattice.js";
import type { AdminContext } from "../core/scoped-admin.js";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Types (mirrors ORG_SEED shape for backwards-compat with HTTP layer)
// ---------------------------------------------------------------------------

export type OrgPerson = {
  id: string;
  name: string;
  type: "human" | "agent";
};

export type OrgPosition = {
  id: string;
  title: string;
  people: OrgPerson[];
};

export type OrgDepartment = {
  id: string;
  name: string;
  positions: OrgPosition[];
};

// ---------------------------------------------------------------------------
// Dev tenant UUID (matches migration 013 seed)
// ---------------------------------------------------------------------------

export const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// Pool factory (lazy singleton keyed on DATABASE_URL)
// ---------------------------------------------------------------------------

let _pool: pg.Pool | null = null;

export function getOrgPool(): pg.Pool {
  if (!_pool) {
    const url = process.env["DATABASE_URL"];
    if (!url) {
      throw new Error("DATABASE_URL not set — cannot build org pool");
    }
    _pool = new Pool({ connectionString: url });
  }
  return _pool;
}

// ---------------------------------------------------------------------------
// UUID shape guard (defense-in-depth per T-0013 / T-0116 R-3 pattern)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// Helper: run a query inside a tenant-scoped transaction (SET LOCAL)
// ---------------------------------------------------------------------------

async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuid(tenantId, "tenantId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SET LOCAL choros.tenant_id = '${tenantId}'`,
    );
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
// listOrgTree — returns the full org tree: department → position → people
// Response shape matches the ORG_SEED structure consumed by the web frontend.
// ---------------------------------------------------------------------------

export async function listOrgTree(
  pool: pg.Pool,
  tenantId: string,
): Promise<OrgDepartment[]> {
  return withTenant(pool, tenantId, async (client) => {
    // Fetch all departments (root only for now; no parent_id traversal needed
    // since the dev silo has flat root departments — tree traversal is an
    // autonomous improvement for T-0022 org-scope resolution).
    const deptRows = await client.query<{
      id: string;
      slug: string;
      display_name: string;
    }>(
      `SELECT id, slug, display_name FROM choros.department ORDER BY slug`,
    );

    const departments: OrgDepartment[] = [];

    for (const dept of deptRows.rows) {
      // Fetch positions for this department.
      const posRows = await client.query<{
        id: string;
        slug: string;
        title: string;
      }>(
        `SELECT id, slug, title FROM choros.position
         WHERE department_id = $1
         ORDER BY slug`,
        [dept.id],
      );

      const positions: OrgPosition[] = [];

      for (const pos of posRows.rows) {
        // Fetch employees for this position.
        const empRows = await client.query<{
          id: string;
          slug: string;
          display_name: string;
          kind: string;
        }>(
          `SELECT id, slug, display_name, kind FROM choros.employee
           WHERE position_id = $1
           ORDER BY slug`,
          [pos.id],
        );

        const people: OrgPerson[] = empRows.rows.map((e) => ({
          id: e.slug,
          name: e.display_name,
          type: e.kind as "human" | "agent",
        }));

        positions.push({
          id: pos.slug,
          title: pos.title,
          people,
        });
      }

      departments.push({
        id: dept.slug,
        name: dept.display_name,
        positions,
      });
    }

    return departments;
  });
}

// ---------------------------------------------------------------------------
// findEmployeeById — resolve employee by slug; returns position + department name
// Returns null if not found.
// ---------------------------------------------------------------------------

export async function findEmployeeById(
  pool: pg.Pool,
  tenantId: string,
  slug: string,
): Promise<(OrgPerson & { position: string; department: string }) | null> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{
      slug: string;
      display_name: string;
      kind: string;
      position_title: string;
      department_name: string;
    }>(
      `SELECT e.slug, e.display_name, e.kind,
              p.title AS position_title,
              d.display_name AS department_name
         FROM choros.employee e
         LEFT JOIN choros.position p
               ON p.tenant_id = e.tenant_id AND p.id = e.position_id
         LEFT JOIN choros.department d
               ON d.tenant_id = p.tenant_id AND d.id = p.department_id
        WHERE e.slug = $1`,
      [slug],
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.slug,
      name: row.display_name,
      type: row.kind as "human" | "agent",
      position: row.position_title ?? "",
      department: row.department_name ?? "",
    };
  });
}

// ---------------------------------------------------------------------------
// listHumanEmployees — returns only kind='human' employees with position + department
// Used by GET /api/users (listSelectableUsers).
// ---------------------------------------------------------------------------

export async function listHumanEmployees(
  pool: pg.Pool,
  tenantId: string,
): Promise<Array<{ id: string; name: string; position: string; department: string }>> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{
      slug: string;
      display_name: string;
      position_title: string;
      department_name: string;
    }>(
      `SELECT e.slug, e.display_name,
              p.title AS position_title,
              d.display_name AS department_name
         FROM choros.employee e
         LEFT JOIN choros.position p
               ON p.tenant_id = e.tenant_id AND p.id = e.position_id
         LEFT JOIN choros.department d
               ON d.tenant_id = p.tenant_id AND d.id = p.department_id
        WHERE e.kind = 'human'
        ORDER BY e.slug`,
    );

    return rows.map((row) => ({
      id: row.slug,
      name: row.display_name,
      position: row.position_title ?? "",
      department: row.department_name ?? "",
    }));
  });
}

// ---------------------------------------------------------------------------
// isGenesisOwnerForTenant — T-0030 AC-15 / NF-3
//
// Returns true iff the actor holds the tenant-owner role via a confirmed,
// in-window role_assignment. isGenesisOwner is ALWAYS resolved from the DB
// — never assumed or derived from a JWT claim (NF-3).
// ---------------------------------------------------------------------------

export async function isGenesisOwnerForTenant(
  pool: pg.Pool,
  tenantId: string,
  actorEmployeeId: string,
  nowMs: number,
): Promise<boolean> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT ra.id
         FROM choros.role_assignment ra
         JOIN choros.role r
              ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        WHERE ra.tenant_id = $1
          AND ra.employee_id = (
                SELECT id FROM choros.employee
                 WHERE tenant_id = $1 AND slug = $2 LIMIT 1
              )
          AND r.slug = 'tenant-owner'
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $3)
        LIMIT 1`,
      [tenantId, actorEmployeeId, nowMs],
    );
    return rows.length > 0;
  });
}

// ---------------------------------------------------------------------------
// loadAdminContext — T-0030 FR-2
//
// Builds the AdminContext needed by validateAdminDelegation.
// Three-query sequence inside one withTenant call:
//   1. isGenesisOwner (via isGenesisOwnerForTenant helper, re-using the
//      already-acquired client to stay in the same transaction scope).
//   2. All confirmed, in-window role_assignment rows for the actor.
//   3. For each assignment, all confirmed, in-window, delegable=true grants
//      on the assigned role where resource_type starts with mgmt_object:.
// ---------------------------------------------------------------------------

export async function loadAdminContext(
  pool: pg.Pool,
  tenantId: string,
  actorEmployeeId: string,
  nowMs: number,
): Promise<AdminContext> {
  return withTenant(pool, tenantId, async (client) => {
    // Step 1: resolve isGenesisOwner from DB (AC-15 / NF-3).
    const { rows: ownerRows } = await client.query<{ id: string }>(
      `SELECT ra.id
         FROM choros.role_assignment ra
         JOIN choros.role r
              ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        WHERE ra.tenant_id = $1
          AND ra.employee_id = (
                SELECT id FROM choros.employee
                 WHERE tenant_id = $1 AND slug = $2 LIMIT 1
              )
          AND r.slug = 'tenant-owner'
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $3)
        LIMIT 1`,
      [tenantId, actorEmployeeId, nowMs],
    );
    const isGenesisOwner = ownerRows.length > 0;

    // Step 2: load confirmed, in-window assignments for the actor.
    const { rows: raRows } = await client.query<{
      id: string;
      role_id: string;
      org_scope: unknown;
    }>(
      `SELECT ra.id, ra.role_id, ra.org_scope
         FROM choros.role_assignment ra
        WHERE ra.tenant_id = $1
          AND ra.employee_id = (
                SELECT id FROM choros.employee
                 WHERE tenant_id = $1 AND slug = $2 LIMIT 1
              )
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $3)`,
      [tenantId, actorEmployeeId, nowMs],
    );

    // Step 3: for each assignment, load delegable mgmt_object:* grants on its role.
    const adminGrantsList: Grant[] = [];
    for (const ra of raRows) {
      const { rows: grantRows } = await client.query<{
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
          WHERE g.tenant_id = $1
            AND g.role_id = $2
            AND g.resource_type LIKE 'mgmt_object:%'
            AND g.delegable = true
            AND (g.valid_from  IS NULL OR g.valid_from  <= $3)
            AND (g.valid_until IS NULL OR g.valid_until  > $3)`,
        [tenantId, ra.role_id, nowMs],
      );

      for (const g of grantRows) {
        adminGrantsList.push({
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
        });
      }
    }

    // Construct adminOrgScope: union of assignment org_scope values.
    // Single assignment → use its org_scope directly.
    // Multiple assignments → wrap in a set (the lattice supports sets of atoms).
    let adminOrgScope: ScopeElement;
    if (raRows.length === 0) {
      // No assignments → bottom (empty set = no org authority).
      adminOrgScope = { kind: "set", members: [] };
    } else if (raRows.length === 1) {
      adminOrgScope = raRows[0].org_scope as ScopeElement;
    } else {
      // Collect all unique members; if any member is already a set, flatten it.
      const members: Array<Exclude<ScopeElement, { kind: "set" }>> = [];
      for (const ra of raRows) {
        const s = ra.org_scope as ScopeElement;
        if (s.kind === "set") {
          for (const m of s.members) {
            members.push(m);
          }
        } else {
          members.push(s as Exclude<ScopeElement, { kind: "set" }>);
        }
      }
      adminOrgScope = { kind: "set", members };
    }

    return { isGenesisOwner, adminGrants: adminGrantsList, adminOrgScope };
  });
}
