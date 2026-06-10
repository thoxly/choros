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

interface VacuumResult {
  ok: true;
  tableVacuumed: string;
} | {
  ok: false;
  error: string;
}

async function main(): Promise<void> {
  let dbUrl: string | undefined;

  // Accept --db as CLI arg or fall back to DATABASE_URL
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
    const result: VacuumResult = { ok: false, error: "DATABASE_URL not set and --db not provided" };
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
    return;
  }

  const pool = new pg.Pool({ connectionString: dbUrl });

  try {
    // VACUUM ANALYZE cannot run inside a transaction block.
    // Use a direct client to ensure autocommit semantics.
    const client = await pool.connect();
    try {
      await client.query("VACUUM ANALYZE choros.job");
    } finally {
      client.release();
    }
    const result: VacuumResult = { ok: true, tableVacuumed: "job" };
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const result: VacuumResult = { ok: false, error: message };
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    await pool.end();
  }

  process.exit(0);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  process.exit(0);
});

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
    const client = await pool.connect();
    try {
      await client.query("VACUUM ANALYZE choros.job");
    } finally {
      client.release();
    }
    return { ok: true, tableVacuumed: "job" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    await pool.end();
  }
}
