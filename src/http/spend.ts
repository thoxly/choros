/**
 * src/http/spend.ts — T-0477 [E-AGENTS L5]
 *
 * Read-only spend accounting API for the «Расход» screen.
 * Backed by spend_ledger (migration 034 + 107) — accounting only, no ceilings.
 *
 * Routes:
 *   GET /api/spend        — windows + by-connection aggregates + recent rows
 *   GET /api/spend/recent — most-recent N individual rows (optional ?limit=N)
 *
 * Auth: same x-dev-user / keycloak-Bearer pattern as llm-connections.ts.
 * Authz: any tenant member can view spend (read-only accounting).
 * Tenant isolation: resolveActorTenant + withTenantTx (SET LOCAL + FORCE RLS).
 *
 * NON-GOAL: no ceilings, no limits, no mutations — purely accounting + display.
 */

import pg from "pg";
import { HttpError, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import {
  getSpendByConnection,
  getSpendWindows,
  getRecentSpend,
} from "../db/spend-ledger-dao.js";
import type { PgClientLike } from "../db/audit-writer.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

export interface SpendRouteDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function extractActor(req: import("node:http").IncomingMessage): string {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) return ctx.sub;
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// withTenantReadTx
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function withTenantReadTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new HttpError(400, "VALIDATION", "invalid tenantId");
  }
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
// GET /api/spend — aggregate overview
// ---------------------------------------------------------------------------

async function handleSpendOverview(
  pool: pg.Pool,
  resolveActorTenant: ActorTenantResolver,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const actor = extractActor(req);
  const tenantId = await resolveActorTenant(actor);

  const { windows, byConnection } = await withTenantReadTx(pool, tenantId, async (client) => {
    const [windows, byConnection] = await Promise.all([
      getSpendWindows(client as unknown as PgClientLike, tenantId),
      getSpendByConnection(client as unknown as PgClientLike, tenantId),
    ]);
    return { windows, byConnection };
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ windows, byConnection }));
}

// ---------------------------------------------------------------------------
// GET /api/spend/recent?limit=N
// ---------------------------------------------------------------------------

async function handleSpendRecent(
  pool: pg.Pool,
  resolveActorTenant: ActorTenantResolver,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const actor = extractActor(req);
  const tenantId = await resolveActorTenant(actor);

  // Parse optional ?limit param. Default 50, cap at 500.
  const url = new URL(req.url ?? "/", "http://localhost");
  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(
    limitParam && /^\d+$/.test(limitParam) ? parseInt(limitParam, 10) : 50,
    500,
  );

  const rows = await withTenantReadTx(pool, tenantId, (client) =>
    getRecentSpend(client as unknown as PgClientLike, tenantId, limit),
  );

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ rows }));
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSpendRoutes(router: Router, deps: SpendRouteDeps): void {
  const { pool, resolveActorTenant } = deps;

  router.register(
    "GET",
    "/api/spend",
    withAuth(async (req, res) => handleSpendOverview(pool, resolveActorTenant, req, res)),
  );

  router.register(
    "GET",
    "/api/spend/recent",
    withAuth(async (req, res) => handleSpendRecent(pool, resolveActorTenant, req, res)),
  );
}
