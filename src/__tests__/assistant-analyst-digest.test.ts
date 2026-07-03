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

  it("AC-2: digest known-and-empty (registries with 0 records) → honest zero, still no false «нет данных»", async () => {
    const digest: ReadableRegistryDigest = {
      degraded: false,
      registries: [{ slug: "vendors", displayName: "Каталог", visibleCount: 0, samples: [] }],
    };
    const ports: AnalystPorts = { loadRegistryDigest: async () => digest };
    const stub = new StubChatLlmPort();
    await runAnalyst("сколько заведено", ctx(stub), ports);

    const sent = contextSentToLlm(stub);
    // The registry itself is listed with a truthful zero count.
    expect(sent).toContain("записей — 0");
    expect(sent).toMatch(/достоверный факт/);
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

describe("analyst LLM-error → honest reply in thread (T-0607 г)", () => {
  it("AC-8: throwing LLM port yields a canonical HandlerResult, no propagation", async () => {
    const stub = new StubChatLlmPort({ mode: "error" });
    const ports: AnalystPorts = { loadRegistryDigest: async () => ({ degraded: false, registries: [] }) };
    const result = await runAnalyst("любой запрос", ctx(stub), ports);
    expect(result.intent).toBe("analyst");
    expect(result.text.length).toBeGreaterThan(0);
    // Canonical, not a raw thrown Error / provider body.
    expect(result.text).not.toMatch(/Error:|OpenAI API error|at \w+\.ts:/);
  });
});
