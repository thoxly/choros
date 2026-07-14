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
  type LiveLlmConfig,
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
import { dormantLlmPort, type LlmPort } from "../core/llm-port.js";
import { stubBudgetPort } from "../runtime/agent-dispatch/agent-step-context.js";
import type { PostgresJobStore } from "../core/jobStore.js";
import type { PostgresOutboxStore } from "../core/postgres/pgOutboxStore.js";
import { AGENT_STEP_TOPIC } from "../core/agent-task-external-mapper.js";
// T-0586 (composition root — adapters allowed here, NOT in src/runtime/agent-dispatch/):
// the SAME production OpenAI-compatible adapter + tenant secret resolver already used
// by the assistant path (src/server.ts:makeLlmPortFactory). No second SQL resolver —
// ctx.llm is already assembled per-job by readAgentCardLlmConfigById (agent-step-context.ts).
import { OpenAILlmPort } from "../adapters/openai-llm-port.js";
import { tenantSecretResolver } from "../server.js";

/**
 * Concrete InstructionSource that delegates to the real agent-instruction-store DAO.
 * Exported from the composition root (src/server/) so src/runtime/agent-dispatch/
 * never imports agent-instruction-store directly (FF-LP-4 / T-0233 AC-11/NF-4).
 */
export const storeInstructionSource: InstructionSource = {
  readPublished,
};

/**
 * The default DEDICATED keystone agent topic (NOT the tel-intake DMN seam).
 *
 * T-0460 [D8-R5] FF-R5-6: sourced from the single exported AGENT_STEP_TOPIC constant
 * (agent-task-external-mapper.ts) — the SAME literal the publish transform stamps onto
 * authored agent serviceTasks (flowable:topic) and the linter coherence guard validates.
 * One source of truth → no string drift between the publish wire and the dispatcher poll.
 */
export const DEFAULT_AGENT_TOPIC = AGENT_STEP_TOPIC;

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
 * Phase-1 (cross-tenant discovery): find distinct tenants with ELIGIBLE agent-topic
 *   jobs. This runs as a plain pool query that intentionally sees ALL tenants. The
 *   safety mechanism here is NOT RLS and NOT table partitioning — `choros.job` is a
 *   single non-partitioned table (migrations/002_job.sql) and the production pool
 *   connects as `choros_migrator` (BYPASSRLS), so RLS would not scope this query in
 *   any case. The real Phase-1 precedents (outbox_pending_buckets / job_locked_
 *   expired_buckets) wrap the equivalent discovery in a SECURITY DEFINER aggregate;
 *   here we inline the discovery directly on the BYPASSRLS pool. What keeps it safe
 *   is that it SELECTs ONLY `DISTINCT tenant_id` — no id, payload, or other row data
 *   ever escapes the discovery step (the cross-tenant tenant list is precisely what
 *   we need to drive Phase-2 per-tenant).
 * Phase-2 (per-tenant): for each eligible tenant, open a tx, SET LOCAL the GUC, and
 *   run a lock CTE with an EXPLICIT `tenant_id = $N` predicate. Under the BYPASSRLS
 *   migrator role the GUC is INERT for row filtering, so the predicate — not the GUC
 *   — is what scopes the lock to one tenant (mirrors every other DAO).
 *
 * Tenant-scoping invariant: the returned jobs carry `variables.__tenantId` set from
 * the LOCKED ROW's real `tenant_id` (RETURNING j.tenant_id) so `assembleAgentStep
 * Context` reads it without a second DB query. This field IS part of the
 * job.variables threaded at fetch time (see below).
 *
 * Cross-tenant safety: Phase-1 returns ONLY `tenant_id` — no row data. Phase-2's CTE
 * filters on `tenant_id = $N` (the authoritative scope under BYPASSRLS) AND stamps
 * `__tenantId` from each row's own `tenant_id`, so no job can be locked or stamped
 * under a foreign tenant even though the GUC is inert.
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

    // Phase-1: discover tenants with eligible jobs. Plain pool query on the
    // BYPASSRLS migrator pool — it intentionally sees ALL tenants (that cross-tenant
    // list is exactly what drives Phase-2). Safety = it SELECTs ONLY DISTINCT
    // tenant_id; no id/payload/row-data escapes (the discovery analogue of the
    // SECURITY DEFINER outbox_pending_buckets aggregate). NOT scoped by RLS (inert
    // under BYPASSRLS) and `choros.job` is NOT partitioned.
    // Eligible = state='CREATED' AND available_at<=nowMs, OR
    //            state='LOCKED' AND lock_expiry<=nowMs (expired lock = re-eligible).
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
        //
        // EXPLICIT tenant predicate `AND tenant_id = $6` (NOT just the GUC):
        // the production runtime pool connects as `choros_migrator`, which is
        // BYPASSRLS (docker-compose / .env.prod.example / migrations/001). Under
        // BYPASSRLS the RLS policy keyed on `choros.tenant_id` is NEVER applied, so
        // `SET LOCAL choros.tenant_id` above is INERT for row filtering and the CTE
        // would otherwise lock agent-step jobs across ALL tenants during one tenant's
        // pass. The explicit `tenant_id = $6` is the authoritative scope under the
        // migrator role — mirrors every other DAO (role-grant-dao.ts WHERE tenant_id
        // = $1, org.ts:118, the outbox/timer/reaper stores). `tenant_id` is also
        // RETURNED so __tenantId is stamped from the row, not the loop iterator.
        const { rows: jobRows } = await client.query<{
          tenant_id: string;
          id: string;
          topic: string;
          variables: Record<string, unknown>;
          state: string;
          retries: number;
          lock_owner: string | null;
          lock_expiry: string | null;
          created_at: string;
          available_at: string;
          // T-0677: process_def_id/instance_id (migration 111, T-0534). Previously
          // omitted from this hand-rolled RETURNING list — the production cause of
          // agent-step-context.ts's readJobVars() always seeing instanceId="" (this
          // fetcher, NOT PostgresJobStore.fetchAndLock, is what backs the live
          // agent dispatch loop wired in main.ts).
          process_def_id: string | null;
          instance_id: string | null;
        }>(
          `WITH candidates AS (
             SELECT id FROM choros.job
             WHERE tenant_id = $6
               AND topic = ANY($1::text[])
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
             AND j.tenant_id = $6
           RETURNING j.tenant_id, j.id, j.topic, j.variables, j.state, j.retries,
                     j.lock_owner, j.lock_expiry, j.created_at, j.available_at,
                     j.process_def_id, j.instance_id`,
          [
            args.topics,
            args.nowMs,
            args.maxJobs,
            args.workerId,
            args.lockMs,
            tenantId,
          ],
        );
        await client.query("COMMIT");

        // Thread __tenantId onto job.variables so assembleAgentStepContext can read it
        // without a second DB query (the job row has no TS-level tenantId field).
        // __tenantId comes from the ROW's real tenant_id (RETURNING j.tenant_id), NOT
        // the loop iterator — belt-and-suspenders: with the `tenant_id = $6` predicate
        // they are equal, but the row value is the authoritative source of truth so a
        // mis-scoped lock can never be stamped with the wrong tenant downstream.
        jobs = jobRows.map((r) => ({
          id: r.id,
          topic: r.topic,
          // T-0677: inject the authoritative process_def_id/instance_id (migration
          // 111, T-0534 — captured from the Flowable ExternalTask engine metadata at
          // enqueue time) into job.variables under the SAME keys the (frozen,
          // FF-15-owned) agent-step-context.ts::readJobVars() already probes
          // (`instanceId` / `procKey`). This is the call-site injection point: the
          // frozen readJobVars stays byte-identical and finds the correct value
          // through its existing variables lookup — no edit to the frozen zone.
          // Spread order: ...r.variables FIRST, then the injected keys OVERRIDE when
          // the migration-111 column carries a non-empty value — the DB column is the
          // authoritative engine-captured correlation id and wins over any stale
          // business-variable of the same name; when the column is NULL/empty the
          // injection is skipped and readJobVars falls back to whatever variables
          // already carried (legacy jobs enqueued before migration 111). __tenantId is
          // stamped last so it is never shadowed.
          variables: {
            ...r.variables,
            ...(r.instance_id != null && r.instance_id !== ""
              ? { instanceId: r.instance_id }
              : {}),
            ...(r.process_def_id != null && r.process_def_id !== ""
              ? { procKey: r.process_def_id }
              : {}),
            __tenantId: r.tenant_id,
          },
          state: r.state as Job["state"],
          retries: r.retries,
          lockOwner: r.lock_owner ?? undefined,
          lockExpiry: r.lock_expiry !== null ? Number(r.lock_expiry) : undefined,
          createdAt: Number(r.created_at),
          available_at: Number(r.available_at),
          // T-0677: also thread process_def_id/instance_id onto the Job object's
          // (non-frozen, types.ts) optional fields — the authoritative machine-readable
          // copy, useful for DB-level assertions and any future non-frozen consumer.
          // The functional wiring that feeds readJobVars is the variables injection
          // above; these top-level fields are the belt to that suspenders.
          processDefId: r.process_def_id ?? null,
          instanceId: r.instance_id ?? null,
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
 * LLM: dormant by default (`AGENT_LIVE_ENABLED` unset/not exactly "true" →
 * liveEnabled=false). Motor defers every job to the human inbox when no LLM
 * is configured — safe-degrade (NF-5, T-0378 dormant keystone). T-0586: the
 * live path (`AGENT_LIVE_ENABLED=true` + BYO LLM key on the agent's own
 * `llm_connection`) is a config flip, no code change (ADR-T0586 §3 / RL-3) —
 * `makeAgentLlmPortFactory` below builds a fresh per-job `OpenAILlmPort` via
 * the same `tenantSecretResolver` the assistant path already uses.
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
 *
 * T-0586 (AC-1): `liveEnabled: false` here is INTENTIONAL, not a forgotten
 * literal — this is the degraded/no-DB path (`topics: []`), which
 * `startAgentDispatchLoop` short-circuits to a `noopHandle()` BEFORE `runDeps`
 * is ever read (see `startAgentDispatchLoop` above: `if (deps.topics.length
 * === 0) return noopHandle()`). `runDeps` is therefore unreachable runtime
 * state in this branch — same class of stub-safety as the fetcher/withTenantTx/
 * applyDeps fields right above, which also throw/no-op rather than do
 * anything real. Reading `AGENT_LIVE_ENABLED` here would be dead code.
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

/**
 * T-0586 ND-2: per-job live LlmPort factory. Builds a FRESH `OpenAILlmPort`
 * from the agent's OWN resolved config (`ctx.llm`, threaded in via the
 * `LiveLlmConfig` the motor passes at call time) using the SAME
 * `tenantSecretResolver` as the assistant path (src/server.ts). No cache: a
 * UI key/connection change is picked up on the very next job — nothing here
 * is captured in a closure across calls, the pool/resolver reference is the
 * only thing shared and both are safe to reuse for all tenants (the tenant
 * scoping happens INSIDE the resolver, keyed by `cfg.tenantId`).
 *
 * `OpenAILlmPort`'s constructor itself validates the secret-handle SHAPE and
 * throws `LlmUnavailableError` on an invalid one — that throw is caught by
 * `runAgentStep`'s live-call try/catch (constructed then immediately used via
 * `port.complete(...)`) and routed to defer-to-human (F6(b)); no additional
 * validation needed here.
 */
function makeAgentLlmPortFactory(): (cfg: LiveLlmConfig) => LlmPort {
  return (cfg: LiveLlmConfig): LlmPort =>
    new OpenAILlmPort({
      endpoint: cfg.endpoint,
      model: cfg.model,
      secretHandle: cfg.secretHandle,
      tenantId: cfg.tenantId,
      secretResolver: tenantSecretResolver,
    });
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

  // T-0586 F1/F2: AGENT_LIVE_ENABLED — deploy-time flag, read exactly like
  // AGENT_TOPICS/AGENT_WORKER_ID just above. Default (absent / any value other
  // than the exact string "true") is `false` — dormant, safe-by-default
  // (NF1). When live, additively supply a per-job port factory (ND-2) — the
  // `llm` field stays `dormantLlmPort` as the safe fallback if the factory is
  // ever not consulted (defence-in-depth; the motor always prefers the
  // factory when liveEnabled is true — see run-agent-step.ts live-gate).
  const liveEnabled = env["AGENT_LIVE_ENABLED"] === "true";
  const runDeps: RunAgentStepDeps = liveEnabled
    ? { llm: dormantLlmPort, liveEnabled: true, llmPortFactory: makeAgentLlmPortFactory() }
    : { llm: dormantLlmPort, liveEnabled: false };

  return {
    fetcher,
    withTenantTx,
    assembleDeps,
    runDeps,
    applyDeps,
    workerId: env["AGENT_WORKER_ID"] ?? "choros-agent-dispatcher",
    topics,
  };
}
