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
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { loadAdminContext, resolveActorSlugFromAuth } from "../db/org.js";
// T-0662: single NAMED deactivation predicate. defaultCheckReadGrant (below,
// non-owner branch) is authority resolver C — it carries ACTOR_ACTIVE_SQL.
import { ACTOR_ACTIVE_SQL } from "../db/actor-authority-gate.js";
import {
  isNarrowerOrEqual,
  type Grant,
  type ScopeElement,
  type AncestryOracle,
} from "../core/grant-lattice.js";
// T-0491: zero-dependency tabular export (CSV + XLSX) for the Floor-1 aggregate.
import { toCsv, toXlsx, sanitizeSheetName, type Tabular } from "./tabular-export.js";
// T-0339 [E15-S3]: cycle-time analytics for the transition journal.
import {
  loadCycleTimeByActivity,
  loadActorTypeBreakdown,
  loadProcessKeys,
  type CycleTimeAnalytics,
  type ActorTypeBreakdown,
} from "../db/transition-journal.js";
// T-0632 (security, столп 4): the SAME per-row READ-PDP predicate GET
// /api/records and the analyst (T-0587 registry-digest-dao.ts) already use —
// single-resolver, NOT a second authority path (NF-1).
import { isRecordReadable, type RowAncestry } from "../core/read-visibility.js";
// T-0632: pure, IO-free Floor-1 aggregate accumulator over an
// ALREADY-READ-PDP-FILTERED row stream (mirrors visible-aggregate.ts, T-0587
// §1.4, generalized to the full Floor-1 vocab: group_by / filter / list).
import { VisibleAggregator, matchesFilter, type VisibleFilterSpec } from "../core/visible-record-agg.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maximum records returned by Floor-2 data API per request. */
export const MAX_DATA_LIMIT = 100;

/**
 * T-0632 (security, столп 4 / NF-3 bounded): maximum candidate records
 * scanned per Floor-1 metric when computing an aggregate over the
 * READ-PDP-visible subset. Mirrors `registry-digest-dao.ts`'s `scanLimit`
 * (T-0587 §1.4) — the aggregate is bounded, not an unbounded `SELECT *`.
 * When the DB returns exactly this many candidate rows, the aggregate MAY
 * understate the true visible set (see `truncated` on `MetricResult`).
 */
export const AGG_SCAN_LIMIT = 5000;

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

// ---------------------------------------------------------------------------
// T-0632 (security, столп 4): record-level READ-PDP visibility resolver.
//
// ADDITIVE, OPTIONAL — mirrors `ReadVisibilityResolver` in `src/http/records.ts`
// / the production wiring in `src/server.ts` (:875-885) BYTE-FOR-BYTE: the same
// `getGrantsForSubject` + `loadTenantOrgAncestry` → `makeResourceAncestryOracle`
// composition. NOT a second authority path (NF-1) — this resolver returns
// exactly the `{ grants, ancestry }` shape `isRecordReadable` (T-0570,
// src/core/read-visibility.ts) already consumes.
//
// THE DEFECT this closes (adversary finding T-0587, ADR-T0587 §1.1): the
// Floor-1 aggregate renderer used to compute SUM/AVG/COUNT/MIN/MAX/LIST as a
// raw SQL aggregate over EVERY record in a registry, gated only by the
// application-level `checkReadGrant` above — never a record-level READ-PDP
// check. An actor with a narrow record-scope grant (sees a subset of a
// registry's rows) received an aggregate computed over rows they cannot read
// individually. This resolver is the record-level gate ADR-T0587 §1.1
// deliberately declined to build INTO the analyst (reusing this exact module
// would have leaked) — T-0632 closes it here, at the source.
//
// HONEST-DEGRADE (mirrors records.ts's ReadVisibilityResolver / NF-2): this
// parameter is OPTIONAL on `registerReportPageRenderRoutes` so existing unit
// tests that do not pass it keep compiling; when absent, `renderFloor1`
// degrades to the OLD (pre-T-0632) full-registry aggregate — a deliberate,
// documented test-only degradation, NOT a sanctioned production state.
// `src/server.ts` MUST wire this resolver (this is a security fix, not an
// opt-in feature).
// ---------------------------------------------------------------------------

export type ReportAggReadVisibilityResolver = (
  actorSlug: string,
  tenantId: string,
  nowMs: number,
) => Promise<{ grants: Grant[]; ancestry: AncestryOracle }>;

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
    //
    // T-0658 [security/системный, столп 4] — `AND deactivated_at IS NULL`
    // (fail-closed). This is the non-owner branch of the report-page read-authz
    // resolver: a bespoke inline grant read (NOT via getGrantsForSubject), so
    // the grant-side T-0658 gate does not cover it. Without this predicate a
    // DEACTIVATED employee holding an application:read grant, with a still-live
    // KC token, kept rendering report pages. The owner branch (step 1,
    // loadAdminContext above) is already gated by the org.ts T-0658 fix; this
    // closes the delegated-reader branch too so no parallel path resolves a
    // deactivated subject to page-read authority.
    // T-0662: `deactivated_at IS NULL` via the single named marker ACTOR_ACTIVE_SQL.
    const { rows: empRows } = await client.query<{ id: string }>(
      `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 AND ${ACTOR_ACTIVE_SQL} LIMIT 1`,
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

// keycloak mode: the JWT `sub` is the KC user UUID, NOT the employee slug; resolve
// it to the slug (T-0489 / T-0372, kind='human') so the PDP gate (defaultCheckReadGrant
// looks up employee.slug) + tenant resolution use the real identity. null ⇒ 401.
// dev mode: read the x-dev-user header as before.
async function extractActor(req: IncomingMessage, pool: pg.Pool): Promise<string> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
  }
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// T-0489 [SECURITY]: tenant from the actor's OWN row (resolveActorTenant, fail-
// closed) when a resolver is wired (server.ts); never a request-supplied tenant.
// Omitted in unit tests → DEV_TENANT_ID (unchanged).
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

async function resolveTenantForActor(
  actorSlug: string,
  resolveActorTenant: ActorTenantResolver | undefined,
): Promise<string> {
  return resolveActorTenant ? resolveActorTenant(actorSlug) : DEV_TENANT_ID;
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
// buildFilterClause — parameterized WHERE-filter builder shared by BOTH the
// legacy full-registry SQL aggregate (honest-degrade fallback, no resolver
// wired) and the new raw-row fetch (T-0632 default path).
//
// SECURITY: field_key is used as a jsonb-path string literal in the SQL text
// ONLY AFTER both charset and schema-whitelist validation — unchanged from
// the original buildAggSql (NF-5, ci/checks/report-page-render-isolation.sh).
// filter.value is ALWAYS a $N parameter — never in SQL text.
// ---------------------------------------------------------------------------

interface FilterClauseResult {
  clause: string;
  params: unknown[];
  nextParamIdx: number;
}

function buildFilterClause(
  filter: Floor1Filter | undefined,
  schemaProps: Record<string, unknown>,
  startParamIdx: number,
): FilterClauseResult {
  if (filter === undefined) {
    return { clause: "", params: [], nextParamIdx: startParamIdx };
  }
  assertFieldKeySafe(filter.field_key, `filter.field_key`);
  assertFieldKeyInSchema(filter.field_key, schemaProps, `filter.field_key`);

  let paramIdx = startParamIdx;
  const params: unknown[] = [];
  let clause: string;

  if (filter.op === "in") {
    if (!Array.isArray(filter.value)) {
      throw new HttpError(400, "INVALID_FILTER", `filter.op='in' requires value to be an array`);
    }
    const placeholders = (filter.value as unknown[]).map(() => {
      const ph = `$${paramIdx}`;
      paramIdx++;
      return ph;
    });
    for (const v of filter.value as unknown[]) {
      params.push(v);
    }
    // Safe: filter.field_key is charset-guarded + whitelist-validated
    clause = ` AND data->>'${filter.field_key}' IN (${placeholders.join(",")})`;
  } else {
    params.push(filter.value);
    const ph = `$${paramIdx}`;
    paramIdx++;
    // Safe: filter.field_key is charset-guarded + whitelist-validated
    // op comes from closed set ["=","!=","<",">"] — no injection possible
    clause = ` AND (data->>'${filter.field_key}') ${filter.op} ${ph}`;
  }

  return { clause, params, nextParamIdx: paramIdx };
}

// ---------------------------------------------------------------------------
// buildRawRecordSql — T-0632 (security, столп 4) — DEFAULT Floor-1 aggregate
// path. Instead of computing SUM/AVG/COUNT/MIN/MAX/LIST as a raw SQL
// aggregate over EVERY record in a registry (the pre-T-0632 behavior, which
// let an actor with a narrow record-scope READ grant see an aggregate over
// rows they cannot read individually — ADR-T0587 §1.1 finding), this fetches
// a BOUNDED (AGG_SCAN_LIMIT, NF-3) candidate window of raw `{id, data}` rows
// — the SAME WHERE tenant/registry/filter predicate the old SQL aggregate
// used — and lets the caller (renderFloor1) filter each row through
// `isRecordReadable` BEFORE folding it into the aggregate (VisibleAggregator,
// src/core/visible-record-agg.ts).
//
// SECURITY: identical charset+whitelist guard discipline as the legacy path —
// field_key/group_by are validated before being referenced by
// buildFilterClause; filter.value is always parameterized.
// ---------------------------------------------------------------------------

interface BuiltRawRowQuery {
  sql: string;
  params: unknown[];
}

function buildRawRecordSql(
  metric: Floor1Metric,
  schemaProps: Record<string, unknown>,
  tenantId: string,
  registryDefId: string,
): BuiltRawRowQuery {
  const { field_key, group_by } = metric;

  // Dual guard: charset + whitelist (unchanged from the original buildAggSql).
  assertFieldKeySafe(field_key, `metrics[field_key]`);
  assertFieldKeyInSchema(field_key, schemaProps, `metrics[field_key]`);
  if (group_by !== undefined) {
    assertFieldKeySafe(group_by, `metrics[group_by]`);
    assertFieldKeyInSchema(group_by, schemaProps, `metrics[group_by]`);
  }

  const { clause: filterClause, params: filterParams } = buildFilterClause(
    metric.filter,
    schemaProps,
    4,
  );

  const sql = `SELECT id, data
    FROM choros.record
   WHERE tenant_id = $1 AND registry_id = $2${filterClause}
   ORDER BY created_at DESC, id ASC
   LIMIT $3`;

  return { sql, params: [tenantId, registryDefId, ...filterParams, AGG_SCAN_LIMIT] };
}

// ---------------------------------------------------------------------------
// buildAggSql — LEGACY full-registry SQL aggregate. Retained ONLY for the
// honest-degrade fallback path (no `resolveReadVisibility` resolver wired —
// test-only, see ReportAggReadVisibilityResolver doc comment above). NOT used
// when a resolver is present (the production path, T-0632 default).
//
// SECURITY: field_key and group_by are used as jsonb-path string literals in
// the SQL text ONLY AFTER both charset and schema-whitelist validation.
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
  const { field_key, agg, group_by } = metric;

  // Dual guard: charset + whitelist
  assertFieldKeySafe(field_key, `metrics[field_key]`);
  assertFieldKeyInSchema(field_key, schemaProps, `metrics[field_key]`);
  if (group_by !== undefined) {
    assertFieldKeySafe(group_by, `metrics[group_by]`);
    assertFieldKeyInSchema(group_by, schemaProps, `metrics[group_by]`);
  }

  const { clause: filterClause, params: filterParams } = buildFilterClause(
    metric.filter,
    schemaProps,
    3,
  );
  const params: unknown[] = [tenantId, registryDefId, ...filterParams];

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
  /**
   * T-0632 (NF-3, mirrors registry-digest-dao.ts's `truncated`): true when the
   * bounded candidate-row scan for THIS metric hit `AGG_SCAN_LIMIT` exactly —
   * there may be more visible (or invisible) rows this aggregate never saw.
   * Only meaningful on the T-0632 READ-PDP-filtered path (absent/false on the
   * legacy honest-degrade fallback, which has no such bound).
   */
  truncated?: boolean;
}

export interface RenderResult {
  page_id: string;
  floor: "1";
  metrics: MetricResult[];
}

// ---------------------------------------------------------------------------
// runVisibilityFilteredMetric — T-0632 (security, столп 4) DEFAULT path.
//
// Fetches a BOUNDED window of raw `{id, data}` candidate rows (buildRawRecordSql
// — same tenant/registry/filter WHERE predicate as the legacy aggregate, same
// charset+whitelist guards), filters EACH row through `isRecordReadable`
// (T-0570 — the exact predicate GET /api/records and the analyst digest use),
// and folds ONLY the rows that pass into a VisibleAggregator
// (src/core/visible-record-agg.ts, pure/IO-free). A row failing the predicate
// contributes to NOTHING — not count, not sum, not any group.
//
// filter (metric.filter) is applied by buildRawRecordSql's WHERE clause AS
// BEFORE (parameterized, unchanged semantics) — matchesFilter here is used
// only defensively (belt-and-suspenders — the SQL WHERE already narrows the
// candidate set; re-checking in JS costs nothing and guards against any future
// refactor accidentally dropping the SQL filter clause).
// ---------------------------------------------------------------------------

async function runVisibilityFilteredMetric(
  client: pg.PoolClient,
  metric: Floor1Metric,
  schemaProps: Record<string, unknown>,
  tenantId: string,
  registryDefId: string,
  grants: readonly Grant[],
  ancestry: AncestryOracle,
  nowMs: number,
): Promise<MetricResult> {
  const { sql, params } = buildRawRecordSql(metric, schemaProps, tenantId, registryDefId);

  const { rows } = await client.query<{ id: string; data: unknown }>(sql, params);

  const aggregator = new VisibleAggregator(metric.agg, metric.field_key, metric.group_by);

  const filterSpec: VisibleFilterSpec | undefined = metric.filter
    ? { fieldKey: metric.filter.field_key, op: metric.filter.op, value: metric.filter.value }
    : undefined;

  for (const row of rows) {
    const rowAncestry: RowAncestry = {
      recordId: row.id,
      registryId: registryDefId,
      applicationId: "", // application-level containment already enforced by checkReadGrant (step 2); record-scope/root-sentinel rules (ADR §2.1 rules 1/2) don't need this field.
    };
    if (!isRecordReadable(rowAncestry, grants, ancestry, nowMs)) continue;
    if (filterSpec !== undefined && !matchesFilter(row.data, filterSpec)) continue;
    // INVARIANT (FR-1): everything below runs ONLY for a row that already
    // passed BOTH isRecordReadable and the filter — mirrors the
    // isRecordReadable-then-accumulate discipline in registry-digest-dao.ts.
    aggregator.fold(row.data);
  }

  const { result, grouped } = aggregator.finalize();
  // T-0632 LEAK B (adversary, LOW — ACCEPTED as-is): `truncated` is computed
  // from the PRE-filter candidate count (rows.length === AGG_SCAN_LIMIT), which
  // reveals only "the scan window was exhausted" — a coarse ≥AGG_SCAN_LIMIT
  // signal, never an exact hidden-record count. This is BYTE-IDENTICAL to the
  // already-accepted T-0587 precedent (registry-digest-dao.ts:
  // `recRes.rows.length === scanLimit`). Computing it from the visible fold-count
  // instead would be semantically WRONG — `truncated` must mean "candidate scan
  // may be incomplete" (a pre-filter property of the window), not "visible set
  // may be incomplete"; a registry of 5000 candidates with 3 visible rows still
  // needs the truncation flag. Kept consistent with T-0587; see ADR-T0632 §7.
  const truncated = rows.length === AGG_SCAN_LIMIT;

  const metricResult: MetricResult = {
    source_registry_def_id: registryDefId,
    field_key: metric.field_key,
    agg: metric.agg,
    result: grouped ? null : result,
    ...(grouped ? { grouped } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
  if (metric.title !== undefined) {
    metricResult.title = metric.title;
  }
  return metricResult;
}

// ---------------------------------------------------------------------------
// runLegacyFullRegistryMetric — honest-degrade fallback (NO resolveReadVisibility
// wired). Reproduces the pre-T-0632 behavior byte-for-byte: a raw SQL aggregate
// over EVERY record in the registry, gated only by the application-level
// checkReadGrant. Test-only / documented degradation — production
// (src/server.ts) always wires the resolver, so this path never runs there.
// ---------------------------------------------------------------------------

async function runLegacyFullRegistryMetric(
  client: pg.PoolClient,
  metric: Floor1Metric,
  schemaProps: Record<string, unknown>,
  tenantId: string,
  registryDefId: string,
): Promise<MetricResult> {
  const { sql, params, isGrouped } = buildAggSql(metric, schemaProps, tenantId, registryDefId);

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

  return metricResult;
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
  /**
   * T-0632 (security, столп 4): OPTIONAL record-level READ-PDP resolver. When
   * present (production, src/server.ts), every metric's aggregate is computed
   * STRICTLY over records `isRecordReadable` allows for THIS actor — closing
   * the ADR-T0587 §1.1 finding. When absent (honest-degrade, test-only — see
   * ReportAggReadVisibilityResolver doc comment), falls back to the legacy
   * full-registry SQL aggregate (pre-T-0632 behavior).
   */
  resolveReadVisibility?: ReportAggReadVisibilityResolver;
}): Promise<RenderResult> {
  const { pool, tenantId, pageId, actor, nowMs, authzDeps, resolveReadVisibility } = args;

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
    // FR-3 (T-0632): this application-level gate remains FIRST and MANDATORY —
    // the record-level READ-PDP filter below is an ADDITIONAL, second gate on
    // top of it, never a replacement.
    const gateResult = await authzDeps.checkReadGrant(pool, tenantId, actor, page.app_id, nowMs);
    if (!gateResult.ok) {
      throw new HttpError(403, "NO_READ_GRANT", `read on application denied: ${gateResult.reason}`);
    }

    // 3. Parse metrics from page_def
    const metrics = parseMetrics(page.page_def);

    if (metrics.length === 0) {
      return { page_id: pageId, floor: "1", metrics: [] };
    }

    // 3b. T-0632: resolve the actor's record-level READ-PDP visibility ONCE
    // for the whole render call (NF-1 single-resolver; mirrors records.ts's
    // ReadVisibilityResolver — grants/ancestry resolved once per request, not
    // once per row/metric). Honest-degrade: absent resolver → undefined →
    // every metric below falls back to the legacy full-registry SQL aggregate.
    const visibility = resolveReadVisibility
      ? await resolveReadVisibility(actor, tenantId, nowMs)
      : undefined;

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
        const metricResult = visibility
          ? await runVisibilityFilteredMetric(
              client,
              metric,
              schemaProps,
              tenantId,
              registryDefId,
              visibility.grants,
              visibility.ancestry,
              nowMs,
            )
          : await runLegacyFullRegistryMetric(client, metric, schemaProps, tenantId, registryDefId);

        results.push(metricResult);
      }
    }

    return { page_id: pageId, floor: "1", metrics: results };
  });
}

// ---------------------------------------------------------------------------
// T-0491 — flatten a Floor-1 RenderResult into a tabular shape for export.
//
// The aggregate is heterogeneous (some metrics are scalar, some are grouped),
// so we emit a uniform "long" table whose columns are:
//   metric | group | value
// where:
//   - metric = the metric label (title ?? "<agg>(<field_key>)").
//   - group  = the group_by key value (empty for scalar metrics).
//   - value  = the aggregate result (scalar, or per-group result).
//
// "list" aggregates yield a JSON array; we stringify it into the value cell so
// the file stays flat. Empty metrics → header-only table (valid, NOT an error).
//
// PURE: no DB / authz / env. Operates only on the already-authorized RenderResult.
// ---------------------------------------------------------------------------

function metricLabel(m: MetricResult): string {
  if (m.title !== undefined && m.title !== "") return m.title;
  return `${m.agg}(${m.field_key})`;
}

/** Stringify an aggregate cell value (objects/arrays → JSON; scalars as-is). */
function aggValueToCell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  // arrays / objects (e.g. list agg, jsonb) → compact JSON.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function flattenRenderResultToTable(result: RenderResult): Tabular {
  const columns = ["metric", "group", "value"];
  const rows: Tabular["rows"] = [];
  for (const m of result.metrics) {
    const label = metricLabel(m);
    if (m.grouped !== undefined) {
      for (const g of m.grouped) {
        rows.push([label, g.group_key, aggValueToCell(g.result)]);
      }
    } else {
      rows.push([label, "", aggValueToCell(m.result)]);
    }
  }
  return { columns, rows };
}

// ---------------------------------------------------------------------------
// dataFloor2 — Floor-2 RLS-gated data API (ADR §6 / §7 AC-11)
//
// Returns raw record rows for a given registry_def, subject to:
//   - RLS: tenant isolation via GUC choros.tenant_id.
//   - PDP (application-level): checkReadGrant (application read grant) — FIRST,
//     mandatory gate.
//   - PDP (record-level, T-0632): each row filtered through isRecordReadable;
//     total_count is the VISIBLE count, not a full-registry COUNT(*). This is
//     the raw-row twin of the /render aggregate fix — without it, a narrow
//     record-scope actor read the FULL data of EVERY record here (bypassing the
//     READ-PDP the /render fix added). Active whenever resolveReadVisibility is
//     wired (production); absent → honest-degrade legacy full-registry dump.
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
  /**
   * T-0632 (security, столп 4): OPTIONAL record-level READ-PDP resolver. When
   * present (production, src/server.ts), the raw-record dump is filtered
   * STRICTLY to records `isRecordReadable` allows for THIS actor and
   * `total_count` reflects only the VISIBLE count — closing the sibling of
   * the ADR-T0587 §1.1 finding (the /data endpoint is the raw-row twin of the
   * /render aggregate; the application-level checkReadGrant alone let a narrow
   * record-scope actor read the FULL data of EVERY record + an exact
   * full-registry COUNT). When absent (honest-degrade, test-only), falls back
   * to the pre-T-0632 full-registry dump.
   */
  resolveReadVisibility?: ReportAggReadVisibilityResolver;
}): Promise<DataResult> {
  const { pool, tenantId, pageId, registryDefId, limit, offset, actor, nowMs, authzDeps, resolveReadVisibility } = args;

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
    // FR-3 (T-0632): this application-level gate remains FIRST and MANDATORY — the
    // record-level READ-PDP filter below is an ADDITIONAL, second gate on top of it.
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

    // 3b. T-0632: resolve the actor's record-level READ-PDP visibility ONCE
    // (NF-1 single-resolver — mirrors records.ts). Honest-degrade: absent
    // resolver → the legacy full-registry dump path (step 4/5 below).
    const visibility = resolveReadVisibility
      ? await resolveReadVisibility(actor, tenantId, nowMs)
      : undefined;

    if (visibility === undefined) {
      // -----------------------------------------------------------------------
      // LEGACY / honest-degrade path (no resolver wired — test-only; production
      // src/server.ts ALWAYS wires the resolver). Byte-identical to pre-T-0632:
      // full-registry COUNT + SQL LIMIT/OFFSET dump. NOT a sanctioned prod state.
      // -----------------------------------------------------------------------
      const { rows: countRows } = await client.query<{ total: string }>(
        `SELECT COUNT(*) AS total
           FROM choros.record
          WHERE tenant_id = $1 AND registry_id = $2`,
        [tenantId, registryDefId],
      );
      const totalCount = parseInt(countRows[0]?.total ?? "0", 10);

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
    }

    // -------------------------------------------------------------------------
    // T-0632 DEFAULT (production) path: fetch a BOUNDED candidate window
    // (AGG_SCAN_LIMIT, NF-3 — same bound the /render aggregate uses), filter
    // EACH row through isRecordReadable (the SAME predicate GET /api/records
    // and the analyst use — NF-1), then paginate the VISIBLE subset in-memory
    // and derive total_count from the VISIBLE count (NOT a full-registry
    // COUNT(*), which would itself leak the exact hidden-record count).
    //
    // The application_id per row is needed for the RowAncestry the predicate
    // walks (record-scope self-match rule 1 / root-sentinel rule 2 both work
    // via the record's own id / the root oracle; the join carries application_id
    // for completeness / any future registry/app-scope narrowing, exactly as
    // registry-digest-dao.ts joins it).
    // -------------------------------------------------------------------------
    const { rows: candidateRows } = await client.query<{
      id: string;
      data: unknown;
      created_at: string;
      updated_at: string;
      application_id: string;
    }>(
      `SELECT r.id, r.data, r.created_at, r.updated_at, rd.application_id
         FROM choros.record r
         JOIN choros.registry_def rd
           ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
        WHERE r.tenant_id = $1 AND r.registry_id = $2
        ORDER BY r.created_at ASC, r.id ASC
        LIMIT $3`,
      [tenantId, registryDefId, AGG_SCAN_LIMIT],
    );

    const visibleRows = candidateRows.filter((r) => {
      const rowAncestry: RowAncestry = {
        recordId: r.id,
        registryId: registryDefId,
        applicationId: r.application_id,
      };
      return isRecordReadable(rowAncestry, visibility.grants, visibility.ancestry, nowMs);
    });

    // total_count = count of VISIBLE records only (never the full-registry
    // COUNT(*) — that would leak the number of records the actor cannot read).
    const totalCount = visibleRows.length;

    // Paginate the visible subset in-memory (offset/limit already validated +
    // capped at the route). Slice is byte-identical to what SQL LIMIT/OFFSET
    // would produce over the visible-only ordered set.
    const pageRowsSlice = visibleRows.slice(offset, offset + limit);

    return {
      page_id: pageId,
      floor: "2",
      registry_def_id: registryDefId,
      records: pageRowsSlice.map((r) => ({
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
 * @param resolveActorTenant - T-0489 [SECURITY]: optional tenant resolver. When wired
 *   (server.ts) every route runs in the caller's REAL tenant (fail-closed) instead of
 *   the hardcoded Dev Silo. Omitted in unit tests → DEV_TENANT_ID (unchanged).
 * @param resolveReadVisibility - T-0632 [SECURITY, столп 4]: optional record-level
 *   READ-PDP resolver (ReportAggReadVisibilityResolver). When wired (server.ts, the
 *   SAME getGrantsForSubject+loadTenantOrgAncestry→makeResourceAncestryOracle
 *   composition as records.ts's ReadVisibilityResolver), it gates BOTH sibling
 *   endpoints: (1) /render + /export — every Floor-1 aggregate is computed STRICTLY
 *   over records isRecordReadable allows for the actor; (2) /data — the raw-record
 *   dump is filtered to visible records only + total_count is the visible count.
 *   Closes the ADR-T0587 §1.1 finding AND its /data raw-row sibling (a narrow
 *   record-scope grant used to receive a SUM/COUNT over the WHOLE registry via
 *   /render AND the FULL data of EVERY record via /data). Omitted (test-only) →
 *   legacy full-registry behavior on both (pre-T-0632, honest-degrade).
 *
 * T-0489 G2: every handler is withAuth-wrapped at the registration site — keycloak
 * mode REQUIRES a valid Bearer (401 otherwise; x-dev-user no longer bypasses); dev
 * mode is a no-op pass-through. Closes the http-route-auth-coverage [KNOWN-GAP] entry.
 */
export function registerReportPageRenderRoutes(
  router: Router,
  _poolHint?: pg.Pool,
  deps: ReportPageRenderAuthzDeps = defaultRenderAuthzDeps,
  resolveActorTenant?: ActorTenantResolver,
  resolveReadVisibility?: ReportAggReadVisibilityResolver,
): void {
  // -------------------------------------------------------------------------
  // GET /api/report-pages/:id/render — Floor-1 server-side aggregate renderer
  // -------------------------------------------------------------------------
  router.register(
    "GET",
    "/api/report-pages/:id/render",
    withAuth(async (req, res, params) => {
      const pageId = params["id"] ?? "";
      if (!UUID_RE.test(pageId)) {
        throw new HttpError(400, "VALIDATION", "report_page id must be a valid UUID");
      }

      // Auth (required for PDP gate + RLS context)
      const pool = _poolHint ?? getPool();
      const actor = await extractActor(req, pool);
      const tenantId = await resolveTenantForActor(actor, resolveActorTenant);

      const result = await renderFloor1({
        pool,
        tenantId,
        pageId,
        actor,
        nowMs: Date.now(),
        authzDeps: deps,
        resolveReadVisibility,
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    }),
  );

  // -------------------------------------------------------------------------
  // T-0491: GET /api/report-pages/:id/export?format=xlsx|csv
  //
  // Downloads the SAME Floor-1 aggregate as /render, serialized as a file.
  //
  // SECURITY — reuses /render end-to-end, weakening NOTHING:
  //   - extractActor → resolveTenantForActor: identical actor→tenant resolution
  //     (keycloak JWT sub→slug or dev x-dev-user; tenant from the actor's OWN row).
  //   - renderFloor1(...): the EXACT same function /render calls. It applies the
  //     same PDP read-grant gate (authzDeps.checkReadGrant, scope-contained to the
  //     page's app_id), the same RLS tenant-narrowed queries (withTenantTx GUC),
  //     the same field_key charset+schema injection guards, and (T-0632) the SAME
  //     record-level READ-PDP filter (resolveReadVisibility/isRecordReadable) — an
  //     export can never reveal a wider aggregate than /render would for the same
  //     actor. The export does NOT re-implement any query — it consumes
  //     renderFloor1's already-authorized result.
  //   - MAX_DATA_LIMIT: Floor-1 aggregates collapse the dataset (count/sum/...), so
  //     no row stream crosses the wire; the export is BOUNDED by the same aggregate
  //     vocabulary as /render (no raw-row dump, no limit bypass).
  //   - Unauthenticated → 401, wrong tenant / no grant → 403, same as /render.
  //
  // format: csv (default) | xlsx. Unknown format → 400.
  // -------------------------------------------------------------------------
  router.register(
    "GET",
    "/api/report-pages/:id/export",
    withAuth(async (req, res, params) => {
      const pageId = params["id"] ?? "";
      if (!UUID_RE.test(pageId)) {
        throw new HttpError(400, "VALIDATION", "report_page id must be a valid UUID");
      }

      // Validate format FIRST (before any DB/authz work) — fail-fast on 400.
      const url = new URL(req.url ?? "/", "http://localhost");
      const rawFormat = (url.searchParams.get("format") ?? "csv").toLowerCase();
      if (rawFormat !== "csv" && rawFormat !== "xlsx") {
        throw new HttpError(
          400,
          "VALIDATION",
          `unknown format "${rawFormat}"; expected "csv" or "xlsx"`,
        );
      }

      // Auth + tenant — identical resolution path to /render.
      const pool = _poolHint ?? getPool();
      const actor = await extractActor(req, pool);
      const tenantId = await resolveTenantForActor(actor, resolveActorTenant);

      // Reuse the EXACT /render path: same PDP gate, RLS, limit, injection guards.
      const result = await renderFloor1({
        pool,
        tenantId,
        pageId,
        actor,
        nowMs: Date.now(),
        authzDeps: deps,
        resolveReadVisibility,
      });

      const table = flattenRenderResultToTable(result);
      const slug = `report-${pageId}`;

      if (rawFormat === "csv") {
        const body = toCsv(table);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${slug}.csv"`);
        res.end(body);
        return;
      }

      // xlsx
      const buffer = toXlsx(table, sanitizeSheetName("report"));
      res.statusCode = 200;
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", `attachment; filename="${slug}.xlsx"`);
      res.setHeader("Content-Length", String(buffer.length));
      res.end(buffer);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/report-pages/:id/data — Floor-2 RLS-gated data API
  // -------------------------------------------------------------------------
  router.register(
    "GET",
    "/api/report-pages/:id/data",
    withAuth(async (req, res, params) => {
      const pageId = params["id"] ?? "";
      if (!UUID_RE.test(pageId)) {
        throw new HttpError(400, "VALIDATION", "report_page id must be a valid UUID");
      }

      const pool = _poolHint ?? getPool();
      const actor = await extractActor(req, pool);
      const tenantId = await resolveTenantForActor(actor, resolveActorTenant);

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
        pool,
        tenantId,
        pageId,
        registryDefId,
        limit: limitVal,
        offset: offsetVal,
        actor,
        nowMs: Date.now(),
        authzDeps: deps,
        resolveReadVisibility,
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    }),
  );

  // -------------------------------------------------------------------------
  // T-0339 [E15-S3]: GET /api/process-analytics — cycle-time analytics
  //
  // Returns cycle-time GROUP BY analytics over the F2 Phase 1 transition journal:
  //   - bottleneck: the activity with the highest average duration (the bottleneck step)
  //   - rows: all activities sorted by avg_duration_ms DESC (human vs agent split)
  //   - actorBreakdown: per-(activity, actor_type) count
  //
  // Uses loadCycleTimeByActivity (self-join on audit_event) + loadActorTypeBreakdown.
  // Requires an authenticated identity; the tenant is resolved from the actor's own
  // row (T-0489), falling back to DEV_TENANT_ID when no resolver is wired.
  //
  // AC-2 (report-page-render-isolation.sh): uses the same injectable pool path.
  // -------------------------------------------------------------------------
  router.register(
    "GET",
    "/api/process-analytics",
    withAuth(async (req, res) => {
      // Auth context required (matches Floor-1 pattern — no anonymous analytics).
      const pool = _poolHint ?? getPool();
      const actor = await extractActor(req, pool); // throws 401 if missing
      const tenantId = await resolveTenantForActor(actor, resolveActorTenant);
      const nowMs = Date.now();

      // T-0739 (security P2, столп 4): ACTOR_ACTIVE entry gate — reuses the
      // SAME resolveReadVisibility resolver /render, /export, /data already
      // consult (ADR-T0739 §3.2), no new wiring. The actor must hold >=1
      // confirmed grant of ANY kind (role-reader default-open backfill,
      // migrations 117/124, guarantees every ACTIVE employee holds at least
      // this one grant — getGrantsForSubject fail-closes a DEACTIVATED
      // actor's residual JWT to grants=[]). cycleTime/actorBreakdown remain
      // tenant-wide audit_event telemetry past this gate (ADR-T0632 already
      // audited this exact route: "process telemetry, NOT choros.record...
      // no change needed" — unchanged here, only the entry gate is new).
      // Honest-degrade (NF-2): resolver absent (test-only) → gate skipped.
      if (resolveReadVisibility !== undefined) {
        const visibility = await resolveReadVisibility(actor, tenantId, nowMs);
        if (visibility.grants.length === 0) {
          throw new HttpError(403, "NO_READ_GRANT", "no confirmed grant for this tenant");
        }
      }

      // T-0495: optional drill-down by process. The process_key from the query is
      // ONLY ever passed to the loaders as a bound SQL parameter ($N) — never
      // interpolated into SQL. Empty/absent ⇒ undefined ⇒ tenant-wide analytics.
      const url = new URL(req.url ?? "/", "http://localhost");
      const rawProcessKey = url.searchParams.get("process_key");
      const processKey =
        rawProcessKey !== null && rawProcessKey !== "" ? rawProcessKey : undefined;

      const [cycleTime, actorBreakdown, processKeys] = await Promise.all([
        loadCycleTimeByActivity(pool, tenantId, processKey),
        loadActorTypeBreakdown(pool, tenantId, processKey),
        loadProcessKeys(pool, tenantId),
      ]);

      const analyticsResult: {
        bottleneck: string | null;
        cycleTime: CycleTimeAnalytics;
        actorBreakdown: ActorTypeBreakdown[];
        processKeys: string[];
        selectedProcess: string | null;
      } = {
        bottleneck: cycleTime.bottleneck,
        cycleTime,
        actorBreakdown,
        processKeys,
        selectedProcess: processKey ?? null,
      };

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(analyticsResult));
    }),
  );
}

// Re-export analytics types so callers can import from one place.
export type { CycleTimeAnalytics, ActorTypeBreakdown };
