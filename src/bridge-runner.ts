/**
 * T-0067: bridge-runner — CLI runner for bridge-e2e-smoke.sh.
 *
 * Runs one pass of runBridgeOnce against a real Flowable + Postgres and
 * prints the result as JSON. Used only in the live E2E smoke gate.
 *
 * Usage (from repo root after `npm run build`):
 *   DATABASE_URL=postgres://... \
 *   FLOWABLE_BASE_URL=http://localhost:18085/flowable-rest/service \
 *   FLOWABLE_REST_APP_ADMIN_PASSWORD=choros_flowable_dev_pw \
 *   BRIDGE_TENANT_ID=<uuid> \
 *   BRIDGE_TOPICS=smoke-topic \
 *   node dist/bridge-runner.js
 *
 * Exit 0 on success (even if 0 tasks returned — empty queue is not an error).
 * Exit 1 on any error.
 */

import pg from "pg";
import { makeFlowableClient } from "./core/flowable-client.js";
import { PostgresJobStore } from "./core/postgres/pgJobStore.js";
import { runBridgeOnce } from "./core/externalTaskBridge.js";

const { Pool } = pg;

async function main(): Promise<void> {
  const dbUrl = process.env["DATABASE_URL"];
  if (!dbUrl) throw new Error("DATABASE_URL is required");

  const tenantId = process.env["BRIDGE_TENANT_ID"];
  if (!tenantId) throw new Error("BRIDGE_TENANT_ID is required");

  const topicsEnv = process.env["BRIDGE_TOPICS"] ?? "";
  const topics = topicsEnv.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  if (topics.length === 0) throw new Error("BRIDGE_TOPICS is required (comma-separated)");

  const workerId = process.env["BRIDGE_WORKER_ID"] ?? "choros-bridge-smoke";
  const lockDurationMs = Number(process.env["BRIDGE_LOCK_MS"] ?? "30000");
  const maxTasksPerTopic = Number(process.env["BRIDGE_MAX_TASKS"] ?? "10");
  const retries = Number(process.env["BRIDGE_RETRIES"] ?? "3");

  const pool = new Pool({ connectionString: dbUrl });
  const jobStore = new PostgresJobStore(pool);
  const flowableClient = makeFlowableClient();

  // Set the tenant GUC for all operations in this runner.
  // We use a dedicated connection to set the session-level GUC.
  const client = await pool.connect();
  try {
    await client.query(`SET "choros.tenant_id" = '${tenantId.replace(/'/g, "''")}'`);

    const result = await runBridgeOnce(
      flowableClient,
      jobStore,
      topics,
      workerId,
      lockDurationMs,
      maxTasksPerTopic,
      retries,
    );

    console.log(JSON.stringify(result));
    if (result.errors > 0) {
      process.stderr.write(
        `[bridge-runner] ${result.errors} topic(s) returned errors\n`,
      );
      process.exit(1);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(`[bridge-runner] FATAL: ${String(err)}\n`);
  process.exit(1);
});
