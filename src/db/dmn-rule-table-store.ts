/**
 * src/db/dmn-rule-table-store.ts — T-0340 [E15-S5]
 *
 * DB adapter: read `choros.dmn_rule_table` rows WHERE status='published'
 * and deserialize them into DmnRuleTable[] for use by the pure evaluate()
 * function in src/core/dmn-middle.ts.
 *
 * DESIGN INVARIANTS:
 *   - RLS-scoped: all reads run under the caller's tenant GUC (SET LOCAL
 *     choros.tenant_id). No BYPASSRLS; choros_app is the role.
 *   - Returns ONLY 'published' rows (status column gate, migration 066).
 *   - Definition JSONB is deserialized into DmnRuleTable; unknown/malformed
 *     rows are skipped with a warning (fail-open on evaluation; fail-closed
 *     is at the gateway variable write path via applyStepResult).
 *   - No writes. Read-only DAO (read-side of the two-layer gateway F4 plan).
 *   - Version pinning for in-flight rule-change semantics (§8 founder decision):
 *     at process LAUNCH we capture the current `updated_at` of each rule table
 *     and pin it in the process variables. Running instances use the pinned
 *     `rule_table_version_<id>` variable to select the historical snapshot.
 *     New launches always read the latest 'published' row.
 *   - The DB adapter exposes TWO functions:
 *       loadPublishedRuleTables(client, tenantId, procDefId?)
 *         → loads the current latest-published rule tables for a process.
 *       loadRuleTablesByVersions(client, tenantId, versions)
 *         → loads pinned historical snapshots by (id, updatedAt) pairs for
 *           already-running instances (in-flight rule-change safety).
 */

import pg from "pg";
import type { DmnRuleTable } from "../core/dmn-middle.js";

// ---------------------------------------------------------------------------
// UUID guard
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

// ---------------------------------------------------------------------------
// Internal row shape (what Postgres returns from dmn_rule_table)
// ---------------------------------------------------------------------------

interface DmnRuleTableDbRow {
  id: string;
  name: string;
  definition: unknown; // JSONB — deserialized to DmnRuleTable shape
  process_def_id: string | null;
  status: string;
  updated_at: number; // epoch ms cast via ::float8
}

// ---------------------------------------------------------------------------
// Deserialization: DB row → DmnRuleTable
// ---------------------------------------------------------------------------

/**
 * Attempt to deserialize a raw JSONB definition into DmnRuleTable.
 * Returns null if the definition is missing required fields or malformed.
 * Fail-open: callers skip null returns and log a warning.
 */
function deserializeDefinition(
  rowId: string,
  definition: unknown,
): DmnRuleTable | null {
  if (
    definition === null ||
    definition === undefined ||
    typeof definition !== "object" ||
    Array.isArray(definition)
  ) {
    console.warn(`[dmn-rule-table-store] row ${rowId}: definition is not an object — skipped`);
    return null;
  }

  const def = definition as Record<string, unknown>;

  // id (use DB row id as canonical id — overrides whatever is in the definition blob)
  // name
  if (typeof def["name"] !== "string" || def["name"].trim().length === 0) {
    console.warn(`[dmn-rule-table-store] row ${rowId}: definition.name missing — skipped`);
    return null;
  }

  // hitPolicy
  const hp = def["hitPolicy"];
  if (hp !== "FIRST" && hp !== "COLLECT") {
    console.warn(`[dmn-rule-table-store] row ${rowId}: unknown hitPolicy '${String(hp)}' — skipped`);
    return null;
  }

  // rules
  if (!Array.isArray(def["rules"])) {
    console.warn(`[dmn-rule-table-store] row ${rowId}: definition.rules is not an array — skipped`);
    return null;
  }

  // Trust the stored shape (was validated at insert time by migration 066 CHECK +
  // future authoring UI). We do lightweight structural typing here, not full
  // re-validation — the pure evaluate() is fail-open on unknown operators anyway.
  return {
    id: rowId,
    name: def["name"] as string,
    hitPolicy: hp as "FIRST" | "COLLECT",
    rules: def["rules"] as DmnRuleTable["rules"],
  };
}

// ---------------------------------------------------------------------------
// Pinned version shape (for in-flight rule-change semantics)
// ---------------------------------------------------------------------------

/**
 * A pinned version reference: rule table id + the updated_at epoch-ms at
 * which the table was loaded at launch time. Serialised into the process
 * variables as `dmn_rule_table_version_<id>` so running instances can
 * re-evaluate on the SAME definition snapshot they were started with.
 */
export interface DmnRuleTableVersion {
  readonly id: string;
  readonly updatedAt: number; // epoch ms
}

// ---------------------------------------------------------------------------
// loadPublishedRuleTables
// ---------------------------------------------------------------------------

/**
 * Load all CURRENT 'published' rule tables for a tenant, optionally scoped
 * to a process definition key. Called at process LAUNCH to obtain the latest
 * rule set AND to pin the version for in-flight rule-change safety.
 *
 * Rules:
 *   1. Tables with process_def_id = NULL apply to ALL processes of the tenant.
 *   2. Tables with process_def_id = <procDefId> apply to that specific process.
 *   3. Both sets are returned when procDefId is supplied; NULL-scoped only otherwise.
 *   4. Only status='published' rows are returned.
 *   5. Ordered by name ASC for deterministic evaluation order.
 *
 * @param client   Caller's open tenant-scoped pg.PoolClient (RLS enforced).
 * @param tenantId UUID of the current tenant (explicit WHERE predicate, BYPASSRLS guard).
 * @param procDefId Optional process definition key to scope the lookup.
 * @returns { tables, versions } — tables for evaluate(); versions to pin in variables.
 */
export async function loadPublishedRuleTables(
  client: pg.PoolClient,
  tenantId: string,
  procDefId?: string,
): Promise<{ tables: DmnRuleTable[]; versions: DmnRuleTableVersion[] }> {
  if (!isUuid(tenantId)) {
    throw new Error(`loadPublishedRuleTables: tenantId must be a UUID, got: ${JSON.stringify(tenantId)}`);
  }

  let rows: DmnRuleTableDbRow[];

  if (procDefId && typeof procDefId === "string" && procDefId.trim().length > 0) {
    const res = await client.query<DmnRuleTableDbRow>(
      `SELECT id, name, definition, process_def_id, status,
              (EXTRACT(EPOCH FROM updated_at) * 1000)::float8 AS updated_at
         FROM choros.dmn_rule_table
        WHERE tenant_id     = $1
          AND status        = 'published'
          AND (process_def_id IS NULL OR process_def_id = $2)
        ORDER BY name ASC`,
      [tenantId, procDefId],
    );
    rows = res.rows;
  } else {
    const res = await client.query<DmnRuleTableDbRow>(
      `SELECT id, name, definition, process_def_id, status,
              (EXTRACT(EPOCH FROM updated_at) * 1000)::float8 AS updated_at
         FROM choros.dmn_rule_table
        WHERE tenant_id     = $1
          AND status        = 'published'
          AND process_def_id IS NULL
        ORDER BY name ASC`,
      [tenantId],
    );
    rows = res.rows;
  }

  const tables: DmnRuleTable[] = [];
  const versions: DmnRuleTableVersion[] = [];

  for (const row of rows) {
    const table = deserializeDefinition(row.id, row.definition);
    if (table === null) continue; // skip malformed rows (fail-open on evaluation)
    tables.push(table);
    versions.push({ id: row.id, updatedAt: row.updated_at });
  }

  return { tables, versions };
}

// ---------------------------------------------------------------------------
// loadRuleTablesByVersions
// ---------------------------------------------------------------------------

/**
 * Load pinned historical snapshots of rule tables for ALREADY-RUNNING instances
 * (in-flight rule-change semantics, §8 founder decision: running instances finish
 * on the OLD rule).
 *
 * The `versions` array is the pinned set stored in process variables at launch.
 * We re-load each table WHERE id = <id> AND updated_at = <updatedAt> (epoch-ms
 * tolerance: within 1ms of the pinned value, to absorb float cast rounding).
 * If a pinned version is no longer found (e.g. the row was replaced/deleted),
 * the function falls back to the latest 'published' snapshot for that id and
 * emits a warning. This ensures already-running instances are never silently
 * broken by a table deletion, while preserving the intent of rule pinning.
 *
 * @param client   Caller's open tenant-scoped pg.PoolClient (RLS enforced).
 * @param tenantId UUID of the current tenant.
 * @param versions Pinned version references from process variables.
 * @returns DmnRuleTable[] — the pinned snapshots (or fallback current) for evaluate().
 */
export async function loadRuleTablesByVersions(
  client: pg.PoolClient,
  tenantId: string,
  versions: DmnRuleTableVersion[],
): Promise<DmnRuleTable[]> {
  if (!isUuid(tenantId)) {
    throw new Error(`loadRuleTablesByVersions: tenantId must be a UUID, got: ${JSON.stringify(tenantId)}`);
  }
  if (versions.length === 0) return [];

  const tables: DmnRuleTable[] = [];

  for (const ver of versions) {
    if (!isUuid(ver.id)) {
      console.warn(`[dmn-rule-table-store] loadRuleTablesByVersions: skipping invalid id: ${ver.id}`);
      continue;
    }

    // Try exact-match on updated_at (within 1ms tolerance for float cast rounding).
    const res = await client.query<DmnRuleTableDbRow>(
      `SELECT id, name, definition, process_def_id, status,
              (EXTRACT(EPOCH FROM updated_at) * 1000)::float8 AS updated_at
         FROM choros.dmn_rule_table
        WHERE tenant_id  = $1
          AND id         = $2
          AND ABS((EXTRACT(EPOCH FROM updated_at) * 1000)::float8 - $3) < 1.5
        LIMIT 1`,
      [tenantId, ver.id, ver.updatedAt],
    );

    if (res.rows.length > 0) {
      const table = deserializeDefinition(res.rows[0].id, res.rows[0].definition);
      if (table !== null) {
        tables.push(table);
        continue;
      }
    }

    // Fallback: latest 'published' snapshot for this id
    console.warn(
      `[dmn-rule-table-store] pinned version (id=${ver.id}, updatedAt=${ver.updatedAt}) ` +
        `not found — falling back to latest published snapshot`,
    );
    const fallback = await client.query<DmnRuleTableDbRow>(
      `SELECT id, name, definition, process_def_id, status,
              (EXTRACT(EPOCH FROM updated_at) * 1000)::float8 AS updated_at
         FROM choros.dmn_rule_table
        WHERE tenant_id = $1
          AND id        = $2
          AND status    = 'published'
        ORDER BY updated_at DESC
        LIMIT 1`,
      [tenantId, ver.id],
    );
    if (fallback.rows.length > 0) {
      const table = deserializeDefinition(fallback.rows[0].id, fallback.rows[0].definition);
      if (table !== null) tables.push(table);
    }
  }

  return tables;
}

// ---------------------------------------------------------------------------
// Variable key helpers — for pinning rule table versions in process variables
// ---------------------------------------------------------------------------

/** Variable key prefix for pinning a rule table version in process variables. */
export const DMN_VERSION_VAR_PREFIX = "dmn_rtv_" as const;

/**
 * Build the process variable key for pinning a rule table version.
 * Stored in Flowable variables at process launch (A pre-compute path).
 */
export function dmnVersionVarKey(ruleTableId: string): string {
  // Short prefix to stay within Flowable variable name limits.
  return `${DMN_VERSION_VAR_PREFIX}${ruleTableId.replace(/-/g, "")}`;
}

/**
 * Serialize a DmnRuleTableVersion[] into a flat Record<string, string>
 * suitable for inclusion in the Flowable `completeTask` variables map.
 * Each entry: { "dmn_rtv_<id-nohyphen>": "<id>:<updatedAt>" }.
 */
export function serializeVersionsAsVariables(
  versions: DmnRuleTableVersion[],
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const v of versions) {
    vars[dmnVersionVarKey(v.id)] = `${v.id}:${v.updatedAt}`;
  }
  return vars;
}

/**
 * Deserialize pinned version variables back into DmnRuleTableVersion[].
 * Reads all keys matching `DMN_VERSION_VAR_PREFIX` from the process variables map.
 * Returns an empty array if none found (new launch with no gateway vars yet).
 */
export function deserializeVersionsFromVariables(
  variables: Record<string, unknown>,
): DmnRuleTableVersion[] {
  const versions: DmnRuleTableVersion[] = [];
  for (const [key, value] of Object.entries(variables)) {
    if (!key.startsWith(DMN_VERSION_VAR_PREFIX)) continue;
    if (typeof value !== "string") continue;
    const colonIdx = value.lastIndexOf(":");
    if (colonIdx <= 0) continue;
    const id = value.slice(0, colonIdx);
    const updatedAt = parseFloat(value.slice(colonIdx + 1));
    if (!isUuid(id) || isNaN(updatedAt)) continue;
    versions.push({ id, updatedAt });
  }
  return versions;
}
