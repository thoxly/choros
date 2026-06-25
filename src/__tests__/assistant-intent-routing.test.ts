/**
 * T-0462 (D8-G1) · assistant-intent routing tests.
 *
 * ZERO NETWORK / ZERO DB / ZERO COST — pure classifyIntent + intentDispatch.
 *
 * Invariant under test (spec §3.3): build/configure intents
 * («построй / собери / настрой …») route to the CONFIGURATOR (authoring path),
 * NOT the read-only analyst. A user who says «построй приложение …» must reach
 * the authoring tool, not get a read-only answer.
 */

import { describe, it, expect } from "vitest";
import {
  classifyIntent,
  intentDispatch,
  type HandlerContext,
} from "../core/assistant-intent.js";
import { StubChatLlmPort } from "../core/__tests__/stub-chat-llm-port.js";
import type { GrantSource } from "../core/grant-resolver.js";
import type { Grant, AncestryOracle } from "../core/grant-lattice.js";
import type { ResolveSubject } from "../core/object-handle.js";

const DEV_TENANT = "a0000000-0000-0000-0000-000000000001";
const AUTHORING_DRAFT = "authoring_draft" as Grant["resourceType"];

const DRAFT_GRANT: Grant = {
  tenantId: DEV_TENANT,
  id: "f1000000-0000-0000-0000-000000000001",
  roleId: "e0000000-0000-0000-0000-000000000003",
  resourceType: AUTHORING_DRAFT,
  operation: "create",
  scope: { kind: "node", hierarchy: "org", nodeId: "b0000000-0000-0000-0000-000000000001", nodeLevel: "department" },
  delegable: false,
  grantedBy: "seed",
  createdAt: 0,
};

function makeGrantSource(grants: Grant[]): GrantSource {
  return {
    async getGrants(subject: ResolveSubject, _nowMs: number): Promise<Grant[]> {
      return grants.filter((g) => g.tenantId === subject.tenantId);
    },
  };
}

const flatOracle: AncestryOracle = {
  isDescendantOrSelf(_h, descendantId, ancestorId) {
    return descendantId === ancestorId;
  },
};

function makeContext(grants: Grant[], llm: StubChatLlmPort): HandlerContext {
  return {
    tenantId: DEV_TENANT,
    userSubject: { tenantId: DEV_TENANT, subjectId: "e-orlov" },
    agentSubject: { tenantId: DEV_TENANT, subjectId: "assistant-agent" },
    intersectionGrants: makeGrantSource(grants),
    ancestry: flatOracle,
    llm,
    threadId: "thread-test-001",
    messageId: "msg-test-001",
  };
}

// ---------------------------------------------------------------------------
// AC-T462-R1: build/configure verbs classify as configurator
// ---------------------------------------------------------------------------

describe("AC-T462-R1: build/configure intents route to configurator", () => {
  const buildPhrases = [
    "построй приложение для закупок",
    "построить CRM",
    "собери приложение Заявки",
    "собрать процесс согласования",
    "настрой форму заявки",
    "настроить процесс закупок",
    "создай раздел Контрагенты",
    "создать приложение",
    "build a CRM app",
  ];

  for (const phrase of buildPhrases) {
    it(`classifies «${phrase}» as configurator`, () => {
      expect(classifyIntent(phrase)).toBe("configurator");
    });
  }

  it("«построй приложение …» is NOT classified as analyst (the regression this fixes)", () => {
    expect(classifyIntent("построй приложение для закупок")).not.toBe("analyst");
  });
});

// ---------------------------------------------------------------------------
// AC-T462-R2: read-only report intents still route to analyst
// ---------------------------------------------------------------------------

describe("AC-T462-R2: read-only report intents still route to analyst", () => {
  it("«покажи отчёт по заявкам» → analyst", () => {
    expect(classifyIntent("покажи отчёт по заявкам")).toBe("analyst");
  });

  it("«сделай анализ продаж» → analyst", () => {
    expect(classifyIntent("сделай анализ продаж")).toBe("analyst");
  });

  it("«дай рекомендация по продажам» → analyst", () => {
    expect(classifyIntent("дай рекомендация по продажам")).toBe("analyst");
  });
});

// ---------------------------------------------------------------------------
// AC-T462-R3: intentDispatch sends a build intent to the configurator handler
// (which then enforces the authoring_draft grant) — NOT to the read-only analyst.
// ---------------------------------------------------------------------------

describe("AC-T462-R3: intentDispatch routes «построй …» to configurator handler", () => {
  it("a holder of authoring_draft reaching «построй приложение …» gets the configurator (intent=configurator)", async () => {
    const stub = new StubChatLlmPort({ fixedText: "Собираю черновик приложения." });
    const ctx = makeContext([DRAFT_GRANT], stub);
    const result = await intentDispatch("построй приложение Заявки на закупку", ctx);
    expect(result.intent).toBe("configurator");
    // Configurator actually engaged the LLM (authoring path), not a read-only analyst stub.
    expect(stub.chatCalls.length).toBeGreaterThan(0);
  });

  it("a NON-holder reaching «построй приложение …» is refused honestly (configurator grant gate), NOT given a read-only analyst answer", async () => {
    const stub = new StubChatLlmPort();
    const ctx = makeContext([], stub); // no authoring_draft grant
    const result = await intentDispatch("построй приложение Заявки", ctx);
    // Routed to configurator (not analyst) → T-0466 [D8-G5] HUMAN refusal
    // («нет прав настраивать … обратитесь к администратору»), no LLM dispatch.
    expect(result.intent).toBe("configurator");
    expect(result.text).toMatch(/нет прав настраивать|администратор/i);
    expect(stub.chatCalls).toHaveLength(0);
  });
});
