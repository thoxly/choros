/**
 * src/http/user-prefs.ts — T-0651 (E-NAV-IA/sidebar-workspace): user_pref
 * generic per-actor key/value store CRUD API.
 *
 * UX-study 2026-07-05 §1/§4 diagnosis: "нет слоя персонального рабочего
 * места" — no user-prefs storage existed anywhere in the product, so nothing
 * (sidebar collapse state, personal list views, table density) could be
 * remembered "just for me". This is the ONE reusable primitive that closes
 * that gap: a flat, tenant+actor-scoped key/value store. This task's own
 * consumer is sidebar group-collapse state (key: "sidebar.collapsed_groups"),
 * but the contract is intentionally generic — a future view-registry
 * owner_actor feature (§4 of the study) or a table-density toggle reads/writes
 * through the SAME two routes with a different key, no new table.
 *
 * Registers (over choros.user_pref, migration 129):
 *   GET  /api/user-prefs             → 200 { prefs: { [key]: value, ... } }
 *        (every pref this actor owns in their tenant, as a flat map — cheap,
 *        the sidebar needs all of them on mount, not one at a time)
 *   PUT  /api/user-prefs/:key  body { value: <any JSON> }
 *        → 200 { key, value, updated_at }  (upsert — ON CONFLICT DO UPDATE)
 *        · 400 VALIDATION (missing/oversized key, body not a JSON object,
 *          "value" absent)
 *   DELETE /api/user-prefs/:key  → 204 (idempotent — absent key is still 204,
 *        "reset to default" is not an error)
 *
 * MULTI-TENANT (mandatory, T-0013): every operation runs inside withTenantTx
 * under SET LOCAL choros.tenant_id = '<actor-tenant>' + FORCE RLS (policy
 * user_pref_tenant_isolation, migration 129). The actor's REAL tenant is
 * resolved from the dev-user slug / KC sub — NEVER from the request body or
 * an attacker header (mirrors sections.ts / applications.ts verbatim).
 *
 * PER-ACTOR (not just per-tenant): the row is additionally scoped by `actor`
 * (UNIQUE (tenant_id, actor, key)) — every read/write is implicitly filtered
 * to `WHERE actor = <caller's own actor>`. There is no "list another actor's
 * prefs" capability by design — a preference is private-by-construction, not
 * privilege-gated (there is nothing to gate: nobody but the owner ever has a
 * reason to read it, mirrors localStorage's trust model but survives across
 * devices/browsers, T-0651 spec §1).
 *
 * NO MUTATION PRIVILEGE CHECK beyond tenant-membership + auth: unlike
 * list_view (list-views.ts) or applications (which require authoring_draft),
 * a personal preference costs nothing to write and affects only the writer's
 * own view — the same reasoning theme toggle (localStorage) already uses.
 *
 * DEPS INJECTION (mirrors sections.ts): the composition root supplies
 * { pool, resolveActorTenant }. When absent (no DATABASE_URL) the routes are
 * NOT registered — same honest-degrade contract as the other DB-backed write
 * APIs (the sidebar falls back to non-persisted in-memory collapse state).
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

const KEY_MAX = 128;
// Conservative body-size guard: a pref value is a small UI-state blob (a list
// of ids, a boolean map), never a document. 16 KiB is generous headroom over
// every real consumer (sidebar collapse: a handful of short ids).
const VALUE_JSON_MAX_BYTES = 16_384;
const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

// ---------------------------------------------------------------------------
// Injected deps (mirrors SectionRoutesDeps)
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

export interface UserPrefRoutesDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
}

// ---------------------------------------------------------------------------
// withTenantTx — canonical RLS pattern (mirrors sections.ts)
// ---------------------------------------------------------------------------

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
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
// Services
// ---------------------------------------------------------------------------

interface UserPrefRow {
  key: string;
  value: unknown;
  updated_at: string | number;
}

async function listUserPrefs(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
): Promise<UserPrefRow[]> {
  return withTenantTx(pool, tenantId, async (client) => {
    const res = await client.query<UserPrefRow>(
      `SELECT key, value, updated_at FROM choros.user_pref WHERE tenant_id = $1 AND actor = $2`,
      [tenantId, actor],
    );
    return res.rows;
  });
}

async function putUserPref(args: {
  pool: pg.Pool;
  tenantId: string;
  actor: string;
  key: string;
  value: unknown;
  nowMs: number;
}): Promise<UserPrefRow> {
  const { pool, tenantId, actor, key, value, nowMs } = args;
  const id = randomUUID();
  return withTenantTx(pool, tenantId, async (client) => {
    const res = await client.query<UserPrefRow>(
      `INSERT INTO choros.user_pref (tenant_id, id, actor, key, value, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)
       ON CONFLICT (tenant_id, actor, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
       RETURNING key, value, updated_at`,
      [tenantId, id, actor, key, JSON.stringify(value), nowMs],
    );
    return res.rows[0]!;
  });
}

async function deleteUserPref(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
  key: string,
): Promise<void> {
  await withTenantTx(pool, tenantId, async (client) => {
    await client.query(
      `DELETE FROM choros.user_pref WHERE tenant_id = $1 AND actor = $2 AND key = $3`,
      [tenantId, actor, key],
    );
  });
}

function serializePref(row: UserPrefRow): unknown {
  return row.value;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerUserPrefRoutes(
  router: Router,
  deps?: UserPrefRoutesDeps,
): void {
  if (!deps) return;
  const { pool, resolveActorTenant } = deps;

  // GET /api/user-prefs — every pref this actor owns, as a flat { key: value } map.
  router.register("GET", "/api/user-prefs", withAuth(async (req: IncomingMessage, res: ServerResponse) => {
    const actor = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(actor);
    const rows = await listUserPrefs(pool, tenantId, actor);

    const prefs: Record<string, unknown> = {};
    for (const row of rows) prefs[row.key] = serializePref(row);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ prefs }));
  }));

  // PUT /api/user-prefs/:key — upsert one pref value (idempotent write).
  router.register(
    "PUT",
    "/api/user-prefs/:key",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const key = params["key"] ?? "";
      if (!KEY_RE.test(key)) {
        throw new HttpError(400, "VALIDATION", `key must match ${KEY_RE} (max ${KEY_MAX} chars)`);
      }

      const actor = await extractActor(req, pool);

      const rawBody = await readJsonBody(req, VALUE_JSON_MAX_BYTES);
      if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
      }
      const body = rawBody as Record<string, unknown>;
      if (!("value" in body)) {
        throw new HttpError(400, "VALIDATION", "body must include \"value\"");
      }

      const tenantId = await resolveActorTenant(actor);
      const row = await putUserPref({
        pool, tenantId, actor, key, value: body["value"], nowMs: Date.now(),
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ key: row.key, value: serializePref(row), updated_at: Number(row.updated_at) }));
    }),
  );

  // DELETE /api/user-prefs/:key — reset to default (idempotent: 204 either way).
  router.register(
    "DELETE",
    "/api/user-prefs/:key",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const key = params["key"] ?? "";
      if (!KEY_RE.test(key)) {
        throw new HttpError(400, "VALIDATION", `key must match ${KEY_RE} (max ${KEY_MAX} chars)`);
      }
      const actor = await extractActor(req, pool);
      const tenantId = await resolveActorTenant(actor);
      await deleteUserPref(pool, tenantId, actor, key);

      res.statusCode = 204;
      res.end();
    }),
  );
}
