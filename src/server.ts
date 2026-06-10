import * as http from "node:http";
import pg from "pg";
import { Router } from "./http/router.js";
import { JobStore, PostgresJobStore } from "./core/jobStore.js";
import { InMemoryJobStore } from "./core/inMemoryJobStore.js";
import { type Clock } from "./core/types.js";
import { registerExternalWorkerRoutes } from "./http/externalWorker.js";
import { registerOrgRoutes } from "./http/org.js";
import { registerInboxRoutes } from "./http/inbox.js";
import { registerAuditRoutes } from "./http/audit.js";
import { registerAuthRoutes } from "./http/auth.js";
import { registerRightsRoutes } from "./http/rights.js";
import { registerProcessesRoutes } from "./http/processes.js";
import { makeStaticHandler, resolveDefaultDistDir } from "./http/static.js";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Store factory (ADR §4.1)
// ---------------------------------------------------------------------------

/**
 * Creates a PostgresJobStore if DATABASE_URL is set, otherwise InMemoryJobStore.
 * Used by createServer() in production (index.ts) and by tests via optional store
 * injection. Clock injection seam is preserved for deterministic tests.
 */
function createJobStore(clock?: Clock): PostgresJobStore | InMemoryJobStore {
  const url = process.env["DATABASE_URL"];
  if (url) {
    const pool = new Pool({ connectionString: url });
    return new PostgresJobStore(pool, clock);
  }
  return new InMemoryJobStore(clock);
}

// ---------------------------------------------------------------------------
// Internal builder — composes a Router with health + external-worker routes.
// Returns both the Router (for handleRequest) and the http.Server.
// ---------------------------------------------------------------------------

function buildRouter(store: JobStore | PostgresJobStore | InMemoryJobStore): Router {
  const router = new Router();

  // Register GET /health (ADR §3.7: queue metrics when Postgres available)
  router.register("GET", "/health", async (_req, res) => {
    let status: "ok" | "degraded" = "ok";
    let queueDepth = 0;
    let oldestAvailableLagMs: number | null = null;

    if (store instanceof PostgresJobStore) {
      try {
        const health = await store.getQueueHealth();
        queueDepth = health.depth;
        oldestAvailableLagMs = health.oldestAvailableLagMs;
      } catch {
        status = "degraded";
      }
    }

    const body = JSON.stringify({
      status,
      queue: {
        depth: queueDepth,
        oldestAvailableLagMs,
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

  // Register rights endpoints
  registerRightsRoutes(router, store as JobStore);

  // Register processes endpoints
  registerProcessesRoutes(router, store as JobStore);

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
 * Does NOT call .listen() — that is the caller's responsibility.
 */
export function createServer(store: JobStore | PostgresJobStore | InMemoryJobStore = createJobStore()): http.Server {
  const router = buildRouter(store);
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
    _defaultRouter = buildRouter(createJobStore());
  }
  _defaultRouter.dispatch(req, res);
};
