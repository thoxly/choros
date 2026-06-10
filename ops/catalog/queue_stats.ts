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
 *     depth: number,          // CREATED with available_at<=now AND LOCKED rows ready
 *     lockedCount: number,    // LOCKED rows
 *     failedCount: number,    // FAILED rows
 *     completedCount: number, // COMPLETED rows
 *     dlqCount: number,       // FAILED with retries=0 (dead letter queue)
 *     oldestAvailableLagMs: number | null
 *   }
 */
import pg from "pg";
import { parseArgs } from "node:util";

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
// Core query (ADR §4.6)
// ---------------------------------------------------------------------------
async function fetchStats(pool: pg.Pool): Promise<QueueStats> {
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
  return {
    depth: Number(row.depth),
    lockedCount: Number(row.locked_count),
    failedCount: Number(row.failed_count),
    completedCount: Number(row.completed_count),
    dlqCount: Number(row.dlq_count),
    oldestAvailableLagMs: oldestAvailableAt != null ? now - oldestAvailableAt : null,
  };
}

// ---------------------------------------------------------------------------
// Programmatic API — for use in integration tests
// ---------------------------------------------------------------------------
/**
 * Programmatic queue stats runner. Never throws. Returns QueueStatsResult.
 */
export async function getQueueStats(dbUrl: string): Promise<QueueStatsResult> {
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    const stats = await fetchStats(pool);
    return { ok: true, stats };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
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

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  process.exit(0);
});
