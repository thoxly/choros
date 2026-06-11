/**
 * src/db/audit-grant-trail.ts
 *
 * T-0031: DB query layer for the grant trail.
 *
 * Reads audit_event rows with type IN ('grant.create', 'grant.revoke',
 * 'assignment.create', 'assignment.revoke') for a given tenant.
 *
 * DESIGN INVARIANTS (ADR §4.2 / NF-4 — updated by T-0184 R-1 follow-up):
 *  - queryGrantTrail always executes inside withTenant() (sets choros.tenant_id GUC).
 *  - T-0184: explicit WHERE tenant_id = $N added for BYPASSRLS (choros_migrator) pool
 *    safety. Mirrors the T-0141 org.ts pattern. Additive — redundant but correct on
 *    NOBYPASSRLS connections where RLS already filters.
 *  - The function never queries the grant or role_assignment tables — only audit_event.
 *  - No DDL, no new tables; known_tenant_tables.txt is unchanged.
 */

import pg from "pg";

// ---------------------------------------------------------------------------
// GrantTrailRow — mirrors the audit_event columns the trail UI needs.
// Exported so HTTP layer and callers can type-check the response.
// ---------------------------------------------------------------------------

export type GrantTrailRow = {
  seq: number;
  id: string;
  type: string;
  actor: string;
  subject: string | null;
  scope: unknown | null;
  proposed_by: string | null;
  confirmed_by: string | null;
  payload: unknown;
  occurred_at: number;
};

// ---------------------------------------------------------------------------
// QueryGrantTrailOpts — filter parameters for queryGrantTrail.
// ---------------------------------------------------------------------------

export type QueryGrantTrailOpts = {
  roleId?: string;      // subject = roleId (grant events) OR payload->>'roleId' = roleId (assignment events)
  actor?: string;       // actor = actor
  subject?: string;     // subject = subject
  limit?: number;       // default 100, max 500
  beforeSeq?: number;   // seq < beforeSeq (cursor pagination)
};

// ---------------------------------------------------------------------------
// The four grant-family event types that belong in the grant trail.
// ---------------------------------------------------------------------------

const GRANT_TRAIL_TYPES = [
  "grant.create",
  "grant.revoke",
  "assignment.create",
  "assignment.revoke",
] as const;

// ---------------------------------------------------------------------------
// UUID shape guard (defense-in-depth, matching the T-0013 pattern in db/org.ts)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// withTenant — local copy of the T-0013 pattern from src/db/org.ts.
// Sets choros.tenant_id GUC inside a BEGIN/COMMIT/ROLLBACK block.
//
// NOTE (R-2): src/db/org.ts does NOT export withTenant (private module helper),
// so a shared import is not possible without a refactor that introduces a new
// shared module (e.g. src/db/tenant.ts).  That refactor is out of scope for
// T-0031; tracked as a future cleanup task.  The two implementations are
// byte-for-byte identical — any future change (e.g. new security GUC) must
// update both until the extraction happens.
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
// queryGrantTrail — the main query function.
//
// Always runs inside withTenant (sets GUC). Returns rows ordered newest-first
// (ORDER BY seq DESC). Cursor pagination via beforeSeq (seq < beforeSeq).
// Returns { rows, hasMore } — hasMore is true when the raw query returns
// limit+1 rows (the +1 probe row is stripped before returning).
// ---------------------------------------------------------------------------

export async function queryGrantTrail(
  pool: pg.Pool,
  tenantId: string,
  opts: QueryGrantTrailOpts,
): Promise<{ rows: GrantTrailRow[]; hasMore: boolean }> {
  const limit = Math.min(opts.limit ?? 100, 500);

  return withTenant(pool, tenantId, async (client) => {
    // Build params and conditions incrementally.
    // $1 is always the GRANT_TRAIL_TYPES array.
    // $2 is always the tenantId — explicit WHERE tenant_id guard for BYPASSRLS
    // (choros_migrator) pool safety (T-0184, mirrors T-0141 org.ts pattern).
    const params: unknown[] = [GRANT_TRAIL_TYPES, tenantId];
    let paramIdx = 2;

    const conditions: string[] = [
      `type = ANY($1::text[])`,
      `tenant_id = $2`,
    ];

    // actor filter
    if (opts.actor !== undefined) {
      paramIdx++;
      conditions.push(`actor = $${paramIdx}`);
      params.push(opts.actor);
    }

    // subject filter (direct column)
    if (opts.subject !== undefined) {
      paramIdx++;
      conditions.push(`subject = $${paramIdx}`);
      params.push(opts.subject);
    }

    // roleId filter: covers both grant events (subject = roleId) and
    // assignment events (payload->>'roleId' = roleId)
    if (opts.roleId !== undefined) {
      paramIdx++;
      conditions.push(
        `(subject = $${paramIdx} OR payload->>'roleId' = $${paramIdx})`,
      );
      params.push(opts.roleId);
    }

    // cursor pagination
    if (opts.beforeSeq !== undefined) {
      paramIdx++;
      conditions.push(`seq < $${paramIdx}`);
      params.push(opts.beforeSeq);
    }

    // LIMIT is limit+1 to detect hasMore
    paramIdx++;
    const limitParamIdx = paramIdx;
    params.push(limit + 1);

    const where = conditions.join(" AND ");

    const sql = `
      SELECT
        seq::float8           AS seq,
        id,
        type,
        actor,
        subject,
        scope,
        proposed_by,
        confirmed_by,
        payload,
        occurred_at::float8   AS occurred_at
      FROM choros.audit_event
      WHERE ${where}
      ORDER BY seq DESC
      LIMIT $${limitParamIdx}
    `;

    const result = await client.query<{
      seq: number;
      id: string;
      type: string;
      actor: string;
      subject: string | null;
      scope: unknown | null;
      proposed_by: string | null;
      confirmed_by: string | null;
      payload: unknown;
      occurred_at: number;
    }>(sql, params);

    const rawRows = result.rows;
    const hasMore = rawRows.length > limit;
    const rows = hasMore ? rawRows.slice(0, limit) : rawRows;

    return {
      rows: rows.map((r) => ({
        seq: r.seq,
        id: r.id,
        type: r.type,
        actor: r.actor,
        subject: r.subject,
        scope: r.scope,
        proposed_by: r.proposed_by,
        confirmed_by: r.confirmed_by,
        payload: r.payload,
        occurred_at: r.occurred_at,
      })),
      hasMore,
    };
  });
}
