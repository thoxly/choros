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
import { runAgentStep, type RunAgentStepDeps, DEFAULT_AUTONOMY_THRESHOLD } from "../run-agent-step.js";
import type { AgentStepContext } from "../agent-step-context.js";
import { dormantLlmPort } from "../../../core/llm-port.js";
import { StubLlmPort } from "../../../core/__tests__/stub-llm-port.js";
import { MIN_AUTONOMY_THRESHOLD } from "../../../core/agent-hire.js";

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

// ---------------------------------------------------------------------------
// T-0586 ND-2 — llmPortFactory DI: when present + live-gate open, the motor
// builds the port PER-JOB from the factory (with ctx.llm's own values), NOT
// from deps.llm. When absent, deps.llm is used unchanged (frozen weld — see
// agent-step-weld.*.test.ts, which never pass llmPortFactory at all).
// ---------------------------------------------------------------------------

describe("T-0586 ND-2 — llmPortFactory DI (per-job live port construction)", () => {
  const liveLlm = { endpoint: "https://live.example/v1", model: "live-model", secretHandle: "app://tenant/x/handle" };

  it("live-gate open + llmPortFactory present → factory is called with ctx.llm's own values, its returned port is used (NOT deps.llm)", async () => {
    const neverCalled = new StubLlmPort({ mode: "succeed", recordCalls: true });
    const factoryPort = new StubLlmPort({ mode: "succeed", recordCalls: true });
    let capturedCfg: unknown;
    const outcome = await runAgentStep(makeCtx({ llm: liveLlm }), {
      llm: neverCalled, // fallback port — must NOT be the one invoked
      liveEnabled: true,
      llmPortFactory: (cfg) => {
        capturedCfg = cfg;
        return factoryPort;
      },
    });

    expect(outcome.kind).toBe("proceed");
    // The factory-built port was used — NOT the deps.llm fallback.
    expect(factoryPort.calls.length).toBe(1);
    expect(neverCalled.calls.length).toBe(0);
    // The factory received exactly ctx.llm's resolved fields + tenantId.
    expect(capturedCfg).toEqual({
      tenantId: TENANT,
      endpoint: liveLlm.endpoint,
      model: liveLlm.model,
      secretHandle: liveLlm.secretHandle,
    });
  });

  it("llmPortFactory absent → deps.llm is used directly (unchanged pre-T-0586 behaviour)", async () => {
    const stub = new StubLlmPort({ mode: "succeed", recordCalls: true });
    // No llmPortFactory key at all — mirrors every existing weld test's deps shape.
    const outcome = await runAgentStep(makeCtx({ llm: liveLlm }), { llm: stub, liveEnabled: true });
    expect(outcome.kind).toBe("proceed");
    expect(stub.calls.length).toBe(1);
  });

  it("liveEnabled=false → llmPortFactory is NEVER called even if present (dormant wins)", async () => {
    let factoryCalled = false;
    const outcome = await runAgentStep(makeCtx(), {
      llm: dormantLlmPort,
      liveEnabled: false,
      llmPortFactory: () => {
        factoryCalled = true;
        return new StubLlmPort({ mode: "succeed" });
      },
    });
    expect(outcome.kind).toBe("defer-to-human");
    expect(factoryCalled).toBe(false);
  });

  it("llm_* unconfigured (ctx.llm nulls) → llmPortFactory is NEVER called even if liveEnabled=true", async () => {
    let factoryCalled = false;
    const outcome = await runAgentStep(makeCtx({ llm: { endpoint: null, model: null, secretHandle: null } }), {
      llm: dormantLlmPort,
      liveEnabled: true,
      llmPortFactory: () => {
        factoryCalled = true;
        return new StubLlmPort({ mode: "succeed" });
      },
    });
    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") expect(outcome.signal).toBe("dormant");
    expect(factoryCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-0586 F6(b) / FF-586-4 — LlmUnavailableError → defer-to-human (NOT fail-closed).
// ---------------------------------------------------------------------------

describe("T-0586 FF-586-4 — LlmUnavailableError (configured but call failed) → defer-to-human", () => {
  const liveLlm = { endpoint: "https://x", model: "m", secretHandle: "h" };

  it("port.complete throws LlmUnavailableError → defer-to-human(signal=model), human-readable doubtReason, NOT fail-closed", async () => {
    const stub = new StubLlmPort({ mode: "unavailable", recordCalls: true });
    const outcome = await runAgentStep(makeCtx({ llm: liveLlm }), { llm: stub, liveEnabled: true });

    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") {
      expect(outcome.signal).toBe("model");
      expect(outcome.doubtReason).toBeTruthy();
      // Human-readable canonical text (canonicalizeLlmError) — never the raw
      // stub error message (no leaking internal/dev-facing detail).
      expect(outcome.doubtReason).not.toContain("stub:");
      expect(outcome.inboxTaskRef).toBe("pending");
    }
    // The call WAS attempted exactly once (config existed, the call itself failed).
    expect(stub.calls.length).toBe(1);
  });

  it("LlmUnavailableError is classified BEFORE the generic/timeout/egress fallback (narrow branch wins)", async () => {
    // A message that ALSO contains the substring "timeout" must still classify
    // as defer-to-human via the LlmUnavailableError branch (type-based check,
    // ordered before the string-based timeout/egress heuristics) — proves the
    // narrow `instanceof LlmUnavailableError` branch short-circuits first.
    const stub = new StubLlmPort({ mode: "unavailable" });
    const outcome = await runAgentStep(makeCtx({ llm: liveLlm }), { llm: stub, liveEnabled: true });
    expect(outcome.kind).toBe("defer-to-human");
  });

  it("dormant LlmDormantError is UNCHANGED by the new branch (still signal=dormant, not signal=model)", async () => {
    // Regression guard: adding the LlmUnavailableError branch must not shadow
    // the pre-existing LlmDormantError → signal=dormant path (AC-5).
    const stub = new StubLlmPort({ mode: "dormant" });
    const outcome = await runAgentStep(makeCtx({ llm: liveLlm }), { llm: stub, liveEnabled: true });
    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") expect(outcome.signal).toBe("dormant");
  });
});

describe("runAgentStep — determinism", () => {
  it("same dormant input → same outcome (NF-6)", async () => {
    const a = await runAgentStep(makeCtx(), dormantDeps);
    const b = await runAgentStep(makeCtx(), dormantDeps);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// T-0381: F3 / F4 / F5 tests
// ---------------------------------------------------------------------------

describe("T-0381 F3 — criticality ceiling: critical op → ALWAYS defer, regardless of confidence", () => {
  const liveLlm = { endpoint: "https://x", model: "m", secretHandle: "h" };

  it("critical role + high-confidence LLM → defer (gate B fires before LLM call)", async () => {
    const stub = new StubLlmPort({ mode: "succeed", recordCalls: true });
    const outcome = await runAgentStep(
      makeCtx({ criticalityLevel: "critical", llm: liveLlm }),
      { llm: stub, liveEnabled: true },
    );
    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") {
      expect(outcome.signal).toBe("threshold");
      // Gate B must short-circuit: no LLM call made.
      expect(stub.calls.length).toBe(0);
      expect(outcome.doubtReason).toMatch(/critical/i);
    }
  });

  it("critical role + dormant LLM → defer (gate B still fires, zero LLM spend)", async () => {
    const outcome = await runAgentStep(
      makeCtx({ criticalityLevel: "critical" }),
      dormantDeps,
    );
    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") {
      // Gate B fires before live-gate, signal stays threshold (not dormant).
      expect(outcome.signal).toBe("threshold");
    }
  });

  it("routine role + high-confidence LLM → proceed (F3 gate does not fire)", async () => {
    const stub = new StubLlmPort({ mode: "succeed" });
    const outcome = await runAgentStep(
      makeCtx({ criticalityLevel: "routine", llm: liveLlm }),
      { llm: stub, liveEnabled: true },
    );
    expect(outcome.kind).toBe("proceed");
  });
});

describe("T-0381 F4 — autonomy_threshold: tenant default + per-agent override", () => {
  const liveLlm = { endpoint: "https://x", model: "m", secretHandle: "h" };

  it("null autonomy_threshold → falls back to DEFAULT_AUTONOMY_THRESHOLD; succeed-stub (0.92) ≥ default (0.85) → proceed", async () => {
    const stub = new StubLlmPort({ mode: "succeed" });
    // autonomyThreshold: null → gate uses DEFAULT_AUTONOMY_THRESHOLD = 0.85; confidence 0.92 ≥ 0.85
    const outcome = await runAgentStep(
      makeCtx({ autonomyThreshold: null, llm: liveLlm }),
      { llm: stub, liveEnabled: true },
    );
    expect(outcome.kind).toBe("proceed");
  });

  it("null autonomy_threshold → DEFAULT; confidence 0.45 (low_confidence stub) < default → defer", async () => {
    const stub = new StubLlmPort({ mode: "low_confidence" });
    const outcome = await runAgentStep(
      makeCtx({ autonomyThreshold: null, llm: liveLlm }),
      { llm: stub, liveEnabled: true },
    );
    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") expect(outcome.signal).toBe("threshold");
  });

  it("per-agent override (0.95) > DEFAULT (0.85) > confidence (0.92) → defer (agent override takes effect)", async () => {
    const stub = new StubLlmPort({ mode: "succeed" }); // confidence 0.92
    const outcome = await runAgentStep(
      makeCtx({ autonomyThreshold: 0.95, llm: liveLlm }),
      { llm: stub, liveEnabled: true },
    );
    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") expect(outcome.signal).toBe("threshold");
  });

  it("per-agent override (0.80) below floor: clamped to MIN_AUTONOMY_THRESHOLD (0.85); confidence (0.92) ≥ 0.85 → proceed", async () => {
    const stub = new StubLlmPort({ mode: "succeed" }); // confidence 0.92
    const outcome = await runAgentStep(
      makeCtx({ autonomyThreshold: 0.80, llm: liveLlm }),
      { llm: stub, liveEnabled: true },
    );
    expect(outcome.kind).toBe("proceed");
  });

  it("DEFAULT_AUTONOMY_THRESHOLD is exported and above CONFIDENCE_FLOOR (policy > structural floor)", async () => {
    // Confirms the constant is set to a value stricter than CONFIDENCE_FLOOR (0.70).
    expect(DEFAULT_AUTONOMY_THRESHOLD).toBeGreaterThan(0.7);
    expect(DEFAULT_AUTONOMY_THRESHOLD).toBeLessThanOrEqual(1.0);
  });
});

describe("T-0381 F5 — escalation prefilled with agent draft + rationale", () => {
  const liveLlm = { endpoint: "https://x", model: "m", secretHandle: "h" };

  it("threshold defer (low confidence) → agentDraft carries the LLM answer for human prefill", async () => {
    const stub = new StubLlmPort({ mode: "low_confidence" });
    const outcome = await runAgentStep(
      makeCtx({ autonomyThreshold: null, llm: liveLlm }),
      { llm: stub, liveEnabled: true },
    );
    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") {
      expect(outcome.agentDraft).toBeDefined();
      // The draft must be the LLM's answer (not empty).
      expect(outcome.agentDraft?.summary).toBeTruthy();
    }
  });

  it("high-autonomy threshold defer (confidence below per-agent override) → agentDraft present", async () => {
    const stub = new StubLlmPort({ mode: "succeed" }); // confidence 0.92
    const outcome = await runAgentStep(
      makeCtx({ autonomyThreshold: 0.95, llm: liveLlm }),
      { llm: stub, liveEnabled: true },
    );
    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") {
      expect(outcome.agentDraft).toBeDefined();
      // The proceed answer was available — it should be in the draft.
      expect(outcome.agentDraft?.redFlags).toBeInstanceOf(Array);
    }
  });

  it("dormant defer → agentDraft is absent (no LLM call, no draft to carry)", async () => {
    const outcome = await runAgentStep(makeCtx(), dormantDeps);
    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") {
      // Dormant path: no LLM answer exists → draft must be absent.
      expect(outcome.agentDraft).toBeUndefined();
    }
  });

  it("critical gate B defer → agentDraft is absent (no LLM call before gate)", async () => {
    const stub = new StubLlmPort({ mode: "succeed", recordCalls: true });
    const outcome = await runAgentStep(
      makeCtx({ criticalityLevel: "critical", llm: liveLlm }),
      { llm: stub, liveEnabled: true },
    );
    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") {
      // Gate B fires before LLM → no draft.
      expect(outcome.agentDraft).toBeUndefined();
      expect(stub.calls.length).toBe(0);
    }
  });

  it("dormant path still defers with zero LLM spend (dormant-safety preserved)", async () => {
    // Even with liveEnabled=false and a stub that would succeed, the dormant path is taken.
    const stub = new StubLlmPort({ mode: "succeed", recordCalls: true });
    const outcome = await runAgentStep(makeCtx(), { llm: stub, liveEnabled: false });
    expect(outcome.kind).toBe("defer-to-human");
    if (outcome.kind === "defer-to-human") {
      expect(outcome.signal).toBe("dormant");
      expect(outcome.agentDraft).toBeUndefined(); // no draft when dormant
    }
    expect(stub.calls.length).toBe(0); // zero LLM spend
  });
});

// ---------------------------------------------------------------------------
// T-0398 — read-side floor clamp (defense-in-depth for pre-existing sub-floor rows)
// ---------------------------------------------------------------------------

describe("T-0398 — read-side MIN_AUTONOMY_THRESHOLD clamp in gate A", () => {
  const liveLlm = { endpoint: "https://x", model: "m", secretHandle: "h" };

  it("sub-floor stored value (0) → clamped to MIN_AUTONOMY_THRESHOLD; confidence (0.92) ≥ floor → proceed", async () => {
    // Simulates a row written before T-0398 with autonomy_threshold=0.
    // The read-side clamp must raise it to MIN_AUTONOMY_THRESHOLD (0.85).
    // confidence 0.92 ≥ 0.85 → proceed.
    const stub = new StubLlmPort({ mode: "succeed" });
    const outcome = await runAgentStep(
      makeCtx({ autonomyThreshold: 0, llm: liveLlm }),
      { llm: stub, liveEnabled: true },
    );
    expect(outcome.kind).toBe("proceed");
  });

  it("sub-floor stored value (0) → clamped; confidence (0.45) < floor → defer", async () => {
    // confidence 0.45 < clamped threshold 0.85 (also < CONFIDENCE_FLOOR) → defer.
    const stub = new StubLlmPort({ mode: "low_confidence" });
    const outcome = await runAgentStep(
      makeCtx({ autonomyThreshold: 0, llm: liveLlm }),
      { llm: stub, liveEnabled: true },
    );
    expect(outcome.kind).toBe("defer-to-human");
  });

  it("MIN_AUTONOMY_THRESHOLD constant is consistent with DEFAULT_AUTONOMY_THRESHOLD", () => {
    // The floor must be at least as strict as the global default.
    // If this fails the constants have drifted — floor would be weaker than default.
    expect(MIN_AUTONOMY_THRESHOLD).toBeGreaterThanOrEqual(DEFAULT_AUTONOMY_THRESHOLD);
  });
});
