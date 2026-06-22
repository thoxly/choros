/**
 * T-0383 · per-tenant assistant system prompt tests.
 *
 * Tests:
 *  AC-T383-1: analyst uses custom prompt when override provided.
 *  AC-T383-2: analyst falls back to default when loadSystemPrompt returns null.
 *  AC-T383-3: analyst default contains the tenantId suffix (backward-compat).
 *  AC-T383-4: ANALYST_DEFAULT_SYSTEM_PROMPT is exported and non-empty.
 *  AC-T383-5: configurator uses custom prompt when systemPromptOverride provided.
 *  AC-T383-6: configurator falls back to default when no override.
 *  AC-T383-7: CONFIGURATOR_DEFAULT_SYSTEM_PROMPT is exported and non-empty.
 *  AC-T383-8: setAnalystPorts with loadSystemPrompt wires the override into handleAnalyst.
 *
 * DB / network: ZERO (all stubs).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  runAnalyst,
  setAnalystPorts,
  resetAnalystPorts,
  handleAnalyst,
  ANALYST_DEFAULT_SYSTEM_PROMPT,
  type AnalystPorts,
} from "../core/assistant-analyst.js";
import {
  handleConfigurator,
  runConfigurator,
  CONFIGURATOR_DEFAULT_SYSTEM_PROMPT,
} from "../core/assistant-configurator.js";
import type { HandlerContext } from "../core/assistant-intent.js";
import { StubChatLlmPort } from "../core/__tests__/stub-chat-llm-port.js";
import type { GrantSource } from "../core/grant-resolver.js";
import type { Grant, AncestryOracle } from "../core/grant-lattice.js";
import type { ResolveSubject } from "../core/object-handle.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const AUTHORING_DRAFT = "authoring_draft" as Grant["resourceType"];

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const agentSubject: ResolveSubject = { tenantId: TENANT_A, subjectId: "assistant-agent" };
const userSubject: ResolveSubject = { tenantId: TENANT_A, subjectId: "alice" };

const flatOracle: AncestryOracle = {
  isDescendantOrSelf(_h, a, b) { return a === b; },
};

const emptyGrantSource: GrantSource = { async getGrants() { return []; } };

function makeGrantSource(grants: Grant[]): GrantSource {
  return {
    async getGrants(subject: ResolveSubject, _nowMs: number) {
      return grants.filter((g) => g.tenantId === subject.tenantId || g.tenantId === "");
    },
  };
}

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    tenantId: TENANT_A,
    userSubject,
    agentSubject,
    intersectionGrants: emptyGrantSource,
    ancestry: flatOracle,
    llm: new StubChatLlmPort({ fixedText: "Ответ от LLM." }),
    threadId: "thread-0001",
    messageId: "msg-0001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-T383-4: ANALYST_DEFAULT_SYSTEM_PROMPT exported and non-empty
// ---------------------------------------------------------------------------

describe("ANALYST_DEFAULT_SYSTEM_PROMPT", () => {
  it("AC-T383-4: is a non-empty string", () => {
    expect(typeof ANALYST_DEFAULT_SYSTEM_PROMPT).toBe("string");
    expect(ANALYST_DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// AC-T383-7: CONFIGURATOR_DEFAULT_SYSTEM_PROMPT exported and non-empty
// ---------------------------------------------------------------------------

describe("CONFIGURATOR_DEFAULT_SYSTEM_PROMPT", () => {
  it("AC-T383-7: is a non-empty string", () => {
    expect(typeof CONFIGURATOR_DEFAULT_SYSTEM_PROMPT).toBe("string");
    expect(CONFIGURATOR_DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Analyst prompt tests
// ---------------------------------------------------------------------------

describe("runAnalyst — per-tenant system prompt (T-0383)", () => {
  afterEach(() => {
    resetAnalystPorts();
  });

  it("AC-T383-2: falls back to default when loadSystemPrompt returns null", async () => {
    // Track what system prompt was passed to the LLM.
    let capturedSystem: string | undefined;
    const llm = new StubChatLlmPort({ fixedText: "ok" });
    const origChat = llm.chat.bind(llm);
    llm.chat = async (req) => {
      capturedSystem = req.system;
      return origChat(req);
    };

    const ports: AnalystPorts = {
      loadSystemPrompt: async () => null,
    };

    await runAnalyst("тест", makeCtx({ llm }), ports);

    // Should contain the tenantId suffix (backward-compat default).
    expect(capturedSystem).toBeDefined();
    expect(capturedSystem).toContain(TENANT_A);
  });

  it("AC-T383-1: uses custom prompt when override provided", async () => {
    let capturedSystem: string | undefined;
    const customPrompt = "Ты специализированный аналитик по продажам. Отвечай только по продажам.";
    const llm = new StubChatLlmPort({ fixedText: "ok" });
    const origChat = llm.chat.bind(llm);
    llm.chat = async (req) => {
      capturedSystem = req.system;
      return origChat(req);
    };

    const ports: AnalystPorts = {
      loadSystemPrompt: async () => customPrompt,
    };

    await runAnalyst("тест", makeCtx({ llm }), ports);

    // Should be exactly the custom prompt, not the default.
    expect(capturedSystem).toBe(customPrompt);
    // Should NOT contain the tenantId (which appears in the default).
    expect(capturedSystem).not.toContain(TENANT_A);
  });

  it("AC-T383-3: default prompt contains tenantId (backward-compat)", async () => {
    let capturedSystem: string | undefined;
    const llm = new StubChatLlmPort({ fixedText: "ok" });
    const origChat = llm.chat.bind(llm);
    llm.chat = async (req) => {
      capturedSystem = req.system;
      return origChat(req);
    };

    // No loadSystemPrompt port → default applies.
    await runAnalyst("тест", makeCtx({ llm }), {});

    expect(capturedSystem).toContain(TENANT_A);
  });

  it("AC-T383-8: setAnalystPorts wires loadSystemPrompt into handleAnalyst", async () => {
    let capturedSystem: string | undefined;
    const customPrompt = "Кастомный промпт для handleAnalyst.";
    const llm = new StubChatLlmPort({ fixedText: "ok" });
    const origChat = llm.chat.bind(llm);
    llm.chat = async (req) => {
      capturedSystem = req.system;
      return origChat(req);
    };

    setAnalystPorts({
      loadSystemPrompt: async () => customPrompt,
    });

    await handleAnalyst("тест", makeCtx({ llm }));

    expect(capturedSystem).toBe(customPrompt);
  });
});

// ---------------------------------------------------------------------------
// Configurator prompt tests
// ---------------------------------------------------------------------------

describe("runConfigurator — per-tenant system prompt (T-0383)", () => {
  const authoringDraftGrant: Grant = {
    id: "g-001",
    tenantId: TENANT_A,
    resourceType: AUTHORING_DRAFT,
    operation: "create",
    scope: { kind: "node", hierarchy: "org", nodeId: "org", nodeLevel: "department" },
    delegable: false,
    confirmedBy: "admin",
  };

  function makeCtxWithGrant(llm: StubChatLlmPort): HandlerContext {
    const grantSource = makeGrantSource([authoringDraftGrant]);
    return makeCtx({ intersectionGrants: grantSource, llm });
  }

  it("AC-T383-6: falls back to default when no systemPromptOverride", async () => {
    let capturedSystem: string | undefined;
    const llm = new StubChatLlmPort({ fixedText: "ok" });
    const origChat = llm.chat.bind(llm);
    llm.chat = async (req) => {
      capturedSystem = req.system;
      return origChat(req);
    };

    await runConfigurator("тест", makeCtxWithGrant(llm), null);

    expect(capturedSystem).toBe(CONFIGURATOR_DEFAULT_SYSTEM_PROMPT);
  });

  it("AC-T383-5: uses custom prompt when systemPromptOverride provided", async () => {
    let capturedSystem: string | undefined;
    const customPrompt = "Ты специализированный конфигуратор CRM-системы.";
    const llm = new StubChatLlmPort({ fixedText: "ok" });
    const origChat = llm.chat.bind(llm);
    llm.chat = async (req) => {
      capturedSystem = req.system;
      return origChat(req);
    };

    await runConfigurator("тест", makeCtxWithGrant(llm), customPrompt);

    expect(capturedSystem).toBe(customPrompt);
  });

  it("AC-T383-6b: empty string override falls back to default", async () => {
    let capturedSystem: string | undefined;
    const llm = new StubChatLlmPort({ fixedText: "ok" });
    const origChat = llm.chat.bind(llm);
    llm.chat = async (req) => {
      capturedSystem = req.system;
      return origChat(req);
    };

    await runConfigurator("тест", makeCtxWithGrant(llm), "");

    expect(capturedSystem).toBe(CONFIGURATOR_DEFAULT_SYSTEM_PROMPT);
  });
});
