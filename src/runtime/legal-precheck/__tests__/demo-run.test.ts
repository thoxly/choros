/**
 * Unit tests for T-0234 DEMO-3: legal-precheck agent as S3 actor of the ТЭЛ demo.
 *
 * Covers (SPEC AC-2/3/4/5/6/7):
 *  AC-2 — live-stub run → proceed + ≥1 red-flag (legal_precheck_v1), zero network.
 *  AC-3 — dormant run (liveEnabled=false) → defer-to-human, NOT proceed (INV-DEFAULT).
 *  AC-4 — moat: the agent CANNOT approve — resolveFor('approve') → denied.
 *  AC-5 — slice surface: INS-TEL-DEMO trace has an S3 legal-precheck node.
 *  AC-6 — D-139: the slice view carries NO raw reasoning (only answer + opaque ref).
 *  AC-7 — dealContext = T-0233 fixture {5_500_000, service_agreement, outbound}.
 *
 * Static-now: no DB, no network, no OPENAI key. The motor runs through the
 * in-process DemoStubLlmPort + in-memory deps (deterministic).
 */

import { describe, it, expect } from "vitest";

import {
  runDemoLegalPrecheck,
  demoApproveDenied,
  buildLegalPrecheckSliceView,
  DEMO_LEGAL_PRECHECK_DEAL,
  DemoStubLlmPort,
} from "../demo-run.js";
import {
  getTelDemoInstance,
  TEL_DEMO_INSTANCE_ID,
} from "../../../http/audit.js";

describe("T-0234 demo-run — agent as S3 actor", () => {
  it("AC-7: demo dealContext = T-0233 fixture {5_500_000, service_agreement, outbound}", () => {
    expect(DEMO_LEGAL_PRECHECK_DEAL).toStrictEqual({
      amount: 5_500_000,
      kind: "service_agreement",
      direction: "outbound",
    });
  });

  it("AC-2: live-stub run → proceed + ≥1 red-flag (legal_precheck_v1), single audit", async () => {
    const run = await runDemoLegalPrecheck("live-stub");
    expect(run.outcome.kind).toBe("proceed");
    const answer = (run.outcome as unknown as { answer: { answerForm: string; redFlags: unknown[] } }).answer;
    expect(answer.answerForm).toBe("legal_precheck_v1");
    expect(answer.redFlags.length).toBeGreaterThan(0);
    // Single audit sink → exactly one audit event (proceeded).
    expect(run.auditEventCount).toBe(1);
    expect(run.auditEventType).toBe("agent.legal_precheck.proceeded");
  });

  it("AC-2: deterministic — same input → byte-identical outcome", async () => {
    const a = await runDemoLegalPrecheck("live-stub");
    const b = await runDemoLegalPrecheck("live-stub");
    expect(JSON.stringify(a.outcome)).toBe(JSON.stringify(b.outcome));
  });

  it("AC-3: dormant run → defer-to-human(dormant), NOT proceed (INV-DEFAULT)", async () => {
    const run = await runDemoLegalPrecheck("dormant");
    expect(run.outcome.kind).toBe("defer-to-human");
    expect(run.outcome.kind).not.toBe("proceed");
    expect((run.outcome as { signal: string }).signal).toBe("dormant");
    expect(run.auditEventType).toBe("agent.deferred");
  });

  it("DemoStubLlmPort: zero-network deterministic port returns demo red-flags", async () => {
    const port = new DemoStubLlmPort();
    const res = await port.complete({
      instruction: "x",
      document: "y",
      dealContext: DEMO_LEGAL_PRECHECK_DEAL,
      answerForm: "legal_precheck_v1",
    });
    expect(res.answer.redFlags.length).toBe(3);
    expect(res.confidence).toBeGreaterThan(0.7);
  });
});

describe("T-0234 moat — agent cannot approve (AC-4)", () => {
  it("AC-4: resolveFor('approve') for the demo agent → denied (no approve grant)", async () => {
    const probe = await demoApproveDenied();
    expect(probe.denied).toBe(true);
    expect(probe.reason).toBe("no_grant");
  });
});

describe("T-0234 D-139 — slice view has no raw reasoning (AC-6)", () => {
  it("AC-6: proceed slice view carries answer + opaque ref, NO reasoning text", async () => {
    const run = await runDemoLegalPrecheck("live-stub");
    const view = buildLegalPrecheckSliceView(run.outcome);
    expect(view.kind).toBe("proceed");
    expect(view.redFlags.length).toBeGreaterThan(0);
    // Opaque presence ref — not chain-of-thought text.
    expect(view.reasoningTraceRef).toMatch(/^trace:legal_precheck:/);

    const serialized = JSON.stringify(view);
    // D-139: no reasoning/chainOfThought field, and not the stub's CoT text.
    expect(serialized).not.toContain("chainOfThought");
    expect(serialized).not.toContain("Internal:");
    // The view object must not expose a `reasoning` key carrying text.
    expect(Object.keys(view)).not.toContain("reasoning");
  });
});

describe("T-0234 slice surface — INS-TEL-DEMO audit instance (AC-5)", () => {
  it("AC-5: getTelDemoInstance() exposes an S3 legal-precheck node with the agent outcome", async () => {
    const data = await getTelDemoInstance();
    expect(data.instance.id).toBe(TEL_DEMO_INSTANCE_ID);

    const s3 = data.trace.find((step) => step.node === "S3");
    expect(s3).toBeDefined();
    // S3 acted by the AGENT (not a human).
    const agentEvent = s3?.events.find((e) => e.type === "agent" && e.action.includes("юр-предпроверку"));
    expect(agentEvent).toBeDefined();
    expect(agentEvent?.payload?.call).toContain("runLegalPrecheck");

    // The moat event is present: agent's approve attempt was PDP-denied.
    const moatEvent = s3?.events.find((e) => e.action.includes("отказ PDP"));
    expect(moatEvent).toBeDefined();
    expect(moatEvent?.target).toContain("PDP-deny");

    // S4 approve is a HUMAN card-action (the agent never approves).
    const s4 = data.trace.find((step) => step.node === "S4");
    const humanApprove = s4?.events.find((e) => e.type === "human");
    expect(humanApprove).toBeDefined();
  });

  it("AC-5: the demo instance is memoized (deterministic, same object across calls)", async () => {
    const a = await getTelDemoInstance();
    const b = await getTelDemoInstance();
    expect(a).toBe(b);
  });

  it("AC-6: serialized slice instance contains NO raw reasoning text", async () => {
    const data = await getTelDemoInstance();
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("chainOfThought");
    expect(serialized).not.toContain("Internal:");
  });
});
