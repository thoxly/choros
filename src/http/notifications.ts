/**
 * src/http/notifications.ts — T-0173 E-N.6
 *
 * REST endpoints for notification center:
 *   GET  /api/notifications               — keyset-paginated listing (own-only)
 *   GET  /api/notifications/unread-count  — badge count (partial index)
 *   POST /api/notifications/:id/read      — mark one as read
 *   PATCH /api/notifications              — batch mark-read
 *
 * DESIGN INVARIANTS (ADR T-0120 §2.2/§2.7/§5 E-N.6):
 *  - recipient_id ALWAYS = actor (server-constructed from X-Dev-User header).
 *    Never from query params or request body (FF-OWN-ONLY-READ).
 *  - mark-read: UPDATE WHERE id=$1 AND recipient_id=actor. Foreign row → 404 (FF-NO-CROSS-USER).
 *  - Tenant-context fail-closed: no X-Dev-User → 401; SET LOCAL GUC before every SQL.
 *  - No appendAuditEvent anywhere (FF-NO-ISREAD-AUDIT: is_read not audited per ADR §2.8).
 *  - No second at-least-once: mark-read = direct UPDATE, not outbox.
 *  - Routing to /unread-count registered before /:id/read to avoid id-match on literal segment.
 */

import pg from "pg";
import {
  PgNotificationStore,
  serializeCursor,
  deserializeCursor,
} from "../core/postgres/pgNotificationStore.js";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// withTenantTx helper (mirrors notification-prefs.ts pattern)
// Opens a pg transaction, sets choros.tenant_id GUC SET LOCAL, runs fn, commits.
// ---------------------------------------------------------------------------

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

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
// Actor extraction helper
// ---------------------------------------------------------------------------

async function extractActor(req: import("node:http").IncomingMessage, pool: pg.Pool): Promise<string> {
  // T-0372: resolve KC sub → employee slug.
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
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the four notification-center endpoints.
 *
 * Route registration order matters:
 *   GET /api/notifications/unread-count  — registered BEFORE /:id/read to avoid
 *   the router matching 'unread-count' as an :id parameter.
 */
export function registerNotificationRoutes(
  router: Router,
  pool: pg.Pool,
): void {
  const store = new PgNotificationStore(pool);

  // -------------------------------------------------------------------------
  // GET /api/notifications  — own notification listing, keyset-paginated
  // -------------------------------------------------------------------------
  router.register("GET", "/api/notifications", withAuth(async (req, res) => {
    const actorId = await extractActor(req, pool);
    const tenantId = DEV_TENANT_ID;

    // Parse query parameters
    const rawUrl = req.url ?? "/";
    const qIdx = rawUrl.indexOf("?");
    const qs = qIdx !== -1 ? rawUrl.slice(qIdx + 1) : "";
    const params = new URLSearchParams(qs);

    const limitRaw = params.get("limit");
    const limit = limitRaw !== null ? Math.max(1, Math.min(Number(limitRaw) || 20, 100)) : 20;

    const cursorRaw = params.get("cursor");
    const cursor = cursorRaw ? deserializeCursor(cursorRaw) : null;

    const isReadRaw = params.get("is_read");
    let isRead: boolean | null = null;
    if (isReadRaw === "true") isRead = true;
    else if (isReadRaw === "false") isRead = false;

    const result = await withTenantTx(pool, tenantId, (client) =>
      store.list(client, {
        recipientId: actorId,   // FF-OWN-ONLY-READ: always actor, never from params
        limit,
        cursor,
        isRead,
      }),
    );

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      notifications: result.rows,
      nextCursor: result.nextCursor ? serializeCursor(result.nextCursor) : null,
    }));
  }));

  // -------------------------------------------------------------------------
  // GET /api/notifications/unread-count  — badge: COUNT by partial index
  // NOTE: registered BEFORE /:id/read to prevent router matching 'unread-count' as :id
  // -------------------------------------------------------------------------
  router.register("GET", "/api/notifications/unread-count", withAuth(async (req, res) => {
    const actorId = await extractActor(req, pool);
    const tenantId = DEV_TENANT_ID;

    const count = await withTenantTx(pool, tenantId, (client) =>
      store.countUnread(client, actorId),   // FF-OWN-ONLY-READ: actorId server-constructed
    );

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ count }));
  }));

  // -------------------------------------------------------------------------
  // POST /api/notifications/:id/read  — mark single notification as read
  // -------------------------------------------------------------------------
  router.register("POST", "/api/notifications/:id/read", withAuth(async (req, res, params) => {
    const actorId = await extractActor(req, pool);
    const tenantId = DEV_TENANT_ID;

    const notifId = params["id"];
    if (!notifId) {
      throw new HttpError(400, "VALIDATION", "missing notification id");
    }
    // Validate UUID shape before using in SQL
    if (!UUID_RE.test(notifId)) {
      throw new HttpError(400, "VALIDATION", "notification id must be a valid UUID");
    }

    // FF-NO-CROSS-USER: UPDATE WHERE id=$1 AND recipient_id=actor
    // Foreign row → rowCount = 0 → 404
    const updated = await withTenantTx(pool, tenantId, (client) =>
      store.markRead(client, notifId, actorId),   // own-only guard inside DAO
    );

    if (!updated) {
      throw new HttpError(404, "NOT_FOUND", "notification not found");
    }

    // No appendAuditEvent here (FF-NO-ISREAD-AUDIT: is_read not audited per ADR §2.8)
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  }));

  // -------------------------------------------------------------------------
  // PATCH /api/notifications  — batch mark-read
  // -------------------------------------------------------------------------
  router.register("PATCH", "/api/notifications", withAuth(async (req, res) => {
    const actorId = await extractActor(req, pool);
    const tenantId = DEV_TENANT_ID;

    const rawBody = await readJsonBody(req);
    const body = rawBody as Record<string, unknown>;

    if (!Array.isArray(body["ids"]) || body["ids"].some((id: unknown) => typeof id !== "string")) {
      throw new HttpError(400, "VALIDATION", "ids must be an array of strings");
    }

    const ids = body["ids"] as string[];

    // Validate each id is UUID-shaped before passing to SQL
    for (const id of ids) {
      if (!UUID_RE.test(id)) {
        throw new HttpError(400, "VALIDATION", `invalid UUID in ids: ${id}`);
      }
    }

    // FF-NO-CROSS-USER: batchMarkRead matches WHERE id = ANY($1) AND recipient_id = actor.
    // Foreign ids are silently skipped (no per-id 403).
    const updated = await withTenantTx(pool, tenantId, (client) =>
      store.batchMarkRead(client, ids, actorId),
    );

    // No appendAuditEvent here (FF-NO-ISREAD-AUDIT)
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ updated }));
  }));
}
