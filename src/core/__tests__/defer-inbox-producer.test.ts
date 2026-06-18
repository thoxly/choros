/**
 * src/core/__tests__/defer-inbox-producer.test.ts — T-0221 PURE golden tests.
 *
 * Tests planDeferTask invariants (§5.1 ADR):
 *   - doubtReason always non-empty (INV, AC-5)
 *   - empty / "pending" doubtReason → normalised to fallback
 *   - name is deterministic and truncated at 120 chars
 *   - execType is always "agent"
 *   - slaMinutes optional
 *   - originOutcome is always "defer"
 *
 * PURE: no pg / http / env — no IO. All static-now.
 */

import { describe, it, expect } from "vitest";
import { planDeferTask, type DeferTaskPlan } from "../defer-inbox-producer.js";
import type { PrecheckOutcome } from "../agent-precheck-motor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DeferOutcome = Extract<PrecheckOutcome, { kind: "defer-to-human" }>;

function makeDeferOutcome(overrides?: Partial<DeferOutcome>): DeferOutcome {
  return {
    kind: "defer-to-human",
    signal: "threshold",
    doubtReason: "autonomy threshold not met",
    inboxTaskRef: "some-audit-id",
    ...overrides,
  };
}

const DEFAULT_CTX = {
  role: "fin-ctrl",
  agentEmployeeId: "e-agent-01",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("planDeferTask — PURE golden (T-0221 §5.1)", () => {
  it("returns correct shape for normal input", () => {
    const outcome = makeDeferOutcome({ doubtReason: "model confidence too low" });
    const plan: DeferTaskPlan = planDeferTask(outcome, DEFAULT_CTX);

    expect(plan.originOutcome).toBe("defer");
    expect(plan.execType).toBe("agent");
    expect(plan.execName).toBe(DEFAULT_CTX.agentEmployeeId);
    expect(plan.role).toBe(DEFAULT_CTX.role);
    expect(plan.doubtReason).toBe("model confidence too low");
    expect(plan.name).toBe("Проверить: model confidence too low");
    expect(plan.slaMinutes).toBeUndefined();
  });

  it("INV: empty doubtReason → normalises to non-empty fallback", () => {
    const outcome = makeDeferOutcome({ doubtReason: "" });
    const plan = planDeferTask(outcome, DEFAULT_CTX);

    expect(plan.doubtReason.trim().length).toBeGreaterThan(0);
    expect(plan.name.length).toBeGreaterThan(0);
  });

  it("INV: 'pending' doubtReason → normalises to non-empty fallback", () => {
    const outcome = makeDeferOutcome({ doubtReason: "pending" });
    const plan = planDeferTask(outcome, DEFAULT_CTX);

    expect(plan.doubtReason).not.toBe("pending");
    expect(plan.doubtReason.trim().length).toBeGreaterThan(0);
  });

  it("INV: whitespace-only doubtReason → normalises to fallback", () => {
    const outcome = makeDeferOutcome({ doubtReason: "   " });
    const plan = planDeferTask(outcome, DEFAULT_CTX);

    expect(plan.doubtReason.trim().length).toBeGreaterThan(0);
  });

  it("name is truncated to ≤120 chars when doubtReason is very long", () => {
    const longReason = "A".repeat(200);
    const outcome = makeDeferOutcome({ doubtReason: longReason });
    const plan = planDeferTask(outcome, DEFAULT_CTX);

    expect(plan.name.length).toBeLessThanOrEqual(120);
    expect(plan.doubtReason).toBe(longReason); // doubtReason itself is NOT truncated
  });

  it("slaMinutes is passed through from ctx when provided", () => {
    const outcome = makeDeferOutcome();
    const plan = planDeferTask(outcome, { ...DEFAULT_CTX, slaMinutes: 30 });

    expect(plan.slaMinutes).toBe(30);
  });

  it("slaMinutes is undefined when not provided", () => {
    const outcome = makeDeferOutcome();
    const plan = planDeferTask(outcome, DEFAULT_CTX);

    expect(plan.slaMinutes).toBeUndefined();
  });

  it("role comes from ctx, not from outcome", () => {
    const outcome = makeDeferOutcome();
    const plan = planDeferTask(outcome, { ...DEFAULT_CTX, role: "cs-l2" });

    expect(plan.role).toBe("cs-l2");
  });

  it("deterministic: same input → same output", () => {
    const outcome = makeDeferOutcome({ doubtReason: "ambiguous answer" });
    const plan1 = planDeferTask(outcome, DEFAULT_CTX);
    const plan2 = planDeferTask(outcome, DEFAULT_CTX);

    expect(JSON.stringify(plan1)).toBe(JSON.stringify(plan2));
  });

  it("all signal types produce valid plans", () => {
    const signals: Array<DeferOutcome["signal"]> = ["threshold", "model", "ambiguity", "dormant"];
    for (const signal of signals) {
      const outcome = makeDeferOutcome({ signal, doubtReason: `reason for ${signal}` });
      const plan = planDeferTask(outcome, DEFAULT_CTX);

      expect(plan.doubtReason.trim().length).toBeGreaterThan(0);
      expect(plan.name.startsWith("Проверить:")).toBe(true);
      expect(plan.originOutcome).toBe("defer");
    }
  });
});
