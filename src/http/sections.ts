/**
 * src/http/sections.ts — T-0551 E-NAV-IA: sections (разделы) CRUD API.
 *
 * Раздел = первоклассная сущность рабочего пространства (ELMA-папка), а НЕ атрибут
 * приложения. РЕВЕРС T-0540 (раздел=строка `application.section`). ADR
 * docs/design/T-0551-sections-as-entity.adr.md (PD-24).
 *
 * Registers (over the NEW choros.section table, migration 113):
 *   GET    /api/sections      → list the caller-tenant's sections (sort_order, name)
 *   POST   /api/sections      → create one section (201; 409 dup name in tenant)
 *   PATCH  /api/sections/:id  → rename / reorder (name?, sort_order?)
 *   DELETE /api/sections/:id  → SOFT delete: apps → section_id=NULL, then drop section
 *
 * MULTI-TENANT (mandatory, T-0013): every operation runs inside withTenantTx under
 * SET LOCAL choros.tenant_id = '<actor-tenant>' + FORCE RLS (policy
 * section_tenant_isolation). The actor's REAL tenant is resolved from the dev-user
 * slug / KC sub — NEVER from the request body or an attacker header. A caller in
 * tenant A therefore cannot list, read, mutate, or delete tenant B's sections
 * (RLS-enforced). DELETE/PATCH of a foreign id RLS-filters to 0 rows → 404.
 *
 * DEPS INJECTION (mirrors applications.ts): the composition root supplies
 * { pool, resolveActorTenant }. When absent (no DATABASE_URL) the routes are NOT
 * registered — same honest-degrade contract as the other DB-backed write APIs.
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

const SECTION_NAME_MAX = 128;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// Injected deps (mirrors ApplicationRoutesDeps)
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

export interface SectionRoutesDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
}

// ---------------------------------------------------------------------------
// withTenantTx — canonical RLS pattern (mirrors applications.ts)
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
// extractActor — caller identity, mode-aware (mirrors applications.ts)
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

interface SectionRow {
  id: string;
  name: string;
  sort_order: number;
  created_at: string | number; // bigint comes back as a string from node-postgres
  updated_at: string | number;
}

function serializeSection(row: SectionRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    sort_order: Number(row.sort_order),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

const SECTION_SELECT_COLS = "id, name, sort_order, created_at, updated_at";

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

async function listSections(pool: pg.Pool, tenantId: string): Promise<SectionRow[]> {
  return withTenantTx(pool, tenantId, async (client) => {
    const res = await client.query<SectionRow>(
      `SELECT ${SECTION_SELECT_COLS}
         FROM choros.section
        WHERE tenant_id = $1
        ORDER BY sort_order ASC, name ASC`,
      [tenantId],
    );
    return res.rows;
  });
}

async function createSection(args: {
  pool: pg.Pool;
  tenantId: string;
  name: string;
  sortOrder: number;
  nowMs: number;
}): Promise<SectionRow> {
  const { pool, tenantId, name, sortOrder, nowMs } = args;
  const id = randomUUID();
  return withTenantTx(pool, tenantId, async (client) => {
    try {
      const res = await client.query<SectionRow>(
        `INSERT INTO choros.section
           (tenant_id, id, name, sort_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         RETURNING ${SECTION_SELECT_COLS}`,
        [tenantId, id, name, sortOrder, nowMs],
      );
      return res.rows[0]!;
    } catch (err) {
      // 23505 = unique_violation → section name already taken within this tenant.
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        throw new HttpError(409, "CONFLICT", `section name '${name}' already exists in this tenant`);
      }
      throw err;
    }
  });
}

async function patchSection(
  pool: pg.Pool,
  tenantId: string,
  id: string,
  patch: { name?: string; sort_order?: number },
  nowMs: number,
): Promise<SectionRow | null> {
  const setClauses: string[] = [];
  const params: unknown[] = [tenantId, id];

  if (patch.name !== undefined) {
    params.push(patch.name);
    setClauses.push(`name = $${params.length}`);
  }
  if (patch.sort_order !== undefined) {
    params.push(patch.sort_order);
    setClauses.push(`sort_order = $${params.length}`);
  }

  if (setClauses.length === 0) {
    // Nothing to update — return current row (404 if absent / cross-tenant).
    return withTenantTx(pool, tenantId, async (client) => {
      const res = await client.query<SectionRow>(
        `SELECT ${SECTION_SELECT_COLS} FROM choros.section WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      return res.rows[0] ?? null;
    });
  }

  params.push(nowMs);
  setClauses.push(`updated_at = $${params.length}`);

  return withTenantTx(pool, tenantId, async (client) => {
    try {
      const res = await client.query<SectionRow>(
        `UPDATE choros.section
            SET ${setClauses.join(", ")}
          WHERE tenant_id = $1 AND id = $2
          RETURNING ${SECTION_SELECT_COLS}`,
        params,
      );
      return res.rows[0] ?? null;
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        throw new HttpError(409, "CONFLICT", `section name '${patch.name}' already exists in this tenant`);
      }
      throw err;
    }
  });
}

/**
 * SOFT delete (ADR §2): detach apps (section_id → NULL), THEN delete the section,
 * both in ONE tenant tx. Applications are NOT deleted. Returns false if the section
 * does not exist in the caller's tenant (RLS-filtered → 0 rows deleted → 404).
 */
async function deleteSection(pool: pg.Pool, tenantId: string, id: string): Promise<boolean> {
  return withTenantTx(pool, tenantId, async (client) => {
    // Detach first (apps move to «Без раздела»). The composite FK ON DELETE SET NULL
    // would also do this, but we do it explicitly so the contract is visible + the
    // updated_at on touched apps could be bumped if desired later.
    await client.query(
      `UPDATE choros.application SET section_id = NULL WHERE tenant_id = $1 AND section_id = $2`,
      [tenantId, id],
    );
    const res = await client.query(
      `DELETE FROM choros.section WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return (res.rowCount ?? 0) > 0;
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSectionRoutes(
  router: Router,
  deps?: SectionRoutesDeps,
): void {
  if (!deps) return;
  const { pool, resolveActorTenant } = deps;

  // GET /api/sections — list the caller-tenant's sections (sort_order, name).
  router.register("GET", "/api/sections", withAuth(async (req: IncomingMessage, res: ServerResponse) => {
    const actor = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(actor);
    const rows = await listSections(pool, tenantId);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ sections: rows.map(serializeSection) }));
  }));

  // POST /api/sections — create one section in the caller's tenant.
  router.register("POST", "/api/sections", withAuth(async (req: IncomingMessage, res: ServerResponse) => {
    const actor = await extractActor(req, pool);

    const rawBody = await readJsonBody(req);
    if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }
    const body = rawBody as Record<string, unknown>;

    const name = body["name"];
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new HttpError(400, "VALIDATION", "name must be a non-empty string");
    }
    const trimmedName = name.trim();
    if (trimmedName.length > SECTION_NAME_MAX) {
      throw new HttpError(400, "VALIDATION", `name must be at most ${SECTION_NAME_MAX} chars`);
    }

    let sortOrder = 0;
    if ("sort_order" in body && body["sort_order"] !== null && body["sort_order"] !== undefined) {
      if (typeof body["sort_order"] !== "number" || !Number.isInteger(body["sort_order"])) {
        throw new HttpError(400, "VALIDATION", "sort_order must be an integer");
      }
      sortOrder = body["sort_order"];
    }

    const tenantId = await resolveActorTenant(actor);
    const row = await createSection({ pool, tenantId, name: trimmedName, sortOrder, nowMs: Date.now() });

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(serializeSection(row)));
  }));

  // PATCH /api/sections/:id — rename / reorder. Identity preserved.
  router.register(
    "PATCH",
    "/api/sections/:id",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "section id");

      const actor = await extractActor(req, pool);

      const rawBody = await readJsonBody(req);
      if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
      }
      const body = rawBody as Record<string, unknown>;

      const patch: { name?: string; sort_order?: number } = {};

      if ("name" in body) {
        if (typeof body["name"] !== "string" || (body["name"] as string).trim().length === 0) {
          throw new HttpError(400, "VALIDATION", "name must be a non-empty string");
        }
        const trimmed = (body["name"] as string).trim();
        if (trimmed.length > SECTION_NAME_MAX) {
          throw new HttpError(400, "VALIDATION", `name must be at most ${SECTION_NAME_MAX} chars`);
        }
        patch.name = trimmed;
      }

      if ("sort_order" in body) {
        if (typeof body["sort_order"] !== "number" || !Number.isInteger(body["sort_order"])) {
          throw new HttpError(400, "VALIDATION", "sort_order must be an integer");
        }
        patch.sort_order = body["sort_order"] as number;
      }

      const tenantId = await resolveActorTenant(actor);
      const row = await patchSection(pool, tenantId, id, patch, Date.now());
      if (row === null) {
        throw new HttpError(404, "NOT_FOUND", "section not found");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(serializeSection(row)));
    }),
  );

  // DELETE /api/sections/:id — SOFT: apps → section_id=NULL, then delete section.
  router.register(
    "DELETE",
    "/api/sections/:id",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "section id");

      const actor = await extractActor(req, pool);
      const tenantId = await resolveActorTenant(actor);
      const deleted = await deleteSection(pool, tenantId, id);
      if (!deleted) {
        throw new HttpError(404, "NOT_FOUND", "section not found");
      }

      res.statusCode = 204;
      res.end();
    }),
  );
}
