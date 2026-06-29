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
  buildProductionNotificationRegistry,
  type LifecycleBridgeDeps,
  type LifecycleBridgeHandle,
} from "./server/lifecycle-bridge.js";
import {
  startAgentDispatchLoop,
  buildAgentDispatchDeps,
  buildDegradedAgentDispatchDeps,
  type AgentDispatchHandle,
  type AgentDispatchDeps,
} from "./server/agent-dispatch-loop.js";
import {
  startTimerFiringLoop,
  buildTimerFiringDeps,
  type TimerFiringHandle,
  type TimerFiringDeps,
} from "./server/timer-firing-loop.js";
import { makeKeyedDigest, type KeyedDigest } from "./core/keyed-digest.js";

export interface MainHandle {
  /** The listening HTTP server (undefined when listen is suppressed in tests). */
  server?: http.Server;
  /** The lifecycle bridge handle (no-op when degraded). */
  lifecycle: LifecycleBridgeHandle;
  /**
   * T-0392 [D4-FU]: the agent dispatch loop handle (no-op when degraded —
   * topics empty or DATABASE_URL absent). Stopped in the graceful shutdown
   * alongside the lifecycle bridge (parallel background loop pattern).
   */
  agentDispatch: AgentDispatchHandle;
  /**
   * T-0535 [ENGINE-CORE]: the background timer-firing loop handle (no-op when
   * degraded — no DB pool or no FLOWABLE_BASE_URL). Drives reconcileInstanceTimers
   * across tenants on a schedule so step deadlines/timers fire WITHOUT a reader.
   * Stopped in the graceful shutdown alongside the other background loops.
   */
  timerFiring: TimerFiringHandle;
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
  /**
   * T-0392 [D4-FU]: Override the agent dispatch deps. In production these are built
   * from DATABASE_URL (pool/jobStore/outboxStore) via buildAgentDispatchDeps.
   * Tests inject in-memory deps so the composition wiring is exercised without IO.
   * When absent AND DATABASE_URL is set, the production deps are built automatically.
   * When absent AND DATABASE_URL is absent, the loop degrades to a no-op (topics=[]).
   */
  agentDispatchDeps?: AgentDispatchDeps;
  /** Override startAgentDispatchLoop (default: the real one). For composition only. */
  startDispatch?: typeof startAgentDispatchLoop;
  /**
   * T-0535 [ENGINE-CORE]: Override the timer-firing deps. In production these are
   * built from the shared pool + FLOWABLE_BASE_URL via buildTimerFiringDeps. Tests
   * inject in-memory deps (mock engine + tenant source) so the composition wiring is
   * exercised without IO. When absent AND a pool+engine exist, built automatically;
   * otherwise the loop degrades to a no-op (deps undefined).
   */
  timerFiringDeps?: TimerFiringDeps;
  /** Override startTimerFiringLoop (default: the real one). For composition only. */
  startTimerFiring?: typeof startTimerFiringLoop;
}

/**
 * Build lifecycle bridge deps from env. Returns {} (degraded) when DATABASE_URL is
 * absent — startLifecycleBridge then returns a no-op handle even if FLOWABLE_BASE_URL
 * is set, since the audit writer + dispatcher have no pool to run against.
 *
 * T-0170 E-N.3 (R-2): when DATABASE_URL is present, also builds the production
 * notification registry (inAppNoOpDriver + EmailChannelDriver) via
 * buildProductionNotificationRegistry(pool). This ensures the email channel is
 * reachable in production (FR-9: registry includes emailChannelDriver).
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
    // T-0170 E-N.3 (R-2): production notification registry — email channel reachable.
    notificationRegistry: buildProductionNotificationRegistry(pool),
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
 * Start the choros process: HTTP server + lifecycle-audit bridge + agent-dispatch
 * loop. Pure composition — no module-level side effects (importing this file starts
 * nothing).
 */
export function startMain(opts: StartMainOptions = {}): MainHandle {
  const env = opts.env ?? process.env;
  const listen = opts.listen ?? true;
  const start = opts.startBridge ?? startLifecycleBridge;
  const startDispatch = opts.startDispatch ?? startAgentDispatchLoop;
  const startTimerFiring = opts.startTimerFiring ?? startTimerFiringLoop;

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

  // T-0392 [D4-FU]: start the agent-dispatch poll loop alongside the lifecycle
  // bridge (same composition-root pattern — NEVER inside createServer, FF-9).
  // Degraded when DATABASE_URL absent (no pool → topics=[] → noopHandle). When
  // DATABASE_URL is set, builds production deps from the same pool as lifecycleDeps
  // (pool is shared; each background loop owns its own connections from it).
  let agentDispatchDeps: AgentDispatchDeps;
  if (opts.agentDispatchDeps !== undefined) {
    agentDispatchDeps = opts.agentDispatchDeps;
  } else if (
    lifecycleDeps.pool !== undefined &&
    lifecycleDeps.jobStore !== undefined &&
    lifecycleDeps.outboxStore !== undefined
  ) {
    // Production: share the pool/jobStore/outboxStore already built for the
    // lifecycle bridge. buildAgentDispatchDeps reads AGENT_TOPICS from env.
    agentDispatchDeps = buildAgentDispatchDeps(
      {
        pool: lifecycleDeps.pool,
        jobStore: lifecycleDeps.jobStore,
        outboxStore: lifecycleDeps.outboxStore,
      },
      env,
    );
  } else {
    // No pool available — degrade to empty topics: startAgentDispatchLoop returns
    // noopHandle immediately (topics.length === 0 branch). The other deps fields
    // are never reached so minimal stubs satisfy the type.
    agentDispatchDeps = buildDegradedAgentDispatchDeps();
  }
  const agentDispatch = startDispatch(agentDispatchDeps);

  // T-0535 [ENGINE-CORE]: start the background timer-firing loop alongside the other
  // background loops (same composition-root pattern — NEVER inside createServer). It
  // drives reconcileInstanceTimers cross-tenant on a schedule so configured step
  // deadlines/timers fire WITHOUT waiting for someone to open the inbox (the on-read
  // reconcile from T-0458 remains as a safety net). Degraded to a no-op when there is
  // no DB pool or no FLOWABLE_BASE_URL (buildTimerFiringDeps returns undefined →
  // startTimerFiringLoop returns a noopHandle). The pool is shared with the other
  // loops (each owns its own connections from it).
  let timerFiringDeps: TimerFiringDeps | undefined;
  if (opts.timerFiringDeps !== undefined) {
    timerFiringDeps = opts.timerFiringDeps;
  } else {
    timerFiringDeps = buildTimerFiringDeps(lifecycleDeps.pool, env);
  }
  const timerFiring = startTimerFiring(timerFiringDeps);

  return {
    server,
    lifecycle,
    agentDispatch,
    timerFiring,
    resolverDeps: resolverDepsObj, // same allocation as passed to createServer() (R-2 / AC-7)
    stop: () => {
      lifecycle.stop();
      agentDispatch.stop();
      timerFiring.stop();
      server?.close();
      void ownedPool?.end();
    },
  };
}
