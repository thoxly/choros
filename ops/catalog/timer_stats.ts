/**
 * ops/catalog/timer_stats.ts — T-0116 ops operation (ADR §3.8)
 *
 * Returns timer metrics for choros.app_timer as JSON.
 * Idempotent: pure SELECT, safe to run any number of times.
 * Accepts DATABASE_URL from environment or --db CLI arg.
 * Outputs JSON to stdout; exits 0 on all outcomes (never throws past top-level catch).
 *
 * Autonomy tier: T0 (automatic, logged).
 * Run:
 *   DATABASE_URL=<migrator-url> node ops/dist/timer_stats.js
 *   node ops/dist/timer_stats.js --db <url>
 *
 * Uses migrator URL (no GUC, no RLS filter) → sees all tenants.
 *
 * Output shape (ADR §3.8):
 *   {
 *     ok: true,
 *     pendingCount: number,
 *     firingCount: number,
 *     doneCount: number,
 *     cancelledCount: number,
 *     overdueCount: number,          // state='pending' AND due_at < now
 *     timerLagMs: number | null      // MAX(now - due_at) WHERE state='pending' AND due_at < now
 *   }
 *   | { ok: false, error: string }   // on connection failure
 */
import pg from "pg";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimerStats {
  pendingCount: number;
  firingCount: number;
  doneCount: number;
  cancelledCount: number;
  overdueCount: number;
  timerLagMs: number | null;
}

export interface TimerStatsOk {
  ok: true;
  stats: TimerStats;
}
export interface TimerStatsFail {
  ok: false;
  error: string;
}
export type TimerStatsResult = TimerStatsOk | TimerStatsFail;

// ---------------------------------------------------------------------------
// Programmatic API — for use in integration tests without subprocess spawn
// ---------------------------------------------------------------------------

/**
 * Programmatic timer stats runner. Never throws. Returns TimerStatsResult.
 */
export async function getTimerStats(dbUrl: string): Promise<TimerStatsResult> {
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    const now = Date.now();
    const { rows } = await pool.query<{
      pending_count: string;
      firing_count: string;
      done_count: string;
      cancelled_count: string;
      overdue_count: string;
      timer_lag_ms: string | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE state = 'pending')                          AS pending_count,
         COUNT(*) FILTER (WHERE state = 'firing')                           AS firing_count,
         COUNT(*) FILTER (WHERE state = 'done')                             AS done_count,
         COUNT(*) FILTER (WHERE state = 'cancelled')                        AS cancelled_count,
         COUNT(*) FILTER (WHERE state = 'pending' AND due_at < $1)          AS overdue_count,
         MAX($1 - due_at) FILTER (WHERE state = 'pending' AND due_at < $1)  AS timer_lag_ms
       FROM choros.app_timer`,
      [now]
    );
    const row = rows[0];
    const timerLagMs = row.timer_lag_ms != null ? Number(row.timer_lag_ms) : null;
    const stats: TimerStats = {
      pendingCount: Number(row.pending_count),
      firingCount: Number(row.firing_count),
      doneCount: Number(row.done_count),
      cancelledCount: Number(row.cancelled_count),
      overdueCount: Number(row.overdue_count),
      timerLagMs,
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

  const result = await getTimerStats(dbUrl);
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
   process.argv[1].endsWith("timer_stats.js"));

if (isMain) {
  cli().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
    process.exit(0);
  });
}
