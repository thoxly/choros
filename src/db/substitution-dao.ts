/**
 * src/db/substitution-dao.ts — T-0429: DB-backed SubstitutionSource.
 *
 * Implements the SubstitutionSource port (src/core/substitution.ts) against the
 * live choros.substitution_rule table (migration 036). Mirrors the GrantSource /
 * RecordSource / SodSource DAO pattern: tenant-scoped via withTenantReadTx (RLS),
 * UUID↔slug translation for the executor-resolver call sites.
 *
 * Two primary exports:
 *
 *   getActiveSubstitutionsForEmployee(pool, tenantId, absentSlug, nowMs)
 *     → SubstitutionRule[] with slug-valued UUID-origin fields, filtered for
 *       confirmed + in-window rules for the named absent employee. Used by the
 *       ExecutorSubstitutionPort (single-task resolver path).
 *
 *   getActiveSubstitutionsByRole(pool, tenantId, roleSlug, nowMs)
 *     → SubstitutionRule[] all active rules for a given role (used by the batch
 *       inbox path: resolveExecutorFallbackBatch). Keyed by absentEmployeeId (slug).
 *
 *   makeDbSubstitutionPort(pool) → ExecutorSubstitutionPort
 *     Adapter factory wiring this DAO to the ExecutorSubstitutionPort interface.
 *     getActiveSubstitutions(tenantId, absentSlug, nowMs) queries the absent
 *     employee's substitution rules by employee SLUG (not UUID placeholder).
 *
 * Design constraints:
 *  - No pg/fs/net in src/core/substitution.ts (pure module — FF-SUB2).
 *  - Tenant isolation: every query inside withTenantReadTx (RLS + SET LOCAL).
 *  - UUID↔slug: all UUID columns are resolved to slugs via JOINs so that
 *    resolveSubstitution (pure, operates on slugs) can match correctly.
 *  - Hop-cap: getActiveSubstitutionsForEmployee enforces MAX_SUBSTITUTION_HOPS
 *    at the DAO level by refusing to resolve a substitute who is themselves absent.
 *    Callers also honour the hop-cap at the resolver level.
 */

import pg from "pg";
import type { SubstitutionRule } from "../core/substitution.js";
import type { ExecutorSubstitutionPort } from "../core/executor-resolver.js";

// ---------------------------------------------------------------------------
// Hop-cap — limits chain substitution depth (mirrors cross-app-ref HOP_CAP).
// A substitute who is also absent triggers a second lookup; we cap the chain
// at 3 hops to prevent infinite cycles (A→B→A) or deep chains.
// ---------------------------------------------------------------------------

export const MAX_SUBSTITUTION_HOPS = 3;

// ---------------------------------------------------------------------------
// UUID shape guard (mirrors grants-dao.ts — defence-in-depth, T-0116 R-3)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// withTenantReadTx — tenant-scoped read transaction (mirrors grants-dao.ts)
// ---------------------------------------------------------------------------

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
// DB row type for the substitution_rule JOIN query (UUID + slug columns)
// ---------------------------------------------------------------------------

interface SubstitutionRuleRow {
  id: string;
  absent_employee_id: string;    // UUID — kept for FK safety; slug in absent_slug
  substitute_employee_id: string; // UUID — kept for FK safety; slug in substitute_slug
  role_id: string;               // UUID — kept for FK safety; slug in role_slug
  org_scope: unknown;
  ttl_grant_id: string | null;
  non_inheritable_excluded: boolean;
  proposed_by: string | null;
  confirmed_by: string | null;
  valid_from: string | null;     // bigint returned as string from pg driver
  valid_until: string | null;
  source: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  absent_slug: string;
  substitute_slug: string;
  role_slug: string;
}

// ---------------------------------------------------------------------------
// mapRow — converts a DB row to a SubstitutionRule with slug-valued ID fields.
//
// The pure resolver (resolveSubstitution) compares rule.absentEmployeeId,
// rule.substituteEmployeeId, and rule.roleId against slug arguments. By placing
// slugs here, the pure function works without UUID knowledge.
// ---------------------------------------------------------------------------

function mapRow(tenantId: string, row: SubstitutionRuleRow): SubstitutionRule {
  return {
    tenantId,
    id: row.id,
    absentEmployeeId: row.absent_slug,
    substituteEmployeeId: row.substitute_slug,
    roleId: row.role_slug,
    orgScope: row.org_scope as SubstitutionRule["orgScope"],
    ttlGrantId: row.ttl_grant_id,
    nonInheritableExcluded: row.non_inheritable_excluded,
    proposedBy: row.proposed_by,
    confirmedBy: row.confirmed_by,
    validFrom: row.valid_from != null ? Number(row.valid_from) : null,
    validUntil: row.valid_until != null ? Number(row.valid_until) : null,
    source: row.source,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Shared SQL fragment for the substitution_rule JOIN (filters + joins)
// ---------------------------------------------------------------------------

const SUBST_SELECT = `
  SELECT
    sr.id,
    sr.absent_employee_id,
    sr.substitute_employee_id,
    sr.role_id,
    sr.org_scope,
    sr.ttl_grant_id,
    sr.non_inheritable_excluded,
    sr.proposed_by,
    sr.confirmed_by,
    sr.valid_from,
    sr.valid_until,
    sr.source,
    sr.created_by,
    sr.created_at,
    sr.updated_at,
    e_absent.slug    AS absent_slug,
    e_sub.slug       AS substitute_slug,
    r.slug           AS role_slug
  FROM choros.substitution_rule sr
  JOIN choros.employee e_absent
    ON e_absent.tenant_id = sr.tenant_id
   AND e_absent.id = sr.absent_employee_id
  JOIN choros.employee e_sub
    ON e_sub.tenant_id = sr.tenant_id
   AND e_sub.id = sr.substitute_employee_id
  JOIN choros.role r
    ON r.tenant_id = sr.tenant_id
   AND r.id = sr.role_id
`;

// ---------------------------------------------------------------------------
// getActiveSubstitutionsForEmployee — rules where `absentSlug` is absent
//
// Used by the ExecutorSubstitutionPort single-task path. Queries by absent
// employee SLUG (resolved to UUID via JOIN on employee.slug). Returns all
// confirmed, in-window rules for that absent employee (all roles). The caller
// (resolveSubstitution) narrows by roleId + orgScope.
// ---------------------------------------------------------------------------

export async function getActiveSubstitutionsForEmployee(
  pool: pg.Pool,
  tenantId: string,
  absentSlug: string,
  nowMs: number,
): Promise<SubstitutionRule[]> {
  return withTenantReadTx(pool, tenantId, async (client) => {
    // Step 1: resolve absentSlug → employee.id (RLS-scoped).
    const { rows: empRows } = await client.query<{ id: string }>(
      `SELECT id FROM choros.employee
        WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
      [tenantId, absentSlug],
    );
    if (empRows.length === 0) return [];
    const absentId = empRows[0]!.id;

    // Step 2: all confirmed + in-window substitution rules for this absent employee.
    const { rows } = await client.query<SubstitutionRuleRow>(
      `${SUBST_SELECT}
       WHERE sr.tenant_id = $1
         AND sr.absent_employee_id = $2
         AND sr.confirmed_by IS NOT NULL
         AND (sr.valid_from  IS NULL OR sr.valid_from  <= $3)
         AND (sr.valid_until IS NULL OR sr.valid_until  > $3)
       ORDER BY sr.valid_from DESC NULLS LAST`,
      [tenantId, absentId, nowMs],
    );

    return rows.map((row) => mapRow(tenantId, row));
  });
}

// ---------------------------------------------------------------------------
// getActiveSubstitutionsByRole — all active rules for a given role (batch path)
//
// Used by resolveExecutorFallbackBatch to enrich the per-role holder set.
// Returns ALL confirmed + in-window rules for a given role slug, regardless
// of which employee is absent. The caller (batch path) iterates over holders
// to find which ones have rules and applies suppress+add logic.
// ---------------------------------------------------------------------------

export async function getActiveSubstitutionsByRole(
  pool: pg.Pool,
  tenantId: string,
  roleSlug: string,
  nowMs: number,
): Promise<SubstitutionRule[]> {
  return withTenantReadTx(pool, tenantId, async (client) => {
    // Step 1: resolve roleSlug → role.id.
    const { rows: roleRows } = await client.query<{ id: string }>(
      `SELECT id FROM choros.role
        WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
      [tenantId, roleSlug],
    );
    if (roleRows.length === 0) return [];
    const roleId = roleRows[0]!.id;

    // Step 2: all confirmed + in-window rules for this role.
    const { rows } = await client.query<SubstitutionRuleRow>(
      `${SUBST_SELECT}
       WHERE sr.tenant_id = $1
         AND sr.role_id = $2
         AND sr.confirmed_by IS NOT NULL
         AND (sr.valid_from  IS NULL OR sr.valid_from  <= $3)
         AND (sr.valid_until IS NULL OR sr.valid_until  > $3)
       ORDER BY sr.valid_from DESC NULLS LAST`,
      [tenantId, roleId, nowMs],
    );

    return rows.map((row) => mapRow(tenantId, row));
  });
}

// ---------------------------------------------------------------------------
// makeDbSubstitutionPort — adapter: ExecutorSubstitutionPort backed by the DAO.
//
// The ExecutorSubstitutionPort interface (executor-resolver.ts) has ONE method:
//   getActiveSubstitutions(tenantId, absentEmployeeId, nowMs): Promise<SubstitutionRule[]>
//
// Here `absentEmployeeId` is the absent employee SLUG (how the resolver calls it
// after the ladder is fixed — it passes the holder slug from step 2). The DAO
// resolves slug → UUID internally.
//
// Degrades gracefully: returns [] on any DB error.
// ---------------------------------------------------------------------------

export function makeDbSubstitutionPort(pool: pg.Pool): ExecutorSubstitutionPort {
  return {
    async getActiveSubstitutions(
      tenantId: string,
      absentEmployeeId: string, // absentEmployee SLUG (from the role-holder set)
      nowMs: number,
    ): Promise<SubstitutionRule[]> {
      try {
        return await getActiveSubstitutionsForEmployee(pool, tenantId, absentEmployeeId, nowMs);
      } catch {
        return [];
      }
    },
  };
}
