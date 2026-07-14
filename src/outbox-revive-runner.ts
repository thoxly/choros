/**
 * T-0644 (P0/столп4): outbox-revive-runner — ONE-TIME operator CLI to revive
 * outbox rows dead-lettered by the bridge/agent-dispatcher workerId mismatch
 * this task fixes.
 *
 * Background: before this fix, makeExternalTaskDeliver forwarded
 * row.payload["workerId"] verbatim to Flowable's completeTask/failTask. A
 * task_completed/task_failed row PRODUCED by a component other than the
 * bridge itself (concretely: the agent dispatcher, whose payload carries
 * "choros-agent-dispatcher") was rejected by Flowable on every attempt
 * (workerId must match the fetchAndLock lock-holder) → 5 attempts exhausted
 * → state='dead' (terminal — the normal dispatch loop never reclaims a dead
 * row, ADR §4.2 monotonicity). Those rows are now safely deliverable (the
 * bridge always uses its OWN workerId — see externalTaskBridge.ts doc-comment
 * on makeExternalTaskDeliver) but need an explicit nudge back to 'pending'.
 *
 * Usage (from repo root, after `npm run build` AND after the fix above is
 * deployed and the bridge is running with its (now-correct) FLOWABLE_WORKER_ID):
 *   DATABASE_URL=postgres://...              \
 *   FLOWABLE_WORKER_ID=choros-bridge          \  (optional — same default as lifecycle-bridge.ts)
 *   node dist/outbox-revive-runner.js
 *
 * Scoped, NOT a blanket revive — see reviveDeadOutboxRows's doc-comment
 * (pgOutboxStore.ts) for the exact WHERE-clause rationale. Prints the number
 * of rows revived and exits 0. Safe to run more than once (idempotent no-op
 * once no rows match the scoped WHERE clause).
 */

import pg from "pg";
import { PostgresOutboxStore } from "./core/postgres/pgOutboxStore.js";
import { DEFAULT_BRIDGE_WORKER_ID } from "./core/externalTaskBridge.js";

const { Pool } = pg;

async function main(): Promise<void> {
  const dbUrl = process.env["DATABASE_URL"];
  if (!dbUrl) throw new Error("DATABASE_URL is required");

  // Same resolution as lifecycle-bridge.ts's bridgeWorkerId — MUST match
  // whatever the bridge is actually configured with in this environment, or
  // the scoping (payload.workerId <> bridgeWorkerId) will not match the
  // intended rows.
  const bridgeWorkerId = process.env["FLOWABLE_WORKER_ID"] ?? DEFAULT_BRIDGE_WORKER_ID;

  const pool = new Pool({ connectionString: dbUrl });
  const outboxStore = new PostgresOutboxStore(pool);

  try {
    const revived = await outboxStore.reviveDeadOutboxRows(bridgeWorkerId);
    console.log(JSON.stringify({ revived, bridgeWorkerId }));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(`[outbox-revive-runner] FATAL: ${String(err)}\n`);
  process.exit(1);
});
