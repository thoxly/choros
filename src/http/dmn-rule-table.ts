/**
 * src/http/dmn-rule-table.ts — T-0433
 *
 * DMN Rule Table WRITE API routes.
 *
 * Endpoints:
 *   GET  /api/dmn-rule-tables               — list (incl. drafts), ?processKey= filter
 *   GET  /api/dmn-rule-tables/:id           — get by id (cross-tenant → 404)
 *   POST /api/dmn-rule-tables               — validate → upsert draft → 201 with id
 *   POST /api/dmn-rule-tables/:id/publish   — flip status draft→published → 200
 *
 * Auth / authz pattern (verbatim mirror of floor1-editor.ts / binding.ts):
 *   - withAuth wrapper (keycloak mode requires valid Bearer; dev mode no-op)
 *   - process_designer role check via checkRole (imported from binding.ts)
 *   - withTenantTx for DB access (RLS enforced via SET LOCAL choros.tenant_id)
 *   - Actor slug resolved from validated token (keycloak) or x-dev-user (dev)
 *
 * Error conventions (mirror of binding.ts / floor1-editor.ts):
 *   201  — created (POST upsert)
 *   200  — ok (GET, POST publish)
 *   400  — VALIDATION | invalid input / violations
 *   401  — UNAUTHENTICATED | missing or invalid identity
 *   403  — FORBIDDEN | role process_designer missing
 *   404  — NOT_FOUND | id not in this tenant / route not matched
 *
 * D-056 integration-honest: rows land in choros.dmn_rule_table, the SAME table
 * read by loadPublishedRuleTables. The publish endpoint flips status='published'
 * so the runtime evaluator picks up the authored table immediately.
 */

import type { IncomingMessage } from "node:http";
import type pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, getAuthMode, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import { checkRole, withTenantTx } from "./binding.js";
import { validateDmnRuleTable } from "../core/dmn-rule-table-validate.js";
import {
  upsertRuleTableDraft,
  getRuleTableById,
  listRuleTables,
  publishRuleTable,
} from "../db/dmn-rule-table-store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/**
 * Mode-aware actor slug extraction — verbatim pattern from binding.ts.
 * Keycloak: resolves slug from validated token (401 if no match).
 * Dev: reads x-dev-user header (401 if missing).
 */
async function extractActorSlug(
  req: IncomingMessage,
  pool: pg.Pool,
): Promise<string> {
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

/**
 * process_designer role check (dev mode softens to authenticated).
 * Mirrors the authorizeEditor pattern from floor1-editor.ts.
 */
async function authorizeDesigner(
  pool: pg.Pool,
  tenantId: string,
  actorSlug: string,
): Promise<void> {
  if (getAuthMode() === "dev") {
    return; // dev mode: authenticated = sufficient
  }
  await withTenantTx(pool, tenantId, (client) =>
    checkRole(client, tenantId, actorSlug),
  );
}

// ---------------------------------------------------------------------------
// URL parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse /api/dmn-rule-tables or /api/dmn-rule-tables/:id[/publish]
 * Returns { id: string|null, publish: boolean } or null if no match.
 */
interface DmnUrlParts {
  id: string | null;
  publish: boolean;
}

function parseDmnUrl(rawUrl: string): DmnUrlParts | null {
  const qIdx = rawUrl.indexOf("?");
  const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  // Remove trailing slash
  const path = pathname.replace(/\/$/, "");

  // /api/dmn-rule-tables
  if (path === "/api/dmn-rule-tables") {
    return { id: null, publish: false };
  }

  const parts = path.split("/");
  // Expected: ["", "api", "dmn-rule-tables", id] or [..., id, "publish"]
  if (
    parts.length >= 4 &&
    parts[1] === "api" &&
    parts[2] === "dmn-rule-tables"
  ) {
    const id = decodeURIComponent(parts[3] ?? "");
    if (parts.length === 4) {
      return { id, publish: false };
    }
    if (parts.length === 5 && parts[4] === "publish") {
      return { id, publish: true };
    }
  }

  return null;
}

function getQueryParam(rawUrl: string, key: string): string | null {
  const qIdx = rawUrl.indexOf("?");
  if (qIdx === -1) return null;
  const params = new URLSearchParams(rawUrl.slice(qIdx + 1));
  return params.get(key);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register DMN rule table routes.
 *
 * All routes require pool (DATABASE_URL must be set). The caller (server.ts)
 * gates registration on `grantsPool` existence — matching the pattern used by
 * registerBindingRoutes, registerApplicationRoutes, etc.
 */
export function registerDmnRuleTableRoutes(
  router: Router,
  pool: pg.Pool,
): void {

  // ---- GET /api/dmn-rule-tables (?processKey=...) ----
  // List all DMN rule tables for the actor's tenant, including drafts.
  router.register(
    "GET",
    "/api/dmn-rule-tables",
    withAuth(async (req, res, _params) => {
      const actor = await extractActorSlug(req, pool);

      // Resolve tenantId from actor membership
      const { resolveActorTenant, getOrgPool } = await import("../db/org.js");
      const tenantId = await resolveActorTenant(getOrgPool(), actor);
      assertUuidShape(tenantId, "tenantId");

      const processKey = getQueryParam(req.url ?? "", "processKey") ?? undefined;

      const rows = await withTenantTx(pool, tenantId, (client) =>
        listRuleTables(client, tenantId, processKey),
      );

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(rows));
    }),
  );

  // ---- GET /api/dmn-rule-tables/:id ----
  // Get a single DMN rule table by id (cross-tenant → 404 via RLS).
  router.register(
    "GET",
    "/api/dmn-rule-tables/:id",
    withAuth(async (req, res, _params) => {
      const actor = await extractActorSlug(req, pool);

      const urlParts = parseDmnUrl(req.url ?? "");
      if (!urlParts || urlParts.id === null) {
        throw new HttpError(404, "NOT_FOUND", "route not found");
      }
      const { id } = urlParts;

      const { resolveActorTenant, getOrgPool } = await import("../db/org.js");
      const tenantId = await resolveActorTenant(getOrgPool(), actor);
      assertUuidShape(tenantId, "tenantId");

      if (!isUuid(id)) {
        throw new HttpError(404, "NOT_FOUND", "dmn-rule-table not found");
      }

      const row = await withTenantTx(pool, tenantId, (client) =>
        getRuleTableById(client, tenantId, id),
      );

      if (!row) {
        throw new HttpError(404, "NOT_FOUND", "dmn-rule-table not found");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(row));
    }),
  );

  // ---- POST /api/dmn-rule-tables ----
  // Validate input → upsert draft → 201 with id.
  // Invalid input → 400 with violations array.
  router.register(
    "POST",
    "/api/dmn-rule-tables",
    withAuth(async (req, res, _params) => {
      const actor = await extractActorSlug(req, pool);

      const rawBody = await readJsonBody(req);
      if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
      }
      const body = rawBody as Record<string, unknown>;

      // Extract optional processKey from body
      const processKey =
        typeof body["processKey"] === "string" && body["processKey"].trim().length > 0
          ? body["processKey"].trim()
          : null;

      // Validate the DMN rule table definition
      const validation = validateDmnRuleTable(rawBody);
      if (!validation.ok) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: "VALIDATION",
            message: "DMN rule table validation failed",
            violations: validation.violations,
          }),
        );
        return;
      }

      const { resolveActorTenant, getOrgPool } = await import("../db/org.js");
      const tenantId = await resolveActorTenant(getOrgPool(), actor);
      assertUuidShape(tenantId, "tenantId");

      // Role check: process_designer required
      await authorizeDesigner(pool, tenantId, actor);

      const id = await withTenantTx(pool, tenantId, (client) =>
        upsertRuleTableDraft(client, tenantId, validation.value, processKey),
      );

      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id }));
    }),
  );

  // ---- POST /api/dmn-rule-tables/:id/publish ----
  // Flip status 'draft' → 'published'. Cross-tenant → 404.
  router.register(
    "POST",
    "/api/dmn-rule-tables/:id/publish",
    withAuth(async (req, res, _params) => {
      const actor = await extractActorSlug(req, pool);

      const urlParts = parseDmnUrl(req.url ?? "");
      if (!urlParts || !urlParts.publish || urlParts.id === null) {
        throw new HttpError(404, "NOT_FOUND", "route not found");
      }
      const { id } = urlParts;

      if (!isUuid(id)) {
        throw new HttpError(404, "NOT_FOUND", "dmn-rule-table not found");
      }

      const { resolveActorTenant, getOrgPool } = await import("../db/org.js");
      const tenantId = await resolveActorTenant(getOrgPool(), actor);
      assertUuidShape(tenantId, "tenantId");

      // Role check: process_designer required
      await authorizeDesigner(pool, tenantId, actor);

      const updated = await withTenantTx(pool, tenantId, (client) =>
        publishRuleTable(client, tenantId, id),
      );

      if (!updated) {
        throw new HttpError(404, "NOT_FOUND", "dmn-rule-table not found");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id, status: "published" }));
    }),
  );
}
