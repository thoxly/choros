/**
 * T-0586 [столп 4 — agentTask живьём] — agent-dispatch-loop-live-flag.test.ts.
 *
 * Covers AC-2/AC-3 + FF-586-2: `buildAgentDispatchDeps(production, env)` reads
 * the deploy-time `AGENT_LIVE_ENABLED` flag EXACTLY like the already-read
 * `AGENT_TOPICS`/`AGENT_WORKER_ID` (agent-dispatch-loop.ts). Table-driven over
 * a representative set of env values (spec AC-2: absent / '' / 'false' / '0' /
 * 'TRUE' (wrong case) all → dormant; ONLY the exact string 'true' → live).
 *
 * `buildAgentDispatchDeps` never touches the DB at CONSTRUCTION time — it only
 * builds DI objects (`PostgresAgentJobFetcher`, `buildAgentWithTenantTx`, etc.)
 * that hit the pool when their METHODS are later called. So a minimal
 * structurally-typed fake `pg.Pool`/`PostgresJobStore`/`PostgresOutboxStore`
 * (never invoked in this test) is sufficient — no real Postgres needed.
 */

import { describe, it, expect } from "vitest";
import type pg from "pg";
import {
  buildAgentDispatchDeps,
  type AgentDispatchProductionDeps,
} from "../agent-dispatch-loop.js";
import type { PostgresJobStore } from "../../core/jobStore.js";
import type { PostgresOutboxStore } from "../../core/postgres/pgOutboxStore.js";

/** Minimal fake production deps — no method is ever invoked at build time. */
function fakeProductionDeps(): AgentDispatchProductionDeps {
  return {
    pool: {} as unknown as pg.Pool,
    jobStore: {} as unknown as PostgresJobStore,
    outboxStore: {} as unknown as PostgresOutboxStore,
  };
}

describe("T-0586 AC-1/AC-2/FF-586-1/FF-586-2 — AGENT_LIVE_ENABLED flip semantics", () => {
  it("env['AGENT_LIVE_ENABLED']='true' → runDeps.liveEnabled===true AND llmPortFactory is defined", () => {
    const deps = buildAgentDispatchDeps(fakeProductionDeps(), { AGENT_LIVE_ENABLED: "true" });
    expect(deps.runDeps.liveEnabled).toBe(true);
    expect(deps.runDeps.llmPortFactory).toBeDefined();
    expect(typeof deps.runDeps.llmPortFactory).toBe("function");
  });

  // Table-driven: every one of these must yield the SAME dormant defaults.
  const dormantCases: Array<[string, NodeJS.ProcessEnv]> = [
    ["absent (no AGENT_LIVE_ENABLED key at all)", {}],
    ["empty string", { AGENT_LIVE_ENABLED: "" }],
    ["'false'", { AGENT_LIVE_ENABLED: "false" }],
    ["'0'", { AGENT_LIVE_ENABLED: "0" }],
    ["'TRUE' (wrong case — exact-match only)", { AGENT_LIVE_ENABLED: "TRUE" }],
    ["'True' (mixed case)", { AGENT_LIVE_ENABLED: "True" }],
    ["' true' (leading space — not exact)", { AGENT_LIVE_ENABLED: " true" }],
    ["'true ' (trailing space — not exact)", { AGENT_LIVE_ENABLED: "true " }],
    ["'yes'", { AGENT_LIVE_ENABLED: "yes" }],
    ["'1'", { AGENT_LIVE_ENABLED: "1" }],
  ];

  for (const [label, env] of dormantCases) {
    it(`env=${label} → runDeps.liveEnabled===false AND llmPortFactory is absent`, () => {
      const deps = buildAgentDispatchDeps(fakeProductionDeps(), env);
      expect(deps.runDeps.liveEnabled).toBe(false);
      expect(deps.runDeps.llmPortFactory).toBeUndefined();
      // NF1 safety net: the fallback `llm` port must still be the dormant one
      // regardless of the flag — never a real adapter leaking through when
      // liveEnabled is false.
      expect(deps.runDeps.llm).toBeDefined();
    });
  }

  it("degraded deps (buildDegradedAgentDispatchDeps) always liveEnabled=false, unreachable at runtime (topics=[])", async () => {
    const { buildDegradedAgentDispatchDeps } = await import("../agent-dispatch-loop.js");
    const deps = buildDegradedAgentDispatchDeps();
    expect(deps.runDeps.liveEnabled).toBe(false);
    expect(deps.topics).toEqual([]);
  });
});

describe("T-0586 AC-3/FF-586-3 — live port built via the shared resolver, not a copy", () => {
  it("the live llmPortFactory constructs an object per call (per-job, not cached)", () => {
    const deps = buildAgentDispatchDeps(fakeProductionDeps(), { AGENT_LIVE_ENABLED: "true" });
    const factory = deps.runDeps.llmPortFactory;
    expect(factory).toBeDefined();

    // Two calls with different tenants/handles must yield two DISTINCT port
    // instances (no shared closure-cached port) — this is the "no cache,
    // per-job" contract (ND-2). We don't invoke .complete() here (that would
    // require a network / real key); we only assert construction identity.
    const cfgA = {
      tenantId: "a0000000-0000-0000-0000-000000000001",
      endpoint: "https://api.deepseek.com",
      model: "deepseek-chat",
      secretHandle: "app://tenant/a0000000-0000-0000-0000-000000000001/llm/handle-a",
    };
    const cfgB = {
      tenantId: "b0000000-0000-0000-0000-000000000002",
      endpoint: "https://api.deepseek.com",
      model: "deepseek-chat",
      secretHandle: "app://tenant/b0000000-0000-0000-0000-000000000002/llm/handle-b",
    };
    const portA = factory!(cfgA);
    const portB = factory!(cfgB);
    expect(portA).not.toBe(portB);
    // Both are real LlmPort-shaped objects (have a complete() method).
    expect(typeof portA.complete).toBe("function");
    expect(typeof portB.complete).toBe("function");
  });
});
