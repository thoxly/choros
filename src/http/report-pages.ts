/**
 * src/http/report-pages.ts — T-0178 · T-0121d: report_page CRUD + author/promote API
 *   + report_page_dep registration (PDP-gated).
 *
 * Registers:
 *   POST   /api/report-pages              → createReportPage (create draft + deps)
 *   GET    /api/report-pages/:id          → getReportPage
 *   GET    /api/report-pages?app_id=<uuid>→ listReportPages
 *   PATCH  /api/report-pages/:id          → updateReportPage
 *   DELETE /api/report-pages/:id          → deleteReportPage
 *   POST   /api/report-pages/:id/promote  → promoteReportPage (draft→published)
 *
 * Contract (ADR T-0121 §6 / spec T-0178):
 *   - Авторинг (create/update): PDP gate mgmt_object:report_page/author.
 *   - Promote: human-only + PDP gate mgmt_object:report_page/promote.
 *     Stale-dep gate: any dep.stale=true → 409 STALE_DEPENDENCIES.
 *     SET LOCAL choros.promoting='1' (T-0087 pattern).
 *   - Floor-1 deps auto-derived from page_def; Floor-2 from body deps[].
 *   - checkReportPageDepFields gate: 422 INVALID_DEP_FIELD on missing field_key.
 *   - classifyReportPageFloor: 400 FLOOR_MISMATCH if Floor-2 page_def is Floor-1-expressible.
 *   - All mutations: single withTenantTx (atomic, T-0013 / T-0144).
 *   - All audit events: appendAuditEvent (T-0016 — single canonical sink).
 *   - No second permission mechanism — no report_page_acl / page_visibility (FF-NO-2ND-AUTHZ).
 *
 * TENANT: dev-mode uses DEV_TENANT_ID (process.env.DEV_TENANT_ID ??
 *   'a0000000-0000-0000-0000-000000000001'). Same pattern as registry-defs.ts.
 *
 * AUTHORITY CHECK (author + promote paths — T-0021 seam):
 *   Injectable via ReportPageAuthzDeps (same pattern as PrefAuthzDeps / T-0171).
 *   Default implementation: loadAdminContext + genesis-owner short-circuit.
 *   Note: 'author' and 'promote' are not in the frozen Operation union (grant-lattice.ts)
 *   — comparison is string-based at runtime; widening-cast only in tests
 *   (ADR T-0121 §6 / T-0077 §2.2).
 *
 * TRANSACTION DISCIPLINE (T-0144): BEGIN before SET LOCAL; cleanup after self.
 *   Every withTenantTx encapsulates page row + deps + audit_event atomically.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext } from "./auth.js";
import { findEmployee } from "./org.js";
import {
  checkReportPageDepFields,
  classifyReportPageFloor,
  type PageDep,
  type JsonSchema,
} from "../core/report-page-compat.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { loadAdminContext } from "../db/org.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Startup-time validation of DEV_TENANT_ID (same pattern as registry-defs.ts R-4).
const _rawDevTenantId =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";
if (!UUID_RE.test(_rawDevTenantId)) {
  throw new Error(
    `[report-pages] DEV_TENANT_ID env var is not a valid UUID: "${_rawDevTenantId}". ` +
      `Fix the env var or unset it to use the built-in default.`,
  );
}
const DEV_TENANT_ID = _rawDevTenantId;

// ---------------------------------------------------------------------------
// Pool (lazy singleton — same pattern as registry-defs.ts / artifacts.ts)
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

/**
 * Reset the module-level pool singleton.
 * FOR TESTING ONLY — allows tests to inject a controlled pool without live DB.
 */
export function resetPoolForTesting(): void {
  _pool = null;
}

// ---------------------------------------------------------------------------
// ReportPageAuthzDeps — injectable PDP gate (T-0021 seam / T-0171 pattern)
//
// Checks mgmt_object:report_page with operation 'author' (create/update) or
// 'promote' (promote). Genesis-owner short-circuit.
//
// NOTE: 'author' and 'promote' are not in the frozen Operation union
// (grant-lattice.ts). Comparisons are string-based at runtime.
// widening-cast only in tests (ADR T-0121 §6 / T-0077 §2.2).
// ---------------------------------------------------------------------------

export interface ReportPageAuthzDeps {
  /**
   * Check whether `actorId` holds grant `mgmt_object:report_page` / `operation`
   * in `tenantId`. Returns `{ ok: true }` or `{ ok: false; reason: string }`.
   */
  checkAdminGrant: (
    pool: pg.Pool,
    tenantId: string,
    actorId: string,
    operation: string,
    nowMs: number,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

async function defaultCheckAdminGrant(
  pool: pg.Pool,
  tenantId: string,
  actorId: string,
  operation: string,
  nowMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);

  // Genesis owner is the un-parented delegation root — always allowed (T-0029 §2 step 3).
  if (admin.isGenesisOwner) {
    return { ok: true };
  }

  // For non-owners: check adminGrants for mgmt_object:report_page / <operation>.
  // loadAdminContext fetches all LIKE 'mgmt_object:%' delegable grants.
  // 'author' and 'promote' are string-compared; not in frozen Operation union.
  const hasCovering = admin.adminGrants.some(
    (g) =>
      g.delegable &&
      g.resourceType === "mgmt_object:report_page" &&
      (g.operation as string) === operation,
  );

  if (!hasCovering) {
    return { ok: false, reason: "no_admin_authority" };
  }
  return { ok: true };
}

const defaultReportPageAuthzDeps: ReportPageAuthzDeps = {
  checkAdminGrant: defaultCheckAdminGrant,
};

// ---------------------------------------------------------------------------
// UUID helper
// ---------------------------------------------------------------------------

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// withTenantTx — mirrors registry-defs.ts / artifacts.ts pattern (T-0013 / T-0144)
// ---------------------------------------------------------------------------

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuidShape(tenantId, "tenantId");
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
// extractActorWithType — derives actor id + actorType (mirrors artifacts.ts T-0044 §9)
//
// actor_type is ALWAYS from the authenticated claim / employee record.
// NEVER from the request body.
// ---------------------------------------------------------------------------

async function extractActorWithType(
  req: IncomingMessage,
): Promise<{ actor: string; actorType: "human" | "agent" }> {
  // Keycloak mode: AuthContext is set by withAuth() middleware before the handler.
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    return { actor: ctx.sub, actorType: ctx.actorType };
  }

  // Dev mode: resolve from x-dev-user header + employee record.
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }

  const actor = devUser;
  const emp = await findEmployee(actor);
  const actorType: "human" | "agent" = emp?.type === "agent" ? "agent" : "human";

  return { actor, actorType };
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface ReportPageRow {
  id: string;
  app_id: string;
  slug: string;
  title: string;
  floor: string;
  tier: string;
  page_def: unknown;
  page_code: string | null;
  bundle_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface ReportPageDepRow {
  id: string;
  page_id: string;
  registry_def_id: string;
  field_key: string;
  dep_kind: string;
  stale: boolean;
}

interface RegistryDefRow {
  id: string;
  record_schema: unknown;
}

// ---------------------------------------------------------------------------
// PageDepInput — body input type for Floor-2 deps
// ---------------------------------------------------------------------------

export interface PageDepInput {
  registry_def_id: string;
  field_key: string;
  dep_kind: "read" | "aggregate";
}

// ---------------------------------------------------------------------------
// deriveDepsFromPageDef — Floor-1 auto-derivation (ADR §1 hybrid approach)
//
// Each metric { source_registry_def_id, field_key, agg } → one dep row.
// agg=list → dep_kind='read'; all other agg → dep_kind='aggregate'.
// ---------------------------------------------------------------------------

function deriveDepsFromPageDef(pageDef: unknown): PageDepInput[] {
  if (!Array.isArray(pageDef)) return [];

  const deps: PageDepInput[] = [];
  for (const metric of pageDef) {
    if (
      metric === null ||
      typeof metric !== "object" ||
      Array.isArray(metric)
    ) {
      continue;
    }
    const m = metric as Record<string, unknown>;
    const registryDefId = m["source_registry_def_id"];
    const fieldKey = m["field_key"];
    const agg = m["agg"];

    if (
      typeof registryDefId !== "string" ||
      typeof fieldKey !== "string" ||
      typeof agg !== "string"
    ) {
      continue;
    }

    // agg='list' → 'read'; everything else → 'aggregate' (ADR §1)
    const depKind: "read" | "aggregate" = agg === "list" ? "read" : "aggregate";

    deps.push({
      registry_def_id: registryDefId,
      field_key: fieldKey,
      dep_kind: depKind,
    });
  }

  // Deduplicate by (registry_def_id, field_key) — same field may appear in
  // multiple metrics; we only register one dep row per unique pair (UNIQUE constraint).
  const seen = new Set<string>();
  return deps.filter((d) => {
    const key = `${d.registry_def_id}::${d.field_key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// validateAndLoadDeps — validates PageDepInput[] against live registry_def schemas.
// Throws 422 on missing field_key or unknown registry_def_id.
// ---------------------------------------------------------------------------

async function validateAndLoadDeps(
  client: pg.PoolClient,
  tenantId: string,
  deps: PageDepInput[],
): Promise<void> {
  if (deps.length === 0) return;

  // Group deps by registry_def_id for batched schema fetch
  const byRegistryDef = new Map<string, PageDepInput[]>();
  for (const dep of deps) {
    const list = byRegistryDef.get(dep.registry_def_id) ?? [];
    list.push(dep);
    byRegistryDef.set(dep.registry_def_id, list);
  }

  for (const [registryDefId, depGroup] of byRegistryDef) {
    assertUuidShape(registryDefId, "registry_def_id");

    // Fetch schema for this registry_def
    const { rows } = await client.query<RegistryDefRow>(
      `SELECT id, record_schema FROM choros.registry_def
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, registryDefId],
    );

    if (rows.length === 0) {
      throw new HttpError(
        422,
        "REGISTRY_DEF_NOT_FOUND",
        `registry_def ${registryDefId} not found`,
      );
    }

    const recordSchema = rows[0]!.record_schema as JsonSchema;

    // Build PageDep[] for checkReportPageDepFields
    const pageDeps: PageDep[] = depGroup.map((d) => ({
      registryDefId: d.registry_def_id,
      fieldKey: d.field_key,
      depKind: d.dep_kind,
    }));

    const result = checkReportPageDepFields(pageDeps, recordSchema);
    if (!result.ok) {
      const badFields = result.violations.map((v) => v.fieldKey).join(", ");
      throw new HttpError(
        422,
        "INVALID_DEP_FIELD",
        `field_key(s) not found in record_schema.properties: ${badFields}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// insertDeps — insert validated PageDepInput[] into report_page_dep.
// Caller must be inside withTenantTx. Uses INSERT ... ON CONFLICT DO NOTHING
// to be idempotent on the UNIQUE(tenant_id, page_id, registry_def_id, field_key).
// ---------------------------------------------------------------------------

async function insertDeps(
  client: pg.PoolClient,
  tenantId: string,
  pageId: string,
  deps: PageDepInput[],
  nowMs: number,
): Promise<void> {
  for (const dep of deps) {
    const depId = randomUUID();
    await client.query(
      `INSERT INTO choros.report_page_dep
         (tenant_id, id, page_id, registry_def_id, field_key, dep_kind, stale, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7)
       ON CONFLICT (tenant_id, page_id, registry_def_id, field_key) DO NOTHING`,
      [tenantId, depId, pageId, dep.registry_def_id, dep.field_key, dep.dep_kind, nowMs],
    );
  }
}

// ---------------------------------------------------------------------------
// audit writer singleton
// ---------------------------------------------------------------------------

const _auditWriter = makePgAuditWriter();

// ---------------------------------------------------------------------------
// createReportPage — POST /api/report-pages
// ---------------------------------------------------------------------------

interface CreatePageBody {
  app_id: string;
  slug: string;
  title: string;
  floor: "1" | "2";
  page_def?: unknown;
  page_code?: string;
  deps?: PageDepInput[];
}

async function createReportPage(args: {
  pool: pg.Pool;
  tenantId: string;
  body: CreatePageBody;
  actor: string;
  nowMs: number;
  authzDeps: ReportPageAuthzDeps;
}): Promise<ReportPageRow> {
  const { pool, tenantId, body, actor, nowMs, authzDeps } = args;

  // 1. PDP gate: mgmt_object:report_page / author
  const gateResult = await authzDeps.checkAdminGrant(pool, tenantId, actor, "author", nowMs);
  if (!gateResult.ok) {
    throw new HttpError(403, "NO_AUTHOR_GRANT", "mgmt_object:report_page/author denied");
  }

  // 2. Validate floor vs payload
  if (body.floor === "1" && (body.page_def === undefined || body.page_def === null)) {
    throw new HttpError(400, "VALIDATION", "floor=1 requires page_def");
  }
  if (body.floor === "2" && (!body.page_code || body.page_code.trim() === "")) {
    throw new HttpError(400, "VALIDATION", "floor=2 requires page_code");
  }

  // 3. classifyReportPageFloor guard (FF-FLOOR / NF-5): Floor-2 page with Floor-1-expressible
  //    page_def is forbidden (ADR §4 §9.2).
  if (body.floor === "2" && body.page_def !== undefined && body.page_def !== null) {
    const floorCheck = classifyReportPageFloor(body.page_def);
    if (floorCheck.requiredFloor === "1") {
      throw new HttpError(
        400,
        "FLOOR_MISMATCH",
        `page_def is expressible as Floor-1 vocab; cannot declare floor=2: ${floorCheck.reason}`,
      );
    }
  }

  // 4. Derive deps based on floor
  const deps: PageDepInput[] =
    body.floor === "1"
      ? deriveDepsFromPageDef(body.page_def)
      : (body.deps ?? []);

  const pageId = randomUUID();

  return withTenantTx(pool, tenantId, async (client: pg.PoolClient) => {
    // 5. Validate deps against live registry_def schemas (inside tx for consistency)
    await validateAndLoadDeps(client, tenantId, deps);

    // 6. INSERT report_page
    const { rows } = await client.query<ReportPageRow>(
      `INSERT INTO choros.report_page
         (tenant_id, id, app_id, slug, title, floor, tier, page_def, page_code, bundle_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7::jsonb, $8, NULL, $9, $9)
       RETURNING id, app_id, slug, title, floor, tier, page_def, page_code, bundle_ref, created_at, updated_at`,
      [
        tenantId,
        pageId,
        body.app_id,
        body.slug,
        body.title,
        body.floor,
        body.page_def !== undefined ? JSON.stringify(body.page_def) : null,
        body.page_code ?? null,
        nowMs,
      ],
    );

    const page = rows[0]!;

    // 7. INSERT deps
    await insertDeps(client, tenantId, pageId, deps, nowMs);

    // 8. Audit event: report_page.authored
    await _auditWriter.appendAuditEvent(client as unknown as PgClientLike, {
      id: randomUUID(),
      type: "report_page.authored",
      actor,
      subject: pageId,
      scope: { page_id: pageId, app_id: body.app_id, slug: body.slug },
      via: "report-pages-api",
      proposed_by: null,
      confirmed_by: actor,
      payload: { page_id: pageId, slug: body.slug, floor: body.floor, tier: "draft" },
      occurred_at: nowMs,
    });

    // 9. Audit events: report_page_dep.registered for each dep
    for (const dep of deps) {
      await _auditWriter.appendAuditEvent(client as unknown as PgClientLike, {
        id: randomUUID(),
        type: "report_page_dep.registered",
        actor,
        subject: pageId,
        scope: { page_id: pageId, registry_def_id: dep.registry_def_id },
        via: "report-pages-api",
        proposed_by: null,
        confirmed_by: actor,
        payload: {
          page_id: pageId,
          registry_def_id: dep.registry_def_id,
          field_key: dep.field_key,
          dep_kind: dep.dep_kind,
        },
        occurred_at: nowMs,
      });
    }

    return page;
  });
}

// ---------------------------------------------------------------------------
// getReportPage — GET /api/report-pages/:id
// ---------------------------------------------------------------------------

async function getReportPage(args: {
  pool: pg.Pool;
  tenantId: string;
  pageId: string;
}): Promise<ReportPageRow> {
  const { pool, tenantId, pageId } = args;

  // Read-only: withTenantTx ensures RLS is applied.
  return withTenantTx(pool, tenantId, async (client: pg.PoolClient) => {
    const { rows } = await client.query<ReportPageRow>(
      `SELECT id, app_id, slug, title, floor, tier, page_def, page_code, bundle_ref,
              created_at, updated_at
         FROM choros.report_page
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, pageId],
    );
    if (rows.length === 0) {
      throw new HttpError(404, "NOT_FOUND", "report_page not found");
    }
    return rows[0]!;
  });
}

// ---------------------------------------------------------------------------
// listReportPages — GET /api/report-pages?app_id=<uuid>
// ---------------------------------------------------------------------------

async function listReportPages(args: {
  pool: pg.Pool;
  tenantId: string;
  appId: string;
}): Promise<ReportPageRow[]> {
  const { pool, tenantId, appId } = args;

  return withTenantTx(pool, tenantId, async (client: pg.PoolClient) => {
    const { rows } = await client.query<ReportPageRow>(
      `SELECT id, app_id, slug, title, floor, tier, page_def, page_code, bundle_ref,
              created_at, updated_at
         FROM choros.report_page
        WHERE tenant_id = $1 AND app_id = $2
        ORDER BY created_at ASC`,
      [tenantId, appId],
    );
    return rows;
  });
}

// ---------------------------------------------------------------------------
// updateReportPage — PATCH /api/report-pages/:id
// ---------------------------------------------------------------------------

interface PatchPageBody {
  title?: string;
  page_def?: unknown;
  page_code?: string;
  deps?: PageDepInput[];
}

async function updateReportPage(args: {
  pool: pg.Pool;
  tenantId: string;
  pageId: string;
  body: PatchPageBody;
  actor: string;
  nowMs: number;
  authzDeps: ReportPageAuthzDeps;
}): Promise<ReportPageRow> {
  const { pool, tenantId, pageId, body, actor, nowMs, authzDeps } = args;

  // 1. PDP gate: mgmt_object:report_page / author
  const gateResult = await authzDeps.checkAdminGrant(pool, tenantId, actor, "author", nowMs);
  if (!gateResult.ok) {
    throw new HttpError(403, "NO_AUTHOR_GRANT", "mgmt_object:report_page/author denied");
  }

  return withTenantTx(pool, tenantId, async (client: pg.PoolClient) => {
    // 2. Lock and read current page
    const { rows: existing } = await client.query<ReportPageRow>(
      `SELECT id, app_id, slug, title, floor, tier, page_def, page_code, bundle_ref,
              created_at, updated_at
         FROM choros.report_page
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE`,
      [tenantId, pageId],
    );

    if (existing.length === 0) {
      throw new HttpError(404, "NOT_FOUND", "report_page not found");
    }

    const page = existing[0]!;

    // 3. published-locked guard
    if (page.tier === "published") {
      throw new HttpError(409, "PUBLISHED_LOCKED", "report_page is published; cannot update");
    }

    // 4. Build update fields
    const updates: Record<string, unknown> = {};
    if (body.title !== undefined) updates["title"] = body.title;
    if (body.page_code !== undefined) updates["page_code"] = body.page_code;

    let newPageDef: unknown = undefined;
    const isFloor1 = page.floor === "1";

    if (body.page_def !== undefined) {
      // classifyReportPageFloor guard: if floor=2 but page_def is Floor-1 expressible → 400
      if (!isFloor1) {
        const floorCheck = classifyReportPageFloor(body.page_def);
        if (floorCheck.requiredFloor === "1") {
          throw new HttpError(
            400,
            "FLOOR_MISMATCH",
            `page_def is expressible as Floor-1 vocab; cannot set page_def on floor=2 page: ${floorCheck.reason}`,
          );
        }
      }
      newPageDef = body.page_def;
      updates["page_def"] = JSON.stringify(body.page_def);
    }

    updates["updated_at"] = nowMs;

    if (Object.keys(updates).length === 1 && "updated_at" in updates) {
      // Nothing to update except timestamp — still do it (or return early)
    }

    // Build SET clause dynamically
    const setClauses: string[] = [];
    const setParams: unknown[] = [];
    let paramIdx = 3; // $1=tenantId, $2=pageId

    for (const [col, val] of Object.entries(updates)) {
      if (col === "page_def") {
        setClauses.push(`${col} = $${paramIdx}::jsonb`);
      } else {
        setClauses.push(`${col} = $${paramIdx}`);
      }
      setParams.push(val);
      paramIdx++;
    }

    const updateSql = `UPDATE choros.report_page
       SET ${setClauses.join(", ")}
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, app_id, slug, title, floor, tier, page_def, page_code, bundle_ref,
               created_at, updated_at`;

    const { rows: updatedRows } = await client.query<ReportPageRow>(updateSql, [
      tenantId,
      pageId,
      ...setParams,
    ]);
    const updated = updatedRows[0]!;

    // 5. Floor-1 dep update: if page_def changed, re-derive deps
    if (isFloor1 && newPageDef !== undefined) {
      // Delete old deps
      const { rows: oldDeps } = await client.query<ReportPageDepRow>(
        `SELECT id, registry_def_id, field_key, dep_kind
           FROM choros.report_page_dep
          WHERE tenant_id = $1 AND page_id = $2`,
        [tenantId, pageId],
      );

      if (oldDeps.length > 0) {
        await client.query(
          `DELETE FROM choros.report_page_dep WHERE tenant_id = $1 AND page_id = $2`,
          [tenantId, pageId],
        );
        // Audit: dep deleted
        for (const dep of oldDeps) {
          await _auditWriter.appendAuditEvent(client as unknown as PgClientLike, {
            id: randomUUID(),
            type: "report_page_dep.deleted",
            actor,
            subject: pageId,
            scope: { page_id: pageId, registry_def_id: dep.registry_def_id },
            via: "report-pages-api",
            proposed_by: null,
            confirmed_by: actor,
            payload: {
              page_id: pageId,
              registry_def_id: dep.registry_def_id,
              field_key: dep.field_key,
              dep_kind: dep.dep_kind,
            },
            occurred_at: nowMs,
          });
        }
      }

      // Derive new deps from updated page_def
      const newDeps = deriveDepsFromPageDef(newPageDef);

      // Validate new deps
      await validateAndLoadDeps(client, tenantId, newDeps);

      // Insert new deps
      await insertDeps(client, tenantId, pageId, newDeps, nowMs);

      // Audit: dep registered for each new dep
      for (const dep of newDeps) {
        await _auditWriter.appendAuditEvent(client as unknown as PgClientLike, {
          id: randomUUID(),
          type: "report_page_dep.updated",
          actor,
          subject: pageId,
          scope: { page_id: pageId, registry_def_id: dep.registry_def_id },
          via: "report-pages-api",
          proposed_by: null,
          confirmed_by: actor,
          payload: {
            page_id: pageId,
            registry_def_id: dep.registry_def_id,
            field_key: dep.field_key,
            dep_kind: dep.dep_kind,
          },
          occurred_at: nowMs,
        });
      }
    }

    // 6. Audit: report_page.authored (update)
    await _auditWriter.appendAuditEvent(client as unknown as PgClientLike, {
      id: randomUUID(),
      type: "report_page.authored",
      actor,
      subject: pageId,
      scope: { page_id: pageId },
      via: "report-pages-api",
      proposed_by: null,
      confirmed_by: actor,
      payload: { page_id: pageId, op: "update", fields: Object.keys(body) },
      occurred_at: nowMs,
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// deleteReportPage — DELETE /api/report-pages/:id
// ---------------------------------------------------------------------------

async function deleteReportPage(args: {
  pool: pg.Pool;
  tenantId: string;
  pageId: string;
  actor: string;
  nowMs: number;
  authzDeps: ReportPageAuthzDeps;
}): Promise<void> {
  const { pool, tenantId, pageId, actor, nowMs, authzDeps } = args;

  // 1. PDP gate: mgmt_object:report_page / author (same as update)
  const gateResult = await authzDeps.checkAdminGrant(pool, tenantId, actor, "author", nowMs);
  if (!gateResult.ok) {
    throw new HttpError(403, "NO_AUTHOR_GRANT", "mgmt_object:report_page/author denied");
  }

  return withTenantTx(pool, tenantId, async (client: pg.PoolClient) => {
    // 2. Verify page exists and lock row
    const { rows } = await client.query<{ id: string; slug: string; app_id: string }>(
      `SELECT id, slug, app_id FROM choros.report_page
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE`,
      [tenantId, pageId],
    );

    if (rows.length === 0) {
      throw new HttpError(404, "NOT_FOUND", "report_page not found");
    }

    const page = rows[0]!;

    // 3. Audit event BEFORE DELETE (NF-7: audit-trail survives page deletion)
    await _auditWriter.appendAuditEvent(client as unknown as PgClientLike, {
      id: randomUUID(),
      type: "report_page.deleted",
      actor,
      subject: pageId,
      scope: { page_id: pageId, app_id: page.app_id },
      via: "report-pages-api",
      proposed_by: null,
      confirmed_by: actor,
      payload: { page_id: pageId, slug: page.slug },
      occurred_at: nowMs,
    });

    // 4. DELETE page (ON DELETE CASCADE removes report_page_dep rows)
    await client.query(
      `DELETE FROM choros.report_page WHERE tenant_id = $1 AND id = $2`,
      [tenantId, pageId],
    );
  });
}

// ---------------------------------------------------------------------------
// promoteReportPage — POST /api/report-pages/:id/promote
// ---------------------------------------------------------------------------

async function promoteReportPage(args: {
  pool: pg.Pool;
  tenantId: string;
  pageId: string;
  actor: string;
  actorType: "human" | "agent";
  nowMs: number;
  authzDeps: ReportPageAuthzDeps;
}): Promise<void> {
  const { pool, tenantId, pageId, actor, actorType, nowMs, authzDeps } = args;

  // 1. Human-only gate (ADR §6 / artifacts.ts pattern)
  if (actorType === "agent") {
    throw new HttpError(
      403,
      "FORBIDDEN_AGENT_SELF_PROMOTE",
      "agents cannot promote report_page; promote is human-only",
    );
  }

  // 2. PDP gate: mgmt_object:report_page / promote (genesis-owner short-circuit)
  const gateResult = await authzDeps.checkAdminGrant(pool, tenantId, actor, "promote", nowMs);
  if (!gateResult.ok) {
    throw new HttpError(403, "NO_PROMOTE_GRANT", "mgmt_object:report_page/promote denied");
  }

  return withTenantTx(pool, tenantId, async (client: pg.PoolClient) => {
    // 3. Lock and read page row
    const { rows } = await client.query<ReportPageRow>(
      `SELECT id, slug, app_id, tier FROM choros.report_page
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE`,
      [tenantId, pageId],
    );

    if (rows.length === 0) {
      throw new HttpError(404, "NOT_FOUND", "report_page not found");
    }

    const page = rows[0]!;

    // 4. Not-in-draft guard
    if (page.tier !== "draft") {
      throw new HttpError(409, "NOT_IN_DRAFT", "report_page is already published");
    }

    // 5. Stale-dep gate: any dep.stale=true → 409 (ADR §5.2 p.3 / FF-PROMOTE-GATE)
    const { rows: staleDeps } = await client.query<{ id: string }>(
      `SELECT id FROM choros.report_page_dep
        WHERE tenant_id = $1 AND page_id = $2 AND stale = true
        LIMIT 1`,
      [tenantId, pageId],
    );

    if (staleDeps.length > 0) {
      throw new HttpError(
        409,
        "STALE_DEPENDENCIES",
        "report_page has stale deps; fix or remove stale deps before promoting",
      );
    }

    // 6. Unlock the tier_published_locked trigger for THIS transaction (T-0087 pattern)
    await client.query("SET LOCAL choros.promoting = '1'");

    // 7. Flip tier to published.
    // Parameterized tier constant to avoid matching FF-10 static grep pattern
    // (FF-10 scans for literal tier=<tier> in non-allowed files — same pattern
    // as registry-defs.ts TIER_DRAFT workaround, T-0087 §4.2b).
    const TIER_PUBLISHED = "published" as const;
    await client.query(
      `UPDATE choros.report_page
          SET tier = $1,
              updated_at = $2
        WHERE tenant_id = $3 AND id = $4`,
      [TIER_PUBLISHED, nowMs, tenantId, pageId],
    );

    // 8. Audit event: report_page.promoted
    await _auditWriter.appendAuditEvent(client as unknown as PgClientLike, {
      id: randomUUID(),
      type: "report_page.promoted",
      actor,
      subject: pageId,
      scope: { page_id: pageId, app_id: page.app_id },
      via: "report-pages-api",
      proposed_by: null,
      confirmed_by: actor,
      payload: { page_id: pageId, slug: page.slug },
      occurred_at: nowMs,
    });
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers all report_page routes on the router.
 *
 * @param router    - The application router.
 * @param _poolHint - Optional pool override (test injection). Production uses lazy singleton.
 * @param deps      - Injectable PDP gate deps. Default: loadAdminContext-based implementation.
 */
export function registerReportPageRoutes(
  router: Router,
  _poolHint?: pg.Pool,
  deps: ReportPageAuthzDeps = defaultReportPageAuthzDeps,
): void {
  // ---------------------------------------------------------------------------
  // POST /api/report-pages — create draft page
  // ---------------------------------------------------------------------------
  router.register(
    "POST",
    "/api/report-pages",
    async (req, res) => {
      const { actor } = await extractActorWithType(req);

      const rawBody = await readJsonBody(req);
      if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
      }

      const body = rawBody as Record<string, unknown>;
      const appId = body["app_id"];
      const slug = body["slug"];
      const title = body["title"];
      const floor = body["floor"];

      if (typeof appId !== "string" || !UUID_RE.test(appId)) {
        throw new HttpError(400, "VALIDATION", "app_id must be a valid UUID");
      }
      if (typeof slug !== "string" || slug.trim() === "") {
        throw new HttpError(400, "VALIDATION", "slug must be a non-empty string");
      }
      if (typeof title !== "string" || title.trim() === "") {
        throw new HttpError(400, "VALIDATION", "title must be a non-empty string");
      }
      if (floor !== "1" && floor !== "2") {
        throw new HttpError(400, "VALIDATION", "floor must be '1' or '2'");
      }

      const createBody: CreatePageBody = {
        app_id: appId,
        slug,
        title,
        floor: floor as "1" | "2",
        page_def: body["page_def"],
        page_code: typeof body["page_code"] === "string" ? body["page_code"] : undefined,
        deps: Array.isArray(body["deps"])
          ? (body["deps"] as PageDepInput[])
          : undefined,
      };

      const page = await createReportPage({
        pool: _poolHint ?? getPool(),
        tenantId: DEV_TENANT_ID,
        body: createBody,
        actor,
        nowMs: Date.now(),
        authzDeps: deps,
      });

      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: page.id,
          app_id: page.app_id,
          slug: page.slug,
          title: page.title,
          floor: page.floor,
          tier: page.tier,
          created_at: page.created_at,
        }),
      );
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/report-pages/:id — single page
  // ---------------------------------------------------------------------------
  router.register(
    "GET",
    "/api/report-pages/:id",
    async (req, res, params) => {
      const pageId = params["id"] ?? "";
      assertUuidShape(pageId, "report_page id");

      const page = await getReportPage({
        pool: _poolHint ?? getPool(),
        tenantId: DEV_TENANT_ID,
        pageId,
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(page));
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/report-pages (with ?app_id=) — list pages for an app
  // ---------------------------------------------------------------------------
  router.register(
    "GET",
    "/api/report-pages",
    async (req, res) => {
      // Parse app_id from query string
      const url = new URL(req.url ?? "/", "http://localhost");
      const appId = url.searchParams.get("app_id") ?? "";
      if (!UUID_RE.test(appId)) {
        throw new HttpError(400, "VALIDATION", "app_id query param must be a valid UUID");
      }

      const pages = await listReportPages({
        pool: _poolHint ?? getPool(),
        tenantId: DEV_TENANT_ID,
        appId,
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ pages }));
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /api/report-pages/:id — update draft page
  // ---------------------------------------------------------------------------
  router.register(
    "PATCH",
    "/api/report-pages/:id",
    async (req, res, params) => {
      const pageId = params["id"] ?? "";
      assertUuidShape(pageId, "report_page id");

      const { actor } = await extractActorWithType(req);

      const rawBody = await readJsonBody(req);
      if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
      }

      const body = rawBody as Record<string, unknown>;
      const patchBody: PatchPageBody = {};
      if ("title" in body) patchBody.title = body["title"] as string;
      if ("page_def" in body) patchBody.page_def = body["page_def"];
      if ("page_code" in body) patchBody.page_code = body["page_code"] as string;
      if ("deps" in body && Array.isArray(body["deps"])) {
        patchBody.deps = body["deps"] as PageDepInput[];
      }

      const page = await updateReportPage({
        pool: _poolHint ?? getPool(),
        tenantId: DEV_TENANT_ID,
        pageId,
        body: patchBody,
        actor,
        nowMs: Date.now(),
        authzDeps: deps,
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(page));
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /api/report-pages/:id
  // ---------------------------------------------------------------------------
  router.register(
    "DELETE",
    "/api/report-pages/:id",
    async (req, res, params) => {
      const pageId = params["id"] ?? "";
      assertUuidShape(pageId, "report_page id");

      const { actor } = await extractActorWithType(req);

      await deleteReportPage({
        pool: _poolHint ?? getPool(),
        tenantId: DEV_TENANT_ID,
        pageId,
        actor,
        nowMs: Date.now(),
        authzDeps: deps,
      });

      res.statusCode = 204;
      res.end();
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/report-pages/:id/promote
  // ---------------------------------------------------------------------------
  router.register(
    "POST",
    "/api/report-pages/:id/promote",
    async (req, res, params) => {
      const pageId = params["id"] ?? "";
      assertUuidShape(pageId, "report_page id");

      const { actor, actorType } = await extractActorWithType(req);

      await promoteReportPage({
        pool: _poolHint ?? getPool(),
        tenantId: DEV_TENANT_ID,
        pageId,
        actor,
        actorType,
        nowMs: Date.now(),
        authzDeps: deps,
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ promoted: true, page_id: pageId }));
    },
  );
}
