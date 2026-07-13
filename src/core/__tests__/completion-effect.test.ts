/**
 * src/core/__tests__/completion-effect.test.ts — T-0249 (B-11)
 *
 * Unit tests for the GENERIC completion-effect primitive (no DB, no case content).
 */

import { describe, it, expect, vi } from "vitest";
import {
  makeCompletionEffectRegistry,
  runCompletionEffect,
  EMPTY_COMPLETION_EFFECT_REGISTRY,
  type CompletionEffectClient,
  type CompletionEffectContext,
  type CompletionEffectHandler,
} from "../completion-effect.js";

const CLIENT: CompletionEffectClient = {
  async query() {
    return { rows: [] };
  },
};

function ctx(overrides: Partial<CompletionEffectContext> = {}): CompletionEffectContext {
  return {
    tenantId: "t1",
    applicationId: "app1",
    registryId: "reg1",
    recordId: "rec1",
    procKey: "some-process",
    activity: "some-step",
    actor: "actor-1",
    nowMs: 1_000,
    ...overrides,
  };
}

describe("completion-effect registry", () => {
  it("resolves a registered (procKey, activity) handler and no other", () => {
    const h: CompletionEffectHandler = async () => {};
    const reg = makeCompletionEffectRegistry([{ procKey: "P", activity: "step-A", handler: h }]);
    expect(reg.resolve("P", "step-A")).toBe(h);
    expect(reg.resolve("P", "step-B")).toBeUndefined();
    expect(reg.resolve("Q", "step-A")).toBeUndefined();
  });

  it("throws on a duplicate (procKey, activity) binding (no silent last-wins)", () => {
    const h: CompletionEffectHandler = async () => {};
    expect(() =>
      makeCompletionEffectRegistry([
        { procKey: "P", activity: "s", handler: h },
        { procKey: "P", activity: "s", handler: h },
      ]),
    ).toThrow(/duplicate completion effect/);
  });

  it("allows the same handler under distinct activity keys (defKey + name)", () => {
    const h: CompletionEffectHandler = async () => {};
    const reg = makeCompletionEffectRegistry([
      { procKey: "P", activity: "task-x", handler: h },
      { procKey: "P", activity: "Step X", handler: h },
    ]);
    expect(reg.resolve("P", "task-x")).toBe(h);
    expect(reg.resolve("P", "Step X")).toBe(h);
  });
});

describe("runCompletionEffect dispatcher", () => {
  it("no-op ({ ran: false }) when nothing is registered for the step", async () => {
    const res = await runCompletionEffect(CLIENT, ctx(), EMPTY_COMPLETION_EFFECT_REGISTRY);
    expect(res.ran).toBe(false);
  });

  it("runs the handler with the caller's client + ctx when registered", async () => {
    const handler = vi.fn<CompletionEffectHandler>(async () => {});
    const reg = makeCompletionEffectRegistry([
      { procKey: "some-process", activity: "some-step", handler },
    ]);
    const c = ctx();
    const res = await runCompletionEffect(CLIENT, c, reg);
    expect(res.ran).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(CLIENT, c);
  });

  it("propagates a handler throw (fail-closed → caller ROLLBACK)", async () => {
    const reg = makeCompletionEffectRegistry([
      {
        procKey: "some-process",
        activity: "some-step",
        handler: async () => {
          throw new Error("effect boom");
        },
      },
    ]);
    await expect(runCompletionEffect(CLIENT, ctx(), reg)).rejects.toThrow(/effect boom/);
  });
});
