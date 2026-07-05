/**
 * src/__tests__/process-name-policy.test.ts — T-0684 (capstone T-0647 P1).
 *
 * Pin tests for the SINGLE process-name gate predicate. Live capstone finding: 11
 * definitions on the operator's real screens were all named the modeler placeholder,
 * because nothing required a real human name. These tests lock the reject rule that
 * both the create route and the publish path enforce.
 *
 * The placeholder LITERAL is never spelled out here — it is imported from the module
 * under test (anti-case-lock: neutral values only in new test strings).
 */

import { describe, it, expect } from "vitest";
import {
  isRejectedProcessName,
  isAcceptedProcessName,
  UNNAMED_PROCESS_PLACEHOLDER,
  PROCESS_NAME_REQUIRED_MESSAGE,
} from "../core/process-name-policy.js";

describe("process-name-policy — isRejectedProcessName", () => {
  it("rejects the modeler placeholder default (the swamp source)", () => {
    expect(isRejectedProcessName(UNNAMED_PROCESS_PLACEHOLDER)).toBe(true);
  });

  it("rejects the placeholder regardless of surrounding whitespace and case", () => {
    expect(isRejectedProcessName(`   ${UNNAMED_PROCESS_PLACEHOLDER}  `)).toBe(true);
    expect(isRejectedProcessName(UNNAMED_PROCESS_PLACEHOLDER.toUpperCase())).toBe(true);
    expect(
      isRejectedProcessName(UNNAMED_PROCESS_PLACEHOLDER.replace(" ", "   ")),
    ).toBe(true);
  });

  it("rejects empty / whitespace-only / non-string", () => {
    expect(isRejectedProcessName("")).toBe(true);
    expect(isRejectedProcessName("   ")).toBe(true);
    expect(isRejectedProcessName(undefined)).toBe(true);
    expect(isRejectedProcessName(null)).toBe(true);
    expect(isRejectedProcessName(42)).toBe(true);
  });

  it("ACCEPTS a real human name (enforcement does not block valid names)", () => {
    expect(isRejectedProcessName("Widget Intake Review")).toBe(false);
    expect(isRejectedProcessName("Обработка виджета")).toBe(false);
    // A name that merely CONTAINS the placeholder as a substring is still real.
    expect(isRejectedProcessName(`${UNNAMED_PROCESS_PLACEHOLDER} v2 — доработка`)).toBe(false);
  });

  it("isAcceptedProcessName is the exact complement", () => {
    expect(isAcceptedProcessName(UNNAMED_PROCESS_PLACEHOLDER)).toBe(false);
    expect(isAcceptedProcessName("")).toBe(false);
    expect(isAcceptedProcessName("Widget Intake Review")).toBe(true);
  });

  it("exposes a non-empty user-facing message", () => {
    expect(typeof PROCESS_NAME_REQUIRED_MESSAGE).toBe("string");
    expect(PROCESS_NAME_REQUIRED_MESSAGE.length).toBeGreaterThan(0);
  });
});
