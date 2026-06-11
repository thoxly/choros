#!/usr/bin/env node
/**
 * seed/cli.ts — T-0140 CLI entry point
 *
 * Usage:
 *   node seed/cli.js apply --tenant <slug> --pack <name> [--base-url http://localhost:8080]
 *   node seed/cli.js reset --tenant <slug> [--pack <name>] [--base-url http://localhost:8080]
 *
 * Exit 0 on success, non-zero on first error (NF-4).
 * Structured-JSON summary to stdout; errors to stderr.
 * Default devUser = e-owner (AC-18).
 */

import { applyPack, resetPack } from "./importer.js";

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== undefined && arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        result[key] = next;
        i++;
      } else {
        result[key] = "true";
      }
    }
  }
  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== "apply" && command !== "reset") {
    process.stderr.write(JSON.stringify({ error: { code: "USAGE", message: "command must be 'apply' or 'reset'" } }) + "\n");
    process.exit(1);
  }

  const opts = parseArgs(args.slice(1));
  const tenant = opts["tenant"];
  if (!tenant) {
    process.stderr.write(JSON.stringify({ error: { code: "USAGE", message: "--tenant is required" } }) + "\n");
    process.exit(1);
  }

  const baseUrl = opts["base-url"] ?? "http://localhost:8080";
  const devUser = opts["dev-user"] ?? "e-owner";

  if (command === "apply") {
    const pack = opts["pack"];
    if (!pack) {
      process.stderr.write(JSON.stringify({ error: { code: "USAGE", message: "--pack is required for apply" } }) + "\n");
      process.exit(1);
    }

    try {
      const summary = await applyPack({ baseUrl, tenantSlug: tenant, packName: pack, devUser });
      process.stdout.write(JSON.stringify({ command: "apply", tenant, pack, summary }) + "\n");
      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(JSON.stringify({ error: { code: "APPLY_FAILED", message } }) + "\n");
      process.exit(1);
    }
  } else {
    // reset
    const pack = opts["pack"];
    try {
      const summary = await resetPack({ baseUrl, tenantSlug: tenant, packName: pack, devUser });
      process.stdout.write(JSON.stringify({ command: "reset", tenant, pack: pack ?? tenant, summary }) + "\n");
      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(JSON.stringify({ error: { code: "RESET_FAILED", message } }) + "\n");
      process.exit(1);
    }
  }
}

main().catch((err) => {
  process.stderr.write(JSON.stringify({ error: { code: "FATAL", message: String(err) } }) + "\n");
  process.exit(1);
});
