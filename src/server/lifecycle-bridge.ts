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
} from "../core/externalTaskBridge.js";
import { startOutboxDispatcherLoop, defaultBackoff, type Deliver } from "../core/outboxDispatcher.js";
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
  type ChannelRegistry,
} from "../core/notification-router.js";

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
   * Production: Map with inAppNoOpDriver + EmailChannelDriver.
   * Tests: override with a stub registry (e.g. Map with a stub email driver).
   * When absent (undefined), defaults to a Map with only inAppNoOpDriver.
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

  const flowableClient = makeFlowableClient({
    baseUrl,
    adminUser: env["FLOWABLE_ADMIN_USER"] ?? "admin",
    adminPassword: env["FLOWABLE_ADMIN_PASSWORD"] ?? "test",
    timeoutMs: 10_000,
    maxRetries: 3,
    retryBaseDelayMs: 500,
    retryMaxDelayMs: 5_000,
  });

  const topics = (env["FLOWABLE_TOPICS"] ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // (1) Poll loop: Flowable external tasks → outbox rows.
  const pollLoop = startBridgePollLoop(flowableClient, deps.jobStore, {
    topics,
    workerId: env["FLOWABLE_WORKER_ID"] ?? "choros-bridge",
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
  // Notification rows (aggregateKind='notification') are handled by notificationDeliver
  // first; makeNotificationDeliver returns idempotentSuccess=true for non-notification
  // rows, so external-task rows fall through to externalTaskDeliver cleanly.
  // maxAttempts=1 for the notification path: immediate-dead semantics (ADR §2.6,
  // IMMEDIATE_DEAD_ERROR_PREFIX rows die on first attempt without back-off cycle).
  const registry: ChannelRegistry =
    deps.notificationRegistry ?? new Map([[inAppNoOpDriver.key, inAppNoOpDriver]]);
  const notificationDeliver = makeNotificationDeliver(registry);
  const externalTaskDeliver = makeExternalTaskDeliver(flowableClient, deps.jobStore);

  // Composed deliver: notification rows handled by notificationDeliver,
  // all other rows (pass-through {ok:true,idempotentSuccess:true} from notificationDeliver)
  // re-routed to externalTaskDeliver for their actual delivery.
  const deliver: Deliver = async (row) => {
    if (row.aggregateKind === "notification") {
      return notificationDeliver(row);
    }
    return externalTaskDeliver(row);
  };

  const dispatchLoop = startOutboxDispatcherLoop(deps.outboxStore, deliver, {
    batchLimit: 10,
    maxAttempts: 5,
    backoff: defaultBackoff,
    onDispatched: auditOnDispatched,
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
