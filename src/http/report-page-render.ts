/**
 * src/http/report-page-render.ts — T-0181 · T-0121g
 *
 * Floor-1 server-side aggregate renderer + Floor-2 RLS-gated data API.
 *
 * Registers:
 *   GET /api/report-pages/:id/render           → renderReportPage (Floor-1 aggregate)
 *   GET /api/report-pages/:id/data             → dataReportPage   (Floor-2 raw records)
 *
 * Security invariants (adversarial AC — SQL injection via field_key):
 *   - field_key values from page_def are NEVER interpolated into SQL directly.
 *   - Before any SQL construction, field_key is validated against:
 *     (a) a strict charset guard: /^[a-zA-Z0-9_-]+$/   (structural reject)
 *     (b) existence in record_schema.properties whitelist (loaded from DB)
 *   - Only after both guards pass is field_key used as a jsonb path literal
 *     (e.g. `data->>'amount'`) — the value appears as a SQL string literal
 *     created via pg's parameterized quoting, NOT via string concatenation.
 *   - filter.value is ALWAYS a $N parameter — never interpolated.
 *   - group_by is subject to the same dual-guard as field_key.
 *
 * Floor-1 render:
 *   - page_def parsed to metrics[] per ADR §4.
 *   - For each metric: SELECT <agg>( (data->>'field_key')::numeric ) (or text for list)
 *     FROM choros.record WHERE tenant_id=$1 AND registry_id=$2 [+ filter] [GROUP BY ...]
 *   - All parameters are $N bindings. field_key used as JSON path string literal
 *     after whitelist validation.
 *   - Result: { metrics: [{ field_key, agg, result, registry_def_id, group_by_field?, grouped_result? }] }
 *   - NF-4: deterministic without LLM; survives agent-offline.
 *
 * Floor-2 data API:
 *   - GET /api/report-pages/:id/data?registry_def_id=<uuid>[&limit=N][&offset=N]
 *   - RLS enforced via withTenantTx (GUC choros.tenant_id).
 *   - PDP gate: grant `read` on `application` (same as view-page per ADR §6).
 *   - No DB credentials in response (only data rows).
 *   - Limit capped at MAX_DATA_LIMIT (100).
 *
 * TENANT: dev-mode uses DEV_TENANT_ID. Same pattern as report-pages.ts.
 *
 * AUTHORITY CHECK: Injectable via ReportPageRenderAuthzDeps (same pattern as
 *   ReportPageAuthzDeps). Default: loadAdminContext genesis-owner short-circuit.
 *   `read` on `application` is string-compared at runtime (not in frozen union).
 *
 * TRANSACTION DISCIPLINE (T-0144): BEGIN before SET LOCAL; COMMIT always.
 *   Floor-1 and Floor-2 both use withTenantTx for RLS scope.
 *
 * ADR: docs/design/T-0121-reports-pages.adr.md §4 (Floor-1 day-1 vocab),
 *      §6 (Floor-2 RLS-gated channel), §7 (tenant isolation + fail-closed),
 *      §9 (T-0121g fitness: FF-FLOOR2-RLS, NF-4).
 */

import type { IncomingMessage } from "node:http";
import pg from "pg";
import { HttpError, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext } from "./auth.js";
import { loadAdminContext } from "../db/org.js";
import {
  isNarrowerOrEqual,
  type ScopeElement,
  type AncestryOracle,
} from "../core/grant-lattice.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maximum records returned by Floor-2 data API per request. */
export const MAX_DATA_LIMIT = 100;

/**
 * Strict field-key charset guard (adversarial AC — SQL injection prevention).
 * field_key must match [a-zA-Z0-9_-]+ before being used as a jsonb path literal.
 * Rejects any key containing SQL metacharacters: quotes, semicolons, spaces, etc.
 */
const FIELD_KEY_SAFE_RE = /^[a-zA-Z0-9_-]+$/;

// Startup-time validation of DEV_TENANT_ID.
const _rawDevTenantId =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";
if (!UUID_RE.test(_rawDevTenantId)) {
  throw new Error(
    `[report-page-render] DEV_TENANT_ID env var is not a valid UUID: "${_rawDevTenantId}". ` +
      `Fix the env var or unset it to use the built-in default.`,
  );
}
const DEV_TENANT_ID = _rawDevTenantId;

// ---------------------------------------------------------------------------
// Resource-hierarchy oracle (T-0193: scope-containment for application nodes)
//
// Day-1: resource hierarchy is flat (application → registry → record).
// No DB-backed tree traversal yet (T-0053). For containment checks against
// application nodes the oracle is equality-only: a grant scope covers the
// target application iff the grant's nodeId equals the target appId, OR the
// grant scope is a wider node (registry/record levels don't apply here since
// we check application-level containment only).
//
// This mirrors the same day-1 equality oracle used for resource UUIDs in
// grants.ts / secret-handle.ts SEED_ORACLE: UUIDs not in ORG_SEED_CHILDREN
// resolve to equality-only (isDescendantOrSelf returns a===b).
// ---------------------------------------------------------------------------

const RESOURCE_ORACLE: AncestryOracle = {
  isDescendantOrSelf(_hierarchy, descendantId, ancestorId): boolean {
    return descendantId === ancestorId;
  },
};

// ---------------------------------------------------------------------------
// Pool (lazy singleton — same pattern as report-pages.ts)
// ---------------------------------------------------------------------------

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) {
    const url = process.env["DATABASE_URL"];
    if (!url) {
      throw new HttpError(503, "DB_UNAVAILABLE", "DATABASE_URL not set");
    }
    _pool = new pg.Pool({ connectionString: url });
  }
  return _pool;
}

/** Reset the module-level pool singleton. FOR TESTING ONLY. */
export function resetRenderPoolForTesting(): void {
  _pool = null;
}

// ---------------------------------------------------------------------------
// ReportPageRenderAuthzDeps — injectable PDP gate
//
// Checks grant `read` on `application` for the page's app_id.
// genesis-owner short-circuit.
// ---------------------------------------------------------------------------

export interface ReportPageRenderAuthzDeps {
  /**
   * Gate: actor must hold a confirmed, in-window `application/read` grant whose
   * scope CONTAINS the target application (appId).
   *
   * T-0193 (R-6 fix): appId added so the check is scope-scoped to the specific
   * application whose page is being rendered/read — not any application grant.
   */
  checkReadGrant: (
    pool: pg.Pool,
    tenantId: string,
    actorId: string,
    appId: string,
    nowMs: number,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

async function defaultCheckReadGrant(
  pool: pg.Pool,
  tenantId: string,
  actorId: string,
  appId: string,
  nowMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Step 1: genesis-owner short-circuit (tenant-owner role check via loadAdminContext).
  const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);
  if (admin.isGenesisOwner) {
    return { ok: true };
  }

  // Step 2: Non-genesis path — query `application read` grants and apply scope-containment.
  //
  // ADR §6: page visibility = grant `read` on resource_type `application`.
  // T-0193 (R-6): the grant's scope must CONTAIN the target application (appId).
  // A grant scoped to App-A must NOT grant access to pages of App-B.
  //
  // Implementation: fetch candidate grants (resource_type=application, operation=read,
  // in-window, confirmed role_assignment), load their scope column, then filter in
  // application code using isNarrowerOrEqual(targetAppScope, grantScope, RESOURCE_ORACLE).
  //
  // This is the JOIN+containment path per the T-0193 spec (minimal honest variant):
  // resolveFor full PDP requires GrantSource/RecordSource ports not available here;
  // instead we import isNarrowerOrEqual (pure function from grant-lattice.ts, no duplication)
  // and apply it to the fetched grant rows.
  //
  // Pattern mirrors invoke.ts loadInvokeGrants (src/http/invoke.ts:220-262) for the JOIN,
  // and secret-handle.ts holdsAgentMgmtUpdate (src/http/secret-handle.ts:154-166) for the
  // isNarrowerOrEqual post-fetch filter.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");

    // Resolve the actor's employee.id from slug (actorId is the slug in dev-mode).
    const { rows: empRows } = await client.query<{ id: string }>(
      `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
      [tenantId, actorId],
    );
    if (empRows.length === 0) {
      await client.query("COMMIT");
      return { ok: false, reason: "no_read_grant_on_application" };
    }
    const employeeId = empRows[0]!.id;

    // Load candidate grants: confirmed role_assignment + application/read + in-window.
    // Fetch scope column for containment check (T-0193 R-6).
    const { rows: grantRows } = await client.query<{ id: string; scope: unknown }>(
      `SELECT g.id, g.scope
         FROM choros."grant" g
         JOIN choros.role_assignment ra
           ON ra.tenant_id = g.tenant_id AND ra.role_id = g.role_id
        WHERE g.tenant_id = $1
          AND ra.employee_id = $2
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $3)
          AND g.resource_type = 'application'
          AND g.operation = 'read'
          AND (g.valid_from  IS NULL OR g.valid_from  <= $3)
          AND (g.valid_until IS NULL OR g.valid_until  > $3)`,
      [tenantId, employeeId, nowMs],
    );
    await client.query("COMMIT");

    if (grantRows.length === 0) {
      return { ok: false, reason: "no_read_grant_on_application" };
    }

    // T-0193 (R-6): scope-containment check.
    // Target scope: the specific application node for this page's app_id.
    // A grant covers the page iff its scope contains (is ⊒ than) the target app node.
    // isNarrowerOrEqual(target, grantScope): target ⊑ grantScope ↔ grant covers target.
    const targetAppScope: ScopeElement = {
      kind: "node",
      hierarchy: "resource",
      nodeId: appId,
      nodeLevel: "application",
    };

    const hasCovering = grantRows.some((row) => {
      const rawScope = row.scope;
      // Freeform scopes are owner-only, non-delegable, outside the lattice — skip.
      if (
        rawScope === null ||
        typeof rawScope !== "object" ||
        (rawScope as Record<string, unknown>)["kind"] === "freeform"
      ) {
        return false;
      }
      const grantScope = rawScope as ScopeElement;
      // isNarrowerOrEqual(target, parent): true iff target's reach ⊆ parent's reach.
      // RESOURCE_ORACLE: day-1 equality-only for resource hierarchy UUIDs.
      return isNarrowerOrEqual(targetAppScope, grantScope, RESOURCE_ORACLE);
    });

    if (!hasCovering) {
      return { ok: false, reason: "no_read_grant_on_application" };
    }
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const defaultRenderAuthzDeps: ReportPageRenderAuthzDeps = {
  checkReadGrant: defaultCheckReadGrant,
};

// ---------------------------------------------------------------------------
// withTenantTx — mirrors report-pages.ts pattern (T-0013 / T-0144)
// ---------------------------------------------------------------------------

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new HttpError(400, "VALIDATION", "tenantId must be a valid UUID");
  }
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
// Auth helper — extracts actor id from request (Keycloak or dev-mode)
// ---------------------------------------------------------------------------

function extractActor(req: IncomingMessage): string {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) return ctx.sub;
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface ReportPageRow {
  id: string;
  app_id: string;
  floor: string;
  page_def: unknown;
  page_code: string | null;
}

interface RegistryDefSchemaRow {
  id: string;
  record_schema: unknown;
}

// ---------------------------------------------------------------------------
// Floor-1 Vocab types (ADR §4)
// ---------------------------------------------------------------------------

type AggFunc = "count" | "sum" | "avg" | "min" | "max" | "list";

interface Floor1Filter {
  field_key: string;
  op: "=" | "!=" | "<" | ">" | "in";
  value: unknown;
}

interface Floor1Metric {
  source_registry_def_id: string;
  field_key: string;
  agg: AggFunc;
  group_by?: string;
  filter?: Floor1Filter;
  title?: string;
  subtitle?: string;
}

// ---------------------------------------------------------------------------
// SQL injection safety — field key validation
//
// Two layers:
//   1. FIELD_KEY_SAFE_RE — structural charset guard (rejects quotes, semicolons, etc.)
//   2. schemaWhitelist — existence check against record_schema.properties (loaded from DB)
//
// Both must pass before field_key is used as a jsonb path literal.
// ---------------------------------------------------------------------------

/** Validates field_key against charset guard. Throws 400 on failure. */
function assertFieldKeySafe(fieldKey: string, context: string): void {
  if (!FIELD_KEY_SAFE_RE.test(fieldKey)) {
    throw new HttpError(
      400,
      "UNSAFE_FIELD_KEY",
      `field_key "${fieldKey}" (${context}) contains characters outside [a-zA-Z0-9_-]; ` +
        `possible SQL injection attempt rejected`,
    );
  }
}

/** Validates field_key against schema whitelist. Throws 422 on failure. */
function assertFieldKeyInSchema(
  fieldKey: string,
  schemaProps: Record<string, unknown>,
  context: string,
): void {
  if (!(fieldKey in schemaProps)) {
    throw new HttpError(
      422,
      "FIELD_KEY_NOT_IN_SCHEMA",
      `field_key "${fieldKey}" (${context}) not found in record_schema.properties`,
    );
  }
}

// ---------------------------------------------------------------------------
// parseMetrics — parse and type-check page_def metrics[]
//
// SECURITY: charset guard (assertFieldKeySafe) runs HERE during parsing,
// BEFORE any DB query. This is intentional fail-fast order:
//   1. charset guard → 400 UNSAFE_FIELD_KEY (earliest possible rejection)
//   2. registry_def schema load (DB query)
//   3. whitelist guard → 422 FIELD_KEY_NOT_IN_SCHEMA
//
// The charset guard firing before the DB query is the correct security
// design: no DB I/O occurs with injected data.
// ---------------------------------------------------------------------------

function parseMetrics(pageDef: unknown): Floor1Metric[] {
  if (!Array.isArray(pageDef)) {
    throw new HttpError(
      400,
      "INVALID_PAGE_DEF",
      "page_def must be an array of metric objects",
    );
  }
  const metrics: Floor1Metric[] = [];
  for (let i = 0; i < pageDef.length; i++) {
    const m = pageDef[i];
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      throw new HttpError(
        400,
        "INVALID_PAGE_DEF",
        `metrics[${i}] is not a plain object`,
      );
    }
    const obj = m as Record<string, unknown>;
    if (typeof obj["source_registry_def_id"] !== "string") {
      throw new HttpError(400, "INVALID_PAGE_DEF", `metrics[${i}].source_registry_def_id missing or not string`);
    }
    if (typeof obj["field_key"] !== "string") {
      throw new HttpError(400, "INVALID_PAGE_DEF", `metrics[${i}].field_key missing or not string`);
    }

    // SECURITY: charset guard fires HERE (before any DB query) — fail-fast.
    // Any field_key with SQL metacharacters is rejected immediately with 400.
    assertFieldKeySafe(obj["field_key"] as string, `metrics[${i}].field_key`);

    const validAggs: AggFunc[] = ["count", "sum", "avg", "min", "max", "list"];
    if (!validAggs.includes(obj["agg"] as AggFunc)) {
      throw new HttpError(400, "INVALID_PAGE_DEF", `metrics[${i}].agg "${String(obj["agg"])}" not in Floor-1 vocab`);
    }
    const metric: Floor1Metric = {
      source_registry_def_id: obj["source_registry_def_id"] as string,
      field_key: obj["field_key"] as string,
      agg: obj["agg"] as AggFunc,
    };
    if ("group_by" in obj && typeof obj["group_by"] === "string") {
      // SECURITY: charset guard on group_by at parse time too
      assertFieldKeySafe(obj["group_by"] as string, `metrics[${i}].group_by`);
      metric.group_by = obj["group_by"] as string;
    }
    if ("filter" in obj && obj["filter"] !== null && typeof obj["filter"] === "object" && !Array.isArray(obj["filter"])) {
      const f = obj["filter"] as Record<string, unknown>;
      const validOps = ["=", "!=", "<", ">", "in"];
      if (typeof f["field_key"] !== "string" || !validOps.includes(String(f["op"]))) {
        throw new HttpError(400, "INVALID_PAGE_DEF", `metrics[${i}].filter is malformed`);
      }
      // SECURITY: charset guard on filter.field_key at parse time
      assertFieldKeySafe(f["field_key"] as string, `metrics[${i}].filter.field_key`);
      metric.filter = {
        field_key: f["field_key"] as string,
        op: f["op"] as Floor1Filter["op"],
        value: f["value"],
      };
    }
    metrics.push(metric);
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// buildAggSql — builds parameterized SQL for one Floor-1 metric.
//
// SECURITY: field_key and group_by are used as jsonb-path string literals in
// the SQL text ONLY AFTER both charset and schema-whitelist validation.
// The pattern used is: (data->>'<field_key>')::cast
// This is safe because:
//   (a) FIELD_KEY_SAFE_RE guarantees no SQL metacharacters.
//   (b) The schema whitelist guarantees the key exists in the registry.
//   (c) The single-quotes wrapping are part of the jsonb operator syntax
//       and cannot be injected out of because the charset guard blocks quotes.
//
// filter.value is ALWAYS a $N parameter — never in SQL text.
//
// Returns: { sql, params, isGrouped }
// ---------------------------------------------------------------------------

interface BuiltQuery {
  sql: string;
  params: unknown[];
  isGrouped: boolean;
}

function buildAggSql(
  metric: Floor1Metric,
  schemaProps: Record<string, unknown>,
  tenantId: string,
  registryDefId: string,
): BuiltQuery {
  const { field_key, agg, group_by, filter } = metric;

  // Dual guard: charset + whitelist
  assertFieldKeySafe(field_key, `metrics[field_key]`);
  assertFieldKeyInSchema(field_key, schemaProps, `metrics[field_key]`);
  if (group_by !== undefined) {
    assertFieldKeySafe(group_by, `metrics[group_by]`);
    assertFieldKeyInSchema(group_by, schemaProps, `metrics[group_by]`);
  }

  const params: unknown[] = [tenantId, registryDefId];
  let paramIdx = 3;

  // Validate and build WHERE filter clause if present
  let filterClause = "";
  if (filter !== undefined) {
    assertFieldKeySafe(filter.field_key, `filter.field_key`);
    assertFieldKeyInSchema(filter.field_key, schemaProps, `filter.field_key`);

    if (filter.op === "in") {
      // value must be an array
      if (!Array.isArray(filter.value)) {
        throw new HttpError(400, "INVALID_FILTER", `filter.op='in' requires value to be an array`);
      }
      // Build $N,$M,... for array elements (all parameterized)
      const placeholders = (filter.value as unknown[]).map(() => {
        const ph = `$${paramIdx}`;
        paramIdx++;
        return ph;
      });
      for (const v of filter.value as unknown[]) {
        params.push(v);
      }
      // Safe: filter.field_key is charset-guarded + whitelist-validated
      filterClause = ` AND data->>'${filter.field_key}' IN (${placeholders.join(",")})`;
    } else {
      // Scalar comparison — value is parameterized
      params.push(filter.value);
      const ph = `$${paramIdx}`;
      paramIdx++;
      // Safe: filter.field_key is charset-guarded + whitelist-validated
      // op comes from closed set ["=","!=","<",">"] — no injection possible
      filterClause = ` AND (data->>'${filter.field_key}') ${filter.op} ${ph}`;
    }
  }

  const isGrouped = group_by !== undefined;

  // Build SELECT expression based on agg type
  let selectExpr: string;
  let groupByClause = "";

  if (agg === "list") {
    // Returns jsonb array of field values — no numeric cast needed
    // Safe: field_key is charset-guarded + whitelist-validated
    selectExpr = isGrouped
      ? `data->>'${group_by}' AS group_key, json_agg(data->>'${field_key}') AS agg_result`
      : `json_agg(data->>'${field_key}') AS agg_result`;
  } else if (agg === "count") {
    // count(*) — field_key not used in aggregate but still validated (dep registered for it)
    selectExpr = isGrouped
      ? `data->>'${group_by}' AS group_key, COUNT(*) AS agg_result`
      : `COUNT(*) AS agg_result`;
  } else {
    // sum/avg/min/max — cast to numeric
    // Safe: field_key is charset-guarded + whitelist-validated
    const sqlAgg = agg.toUpperCase();
    selectExpr = isGrouped
      ? `data->>'${group_by}' AS group_key, ${sqlAgg}((data->>'${field_key}')::numeric) AS agg_result`
      : `${sqlAgg}((data->>'${field_key}')::numeric) AS agg_result`;
  }

  if (isGrouped) {
    // Safe: group_by is charset-guarded + whitelist-validated
    groupByClause = ` GROUP BY data->>'${group_by}'`;
  }

  const sql = `SELECT ${selectExpr}
    FROM choros.record
   WHERE tenant_id = $1 AND registry_id = $2${filterClause}${groupByClause}`;

  return { sql, params, isGrouped };
}

// ---------------------------------------------------------------------------
// MetricResult — output shape for one rendered metric
// ---------------------------------------------------------------------------

export interface MetricResult {
  source_registry_def_id: string;
  field_key: string;
  agg: string;
  title?: string;
  result: unknown;            // scalar for non-grouped
  grouped?: Array<{ group_key: string; result: unknown }>; // for group_by
}

export interface RenderResult {
  page_id: string;
  floor: "1";
  metrics: MetricResult[];
}

// ---------------------------------------------------------------------------
// renderFloor1 — core Floor-1 render logic
// ---------------------------------------------------------------------------

async function renderFloor1(args: {
  pool: pg.Pool;
  tenantId: string;
  pageId: string;
  actor: string;
  nowMs: number;
  authzDeps: ReportPageRenderAuthzDeps;
}): Promise<RenderResult> {
  const { pool, tenantId, pageId, actor, nowMs, authzDeps } = args;

  return withTenantTx(pool, tenantId, async (client) => {
    // 1. Load page (RLS-gated) — must happen first to obtain app_id for PDP gate.
    const { rows: pageRows } = await client.query<ReportPageRow>(
      `SELECT id, app_id, floor, page_def, page_code
         FROM choros.report_page
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, pageId],
    );
    if (pageRows.length === 0) {
      throw new HttpError(404, "NOT_FOUND", "report_page not found");
    }
    const page = pageRows[0]!;

    if (page.floor !== "1") {
      throw new HttpError(
        400,
        "WRONG_FLOOR",
        `report_page floor=${page.floor}; render endpoint requires floor=1`,
      );
    }

    // 2. PDP gate: application read grant scoped to this page's app_id (ADR §6 + T-0193 R-6).
    // Called after page load so we can pass app_id for scope-containment check.
    // The pool is passed separately (defaultCheckReadGrant opens its own connection).
    const gateResult = await authzDeps.checkReadGrant(pool, tenantId, actor, page.app_id, nowMs);
    if (!gateResult.ok) {
      throw new HttpError(403, "NO_READ_GRANT", `read on application denied: ${gateResult.reason}`);
    }

    // 3. Parse metrics from page_def
    const metrics = parseMetrics(page.page_def);

    if (metrics.length === 0) {
      return { page_id: pageId, floor: "1", metrics: [] };
    }

    // 4. Group metrics by source_registry_def_id for batched schema lookup
    const byRegistryDef = new Map<string, Floor1Metric[]>();
    for (const m of metrics) {
      const group = byRegistryDef.get(m.source_registry_def_id) ?? [];
      group.push(m);
      byRegistryDef.set(m.source_registry_def_id, group);
    }

    // 5. For each registry_def: load schema, validate field_keys, run aggregates
    const results: MetricResult[] = [];

    for (const [registryDefId, metricGroup] of byRegistryDef) {
      if (!UUID_RE.test(registryDefId)) {
        throw new HttpError(
          400,
          "INVALID_REGISTRY_DEF_ID",
          `source_registry_def_id "${registryDefId}" is not a valid UUID`,
        );
      }

      // Load record_schema (under RLS — same tenant only)
      const { rows: schemaRows } = await client.query<RegistryDefSchemaRow>(
        `SELECT id, record_schema
           FROM choros.registry_def
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, registryDefId],
      );
      if (schemaRows.length === 0) {
        throw new HttpError(
          422,
          "REGISTRY_DEF_NOT_FOUND",
          `registry_def ${registryDefId} not found`,
        );
      }

      const recordSchema = schemaRows[0]!.record_schema as { properties?: Record<string, unknown> };
      const schemaProps = recordSchema.properties ?? {};

      // Run each metric aggregate
      for (const metric of metricGroup) {
        const { sql, params, isGrouped } = buildAggSql(
          metric,
          schemaProps,
          tenantId,
          registryDefId,
        );

        const { rows: aggRows } = await client.query(sql, params);

        let metricResult: MetricResult;

        if (isGrouped) {
          const grouped = aggRows.map((row: Record<string, unknown>) => ({
            group_key: String(row["group_key"] ?? ""),
            result: row["agg_result"] ?? null,
          }));
          metricResult = {
            source_registry_def_id: registryDefId,
            field_key: metric.field_key,
            agg: metric.agg,
            result: null,
            grouped,
          };
        } else {
          const row = aggRows[0] as Record<string, unknown> | undefined;
          metricResult = {
            source_registry_def_id: registryDefId,
            field_key: metric.field_key,
            agg: metric.agg,
            result: row?.["agg_result"] ?? null,
          };
        }

        if (metric.title !== undefined) {
          metricResult.title = metric.title;
        }

        results.push(metricResult);
      }
    }

    return { page_id: pageId, floor: "1", metrics: results };
  });
}

// ---------------------------------------------------------------------------
// dataFloor2 — Floor-2 RLS-gated data API (ADR §6 / §7 AC-11)
//
// Returns raw record rows for a given registry_def, subject to:
//   - RLS: tenant isolation via GUC choros.tenant_id.
//   - PDP: checkReadGrant (application read grant).
//   - No DB credentials in response.
//   - limit capped at MAX_DATA_LIMIT (100).
//   - offset must be >= 0.
// ---------------------------------------------------------------------------

export interface DataResult {
  page_id: string;
  floor: "2";
  registry_def_id: string;
  records: Array<{ id: string; data: unknown; created_at: number | string; updated_at: number | string }>;
  total_count: number;
  limit: number;
  offset: number;
}

async function dataFloor2(args: {
  pool: pg.Pool;
  tenantId: string;
  pageId: string;
  registryDefId: string;
  limit: number;
  offset: number;
  actor: string;
  nowMs: number;
  authzDeps: ReportPageRenderAuthzDeps;
}): Promise<DataResult> {
  const { pool, tenantId, pageId, registryDefId, limit, offset, actor, nowMs, authzDeps } = args;

  return withTenantTx(pool, tenantId, async (client) => {
    // 1. Load page to verify it exists and is floor=2 (and belongs to this tenant).
    // Page loaded first to obtain app_id for PDP gate (T-0193 R-6 scope-containment).
    const { rows: pageRows } = await client.query<ReportPageRow>(
      `SELECT id, app_id, floor, page_def, page_code
         FROM choros.report_page
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, pageId],
    );
    if (pageRows.length === 0) {
      throw new HttpError(404, "NOT_FOUND", "report_page not found");
    }
    const page = pageRows[0]!;

    if (page.floor !== "2") {
      throw new HttpError(
        400,
        "WRONG_FLOOR",
        `report_page floor=${page.floor}; data endpoint requires floor=2`,
      );
    }

    // 2. PDP gate: application read grant scoped to this page's app_id (ADR §6 + T-0193 R-6).
    // Checked after page existence/floor validated, before any data is returned.
    const gateResult = await authzDeps.checkReadGrant(pool, tenantId, actor, page.app_id, nowMs);
    if (!gateResult.ok) {
      throw new HttpError(403, "NO_READ_GRANT", `read on application denied: ${gateResult.reason}`);
    }

    // 3. Verify registry_def belongs to this tenant (RLS covers it, but explicit FK check)
    const { rows: regRows } = await client.query(
      `SELECT id FROM choros.registry_def WHERE tenant_id = $1 AND id = $2`,
      [tenantId, registryDefId],
    );
    if (regRows.length === 0) {
      throw new HttpError(
        422,
        "REGISTRY_DEF_NOT_FOUND",
        `registry_def ${registryDefId} not found in tenant`,
      );
    }

    // 4. Count total records (for pagination metadata)
    const { rows: countRows } = await client.query<{ total: string }>(
      `SELECT COUNT(*) AS total
         FROM choros.record
        WHERE tenant_id = $1 AND registry_id = $2`,
      [tenantId, registryDefId],
    );
    const totalCount = parseInt(countRows[0]?.total ?? "0", 10);

    // 5. Fetch records with limit+offset (all parameterized — no interpolation)
    const { rows: recordRows } = await client.query<{
      id: string;
      data: unknown;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, data, created_at, updated_at
         FROM choros.record
        WHERE tenant_id = $1 AND registry_id = $2
        ORDER BY created_at ASC, id ASC
        LIMIT $3 OFFSET $4`,
      [tenantId, registryDefId, limit, offset],
    );

    return {
      page_id: pageId,
      floor: "2",
      registry_def_id: registryDefId,
      records: recordRows.map((r) => ({
        id: r.id,
        data: r.data,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
      total_count: totalCount,
      limit,
      offset,
    };
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers Floor-1 render and Floor-2 data API routes on the router.
 *
 * @param router    - The application router.
 * @param _poolHint - Optional pool override (test injection).
 * @param deps      - Injectable PDP gate deps.
 */
export function registerReportPageRenderRoutes(
  router: Router,
  _poolHint?: pg.Pool,
  deps: ReportPageRenderAuthzDeps = defaultRenderAuthzDeps,
): void {
  // -------------------------------------------------------------------------
  // GET /api/report-pages/:id/render — Floor-1 server-side aggregate renderer
  // -------------------------------------------------------------------------
  router.register(
    "GET",
    "/api/report-pages/:id/render",
    async (req, res, params) => {
      const pageId = params["id"] ?? "";
      if (!UUID_RE.test(pageId)) {
        throw new HttpError(400, "VALIDATION", "report_page id must be a valid UUID");
      }

      // Auth (required for PDP gate + RLS context)
      const actor = extractActor(req);

      const result = await renderFloor1({
        pool: _poolHint ?? getPool(),
        tenantId: DEV_TENANT_ID,
        pageId,
        actor,
        nowMs: Date.now(),
        authzDeps: deps,
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/report-pages/:id/data — Floor-2 RLS-gated data API
  // -------------------------------------------------------------------------
  router.register(
    "GET",
    "/api/report-pages/:id/data",
    async (req, res, params) => {
      const pageId = params["id"] ?? "";
      if (!UUID_RE.test(pageId)) {
        throw new HttpError(400, "VALIDATION", "report_page id must be a valid UUID");
      }

      const actor = extractActor(req);

      // Parse query params
      const url = new URL(req.url ?? "/", "http://localhost");
      const registryDefId = url.searchParams.get("registry_def_id") ?? "";
      if (!UUID_RE.test(registryDefId)) {
        throw new HttpError(400, "VALIDATION", "registry_def_id query param must be a valid UUID");
      }

      const rawLimit = url.searchParams.get("limit");
      const rawOffset = url.searchParams.get("offset");

      let limitVal = MAX_DATA_LIMIT;
      if (rawLimit !== null) {
        limitVal = parseInt(rawLimit, 10);
        if (!Number.isFinite(limitVal) || limitVal < 1) {
          throw new HttpError(400, "VALIDATION", "limit must be a positive integer");
        }
        if (limitVal > MAX_DATA_LIMIT) {
          limitVal = MAX_DATA_LIMIT; // cap silently
        }
      }

      let offsetVal = 0;
      if (rawOffset !== null) {
        offsetVal = parseInt(rawOffset, 10);
        if (!Number.isFinite(offsetVal) || offsetVal < 0) {
          throw new HttpError(400, "VALIDATION", "offset must be a non-negative integer");
        }
      }

      const result = await dataFloor2({
        pool: _poolHint ?? getPool(),
        tenantId: DEV_TENANT_ID,
        pageId,
        registryDefId,
        limit: limitVal,
        offset: offsetVal,
        actor,
        nowMs: Date.now(),
        authzDeps: deps,
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    },
  );
}
