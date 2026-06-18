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
import { DEV_USER_HEADER, getAuthContext } from "./auth.js";

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
// extractActor — caller identity (mirrors registry-defs.ts / process-start.ts)
// ---------------------------------------------------------------------------

function extractActor(req: IncomingMessage): string {
  // Keycloak mode: AuthContext is set by withAuth() middleware before the handler.
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    return ctx.sub;
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
    tier: row.tier,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

const APP_SELECT_COLS =
  "id, slug, display_name, description, tier, created_at, updated_at";

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

async function createApplication(args: {
  pool: pg.Pool;
  tenantId: string;
  slug: string;
  displayName: string;
  description: string | null;
  nowMs: number;
}): Promise<ApplicationRow> {
  const { pool, tenantId, slug, displayName, description, nowMs } = args;
  const id = randomUUID();
  return withTenantTx(pool, tenantId, async (client) => {
    try {
      const res = await client.query<ApplicationRow>(
        `INSERT INTO choros.application
           (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'draft', $6, $6)
         RETURNING ${APP_SELECT_COLS}`,
        [tenantId, id, slug, displayName, description, nowMs],
      );
      return res.rows[0]!;
    } catch (err) {
      // 23505 = unique_violation → slug already taken within this tenant (AC-8).
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        throw new HttpError(409, "CONFLICT", `application slug '${slug}' already exists in this tenant`);
      }
      throw err;
    }
  });
}

async function listApplications(pool: pg.Pool, tenantId: string): Promise<ApplicationRow[]> {
  return withTenantTx(pool, tenantId, async (client) => {
    const res = await client.query<ApplicationRow>(
      `SELECT ${APP_SELECT_COLS}
         FROM choros.application
        WHERE tenant_id = $1
        ORDER BY created_at DESC, slug ASC`,
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
    const res = await client.query<ApplicationRow>(
      `SELECT ${APP_SELECT_COLS}
         FROM choros.application
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return res.rows[0] ?? null;
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
  router.register("POST", "/api/applications", async (req: IncomingMessage, res: ServerResponse) => {
    const actor = extractActor(req);

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

    const tenantId = await resolveActorTenant(actor);
    const row = await createApplication({
      pool,
      tenantId,
      slug,
      displayName,
      description,
      nowMs: Date.now(),
    });

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(serializeApplication(row)));
  });

  // GET /api/applications — list the caller-tenant's applications.
  router.register("GET", "/api/applications", async (req: IncomingMessage, res: ServerResponse) => {
    const actor = extractActor(req);
    const tenantId = await resolveActorTenant(actor);
    const rows = await listApplications(pool, tenantId);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ applications: rows.map(serializeApplication) }));
  });

  // GET /api/applications/:id — get one application (404 if not in caller's tenant).
  router.register(
    "GET",
    "/api/applications/:id",
    async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "application id");

      const actor = extractActor(req);
      const tenantId = await resolveActorTenant(actor);
      const row = await getApplication(pool, tenantId, id);
      if (row === null) {
        // Not in the caller's tenant (RLS-filtered) OR does not exist → 404.
        throw new HttpError(404, "NOT_FOUND", "application not found");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(serializeApplication(row)));
    },
  );
}
