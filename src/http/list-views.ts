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
import {
  validateViewConfig,
  defaultViewConfig,
  validateViewSourceConfig,
  defaultInboxViewConfig,
  type ListViewConfig,
} from "../core/view-config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VIEW_NAME_MAX = 128;
const DEFAULT_VIEW_TYPE = "list";

// T-0653: view-primitive source discriminator. 'records' = today's T-0581
// registry_def-bound view; 'inbox'/'processes' = non-registry_def source views.
const DEFAULT_VIEW_SOURCE = "records";
const NON_RECORDS_SOURCES = new Set(["inbox", "processes"]);
function isKnownSource(s: string): boolean {
  return s === "records" || NON_RECORDS_SOURCES.has(s);
}

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
  registry_def_id: string | null;
  application_id: string | null;
  // T-0653: source discriminator + per-user owner (NULL = common tenant view).
  source: string;
  owner_actor: string | null;
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
    source: row.source,
    // owner_actor is surfaced so the client can badge a personal («мой») view;
    // it is only ever the caller's own slug or null (never a foreign actor —
    // foreign personal views are scoped out of every read).
    owner_actor: row.owner_actor,
    type: row.type,
    name: row.name,
    is_default: row.is_default,
    config: row.config,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

const VIEW_SELECT_COLS =
  "id, registry_def_id, application_id, source, owner_actor, type, name, is_default, config, created_at, updated_at";

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

// T-0653: personal-view visibility predicate. A read only ever returns COMMON
// views (owner_actor IS NULL) + the CALLER'S OWN personal views. A foreign
// actor's personal view is invisible (RLS keeps tenant isolation; this keeps
// personal isolation WITHIN a tenant). `$N` is the actor bind-param index.
function ownerVisibilityClause(actorParamIdx: number): string {
  return `(owner_actor IS NULL OR owner_actor = $${actorParamIdx})`;
}

async function listViews(
  pool: pg.Pool,
  tenantId: string,
  registryDefId: string,
  actor: string,
): Promise<{ views: ListViewRow[]; defaultView: ListViewConfig }> {
  return withTenantTx(pool, tenantId, async (client) => {
    const reg = await loadRegistryDef(client, tenantId, registryDefId);
    // records-source views for this registry_def: common + caller's own personal.
    const res = await client.query<ListViewRow>(
      `SELECT ${VIEW_SELECT_COLS}
         FROM choros.list_view
        WHERE tenant_id = $1 AND registry_def_id = $2 AND source = 'records'
          AND ${ownerVisibilityClause(3)}
        ORDER BY name ASC`,
      [tenantId, registryDefId, actor],
    );
    return { views: res.rows, defaultView: defaultViewConfig(reg.record_schema) };
  });
}

// T-0653: list non-records-source views (inbox/processes) — no registry_def.
async function listSourceViews(
  pool: pg.Pool,
  tenantId: string,
  source: string,
  actor: string,
): Promise<ListViewRow[]> {
  return withTenantTx(pool, tenantId, async (client) => {
    const res = await client.query<ListViewRow>(
      `SELECT ${VIEW_SELECT_COLS}
         FROM choros.list_view
        WHERE tenant_id = $1 AND source = $2 AND ${ownerVisibilityClause(3)}
        ORDER BY name ASC`,
      [tenantId, source, actor],
    );
    return res.rows;
  });
}

// getView scopes by owner-visibility: a foreign personal view resolves to null
// (404), indistinguishable from not-found (mirrors RLS foreign-tenant 404).
async function getView(
  pool: pg.Pool,
  tenantId: string,
  id: string,
  actor: string,
): Promise<ListViewRow | null> {
  return withTenantTx(pool, tenantId, async (client) => {
    const res = await client.query<ListViewRow>(
      `SELECT ${VIEW_SELECT_COLS} FROM choros.list_view
        WHERE tenant_id = $1 AND id = $2 AND ${ownerVisibilityClause(3)}`,
      [tenantId, id, actor],
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
  source: string;
  registryDefId: string | null;
  applicationId: string | null;
  type: string;
  name: string;
  config: unknown;
  isDefault: boolean;
  actor: string;
  // T-0653: owner of a PERSONAL view (the caller's own slug) or null (common
  // tenant view). Resolved from the caller identity, NEVER from the body.
  ownerActor: string | null;
  nowMs: number;
}): Promise<CreateOutcome> {
  const { pool, tenantId, source, registryDefId, applicationId, type, name, config, isDefault, actor, ownerActor, nowMs } = args;
  const id = randomUUID();
  return withTenantTx(pool, tenantId, async (client) => {
    let resolvedRegistryDefId: string | null = null;
    let resolvedAppId: string | null = null;

    if (source === "records") {
      // records-source: registry_def_id REQUIRED; config validated against the
      // governing record_schema (T-0581 semantics, unchanged).
      if (registryDefId === null) {
        throw new HttpError(400, "VALIDATION", "registry_def_id is required for a records view");
      }
      const reg = await loadRegistryDef(client, tenantId, registryDefId);
      if (applicationId !== null && applicationId !== reg.application_id) {
        throw new HttpError(
          400,
          "VALIDATION",
          "application_id does not match the registry_def's owning application",
        );
      }
      resolvedRegistryDefId = registryDefId;
      resolvedAppId = applicationId ?? reg.application_id;

      const verdict = validateViewConfig(type, config, reg.record_schema);
      if (!verdict.valid) {
        return { kind: "invalid", errors: verdict.errors };
      }
    } else {
      // inbox/processes-source: NO registry_def; config validated against the
      // static column catalog by SOURCE (validateViewSourceConfig dispatcher).
      const verdict = validateViewSourceConfig(source, config);
      if (!verdict.valid) {
        return { kind: "invalid", errors: verdict.errors };
      }
    }

    // Clearing a prior default happens INSIDE the same tx as the insert so the
    // scoped partial-unique-index invariant (≤1 default per
    // tenant+source+registry_def+owner, migration 130) never observes two
    // defaults even transiently. The clear is SCOPED to the same (source,
    // registry_def, owner) group so setting a personal default does not touch
    // the common default, and vice-versa.
    if (isDefault) {
      await client.query(
        `UPDATE choros.list_view SET is_default = false, updated_at = $2
          WHERE tenant_id = $1 AND is_default
            AND source = $3
            AND registry_def_id IS NOT DISTINCT FROM $4
            AND owner_actor IS NOT DISTINCT FROM $5`,
        [tenantId, nowMs, source, resolvedRegistryDefId, ownerActor],
      );
    }

    try {
      const res = await client.query<ListViewRow>(
        `INSERT INTO choros.list_view
           (tenant_id, id, registry_def_id, application_id, source, owner_actor,
            type, name, is_default, config, created_at, updated_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $11, $12)
         RETURNING ${VIEW_SELECT_COLS}`,
        [tenantId, id, resolvedRegistryDefId, resolvedAppId, source, ownerActor, type, name, isDefault, JSON.stringify(config), nowMs, actor],
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
  actor: string;
  patch: { name?: string; config?: unknown; is_default?: boolean };
  nowMs: number;
}): Promise<PatchOutcome> {
  const { pool, tenantId, id, actor, patch, nowMs } = args;
  return withTenantTx(pool, tenantId, async (client) => {
    // Owner-scoped SELECT: a foreign actor's personal view is invisible → 404.
    const cur = await client.query<ListViewRow>(
      `SELECT ${VIEW_SELECT_COLS} FROM choros.list_view
        WHERE tenant_id = $1 AND id = $2 AND ${ownerVisibilityClause(3)}`,
      [tenantId, id, actor],
    );
    if (cur.rows.length === 0) {
      return { kind: "not_found" };
    }
    const existing = cur.rows[0]!;

    if (patch.config !== undefined) {
      // Source-aware validation: records-view against its record_schema,
      // inbox/processes-view against the static column catalog.
      if (existing.source === "records") {
        if (existing.registry_def_id === null) {
          return { kind: "invalid", errors: ["records view is missing its registry_def"] };
        }
        const reg = await loadRegistryDef(client, tenantId, existing.registry_def_id);
        const verdict = validateViewConfig(existing.type, patch.config, reg.record_schema);
        if (!verdict.valid) {
          return { kind: "invalid", errors: verdict.errors };
        }
      } else {
        const verdict = validateViewSourceConfig(existing.source, patch.config);
        if (!verdict.valid) {
          return { kind: "invalid", errors: verdict.errors };
        }
      }
    }

    if (patch.is_default === true) {
      // Clear the prior default in the SAME (source, registry_def, owner) group.
      await client.query(
        `UPDATE choros.list_view SET is_default = false, updated_at = $2
          WHERE tenant_id = $1 AND is_default AND id <> $3
            AND source = $4
            AND registry_def_id IS NOT DISTINCT FROM $5
            AND owner_actor IS NOT DISTINCT FROM $6`,
        [tenantId, nowMs, id, existing.source, existing.registry_def_id, existing.owner_actor],
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

async function deleteView(pool: pg.Pool, tenantId: string, id: string, actor: string): Promise<boolean> {
  return withTenantTx(pool, tenantId, async (client) => {
    // Owner-scoped: a foreign actor's personal view is not deletable → 404.
    const res = await client.query(
      `DELETE FROM choros.list_view
        WHERE tenant_id = $1 AND id = $2 AND ${ownerVisibilityClause(3)}`,
      [tenantId, id, actor],
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

  // GET /api/list-views?registry_def_id=<uuid>[&application_id=<uuid>]   (records)
  //     OR ?source=inbox|processes                                        (T-0653)
  //
  // Returns COMMON tenant views + the CALLER'S OWN personal views (a foreign
  // actor's personal view is never listed — owner-scoped over RLS).
  router.register("GET", "/api/list-views", withAuth(async (req: IncomingMessage, res: ServerResponse) => {
    const actor = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(actor);

    const rawUrl = req.url ?? "";
    const qIdx = rawUrl.indexOf("?");
    const searchParams = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : "");

    // T-0653: ?source= selects a non-records view source (inbox/processes).
    // Absent source ⇒ 'records' (backward-compatible: registry_def_id path).
    const sourceRaw = searchParams.get("source");
    if (sourceRaw !== null && sourceRaw !== "records") {
      if (!NON_RECORDS_SOURCES.has(sourceRaw)) {
        throw new HttpError(400, "VIEW_SOURCE_INVALID", `unknown view source '${sourceRaw}'`);
      }
      const views = await listSourceViews(pool, tenantId, sourceRaw, actor);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        views: views.map(serializeView),
        default_view: defaultInboxViewConfig(),
      }));
      return;
    }

    // records-source path (T-0581, unchanged contract).
    const registryDefId = searchParams.get("registry_def_id");
    if (registryDefId === null || !UUID_RE.test(registryDefId)) {
      throw new HttpError(400, "VALIDATION", "registry_def_id query param must be a valid UUID");
    }
    const applicationIdRaw = searchParams.get("application_id");
    if (applicationIdRaw !== null && !UUID_RE.test(applicationIdRaw)) {
      throw new HttpError(400, "VALIDATION", "application_id query param must be a valid UUID");
    }

    const { views, defaultView } = await listViews(pool, tenantId, registryDefId, actor);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ views: views.map(serializeView), default_view: defaultView }));
  }));

  // POST /api/list-views
  //   body { registry_def_id?, application_id?, source?, type?, name, config,
  //          is_default?, personal? }
  //
  // T-0653: source defaults to 'records' (T-0581). `personal:true` creates a
  // PERSONAL view owned by the caller (owner_actor = caller slug, resolved from
  // identity NOT the body). A personal view needs NO configurator privilege
  // (like a user_pref — it affects only the writer's own view); a COMMON view
  // keeps the configurator gate (FR-10, T-0581).
  router.register("POST", "/api/list-views", withAuth(async (req: IncomingMessage, res: ServerResponse) => {
    const actor = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(actor);
    const nowMs = Date.now();

    const rawBody = await readJsonBody(req);
    if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }
    const body = rawBody as Record<string, unknown>;

    const source = typeof body["source"] === "string" && body["source"].length > 0
      ? body["source"]
      : DEFAULT_VIEW_SOURCE;
    if (!isKnownSource(source)) {
      throw new HttpError(400, "VIEW_SOURCE_INVALID", `unknown view source '${source}'`);
    }

    // registry_def_id: REQUIRED for records, ignored for others.
    let registryDefId: string | null = null;
    if (source === "records") {
      const rid = body["registry_def_id"];
      if (typeof rid !== "string" || !UUID_RE.test(rid)) {
        throw new HttpError(400, "VALIDATION", "registry_def_id must be a valid UUID");
      }
      registryDefId = rid;
    }

    let applicationId: string | null = null;
    if (source === "records" && body["application_id"] !== undefined && body["application_id"] !== null) {
      if (typeof body["application_id"] !== "string" || !UUID_RE.test(body["application_id"])) {
        throw new HttpError(400, "VALIDATION", "application_id must be a valid UUID");
      }
      applicationId = body["application_id"];
    }

    // personal flag → owner_actor = caller (never from body). Absent/false ⇒ common.
    let personal = false;
    if (body["personal"] !== undefined) {
      if (typeof body["personal"] !== "boolean") {
        throw new HttpError(400, "VALIDATION", "personal must be a boolean");
      }
      personal = body["personal"];
    }
    const ownerActor: string | null = personal ? actor : null;

    // Common views require the configurator privilege; personal views do not.
    if (!personal) {
      await assertConfiguratorPrivilege(actor, tenantId, nowMs);
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
      source,
      registryDefId,
      applicationId,
      type,
      name: trimmedName,
      config,
      isDefault,
      actor,
      ownerActor,
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
      const row = await getView(pool, tenantId, id, actor);
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

      // T-0653: resolve the target's owner FIRST (owner-scoped). A personal view
      // owned by the caller needs no configurator privilege; a common view does.
      const target = await getView(pool, tenantId, id, actor);
      if (target === null) {
        throw new HttpError(404, "NOT_FOUND", "view not found");
      }
      const isPersonal = target.owner_actor === actor;
      if (!isPersonal) {
        await assertConfiguratorPrivilege(actor, tenantId, nowMs);
      }

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

      const outcome = await patchView({ pool, tenantId, id, actor, patch, nowMs });
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

      // T-0653: a personal view owned by the caller needs no configurator
      // privilege; a common view does. Resolve the owner first (owner-scoped).
      const target = await getView(pool, tenantId, id, actor);
      if (target === null) {
        throw new HttpError(404, "NOT_FOUND", "view not found");
      }
      if (target.owner_actor !== actor) {
        await assertConfiguratorPrivilege(actor, tenantId, nowMs);
      }

      const deleted = await deleteView(pool, tenantId, id, actor);
      if (!deleted) {
        throw new HttpError(404, "NOT_FOUND", "view not found");
      }

      res.statusCode = 204;
      res.end();
    }),
  );
}
