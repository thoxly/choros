/**
 * src/db/cross-app-ref-dao.ts — T-0335 [E15-S1b] + T-0352 [E16] + T-0445
 *
 * Thin DAO for the cross_app_ref DEFINITION table (migration 068).
 *
 * T-0335 (write-side): `getCrossAppRef` — single-pair lookup for the inbox applier.
 * T-0352 (read-side): `listCrossAppRefsForSource` — list ALL ref definitions whose
 *   source_registry_id matches a given registry. Used by `GET /api/records/:id/links`
 *   to discover which target registries should be resolved for a record card.
 * T-0445 (write-side): `upsertCrossAppRefForField` + `deleteCrossAppRefForField` —
 *   reconcile cross_app_ref rows from user-authored x-relation schema fields.
 *
 * The pure traversal (resolveHop / resolveHopChain) lives in
 * src/core/cross-app-ref.ts; this DAO only reads definition rows.
 *
 * Scope:
 *   getCrossAppRef(client, tenantId, sourceRegistryId, targetRegistryId)
 *     → { id, refField, label } | null
 *   listCrossAppRefsForSource(client, tenantId, sourceRegistryId)
 *     → CrossAppRefRow[]
 *   upsertCrossAppRefForField(client, tenantId, params)
 *     → void   (idempotent — ON CONFLICT DO UPDATE)
 *   deleteCrossAppRefForField(client, tenantId, sourceRegistryId, refField)
 *     → void   (no-op when row absent)
 *
 * Tenant isolation: runs on a caller-supplied client ALREADY inside an open
 * tenant-scoped tx (SET LOCAL choros.tenant_id + FORCE RLS). The queries carry
 * an explicit `WHERE tenant_id = $1` BYPASSRLS guard (T-0184 double-predicate).
 *
 * NOT a second authority path: plain definition lookup, no grant algebra.
 * Does NOT import grant-resolver / object-handle / pure cross-app-ref core.
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

/** A cross_app_ref definition row returned by listCrossAppRefsForSource (T-0352). */
export interface CrossAppRefRow {
  readonly id: string;
  /** The JSONB key in the SOURCE record that holds the TARGET record's UUID. */
  readonly refField: string;
  readonly label: string;
  readonly sourceRegistryId: string;
  readonly targetRegistryId: string;
  readonly refStrength: "weak" | "strong";
}

interface CrossAppRefFullRow {
  id: string;
  ref_field: string;
  label: string;
  source_registry_id: string;
  target_registry_id: string;
  ref_strength: string;
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

/**
 * T-0352: List ALL cross_app_ref definitions for a given source registry.
 *
 * Returns every ref definition where source_registry_id = $2, ordered by
 * created_at ASC (stable display order). Returns an empty array when none exist.
 *
 * Called by GET /api/records/:id/links to enumerate which linked apps should be
 * resolved for the record's card view (1-hop live). The caller then resolves
 * each ref against the source record's data[refField] via the pure core
 * (resolveHop). DB-untested paths are marked in the HTTP handler.
 *
 * @param client           an open pg client inside a tenant-scoped tx (GUC set).
 * @param tenantId         the tenant UUID (must match the GUC already set).
 * @param sourceRegistryId the source registry UUID whose ref defs we want.
 */
export async function listCrossAppRefsForSource(
  client: pg.PoolClient,
  tenantId: string,
  sourceRegistryId: string,
): Promise<CrossAppRefRow[]> {
  if (!isUuid(tenantId) || !isUuid(sourceRegistryId)) {
    return [];
  }
  const res = await client.query<CrossAppRefFullRow>(
    `SELECT id, ref_field, label, source_registry_id, target_registry_id, ref_strength
       FROM choros.cross_app_ref
      WHERE tenant_id = $1
        AND source_registry_id = $2
      ORDER BY created_at ASC`,
    [tenantId, sourceRegistryId],
  );
  return res.rows.map((row) => ({
    id: row.id,
    refField: row.ref_field,
    label: row.label,
    sourceRegistryId: row.source_registry_id,
    targetRegistryId: row.target_registry_id,
    refStrength: (row.ref_strength === "strong" ? "strong" : "weak") as "weak" | "strong",
  }));
}

// ---------------------------------------------------------------------------
// T-0445 — write ops for user-authored x-relation field reconciliation
// ---------------------------------------------------------------------------

/**
 * Parameters for upserting a cross_app_ref row from a user-authored relation field.
 */
export interface UpsertCrossAppRefParams {
  /** The registry_def that OWNS the relation field (source). */
  readonly sourceRegistryId: string;
  /** The registry_def the relation field POINTS TO (target). */
  readonly targetRegistryId: string;
  /** The JSON Schema property key — the field name in the source record's data. */
  readonly refField: string;
  /** Human-readable label (field title). Stored as-is; may be empty string. */
  readonly label: string;
}

/**
 * T-0445: Upsert a cross_app_ref row for a user-authored relation field.
 *
 * Idempotent: INSERT … ON CONFLICT (tenant_id, source_registry_id, ref_field)
 * DO UPDATE — so re-creating the same registry_def or calling this twice with
 * identical params produces exactly ONE row (unique key honored).
 *
 * Must be called inside an ALREADY-OPEN tenant-scoped tx (GUC set, FORCE RLS).
 * Explicit `WHERE tenant_id = $N` predicate on every statement guards against
 * migrator-pool BYPASSRLS (T-0184 double-predicate).
 *
 * ref_strength defaults to 'weak' (user-authored relations are independent
 * lifecycle; strong is reserved for seeded master-detail pairs).
 *
 * @param client   an open pg client inside a tenant-scoped tx.
 * @param tenantId the tenant UUID (must match the GUC already set).
 * @param params   relation field params (see UpsertCrossAppRefParams).
 */
export async function upsertCrossAppRefForField(
  client: pg.PoolClient,
  tenantId: string,
  params: UpsertCrossAppRefParams,
): Promise<void> {
  const { sourceRegistryId, targetRegistryId, refField, label } = params;
  if (
    !isUuid(tenantId) ||
    !isUuid(sourceRegistryId) ||
    !isUuid(targetRegistryId) ||
    !refField
  ) {
    // Defensive no-op: invalid UUIDs or empty refField should never reach here
    // (callers validate before calling), but guard defensively.
    return;
  }
  const nowMs = Date.now();
  // ON CONFLICT on the unique key (tenant_id, source_registry_id, ref_field):
  // update target_registry_id, label, updated_at in case the relation target or
  // label changed (e.g. a schema update changed the x-relation.target_registry_id).
  // id and created_at are left intact on conflict (stable identity).
  await client.query(
    `INSERT INTO choros.cross_app_ref
       (tenant_id, id, source_registry_id, target_registry_id, ref_field,
        label, ref_strength, created_at, updated_at)
     VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, 'weak', $6, $6)
     ON CONFLICT (tenant_id, source_registry_id, ref_field)
     DO UPDATE SET
       target_registry_id = EXCLUDED.target_registry_id,
       label              = EXCLUDED.label,
       updated_at         = EXCLUDED.updated_at
     WHERE cross_app_ref.tenant_id = $1`,
    [tenantId, sourceRegistryId, targetRegistryId, refField, label, nowMs],
  );
}

/**
 * T-0445: Delete a cross_app_ref row for a user-authored relation field.
 *
 * Called when a relation property is REMOVED from a registry_def's record_schema
 * (mirrors the destructive-schema discipline in updateSchemaInTx).
 *
 * No-op when the row does not exist (DELETE WHERE is safe). Must be called inside
 * an ALREADY-OPEN tenant-scoped tx (GUC set, FORCE RLS). Explicit `WHERE
 * tenant_id = $1` guards against migrator-pool BYPASSRLS (T-0184).
 *
 * @param client           an open pg client inside a tenant-scoped tx.
 * @param tenantId         the tenant UUID (must match the GUC already set).
 * @param sourceRegistryId the source registry UUID.
 * @param refField         the property key being removed.
 */
export async function deleteCrossAppRefForField(
  client: pg.PoolClient,
  tenantId: string,
  sourceRegistryId: string,
  refField: string,
): Promise<void> {
  if (!isUuid(tenantId) || !isUuid(sourceRegistryId) || !refField) {
    return;
  }
  await client.query(
    `DELETE FROM choros.cross_app_ref
      WHERE tenant_id = $1
        AND source_registry_id = $2
        AND ref_field = $3`,
    [tenantId, sourceRegistryId, refField],
  );
}
