/**
 * src/db/node-resolver.ts — T-0733 [R-1 из ревью T-0712, эпик E-UX-HUMAN
 * T-0647, столп 4 анти-UUID] batch ORG-TREE NODE display resolver.
 *
 * WHY: `department.moved`/`position.moved` (org-move-API, T-0655) audit rows
 * carry the MOVED entity as their `target` — the writer's `subject` column
 * (seed-write.ts, always populated since T-0655's first commit). T-0712 gave
 * these two types a payload-aware human SUMMARY, but explicitly left the
 * target-CHIP a bare id (`docs/tasks` T-0712 handoff, `deviations_from_adr`
 * §1: "резолвер имён department/position не существует в кодовой базе,
 * заводить его — отдельный follow-up... не входит в объём P3-фикса"). This
 * module IS that follow-up.
 *
 * SIBLING, NOT DUPLICATE, OF actor-resolver.ts: `employee.moved`'s target is
 * an ACTOR (choros.employee — human/agent/service identity, already resolved
 * by `batchResolveActors`). `department.moved`/`position.moved`'s target is
 * an ORG-TREE NODE (choros.department / choros.position) — a DIFFERENT
 * entity class with no actor identity (no kind, no deactivation column). This
 * module resolves THAT class, with the exact same batch discipline
 * `batchResolveActors` established (T-0648): ONE query for the whole page
 * regardless of how many distinct node ids are on it — never N+1.
 *
 * TWO TABLES, ONE QUERY: department ids and position ids never overlap (they
 * are different UUID columns from different tables), so a single `UNION ALL`
 * query resolves BOTH sets in one round-trip — not two separate queries, and
 * not one query per row. An empty id array on either side is safe: Postgres's
 * `= ANY('{}'::text[])` matches nothing (no error), so a page with only
 * `department.moved` rows (positionIds = []) still costs exactly one query.
 *
 * WHAT ID SHAPE: department/position PATCH routes (`seed-write.ts` PATCH
 * /api/departments/:id, /api/positions/:id) only ever accept the raw UUID
 * `id` column as `:id` (`assertUuidShape`) — there is no client-facing "slug"
 * URL param for these two entities the way employees have both a slug and a
 * UUID. So this resolver matches ONLY by `id` (unlike batchResolveActors'
 * slug-OR-id match) — the `subject` audit_event.moved rows carry is always
 * that same raw `id`.
 *
 * HONEST DEGRADATION (D2): department/position carry NO soft-delete column
 * (unlike `employee.deactivated_at`, migration 125) — `DELETE
 * /api/departments/:id` / `/api/positions/:id` (AC-9, isGenesisOwner-only,
 * seed-write.ts) is a HARD delete. An unresolved node id therefore always
 * means "this node no longer exists" (or, defensively, a cross-tenant id the
 * tenant-scoped query could never see in the first place). `resolveNodeDisplay`
 * mirrors `resolveActorDisplay`'s EXACT fallback contract: `name` is set to
 * the raw `id` as an INTERNAL signal only (never meant to reach the screen
 * verbatim) — the frontend primitive (`NodeRef`, components.jsx) demotes any
 * UUID-shaped name before it ever becomes visible text, exactly like
 * `ActorChip` already does for actors.
 */

import pg from "pg";

// ---------------------------------------------------------------------------
// Wire shape — the resolved node as NodeRef (frontend) expects it.
// ---------------------------------------------------------------------------

/** The two org-tree node tables `.moved` events can target. */
export type NodeKind = "department" | "position";

export interface ResolvedNode {
  /** The node's raw id (the SAME string used as the lookup key). */
  readonly id: string;
  /** choros.department.display_name OR choros.position.title. */
  readonly name: string;
  /** which table resolved this id — drives NodeRef's kind label. */
  readonly kind: NodeKind;
  /** true when `id` matched a real department/position row (false ⇒ honest fallback — deleted, or never existed under this tenant). */
  readonly resolved: boolean;
}

// ---------------------------------------------------------------------------
// withTenant — local copy of the established T-0013 pattern (org.ts /
// actor-resolver.ts / audit-grant-trail.ts all carry their own byte-identical
// copy — see actor-resolver.ts's own comment on why a shared extraction is a
// separate, out-of-scope refactor).
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

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

/**
 * batchResolveOrgNodes — resolve a list of department ids + a list of position
 * ids to their display shape, in ONE query (UNION ALL over both tables — see
 * module doc above). Empty input on both sides short-circuits to an empty Map
 * with ZERO queries.
 *
 * TENANT-SCOPE (defence-in-depth, mirrors batchResolveActors/listOrgTree):
 * `SET LOCAL choros.tenant_id` (department_tenant_isolation / position_
 * tenant_isolation RLS policies, migrations 014/015, FORCE ROW LEVEL SECURITY)
 * PLUS a literal `WHERE tenant_id = $1` in the SQL. A tenant-A caller can
 * NEVER resolve a tenant-B node id — it simply comes back absent from the Map
 * (the SAME honest-miss behaviour as "this id doesn't exist", which is
 * correct: from tenant A's perspective, it doesn't).
 */
export async function batchResolveOrgNodes(
  pool: pg.Pool,
  tenantId: string,
  departmentIds: ReadonlyArray<string>,
  positionIds: ReadonlyArray<string>,
): Promise<Map<string, ResolvedNode>> {
  const result = new Map<string, ResolvedNode>();
  const distinctDept = [
    ...new Set(departmentIds.filter((id) => typeof id === "string" && id.length > 0)),
  ];
  const distinctPos = [
    ...new Set(positionIds.filter((id) => typeof id === "string" && id.length > 0)),
  ];
  if (distinctDept.length === 0 && distinctPos.length === 0) return result;

  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ id: string; name: string; kind: NodeKind }>(
      `SELECT id::text AS id, display_name AS name, 'department'::text AS kind
         FROM choros.department
        WHERE tenant_id = $1 AND id::text = ANY($2::text[])
        UNION ALL
       SELECT id::text AS id, title AS name, 'position'::text AS kind
         FROM choros.position
        WHERE tenant_id = $1 AND id::text = ANY($3::text[])`,
      [tenantId, distinctDept, distinctPos],
    );

    for (const row of rows) {
      result.set(row.id, { id: row.id, name: row.name, kind: row.kind, resolved: true });
    }

    return result;
  });
}

/**
 * resolveNodeDisplay — convenience accessor for a Map produced by
 * batchResolveOrgNodes: returns the resolved node, or an honest fallback shape
 * (mirrors resolveActorDisplay's exact contract — `name` falls back to the raw
 * `id`, `resolved:false`) when the id did not resolve (deleted node, or a
 * cross-tenant id the tenant-scoped query could never see).
 */
export function resolveNodeDisplay(
  resolved: ReadonlyMap<string, ResolvedNode>,
  id: string | null | undefined,
  kind: NodeKind,
): ResolvedNode {
  if (id === null || id === undefined || id === "") {
    return { id: "", name: "—", kind, resolved: false };
  }
  const hit = resolved.get(id);
  if (hit) return hit;
  // Unresolved: the node no longer exists (hard delete — department/position
  // have no soft-delete column, unlike employee) or is not visible under this
  // tenant. `name` is set to the raw id as an INTERNAL signal only — NodeRef
  // (frontend, components.jsx) demotes any UUID-shaped name before it ever
  // reaches visible text, exactly like ActorChip already does for actors.
  return { id, name: id, kind, resolved: false };
}
