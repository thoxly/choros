/**
 * src/main.ts
 *
 * T-0068 (FR-8) composition root for the process entry point. Extracted from the
 * index.ts main block so it is unit/integration-testable WITHOUT spawning the real
 * process: a wired-entry test calls startMain (NOT createServer) with in-memory
 * leaves and asserts a lifecycle event reaches audit_event through the REAL wiring
 * (both loops → onDispatched → encoder → writer.appendAuditEvent).
 *
 * Production path: when DATABASE_URL + FLOWABLE_BASE_URL are set, this constructs a
 * real pg pool, a PostgresJobStore + PostgresOutboxStore, and starts the lifecycle
 * bridge (poll loop + outbox dispatcher loop with the audit onDispatched callback).
 * Absent either env it degrades honestly: the server still starts; the lifecycle
 * audit path stays a dormant no-op (startLifecycleBridge returns a no-op handle).
 */

import http from "node:http";
import { Pool } from "pg";
import { createServer } from "./server.js";
import { PostgresJobStore } from "./core/jobStore.js";
import { PostgresOutboxStore } from "./core/postgres/pgOutboxStore.js";
import {
  startLifecycleBridge,
  type LifecycleBridgeDeps,
  type LifecycleBridgeHandle,
} from "./server/lifecycle-bridge.js";

export interface MainHandle {
  /** The listening HTTP server (undefined when listen is suppressed in tests). */
  server?: http.Server;
  /** The lifecycle bridge handle (no-op when degraded). */
  lifecycle: LifecycleBridgeHandle;
  /** Graceful shutdown: stops the bridge loops and closes the server. */
  stop: () => void;
}

export interface StartMainOptions {
  /** Listening port. Ignored when `listen` is false. */
  port?: number;
  /** Whether to actually bind the HTTP port. Default true; tests pass false. */
  listen?: boolean;
  /** Env source (injectable for tests). Default process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Override the lifecycle bridge deps. In production these are built from
   * DATABASE_URL (pool/jobStore/outboxStore). A wired-entry test injects in-memory
   * leaves (auditWriter, withTenantTx, a fake outboxStore/jobStore) so the REAL
   * composition runs against fakes.
   */
  lifecycleDeps?: LifecycleBridgeDeps;
  /** Override startLifecycleBridge (default: the real one). For composition only. */
  startBridge?: typeof startLifecycleBridge;
}

/**
 * Build lifecycle bridge deps from env. Returns {} (degraded) when DATABASE_URL is
 * absent — startLifecycleBridge then returns a no-op handle even if FLOWABLE_BASE_URL
 * is set, since the audit writer + dispatcher have no pool to run against.
 */
function buildLifecycleDepsFromEnv(env: NodeJS.ProcessEnv): {
  deps: LifecycleBridgeDeps;
  pool?: Pool;
} {
  const dbUrl = env["DATABASE_URL"];
  if (dbUrl === undefined || dbUrl === "") return { deps: {} };
  const pool = new Pool({ connectionString: dbUrl });
  const deps: LifecycleBridgeDeps = {
    pool,
    jobStore: new PostgresJobStore(pool),
    outboxStore: new PostgresOutboxStore(pool),
  };
  return { deps, pool };
}

/**
 * Start the choros process: HTTP server + lifecycle-audit bridge. Pure composition
 * — no module-level side effects (importing this file starts nothing).
 */
export function startMain(opts: StartMainOptions = {}): MainHandle {
  const env = opts.env ?? process.env;
  const listen = opts.listen ?? true;
  const start = opts.startBridge ?? startLifecycleBridge;

  let ownedPool: Pool | undefined;
  let lifecycleDeps: LifecycleBridgeDeps;
  if (opts.lifecycleDeps !== undefined) {
    lifecycleDeps = opts.lifecycleDeps;
  } else {
    const built = buildLifecycleDepsFromEnv(env);
    lifecycleDeps = built.deps;
    ownedPool = built.pool;
  }

  let server: http.Server | undefined;
  if (listen) {
    const port = opts.port ?? Number(env["PORT"] ?? 8080);
    server = createServer().listen(port, () => {
      process.stdout.write(`choros listening on port ${port}\n`);
    });
  }

  // T-0068 (FR-8): start the lifecycle-audit bridge alongside the server, NEVER
  // inside createServer (so test imports of the server do not start a loop — FF-9).
  // Degraded without FLOWABLE_BASE_URL / DATABASE_URL: returns a no-op handle.
  const lifecycle = start(lifecycleDeps, env);

  return {
    server,
    lifecycle,
    stop: () => {
      lifecycle.stop();
      server?.close();
      void ownedPool?.end();
    },
  };
}
