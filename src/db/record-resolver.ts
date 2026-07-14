/**
 * src/db/record-resolver.ts — T-0769 [столп 4 анти-UUID] batch RECORD-TITLE
 * display resolver for the audit journal.
 *
 * THE DEFECT this closes: `record.create` (and its siblings `record.update` /
 * `record.deleted`) audit rows carry the touched RECORD as their `target`
 * (audit-read-dao.ts `safeTarget` falls back to the writer's `record_id`
 * payload key — records.ts/form-record-persister.ts/step-applier.ts have
 * always populated it). Before this, /audit rendered that as a bare-UUID
 * MonoId chip («Событие записи <uuid>») — the SAME acknowledged
 * honest-degradation baseline T-0712's own doc comment cites for the node
 * resolver ("резолвер... не существует в кодовой базе... заводить его —
 * отдельный follow-up"). This module IS that follow-up for records: the
 * THIRD sibling of actor-resolver.ts (T-0648, choros.employee) and
 * node-resolver.ts (T-0733, choros.department/choros.position) — same batch
 * discipline, a different entity class (a record is neither an actor nor an
 * org-tree node).
 *
 * SINGLE AUTHORITY FOR "WHAT IS THIS RECORD'S TITLE": reuses
 * `deriveSafeRecordTitle` / `GENERIC_RECORD_TYPE_LABEL`
 * (src/core/registry-title-field.ts) verbatim — the EXACT SAME
 * schema-designated-title-field picker the T-0756 source-record projection
 * (process-projection.ts::resolveSourceRecordProjection) and the assistant
 * registry digest (T-0613) already use. This module does not invent a second
 * "guess the record's name" heuristic; it is a second, BATCHED caller of the
 * one that already exists (that extraction — moving the two symbols out of
 * process-projection.ts into registry-title-field.ts — is itself part of this
 * task, so there remains exactly one authority, not a copy).
 *
 * NO PER-ROW PDP/SANDBOX CHECK (unlike resolveSourceRecordProjection): GET
 * /api/audit is genesis-owner-ONLY (src/http/audit.ts::holdsAuditRead) — an
 * owner already sees the WHOLE tenant journal unredacted, so there is no
 * narrower per-record visibility left to additionally enforce here. This
 * mirrors node-resolver.ts, which resolves department/position under the
 * SAME owner-only assumption with no PDP check either (see that module's own
 * doc comment). Do NOT reuse this resolver from a non-owner-gated surface
 * without adding one.
 *
 * ONE QUERY: record ⋈ registry_def (for the title-field schema + type label +
 * owning application, all needed by the wire shape below) in a single
 * `WHERE r.id::text = ANY($2::text[])`, regardless of how many distinct
 * record ids are on the page — the SAME O(1)-query-per-page discipline
 * `batchResolveActors`/`batchResolveOrgNodes` established.
 *
 * HONEST DEGRADATION (D2): a record id that matches no row (hard-deleted —
 * `DELETE /api/records/:id` is a real DELETE, records.ts — or a malformed /
 * cross-tenant id) is simply ABSENT from the returned Map, exactly like
 * `resolveSourceRecordProjection` returning `null` for the same case. Unlike
 * `resolveActorDisplay`/`resolveNodeDisplay` (which always hand back a
 * fallback shape with `name = id`), there is no "the record itself, just
 * unresolved" shape to fall back to here — a deleted record has genuinely
 * nothing left to name. `resolveRecordDisplay` therefore returns `null` on a
 * miss; the caller (src/http/audit.ts) then leaves `targetDisplay` null and
 * the frontend (screen-audit.jsx) falls through to its PRE-EXISTING MonoId(raw
 * id) chip — the same honest baseline this task started from, now reserved
 * for the genuinely-unresolvable case instead of every record event.
 */

import pg from "pg";
import { deriveSafeRecordTitle, GENERIC_RECORD_TYPE_LABEL } from "../core/registry-title-field.js";

// ---------------------------------------------------------------------------
// Wire shape — matches process-projection.ts's SourceRecordProjection fields
// (id/title/typeLabel/canOpen/appId) so it can be handed straight to RecordRef
// (components.jsx, T-0648/T-0756) as its `projection` prop without any
// reshaping at the call site.
// ---------------------------------------------------------------------------

export interface ResolvedRecord {
  /** The record's raw id (the SAME string used as the lookup key). */
  readonly id: string;
  /** deriveSafeRecordTitle(data, record_schema, id, typeLabel) — never raw data. */
  readonly title: string;
  /** The record's TYPE — the governing registry_def.display_name. */
  readonly typeLabel: string;
  /**
   * Always `true`: a genesis owner (the ONLY caller of this resolver, per the
   * module doc above) can always open any record in their own tenant — there
   * is no narrower per-record openability to compute here, unlike
   * resolveSourceRecordProjection's per-actor canOpen.
   */
  readonly canOpen: true;
  /** Owning application id — always present (needed for the RecordRef open-link). */
  readonly appId: string;
}

// ---------------------------------------------------------------------------
// withTenant — local copy of the established T-0013 pattern (actor-resolver.ts
// / node-resolver.ts / org.ts all carry their own byte-identical copy — see
// actor-resolver.ts's own comment on why a shared extraction is a separate,
// out-of-scope refactor).
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
 * batchResolveRecords — resolve a list of record ids to their display shape,
 * in ONE query. Empty input short-circuits to an empty Map with ZERO queries
 * (mirrors batchResolveActors/batchResolveOrgNodes).
 *
 * TENANT-SCOPE (defence-in-depth, mirrors the actor/node batches above):
 * `SET LOCAL choros.tenant_id` (record_tenant_isolation / registry_def_tenant
 * _isolation RLS policies, migrations 004/005, FORCE ROW LEVEL SECURITY) PLUS
 * a literal `WHERE tenant_id = $1` in the SQL. A tenant-A caller can NEVER
 * resolve a tenant-B record id — it simply comes back absent from the Map.
 */
export async function batchResolveRecords(
  pool: pg.Pool,
  tenantId: string,
  ids: ReadonlyArray<string>,
): Promise<Map<string, ResolvedRecord>> {
  const result = new Map<string, ResolvedRecord>();
  const distinct = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  if (distinct.length === 0) return result;

  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      data: unknown;
      record_schema: unknown;
      type_label: string | null;
      application_id: string;
    }>(
      `SELECT r.id::text AS id, r.data, rd.record_schema,
              rd.display_name AS type_label, rd.application_id::text AS application_id
         FROM choros.record r
         JOIN choros.registry_def rd
           ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
        WHERE r.tenant_id = $1 AND r.id::text = ANY($2::text[])`,
      [tenantId, distinct],
    );

    for (const row of rows) {
      const typeLabel =
        typeof row.type_label === "string" && row.type_label.trim().length > 0
          ? row.type_label.trim()
          : GENERIC_RECORD_TYPE_LABEL;
      const title = deriveSafeRecordTitle(row.data, row.record_schema, row.id, typeLabel);
      result.set(row.id, {
        id: row.id,
        title,
        typeLabel,
        canOpen: true,
        appId: row.application_id,
      });
    }

    return result;
  });
}

/**
 * resolveRecordDisplay — convenience accessor for a Map produced by
 * batchResolveRecords: returns the resolved record, or `null` when the id did
 * not resolve (deleted record, malformed id, or a cross-tenant id the
 * tenant-scoped query could never see). Unlike resolveActorDisplay/
 * resolveNodeDisplay, there is NO honest-fallback shape here (see the module
 * doc's "HONEST DEGRADATION" note) — the caller falls back to its own
 * pre-existing raw-id MonoId chip instead.
 */
export function resolveRecordDisplay(
  resolved: ReadonlyMap<string, ResolvedRecord>,
  id: string | null | undefined,
): ResolvedRecord | null {
  if (id === null || id === undefined || id === "") return null;
  return resolved.get(id) ?? null;
}
