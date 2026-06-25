/**
 * src/core/__tests__/assistant-chat-open.test.ts — T-0475 [E-AGENTS L4]
 *
 * Proves spec §6 invariant: ASSISTANT-CHAT is open to ANY tenant member (the
 * `use` capability). A plain member — EMPTY grants, no authoring_draft, no
 * llm_connection:configure, no system_agent:operate — can chat with the assistant
 * (read-only analyst / general path) WITHOUT any authority gate.
 *
 * The capability gate lives ONLY on the configurator (authoring) path: a plain
 * member who tries to BUILD something is refused (handled by the configurator's
 * canOperateSystemAgent gate) — but plain CHAT/ANALYST use is never gated. This
 * test exercises intentDispatch (the single seam assistant.ts calls) with an
 * empty-grant member and asserts:
 *   - a general/analytic message → a normal reply (no throw, no 403/grant error);
 *   - a configurator (build) message → an honest "needs authoring grant" refusal
 *     (the configurator gate still bites), proving the asymmetry is intentional.
 */

import { describe, it, expect, afterEach } from "vitest";
import { intentDispatch, classifyIntent, type HandlerContext } from "../assistant-intent.js";
import { setAnalystPorts, resetAnalystPorts } from "../assistant-analyst.js";
import { StubChatLlmPort } from "./stub-chat-llm-port.js";
import type { GrantSource } from "../grant-resolver.js";
import type { AncestryOracle } from "../grant-lattice.js";
import type { ResolveSubject } from "../object-handle.js";

const TENANT = "aaaaaaaa-0000-0000-0000-000000000001";

const flatOracle: AncestryOracle = { isDescendantOrSelf: (_h, a, b) => a === b };

/** A plain member: getGrants ALWAYS returns [] — no authoring, no capabilities. */
const emptyGrantSource: GrantSource = { async getGrants() { return []; } };

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  const userSubject: ResolveSubject = { tenantId: TENANT, subjectId: "plain-member" };
  const agentSubject: ResolveSubject = { tenantId: TENANT, subjectId: "assistant-agent" };
  return {
    tenantId: TENANT,
    userSubject,
    agentSubject,
    intersectionGrants: emptyGrantSource,
    ancestry: flatOracle,
    llm: new StubChatLlmPort({ fixedText: "Привет! Чем помочь?" }),
    threadId: "thread-0001",
    messageId: "msg-0001",
    ...overrides,
  };
}

afterEach(() => resetAnalystPorts());

describe("T-0475 — assistant chat is open to any tenant member (no authoring gate)", () => {
  it("a plain member (empty grants) gets a normal analyst/chat reply — NOT gated", async () => {
    // Inject read-only ports so the analyst path does no real DB IO.
    setAnalystPorts({
      listRecords: async () => [],
      loadCycleTime: async () => ({ tenant_id: TENANT, bottleneck: null, rows: [] }),
      loadActorBreakdown: async () => [],
      emitAudit: async () => {},
      loadSystemPrompt: async () => null,
    });

    // A general/analytic message routes to the read-only analyst (not configurator).
    const msg = "покажи аналитику по заявкам";
    expect(classifyIntent(msg)).not.toBe("configurator");

    const result = await intentDispatch(msg, makeCtx());
    // Reply is produced; no authority error. The plain member CAN use the chat.
    expect(result.text).toContain("Привет! Чем помочь?");
  });

  it("a plain member's BUILD request IS refused on the authoring path — the asymmetry is intentional", async () => {
    const msg = "построй приложение для заявок";
    expect(classifyIntent(msg)).toBe("configurator");

    // The configurator gate (canOperateSystemAgent over the empty intersection)
    // refuses honestly — it does NOT throw. The refusal proves authoring is gated
    // while basic chat (above) is not.
    const result = await intentDispatch(msg, makeCtx());
    expect(result.intent).toBe("configurator");
    // Honest refusal mentions the missing authority (authoring grant).
    expect(result.text.toLowerCase()).toContain("прав");
  });
});
