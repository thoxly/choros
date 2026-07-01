/**
 * src/http/applications.ts — T-0262 E13: applications create/list/get API.
 *
 * Registers (over the EXISTING choros.application table, migration 003 + 049):
 *   POST /api/applications      → create one application (tenant-scoped)
 *   GET  /api/applications      → list the caller-tenant's applications
 *   GET  /api/applications/:id  → get one application (404 if not in tenant)
 *
 * WHY THIS EXISTS: there was NO HTTP create endpoint for ANY primitive — the root
 * cause of "no create buttons in the product". This is the first write-surface over
 * a config primitive; T-0263 (registry_def) and T-0264 (record) follow the same
 * shape on the central router seam.
 *
 * MULTI-TENANT (mandatory, AC): every operation runs inside withTenantTx under
 * SET LOCAL choros.tenant_id = '<actor-tenant>' + FORCE RLS (policy
 * application_tenant_isolation). The actor's REAL tenant is resolved from the
 * x-dev-user slug via the injected resolveActorTenant — NEVER from the request
 * body or an attacker-controlled header. A caller in tenant A therefore cannot
 * list or read tenant B's rows (RLS-enforced, the Враг target).
 *
 * COLUMNS (migration 003_application.sql + 049_tier.sql):
 *   tenant_id    uuid    (scope; resolved from actor, not body)
 *   id           uuid    (server-generated)
 *   slug         text    (required; UNIQUE (tenant_id, slug) — AC-8)
 *   display_name text    (required)
 *   description  text    (nullable)
 *   created_at   bigint  (epoch ms, server clock)
 *   updated_at   bigint  (epoch ms, server clock)
 *   tier         text    ('draft'|'published'; DEFAULT 'draft' — created as draft)
 *
 * DEPS INJECTION (mirrors processes.ts / inbox.ts): the composition root supplies
 * { pool, resolveActorTenant }. When absent (no DATABASE_URL) the routes are NOT
 * registered — same honest-degrade contract as the other DB-backed write APIs.
 *
 * "sections" (task title "приложений/разделов"): migration 003 models only the
 * application primitive; there is no distinct `section` table. Sections are the
 * registry/report grouping under an application (registry_def.application_id,
 * report_page.app_id) — owned by T-0263 and the report-page CRUD already shipped.
 * Honest minimal scope here = application create/list/get.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// slug: lowercase alphanumerics + dashes, 1..64 chars. Matches the human-authored
// slug convention used elsewhere (report-page slugs). Kept strict so a slug is a
// safe, URL-shaped identifier; display_name carries the free-text label.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// Injected deps (mirrors StartInstanceDeps in process-start.ts)
// ---------------------------------------------------------------------------

/**
 * Resolve the tenant the actor (dev-user slug) actually belongs to.
 * Production binding = resolveActorTenant(getOrgPool(), slug) from src/db/org.ts;
 * injected so the test suite can stub the membership check (actor A → tenant A,
 * actor B → tenant B) without standing up Keycloak.
 */
export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

export interface ApplicationRoutesDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
}

// ---------------------------------------------------------------------------
// withTenantTx — canonical RLS pattern (mirrors artifacts.ts / registry-defs.ts)
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
// extractActor — caller identity, mode-aware (T-0372: resolves KC sub → slug)
// ---------------------------------------------------------------------------

async function extractActor(req: IncomingMessage, pool: pg.Pool): Promise<string> {
  // Keycloak mode: resolve sub → employee slug (T-0372).
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
  }
  // Dev mode: x-dev-user header.
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

interface ApplicationRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  section: string | null;  // T-0540 (DEPRECATED, T-0551): legacy free-text раздел.
  section_id: string | null; // T-0551: FK на choros.section; NULL → «Без раздела».
  section_name: string | null; // T-0551: denormalized section.name (LEFT JOIN), for nav/list.
  tier: string;
  created_at: string | number; // bigint comes back as a string from node-postgres
  updated_at: string | number;
}

function serializeApplication(row: ApplicationRow): Record<string, unknown> {
  return {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    description: row.description,
    section: row.section ?? null,  // T-0540 legacy (DEPRECATED); kept until column drop.
    section_id: row.section_id ?? null,    // T-0551: раздел-сущность; null = «Без раздела».
    section_name: row.section_name ?? null, // T-0551: имя раздела (для нав/списка без доп.запроса).
    tier: row.tier,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

// T-0551: reads LEFT JOIN choros.section so the row carries section_id + section_name
// (имя раздела для нав/списка без доп.запроса). NULL section_id → section_name NULL
// = «Без раздела». INSERT/UPDATE re-select via this fragment to populate section_name.
const APP_READ_SELECT = `
  SELECT a.id, a.slug, a.display_name, a.description, a.section,
         a.section_id, s.name AS section_name, a.tier, a.created_at, a.updated_at
    FROM choros.application a
    LEFT JOIN choros.section s
      ON s.tenant_id = a.tenant_id AND s.id = a.section_id`;

// Re-select one application (with section JOIN) inside an existing tenant tx client.
async function selectAppByIdTx(
  client: pg.PoolClient,
  tenantId: string,
  id: string,
): Promise<ApplicationRow | null> {
  const res = await client.query<ApplicationRow>(
    `${APP_READ_SELECT} WHERE a.tenant_id = $1 AND a.id = $2`,
    [tenantId, id],
  );
  return res.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

async function createApplication(args: {
  pool: pg.Pool;
  tenantId: string;
  slug: string;
  displayName: string;
  description: string | null;
  section: string | null;  // T-0540
  nowMs: number;
}): Promise<ApplicationRow> {
  const { pool, tenantId, slug, displayName, description, section, nowMs } = args;
  const id = randomUUID();
  return withTenantTx(pool, tenantId, async (client) => {
    try {
      await client.query(
        `INSERT INTO choros.application
           (tenant_id, id, slug, display_name, description, section, tier, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $7)`,
        [tenantId, id, slug, displayName, description, section, nowMs],
      );
      // Re-select with the section JOIN so section_name is populated (T-0551).
      const row = await selectAppByIdTx(client, tenantId, id);
      return row!;
    } catch (err) {
      // 23505 = unique_violation → slug already taken within this tenant (AC-8).
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        throw new HttpError(409, "CONFLICT", `application slug '${slug}' already exists in this tenant`);
      }
      throw err;
    }
  });
}

// Sentinel thrown when a PATCH references a section_id not in the caller's tenant.
// Surfaced as 404 by the route (ADR §2.1: чужой/несуществующий раздел → 404).
class ForeignSectionError extends Error {}

// T-0540/T-0551: update section_id (and optionally display_name/description/legacy section).
async function patchApplication(
  pool: pg.Pool,
  tenantId: string,
  id: string,
  patch: {
    section?: string | null;
    section_id?: string | null;
    display_name?: string;
    description?: string | null;
  },
  nowMs: number,
): Promise<ApplicationRow | null> {
  return withTenantTx(pool, tenantId, async (client) => {
    // T-0551: validate section_id belongs to the caller's tenant (RLS-scoped) BEFORE
    // the update — a foreign/nonexistent id → 404 (ForeignSectionError), not a raw FK
    // 23503. NULL is always allowed («Без раздела»).
    if (patch.section_id !== undefined && patch.section_id !== null) {
      const chk = await client.query(
        `SELECT 1 FROM choros.section WHERE tenant_id = $1 AND id = $2`,
        [tenantId, patch.section_id],
      );
      if (chk.rowCount === 0) {
        throw new ForeignSectionError("section not found in tenant");
      }
    }

    // Build dynamic SET clause from provided fields.
    const setClauses: string[] = [];
    const params: unknown[] = [tenantId, id];

    if ("section" in patch) {
      params.push(patch.section ?? null);
      setClauses.push(`section = $${params.length}`);
    }
    if ("section_id" in patch) {
      params.push(patch.section_id ?? null);
      setClauses.push(`section_id = $${params.length}`);
    }
    if ("display_name" in patch && patch.display_name !== undefined) {
      params.push(patch.display_name);
      setClauses.push(`display_name = $${params.length}`);
    }
    if ("description" in patch) {
      params.push(patch.description ?? null);
      setClauses.push(`description = $${params.length}`);
    }

    if (setClauses.length === 0) {
      // Nothing to update — return current row.
      return selectAppByIdTx(client, tenantId, id);
    }

    params.push(nowMs);
    setClauses.push(`updated_at = $${params.length}`);

    const upd = await client.query(
      `UPDATE choros.application
          SET ${setClauses.join(", ")}
        WHERE tenant_id = $1 AND id = $2`,
      params,
    );
    if ((upd.rowCount ?? 0) === 0) return null;
    // Re-select with the section JOIN to return section_name (T-0551).
    return selectAppByIdTx(client, tenantId, id);
  });
}

// T-0567: delete one application within the caller's tenant.
//
// The application's OWN data — its registries (наборы полей) and their records —
// is removed in the same transaction (children first, tenant-scoped by RLS +
// explicit tenant_id), matching the honest consequence shown to the user:
// «Приложение и все его записи и наборы полей будут удалены безвозвратно».
//
// If some OTHER object still references the application or its registries
// (report_page, doc_page, template_def, cross_app_ref, …) Postgres raises a
// foreign_key_violation (SQLSTATE 23503); we surface that as a 409 CONFLICT so
// the caller sees an honest "still in use" error rather than a 500. The whole
// thing is one transaction, so a 409 rolls back the child deletes too.
//
// Returns true if an application row was deleted, false if none matched
// (not in tenant OR does not exist → the route maps that to 404).
async function deleteApplication(
  pool: pg.Pool,
  tenantId: string,
  id: string,
): Promise<boolean> {
  return withTenantTx(pool, tenantId, async (client) => {
    // Guard: does the app exist in this tenant at all? (distinguish 404 from 204).
    const exists = await client.query(
      `SELECT 1 FROM choros.application WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    if (exists.rowCount === 0) return false;

    try {
      // records → registry_defs → application (children first; FK is child→parent).
      await client.query(
        `DELETE FROM choros.record
           WHERE tenant_id = $1
             AND registry_id IN (
               SELECT id FROM choros.registry_def
                 WHERE tenant_id = $1 AND application_id = $2)`,
        [tenantId, id],
      );
      await client.query(
        `DELETE FROM choros.registry_def
           WHERE tenant_id = $1 AND application_id = $2`,
        [tenantId, id],
      );
      await client.query(
        `DELETE FROM choros.application WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
    } catch (err) {
      // 23503 = foreign_key_violation → the app (or one of its registries) is
      // still referenced by another object → honest 409, not a 500.
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23503") {
        throw new HttpError(
          409,
          "CONFLICT",
          "приложение используется другими объектами (отчёты, документы, связи) — удалите их сначала",
        );
      }
      throw err;
    }
    return true;
  });
}

async function listApplications(pool: pg.Pool, tenantId: string): Promise<ApplicationRow[]> {
  return withTenantTx(pool, tenantId, async (client) => {
    const res = await client.query<ApplicationRow>(
      `${APP_READ_SELECT}
        WHERE a.tenant_id = $1
        ORDER BY a.created_at DESC, a.slug ASC`,
      [tenantId],
    );
    return res.rows;
  });
}

async function getApplication(
  pool: pg.Pool,
  tenantId: string,
  id: string,
): Promise<ApplicationRow | null> {
  return withTenantTx(pool, tenantId, async (client) => {
    return selectAppByIdTx(client, tenantId, id);
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register the applications create/list/get routes.
 *
 * @param router HTTP router.
 * @param deps   Injected { pool, resolveActorTenant }. When omitted the routes are
 *               NOT registered (no-DB honest degrade — same as the other write APIs).
 */
export function registerApplicationRoutes(
  router: Router,
  deps?: ApplicationRoutesDeps,
): void {
  if (!deps) return;
  const { pool, resolveActorTenant } = deps;

  // POST /api/applications — create one application in the caller's tenant.
  // withAuth: in keycloak mode a valid Bearer JWT is REQUIRED (401 otherwise) and
  // the actor comes from the validated token (extractActor reads getAuthContext);
  // in dev mode withAuth is a no-op pass-through and the x-dev-user path is unchanged.
  router.register("POST", "/api/applications", withAuth(async (req: IncomingMessage, res: ServerResponse) => {
    const actor = await extractActor(req, pool);

    const rawBody = await readJsonBody(req);
    if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }
    const body = rawBody as Record<string, unknown>;

    const slug = body["slug"];
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
      throw new HttpError(
        400,
        "VALIDATION",
        "slug must be a lowercase alphanumeric/dash string (1-64 chars)",
      );
    }

    const displayName = body["display_name"];
    if (typeof displayName !== "string" || displayName.trim().length === 0) {
      throw new HttpError(400, "VALIDATION", "display_name must be a non-empty string");
    }
    if (displayName.length > 256) {
      throw new HttpError(400, "VALIDATION", "display_name must be at most 256 chars");
    }

    let description: string | null = null;
    if ("description" in body && body["description"] !== null && body["description"] !== undefined) {
      if (typeof body["description"] !== "string") {
        throw new HttpError(400, "VALIDATION", "description must be a string or null");
      }
      description = body["description"];
    }

    // T-0540: optional section (бизнес-функция / раздел для группировки в нав РАБОТА).
    let section: string | null = null;
    if ("section" in body && body["section"] !== null && body["section"] !== undefined) {
      if (typeof body["section"] !== "string") {
        throw new HttpError(400, "VALIDATION", "section must be a string or null");
      }
      if (body["section"].trim().length === 0) {
        throw new HttpError(400, "VALIDATION", "section must not be an empty string; use null to clear");
      }
      if (body["section"].length > 128) {
        throw new HttpError(400, "VALIDATION", "section must be at most 128 chars");
      }
      section = body["section"];
    }

    const tenantId = await resolveActorTenant(actor);
    const row = await createApplication({
      pool,
      tenantId,
      slug,
      displayName,
      description,
      section,
      nowMs: Date.now(),
    });

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(serializeApplication(row)));
  }));

  // GET /api/applications — list the caller-tenant's applications.
  router.register("GET", "/api/applications", withAuth(async (req: IncomingMessage, res: ServerResponse) => {
    const actor = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(actor);
    const rows = await listApplications(pool, tenantId);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ applications: rows.map(serializeApplication) }));
  }));

  // GET /api/applications/:id — get one application (404 if not in caller's tenant).
  router.register(
    "GET",
    "/api/applications/:id",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "application id");

      const actor = await extractActor(req, pool);
      const tenantId = await resolveActorTenant(actor);
      const row = await getApplication(pool, tenantId, id);
      if (row === null) {
        // Not in the caller's tenant (RLS-filtered) OR does not exist → 404.
        throw new HttpError(404, "NOT_FOUND", "application not found");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(serializeApplication(row)));
    }),
  );

  // PATCH /api/applications/:id — T-0540/T-0551: update section_id (раздел-сущность),
  // legacy section string, display_name, description.
  // Primary use: назначение раздела (screen-apps.jsx SetSectionModal + агент).
  // Body: { section_id?: string|null, section?: string|null, display_name?: string, description?: string|null }
  // Returns 200 with updated application; 404 if app OR referenced section_id not in caller's tenant.
  router.register(
    "PATCH",
    "/api/applications/:id",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "application id");

      const actor = await extractActor(req, pool);

      const rawBody = await readJsonBody(req);
      if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
      }
      const body = rawBody as Record<string, unknown>;

      // Build patch from provided fields (only what's present in body is updated).
      const patch: {
        section?: string | null;
        section_id?: string | null;
        display_name?: string;
        description?: string | null;
      } = {};

      // T-0551: section_id (раздел-сущность). null = «Без раздела». Foreign/unknown id → 404.
      if ("section_id" in body) {
        if (body["section_id"] === null || body["section_id"] === undefined) {
          patch.section_id = null;
        } else {
          if (typeof body["section_id"] !== "string" || !UUID_RE.test(body["section_id"] as string)) {
            throw new HttpError(400, "VALIDATION", "section_id must be a UUID or null");
          }
          patch.section_id = body["section_id"] as string;
        }
      }

      if ("section" in body) {
        if (body["section"] === null || body["section"] === undefined) {
          patch.section = null;  // явная очистка раздела
        } else {
          if (typeof body["section"] !== "string") {
            throw new HttpError(400, "VALIDATION", "section must be a string or null");
          }
          if ((body["section"] as string).trim().length === 0) {
            throw new HttpError(400, "VALIDATION", "section must not be an empty string; use null to clear");
          }
          if ((body["section"] as string).length > 128) {
            throw new HttpError(400, "VALIDATION", "section must be at most 128 chars");
          }
          patch.section = body["section"] as string;
        }
      }

      if ("display_name" in body) {
        if (typeof body["display_name"] !== "string" || (body["display_name"] as string).trim().length === 0) {
          throw new HttpError(400, "VALIDATION", "display_name must be a non-empty string");
        }
        if ((body["display_name"] as string).length > 256) {
          throw new HttpError(400, "VALIDATION", "display_name must be at most 256 chars");
        }
        patch.display_name = body["display_name"] as string;
      }

      if ("description" in body) {
        if (body["description"] !== null && body["description"] !== undefined) {
          if (typeof body["description"] !== "string") {
            throw new HttpError(400, "VALIDATION", "description must be a string or null");
          }
          patch.description = body["description"] as string;
        } else {
          patch.description = null;
        }
      }

      const tenantId = await resolveActorTenant(actor);
      let row: ApplicationRow | null;
      try {
        row = await patchApplication(pool, tenantId, id, patch, Date.now());
      } catch (err) {
        if (err instanceof ForeignSectionError) {
          // Referenced section_id is not in the caller's tenant (ADR §2.1).
          throw new HttpError(404, "NOT_FOUND", "section not found");
        }
        throw err;
      }
      if (row === null) {
        throw new HttpError(404, "NOT_FOUND", "application not found");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(serializeApplication(row)));
    }),
  );

  // DELETE /api/applications/:id — T-0567: delete an application + its own data.
  // Frozen contract: 204 (deleted, no body) · 404 (not in caller's tenant) ·
  // 409 (still referenced by other objects). The app's registries + records are
  // removed in the same transaction (see deleteApplication).
  router.register(
    "DELETE",
    "/api/applications/:id",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "application id");

      const actor = await extractActor(req, pool);
      const tenantId = await resolveActorTenant(actor);
      const deleted = await deleteApplication(pool, tenantId, id);
      if (!deleted) {
        // Not in the caller's tenant (RLS-filtered) OR does not exist → 404.
        throw new HttpError(404, "NOT_FOUND", "application not found");
      }

      res.statusCode = 204;
      res.end();
    }),
  );
}
