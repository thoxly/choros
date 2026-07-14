/**
 * src/db/engine-process-name.ts — T-0732 (E16 T-0349, O-1 из ревью T-0717).
 *
 * The tenant-scoped write/read for choros.engine_process_name (migration 131) — a
 * display-name OVERLAY for engine-source process definitions (those deployed
 * straight to Flowable, with NO row in choros.process_definition). It is NOT a
 * process_definition row on purpose: "an engine process is defined by the ABSENCE
 * of a process_definition row" is a load-bearing invariant (process-start.ts's
 * sandbox gate, inbox.ts's draft-hide, the catalog's source classification). This
 * overlay names such processes WITHOUT touching that invariant.
 *
 * Both functions are CLIENT-based: the caller supplies an already tenant-scoped
 * pg.PoolClient (SET LOCAL choros.tenant_id + FORCE RLS), exactly as
 * process-projection.ts's withTenant / process-catalog.ts's withTenantTx already
 * open. In addition to RLS, every statement carries an EXPLICIT `WHERE/VALUES
 * tenant_id = $1` (defense-in-depth — the SAME belt-and-suspenders posture
 * T-0616 §F-1 pinned for resolveDefinitionNames, so a cross-tenant name can never
 * leak even if the session GUC were ever mis-set).
 *
 * selectEngineProcessNames is the SINGLE read resolver, reused by BOTH display
 * paths (resolveDefinitionNames → instance list/detail/inbox; buildCatalogDefinitions
 * → catalog) so the two can never disagree on an engine process's human name.
 */

import type pg from "pg";

/**
 * Upsert the human name for one engine (source=engine) process definition,
 * tenant-scoped. Idempotent: a repeat with the same name is a no-op; a changed
 * name overwrites (last deploy wins). This is the write half of the "parse
 * <process name> at deploy → store tenant-scoped" primitive — a deploy path
 * parses the BPMN via parseBpmnProcessMeta (src/core/bpmn-process-meta.ts) and,
 * when a name is present, calls this.
 *
 * @param client   a tenant-scoped PoolClient (SET LOCAL choros.tenant_id done).
 * @param tenantId the tenant uuid (also the RLS predicate value).
 * @param processKey the process-definition key (e.g. "telLinear").
 * @param name     the human name from <process name="…"> (non-empty by contract).
 * @param nowMs    wall-clock ms for created_at/updated_at.
 */
export async function registerEngineProcessName(
  client: pg.PoolClient,
  tenantId: string,
  processKey: string,
  name: string,
  nowMs: number,
): Promise<void> {
  await client.query(
    `INSERT INTO choros.engine_process_name
       (tenant_id, process_key, name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (tenant_id, process_key)
     DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
    [tenantId, processKey, name, nowMs],
  );
}

/**
 * Resolve { process_key → human name } for the given keys, tenant-scoped. Only
 * keys with an overlay row are present in the result — a key with no row is
 * simply absent (the caller then keeps its own next-tier fallback:
 * fallbackDefinitionName(key) = the raw key). NEVER throws on a not-found key.
 *
 * Cross-tenant safety (T-0616 §F-1 class): RLS (FORCE) on the tenant-scoped
 * client PLUS the explicit `WHERE tenant_id = $1` — a name written in tenant B
 * cannot surface when resolving in tenant A.
 *
 * @param client a tenant-scoped PoolClient.
 * @param tenantId the tenant uuid.
 * @param keys   the process keys to resolve (deduped internally).
 */
export async function selectEngineProcessNames(
  client: pg.PoolClient,
  tenantId: string,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const uniqueKeys = [...new Set(keys)].filter((k) => k.length > 0);
  if (uniqueKeys.length === 0) return names;
  const { rows } = await client.query<{ process_key: string; name: string }>(
    `SELECT process_key, name
       FROM choros.engine_process_name
      WHERE tenant_id = $1
        AND process_key = ANY($2::text[])`,
    [tenantId, uniqueKeys],
  );
  for (const r of rows) names.set(r.process_key, r.name);
  return names;
}
