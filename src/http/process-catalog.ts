/**
 * src/http/process-catalog.ts — T-0270 (E13).
 *
 * The REAL process catalog + process↔application binding surface. This is the
 * "how processes connect to the applications you built in the constructor" view.
 *
 * Routes (ALL withAuth-wrapped + mode-aware + tenant-scoped via resolveActorTenant):
 *   GET  /api/process-catalog        → real process DEFINITIONS + real INSTANCES
 *   GET  /api/process-app-bindings   → list this tenant's process↔application bindings
 *   POST /api/process-app-bindings   → bind a process to an application (+ optional form)
 *
 * WHY A SEPARATE MODULE FROM processes.ts (FF-7-3 / start-route-isolation.sh):
 *   src/http/processes.ts is the FROZEN display plane — it must NOT import pg or
 *   src/db/* (its GETs are pack/seed-served, with the projection merged in via the
 *   pg-carrying process-projection.ts it imports). The REAL catalog needs to read
 *   process_definition (pg, RLS) directly, so it lives here. processes.ts is left
 *   byte-untouched; the no-DB fallback (no-db-fallback.sh) that requires
 *   /api/processes to return the seed list WITHOUT DATABASE_URL stays intact.
 *
 * REAL DEFINITIONS — two honest sources, never a mock:
 *   1. choros.process_definition (074) — modeler-created drafts/published, tenant-scoped.
 *   2. process keys observed in REAL started instances (listInstanceProjections /
 *      audit-backed). The canonical ТЭЛ (telLinear) is deployed straight to Flowable
 *      from config/flowable/processes/, so it has NO process_definition row — but once
 *      a real instance is started it appears here as a REAL definition (source:
 *      'engine') derived from its own running instances. No fabricated rows: a key only
 *      appears if it has a real DB definition OR a real instance.
 *
 * GRACEFUL-EMPTY: when there are genuinely no definitions and no instances, the
 * response is { definitions: [], instances: [], bindings: [] } — an honest empty
 * state, never seed/showcase rows.
 *
 * TENANCY: resolveActorTenant(actor) (NEVER a request header/body) → withTenantTx
 * (SET LOCAL choros.tenant_id + FORCE RLS). A caller in tenant A cannot see tenant B's
 * definitions, instances, or bindings (RLS-enforced via the choros_app NOBYPASSRLS pool).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import {
  listInstanceProjections,
  type InstanceProjection,
} from "./process-projection.js";
import {
  buildCatalogDefinitions,
  serializeInstance,
  type CatalogDefinition,
  type CatalogInstance,
  type ProcessDefRow,
} from "../core/process-catalog-view.js";

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

/** Resolve an actor slug/sub to a tenant UUID (same shape as the other route modules). */
export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

/** Injected deps. When absent the routes are NOT registered (no-DB honest degrade). */
export interface ProcessCatalogDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
}

// ---------------------------------------------------------------------------
// withTenantTx — canonical RLS pattern (mirrors applications.ts / agents-list.ts)
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
// extractActor — mode-aware (mirrors agents.ts::extractActor — T-0371/T-0633:
// keycloak resolves the JWT sub/preferred_username to the REAL employee slug
// via resolveActorSlugFromAuth before it drives tenant resolution). dev mode
// (x-dev-user) unchanged.
// ---------------------------------------------------------------------------

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
// Trigger type values (mirrors migration 082 CHECK constraint)
// ---------------------------------------------------------------------------

const TRIGGER_TYPES = ["on_create", "record_action", "launcher", "auto"] as const;
type TriggerType = (typeof TRIGGER_TYPES)[number];

function isTriggerType(v: unknown): v is TriggerType {
  return typeof v === "string" && (TRIGGER_TYPES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Binding row + serializer
// ---------------------------------------------------------------------------

interface ProcessAppBindingRow {
  id: string;
  process_key: string;
  application_id: string;
  form_key: string | null;
  // T-0351 E16: runtime trigger config columns (migration 082)
  trigger_type: string;
  start_form_key: string | null;
  field_mapping: Record<string, string> | null;
  created_at: string | number;
  updated_at: string | number;
  // application display columns (LEFT JOIN — present iff the app still exists in tenant).
  app_slug: string | null;
  app_display_name: string | null;
}

export interface ProcessAppBinding {
  id: string;
  process_key: string;
  application_id: string;
  application_slug: string | null;
  application_name: string | null;
  form_key: string | null;
  // T-0351 E16: runtime trigger config
  trigger_type: TriggerType;
  start_form_key: string | null;
  field_mapping: Record<string, string>;
  created_at: number;
  updated_at: number;
}

function serializeBinding(row: ProcessAppBindingRow): ProcessAppBinding {
  return {
    id: row.id,
    process_key: row.process_key,
    application_id: row.application_id,
    application_slug: row.app_slug,
    application_name: row.app_display_name,
    form_key: row.form_key,
    trigger_type: isTriggerType(row.trigger_type) ? row.trigger_type : "launcher",
    start_form_key: row.start_form_key,
    field_mapping:
      row.field_mapping !== null && typeof row.field_mapping === "object"
        ? (row.field_mapping as Record<string, string>)
        : {},
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// DB reads
// ---------------------------------------------------------------------------

/** Real process definitions from the modeler store (074), tenant-scoped via RLS. */
async function listProcessDefRows(
  client: pg.PoolClient,
  tenantId: string,
): Promise<ProcessDefRow[]> {
  const { rows } = await client.query<ProcessDefRow>(
    `SELECT DISTINCT ON (process_key)
            process_key, name, version, status, deployment_id, updated_at
       FROM choros.process_definition
      WHERE tenant_id = $1
      ORDER BY process_key, version DESC`,
    [tenantId],
  );
  return rows;
}

/** This tenant's process↔application bindings, joined to the application for display. */
async function listBindingRows(
  client: pg.PoolClient,
  tenantId: string,
): Promise<ProcessAppBindingRow[]> {
  // T-0351 E16: select the 3 new runtime trigger columns (migration 082).
  // COALESCE for trigger_type/field_mapping handles rows created before 082 is applied
  // on a given environment (defensive; migrator guarantees columns exist in prod).
  const { rows } = await client.query<ProcessAppBindingRow>(
    `SELECT b.id, b.process_key, b.application_id, b.form_key,
            COALESCE(b.trigger_type, 'launcher')  AS trigger_type,
            b.start_form_key,
            COALESCE(b.field_mapping, '{}')::jsonb AS field_mapping,
            b.created_at, b.updated_at,
            a.slug         AS app_slug,
            a.display_name AS app_display_name
       FROM choros.process_app_binding b
       LEFT JOIN choros.application a
              ON a.tenant_id = b.tenant_id AND a.id = b.application_id
      WHERE b.tenant_id = $1
      ORDER BY b.created_at DESC, b.process_key ASC`,
    [tenantId],
  );
  return rows;
}

/** True iff the application exists in the caller's tenant (RLS-scoped). */
async function applicationExists(
  client: pg.PoolClient,
  tenantId: string,
  applicationId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ one: number }>(
    `SELECT 1 AS one
       FROM choros.application
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1`,
    [tenantId, applicationId],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerProcessCatalogRoutes(
  router: Router,
  deps?: ProcessCatalogDeps,
): void {
  if (!deps) return;
  const { pool, resolveActorTenant } = deps;

  // -------------------------------------------------------------------------
  // GET /api/process-catalog — REAL definitions + REAL instances + bindings.
  // withAuth: keycloak → 401 without a valid Bearer JWT; dev → x-dev-user.
  // -------------------------------------------------------------------------
  router.register(
    "GET",
    "/api/process-catalog",
    withAuth(async (req: IncomingMessage, res: ServerResponse) => {
      const actor = await extractActor(req, pool);
      const tenantId = await resolveActorTenant(actor);

      // Modeler definitions + bindings: one tenant-scoped tx (FORCE RLS).
      const { defRows, bindingRows } = await withTenantTx(pool, tenantId, async (client) => {
        const dr = await listProcessDefRows(client, tenantId);
        const br = await listBindingRows(client, tenantId);
        return { defRows: dr, bindingRows: br };
      });
      // Real instances: the projection module owns its own scoped tx (BYPASSRLS-safe
      // WHERE tenant_id guard, audit-backed). Real instances only — never seed/mock.
      const projections: InstanceProjection[] = await listInstanceProjections(pool, tenantId);

      const definitions: CatalogDefinition[] = buildCatalogDefinitions(defRows, projections);
      const instances: CatalogInstance[] = projections.map(serializeInstance);
      const bindings = bindingRows.map(serializeBinding);

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      // Honest graceful-empty: empty arrays when there is genuinely nothing real.
      res.end(JSON.stringify({ definitions, instances, bindings }));
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/process-app-bindings — list this tenant's bindings (for display).
  // -------------------------------------------------------------------------
  router.register(
    "GET",
    "/api/process-app-bindings",
    withAuth(async (req: IncomingMessage, res: ServerResponse) => {
      const actor = await extractActor(req, pool);
      const tenantId = await resolveActorTenant(actor);

      const rows = await withTenantTx(pool, tenantId, (client) =>
        listBindingRows(client, tenantId),
      );

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ bindings: rows.map(serializeBinding) }));
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/process-app-bindings — bind a process definition to an application.
  // Body: { process_key: string, application_id: uuid, form_key?: string|null }
  // Upsert on (tenant_id, process_key, application_id): re-binding the same pair
  // updates form_key (version-free; this is a membership link, not a contract).
  // -------------------------------------------------------------------------
  router.register(
    "POST",
    "/api/process-app-bindings",
    withAuth(async (req: IncomingMessage, res: ServerResponse) => {
      const actor = await extractActor(req, pool);

      const rawBody = await readJsonBody(req);
      if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
      }
      const body = rawBody as Record<string, unknown>;

      const processKey = body["process_key"];
      if (typeof processKey !== "string" || processKey.trim().length === 0) {
        throw new HttpError(400, "VALIDATION", "process_key must be a non-empty string");
      }
      const applicationId = body["application_id"];
      if (typeof applicationId !== "string" || !UUID_RE.test(applicationId)) {
        throw new HttpError(400, "VALIDATION", "application_id must be a valid UUID");
      }
      let formKey: string | null = null;
      if ("form_key" in body && body["form_key"] !== null && body["form_key"] !== undefined) {
        if (typeof body["form_key"] !== "string") {
          throw new HttpError(400, "VALIDATION", "form_key must be a string or null");
        }
        const fk = body["form_key"].trim();
        formKey = fk.length > 0 ? fk : null;
      }

      // T-0351 E16: runtime trigger config fields (migration 082).
      // trigger_type defaults to 'launcher' (backward-compat with old UIs that do not send it).
      let triggerType: TriggerType = "launcher";
      if ("trigger_type" in body && body["trigger_type"] !== null && body["trigger_type"] !== undefined) {
        if (!isTriggerType(body["trigger_type"])) {
          throw new HttpError(
            400,
            "VALIDATION",
            `trigger_type must be one of: ${TRIGGER_TYPES.join(", ")}`,
          );
        }
        triggerType = body["trigger_type"];
      }

      let startFormKey: string | null = null;
      if ("start_form_key" in body && body["start_form_key"] !== null && body["start_form_key"] !== undefined) {
        if (typeof body["start_form_key"] !== "string") {
          throw new HttpError(400, "VALIDATION", "start_form_key must be a string or null");
        }
        const sfk = body["start_form_key"].trim();
        startFormKey = sfk.length > 0 ? sfk : null;
      }

      let fieldMapping: Record<string, string> = {};
      if ("field_mapping" in body && body["field_mapping"] !== null && body["field_mapping"] !== undefined) {
        if (typeof body["field_mapping"] !== "object" || Array.isArray(body["field_mapping"])) {
          throw new HttpError(400, "VALIDATION", "field_mapping must be an object");
        }
        // Validate: all values must be strings (field paths → scalar only).
        const fm = body["field_mapping"] as Record<string, unknown>;
        for (const [k, v] of Object.entries(fm)) {
          if (typeof v !== "string") {
            throw new HttpError(
              400,
              "VALIDATION",
              `field_mapping["${k}"] must be a string (scalar field path)`,
            );
          }
        }
        fieldMapping = fm as Record<string, string>;
      }

      const tenantId = await resolveActorTenant(actor);
      const nowMs = Date.now();

      const result = await withTenantTx(pool, tenantId, async (client) => {
        // Runtime integrity: the application MUST exist in the caller's tenant.
        // RLS-scoped SELECT — a cross-tenant application id reads as absent → 404.
        const exists = await applicationExists(client, tenantId, applicationId);
        if (!exists) {
          throw new HttpError(404, "NOT_FOUND", "application not found in this tenant");
        }

        // Upsert on the natural key (tenant_id, process_key, application_id).
        // T-0351: also upsert the 3 runtime trigger columns.
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO choros.process_app_binding
             (tenant_id, id, process_key, application_id, form_key,
              trigger_type, start_form_key, field_mapping,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9)
           ON CONFLICT (tenant_id, process_key, application_id)
           DO UPDATE SET
             form_key       = EXCLUDED.form_key,
             trigger_type   = EXCLUDED.trigger_type,
             start_form_key = EXCLUDED.start_form_key,
             field_mapping  = EXCLUDED.field_mapping,
             updated_at     = EXCLUDED.updated_at
           RETURNING id`,
          [
            tenantId,
            randomUUID(),
            processKey.trim(),
            applicationId,
            formKey,
            triggerType,
            startFormKey,
            JSON.stringify(fieldMapping),
            nowMs,
          ],
        );
        return rows[0]!;
      });

      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: result.id,
          process_key: processKey.trim(),
          application_id: applicationId,
          form_key: formKey,
          trigger_type: triggerType,
          start_form_key: startFormKey,
          field_mapping: fieldMapping,
        }),
      );
    }),
  );
}
