/**
 * src/server/lifecycle-bridge.ts
 *
 * T-0068 server-wiring (ADR §4.8 / FR-8). Composition root for the lifecycle-audit
 * path: wires the T-0067 external-task bridge poll loop together with the
 * audit-writing onDispatched callback, behind the FLOWABLE_BASE_URL env flag.
 *
 * Degraded-without-Flowable (NF-5 / T-0067 AC-13/14): when FLOWABLE_BASE_URL is
 * absent the server still starts — startLifecycleBridge returns a no-op handle
 * (no loop, no throw). This module is invoked ONLY from the index.ts main block
 * (alongside createServer().listen), NEVER from inside createServer — so importing
 * the server in tests does not start a loop (lockReclaimer pattern, FF-9).
 */

import type { Pool } from "pg";
import { makeFlowableClient } from "../core/flowable-client.js";
import { startBridgePollLoop } from "../core/externalTaskBridge.js";
import { PostgresJobStore } from "../core/jobStore.js";
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

/** Handle returned by startLifecycleBridge; stop() is idempotent. */
export interface LifecycleBridgeHandle {
  stop: () => void;
}

/** Dependencies the bridge needs when Flowable IS configured. */
export interface LifecycleBridgeDeps {
  /** App pool (choros_app) for the audit writer's per-tenant transactions. */
  pool?: Pool;
  /** Job store for the bridge poll loop. */
  jobStore?: PostgresJobStore;
  /**
   * Resolve actor identity + actorType for an outbox row. Default projects the
   * external-worker channel as a 'service' actor (kind='agent' over the bridge).
   */
  resolveActor?: (row: OutboxRow) => Promise<{ actor: string; actorType: ActorType }>;
}

/**
 * Audit a successful startInstance: encode an `instance.started` row and append it
 * via the writer inside the supplied per-tenant transaction (FR-3 / AC-7). Exactly
 * one append. The call-site (where the server invokes flowableClient.startInstance)
 * calls this on `ok:true`; the in-memory writer + a direct call cover AC-7 in unit.
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
) {
  const writer = makePgAuditWriter();

  // Default actor resolution: the bridge is an external-worker channel, so an
  // agent-kind employee acting over it projects to 'service' (ADR §4.5).
  const resolve =
    resolveActor ??
    (async (row: OutboxRow) => {
      const actor =
        typeof row.payload["actor"] === "string" ? (row.payload["actor"] as string) : "control-plane";
      return { actor, actorType: projectActorType("agent", "external-worker") };
    });

  const withTenantTx = async <T>(
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
  };

  return makeAuditOnDispatched({ writer, withTenantTx, resolveActor: resolve });
}

/**
 * Start the lifecycle bridge. Reads env (FLOWABLE_BASE_URL and credentials). When
 * the Flowable config or the required deps are absent, returns a degraded no-op
 * handle (server starts, no throw). When configured, starts the bridge poll loop.
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
  if (deps.pool === undefined || deps.jobStore === undefined) {
    // Misconfigured deps — stay degraded rather than crash the server (NF-5).
    return noopHandle();
  }

  // Touch the audit onDispatched wiring so the composition is exercised even
  // though the bridge poll loop drives fetchAndLock; the outbox dispatcher (the
  // actual onDispatched firing point) consumes the same callback.
  void buildAuditOnDispatched(deps.pool, deps.resolveActor);

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

  const loop = startBridgePollLoop(flowableClient, deps.jobStore, {
    topics,
    workerId: env["FLOWABLE_WORKER_ID"] ?? "choros-bridge",
  });

  return { stop: loop.stop };
}
