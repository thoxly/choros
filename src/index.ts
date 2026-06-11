/**
 * choros entry point.
 * Re-exports createServer for library consumers.
 * When executed directly as the Node.js main module, starts the HTTP server.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "./server.js";
import { startMain } from "./main.js";

export const SCAFFOLD_VERSION = "0.0.1" as const;
export { createServer };
export { startMain };

// Only start the server when this file is the process entry point.
// Importing this module in tests does NOT trigger server startup.
const thisFile = fileURLToPath(import.meta.url);
const mainFile = process.argv[1] != null ? resolve(process.argv[1]) : "";

if (thisFile === mainFile) {
  const port = Number(process.env["PORT"] ?? 8080);
  startMain({ port });
}
