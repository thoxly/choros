/**
 * choros entry point.
 * Re-exports createServer for library consumers.
 * When executed directly as the Node.js main module, starts the HTTP server.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "./server.js";
import { startLifecycleBridge } from "./server/lifecycle-bridge.js";

export const SCAFFOLD_VERSION = "0.0.1" as const;
export { createServer };

// Only start the server when this file is the process entry point.
// Importing this module in tests does NOT trigger server startup.
const thisFile = fileURLToPath(import.meta.url);
const mainFile = process.argv[1] != null ? resolve(process.argv[1]) : "";

if (thisFile === mainFile) {
  const port = Number(process.env["PORT"] ?? 8080);
  createServer().listen(port, () => {
    process.stdout.write(`choros listening on port ${port}\n`);
  });
  // T-0068 (FR-8): start the lifecycle-audit bridge alongside the server, NEVER
  // inside createServer (so test imports do not start a loop — FF-9). Degraded
  // without FLOWABLE_BASE_URL: returns a no-op handle, server runs regardless.
  startLifecycleBridge();
}
