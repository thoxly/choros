import * as http from "node:http";
import { Router } from "./http/router.js";
import { JobStore } from "./core/jobStore.js";
import { registerExternalWorkerRoutes } from "./http/externalWorker.js";
import { registerOrgRoutes } from "./http/org.js";
import { registerInboxRoutes } from "./http/inbox.js";

// ---------------------------------------------------------------------------
// Internal builder — composes a Router with health + external-worker routes.
// Returns both the Router (for handleRequest) and the http.Server.
// ---------------------------------------------------------------------------

function buildRouter(store: JobStore): Router {
  const router = new Router();

  // Register GET /health
  router.register("GET", "/health", (_req, res) => {
    const body = JSON.stringify({ status: "ok" });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(body);
  });

  // Register external-worker endpoints
  registerExternalWorkerRoutes(router, store);

  // Register org structure endpoints
  registerOrgRoutes(router, store);

  // Register inbox endpoints
  registerInboxRoutes(router, store);

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
export function createServer(store: JobStore = new JobStore()): http.Server {
  const router = buildRouter(store);
  return http.createServer(router.dispatch.bind(router));
}

/**
 * Named export preserved for backwards-compatibility with health.test.ts, which
 * imports and calls `handleRequest` directly rather than going through createServer.
 *
 * Backed by a module-level default-store router so that GET /health (and the
 * external-worker routes) behave identically to what createServer() would produce.
 */
const _defaultRouter = buildRouter(new JobStore());

export const handleRequest = (
  req: http.IncomingMessage,
  res: http.ServerResponse
): void => {
  _defaultRouter.dispatch(req, res);
};
