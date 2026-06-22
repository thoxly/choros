/**
 * src/http/rights-sod-admin.ts — T-0386 [D6]: SoD constraint CRUD write API
 *
 * Registers the write-surface for SoD constraint authoring:
 *   POST   /api/rights/sod-rules          — create a new sod_constraint row
 *   PUT    /api/rights/sod-rules/:id      — full/partial update of a row
 *   DELETE /api/rights/sod-rules/:id      — hard-delete a row
 *
 * All three routes:
 *   1. Authenticate via withAuth (Keycloak JWT or x-dev-user header).
 *   2. Resolve actor → tenant via resolveActorTenant.
 *   3. Gate on isGenesisOwner (loadAdminContext) — the same owner gate that
 *      guards org-write endpoints (seed-write.ts). SoD constraint authoring is a
 *      tenant-level structural write, not a scoped-admin mgmt_object action.
 *      A non-owner actor receives 403 NOT_OWNER.
 *   4. Execute the CRUD operation via sod-dao.ts helpers (RLS-scoped to the
 *      actor's own tenant; tenant_id is NEVER trusted from the request body).
 *
 * Response shapes:
 *   POST  201  { id: string }
 *   PUT   200  { updated: true }
 *   DELETE 200 { deleted: true }
 *
 * Error codes:
 *   400 VALIDATION   — malformed body / shape violation
 *   403 NOT_OWNER    — actor is not the tenant genesis-owner
 *   404 NOT_FOUND    — constraintId does not exist in tenant
 *
 * ── Routing order ─────────────────────────────────────────────────────────────
 * These routes share the /api/rights/sod-rules prefix with the read routes in
 * rights-sod.ts. The read-routes use LITERAL paths (no :id slot); the write
 * routes with /:id are distinct. Register BEFORE registerRightsRoutes
 * (GET /api/rights/:roleId catch-all) so "sod-rules" is never swallowed by the
 * param slot. The existing registration order in server.ts (sod read, then sod
 * admin, then rights catch-all) satisfies this.
 *
 * ── Rule-9 ────────────────────────────────────────────────────────────────────
 * Does NOT touch: src/http/rights-sod.ts (read API, frozen), src/core/sod.ts,
 * src/core/grant-resolver.ts, src/http/grants.ts, src/http/seed-write.ts,
 * src/http/inbox.ts, src/http/process-defs.ts, any migration.
 */

import pg from "pg";
import {
  resolveActorTenant,
  resolveActorSlugFromAuth,
  loadAdminContext,
} from "../db/org.js";
import {
  createSodConstraint,
  updateSodConstraint,
  deleteSodConstraint,
  SodValidationError,
  type CreateSodConstraintInput,
  type UpdateSodConstraintInput,
} from "../db/sod-dao.js";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidParam(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// Actor extraction (mirrors rights-sod.ts / rights-change-requests.ts pattern)
// ---------------------------------------------------------------------------

async function extractActorFromReq(
  req: import("node:http").IncomingMessage,
  pool: pg.Pool,
): Promise<string> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    const slug = await resolveActorSlugFromAuth(
      pool,
      ctx.sub,
      ctx.preferredUsername,
    );
    if (slug === null) {
      throw new HttpError(
        401,
        "UNAUTHENTICATED",
        "no employee matches authenticated identity",
      );
    }
    return slug;
  }
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(
      401,
      "UNAUTHENTICATED",
      "missing x-dev-user header",
    );
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// Authz gate — isGenesisOwner (mirrors seed-write.ts org-write pattern)
// ---------------------------------------------------------------------------

async function requireGenesisOwner(
  pool: pg.Pool,
  tenantId: string,
  actorId: string,
): Promise<void> {
  const nowMs = Date.now();
  const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);
  if (!admin.isGenesisOwner) {
    throw new HttpError(
      403,
      "NOT_OWNER",
      "genesis owner required to manage SoD constraints",
    );
  }
}

// ---------------------------------------------------------------------------
// Body parsers / validators
// ---------------------------------------------------------------------------

function parseCreateBody(body: unknown): CreateSodConstraintInput {
  const b = body as Record<string, unknown>;

  const kind = b["kind"];
  if (kind !== "static" && kind !== "dynamic") {
    throw new HttpError(
      400,
      "VALIDATION",
      "kind must be 'static' or 'dynamic'",
    );
  }

  const scope = b["scope"];
  if (scope === undefined || scope === null) {
    throw new HttpError(
      400,
      "VALIDATION",
      "scope is required (grant-lattice ScopeElement-shaped jsonb)",
    );
  }

  const roleA = b["roleA"] as string | null | undefined;
  const roleB = b["roleB"] as string | null | undefined;

  if (kind === "static" && (roleA == null || roleB == null)) {
    throw new HttpError(
      400,
      "VALIDATION",
      "static SoD constraint requires roleA and roleB (the incompatible role pair)",
    );
  }

  const selfRecord = b["selfRecord"];

  return {
    kind,
    roleA: typeof roleA === "string" ? roleA : null,
    roleB: typeof roleB === "string" ? roleB : null,
    selfRecord: typeof selfRecord === "boolean" ? selfRecord : false,
    scope,
    detail:
      b["detail"] != null && typeof b["detail"] === "object"
        ? (b["detail"] as Record<string, unknown>)
        : null,
  };
}

function parseUpdateBody(body: unknown): UpdateSodConstraintInput {
  const b = body as Record<string, unknown>;
  const result: UpdateSodConstraintInput = {};

  if ("roleA" in b) {
    result.roleA =
      typeof b["roleA"] === "string" ? b["roleA"] : null;
  }
  if ("roleB" in b) {
    result.roleB =
      typeof b["roleB"] === "string" ? b["roleB"] : null;
  }
  if ("selfRecord" in b && typeof b["selfRecord"] === "boolean") {
    result.selfRecord = b["selfRecord"];
  }
  if ("scope" in b && b["scope"] != null) {
    result.scope = b["scope"];
  }
  if ("detail" in b) {
    result.detail =
      b["detail"] != null && typeof b["detail"] === "object"
        ? (b["detail"] as Record<string, unknown>)
        : null;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSodAdminRoutes(router: Router, pool: pg.Pool): void {
  // ── POST /api/rights/sod-rules — create a new SoD constraint ─────────────
  // Body: CreateSodConstraintInput
  // 201: { id: string }
  router.register(
    "POST",
    "/api/rights/sod-rules",
    withAuth(async (req, res) => {
      const actorId = await extractActorFromReq(req, pool);
      const tenantId = await resolveActorTenant(pool, actorId);
      await requireGenesisOwner(pool, tenantId, actorId);

      const body = await readJsonBody(req);
      let input: CreateSodConstraintInput;
      try {
        input = parseCreateBody(body);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, "VALIDATION", String(err));
      }

      let id: string;
      try {
        id = await createSodConstraint(pool, tenantId, input);
      } catch (err) {
        if (err instanceof SodValidationError) {
          throw new HttpError(400, "VALIDATION", err.message);
        }
        throw err;
      }

      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id }));
    }),
  );

  // ── PUT /api/rights/sod-rules/:id — update a SoD constraint (partial) ───
  // Body: UpdateSodConstraintInput
  // 200: { updated: true }
  // 404: NOT_FOUND
  router.register(
    "PUT",
    "/api/rights/sod-rules/:id",
    withAuth(async (req, res, params) => {
      const constraintId = params?.["id"] ?? "";
      assertUuidParam(constraintId, "constraintId");

      const actorId = await extractActorFromReq(req, pool);
      const tenantId = await resolveActorTenant(pool, actorId);
      await requireGenesisOwner(pool, tenantId, actorId);

      const body = await readJsonBody(req);
      let input: UpdateSodConstraintInput;
      try {
        input = parseUpdateBody(body);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, "VALIDATION", String(err));
      }

      let found: boolean;
      try {
        found = await updateSodConstraint(pool, tenantId, constraintId, input);
      } catch (err) {
        if (err instanceof SodValidationError) {
          throw new HttpError(400, "VALIDATION", err.message);
        }
        throw err;
      }

      if (!found) {
        throw new HttpError(
          404,
          "NOT_FOUND",
          `sod_constraint ${constraintId} not found in tenant`,
        );
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ updated: true }));
    }),
  );

  // ── DELETE /api/rights/sod-rules/:id — delete a SoD constraint ──────────
  // 200: { deleted: true }
  // 404: NOT_FOUND
  router.register(
    "DELETE",
    "/api/rights/sod-rules/:id",
    withAuth(async (req, res, params) => {
      const constraintId = params?.["id"] ?? "";
      assertUuidParam(constraintId, "constraintId");

      const actorId = await extractActorFromReq(req, pool);
      const tenantId = await resolveActorTenant(pool, actorId);
      await requireGenesisOwner(pool, tenantId, actorId);

      const found = await deleteSodConstraint(pool, tenantId, constraintId);
      if (!found) {
        throw new HttpError(
          404,
          "NOT_FOUND",
          `sod_constraint ${constraintId} not found in tenant`,
        );
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ deleted: true }));
    }),
  );
}
