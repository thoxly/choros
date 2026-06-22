/**
 * src/server/agent-dispatch-loop.ts — T-0378 [D4] (PD-2 dispatcher loop).
 *
 * The poll scheduler that drives the agent dispatcher (mirror of startBridgePollLoop
 * / startLifecycleBridge). Per pass, for each tenant with eligible agent-topic jobs:
 *   fetchAndLock → withTenantTx { assemble context → run motor → apply outcome } → COMMIT.
 *
 * Degraded-safe (NF-5, mirrors lifecycle-bridge noopHandle): no AGENT_TOPICS or no
 * deps → no-op handle (server starts, no loop, no throw). Wired in the composition
 * root (main.ts) ALONGSIDE startLifecycleBridge — NEVER inside createServer (so test
 * imports of the server do not start a loop, FF-9 / lockReclaimer pattern).
 *
 * Topic choice (ADR §2 / §8 risk 3): keys off the JOB TOPIC, not a BPMN attribute.
 * AGENT_TOPICS defaults to a DEDICATED keystone topic ("agent-step") — NOT the
 * "tel-intake" DMN-triage topic that makeExternalTaskDeliver special-cases — so the
 * dispatcher does not collide with the gateway late-compute seam.
 *
 * The loop owns NO domain logic: assembleAgentStepContext + runAgentStep +
 * applyAgentOutcome do the work. The loop is wiring + scheduling + the per-job tx.
 */

import type { Job } from "../core/types.js";
import {
  assembleAgentStepContext,
  type AssembleDeps,
  type InstructionSource,
} from "../runtime/agent-dispatch/agent-step-context.js";
import { readPublished } from "../db/agent-instruction-store.js";
import {
  runAgentStep,
  type RunAgentStepDeps,
} from "../runtime/agent-dispatch/run-agent-step.js";
import {
  applyAgentOutcome,
  type ApplyOutcomeDeps,
} from "../runtime/agent-dispatch/dispatch-outcome.js";
import type pg from "pg";
import { makeDbGrantSource } from "../db/grants-dao.js";
import { makeDbMcpToolSource } from "../db/mcp-tool-dao.js";
import { makeDbRoleGrantSource } from "../db/role-grant-dao.js";
import { makePgAuditWriter } from "../db/audit-writer.js";
import { dormantLlmPort } from "../core/llm-port.js";
import { stubBudgetPort } from "../runtime/agent-dispatch/agent-step-context.js";
import type { PostgresJobStore } from "../core/jobStore.js";
import type { PostgresOutboxStore } from "../core/postgres/pgOutboxStore.js";

/**
 * Concrete InstructionSource that delegates to the real agent-instruction-store DAO.
 * Exported from the composition root (src/server/) so src/runtime/agent-dispatch/
 * never imports agent-instruction-store directly (FF-LP-4 / T-0233 AC-11/NF-4).
 */
export const storeInstructionSource: InstructionSource = {
  readPublished,
};

/** The default DEDICATED keystone agent topic (NOT the tel-intake DMN seam). */
export const DEFAULT_AGENT_TOPIC = "agent-step";

/** Handle returned by startAgentDispatchLoop; stop() is idempotent. */
export interface AgentDispatchHandle {
  stop: () => void;
}

/**
 * One tenant's batch of locked agent-topic jobs. The production fetcher discovers
 * distinct tenants with eligible jobs and locks them per-tenant under the tenant GUC;
 * tests supply an in-memory fetcher. The jobs carry their tenant on `variables.__tenantId`
 * (threaded by the fetcher) so assembleAgentStepContext can read it without a 2nd query.
 */
export interface TenantJobBatch {
  readonly tenantId: string;
  readonly jobs: readonly Job[];
}

/**
 * Fetch-and-lock eligible agent-topic jobs across tenants for ONE pass. Returns one
 * batch per tenant that has eligible jobs. Each returned job MUST already be LOCKED
 * by `workerId` and carry `variables.__tenantId === batch.tenantId`.
 */
export interface AgentJobFetcher {
  fetchAndLockAgentJobs(args: {
    readonly workerId: string;
    readonly topics: readonly string[];
    readonly maxJobs: number;
    readonly lockMs: number;
    readonly nowMs: number;
  }): Promise<readonly TenantJobBatch[]>;
}

/** Run a callback inside an open tenant-scoped tx (BEGIN + SET LOCAL GUC + COMMIT). */
export type WithTenantTx = <T>(
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
) => Promise<T>;

export interface AgentDispatchDeps {
  readonly fetcher: AgentJobFetcher;
  readonly withTenantTx: WithTenantTx;
  readonly assembleDeps: AssembleDeps;
  readonly runDeps: RunAgentStepDeps;
  /** apply-outcome ports MINUS workerId (the loop supplies workerId). */
  readonly applyDeps: Omit<ApplyOutcomeDeps, "workerId">;
  readonly workerId: string;
  readonly topics: readonly string[];
  readonly maxJobsPerPass?: number;
  readonly lockMs?: number;
  /** Server clock (injectable for tests). Default Date.now. */
  readonly now?: () => number;
}

/** A no-op handle (degraded / no agent topics). */
function noopHandle(): AgentDispatchHandle {
  let stopped = false;
  return {
    stop: () => {
      stopped = true;
      void stopped;
    },
  };
}

/**
 * Process ONE pass: fetch+lock eligible agent jobs across tenants, then for each job
 * open a tenant tx and run assemble → motor → apply-outcome (atomic per job).
 *
 * Per-job errors are swallowed (logged) so one bad job does not stall the batch; the
 * job stays LOCKED and is reclaimed on lock-expiry (idempotent re-run, ADR §5).
 * Returns a summary count for tests / observability.
 */
export async function runAgentDispatchOnce(
  deps: AgentDispatchDeps,
): Promise<{ processed: number; proceeded: number; deferred: number; failed: number; errored: number }> {
  const now = deps.now ?? Date.now;
  const maxJobs = deps.maxJobsPerPass ?? 10;
  const lockMs = deps.lockMs ?? 30_000;

  const summary = { processed: 0, proceeded: 0, deferred: 0, failed: 0, errored: 0 };

  const batches = await deps.fetcher.fetchAndLockAgentJobs({
    workerId: deps.workerId,
    topics: deps.topics,
    maxJobs,
    lockMs,
    nowMs: now(),
  });

  for (const batch of batches) {
    for (const job of batch.jobs) {
      const nowMs = now();
      try {
        await deps.withTenantTx(batch.tenantId, async (client) => {
          const ctx = await assembleAgentStepContext(
            client,
            job,
            deps.assembleDeps,
            nowMs,
          );
          const outcome = await runAgentStep(ctx, deps.runDeps);
          const result = await applyAgentOutcome(client, ctx, outcome, {
            ...deps.applyDeps,
            workerId: deps.workerId,
          });
          summary.processed += 1;
          if (result.outcome === "proceed") summary.proceeded += 1;
          else if (result.outcome === "defer-to-human") summary.deferred += 1;
          else summary.failed += 1;
        });
      } catch (err) {
        // Swallow per-job error — the job stays LOCKED, reclaimed on lock-expiry.
        summary.errored += 1;
        console.error(
          `[agent-dispatch] job ${job.id} (tenant ${batch.tenantId}) failed: ${String(err)}`,
        );
      }
    }
  }

  return summary;
}

/**
 * Start the agent dispatch poll loop. Degraded no-op when topics is empty.
 * First pass fires after one interval (server start non-blocking). stop() clears
 * the interval. Per-pass errors are swallowed (loop stays alive).
 */
export function startAgentDispatchLoop(
  deps: AgentDispatchDeps,
  opts: {
    readonly intervalMs?: number;
    readonly setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  } = {},
): AgentDispatchHandle {
  if (deps.topics.length === 0) {
    return noopHandle();
  }
  const intervalMs = opts.intervalMs ?? 5_000;
  const setIntervalFn = opts.setIntervalFn ?? setInterval;

  const handle = setIntervalFn(() => {
    runAgentDispatchOnce(deps).catch(() => {
      /* swallow — degraded signal; loop continues on next interval */
    });
  }, intervalMs);

  return { stop: () => clearInterval(handle) };
}

// ---------------------------------------------------------------------------
// Production wiring — PostgresAgentJobFetcher + buildAgentDispatchDeps
// ---------------------------------------------------------------------------

/**
 * UUID validation (mirrors pgJobStore / pgOutboxStore pattern — R-3 defence).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Production `AgentJobFetcher`: two-phase cross-tenant pass (образец lockReclaimer
 * / outboxDispatcher pendingBuckets + claimBatch).
 *
 * Phase-1 (no GUC): discover distinct tenants with ELIGIBLE agent-topic jobs using a
 *   direct pool query (no SECURITY DEFINER function required — the job table is
 *   partitioned by tenant_id; the query is an aggregate-count-only discovery step
 *   with NO row-data payload, mirroring the safety of outbox_pending_buckets).
 * Phase-2 (per-tenant GUC): for each eligible tenant, open a tenant-scoped tx,
 *   SET LOCAL choros.tenant_id, then call pgJobStore.fetchAndLock.
 *
 * Tenant-scoping invariant: the returned jobs carry `variables.__tenantId` set by
 * the caller so `assembleAgentStepContext` reads it without a second DB query.
 * This field IS part of the job.variables threaded at fetch time (see below).
 *
 * Cross-tenant safety: Phase-1 returns ONLY (tenantId, count) — no row data.
 * Phase-2 fetchAndLock executes under the per-tenant GUC so RLS scopes every row
 * to the correct tenant. The thread of `__tenantId` onto `job.variables` happens
 * HERE (not in the job table) to satisfy assembleAgentStepContext's requirement
 * WITHOUT a second query.
 */
export class PostgresAgentJobFetcher implements AgentJobFetcher {
  constructor(
    private readonly pool: pg.Pool,
    private readonly jobStore: PostgresJobStore,
  ) {}

  async fetchAndLockAgentJobs(args: {
    readonly workerId: string;
    readonly topics: readonly string[];
    readonly maxJobs: number;
    readonly lockMs: number;
    readonly nowMs: number;
  }): Promise<readonly TenantJobBatch[]> {
    if (args.topics.length === 0 || args.maxJobs <= 0) return [];

    // Phase-1: discover tenants with eligible jobs (no GUC, aggregate only).
    // Eligible = state='CREATED' AND available_at<=nowMs, OR
    //            state='LOCKED' AND lock_expiry<=nowMs (expired lock = re-eligible).
    // Returns ONLY tenantId — no job row data escapes the aggregate.
    const { rows } = await this.pool.query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id
         FROM choros.job
        WHERE topic = ANY($1::text[])
          AND (
            (state = 'CREATED' AND available_at <= $2)
            OR (state = 'LOCKED' AND lock_expiry <= $2)
          )
        LIMIT 100`,
      [args.topics, args.nowMs],
    );

    if (rows.length === 0) return [];

    const batches: TenantJobBatch[] = [];
    for (const row of rows) {
      const tenantId = row.tenant_id;
      // UUID guard (R-3 defence — mirrors pgOutboxStore.claimBatch).
      if (!UUID_RE.test(tenantId)) continue;

      // Phase-2: per-tenant fetchAndLock under GUC.
      // We open a dedicated client, set the GUC, run fetchAndLock (which runs its
      // own CTE under that GUC), then release. fetchAndLock uses the jobStore's pool
      // internally but pgJobStore.fetchAndLock takes `this.pool.query` directly —
      // we must supply the GUC-scoped client via a wrapped call instead.
      const client = await this.pool.connect();
      let jobs: Job[] = [];
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL choros.tenant_id = '${tenantId.replace(/'/g, "''")}'`);
        await client.query("SET LOCAL search_path TO choros");

        // fetchAndLock via the jobStore pool — pgJobStore.fetchAndLock calls
        // this.pool.query directly (no GUC awareness). We replicate the CTE here
        // using the GUC-scoped client instead, mirroring the pgJobStore implementation.
        const { rows: jobRows } = await client.query<{
          id: string;
          topic: string;
          variables: Record<string, unknown>;
          state: string;
          retries: number;
          lock_owner: string | null;
          lock_expiry: string | null;
          created_at: string;
          available_at: string;
        }>(
          `WITH candidates AS (
             SELECT id FROM choros.job
             WHERE topic = ANY($1::text[])
               AND (
                 (state = 'CREATED' AND available_at <= $2)
                 OR (state = 'LOCKED' AND lock_expiry  <= $2)
               )
             ORDER BY created_at ASC
             LIMIT $3
             FOR UPDATE SKIP LOCKED
           )
           UPDATE choros.job j
           SET
             state       = 'LOCKED',
             lock_owner  = $4,
             lock_expiry = $2 + $5
           FROM candidates
           WHERE j.id = candidates.id
           RETURNING j.id, j.topic, j.variables, j.state, j.retries,
                     j.lock_owner, j.lock_expiry, j.created_at, j.available_at`,
          [
            args.topics,
            args.nowMs,
            args.maxJobs,
            args.workerId,
            args.lockMs,
          ],
        );
        await client.query("COMMIT");

        // Thread __tenantId onto job.variables so assembleAgentStepContext can read it
        // without a second DB query (the job row has no TS-level tenantId field).
        jobs = jobRows.map((r) => ({
          id: r.id,
          topic: r.topic,
          variables: { ...r.variables, __tenantId: tenantId },
          state: r.state as Job["state"],
          retries: r.retries,
          lockOwner: r.lock_owner ?? undefined,
          lockExpiry: r.lock_expiry !== null ? Number(r.lock_expiry) : undefined,
          createdAt: Number(r.created_at),
          available_at: Number(r.available_at),
        }));
      } catch {
        await client.query("ROLLBACK").catch(() => {/* swallow */});
        // Per-tenant error is non-fatal: other tenants continue (образец lockReclaimer).
      } finally {
        client.release();
      }

      if (jobs.length > 0) {
        batches.push({ tenantId, jobs });
      }
    }

    return batches;
  }
}

/**
 * Production `withTenantTx` for the agent dispatch loop. Opens a pg client, sets
 * the GUC, runs the caller's fn inside the tx (BEGIN…COMMIT), releases on exit.
 * Mirrors lifecycle-bridge.ts buildAuditOnDispatched's withTenantTx construction.
 *
 * UUID-validated before GUC interpolation (R-3 defence).
 */
export function buildAgentWithTenantTx(pool: pg.Pool): WithTenantTx {
  return async <T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    if (!UUID_RE.test(tenantId)) {
      throw new Error(`buildAgentWithTenantTx: invalid tenantId '${tenantId}'`);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId.replace(/'/g, "''")}'`);
      await client.query("SET LOCAL search_path TO choros");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {/* swallow */});
      throw err;
    } finally {
      client.release();
    }
  };
}

/**
 * Build the full `AgentDispatchDeps` for production from env + a pg pool.
 *
 * Topics: read from `AGENT_TOPICS` env var (comma-separated); defaults to
 * `["agent-step"]` (DEFAULT_AGENT_TOPIC) when the var is absent — so production
 * works out-of-the-box without extra configuration.
 *
 * LLM: dormant day-1 (liveEnabled=false). Motor defers every job to the human
 * inbox when no LLM is configured — safe-degrade (NF-5, T-0378 dormant keystone).
 * The live path (liveEnabled=true + BYO LLM key) is enabled by a config flip,
 * no code change (ADR §3 / RL-3).
 *
 * When `pool` or `jobStore` is absent (DATABASE_URL not set), returns `undefined`
 * — the caller should degrade to a no-op handle (topics=[]).
 */
export interface AgentDispatchProductionDeps {
  readonly pool: pg.Pool;
  readonly jobStore: PostgresJobStore;
  readonly outboxStore: PostgresOutboxStore;
}

/**
 * Minimal degraded `AgentDispatchDeps` with `topics: []`. Used by `startMain`
 * when DATABASE_URL is absent (no pool). `startAgentDispatchLoop` returns a
 * noopHandle immediately when `topics.length === 0` — none of the other deps
 * fields are ever reached so stub values are safe.
 */
export function buildDegradedAgentDispatchDeps(): AgentDispatchDeps {
  return {
    fetcher: { fetchAndLockAgentJobs: async () => [] },
    withTenantTx: async (_t, _fn) => { throw new Error("degraded"); },
    assembleDeps: {
      grants: { getGrants: async () => [] },
      tools: { listTools: async () => [] },
      roleGrants: { getRoleGrants: async () => [] },
      instruction: { readPublished: async () => null },
    },
    runDeps: { llm: dormantLlmPort, liveEnabled: false },
    applyDeps: {
      auditWriter: makePgAuditWriter(),
      outboxStore: {
        enqueueInTx: async () => undefined,
      } as unknown as ApplyOutcomeDeps["outboxStore"],
      jobStore: {
        complete: async () => ({ ok: true }),
        fail: async () => ({ ok: true }),
      } as unknown as ApplyOutcomeDeps["jobStore"],
    },
    workerId: "choros-agent-dispatcher",
    topics: [], // degraded — startAgentDispatchLoop returns noopHandle immediately
  };
}

export function buildAgentDispatchDeps(
  production: AgentDispatchProductionDeps,
  env: NodeJS.ProcessEnv,
): AgentDispatchDeps {
  const { pool, jobStore, outboxStore } = production;

  const topicsEnv = env["AGENT_TOPICS"];
  const topics: string[] =
    topicsEnv !== undefined && topicsEnv !== ""
      ? topicsEnv
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      : [DEFAULT_AGENT_TOPIC];

  const fetcher = new PostgresAgentJobFetcher(pool, jobStore);
  const withTenantTx = buildAgentWithTenantTx(pool);
  const auditWriter = makePgAuditWriter();

  const assembleDeps: AssembleDeps = {
    grants: makeDbGrantSource(pool),
    tools: makeDbMcpToolSource(pool),
    roleGrants: makeDbRoleGrantSource(pool),
    budget: stubBudgetPort,
    instruction: storeInstructionSource,
  };

  const applyDeps: Omit<ApplyOutcomeDeps, "workerId"> = {
    auditWriter,
    outboxStore,
    jobStore,
  };

  return {
    fetcher,
    withTenantTx,
    assembleDeps,
    runDeps: { llm: dormantLlmPort, liveEnabled: false },
    applyDeps,
    workerId: env["AGENT_WORKER_ID"] ?? "choros-agent-dispatcher",
    topics,
  };
}
