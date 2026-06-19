/**
 * src/db/cross-app-ref-dao.ts — T-0335 [E15-S1b]
 *
 * WRITE-SIDE thin DAO for the cross_app_ref DEFINITION table (migration 068).
 *
 * The pure read-side traversal (resolveHop / resolveHopChain) lives in
 * src/core/cross-app-ref.ts and stays an orphan until a later increment wires it
 * (the per-hop ACL re-check). This DAO does NOT touch that traversal; it only
 * looks up the reference DEFINITION row so the S1 applier can learn which JSONB
 * `ref_field` key links the «Согласование» (source) registry to the primary
 * «Заявки» (target) registry, and write the primary record's UUID under that key.
 *
 * Scope (single read):
 *   getCrossAppRef(client, tenantId, sourceRegistryId, targetRegistryId)
 *     → { id, refField, label } | null
 *
 * Tenant isolation: runs on a caller-supplied client ALREADY inside an open
 * tenant-scoped tx (the inbox approve tx: SET LOCAL choros.tenant_id + FORCE RLS).
 * The SELECT carries an explicit `WHERE tenant_id = $1` BYPASSRLS guard (T-0184
 * double-predicate pattern) so the read is correct even on a BYPASSRLS connection.
 *
 * NOT a second authority path: this is a plain definition lookup, no grant algebra.
 * It does NOT import grant-resolver / object-handle / the pure cross-app-ref core.
 */

import pg from "pg";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** The minimal cross_app_ref definition the applier needs (ref_field write-side). */
export interface CrossAppRefHandle {
  readonly id: string;
  /** The JSONB key in the SOURCE record that holds the TARGET record's UUID. */
  readonly refField: string;
  /** Display label (informational; carried for logging). */
  readonly label: string;
}

interface CrossAppRefDbRow {
  id: string;
  ref_field: string;
  label: string;
}

/**
 * Look up the cross_app_ref definition for a (source → target) registry pair.
 *
 * Runs on `client`, which MUST already be inside a tenant-scoped tx (GUC set).
 * Returns the handle or null when no definition links the two registries (the
 * applier treats null as "no cross-ref to write" and skips the ref_field set —
 * the «Согласование» record is still created without the back-link).
 *
 * NEVER throws on "not found"; throws only on genuine DB / SQL errors.
 *
 * @param client            an open pg client inside a tenant-scoped tx.
 * @param tenantId          the tenant UUID (must already match the GUC).
 * @param sourceRegistryId  the registry that OWNS the ref_field (the «Согласование» registry).
 * @param targetRegistryId  the registry the ref_field POINTS TO (the primary «Заявки» registry).
 */
export async function getCrossAppRef(
  client: pg.PoolClient,
  tenantId: string,
  sourceRegistryId: string,
  targetRegistryId: string,
): Promise<CrossAppRefHandle | null> {
  if (!isUuid(tenantId) || !isUuid(sourceRegistryId) || !isUuid(targetRegistryId)) {
    return null;
  }
  const res = await client.query<CrossAppRefDbRow>(
    `SELECT id, ref_field, label
       FROM choros.cross_app_ref
      WHERE tenant_id = $1
        AND source_registry_id = $2
        AND target_registry_id = $3
      LIMIT 1`,
    [tenantId, sourceRegistryId, targetRegistryId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { id: row.id, refField: row.ref_field, label: row.label };
}
