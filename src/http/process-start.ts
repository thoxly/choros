/**
 * src/http/process-start.ts
 *
 * T-0280 (ADR T-0278 §B) — start-instance write-path for process instances.
 *
 * Owns the FROZEN contract (ADR §2.2 — seam B↔C↔E):
 *   POST /api/processes/start
 *   Headers: x-dev-user (actor), x-tenant-id (tenant scope)
 *   Body:    { processKey: string, variables?: Record<string, unknown> }
 *   201 { instanceId, processKey, tenantId }
 *   400 VALIDATION       — processKey empty / body not object / tenantId not UUID
 *   401 UNAUTHENTICATED  — no x-dev-user
 *   403 NOT_ELIGIBLE     — actor not entitled to start a process in this tenant (PDP)
 *   502 ENGINE_ERROR     — startInstance returned not-ok
 *
 * Why this is its OWN module (not inline in processes.ts):
 *   FF-DISPLAY-4 (ci/checks/demo/pack-serve-no-write.sh) forbids src/http/processes.ts
 *   from importing `pg` or `src/db/*` — it is the read-only display plane. The start
 *   write-path REQUIRES the withTenantTx + RLS pattern (which needs pg). ADR §3
 *   explicitly sanctions extracting the engine-write seam into a dedicated module so
 *   processes.ts stays display-plane-pure while the route is still registered through
 *   registerProcessesRoutes. The FROZEN seam is the REST shape, not the file layout.
 *
 * Tenant-scoping (AC-9 / NF4 — the Враг target):
 *   The actor's REAL tenant is resolved from the dev-user slug (resolveActorTenant).
 *   A cross-tenant start — x-tenant-id naming a tenant the actor does NOT belong to —
 *   is rejected with 403 NOT_ELIGIBLE BEFORE the engine is touched: no instance is
 *   created in a foreign tenant. The engine call then runs inside withTenantTx under
 *   SET LOCAL choros.tenant_id (FORCE RLS), exactly as process-defs.ts, so any
 *   tenant-bound projection write (task D's §2.3 seam) is scoped to the actor tenant.
 *
 * FlowableClient + pool are injected from the composition root (src/server.ts);
 * NO env reads here (NF-1, no-env-in-core / FF). The actor→tenant resolver is also
 * injected so the unit suite can exercise the route without a live Postgres.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { HttpError, readJsonBody, type RouteHandler } from "./router.js";
import { DEV_USER_HEADER } from "./auth.js";
import type { FlowableClient } from "../core/flowable-client.js";

// ---------------------------------------------------------------------------
// UUID guard — same shape as process-defs.ts withTenantTx
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Header extraction — mirrors process-defs.ts dosly
// ---------------------------------------------------------------------------

function extractActor(req: IncomingMessage): string {
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

function extractTenantId(req: IncomingMessage): string {
  let tenantId = req.headers["x-tenant-id"];
  if (Array.isArray(tenantId)) tenantId = tenantId[0];
  if (!tenantId || typeof tenantId !== "string") {
    throw new HttpError(400, "VALIDATION", "missing x-tenant-id header");
  }
  return tenantId;
}

// ---------------------------------------------------------------------------
// withTenantTx — same RLS pattern as process-defs.ts (FORCE RLS via SET LOCAL).
// The engine call runs INSIDE this transaction so the start (and any tenant-bound
// projection write added by task D's §2.3 seam) is scoped to the actor's tenant.
// ---------------------------------------------------------------------------

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new HttpError(400, "VALIDATION", "tenantId must be a valid UUID");
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
// Injected deps
// ---------------------------------------------------------------------------

/**
 * Resolve the tenant the actor (dev-user slug) actually belongs to.
 * Production binding = resolveActorTenant(getOrgPool(), slug) from src/db/org.ts;
 * injected so the unit suite can stub the membership check without a live DB.
 */
export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

export interface StartInstanceDeps {
  pool: pg.Pool;
  flowable: FlowableClient;
  resolveActorTenant: ActorTenantResolver;
}

// ---------------------------------------------------------------------------
// Handler factory — the POST /api/processes/start handler.
// ---------------------------------------------------------------------------

export function makeStartInstanceHandler(deps: StartInstanceDeps): RouteHandler {
  const { pool, flowable, resolveActorTenant } = deps;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 1. Auth gate (401)
    const actor = extractActor(req);

    // 2. Tenant scope header (400 if absent)
    const tenantId = extractTenantId(req);

    // 3. Body validation (400)
    const rawBody = await readJsonBody(req);
    if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }
    const body = rawBody as Record<string, unknown>;

    const processKey = body["processKey"];
    if (typeof processKey !== "string" || !processKey.trim()) {
      throw new HttpError(400, "VALIDATION", "processKey must be a non-empty string");
    }

    let variables: Record<string, unknown> | undefined;
    const rawVars = body["variables"];
    if (rawVars !== undefined) {
      if (rawVars === null || typeof rawVars !== "object" || Array.isArray(rawVars)) {
        throw new HttpError(400, "VALIDATION", "variables must be an object when present");
      }
      variables = rawVars as Record<string, unknown>;
    }

    // 4. Tenant-scoping authorization (AC-9 / NF4 — the Враг target).
    //    The actor may only start a process in the tenant they belong to. A
    //    cross-tenant x-tenant-id is rejected BEFORE the engine is touched, so no
    //    instance is created in a foreign tenant.
    const actorTenant = await resolveActorTenant(actor);
    if (actorTenant !== tenantId) {
      throw new HttpError(
        403,
        "NOT_ELIGIBLE",
        "actor is not entitled to start a process in this tenant",
      );
    }

    // 5. Engine call inside the tenant-scoped transaction (RLS via SET LOCAL).
    //    withTenantTx validates the UUID shape (→ 400) before opening the tx.
    const startResult = await withTenantTx(pool, tenantId, async () => {
      // The start runs under SET LOCAL choros.tenant_id (FORCE RLS). Task D's §2.3
      // projection write (process.started → audit_event) hangs off this same seam.
      return flowable.startInstance(processKey, variables);
    });

    if (!startResult.ok) {
      throw new HttpError(502, "ENGINE_ERROR", `startInstance failed: ${startResult.code}`);
    }

    // 6. 201 with the FROZEN response shape.
    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        instanceId: startResult.instanceId,
        processKey,
        tenantId,
      }),
    );
  };
}
