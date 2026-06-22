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
