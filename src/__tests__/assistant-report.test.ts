/**
 * T-0607 (в2/г) · assistant-report unit tests.
 *
 * ZERO NETWORK / ZERO DB / ZERO COST — pure functions.
 *
 * Invariants:
 *  AC-7 (в2): buildHonestOpsReport reconciles the assistant text with the REAL
 *             per-op outcomes. Failed ops are shown as failed (never «✅»);
 *             a duplicate op reads «уже было», not «не создано»; when everything
 *             succeeds the optimistic text is returned unchanged.
 *  AC-9 (г):  buildDispatchFailureReply returns a canonical, jargon-free reply.
 */

import { describe, it, expect } from "vitest";
import {
  buildHonestOpsReport,
  buildDispatchFailureReply,
  DISPATCH_FAILURE_REPLY,
  type OpResult,
} from "../core/assistant-report.js";

// Dev-jargon denylist mirrored from ci/checks/ux/assistant-llm-message-jargon.sh.
const JARGON = ["LLM_NOT_CONFIGURED", "OpenAILlmPort", "endpoint", "secretHandle", "stack"];

describe("buildHonestOpsReport (T-0607 в2)", () => {
  const OPTIMISTIC = "Все поля добавлены ✅";

  it("returns the LLM text UNCHANGED when every op succeeded", () => {
    const ops: OpResult[] = [
      { description: "op A", ok: true },
      { description: "op B", ok: true },
    ];
    expect(buildHonestOpsReport(OPTIMISTIC, ops)).toBe(OPTIMISTIC);
  });

  it("returns the LLM text UNCHANGED when there are no ops (plan-only turn)", () => {
    expect(buildHonestOpsReport(OPTIMISTIC, [])).toBe(OPTIMISTIC);
  });

  it("AC-7: [1 ok, 1 fail] → failed op shown as failed, NO ✅ carried for it", () => {
    const ops: OpResult[] = [
      { description: "добавить поле X", ok: true },
      { description: "добавить поле Y", ok: false, error: "реестр не найден" },
    ];
    const out = buildHonestOpsReport(OPTIMISTIC, ops);

    // The optimistic all-success claim must NOT survive a real failure.
    expect(out).not.toContain(OPTIMISTIC);
    // No green success tick anywhere near the failed op.
    expect(out).toContain("✗ добавить поле Y");
    expect(out).toContain("реестр не найден");
    // The succeeded op is still acknowledged truthfully.
    expect(out).toContain("✓ добавить поле X");
    // Honest partial-result header.
    expect(out).toMatch(/частично/i);
  });

  it("all-fail → header says none executed, no ✅", () => {
    const ops: OpResult[] = [
      { description: "op A", ok: false, error: "e1" },
      { description: "op B", ok: false, error: "e2" },
    ];
    const out = buildHonestOpsReport(OPTIMISTIC, ops);
    expect(out).not.toContain("✅");
    expect(out).toContain("✗ op A");
    expect(out).toContain("✗ op B");
    expect(out).toMatch(/Ни одна/i);
  });

  it("duplicate op reads «уже было», distinct from «не создано»", () => {
    const ops: OpResult[] = [
      { description: "создать раздел Z", ok: false, duplicate: true, error: "раздел уже есть" },
    ];
    const out = buildHonestOpsReport(OPTIMISTIC, ops);
    expect(out).toContain("уже было");
    expect(out).not.toContain("не создано");
    // A duplicate is NOT a hard failure — no «исправьте причину» tail.
    expect(out).not.toMatch(/исправьте причину/i);
  });

  it("mixed duplicate + hard failure → hard-failure tail present", () => {
    const ops: OpResult[] = [
      { description: "op dup", ok: false, duplicate: true, error: "уже есть" },
      { description: "op hard", ok: false, error: "реестр не найден" },
    ];
    const out = buildHonestOpsReport(OPTIMISTIC, ops);
    expect(out).toContain("уже было");
    expect(out).toContain("✗ op hard");
    expect(out).toMatch(/исправьте причину/i);
  });
});

describe("buildDispatchFailureReply (T-0607 г)", () => {
  it("AC-9: returns the canonical constant, non-empty", () => {
    expect(buildDispatchFailureReply()).toBe(DISPATCH_FAILURE_REPLY);
    expect(buildDispatchFailureReply().length).toBeGreaterThan(0);
  });

  it("carries no dev-jargon denylist tokens", () => {
    const text = buildDispatchFailureReply();
    for (const tok of JARGON) expect(text).not.toContain(tok);
  });

  it("does not leak raw error / stack shapes", () => {
    const text = buildDispatchFailureReply();
    expect(text).not.toMatch(/Error:|at \w+\.ts:/);
  });
});
