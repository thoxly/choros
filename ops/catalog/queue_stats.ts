/**
 * ops/catalog/queue_stats.ts — T-0114 ops operation (ADR §3.8)
 *
 * Returns queue metrics for choros.job as JSON.
 * Idempotent: pure SELECT, safe to run any number of times.
 * Accepts DATABASE_URL from environment or --db CLI arg.
 * Outputs JSON to stdout; exits 0 on all outcomes (never throws past top-level catch).
 *
 * Autonomy tier: T0 (automatic, logged).
 * Run:
 *   DATABASE_URL=<url> node ops/dist/queue_stats.js
 *   node ops/dist/queue_stats.js --db <url>
 *
 * Output shape (ADR §4.6):
 *   {
 *     depth: number,          // CREATED+LOCKED with available_at<=now
 *     lockedCount: number,    // LOCKED rows
 *     failedCount: number,    // FAILED rows
 *     completedCount: number, // COMPLETED rows
 *     dlqCount: number,       // FAILED with retries=0 (dead letter queue)
 *     oldestAvailableLagMs: number | null
 *   }
 */
import pg from "pg";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueueStats {
  depth: number;
  lockedCount: number;
  failedCount: number;
  completedCount: number;
  dlqCount: number;
  oldestAvailableLagMs: number | null;
}

export interface QueueStatsOk {
  ok: true;
  stats: QueueStats;
}
export interface QueueStatsFail {
  ok: false;
  error: string;
}
export type QueueStatsResult = QueueStatsOk | QueueStatsFail;

// ---------------------------------------------------------------------------
// Programmatic API — for use in integration tests without subprocess spawn
// ---------------------------------------------------------------------------

/**
 * Programmatic queue stats runner. Never throws. Returns QueueStatsResult.
 */
export async function getQueueStats(dbUrl: string): Promise<QueueStatsResult> {
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    const now = Date.now();
    const { rows } = await pool.query<{
      depth: string;
      locked_count: string;
      failed_count: string;
      completed_count: string;
      dlq_count: string;
      oldest_available_at: string | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE state IN ('CREATED','LOCKED') AND available_at <= $1) AS depth,
         COUNT(*) FILTER (WHERE state = 'LOCKED')                                      AS locked_count,
         COUNT(*) FILTER (WHERE state = 'FAILED')                                      AS failed_count,
         COUNT(*) FILTER (WHERE state = 'COMPLETED')                                   AS completed_count,
         COUNT(*) FILTER (WHERE state = 'FAILED' AND retries = 0)                      AS dlq_count,
         MIN(available_at) FILTER (WHERE state IN ('CREATED','LOCKED') AND available_at <= $1) AS oldest_available_at
       FROM choros.job`,
      [now]
    );
    const row = rows[0];
    const oldestAvailableAt = row.oldest_available_at != null
      ? Number(row.oldest_available_at)
      : null;
    const stats: QueueStats = {
      depth: Number(row.depth),
      lockedCount: Number(row.locked_count),
      failedCount: Number(row.failed_count),
      completedCount: Number(row.completed_count),
      dlqCount: Number(row.dlq_count),
      oldestAvailableLagMs: oldestAvailableAt != null ? now - oldestAvailableAt : null,
    };
    return { ok: true, stats };
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

  const result = await getQueueStats(dbUrl);
  if (result.ok) {
    // Flatten for CLI output (stats fields at top level)
    const out = { ok: true, ...result.stats };
    process.stdout.write(JSON.stringify(out) + "\n");
  } else {
    process.stdout.write(JSON.stringify(result) + "\n");
  }
  process.exit(0);
}

// Guard: only run CLI when invoked directly (not when imported by tests)
const isMain = process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
   process.argv[1].endsWith("queue_stats.js"));

if (isMain) {
  cli().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
    process.exit(0);
  });
}
