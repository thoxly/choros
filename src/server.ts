import * as http from "node:http";
import { Router } from "./http/router.js";

// Module-level router instance
const router = new Router();

// Register GET /health
router.register("GET", "/health", (_req, res) => {
  const body = JSON.stringify({ status: "ok" });
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(body);
});

/**
 * Named export preserved for backwards-compatibility with health.test.ts and
 * any consumer that imports handleRequest directly. Alias to router.dispatch
 * bound to the module-level Router instance.
 */
export const handleRequest = router.dispatch.bind(router) as (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => void;

/**
 * Factory: creates an http.Server bound to the router.
 * Does NOT call .listen() — that is the entry-point's responsibility.
 */
export function createServer(): http.Server {
  return http.createServer(handleRequest);
}
