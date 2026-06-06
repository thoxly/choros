import * as http from "node:http";

/**
 * Pure request handler for the choros HTTP server.
 * GET /health → 200 application/json { status: 'ok' }
 * All other method+url combinations → 404
 */
export function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  if (req.method === "GET" && req.url === "/health") {
    const body = JSON.stringify({ status: "ok" });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(body);
  } else {
    res.statusCode = 404;
    res.end();
  }
}

/**
 * Factory: creates an http.Server bound to handleRequest.
 * Does NOT call .listen() — that is the entry-point's responsibility.
 */
export function createServer(): http.Server {
  return http.createServer(handleRequest);
}
