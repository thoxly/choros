/**
 * src/http/list-views.ts — T-0581: list_view (view registry) CRUD API.
 *
 * A saved view = tenant-scoped, named configuration of a registry_def's list
 * display ({ columns, filters, sort }). Views live in the `list_view` registry
 * (migration 123) so T-0582 (kanban) can add `type='kanban'` without touching
 * this table, this CRUD contract, or the config validator's dispatch shape
 * (ADR §3.2/FF-VR-4).
 *
 * Registers (over choros.list_view, migration 123):
 *   GET    /api/list-views?registry_def_id=<uuid>[&application_id=<uuid>]
 *          → 200 { views: [...], default_view: <synthetic ListViewConfig> }
 *   POST   /api/list-views   body { registry_def_id, application_id?, type?, name, config, is_default? }
 *          → 201 { ...view } | 400 VIEW_CONFIG_INVALID | 404 | 409 CONFLICT
 *   GET    /api/list-views/:id  → 200 { ...view } | 404
 *   PUT    /api/list-views/:id  body { name?, config?, is_default? }
 *          → 200 { ...view } | 400 VIEW_CONFIG_INVALID | 404
 *   DELETE /api/list-views/:id  → 204 | 404
 *
 * MULTI-TENANT (mandatory, T-0013): every operation runs inside withTenantTx under
 * SET LOCAL choros.tenant_id = '<actor-tenant>' + FORCE RLS (policy
 * list_view_tenant_isolation, migration 123). The actor's REAL tenant is resolved
 * from the dev-user slug / KC sub — NEVER from the request body or an attacker
 * header. A caller in tenant A therefore cannot list, read, mutate, or delete
 * tenant B's views (RLS-enforced; GET/PUT/DELETE of a foreign id RLS-filters to
 * 0 rows → 404, indistinguishable from not-found — AC-2).
 *
 * MUTATION PRIVILEGE (FR-10 / ADR §4): create/update/delete require the SAME
 * configurator privilege as record/schema edits — owner/admin OR the
 * `authoring_draft` grant (resolveActorPrivilege, mirrors DELETE /api/records).
 * READ (GET) requires only tenant membership — views are common-to-tenant
 * configuration (spec §6), not privileged content.
 *
 * CONFIG VALIDATION (AC-4/AC-5): validateViewConfig(type, config, recordSchema)
 * — the record_schema is loaded from the target registry_def (never trusted
 * from the request body) so the validator's field-type/operator/sortability
 * checks are always against the REAL governing schema.
 *
 * DEPS INJECTION (mirrors sections.ts / applications.ts): the composition root
 * supplies { pool, resolveActorTenant, resolveActorPrivilege? }. When pool is
 * absent (no DATABASE_URL) the routes are NOT registered — same honest-degrade
 * contract as the other DB-backed write APIs.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import { resolveActorPrivilege, type ActorPrivilege } from "../db/sandbox-gate-dao.js";
import { validateViewConfig, defaultViewConfig, type ListViewConfig } from "../core/view-config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VIEW_NAME_MAX = 128;
const DEFAULT_VIEW_TYPE = "list";

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// Injected deps (mirrors SectionRoutesDeps / RecordRoutesDeps)
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

/**
 * OPTIONAL actor-privilege resolver (mirrors RecordRoutesDeps.resolveSandboxPrivilege).
 * Honest-degrade: when absent, falls back to the REAL resolveActorPrivilege
 * against the injected pool — the mutation gate is NEVER silently disabled.
 */
export type ActorPrivilegeResolver = (
  actorSlug: string,
  tenantId: string,
  nowMs: number,
) => Promise<ActorPrivilege>;

export interface ListViewRoutesDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
  resolveActorPrivilege?: ActorPrivilegeResolver;
}

// ---------------------------------------------------------------------------
// withTenantTx — canonical RLS pattern (mirrors sections.ts / records.ts)
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
// extractActor — caller identity, mode-aware (mirrors sections.ts)
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
// Row type + serializer
// ---------------------------------------------------------------------------

interface ListViewRow {
  id: string;
  registry_def_id: string;
  application_id: string;
  type: string;
  name: string;
  is_default: boolean;
  config: unknown;
  created_at: string | number;
  updated_at: string | number;
}

function serializeView(row: ListViewRow): Record<string, unknown> {
  return {
    id: row.id,
    registry_def_id: row.registry_def_id,
    application_id: row.application_id,
    type: row.type,
    name: row.name,
    is_default: row.is_default,
    config: row.config,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

const VIEW_SELECT_COLS =
  "id, registry_def_id, application_id, type, name, is_default, config, created_at, updated_at";

// ---------------------------------------------------------------------------
// Governing registry_def lookup (record_schema for config validation)
// ---------------------------------------------------------------------------

interface GoverningRegistryDef {
  id: string;
  application_id: string;
  record_schema: unknown;
}

/** Resolve a registry_def in the caller's tenant. 404 if absent/foreign. */
async function loadRegistryDef(
  client: pg.PoolClient,
  tenantId: string,
  registryDefId: string,
): Promise<GoverningRegistryDef> {
  const res = await client.query<GoverningRegistryDef>(
    `SELECT id, application_id, record_schema
       FROM choros.registry_def
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, registryDefId],
  );
  if (res.rows.length === 0) {
    throw new HttpError(404, "NOT_FOUND", `registry_def '${registryDefId}' not found in this tenant`);
  }
  return res.rows[0]!;
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

async function listViews(
  pool: pg.Pool,
  tenantId: string,
  registryDefId: string,
): Promise<{ views: ListViewRow[]; defaultView: ListViewConfig }> {
  return withTenantTx(pool, tenantId, async (client) => {
    const reg = await loadRegistryDef(client, tenantId, registryDefId);
    const res = await client.query<ListViewRow>(
      `SELECT ${VIEW_SELECT_COLS}
         FROM choros.list_view
        WHERE tenant_id = $1 AND registry_def_id = $2
        ORDER BY name ASC`,
      [tenantId, registryDefId],
    );
    return { views: res.rows, defaultView: defaultViewConfig(reg.record_schema) };
  });
}

async function getView(pool: pg.Pool, tenantId: string, id: string): Promise<ListViewRow | null> {
  return withTenantTx(pool, tenantId, async (client) => {
    const res = await client.query<ListViewRow>(
      `SELECT ${VIEW_SELECT_COLS} FROM choros.list_view WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return res.rows[0] ?? null;
  });
}

type CreateOutcome =
  | { kind: "created"; row: ListViewRow }
  | { kind: "invalid"; errors: string[] }
  | { kind: "conflict" };

async function createView(args: {
  pool: pg.Pool;
  tenantId: string;
  registryDefId: string;
  applicationId: string | null;
  type: string;
  name: string;
  config: unknown;
  isDefault: boolean;
  actor: string;
  nowMs: number;
}): Promise<CreateOutcome> {
  const { pool, tenantId, registryDefId, applicationId, type, name, config, isDefault, actor, nowMs } = args;
  const id = randomUUID();
  return withTenantTx(pool, tenantId, async (client) => {
    const reg = await loadRegistryDef(client, tenantId, registryDefId);
    if (applicationId !== null && applicationId !== reg.application_id) {
      throw new HttpError(
        400,
        "VALIDATION",
        "application_id does not match the registry_def's owning application",
      );
    }
    const resolvedAppId = applicationId ?? reg.application_id;

    const verdict = validateViewConfig(type, config, reg.record_schema);
    if (!verdict.valid) {
      return { kind: "invalid", errors: verdict.errors };
    }

    // Clearing a prior default happens INSIDE the same tx as the insert so the
    // partial-unique-index invariant (≤1 default per registry_def, AC-10) never
    // observes two defaults even transiently.
    if (isDefault) {
      await client.query(
        `UPDATE choros.list_view SET is_default = false, updated_at = $3
          WHERE tenant_id = $1 AND registry_def_id = $2 AND is_default`,
        [tenantId, registryDefId, nowMs],
      );
    }

    try {
      const res = await client.query<ListViewRow>(
        `INSERT INTO choros.list_view
           (tenant_id, id, registry_def_id, application_id, type, name, is_default,
            config, created_at, updated_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9, $10)
         RETURNING ${VIEW_SELECT_COLS}`,
        [tenantId, id, registryDefId, resolvedAppId, type, name, isDefault, JSON.stringify(config), nowMs, actor],
      );
      return { kind: "created", row: res.rows[0]! };
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        return { kind: "conflict" };
      }
      throw err;
    }
  });
}

type PatchOutcome =
  | { kind: "updated"; row: ListViewRow }
  | { kind: "not_found" }
  | { kind: "invalid"; errors: string[] }
  | { kind: "conflict" };

async function patchView(args: {
  pool: pg.Pool;
  tenantId: string;
  id: string;
  patch: { name?: string; config?: unknown; is_default?: boolean };
  nowMs: number;
}): Promise<PatchOutcome> {
  const { pool, tenantId, id, patch, nowMs } = args;
  return withTenantTx(pool, tenantId, async (client) => {
    const cur = await client.query<ListViewRow>(
      `SELECT ${VIEW_SELECT_COLS} FROM choros.list_view WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    if (cur.rows.length === 0) {
      return { kind: "not_found" };
    }
    const existing = cur.rows[0]!;

    if (patch.config !== undefined) {
      const reg = await loadRegistryDef(client, tenantId, existing.registry_def_id);
      const verdict = validateViewConfig(existing.type, patch.config, reg.record_schema);
      if (!verdict.valid) {
        return { kind: "invalid", errors: verdict.errors };
      }
    }

    if (patch.is_default === true) {
      await client.query(
        `UPDATE choros.list_view SET is_default = false, updated_at = $3
          WHERE tenant_id = $1 AND registry_def_id = $2 AND is_default AND id <> $4`,
        [tenantId, existing.registry_def_id, nowMs, id],
      );
    }

    const setClauses: string[] = [];
    const params: unknown[] = [tenantId, id];
    if (patch.name !== undefined) {
      params.push(patch.name);
      setClauses.push(`name = $${params.length}`);
    }
    if (patch.config !== undefined) {
      params.push(JSON.stringify(patch.config));
      setClauses.push(`config = $${params.length}::jsonb`);
    }
    if (patch.is_default !== undefined) {
      params.push(patch.is_default);
      setClauses.push(`is_default = $${params.length}`);
    }
    if (setClauses.length === 0) {
      return { kind: "updated", row: existing };
    }
    params.push(nowMs);
    setClauses.push(`updated_at = $${params.length}`);

    try {
      const res = await client.query<ListViewRow>(
        `UPDATE choros.list_view
            SET ${setClauses.join(", ")}
          WHERE tenant_id = $1 AND id = $2
          RETURNING ${VIEW_SELECT_COLS}`,
        params,
      );
      return { kind: "updated", row: res.rows[0]! };
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        return { kind: "conflict" };
      }
      throw err;
    }
  });
}

async function deleteView(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  return withTenantTx(pool, tenantId, async (client) => {
    const res = await client.query(
      `DELETE FROM choros.list_view WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return (res.rowCount ?? 0) > 0;
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerListViewRoutes(
  router: Router,
  deps?: ListViewRoutesDeps,
): void {
  if (!deps) return;
  const { pool, resolveActorTenant, resolveActorPrivilege: resolvePrivilegeDep } = deps;

  // Mutation privilege gate (FR-10): owner/admin OR authoring_draft grant.
  // Honest-degrade: no injected resolver → falls back to the REAL
  // resolveActorPrivilege against `pool` (never silently disabled).
  async function assertConfiguratorPrivilege(actor: string, tenantId: string, nowMs: number): Promise<void> {
    const priv = resolvePrivilegeDep
      ? await resolvePrivilegeDep(actor, tenantId, nowMs)
      : await resolveActorPrivilege(pool, tenantId, actor, nowMs);
    if (!priv.isOwnerOrAdmin && !priv.hasAuthoringDraftGrant) {
      throw new HttpError(403, "FORBIDDEN", "not permitted to configure list views");
    }
  }

  function invalidConfigError(errors: string[]): HttpError {
    return new HttpError(400, "VIEW_CONFIG_INVALID", errors.join("; "));
  }

  // GET /api/list-views?registry_def_id=<uuid>[&application_id=<uuid>]
  router.register("GET", "/api/list-views", withAuth(async (req: IncomingMessage, res: ServerResponse) => {
    const actor = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(actor);

    const rawUrl = req.url ?? "";
    const qIdx = rawUrl.indexOf("?");
    const searchParams = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : "");
    const registryDefId = searchParams.get("registry_def_id");
    if (registryDefId === null || !UUID_RE.test(registryDefId)) {
      throw new HttpError(400, "VALIDATION", "registry_def_id query param must be a valid UUID");
    }
    const applicationIdRaw = searchParams.get("application_id");
    if (applicationIdRaw !== null && !UUID_RE.test(applicationIdRaw)) {
      throw new HttpError(400, "VALIDATION", "application_id query param must be a valid UUID");
    }

    const { views, defaultView } = await listViews(pool, tenantId, registryDefId);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ views: views.map(serializeView), default_view: defaultView }));
  }));

  // POST /api/list-views
  router.register("POST", "/api/list-views", withAuth(async (req: IncomingMessage, res: ServerResponse) => {
    const actor = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(actor);
    const nowMs = Date.now();
    await assertConfiguratorPrivilege(actor, tenantId, nowMs);

    const rawBody = await readJsonBody(req);
    if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }
    const body = rawBody as Record<string, unknown>;

    const registryDefId = body["registry_def_id"];
    if (typeof registryDefId !== "string" || !UUID_RE.test(registryDefId)) {
      throw new HttpError(400, "VALIDATION", "registry_def_id must be a valid UUID");
    }

    let applicationId: string | null = null;
    if (body["application_id"] !== undefined && body["application_id"] !== null) {
      if (typeof body["application_id"] !== "string" || !UUID_RE.test(body["application_id"])) {
        throw new HttpError(400, "VALIDATION", "application_id must be a valid UUID");
      }
      applicationId = body["application_id"];
    }

    const type = typeof body["type"] === "string" && body["type"].length > 0 ? body["type"] : DEFAULT_VIEW_TYPE;

    const name = body["name"];
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new HttpError(400, "VALIDATION", "name must be a non-empty string");
    }
    const trimmedName = name.trim();
    if (trimmedName.length > VIEW_NAME_MAX) {
      throw new HttpError(400, "VALIDATION", `name must be at most ${VIEW_NAME_MAX} chars`);
    }

    if (!("config" in body)) {
      throw new HttpError(400, "VALIDATION", "config is required");
    }
    const config = body["config"];

    let isDefault = false;
    if (body["is_default"] !== undefined) {
      if (typeof body["is_default"] !== "boolean") {
        throw new HttpError(400, "VALIDATION", "is_default must be a boolean");
      }
      isDefault = body["is_default"];
    }

    const outcome = await createView({
      pool,
      tenantId,
      registryDefId,
      applicationId,
      type,
      name: trimmedName,
      config,
      isDefault,
      actor,
      nowMs,
    });

    if (outcome.kind === "invalid") throw invalidConfigError(outcome.errors);
    if (outcome.kind === "conflict") {
      throw new HttpError(409, "CONFLICT", `view name '${trimmedName}' already exists for this set of fields`);
    }

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(serializeView(outcome.row)));
  }));

  // GET /api/list-views/:id
  router.register(
    "GET",
    "/api/list-views/:id",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "view id");

      const actor = await extractActor(req, pool);
      const tenantId = await resolveActorTenant(actor);
      const row = await getView(pool, tenantId, id);
      if (row === null) {
        throw new HttpError(404, "NOT_FOUND", "view not found");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(serializeView(row)));
    }),
  );

  // PUT /api/list-views/:id
  router.register(
    "PUT",
    "/api/list-views/:id",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "view id");

      const actor = await extractActor(req, pool);
      const tenantId = await resolveActorTenant(actor);
      const nowMs = Date.now();
      await assertConfiguratorPrivilege(actor, tenantId, nowMs);

      const rawBody = await readJsonBody(req);
      if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
      }
      const body = rawBody as Record<string, unknown>;

      const patch: { name?: string; config?: unknown; is_default?: boolean } = {};

      if ("name" in body) {
        if (typeof body["name"] !== "string" || (body["name"] as string).trim().length === 0) {
          throw new HttpError(400, "VALIDATION", "name must be a non-empty string");
        }
        const trimmed = (body["name"] as string).trim();
        if (trimmed.length > VIEW_NAME_MAX) {
          throw new HttpError(400, "VALIDATION", `name must be at most ${VIEW_NAME_MAX} chars`);
        }
        patch.name = trimmed;
      }
      if ("config" in body) {
        patch.config = body["config"];
      }
      if ("is_default" in body) {
        if (typeof body["is_default"] !== "boolean") {
          throw new HttpError(400, "VALIDATION", "is_default must be a boolean");
        }
        patch.is_default = body["is_default"];
      }

      const outcome = await patchView({ pool, tenantId, id, patch, nowMs });
      if (outcome.kind === "not_found") {
        throw new HttpError(404, "NOT_FOUND", "view not found");
      }
      if (outcome.kind === "invalid") throw invalidConfigError(outcome.errors);
      if (outcome.kind === "conflict") {
        throw new HttpError(409, "CONFLICT", "view name already exists for this set of fields");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(serializeView(outcome.row)));
    }),
  );

  // DELETE /api/list-views/:id
  router.register(
    "DELETE",
    "/api/list-views/:id",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "view id");

      const actor = await extractActor(req, pool);
      const tenantId = await resolveActorTenant(actor);
      const nowMs = Date.now();
      await assertConfiguratorPrivilege(actor, tenantId, nowMs);

      const deleted = await deleteView(pool, tenantId, id);
      if (!deleted) {
        throw new HttpError(404, "NOT_FOUND", "view not found");
      }

      res.statusCode = 204;
      res.end();
    }),
  );
}
