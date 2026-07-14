/**
 * src/server/lifecycle-bridge.ts
 *
 * T-0068 server-wiring (ADR §4.8 / FR-8). Composition root for the lifecycle-audit
 * path: wires the T-0067 external-task bridge poll loop together with the
 * audit-writing onDispatched callback, behind the FLOWABLE_BASE_URL env flag.
 *
 * T-0170 E-N.3 wiring: makeNotificationDeliver is COMPOSED with makeExternalTaskDeliver
 * in the production dispatch loop. Notification outbox rows (aggregateKind='notification')
 * are handled by makeNotificationDeliver first; other rows fall through to
 * makeExternalTaskDeliver (pass-through idempotent success for notification rows).
 * Notification dispatcher uses maxAttempts=1 to honour immediate-dead semantics
 * (IMMEDIATE_DEAD_ERROR_PREFIX rows die on first attempt — ADR T-0120 §2.6).
 *
 * Degraded-without-Flowable (NF-5 / T-0067 AC-13/14): when FLOWABLE_BASE_URL is
 * absent the server still starts — startLifecycleBridge returns a no-op handle
 * (no loop, no throw). This module is invoked ONLY from the index.ts main block
 * (alongside createServer().listen), NEVER from inside createServer — so importing
 * the server in tests does not start a loop (lockReclaimer pattern, FF-9).
 */

import type { Pool } from "pg";
import { makeFlowableClient } from "../core/flowable-client.js";
import {
  startBridgePollLoop,
  makeExternalTaskDeliver,
  DEFAULT_BRIDGE_WORKER_ID,
} from "../core/externalTaskBridge.js";
import { startOutboxDispatcherLoop, defaultBackoff, type Deliver, type RunOutboxOptions } from "../core/outboxDispatcher.js";
import { PostgresJobStore } from "../core/jobStore.js";
import { PostgresOutboxStore } from "../core/postgres/pgOutboxStore.js";
import {
  makePgAuditWriter,
  type AuditWriter,
  type PgClientLike,
} from "../db/audit-writer.js";
import {
  encodeLifecycleAuditEvent,
  makeAuditOnDispatched,
  projectActorType,
  type ActorType,
} from "../core/lifecycle-audit.js";
import type { OutboxRow } from "../core/outboxTypes.js";
// T-0170 E-N.3: notification routing (makeNotificationDeliver + channel registry)
import {
  makeNotificationDeliver,
  inAppNoOpDriver,
  IMMEDIATE_DEAD_ERROR_PREFIX,
  type ChannelRegistry,
} from "../core/notification-router.js";
// T-0170 E-N.3 production wiring: EmailChannelDriver + resolver + pg DAO
import {
  EmailChannelDriver,
  makeDirectStringSmtpResolver,
} from "../core/notification-email.js";
import { PgEmailConfigStore } from "../core/postgres/pgEmailConfigStore.js";
import { NodemailerSmtpSender } from "../adapters/smtp-sender.js";

/** Handle returned by startLifecycleBridge; stop() is idempotent. */
export interface LifecycleBridgeHandle {
  stop: () => void;
}

/** Dependencies the bridge needs when Flowable IS configured. */
export interface LifecycleBridgeDeps {
  /** App pool (choros_app) for the audit writer's per-tenant transactions. */
  pool?: Pool;
  /** Job store for the bridge poll loop + external-task deliver reverse-map. */
  jobStore?: PostgresJobStore;
  /** Outbox store the dispatcher loop drains (where onDispatched fires). */
  outboxStore?: PostgresOutboxStore;
  /**
   * Resolve actor identity + actorType for an outbox row. Default projects the
   * external-worker channel as a 'service' actor (kind='agent' over the bridge).
   */
  resolveActor?: (row: OutboxRow) => Promise<{ actor: string; actorType: ActorType }>;
  /**
   * TEST SEAMS (production leaves them undefined → real pg/Flowable path). They
   * let a wired-entry integration test exercise the REAL composition (both loops,
   * onDispatched, encoder, writer.appendAuditEvent) against in-memory leaves —
   * the wiring is real, only the boundary IO is faked.
   */
  /** Override the audit writer (e.g. InMemoryAuditWriter). Default makePgAuditWriter(). */
  auditWriter?: AuditWriter;
  /** Override the per-tenant tx runner. Default opens a pg tx + sets the GUC. */
  withTenantTx?: <T>(tenantId: string, fn: (tx: PgClientLike) => Promise<T>) => Promise<T>;
  /** Poll interval for both loops (ms). */
  intervalMs?: number;
  /** Injectable setInterval for deterministic tests. */
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  /**
   * T-0170 E-N.3 wiring: notification channel registry for makeNotificationDeliver.
   * Production (main.ts): Map with inAppNoOpDriver + EmailChannelDriver (wired via
   *   buildProductionNotificationRegistry(pool)). This is the canonical production
   *   default — email channel is reachable in production.
   * Tests: override with a stub registry (e.g. Map with a stub email driver).
   * When absent (undefined), defaults to a Map with only inAppNoOpDriver (degraded:
   *   in_app channel works; email rows return IMMEDIATE_DEAD and die on attempt 1).
   */
  notificationRegistry?: ChannelRegistry;
}

/**
 * Audit a successful startInstance: encode an `instance.started` row and append it
 * via the canonical writer inside the supplied per-tenant transaction (FR-3). Exactly
 * one append.
 *
 * FORWARD-OBLIGATION (honest seam, not yet live): there is NO production HTTP route
 * that calls flowableClient.startInstance today — the only call-sites are the
 * flowable-client tests and the bridge smoke runner. This wrapper is therefore the
 * sanctioned call-site FOR the start-instance route when it lands (the route task
 * MUST invoke auditInstanceStarted on ok:true inside its own withTenant tx). The
 * RUNTIME lifecycle audit path that IS live end-to-end in this build is
 * task.completed / task.failed via the outbox dispatcher's onDispatched (see
 * startLifecycleBridge). The in-memory writer + a direct call cover AC-7 in unit.
 */
export async function auditInstanceStarted(
  writer: AuditWriter,
  tx: PgClientLike,
  args: {
    instanceId: string;
    processKey: string;
    actor: string;
    actorType: ActorType;
    via?: string | null;
  },
  nowMs: number = Date.now(),
): Promise<void> {
  const event = encodeLifecycleAuditEvent(
    {
      kind: "instance.started",
      instanceId: args.instanceId,
      processKey: args.processKey,
      actor: args.actor,
      actorType: args.actorType,
      via: args.via,
    },
    nowMs,
  );
  await writer.appendAuditEvent(tx, event);
}

/** A no-op handle (degraded / no Flowable config). */
function noopHandle(): LifecycleBridgeHandle {
  let stopped = false;
  return {
    stop: () => {
      stopped = true;
      void stopped; // idempotent no-op
    },
  };
}

/**
 * Build the audit onDispatched callback for the wired bridge. Exported so the
 * outbox dispatcher composition (where onDispatched actually fires after a durable
 * markDispatched) can use the identical wiring as the bridge.
 */
export function buildAuditOnDispatched(
  pool: Pool,
  resolveActor?: (row: OutboxRow) => Promise<{ actor: string; actorType: ActorType }>,
  writerOverride?: AuditWriter,
  withTenantTxOverride?: <T>(tenantId: string, fn: (tx: PgClientLike) => Promise<T>) => Promise<T>,
) {
  const writer = writerOverride ?? makePgAuditWriter();

  // Default actor resolution: the bridge is an external-worker channel, so an
  // agent-kind employee acting over it projects to 'service' (ADR §4.5).
  const resolve =
    resolveActor ??
    (async (row: OutboxRow) => {
      const actor =
        typeof row.payload["actor"] === "string" ? (row.payload["actor"] as string) : "control-plane";
      return { actor, actorType: projectActorType("agent", "external-worker") };
    });

  const withTenantTx =
    withTenantTxOverride ??
    (async <T>(
    tenantId: string,
    fn: (tx: PgClientLike) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId.replace(/'/g, "''")}'`);
      await client.query("SET LOCAL search_path TO choros");
      const result = await fn(client as unknown as PgClientLike);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {/* swallow */});
      throw err;
    } finally {
      client.release();
    }
  });

  return makeAuditOnDispatched({ writer, withTenantTx, resolveActor: resolve });
}

/**
 * T-0170 E-N.3 (R-2): Build the production notification channel registry.
 *
 * Wires:
 *   - inAppNoOpDriver (always present — in_app channel always reachable)
 *   - EmailChannelDriver (email channel — requires email_channel_config in DB)
 *       → PgEmailConfigStore(pool) — reads email_channel_config via GUC-scoped pool
 *       → makeDirectStringSmtpResolver() — day-1 direct-string SMTP resolver (ADR §8)
 *       → NodemailerSmtpSender — production SMTP adapter (node:net/tls, no nodemailer dep)
 *
 * Called from main.ts (composition root) when DATABASE_URL is set.
 * FR-9: registry includes both inAppNoOpDriver and emailChannelDriver.
 */
export function buildProductionNotificationRegistry(pool: Pool): ChannelRegistry {
  const pgEmailConfigStore = new PgEmailConfigStore(pool);
  const emailDriver = new EmailChannelDriver(
    pgEmailConfigStore,
    makeDirectStringSmtpResolver(),
    new NodemailerSmtpSender(),
  );
  return new Map([
    [inAppNoOpDriver.key, inAppNoOpDriver],
    [emailDriver.key, emailDriver],
  ]);
}

/**
 * Start the lifecycle bridge. Reads env (FLOWABLE_BASE_URL and credentials). When
 * the Flowable config or the required deps are absent, returns a degraded no-op
 * handle (server starts, no throw — NF-5). When configured, starts BOTH halves of
 * the lifecycle path:
 *
 *   (1) the bridge poll loop — fetch-and-lock external tasks from Flowable, enqueue
 *       outbox rows (task_completed / task_failed);
 *   (2) the OUTBOX DISPATCHER loop — drains those rows back into Flowable via
 *       makeExternalTaskDeliver, and fires onDispatched=makeAuditOnDispatched(...)
 *       after each durable markDispatched (exactly-once). This is the live
 *       end-to-end audit firing point (FR-4/FR-8): a completed/failed task lands a
 *       lifecycle audit_event row through the SAME canonical sink as grants.
 *
 * Both loops are stopped by the returned handle (graceful shutdown).
 */
export function startLifecycleBridge(
  deps: LifecycleBridgeDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): LifecycleBridgeHandle {
  const baseUrl = env["FLOWABLE_BASE_URL"];
  if (baseUrl === undefined || baseUrl === "") {
    // Degraded: no engine configured. Server runs; lifecycle audit path dormant.
    return noopHandle();
  }
  if (
    deps.pool === undefined ||
    deps.jobStore === undefined ||
    deps.outboxStore === undefined
  ) {
    // Misconfigured deps — stay degraded rather than crash the server (NF-5).
    return noopHandle();
  }

  // T-0636 (P0-5): read the SAME env names src/server.ts:474-486 (process-start
  // route), src/bridge-runner.ts, and every ci/checks/db/*.db.test.ts already use
  // successfully — FLOWABLE_REST_APP_ADMIN_USER_ID / FLOWABLE_REST_APP_ADMIN_PASSWORD.
  // The old FLOWABLE_ADMIN_USER/FLOWABLE_ADMIN_PASSWORD names are never set by any
  // compose file (docker-compose.yml:136-137/199-202, .prod.yml:43, .arena.yml:87
  // all set the REST_APP_* names) — reading them always fell through to the
  // literal admin:test default, a permanent 401 in production. No default for the
  // password: absent password → honest noop-degrade (NOT a throw, NOT a literal
  // 'test' substitution — mirrors the FLOWABLE_BASE_URL degrade above, NF-5/AC-3).
  const flowableAdminPassword = env["FLOWABLE_REST_APP_ADMIN_PASSWORD"];
  if (!flowableAdminPassword) {
    return noopHandle();
  }

  const flowableClient = makeFlowableClient({
    baseUrl,
    adminUser: env["FLOWABLE_REST_APP_ADMIN_USER_ID"] ?? "admin",
    adminPassword: flowableAdminPassword,
    timeoutMs: 10_000,
    maxRetries: 3,
    retryBaseDelayMs: 500,
    retryMaxDelayMs: 5_000,
  });

  const topics = (env["FLOWABLE_TOPICS"] ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // T-0644 (P0/столп4): SINGLE source of truth for the bridge's Flowable
  // lock-holder identity — read ONCE, used for BOTH fetchAndLock (poll loop,
  // below) AND completeTask/failTask (externalTaskDeliver, below). Threading
  // the SAME value to both call-sites is what keeps the lock-holder and the
  // completer/failer in sync (a mismatch is REJECTED by the Flowable engine —
  // LIVE_PROOF diagnosis of the bug this constant closes).
  const bridgeWorkerId = env["FLOWABLE_WORKER_ID"] ?? DEFAULT_BRIDGE_WORKER_ID;

  // (1) Poll loop: Flowable external tasks → outbox rows.
  // T-0636 (P0-6/F3/F4): pass the pool so runBridgeOnce can enqueue each fetched
  // task under its OWN tenant's GUC-scoped transaction (multi-tenant bridge).
  const pollLoop = startBridgePollLoop(flowableClient, deps.jobStore, {
    topics,
    workerId: bridgeWorkerId,
    pool: deps.pool,
    ...(deps.intervalMs !== undefined ? { pollIntervalMs: deps.intervalMs } : {}),
    ...(deps.setIntervalFn !== undefined ? { setIntervalFn: deps.setIntervalFn } : {}),
  });

  // (2) Dispatcher loop: outbox rows → Flowable + lifecycle audit on dispatch.
  //     onDispatched is the REAL firing point — it appends exactly one lifecycle
  //     audit row per dispatched task_completed/task_failed (no-op for others).
  const auditOnDispatched = buildAuditOnDispatched(
    deps.pool,
    deps.resolveActor,
    deps.auditWriter,
    deps.withTenantTx,
  );

  // T-0170 E-N.3 wiring: compose makeNotificationDeliver + makeExternalTaskDeliver.
  //
  // Notification rows (aggregateKind='notification') are handled by notificationDeliver;
  // all other rows fall through to externalTaskDeliver (notification rows return
  // {ok:true, idempotentSuccess:true} from makeNotificationDeliver for non-notification
  // aggregateKinds — that path is the pass-through guard, not this composed deliver).
  //
  // Immediate-dead semantics (AC-13 / FR-8 / ADR §2.6):
  //   IMMEDIATE_DEAD_ERROR_PREFIX rows must die on attempt 1, not after maxAttempts=5.
  //   We honour this via perRowMaxAttempts (additive T-0062 option): when a notification
  //   row fails with IMMEDIATE_DEAD_ERROR_PREFIX, markRetry is called with maxAttempts=1
  //   → attempts 0+1=1 >= 1 → state='dead' on the first attempt (no back-off cycle).
  //   External-task rows are unaffected (perRowMaxAttempts returns undefined → opts.maxAttempts=5).
  const registry: ChannelRegistry =
    deps.notificationRegistry ?? new Map([[inAppNoOpDriver.key, inAppNoOpDriver]]);
  const notificationDeliver = makeNotificationDeliver(registry);
  // T-0644 (P0/столп4): pass the SAME bridgeWorkerId used for fetchAndLock above
  // (onDispatched is intentionally omitted here — undefined, mirrors pre-existing
  // call-shape; the 4th positional arg is bridgeWorkerId).
  const externalTaskDeliver = makeExternalTaskDeliver(
    flowableClient,
    deps.jobStore,
    undefined,
    bridgeWorkerId,
  );

  // Composed deliver: notification rows → notificationDeliver,
  // all other rows → externalTaskDeliver.
  const deliver: Deliver = async (row: OutboxRow) => {
    if (row.aggregateKind === "notification") {
      return notificationDeliver(row);
    }
    return externalTaskDeliver(row);
  };

  // perRowMaxAttempts: override to maxAttempts=1 for IMMEDIATE_DEAD notification rows
  // (spec AC-13/FR-8). External-task rows get the shared maxAttempts=5 ceiling.
  const perRowMaxAttempts: RunOutboxOptions["perRowMaxAttempts"] = (row, error) => {
    if (
      row.aggregateKind === "notification" &&
      error !== undefined &&
      error.startsWith(IMMEDIATE_DEAD_ERROR_PREFIX)
    ) {
      return 1; // die on first attempt (attempts 0+1=1 >= 1 → dead)
    }
    return undefined; // fall through to opts.maxAttempts
  };

  const dispatchLoop = startOutboxDispatcherLoop(deps.outboxStore, deliver, {
    batchLimit: 10,
    maxAttempts: 5,
    backoff: defaultBackoff,
    onDispatched: auditOnDispatched,
    perRowMaxAttempts,
    ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
    ...(deps.setIntervalFn !== undefined ? { setIntervalFn: deps.setIntervalFn } : {}),
  });

  return {
    stop: () => {
      pollLoop.stop();
      dispatchLoop.stop();
    },
  };
}
