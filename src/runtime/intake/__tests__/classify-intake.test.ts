/**
 * src/runtime/intake/__tests__/classify-intake.test.ts — T-0219 intake-agent.
 *
 * Unit tests for the deterministic classifier-demonstrator: stable demo-deal
 * output, typed route, the load-bearing S2→S3 legal_required link, and the
 * reasoning-trace (D-139: structured «why», never raw chain-of-thought).
 */

import { describe, it, expect } from "vitest";
import {
  classifyIntake,
  buildIntakeRoute,
  TEL_LEGAL_THRESHOLD_RUB,
} from "../classify-intake.js";
import type { IntakeInput } from "../intake-types.js";

const DEMO_DEAL: IntakeInput = {
  subject: "Закупка лицензий ПО для отдела ИТ (годовая)",
  amount: 5_500_000,
  justification: "Продление корпоративных лицензий, истекают 30.06.2026",
  requester: "e-orlov",
};

describe("classifyIntake — demo-deal determinism (AC-6)", () => {
  it("produces stable category / article / direction for the demo-deal", () => {
    const r = classifyIntake(DEMO_DEAL);
    expect(r.answer.category).toBe("it_expense");
    expect(r.answer.budget_article).toBe("BUD-14");
    expect(r.answer.direction).toBe("buy");
    expect(r.answer_form).toBe("intake_triage_v1");
  });

  it("is deterministic — same input → byte-equal output", () => {
    expect(classifyIntake(DEMO_DEAL)).toStrictEqual(classifyIntake(DEMO_DEAL));
  });

  it("produces the mandatory approver chain [fin_controller, legal, cfo] ≥5M (AC-6)", () => {
    const r = classifyIntake(DEMO_DEAL);
    expect(r.answer.route.approver_chain).toEqual(["fin_controller", "legal", "cfo"]);
    expect(r.answer.route.legal_required).toBe(true);
    expect(r.answer.route.steps.map((s) => s.order)).toEqual([1, 2, 3]);
    expect(r.answer.route.steps.every((s) => s.mandatory)).toBe(true);
  });
});

describe("buildIntakeRoute — typed route + legal_required link (AC-5, AC-9)", () => {
  it("≥ threshold → legal_required true, chain includes legal+cfo", () => {
    const route = buildIntakeRoute(TEL_LEGAL_THRESHOLD_RUB);
    expect(route.legal_required).toBe(true);
    expect(route.approver_chain).toEqual(["fin_controller", "legal", "cfo"]);
  });

  it("< threshold → legal_required false, fin_controller only", () => {
    const route = buildIntakeRoute(TEL_LEGAL_THRESHOLD_RUB - 1);
    expect(route.legal_required).toBe(false);
    expect(route.approver_chain).toEqual(["fin_controller"]);
    expect(route.steps).toHaveLength(1);
  });

  it("legal_required === (amount ≥ threshold) — the S2→S3 link (AC-9)", () => {
    for (const amount of [0, 1_000_000, 4_999_999, 5_000_000, 5_500_000, 10_000_000]) {
      const route = buildIntakeRoute(amount);
      expect(route.legal_required).toBe(amount >= TEL_LEGAL_THRESHOLD_RUB);
    }
  });

  it("approver_chain mirrors steps order exactly", () => {
    const route = buildIntakeRoute(9_000_000);
    expect(route.approver_chain).toEqual(route.steps.map((s) => s.role));
  });
});

describe("category classification — deterministic keyword routing", () => {
  it("aho keyword → BUD-21", () => {
    const r = classifyIntake({
      subject: "Ремонт офисной мебели",
      amount: 100_000,
      justification: "Хозяйственные нужды",
      requester: "e-x",
    });
    expect(r.answer.category).toBe("aho");
    expect(r.answer.budget_article).toBe("BUD-21");
  });

  it("marketing keyword → BUD-33", () => {
    const r = classifyIntake({
      subject: "Рекламная кампания Q3",
      amount: 300_000,
      justification: "Промо новой линейки",
      requester: "e-y",
    });
    expect(r.answer.category).toBe("marketing");
    expect(r.answer.budget_article).toBe("BUD-33");
  });

  it("no keyword → fallback it_expense, basis records the fallback honestly", () => {
    const r = classifyIntake({
      subject: "Неопределённая заявка",
      amount: 50_000,
      justification: "Без явных признаков",
      requester: "e-z",
    });
    expect(r.answer.category).toBe("it_expense");
    const catStep = r.reasoning_trace.find((s) => s.claim.startsWith("category="));
    expect(catStep?.basis).toContain("fallback");
  });
});

describe("reasoning-trace (D-139 — structured why, no raw egress) (AC-7)", () => {
  it("emits a structured trace with claim+basis per decision", () => {
    const r = classifyIntake(DEMO_DEAL);
    expect(r.reasoning_trace.length).toBeGreaterThanOrEqual(4);
    for (const step of r.reasoning_trace) {
      expect(typeof step.claim).toBe("string");
      expect(typeof step.basis).toBe("string");
      expect(step.claim.length).toBeGreaterThan(0);
      expect(step.basis.length).toBeGreaterThan(0);
    }
  });

  it("answer carries NO reasoning field (raw reasoning stays out of egress)", () => {
    const r = classifyIntake(DEMO_DEAL);
    // The safe external answer is exactly {category, budget_article, direction, route}.
    expect(Object.keys(r.answer).sort()).toEqual(
      ["budget_article", "category", "direction", "route"].sort(),
    );
    expect((r.answer as unknown as Record<string, unknown>)["reasoning"]).toBeUndefined();
  });

  it("trace explains the ≥threshold routing decision", () => {
    const r = classifyIntake(DEMO_DEAL);
    const legalStep = r.reasoning_trace.find((s) => s.claim.startsWith("route.legal_required"));
    expect(legalStep?.claim).toBe("route.legal_required=true");
    expect(legalStep?.basis).toContain("порог");
  });
});
