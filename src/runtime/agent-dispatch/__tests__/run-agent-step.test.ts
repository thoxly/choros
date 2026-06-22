/**
 * Unit tests for T-0378 [D4] runAgentStep — the neutral motor orchestrator.
 *
 * Covers (test plan §6, static-now — no DB / network / LLM key):
 *  - Dormant motor yields defer-to-human (signal=dormant) — the keystone path.
 *  - Gate B (criticality=critical) → force defer WITHOUT an LLM call.
 *  - Gate C (budget exhausted) → force defer WITHOUT an LLM call.
 *  - Missing instruction → defer (signal=dormant), no LLM call.
 *  - Live proceed path (stub, high confidence) → proceed (exercised when llm_* flips).
 *  - Live low-confidence (gate A) → defer (signal=model).
 *  - LLM error / timeout / egress → fail-closed.
 */

import { describe, it, expect } from "vitest";
import { runAgentStep, type RunAgentStepDeps } from "../run-agent-step.js";
import type { AgentStepContext } from "../agent-step-context.js";
import { dormantLlmPort } from "../../../core/llm-port.js";
import { StubLlmPort } from "../../../core/__tests__/stub-llm-port.js";

const TENANT = "a0000000-0000-0000-0000-000000000001";
const AGENT = "d0000000-0000-0000-0000-000000000006";
const NOW = 1_700_000_000_000;

function makeCtx(over: Partial<AgentStepContext> = {}): AgentStepContext {
  const { objective, recordRef, llm, ...rest } = over;
  return {
    tenantId: TENANT,
    jobId: "job-1",
    externalTaskId: "ext-1",
    instanceId: "inst-1",
    procKey: "telLinear",
    agentEmployeeId: AGENT,
    roleId: "role-intake-agent",
    tools: [],
    autonomyThreshold: null,
    criticalityLevel: "routine",
    budget: { exhausted: false },
    nowMs: NOW,
    ...rest,
    objective: {
      fields: { amount: 100 },
      prompt: "Step: Триаж\nProcess: telLinear",
      instruction: "Триаж заявки",
      answerForm: "agent_step_v1",
      hasInstruction: true,
      ...(objective ?? {}),
    },
    recordRef: {
      resolved: true,
      registryId: "reg-1",
      applicationId: "app-1",
      primaryRecordId: "rec-1",
      snapshot: { amount: 100 },
      ...(recordRef ?? {}),
    },
    llm: { endpoint: null, model: null, secretHandle: null, ...(llm ?? {}) },
  };
}

const dormantDeps: RunAgentStepDeps = { llm: dormantLlmPort, liveEnabled: false };

describe("runAgentStep — dormant keystone", () => {
  it("dormant agent_card → defer-to-human (signal=dormant), zero LLM spend", async () => {
    const stub = new StubLlmPort({ recordCalls: true });
    // liveEnabled=false → port forced dormant regardless of stub.
    const outcome = await runAgentStep(makeCtx(), { llm: stub, liveEnabled: false });
    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") expect(outcome.signal).toBe("dormant");
    // The forced-dormant port means the stub was NEVER called (no spend).
    expect(stub.calls.length).toBe(0);
  });

  it("live flag but llm_* unconfigured → still dormant → defer (no spend)", async () => {
    const stub = new StubLlmPort();
    const outcome = await runAgentStep(makeCtx({ llm: { endpoint: null, model: null, secretHandle: null } }), {
      llm: stub,
      liveEnabled: true,
    });
    expect(outcome.kind).toBe("defer-to-human");
    expect(stub.calls.length).toBe(0);
  });
});

describe("runAgentStep — gate B (criticality) short-circuit", () => {
  it("criticality=critical → defer WITHOUT an LLM call (F3)", async () => {
    const stub = new StubLlmPort();
    const outcome = await runAgentStep(makeCtx({ criticalityLevel: "critical" }), {
      llm: stub,
      liveEnabled: true,
      // even with a live+configured llm, gate B must short-circuit before the call
    });
    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") {
      expect(outcome.signal).toBe("threshold");
      expect(outcome.doubtReason).toContain("critical");
    }
    expect(stub.calls.length).toBe(0);
  });
});

describe("runAgentStep — gate C (budget) short-circuit", () => {
  it("budget exhausted → defer WITHOUT an LLM call", async () => {
    const stub = new StubLlmPort();
    const outcome = await runAgentStep(makeCtx({ budget: { exhausted: true } }), {
      llm: stub,
      liveEnabled: true,
    });
    expect(outcome.kind).toBe("defer-to-human");
    expect(stub.calls.length).toBe(0);
  });
});

describe("runAgentStep — missing instruction", () => {
  it("no published instruction → defer (signal=dormant), no LLM call", async () => {
    const stub = new StubLlmPort();
    const outcome = await runAgentStep(
      makeCtx({ objective: { fields: {}, prompt: "Step: unknown", instruction: "", answerForm: "agent_step_v1", hasInstruction: false } }),
      { llm: stub, liveEnabled: true },
    );
    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") expect(outcome.signal).toBe("dormant");
    expect(stub.calls.length).toBe(0);
  });
});

describe("runAgentStep — live proceed path (flip-on, llm_* configured)", () => {
  const liveLlm = { endpoint: "https://x", model: "m", secretHandle: "h" };

  it("high-confidence stub → proceed (the later live flip)", async () => {
    const stub = new StubLlmPort({ mode: "succeed" });
    const outcome = await runAgentStep(makeCtx({ llm: liveLlm }), { llm: stub, liveEnabled: true });
    expect(outcome.kind).toBe("proceed");
    expect(stub.calls.length).toBe(1);
  });

  it("low-confidence stub (below CONFIDENCE_FLOOR) → defer (gate A, signal=threshold)", async () => {
    // confidence 0.45 < CONFIDENCE_FLOOR 0.7 → belowFloor folds into thresholdFailed
    // (mirrors run-precheck.ts) → classifyOutcome returns signal='threshold'.
    const stub = new StubLlmPort({ mode: "low_confidence" });
    const outcome = await runAgentStep(makeCtx({ llm: liveLlm }), { llm: stub, liveEnabled: true });
    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") expect(outcome.signal).toBe("threshold");
  });

  it("autonomy_threshold above model confidence → defer (signal=threshold)", async () => {
    const stub = new StubLlmPort({ mode: "succeed" }); // confidence 0.92
    const outcome = await runAgentStep(makeCtx({ llm: liveLlm, autonomyThreshold: 0.95 }), {
      llm: stub,
      liveEnabled: true,
    });
    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") expect(outcome.signal).toBe("threshold");
  });

  it("LLM error → fail-closed (llm_error)", async () => {
    const stub = new StubLlmPort({ mode: "error" });
    const outcome = await runAgentStep(makeCtx({ llm: liveLlm }), { llm: stub, liveEnabled: true });
    expect(outcome.kind).toBe("fail-closed");
    if (outcome.kind === "fail-closed") expect(outcome.cause).toBe("llm_error");
  });

  it("LLM timeout → fail-closed (llm_timeout)", async () => {
    const stub = new StubLlmPort({ mode: "timeout" });
    const outcome = await runAgentStep(makeCtx({ llm: liveLlm }), { llm: stub, liveEnabled: true });
    expect(outcome.kind).toBe("fail-closed");
    if (outcome.kind === "fail-closed") expect(outcome.cause).toBe("llm_timeout");
  });

  it("LLM egress block → fail-closed (egress_block)", async () => {
    const stub = new StubLlmPort({ mode: "egress_block" });
    const outcome = await runAgentStep(makeCtx({ llm: liveLlm }), { llm: stub, liveEnabled: true });
    expect(outcome.kind).toBe("fail-closed");
    if (outcome.kind === "fail-closed") expect(outcome.cause).toBe("egress_block");
  });
});

describe("runAgentStep — determinism", () => {
  it("same dormant input → same outcome (NF-6)", async () => {
    const a = await runAgentStep(makeCtx(), dormantDeps);
    const b = await runAgentStep(makeCtx(), dormantDeps);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
