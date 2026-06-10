/**
 * src/db/org.ts
 *
 * DB access layer for org structure queries (T-0017 ADR §3.6).
 * Backed by the choros_app role; all queries execute inside SET LOCAL transactions
 * following the T-0013 tenant_id GUC pattern.
 *
 * Exports: listOrgTree, findEmployeeById, listHumanEmployees
 */
import pg from "pg";

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
// Helper: run a query inside a tenant-scoped transaction (SET LOCAL)
// ---------------------------------------------------------------------------

async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
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
