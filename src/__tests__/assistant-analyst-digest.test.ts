/**
 * T-0607 (а/д/г) · analyst registry-digest + telemetry-gate + LLM-error tests.
 *
 * ZERO NETWORK / ZERO DB / ZERO COST — StubChatLlmPort + in-memory ports.
 *
 * Invariants:
 *  AC-1 (а): with a digest port returning a registry that has records, the LLM
 *            context contains the registry name + record count, and NOT «записей нет».
 *  AC-2 (а): digest known-and-empty → context states no data; digest degraded
 *            (or unwired) → context does NOT claim «записей нет».
 *  AC-10 (д): a plain data query does NOT put S3 telemetry into the context;
 *            an explicit process-analytics query DOES.
 *  AC-8 (г): a throwing LLM port yields a HandlerResult with canonical text
 *            (no propagation, no raw body).
 */

import { describe, it, expect } from "vitest";
import { runAnalyst, isProcessAnalyticsQuery } from "../core/assistant-analyst.js";
import type { AnalystPorts } from "../core/assistant-analyst.js";
import type { HandlerContext } from "../core/assistant-intent.js";
import { StubChatLlmPort } from "../core/__tests__/stub-chat-llm-port.js";
import type { GrantSource } from "../core/grant-resolver.js";
import type { AncestryOracle } from "../core/grant-lattice.js";
import type { ResolveSubject } from "../core/object-handle.js";
import type { ReadableRegistryDigest } from "../db/registry-digest-dao.js";
import type { CycleTimeAnalytics, ActorTypeBreakdown } from "../db/transition-journal.js";

const TENANT = "a0000000-0000-0000-0000-000000000001";

const emptyGrantSource: GrantSource = { async getGrants() { return []; } };
const flatOracle: AncestryOracle = {
  isDescendantOrSelf(_h, d, a) { return d === a; },
};

function ctx(llm: StubChatLlmPort): HandlerContext {
  return {
    tenantId: TENANT,
    userSubject: { tenantId: TENANT, subjectId: "u-owner" } as ResolveSubject,
    agentSubject: { tenantId: TENANT, subjectId: "assistant-agent" } as ResolveSubject,
    intersectionGrants: emptyGrantSource,
    ancestry: flatOracle,
    llm,
    threadId: "t-1",
    messageId: "m-1",
  };
}

/** Extract the draft context the analyst pushed into the LLM chat() call. */
function contextSentToLlm(stub: StubChatLlmPort): string {
  expect(stub.chatCalls.length).toBe(1);
  return String(stub.chatCalls[0]!.messages[0]!.content);
}

const CYCLE: CycleTimeAnalytics = {
  tenant_id: TENANT,
  bottleneck: "approval",
  rows: [
    { activity: "approval", avg_duration_ms: 1000, count: 3, human_count: 3, agent_count: 0, service_count: 0 },
  ],
};
const ACTORS: ActorTypeBreakdown[] = [
  { activity: "approval", actor_type: "human", count: 3 },
];

describe("isProcessAnalyticsQuery (T-0607 д)", () => {
  it("true for process-analytics phrasings", () => {
    expect(isProcessAnalyticsQuery("покажи цикловое время по этапам")).toBe(true);
    expect(isProcessAnalyticsQuery("где узкое место в процессе")).toBe(true);
    expect(isProcessAnalyticsQuery("what is the cycle time")).toBe(true);
  });
  it("false for a plain data question", () => {
    expect(isProcessAnalyticsQuery("сколько записей заведено и как называется хотя бы одна")).toBe(false);
  });
});

describe("analyst registry digest (T-0607 а)", () => {
  it("AC-1: digest with records → context has registry name + count, NOT «записей нет»", async () => {
    const digest: ReadableRegistryDigest = {
      degraded: false,
      registries: [
        { slug: "vendors", displayName: "Каталог контрагентов", visibleCount: 1, samples: ["Пример-1"] },
      ],
    };
    const ports: AnalystPorts = { loadRegistryDigest: async () => digest };
    const stub = new StubChatLlmPort();
    await runAnalyst("сколько заведено и как называется хотя бы один", ctx(stub), ports);

    const sent = contextSentToLlm(stub);
    expect(sent).toContain("Каталог контрагентов");
    expect(sent).toContain("записей — 1");
    expect(sent).not.toContain("Записей нет");
  });

  it("T-0587 (§2.2 ADR-T0587, FR-3/FR-5): digest known but zero-visible everywhere → honest zone-of-visibility refusal, NOT a system-state claim", async () => {
    const digest: ReadableRegistryDigest = {
      degraded: false,
      registries: [{ slug: "vendors", displayName: "Каталог", visibleCount: 0, samples: [] }],
    };
    const ports: AnalystPorts = { loadRegistryDigest: async () => digest };
    const stub = new StubChatLlmPort();
    await runAnalyst("сколько заведено", ctx(stub), ports);

    const sent = contextSentToLlm(stub);
    // FR-5: the honest refusal text is present, framed as the ASKER's zone of
    // visibility — NOT a claim about the system's overall state.
    expect(sent).toContain("В вашей зоне видимости данных по этому вопросу нет");
    // FR-5 anti-regression: must NOT claim system-wide absence as fact.
    // (Established convention, mirrors the pre-existing "НЕ утверждай, что
    // записей нет" instruction pattern at the `degraded` branch below: the
    // instruction text legitimately MENTIONS the banned phrase inside a
    // negative directive to the LLM — "не утверждай, что данных в системе
    // нет" — so the anti-regression check targets the ASSERTED/capitalised
    // form a system-state CLAIM would use, not the instruction's embedded
    // lowercase mention.)
    expect(sent).not.toContain("Данных в системе нет");
    expect(sent).not.toMatch(/^В системе (нет|отсутствует)/m);
    expect(sent).not.toMatch(/достоверный факт/);
  });

  it("T-0587 (§2.2, FR-5): NO published registries at all (registries.length===0) folds into the SAME honest refusal", async () => {
    const digest: ReadableRegistryDigest = { degraded: false, registries: [] };
    const ports: AnalystPorts = { loadRegistryDigest: async () => digest };
    const stub = new StubChatLlmPort();
    await runAnalyst("сколько заведено", ctx(stub), ports);

    const sent = contextSentToLlm(stub);
    expect(sent).toContain("В вашей зоне видимости данных по этому вопросу нет");
    // (Established convention, mirrors the pre-existing "НЕ утверждай, что
    // записей нет" instruction pattern at the `degraded` branch below: the
    // instruction text legitimately MENTIONS the banned phrase inside a
    // negative directive to the LLM — "не утверждай, что данных в системе
    // нет" — so the anti-regression check targets the ASSERTED/capitalised
    // form a system-state CLAIM would use, not the instruction's embedded
    // lowercase mention.)
    expect(sent).not.toContain("Данных в системе нет");
    expect(sent).not.toMatch(/^В системе (нет|отсутствует)/m);
  });

  it("T-0587 (§1.4, FF-2/AC-4): numericAggregates are rendered under the registry when present, and NOT wiped by the zero-visibility branch", async () => {
    const digest: ReadableRegistryDigest = {
      degraded: false,
      registries: [
        {
          slug: "deals",
          displayName: "Раздел",
          visibleCount: 2,
          samples: ["Пример-1"],
          numericAggregates: [
            { fieldKey: "amount", fieldLabel: "Сумма", count: 2, sum: 350000, avg: 175000, min: 100000, max: 250000 },
          ],
        },
      ],
    };
    const ports: AnalystPorts = { loadRegistryDigest: async () => digest };
    const stub = new StubChatLlmPort();
    await runAnalyst("сколько записей и на какую сумму", ctx(stub), ports);

    const sent = contextSentToLlm(stub);
    expect(sent).toContain("Сумма");
    expect(sent).toContain("350000");
    expect(sent).not.toContain("В вашей зоне видимости данных по этому вопросу нет");
  });

  it("AC-2: degraded digest → context must NOT claim «записей нет»", async () => {
    const digest: ReadableRegistryDigest = { degraded: true, registries: [] };
    const ports: AnalystPorts = { loadRegistryDigest: async () => digest };
    const stub = new StubChatLlmPort();
    await runAnalyst("сколько заведено", ctx(stub), ports);

    const sent = contextSentToLlm(stub);
    expect(sent).not.toContain("Записей нет");
    expect(sent).toMatch(/Не удалось прочитать разделы/);
  });

  it("AC-2: unwired digest port (null) → context must NOT claim «записей нет»", async () => {
    const stub = new StubChatLlmPort();
    // No loadRegistryDigest port at all.
    await runAnalyst("сколько заведено", ctx(stub), {});
    const sent = contextSentToLlm(stub);
    expect(sent).not.toContain("Записей нет");
    expect(sent).toMatch(/недоступны для чтения/);
  });

  it("adversary-honesty fix (T-0587): reg.truncated → context carries an honest 'possibly incomplete' note with the DAO's own scannedLimit, not a fabricated one", async () => {
    const digest: ReadableRegistryDigest = {
      degraded: false,
      registries: [
        {
          slug: "vendors",
          displayName: "Каталог контрагентов",
          visibleCount: 200,
          samples: ["Пример-1"],
          truncated: true,
          scannedLimit: 200,
        },
      ],
    };
    const ports: AnalystPorts = { loadRegistryDigest: async () => digest };
    const stub = new StubChatLlmPort();
    await runAnalyst("сколько заведено", ctx(stub), ports);

    const sent = contextSentToLlm(stub);
    expect(sent).toContain("записей — 200");
    // Human-readable, no jargon ("scanLimit"/"truncated" etc. are internal
    // names — the rendered note must read as prose, and must cite the DAO's
    // OWN scannedLimit (200), not a second hardcoded literal.
    expect(sent).toContain("по первым 200 просканированным видимым записям");
    expect(sent).toContain("итог может быть неполным");
    expect(sent).not.toMatch(/scanLimit|truncated/i);
  });

  it("adversary-honesty fix (T-0587): reg.truncated absent/false → NO truncation note rendered", async () => {
    const digest: ReadableRegistryDigest = {
      degraded: false,
      registries: [
        { slug: "vendors", displayName: "Каталог контрагентов", visibleCount: 5, samples: ["Пример-1"] },
      ],
    };
    const ports: AnalystPorts = { loadRegistryDigest: async () => digest };
    const stub = new StubChatLlmPort();
    await runAnalyst("сколько заведено", ctx(stub), ports);

    const sent = contextSentToLlm(stub);
    expect(sent).toContain("записей — 5");
    expect(sent).not.toContain("просканированным");
    expect(sent).not.toContain("может быть неполным");
  });
});

describe("S3 telemetry gate (T-0607 д)", () => {
  const telemetryPorts: AnalystPorts = {
    loadCycleTime: async () => CYCLE,
    loadActorBreakdown: async () => ACTORS,
    loadRegistryDigest: async () => ({ degraded: false, registries: [] }),
  };

  it("AC-10: plain data query → NO cycle-time / actor-breakdown in context", async () => {
    const stub = new StubChatLlmPort();
    await runAnalyst("сколько поставщиков заведено", ctx(stub), telemetryPorts);
    const sent = contextSentToLlm(stub);
    expect(sent).not.toContain("Цикловое время");
    expect(sent).not.toContain("Разбивка по типу актора");
  });

  it("AC-10: process-analytics query → cycle-time / actor-breakdown ARE in context", async () => {
    const stub = new StubChatLlmPort();
    await runAnalyst("покажи цикловое время по этапам процесса", ctx(stub), telemetryPorts);
    const sent = contextSentToLlm(stub);
    expect(sent).toContain("Цикловое время");
    expect(sent).toContain("Разбивка по типу актора");
  });
});

describe("analyst LLM-error propagates to the route (T-0607 г / anti-mask)", () => {
  it("AC-8: a throwing LLM port PROPAGATES (analyst does not mask) — the route seam handles it", async () => {
    // The (г) guarantee (thread never mute) + the anti-mask invariant (real bugs
    // stay visible) are BOTH enforced at the assistant ROUTE seam, not swallowed
    // here. So the analyst must let the error propagate — the route then persists
    // a canonical in-thread reply AND returns INTERNAL 500 (see
    // ci/checks/db/assistant-dispatch-failure.test.ts + assistant-report.test.ts).
    const stub = new StubChatLlmPort({ mode: "error" });
    const ports: AnalystPorts = { loadRegistryDigest: async () => ({ degraded: false, registries: [] }) };
    await expect(runAnalyst("любой запрос", ctx(stub), ports)).rejects.toBeInstanceOf(Error);
  });
});
