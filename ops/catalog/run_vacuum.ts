/**
 * ops/catalog/run_vacuum.ts — T-0114 ops operation (ADR §3.8)
 *
 * Runs VACUUM ANALYZE on choros.job to reclaim dead tuples and update statistics.
 * Idempotent: safe to run any number of times.
 * Accepts DATABASE_URL from environment or --db CLI arg.
 * Outputs JSON to stdout; exits 0 on all outcomes (never throws past top-level catch).
 *
 * Autonomy tier: T0 (automatic, logged).
 * Run:
 *   DATABASE_URL=<migrator-url> node ops/dist/run_vacuum.js
 *   node ops/dist/run_vacuum.js --db <migrator-url>
 */
import pg from "pg";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Programmatic API — for use in integration tests without subprocess spawn
// ---------------------------------------------------------------------------

export interface VacuumOk {
  ok: true;
  tableVacuumed: string;
}
export interface VacuumFail {
  ok: false;
  error: string;
}
export type VacuumResult = VacuumOk | VacuumFail;

/**
 * Programmatic vacuum runner — same logic as the CLI entry point.
 * Returns a VacuumResult; never throws.
 */
export async function runVacuum(dbUrl: string): Promise<VacuumResult> {
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    // VACUUM ANALYZE cannot run inside a transaction block; use a client directly.
    const client = await pool.connect();
    try {
      await client.query("VACUUM ANALYZE choros.job");
    } finally {
      client.release();
    }
    return { ok: true, tableVacuumed: "job" };
  } catch (err: unknown) {
    const message = err instanceof Error
      ? (err.message || err.toString() || `${err.constructor?.name ?? "Error"}`)
      : String(err);
    return { ok: false, error: message || "connection failed" };
  } finally {
    await pool.end().catch(() => {/* ignore close errors */});
  }
}

// ---------------------------------------------------------------------------
// CLI entry point — only runs when this file is the main module
// ---------------------------------------------------------------------------

async function cli(): Promise<void> {
  let dbUrl: string | undefined;

  try {
    const { values } = parseArgs({
      options: { db: { type: "string" } },
      strict: false,
    });
    dbUrl = (values.db as string | undefined) ?? process.env["DATABASE_URL"];
  } catch {
    dbUrl = process.env["DATABASE_URL"];
  }

  if (!dbUrl) {
    process.stdout.write(JSON.stringify({ ok: false, error: "DATABASE_URL not set and --db not provided" }) + "\n");
    process.exit(0);
    return;
  }

  const result = await runVacuum(dbUrl);
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(0);
}

// Guard: only run CLI when invoked directly (not when imported by tests)
const isMain = process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
   process.argv[1].endsWith("run_vacuum.js"));

if (isMain) {
  cli().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
    process.exit(0);
  });
}
