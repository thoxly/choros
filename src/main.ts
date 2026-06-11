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
import { createServer, createJobStore } from "./server.js";
import { PostgresJobStore } from "./core/jobStore.js";
import { PostgresOutboxStore } from "./core/postgres/pgOutboxStore.js";
import {
  startLifecycleBridge,
  type LifecycleBridgeDeps,
  type LifecycleBridgeHandle,
} from "./server/lifecycle-bridge.js";
import { makeKeyedDigest, type KeyedDigest } from "./core/keyed-digest.js";

export interface MainHandle {
  /** The listening HTTP server (undefined when listen is suppressed in tests). */
  server?: http.Server;
  /** The lifecycle bridge handle (no-op when degraded). */
  lifecycle: LifecycleBridgeHandle;
  /**
   * T-0118 (E4.3-fu): the resolver-deps fragment assembled at the composition
   * root. Currently carries the per-tenant `KeyedDigest` port bound to the silo
   * secret `CHOROS_MASK_DIGEST_KEY` — the request-path `makeGrantResolver`
   * assembly (not yet wired in this entry, ADR §4.4 NOTE) spreads this into its
   * `ResolverDeps`. `keyedDigest` is ALWAYS present (the factory honest-degrades
   * to a digest()⇒undefined instance when the secret is absent), so `hash`
   * fields fail closed to `drop` — never keyless, never raw (AC-6).
   */
  resolverDeps: { keyedDigest: KeyedDigest };
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
 * T-0118 (E4.3-fu) — read the per-silo masking digest secret at the composition
 * root (the ONLY `process.env` boundary; never under `src/core/`, FF-DC9) and
 * bind it into a `KeyedDigest`. Honest-degrade, mirroring
 * `buildLifecycleDepsFromEnv`: when `CHOROS_MASK_DIGEST_KEY` is absent/empty the
 * factory returns a `KeyedDigest` whose `digest()` always yields `undefined` ⇒
 * every `hash` field fails closed to `drop` (AC-6) — the server still starts, no
 * keyless digest is ever emitted, raw is never revealed. The secret is decoded
 * as hex when it is a valid even-length hex string, else base64 — matching the
 * `.env.prod.example` guidance (`openssl rand -hex 32`). The key is read here
 * ONLY and is NEVER logged.
 */
function buildKeyedDigestFromEnv(env: NodeJS.ProcessEnv): KeyedDigest {
  const raw = env["CHOROS_MASK_DIGEST_KEY"];
  if (raw === undefined || raw === "") return makeKeyedDigest(undefined);
  const isHex = raw.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(raw);
  const key = Buffer.from(raw, isHex ? "hex" : "base64");
  return makeKeyedDigest(key.length === 0 ? undefined : key);
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

  // T-0118: bind the silo masking secret into the KeyedDigest port at the
  // composition root (the only process.env boundary). Honest-degrade when absent.
  const keyedDigest = buildKeyedDigestFromEnv(env);

  // T-0143: single allocation for the composition-root wiring fragment.
  // Only keyedDigest exists at startup; per-request sources (grants/records/ancestry)
  // are assembled at the route (ADR §4.3 amendment after review R-3).
  // resolverDepsObj is passed to createServer() AND placed on MainHandle.resolverDeps
  // — same object identity by construction (R-2 fix, ADR §4.3).
  const resolverDepsObj: { keyedDigest: KeyedDigest } = { keyedDigest };

  let server: http.Server | undefined;
  if (listen) {
    const port = opts.port ?? Number(env["PORT"] ?? 8080);
    server = createServer(createJobStore(), resolverDepsObj).listen(port, () => {
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
    resolverDeps: resolverDepsObj, // same allocation as passed to createServer() (R-2 / AC-7)
    stop: () => {
      lifecycle.stop();
      server?.close();
      void ownedPool?.end();
    },
  };
}
