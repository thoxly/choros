/**
 * src/core/assistant-intent.ts — T-0359 (E17): Intent-dispatch seam.
 *
 * PURE SEAM — this file defines the dispatch contract and provides STUB
 * implementations for both handlers. Wave 2 tasks fill the real bodies:
 *
 *   T-0360  →  src/core/assistant-analyst.ts       (fill handleAnalyst)
 *   T-0361  →  src/core/assistant-configurator.ts  (fill handleConfigurator)
 *
 * CRITICAL FOR WAVE 2 PARALLELISM:
 *   Neither T-0360 nor T-0361 should touch assistant.ts.
 *   They only need to:
 *     1. Create their own core module with the real implementation.
 *     2. Replace the import in THIS file (or the factory that produces the handler).
 *   assistant.ts itself is sealed — it delegates to intentDispatch() here.
 *
 * NO IO. No DB. No LLM calls. Pure type + dispatch contract.
 */

import type { LlmPort } from "./llm-port.js";
import type { GrantSource } from "./grant-resolver.js";
import type { AncestryOracle } from "./grant-lattice.js";
import type { ResolveSubject } from "./object-handle.js";

// ---------------------------------------------------------------------------
// Handler context — injected into every handler at call time.
// ---------------------------------------------------------------------------

/**
 * Runtime context available to both handler modes.
 * The handler MUST NOT read process.env — all config is injected here.
 */
export interface HandlerContext {
  /** The resolved tenant UUID for the conversation. */
  tenantId: string;
  /** On-behalf-of user subject (slugs + tenantId). */
  userSubject: ResolveSubject;
  /** The agent acting for the user. */
  agentSubject: ResolveSubject;
  /**
   * Grant source ALREADY scoped to the intersection of agent ∩ user grants.
   * Handlers MUST use ONLY this source — never the raw base GrantSource.
   */
  intersectionGrants: GrantSource;
  /** Hierarchy oracle for scope comparisons (injected, pure). */
  ancestry: AncestryOracle;
  /** Injected LLM port (StubChatLlmPort in $0 mode; real port in production). */
  llm: LlmPort;
  /** The thread ID (journal persistence key). */
  threadId: string;
  /** The message ID being replied to. */
  messageId: string;
}

/**
 * Result returned by any intent handler.
 * The HTTP route serializes this into the response JSON.
 */
export interface HandlerResult {
  /**
   * The assistant's text reply to the user.
   * Must be safe to surface externally (no reasoning, no raw secrets).
   */
  text: string;
  /**
   * Detected intent (for client-side UI hints — e.g. badge "настройка" vs "анализ").
   * Stub handlers return "unknown".
   */
  intent: "analyst" | "configurator" | "unknown";
}

// ---------------------------------------------------------------------------
// Routing — classify the intent from the user message text.
// ---------------------------------------------------------------------------

/**
 * Classify the user's message intent.
 * Production Wave 2 will replace this with LLM-based routing; for now it uses
 * a simple keyword heuristic that is honest about its limitations.
 *
 * Returns "configurator" when the message contains configuration-oriented
 * keywords, "analyst" for data / report keywords, "unknown" otherwise.
 */
export function classifyIntent(text: string): "analyst" | "configurator" | "unknown" {
  const t = text.toLowerCase();
  if (
    t.includes("настрой") ||
    t.includes("добавь поле") ||
    t.includes("добавь") ||
    t.includes("создай") ||
    t.includes("изменить") ||
    t.includes("config") ||
    t.includes("configure") ||
    t.includes("setup")
  ) {
    return "configurator";
  }
  if (
    t.includes("отчёт") ||
    t.includes("отчет") ||
    t.includes("аналитика") ||
    t.includes("анализ") ||
    t.includes("рекомендация") ||
    t.includes("report") ||
    t.includes("analys") ||
    t.includes("recommend")
  ) {
    return "analyst";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// IntentHandler type — the contract T-0360 / T-0361 implement.
// ---------------------------------------------------------------------------

/**
 * The contract each handler module must satisfy.
 * T-0360 exports `handleAnalyst` matching this signature.
 * T-0361 exports `handleConfigurator` matching this signature.
 */
export type IntentHandler = (
  userText: string,
  ctx: HandlerContext,
) => Promise<HandlerResult>;

// ---------------------------------------------------------------------------
// STUB handlers — replaced by Wave 2 imports without touching assistant.ts.
//
// Stub design: they use the LLM port's chat() so:
//   - In $0 test mode (StubChatLlmPort): return a deterministic canned reply.
//   - In production (real port configured): actually call the LLM.
// The "not yet available" barrier is strictly for *tool dispatch* (real BPMN
// authoring, record reads), which Wave 2 wires. The LLM dialogue itself works.
// ---------------------------------------------------------------------------

/**
 * ANALYST handler — T-0360 real implementation.
 * Delegates to src/core/assistant-analyst.ts (handleAnalyst).
 * Read-only: reads records + S3 journal within the asker's ACL; NEVER writes
 * business data. Produces an ephemeral ReportDraft + save-proposal hint.
 */
// T-0360: import the real handler (replaces the stub above)
import { handleAnalyst as _handleAnalystImpl } from "./assistant-analyst.js";
export const handleAnalyst: IntentHandler = _handleAnalystImpl;

/**
 * STUB configurator handler — T-0361 will replace with real implementation.
 * For now: calls LLM chat() for a text reply, returns intent="configurator".
 * No DRAFT authoring tools — deferred to T-0361.
 */
export const handleConfigurator: IntentHandler = async (userText, ctx) => {
  const result = await ctx.llm.chat({
    system:
      "Ты конфигуратор-ассистент в системе Choros. " +
      "Отвечай по-русски, кратко и по делу. " +
      "Авторинг DRAFT-модели (поля, формы, процессы) доступен в следующей версии (T-0361). " +
      "Сейчас расскажи пользователю, что ты понял о задаче настройки, и попроси уточнить детали.",
    messages: [{ role: "user", content: userText }],
  });
  return { text: result.text, intent: "configurator" };
};

// ---------------------------------------------------------------------------
// intentDispatch — the single entry point called by assistant.ts
// ---------------------------------------------------------------------------

/**
 * Route the user message to the correct handler based on detected intent.
 *
 * This is the ONLY function assistant.ts calls. The handlers above are
 * imported locally in this module — Wave 2 edits THIS file or replaces the
 * handler imports here, without ever touching assistant.ts.
 *
 * Dispatch order:
 *  1. Classify intent from text (keyword heuristic, Wave 2 → LLM router).
 *  2. "analyst"      → handleAnalyst
 *  3. "configurator" → handleConfigurator
 *  4. "unknown"      → handleAnalyst (safe default — analyst mode is read-only)
 */
export async function intentDispatch(
  userText: string,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const intent = classifyIntent(userText);
  switch (intent) {
    case "configurator":
      return handleConfigurator(userText, ctx);
    case "analyst":
    case "unknown":
    default:
      return handleAnalyst(userText, ctx);
  }
}
