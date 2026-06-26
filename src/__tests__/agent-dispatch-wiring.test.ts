/**
 * T-0392 [D4-FU] — agent-dispatch-loop wiring test.
 *
 * Mirrors src/__tests__/main-wired-entry.test.ts (the lifecycle-bridge wiring
 * test). Drives the REAL composition root (startMain) and asserts that the
 * agent-dispatch loop IS registered and started — not degraded to a no-op when
 * agentDispatchDeps are injected with a non-empty topics list.
 *
 * What this covers:
 *   startMain(agentDispatchDeps=..., startDispatch=wrappedStart)
 *     → wrappedStart(deps)  [wraps the REAL startAgentDispatchLoop + injects setIntervalFn]
 *     → setIntervalFn registered (loop alive)
 *     → handle.agentDispatch.stop() + handle.stop() graceful
 *
 * Only the LEAVES are faked (injectable setIntervalFn, in-memory fetcher). The
 * composition between startMain → startAgentDispatchLoop → loop lifecycle is the
 * production code path. If the wiring is missing (loop never started), the
 * assertion that setIntervalFn was called fails.
 *
 * DEFER: the deploy-acceptance (live stack: telLinear agent-topic job → dispatch
 * → dormant → agent.deferred → inbox → approve → step closes) needs a live stack
 * + founder deploy GO (T-0392 remaining step).
 */

import { describe, it, expect } from "vitest";
import { startMain } from "../main.js";
import {
  startAgentDispatchLoop,
  DEFAULT_AGENT_TOPIC,
  storeInstructionSource,
  type AgentDispatchDeps,
  type AgentJobFetcher,
} from "../server/agent-dispatch-loop.js";
import { dormantLlmPort } from "../core/llm-port.js";
import { stubBudgetPort } from "../runtime/agent-dispatch/agent-step-context.js";
import { AGENT_STEP_TOPIC } from "../core/agent-task-external-mapper.js";

/** No-op fetcher that never yields jobs (we only test loop registration). */
const noopFetcher: AgentJobFetcher = {
  fetchAndLockAgentJobs: async () => [],
};

/** Minimal AgentDispatchDeps with a non-empty topics list for registration tests. */
function makeTestAgentDispatchDeps(): AgentDispatchDeps {
  return {
    fetcher: noopFetcher,
    withTenantTx: async (_tenantId, _fn) => {
      throw new Error("unexpected withTenantTx call in registration test");
    },
    assembleDeps: {
      grants: { getGrants: async () => [] },
      tools: { listTools: async () => [] },
      roleGrants: { getRoleGrants: async () => [] },
      budget: stubBudgetPort,
      instruction: storeInstructionSource,
    },
    runDeps: { llm: dormantLlmPort, liveEnabled: false },
    applyDeps: {
      auditWriter: { appendAuditEvent: async () => { /* no-op */ } } as never,
      outboxStore: { enqueueInTx: async () => undefined } as never,
      jobStore: {
        complete: async () => ({ ok: true }),
        fail: async () => ({ ok: true }),
      } as never,
    },
    workerId: "test-agent-dispatcher",
    topics: [DEFAULT_AGENT_TOPIC],
  };
}

describe("startMain agent-dispatch-loop wiring (T-0392)", () => {
  it("agent dispatch loop IS registered in startMain — setIntervalFn called when topics non-empty", () => {
    const dispatchTicks: Array<() => void> = [];
    const setIntervalFn = ((fn: () => void): ReturnType<typeof setInterval> => {
      dispatchTicks.push(fn);
      return 0 as unknown as ReturnType<typeof setInterval>;
    }) as (fn: () => void, ms: number) => ReturnType<typeof setInterval>;

    // startDispatch wraps the REAL startAgentDispatchLoop, injecting setIntervalFn
    // so we can observe whether the interval was registered without real timers.
    const startDispatch: typeof startAgentDispatchLoop = (deps, _opts) =>
      startAgentDispatchLoop(deps, { setIntervalFn });

    const handle = startMain({
      listen: false,
      env: {} as NodeJS.ProcessEnv,
      // No lifecycleDeps → lifecycle bridge degrades (no FLOWABLE_BASE_URL → no-op).
      agentDispatchDeps: makeTestAgentDispatchDeps(),
      startDispatch,
    });

    // The agent dispatch loop must have registered exactly one interval
    // (one non-empty topics list → one setInterval call from startAgentDispatchLoop).
    expect(dispatchTicks.length).toBeGreaterThanOrEqual(1);

    // handle.agentDispatch is present (not undefined) — composition root wired it.
    expect(handle.agentDispatch).toBeDefined();

    // Graceful shutdown does not throw.
    expect(() => handle.stop()).not.toThrow();
  });

  it("agent dispatch loop degrades to no-op when topics=[] — no setInterval, handle still present", () => {
    let setIntervalCalled = false;
    const setIntervalFn = ((fn: () => void): ReturnType<typeof setInterval> => {
      setIntervalCalled = true;
      void fn; // never reached
      return 0 as unknown as ReturnType<typeof setInterval>;
    }) as (fn: () => void, ms: number) => ReturnType<typeof setInterval>;

    const startDispatch: typeof startAgentDispatchLoop = (deps, _opts) =>
      startAgentDispatchLoop(deps, { setIntervalFn });

    const degradedDeps: AgentDispatchDeps = {
      ...makeTestAgentDispatchDeps(),
      topics: [], // topics=[] → startAgentDispatchLoop returns noopHandle immediately
    };

    const handle = startMain({
      listen: false,
      env: {} as NodeJS.ProcessEnv,
      agentDispatchDeps: degradedDeps,
      startDispatch,
    });

    // topics=[] → noopHandle → setInterval NOT called (no loop).
    expect(setIntervalCalled).toBe(false);
    // handle.agentDispatch is still present (noopHandle, not undefined).
    expect(handle.agentDispatch).toBeDefined();
    handle.stop(); // no throw
  });
});

// ---------------------------------------------------------------------------
// T-0460 [D8-R5] — topic agreement (FF-R5-6): the publish transform stamps the
// SAME topic the dispatcher polls. The dispatcher's DEFAULT_AGENT_TOPIC must equal
// the single AGENT_STEP_TOPIC constant the mapper stamps + the linter validates —
// no string drift between the authored external task and the runtime poll set.
// ---------------------------------------------------------------------------

describe("T-0460 topic agreement (FF-R5-6)", () => {
  it("DEFAULT_AGENT_TOPIC === AGENT_STEP_TOPIC (single source of truth, no drift)", () => {
    expect(DEFAULT_AGENT_TOPIC).toBe(AGENT_STEP_TOPIC);
    expect(AGENT_STEP_TOPIC).toBe("agent-step");
  });

  it("the dispatcher default topic is NOT the tel-intake DMN-triage seam", () => {
    expect(DEFAULT_AGENT_TOPIC).not.toBe("tel-intake");
  });
});
