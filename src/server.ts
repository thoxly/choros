import * as http from "node:http";
import pg from "pg";
import { Router } from "./http/router.js";
import { JobStore, PostgresJobStore } from "./core/jobStore.js";
import { InMemoryJobStore } from "./core/inMemoryJobStore.js";
import { type Clock } from "./core/types.js";
import { PostgresTimerStore } from "./core/postgres/pgTimerStore.js";
import { PostgresOutboxStore } from "./core/postgres/pgOutboxStore.js";
import { registerExternalWorkerRoutes } from "./http/externalWorker.js";
import { registerOrgRoutes } from "./http/org.js";
import { registerInboxRoutes } from "./http/inbox.js";
import { registerAuditRoutes } from "./http/audit.js";
import { registerAuthRoutes } from "./http/auth.js";
import { registerRightsRoutes } from "./http/rights.js";
import { registerDictionariesRoute, registerGrantsRoutes } from "./http/grants.js";
import { registerInvokeRoutes } from "./http/invoke.js";
import { registerGrantProposeRoute } from "./http/grant-propose.js";
import { registerSecretHandleRoutes } from "./http/secret-handle.js";
import { registerProcessesRoutes } from "./http/processes.js";
import { registerGrantTrailRoutes } from "./http/grant-trail.js";
import { registerAgentRoutes } from "./http/agents.js";
import { makeHttpKeycloakAdminPort } from "./keycloak/admin-port.js";
import { makeStaticHandler, resolveDefaultDistDir } from "./http/static.js";
import { type ResolverDeps } from "./core/grant-resolver.js";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Store factory (ADR §4.1)
// ---------------------------------------------------------------------------

/**
 * Creates a PostgresJobStore if DATABASE_URL is set, otherwise InMemoryJobStore.
 * Used by createServer() in production (index.ts) and by tests via optional store
 * injection. Clock injection seam is preserved for deterministic tests.
 *
 * Exported so startMain (src/main.ts) can call it explicitly before passing both
 * the store AND a resolverDepsObj to createServer() — required when T-0143 threads
 * ResolverDeps through the composition stack (ADR §4.3: single allocation).
 */
export function createJobStore(clock?: Clock): PostgresJobStore | InMemoryJobStore {
  const url = process.env["DATABASE_URL"];
  if (url) {
    const pool = new Pool({ connectionString: url });
    return new PostgresJobStore(pool, clock);
  }
  return new InMemoryJobStore(clock);
}

/**
 * Creates a PostgresTimerStore if DATABASE_URL is set, otherwise undefined.
 * Timer health is only available when Postgres is configured.
 */
function createTimerStore(clock?: Clock): PostgresTimerStore | undefined {
  const url = process.env["DATABASE_URL"];
  if (url) {
    const pool = new Pool({ connectionString: url });
    return new PostgresTimerStore(pool, clock);
  }
  return undefined;
}

/**
 * Creates a PostgresOutboxStore if DATABASE_URL is set, otherwise undefined.
 * Outbox health (T-0062) is only available when Postgres is configured.
 */
function createOutboxStore(clock?: Clock): PostgresOutboxStore | undefined {
  const url = process.env["DATABASE_URL"];
  if (url) {
    const pool = new Pool({ connectionString: url });
    return new PostgresOutboxStore(pool, clock);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Internal builder — composes a Router with health + external-worker routes.
// Returns both the Router (for handleRequest) and the http.Server.
// ---------------------------------------------------------------------------

function buildRouter(
  store: JobStore | PostgresJobStore | InMemoryJobStore,
  timerStore?: PostgresTimerStore,
  outboxStore?: PostgresOutboxStore,
  // T-0143: captured in closure; passed to makeGrantResolver when a route calls it.
  // Absent ⇒ hash fields drop honestly (FR-2 / NF-3).
  // Partial<ResolverDeps>: at composition-root time only keyedDigest exists;
  // per-request sources (grants/records/ancestry) are assembled at the route.
  resolverDeps?: Partial<ResolverDeps>
): Router {
  // resolverDeps is captured here in the closure so every future route that calls
  // makeGrantResolver(resolverDeps) automatically inherits the composition-root
  // binding — no second wiring step required when a new route is added (FR-3).
  void resolverDeps; // referenced via closure; used by future route registrations
  const router = new Router();
  // Postgres pool for the grant write-path (DATABASE_URL optional — routes
  // that hit DB will 500 naturally when no DB is configured; non-DB routes
  // remain available).
  const grantsPool = process.env["DATABASE_URL"]
    ? new Pool({ connectionString: process.env["DATABASE_URL"] })
    : null;

  // Register GET /health (ADR §3.7: queue + timer + outbox metrics when Postgres available)
  // T-0116: timer.timerLagMs; T-0062: outbox.{pendingLagMs,deadCount} (backward-compatible).
  router.register("GET", "/health", async (_req, res) => {
    let status: "ok" | "degraded" = "ok";
    let queueDepth = 0;
    let oldestAvailableLagMs: number | null = null;
    let workerIncidents = 0;
    let timerLagMs: number | null = null;
    let outboxPendingLagMs: number | null = null;
    let outboxDeadCount = 0;

    // Queue health (T-0114 + T-0063 workerIncidents)
    if (store instanceof PostgresJobStore) {
      try {
        const health = await store.getQueueHealth();
        queueDepth = health.depth;
        oldestAvailableLagMs = health.oldestAvailableLagMs;
        workerIncidents = health.workerIncidents;
      } catch {
        status = "degraded";
      }
    }

    // Timer health (T-0116) — independent try/catch (AC-11, ADR §3.7)
    if (timerStore !== undefined) {
      try {
        const timerHealth = await timerStore.getTimerHealth();
        timerLagMs = timerHealth.timerLagMs;
      } catch {
        status = "degraded";
      }
    }

    // Outbox health (T-0062) — independent try/catch (AC-16, ADR §4.4)
    if (outboxStore !== undefined) {
      try {
        const outboxHealth = await outboxStore.getOutboxHealth();
        outboxPendingLagMs = outboxHealth.pendingLagMs;
        outboxDeadCount = outboxHealth.deadCount;
      } catch {
        status = "degraded";
      }
    }

    const body = JSON.stringify({
      status,
      queue: {
        depth: queueDepth,
        oldestAvailableLagMs,
        workerIncidents,
      },
      timer: {
        timerLagMs,
      },
      outbox: {
        pendingLagMs: outboxPendingLagMs,
        deadCount: outboxDeadCount,
      },
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(body);
  });

  // Register external-worker endpoints
  registerExternalWorkerRoutes(router, store as JobStore);

  // Register auth endpoints
  registerAuthRoutes(router, store as JobStore);

  // Register org structure endpoints
  registerOrgRoutes(router, store as JobStore);

  // Register inbox endpoints
  registerInboxRoutes(router, store as JobStore);

  // Register audit endpoints
  registerAuditRoutes(router, store as JobStore);

  // Register GET /api/rights/dictionaries BEFORE :roleId catch-all (R-1 fix).
  // Seed-backed — no DATABASE_URL required (ADR §2.1 / AC-16).
  registerDictionariesRoute(router);

  // Register rights endpoints (includes GET /api/rights/:roleId catch-all).
  registerRightsRoutes(router, store as JobStore);

  // Register grant write-API (T-0030).
  // Write routes require grantsPool; pool is non-null when DATABASE_URL is set.
  if (grantsPool) {
    registerGrantsRoutes(router, grantsPool);
    // Register invoke routes (T-0024 E5.4).
    registerInvokeRoutes(router, grantsPool);
    // Register grant proposal endpoint (T-0039). Must come AFTER registerGrantsRoutes
    // so the literal '/api/grants/propose' path is not confused with ':id' patterns.
    // The path is a distinct fixed segment — it is never captured by the
    // existing '/api/grants/:id/revoke' pattern.
    registerGrantProposeRoute(router, grantsPool);
    registerSecretHandleRoutes(router, grantsPool);
  }

  // Register processes endpoints
  registerProcessesRoutes(router, store as JobStore);

  // Register grant trail endpoints (T-0031)
  registerGrantTrailRoutes(router);

  // Register agent hire endpoint (T-0042 — additive, no existing routes modified)
  if (grantsPool) {
    const kcPort = makeHttpKeycloakAdminPort();
    registerAgentRoutes(router, grantsPool, kcPort);
  }

  // Set static file handler as fallback for everything else
  router.setFallback(makeStaticHandler(resolveDefaultDistDir()));

  return router;
}

/**
 * Factory: creates an http.Server with a fresh Router and the provided JobStore.
 * The optional `store` parameter allows test suites to inject a stub-clock store
 * for deterministic lock-expiry testing. Zero-arg usage (index.ts, health.test.ts)
 * is preserved via the default parameter.
 *
 * T-0143: additive optional second parameter `resolverDeps?: ResolverDeps`.
 * When present it is threaded to `buildRouter` where it is captured in a closure
 * for use by any route that calls `makeGrantResolver` (FR-3, NF-2 / FE-W23-0008).
 * Zero-arg and one-arg callers are unaffected (additive optional parameter).
 * When absent, `hash` fields drop honestly (FR-2 / NF-3).
 *
 * Does NOT call .listen() — that is the caller's responsibility.
 */
export function createServer(
  store: JobStore | PostgresJobStore | InMemoryJobStore = createJobStore(),
  // Partial<ResolverDeps>: at composition-root time only keyedDigest is available;
  // per-request sources (grants/records/ancestry) are assembled at the route (T-0143 §4.3 amendment).
  // Absent => hash fields drop honestly (FR-2 / NF-3).
  resolverDeps?: Partial<ResolverDeps>
): http.Server {
  const router = buildRouter(store, createTimerStore(), createOutboxStore(), resolverDeps);
  return http.createServer(router.dispatch.bind(router));
}

/**
 * Named export preserved for backwards-compatibility with health.test.ts, which
 * imports and calls `handleRequest` directly rather than going through createServer.
 *
 * Backed by a lazy-built default-store router so that GET /health (and the
 * external-worker routes) behave identically to what createServer() would produce.
 * Lazy evaluation ensures environment variables (e.g., CHOROS_WEB_DIST) set by
 * test harnesses are respected.
 */
let _defaultRouter: Router | null = null;

export const handleRequest = (
  req: http.IncomingMessage,
  res: http.ServerResponse
): void => {
  if (!_defaultRouter) {
    _defaultRouter = buildRouter(createJobStore(), createTimerStore(), createOutboxStore());
  }
  _defaultRouter.dispatch(req, res);
};
