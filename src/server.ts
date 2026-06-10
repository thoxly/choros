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
  outboxStore?: PostgresOutboxStore
): Router {
  const router = new Router();

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
  const router = buildRouter(store, createTimerStore(), createOutboxStore());
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
