/**
 * src/db/grants-dao.ts — T-0331 (E15-S0a): Live DB getGrants DAO
 *
 * Reusable DAO that resolves an actor's CURRENT role slugs from the live DB
 * grant source (via role_assignment → role), replacing the in-memory
 * `rolesForUser` fixture in inbox.ts.
 *
 * Design:
 *  - Conforms to the `GrantSource` interface (grant-resolver.ts §3.2): returns
 *    the full `Grant[]` array via `getGrantsForSubject` so callers like the PDP
 *    can use it directly. The `getRoleSlugsForActor` helper is the thin projection
 *    needed by the inbox (role-slug set for pool-task filtering).
 *  - Tenant-isolation: every query runs inside a `SET LOCAL choros.tenant_id`
 *    transaction (RLS). Follows the withTenant pattern from src/db/org.ts.
 *  - No `nowMs` time-window filtering for role slugs: the inbox only needs
 *    CONFIRMED assignments (confirmed_by IS NOT NULL) regardless of
 *    valid_from/valid_until. Time-window filtering is the PDP's responsibility
 *    (grant-resolver.ts step 3 / isEffective). The inbox role-check is a
 *    structural eligibility gate, not a full PDP decision.
 *  - Reuse design: `getGrantsForSubject` provides the full Grant[] path for S2
 *    (executor-resolution, T-0336) and S1 (resolveFor seam, T-0335).
 *
 * Tenant-RLS guard: tenant_id is UUID-validated before interpolation (mirrors
 * org.ts assertUuid pattern — defence-in-depth per T-0013 / T-0116 R-3).
 */

import pg from "pg";
import type { Grant } from "../core/grant-lattice.js";
import type { ResolveSubject } from "../core/object-handle.js";
import type { GrantSource } from "../core/grant-resolver.js";

// ---------------------------------------------------------------------------
// UUID shape guard (mirrors org.ts — defence-in-depth, T-0116 R-3)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// withTenantReadTx — tenant-scoped read transaction (mirrors org.ts withTenant)
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
// getGrantsForSubject — full Grant[] from live DB (GrantSource interface shape)
//
// Loads confirmed, in-window role_assignments for the subject (by employee slug),
// then fetches confirmed grants for those roles.
//
// This is the reusable foundation for:
//   S0a (T-0331): role-slug DAO for inbox.ts
//   S1 (T-0335):  resolveFor seam (applier needs grant PDP)
//   S2 (T-0336):  executor resolution via PDP claim-check
//
// `nowMs` is used for validity-window filtering: NULL valid_from = effective
// from the start; NULL valid_until = no end. Half-open window [from, until).
// This mirrors grant-resolver.ts isEffective semantics exactly.
// ---------------------------------------------------------------------------

export async function getGrantsForSubject(
  pool: pg.Pool,
  tenantId: string,
  actorSlug: string,
  nowMs: number,
): Promise<Grant[]> {
  return withTenantReadTx(pool, tenantId, async (client) => {
    // Step 1: resolve actor slug → employee id (within tenant, RLS-scoped).
    const { rows: empRows } = await client.query<{ id: string }>(
      `SELECT id FROM choros.employee
        WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
      [tenantId, actorSlug],
    );
    if (empRows.length === 0) {
      // Unknown actor → no grants (fail open to empty, not an error).
      return [];
    }
    const employeeId = empRows[0]!.id;

    // Step 2: load confirmed, in-window role_assignments for the employee.
    // confirmed_by IS NOT NULL = confirmed (NF per migration 020 contract).
    // valid_from/until window: NULL = unbounded on that side.
    const { rows: raRows } = await client.query<{ role_id: string }>(
      `SELECT ra.role_id
         FROM choros.role_assignment ra
        WHERE ra.tenant_id = $1
          AND ra.employee_id = $2
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $3)`,
      [tenantId, employeeId, nowMs],
    );
    if (raRows.length === 0) {
      return [];
    }
    const roleIds = raRows.map((r) => r.role_id);

    // Step 3: load confirmed grants for those roles.
    // confirmed_by IS NOT NULL = active grant (migration 031 dual-control contract).
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
      `SELECT id, role_id, resource_type, resource_facet,
              operation, scope, "constraint", delegable,
              granted_by, valid_from, valid_until, created_at
         FROM choros."grant"
        WHERE tenant_id = $1
          AND role_id = ANY($2::uuid[])
          AND confirmed_by IS NOT NULL`,
      [tenantId, roleIds],
    );

    return grantRows.map((g) => ({
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
  });
}

// ---------------------------------------------------------------------------
// makeDbGrantSource — build a GrantSource from a pool for use with the PDP
// (grant-resolver.ts ResolverDeps.grants interface).
//
// The GrantSource.getGrants interface takes a ResolveSubject (tenantId +
// subjectId = employee slug) and nowMs, so it maps cleanly to getGrantsForSubject.
// This is the reuse seam for S1 / S2 — the inbox uses getRoleSlugsForActor
// directly; the PDP uses makeDbGrantSource.
// ---------------------------------------------------------------------------

export function makeDbGrantSource(pool: pg.Pool): GrantSource {
  return {
    async getGrants(subject: ResolveSubject, nowMs: number): Promise<Grant[]> {
      return getGrantsForSubject(pool, subject.tenantId, subject.subjectId, nowMs);
    },
  };
}

// ---------------------------------------------------------------------------
// getRoleSlugsForActor — projection: actor's confirmed, in-window role slugs
//
// The thin projection the inbox.ts `rolesForUser` replacement needs: given an
// actor slug, returns the set of role slugs (e.g. ["fin-ctrl", "role-approver"])
// that actor holds via confirmed, in-window role_assignments.
//
// Role slugs are used by the inbox for pool-task filtering (tab "Из пула") and
// the claim/approve eligibility gate. They are NOT used for PDP decisions —
// that path goes through getGrantsForSubject → resolveFor.
//
// Returns [] (empty array) for an unknown actor (no employee row, no assignments,
// or no valid roles) — the same sentinel as the in-memory rolesForUser fallback.
//
// T-0366 — fallback slug for KC seed personas:
//   Under Keycloak auth mode, the KC JWT `sub` is a random UUID that does
//   not match employee.slug for seed dev personas (e.g. e-larina.slug='e-larina'
//   but KC sub='f4a5f440-…'). The optional `fallbackSlug` param (preferred_username
//   from the JWT) is tried ONLY when the primary lookup returns no employee row.
//
//   Security invariant: primary is ALWAYS tried first and short-circuits — the
//   fallback is never consulted for registered users (slug == sub, so primary hits).
//   The fallback only activates when the primary slug matches NO employee, which
//   happens exclusively for seed personas whose KC sub was not set from their slug.
// ---------------------------------------------------------------------------

export async function getRoleSlugsForActor(
  pool: pg.Pool,
  tenantId: string,
  actorSlug: string,
  nowMs: number = Date.now(),
  fallbackSlug?: string,
): Promise<string[]> {
  return withTenantReadTx(pool, tenantId, async (client) => {
    // Resolve actor slug → employee id.
    // T-0366: try primary first; if no row AND fallback is provided (and distinct),
    // try the fallback slug. The primary short-circuits so registered users
    // (slug == sub) never reach the fallback path — no impersonation risk.
    const { rows: empRows } = await client.query<{ id: string }>(
      `SELECT id FROM choros.employee
        WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
      [tenantId, actorSlug],
    );

    let employeeId: string;
    if (empRows.length > 0) {
      employeeId = empRows[0]!.id;
    } else if (fallbackSlug !== undefined && fallbackSlug !== actorSlug) {
      // Primary slug matched no employee — try the fallback (preferred_username).
      const { rows: fbRows } = await client.query<{ id: string }>(
        `SELECT id FROM choros.employee
          WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
        [tenantId, fallbackSlug],
      );
      if (fbRows.length === 0) {
        return [];
      }
      employeeId = fbRows[0]!.id;
    } else {
      return [];
    }

    // Confirmed, in-window assignments → role slugs in one join.
    const { rows } = await client.query<{ slug: string }>(
      `SELECT DISTINCT r.slug
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
    return rows.map((r) => r.slug);
  });
}
