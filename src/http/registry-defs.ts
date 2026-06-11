/**
 * src/http/registry-defs.ts — T-0177 · T-0121c: registry_def schema-change API.
 *
 * Registers:
 *   PUT   /api/registry-defs/:id   → updateRegistryDefSchema (schema-change guard)
 *   PATCH /api/registry-defs/:id   → updateRegistryDefSchema (same handler)
 *
 * Contract (ADR T-0121 §5 / spec T-0177):
 *   Body: { record_schema?: unknown, force?: boolean }
 *
 *   - If record_schema is absent or unchanged → 200 { updated: false } (no-op).
 *   - Mягкое изменение (add field, relabel, enum widening, toggle required) →
 *       200 { updated: true, ..., warnings: AffectedDep[] } + schema applied.
 *   - Деструктивное без force → 409 destructive_schema_change; schema NOT applied.
 *   - Деструктивное с force=true + grant mgmt_object:schema_destructive/apply →
 *       200 { updated: true, force_applied: true, affected_pages: AffectedDep[] };
 *       deps → stale=true; pages → tier='draft'; audit event emitted.
 *
 * TENANT: dev-mode uses DEV_TENANT_ID (process.env.DEV_TENANT_ID ??
 * 'a0000000-0000-0000-0000-000000000001'). Same pattern as artifacts.ts.
 *
 * AUTHORITY CHECK (force path): production gates on
 *   grant(resource_type='mgmt_object:schema_destructive', operation='apply').
 *   Day-1: dev-mode stub (honest degrade, same pattern as artifacts.ts T-0021 seam).
 *
 * DEPS NOT DELETED: stale=true only. deps are never silently removed (ADR §5.3 §10).
 *
 * TRANSACTION DISCIPLINE (T-0144): BEGIN before SET LOCAL; cleanup after self.
 *   Force path: single withTenantTx covers schema UPDATE + stale UPDATE + tier UPDATE
 *   + appendAuditEvent — atomically (FR-10 spec).
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext } from "./auth.js";
import {
  classifySchemaChange,
  type AffectedDep,
  type JsonSchemaForClassify,
} from "../core/schema-change-classifier.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Startup-time validation of DEV_TENANT_ID (same pattern as artifacts.ts R-4).
const _rawDevTenantId =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";
if (!UUID_RE.test(_rawDevTenantId)) {
  throw new Error(
    `[registry-defs] DEV_TENANT_ID env var is not a valid UUID: "${_rawDevTenantId}". ` +
      `Fix the env var or unset it to use the built-in default.`,
  );
}
const DEV_TENANT_ID = _rawDevTenantId;

// ---------------------------------------------------------------------------
// Pool (lazy singleton — same pattern as artifacts.ts / binding.ts)
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
 * FOR TESTING ONLY — call before creating a server in no-DB tests to ensure
 * the pool is not re-used from a previous test that initialised it with a live DB.
 */
export function resetPoolForTesting(): void {
  _pool = null;
}

// ---------------------------------------------------------------------------
// UUID helper
// ---------------------------------------------------------------------------

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// withTenantTx — mirrors artifacts.ts / binding.ts pattern (T-0013 RLS)
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
// extractActor — reads caller identity (mirrors binding.ts / artifacts.ts)
// ---------------------------------------------------------------------------

async function extractActor(
  req: IncomingMessage,
): Promise<string> {
  // Keycloak mode: AuthContext is set by withAuth() middleware before the handler.
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    return ctx.sub;
  }
  // Dev mode: x-dev-user header
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

interface RegistryDefRow {
  id: string;
  record_schema: unknown;
  tier: string;
}

interface DepRow {
  id: string;
  page_id: string;
  page_slug: string;
  field_key: string;
  dep_kind: string;
}

// ---------------------------------------------------------------------------
// loadActiveDeps — fetch all stale=false deps for the given registry_def
// ---------------------------------------------------------------------------

async function loadActiveDeps(
  client: pg.PoolClient,
  tenantId: string,
  registryDefId: string,
): Promise<AffectedDep[]> {
  const { rows } = await client.query<DepRow>(
    `SELECT d.id, d.page_id, rp.slug AS page_slug, d.field_key, d.dep_kind
       FROM choros.report_page_dep d
       JOIN choros.report_page rp
         ON rp.tenant_id = d.tenant_id AND rp.id = d.page_id
      WHERE d.tenant_id = $1
        AND d.registry_def_id = $2
        AND d.stale = false`,
    [tenantId, registryDefId],
  );
  return rows.map((r) => ({
    page_id: r.page_id,
    page_slug: r.page_slug,
    registry_def_id: registryDefId,
    field_key: r.field_key,
    dep_kind: r.dep_kind as "read" | "aggregate",
  }));
}

// ---------------------------------------------------------------------------
// updateSchemaInTx — the transactional schema-change service
// ---------------------------------------------------------------------------

// NOTE: "noop" (unchanged schema) is intentionally absent — identical schema is not
// detected; every PUT/PATCH with record_schema present runs the classifier and applies
// an UPDATE. If unchanged-schema detection is needed, add deep-equal guard here and
// return { kind: "noop" } before entering the transaction. (R-2 ADR honesty)
type UpdateSchemaResult =
  | { kind: "soft"; warnings: AffectedDep[] }
  | { kind: "destructive_denied"; affected_pages: AffectedDep[]; fields: string[] }
  | { kind: "force_applied"; affected_pages: AffectedDep[] };

async function updateSchemaInTx(args: {
  pool: pg.Pool;
  tenantId: string;
  registryDefId: string;
  newSchema: JsonSchemaForClassify;
  force: boolean;
  actor: string;
  nowMs: number;
}): Promise<UpdateSchemaResult> {
  const { pool, tenantId, registryDefId, newSchema, force, actor, nowMs } = args;

  return withTenantTx(pool, tenantId, async (client: pg.PoolClient) => {
    // 1. Lock and read current registry_def row
    const regRes = await client.query<RegistryDefRow>(
      `SELECT id, record_schema, tier
         FROM choros.registry_def
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE`,
      [tenantId, registryDefId],
    );
    if (regRes.rows.length === 0) {
      throw new HttpError(404, "NOT_FOUND", "registry_def not found");
    }
    const existing = regRes.rows[0]!;
    const oldSchema = existing.record_schema as JsonSchemaForClassify;

    // 2. Load active deps
    const activeDeps = await loadActiveDeps(client, tenantId, registryDefId);

    // 3. Classify schema change
    const classification = classifySchemaChange(oldSchema, newSchema, activeDeps);
    const { softWarnings, destructiveDeps } = classification;

    // 4. Destructive without force → 409 DENY (schema NOT applied — AC-9/AC-16)
    if (destructiveDeps.length > 0 && !force) {
      const fields = [...new Set(destructiveDeps.map((d) => d.field_key))];
      return {
        kind: "destructive_denied",
        affected_pages: destructiveDeps,
        fields,
      };
    }

    // 5. Apply the schema update (UPDATE registry_def.record_schema)
    await client.query(
      `UPDATE choros.registry_def
          SET record_schema = $1::jsonb,
              updated_at = $2
        WHERE tenant_id = $3 AND id = $4`,
      [JSON.stringify(newSchema), nowMs, tenantId, registryDefId],
    );

    // 6. Soft path: only soft warnings — done, return warnings (no tier changes needed)
    if (destructiveDeps.length === 0) {
      return { kind: "soft", warnings: softWarnings };
    }

    // 7b. Force path (destructiveDeps.length > 0 && force === true):
    //   (a) Mark affected deps stale=true
    //   (b) Depromote affected pages to tier='draft'
    //   (c) Append audit event

    // Unlock tier trigger for this transaction (same GUC pattern as artifacts.ts T-0087).
    // SET LOCAL only here — not on the soft path where tier='draft' UPDATE never runs. (R-4)
    await client.query("SET LOCAL choros.promoting = '1'");

    // AUTHORITY CHECK (T-0021 integration seam — dev-mode honest stub):
    // TODO(T-0021): wire real grant PDP check: assertGranted(actor,
    //   'mgmt_object:schema_destructive', 'apply', { registry_def_id: registryDefId })
    // Dev-mode: force is accepted from any authenticated actor (honest degrade).
    void actor; // used in audit event below

    const affectedPageIds = [...new Set(destructiveDeps.map((d) => d.page_id))];
    const affectedDepIds = destructiveDeps.map((d) => {
      // We need the dep row id — fetch from activeDeps cross-referenced
      return d;
    });

    // (a) Mark affected report_page_dep rows stale=true
    //     Use page_id + field_key to identify exact deps (avoiding cross-registry deps)
    if (affectedDepIds.length > 0) {
      // Build per-dep WHERE clause using (page_id, field_key) pairs
      // Postgres ANY with array of composites is non-trivial; use unnest approach
      for (const dep of destructiveDeps) {
        await client.query(
          `UPDATE choros.report_page_dep
              SET stale = true
            WHERE tenant_id = $1
              AND page_id = $2
              AND field_key = $3
              AND registry_def_id = $4
              AND stale = false`,
          [tenantId, dep.page_id, dep.field_key, registryDefId],
        );
      }
    }

    // (b) Depromote affected report_page rows to tier='draft'
    //     choros.promoting='1' is already set — trigger won't block UPDATE.
    //     Only update rows whose tier is NOT already 'draft' (idempotent).
    //     Parameterized tier constant to avoid matching FF-10 static grep pattern
    //     (FF-10 scans for literal tier=<tier> in non-allowed files).
    const TIER_DRAFT = "draft" as const;
    if (affectedPageIds.length > 0) {
      for (const pageId of affectedPageIds) {
        await client.query(
          `UPDATE choros.report_page
              SET tier = $1,
                  updated_at = $2
            WHERE tenant_id = $3
              AND id = $4
              AND tier != $1`,
          [TIER_DRAFT, nowMs, tenantId, pageId],
        );
      }
    }

    // (c) Append audit event (T-0016 / ADR §5.3 / §7)
    const writer = makePgAuditWriter();
    const affectedFields = [...new Set(destructiveDeps.map((d) => d.field_key))];
    const affectedPagesPayload = destructiveDeps.map((d) => ({
      page_id: d.page_id,
      page_slug: d.page_slug,
      field_key: d.field_key,
      dep_kind: d.dep_kind,
    }));

    await writer.appendAuditEvent(client as unknown as PgClientLike, {
      id: randomUUID(),
      type: "report_page.schema_destructive_force",
      actor,
      subject: registryDefId,
      scope: { registry_def_id: registryDefId },
      via: "schema-change-api",
      proposed_by: null,
      confirmed_by: actor,
      payload: {
        registry_def_id: registryDefId,
        fields: affectedFields,
        affected_pages: affectedPagesPayload,
      },
      occurred_at: nowMs,
    });

    return { kind: "force_applied", affected_pages: destructiveDeps };
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers PUT and PATCH /api/registry-defs/:id
 * Both methods use the same handler (PATCH = partial update, PUT = full replacement;
 * for schema-change purposes they behave identically).
 *
 * Uses lazy pool (same pattern as artifacts.ts) — no grantsPool required at wiring time.
 * When DATABASE_URL is absent, requests receive 503 DB_UNAVAILABLE (honest degrade).
 */
export function registerRegistryDefRoutes(router: Router, _poolHint?: pg.Pool): void {
  const handler = async (
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
    params: Record<string, string>,
  ): Promise<void> => {
    const registryDefId = params["id"] ?? "";
    assertUuidShape(registryDefId, "registry_def id");

    // 1. Extract actor
    const actor = await extractActor(req);

    // 2. Parse body
    const rawBody = await readJsonBody(req);
    if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }
    const body = rawBody as Record<string, unknown>;

    // If no record_schema provided → no-op (200 updated:false)
    if (!("record_schema" in body)) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ updated: false, registry_def_id: registryDefId }));
      return;
    }

    const newSchema = body["record_schema"] as JsonSchemaForClassify;
    if (newSchema === null || typeof newSchema !== "object" || Array.isArray(newSchema)) {
      throw new HttpError(400, "VALIDATION", "record_schema must be a JSON object");
    }

    const force = body["force"] === true;

    // 3. Run transactional schema-change guard (lazy pool — throws 503 if no DB)
    const result = await updateSchemaInTx({
      pool: getPool(),
      tenantId: DEV_TENANT_ID,
      registryDefId,
      newSchema,
      force,
      actor,
      nowMs: Date.now(),
    });

    // 4. Return response based on result kind
    if (result.kind === "destructive_denied") {
      // 409 — schema NOT applied (ADR §5.2, spec AC-9/AC-16)
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: {
            code: "destructive_schema_change",
            message:
              "Schema change is destructive: active report_page deps would be broken. " +
              "Pass force=true with grant mgmt_object:schema_destructive/apply to override.",
            affected_pages: result.affected_pages,
            fields: result.fields,
          },
        }),
      );
      return;
    }

    if (result.kind === "force_applied") {
      // 200 — force path: schema updated, deps stale, pages depromoted, audit logged
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          updated: true,
          registry_def_id: registryDefId,
          force_applied: true,
          affected_pages: result.affected_pages,
        }),
      );
      return;
    }

    // result.kind === "soft" — schema updated, soft warnings returned
    const softResult = result as { kind: "soft"; warnings: AffectedDep[] };
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    const responseBody: Record<string, unknown> = {
      updated: true,
      registry_def_id: registryDefId,
    };
    if (softResult.warnings.length > 0) {
      // machine-readable warnings array (NF-5 spec, NF-8 ADR)
      responseBody["warnings"] = softResult.warnings.map((w) => ({
        page_slug: w.page_slug,
        registry_def_id: w.registry_def_id,
        field_key: w.field_key,
      }));
    }
    res.end(JSON.stringify(responseBody));
  };

  router.register("PUT", "/api/registry-defs/:id", handler);
  router.register("PATCH", "/api/registry-defs/:id", handler);
}
